/**
 * 热更新发布脚本
 *
 * 用法：
 *   node scripts/release.mjs <版本号> [选项]
 *
 * 示例：
 *   node scripts/release.mjs 2.0.1
 *   node scripts/release.mjs 2.0.1 --notes "修复留言板滚动 bug"
 *   node scripts/release.mjs 2.0.1 --min-app 2.0.0   # 要求 App 壳版本 >= 2.0.0
 *   node scripts/release.mjs 2.0.1 --dry-run         # 只打 zip 不上传，预演
 *
 * 流程：
 *   1. 校验版本号格式（x.y.z）
 *   2. 把 public/ 复制到暂存目录，在**副本**上把 index.html 的 app-version 改成新版本号
 *   3. 用系统 zip 打包暂存目录内容（zip 根目录即 web 内容，符合 updater 要求）
 *   4. 上传 zip 到 Supabase Storage 的 app_updates bucket
 *   5. 在 app_versions 表插入版本记录
 *
 * 【2026-09-14 改】版本号只注入**暂存副本**，发布对仓库工作区零改动。
 *   旧做法是改 public/index.html 且不还原（靠 git 提交让壳内置 meta 跟上），
 *   结果是每次发布都欠一笔提交 —— 分支保护下要走 PR 还触发模拟器 CI，漏提交就出「多重启一次」。
 *   现在版本真相的唯一来源是发布命令传入的版本号（+ `app_versions` 表）。
 *
 * 安全：用 service_role key（.env 里的 SUPABASE_KEY），仅本地运行
 *
 * 生效时机：App 下次冷启动时后台下载，再次启动加载新资源（@capgo 默认策略）。
 */

import { createClient } from '@supabase/supabase-js';
import {
  existsSync, mkdirSync, unlinkSync, statSync, cpSync, rmSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertNewerThanLatest } from './_lib-version-check.mjs';
import { loadEnv, requireSupabaseEnv } from './_lib-env.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  console.log(`热更新发布脚本

用法：
  node scripts/release.mjs <版本号> [选项]

选项：
  --notes "<说明>"      更新说明（可选）
  --min-app <x.y.z>     最低兼容 App 壳版本（可选）
  --dry-run             只打 zip 不上传，预演
  -h, --help            显示帮助

示例：
  node scripts/release.mjs 2.0.1
  node scripts/release.mjs 2.0.1 --notes "修复留言板滚动 bug"
  node scripts/release.mjs 2.0.1 --min-app 2.0.0 --dry-run
`);
  process.exit(0);
}

const VERSION = args[0];
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error(`✗ 版本号格式错误：${VERSION}，应为 x.y.z（如 2.0.1）`);
  process.exit(1);
}

let notes = '';
let minApp = null;
let dryRun = false;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--notes') notes = args[++i] || '';
  else if (args[i] === '--min-app') minApp = args[++i] || null;
  else if (args[i] === '--dry-run') dryRun = true;
}

// ---------- 加载 .env ----------
// 解析 + 凭据校验统一在 _lib-env.mjs（另有 verify-release.mjs / query-latest-version.mjs 共用）：
// CI 里没 .env 文件，改为环境变量注入，所以 loadEnv 在拿不到文件时会先看环境变量。
loadEnv();
const { url: SUPABASE_URL, key: SERVICE_KEY } = requireSupabaseEnv();

// ---------- 主流程 ----------
async function main() {
  console.log(`\n🚀 发布热更新版本 ${VERSION}\n`);

  // 1.【铁律】先查线上最新版本，版本号必须语义化大于线上
  // 2026-08-07 血泪教训：没查线上发 2.0.1，App 判定无更新，用户永远收不到
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  await assertNewerThanLatest(sb, 'app_versions', 'version', VERSION,
    '  血泪教训 2026-08-07：热更新版本号低，App 判定无更新，用户连开几次都收不到。');

  // 用 regex.test 检测"是否找到 meta"，而非 strict equal —— V8 的 String.replace 优化
  // 在 replacement 与原文一致时会返回同一字符串引用，导致 strict equal 误判"未找到"。
  const META_RE = /<meta name="app-version" content="[^"]*" \/>/;

  const TMP_DIR = join(ROOT, '.release-tmp');
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR);
  const ZIP_PATH = join(TMP_DIR, `release-${VERSION}.zip`);
  // 每次重新生成前删旧 zip，避免 zip 命令追加
  if (existsSync(ZIP_PATH)) unlinkSync(ZIP_PATH);

  // 暂存目录：把 public/ 复制一份，版本号只注入到**副本**上。
  // 【2026-09-14 改】原先的做法是直接改 public/index.html 且打包后不还原 ——
  // 那等于让仓库持有版本真相，于是每次发布都会留下一笔「必须提交回 main」的 meta 变更
  // （分支保护下要走 PR，还会触发约 11 分钟模拟器 CI），且一旦漏提交就让壳内置 meta 与线上
  // bundle 不一致。改成在暂存副本上注入后：**发布对工作区零改动**，也不再需要任何补提交。
  const STAGE_DIR = join(TMP_DIR, 'stage');

  try {
    // 1. 准备暂存副本 + 注入版本号（不动仓库里的任何文件）
    console.log('  → 复制 public/ 到暂存目录并在副本上注入版本号 ...');
    rmSync(STAGE_DIR, { recursive: true, force: true });
    cpSync(PUBLIC_DIR, STAGE_DIR, { recursive: true });
    const stagedIndex = join(STAGE_DIR, 'index.html');
    const stagedHtml = await readFile(stagedIndex, 'utf8');
    if (!META_RE.test(stagedHtml)) {
      console.error('✗ index.html 未找到 <meta name="app-version">，请确认已添加');
      process.exit(1);
    }
    await writeFile(stagedIndex, stagedHtml.replace(
      META_RE, `<meta name="app-version" content="${VERSION}" />`
    ), 'utf8');

    // 2. 打包：在暂存目录内执行 zip，通配 * 让 zip 根目录直接是 web 内容
    //    （@capgo/capacitor-updater 要求 zip 解压后根目录即 index.html，不能有外层目录）
    console.log('  → 打包为 zip ...');
    try {
      execFileSync('zip', ['-r', '-q', ZIP_PATH, '.', '-x', './.*'],
        { cwd: STAGE_DIR, stdio: 'pipe' });
    } catch (e) {
      throw new Error(`zip 命令失败：${e.message}（请确认系统已安装 zip）`);
    }

    const zipSize = statSync(ZIP_PATH).size;
    console.log(`  ✓ 已打包：${ZIP_PATH}（${(zipSize / 1024).toFixed(1)} KB）`);

    if (dryRun) {
      console.log('\n🟡 --dry-run：跳过上传。zip 保留在 .release-tmp/ 供检查（仓库工作区未被改动）。');
      return;
    }

    // 3. 上传（sb client 已在 main 顶部版本检查时创建）
    const storagePath = `releases/${VERSION}.zip`;
    console.log(`  → 上传到 app_updates/${storagePath} ...`);
    const zipBuf = await readFile(ZIP_PATH);
    const { error: upErr } = await sb.storage
      .from('app_updates')
      .upload(storagePath, zipBuf, { contentType: 'application/zip', upsert: true });
    if (upErr) throw new Error(`上传失败：${upErr.message}`);
    console.log('  ✓ 上传成功');

    // 4. 写版本表
    console.log('  → 写入 app_versions 表...');
    const { error: dbErr } = await sb.from('app_versions').upsert({
      version: VERSION,
      storage_path: storagePath,
      min_app_version: minApp,
      enabled: true,
      notes: notes || null,
      released_at: new Date().toISOString(),
    }, { onConflict: 'version' });
    if (dbErr) throw new Error(`写版本表失败：${dbErr.message}`);

    console.log('\n✅ 发布成功！');
    console.log(`   版本：${VERSION}`);
    if (notes) console.log(`   说明：${notes}`);
    if (minApp) console.log(`   最低壳版本：${minApp}`);
    console.log(`\n   App 下次冷启动时自动检查并下载；下载完成后再次启动生效。\n`);

  } finally {
    // 清理：临时 zip（成功时）与暂存副本（始终）
    try {
      rmSync(STAGE_DIR, { recursive: true, force: true });
      if (existsSync(ZIP_PATH) && !dryRun) unlinkSync(ZIP_PATH);
    } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('\n✗ 发布失败：', err && err.message ? err.message : err);
  process.exit(1);
});
