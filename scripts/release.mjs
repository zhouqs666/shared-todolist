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
 *   2. 临时把 index.html 的 app-version meta 改成新版本号
 *   3. 用系统 zip 把 public/ 内容打包（zip 根目录即 web 内容，符合 updater 要求）
 *   4. 还原 index.html
 *   5. 上传 zip 到 Supabase Storage 的 app_updates bucket
 *   6. 在 app_versions 表插入版本记录
 *
 * 安全：用 service_role key（.env 里的 SUPABASE_KEY），仅本地运行
 *
 * 生效时机：App 下次冷启动时后台下载，再次启动加载新资源（@capgo 默认策略）。
 */

import { createClient } from '@supabase/supabase-js';
import {
  existsSync, readFileSync, mkdirSync, unlinkSync, statSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');
const INDEX_HTML = join(PUBLIC_DIR, 'index.html');

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
function loadEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) {
    console.error('✗ 找不到 .env 文件，请在项目根目录创建（参考 .env.example）');
    process.exit(1);
  }
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('✗ .env 缺少 SUPABASE_URL 或 SUPABASE_KEY（service_role）');
  process.exit(1);
}
if (SERVICE_KEY.length < 100) {
  console.error('✗ SUPABASE_KEY 看起来是 anon key，需要 service_role key（更长）才能上传/写表');
  process.exit(1);
}

// ---------- 主流程 ----------
async function main() {
  console.log(`\n🚀 发布热更新版本 ${VERSION}\n`);

  const originalHtml = await readFile(INDEX_HTML, 'utf8');
  const versionedHtml = originalHtml.replace(
    /<meta name="app-version" content="[^"]*" \/>/,
    `<meta name="app-version" content="${VERSION}" />`
  );
  if (versionedHtml === originalHtml) {
    console.error('✗ index.html 未找到 <meta name="app-version">，请确认已添加');
    process.exit(1);
  }

  const TMP_DIR = join(ROOT, '.release-tmp');
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR);
  const ZIP_PATH = join(TMP_DIR, `release-${VERSION}.zip`);
  // 每次重新生成前删旧 zip，避免 zip 命令追加
  if (existsSync(ZIP_PATH)) unlinkSync(ZIP_PATH);

  try {
    // 1. 注入版本号
    console.log('  → 注入版本号到 index.html');
    await writeFile(INDEX_HTML, versionedHtml, 'utf8');

    // 2. 打包：在 public/ 内执行 zip，通配 * 让 zip 根目录直接是 web 内容
    //    （@capgo/capacitor-updater 要求 zip 解压后根目录即 index.html，不能有外层目录）
    console.log('  → 打包 public/ 为 zip ...');
    try {
      execFileSync('zip', ['-r', '-q', ZIP_PATH, '.', '-x', './.*'],
        { cwd: PUBLIC_DIR, stdio: 'pipe' });
    } catch (e) {
      throw new Error(`zip 命令失败：${e.message}（请确认系统已安装 zip）`);
    }

    const zipSize = statSync(ZIP_PATH).size;
    console.log(`  ✓ 已打包：${ZIP_PATH}（${(zipSize / 1024).toFixed(1)} KB）`);

    if (dryRun) {
      console.log('\n🟡 --dry-run：跳过上传。index.html 已还原。zip 保留在 .release-tmp/ 供检查。');
      await writeFile(INDEX_HTML, originalHtml, 'utf8');
      return;
    }

    // 3. 还原 index.html —— 改为不还原，让 meta 保持最新版本号！
    // 为什么：release.mjs 打包 zip 时会把 meta 注入新版本，但之前打包完立即还原了 public/index.html。
    // 这导致下次 APK 构建时壳内置的 meta 还是旧值（如 2.4.6），getLocalVersion() 读旧值 →
    // 服务器最新 bundle（如 2.7.31）> 旧值 → 壳更新装完新 APK 又重复拉一遍热更新（双重重启）。
    // 修复：打包完不再还原，让 index.html 的 meta 和最新 bundle 版本同步，
    // 确保下次 gradlew assembleRelease 时壳内置 meta 就是对的。
    // 如果需要回退，手动改 index.html 即可（或 git checkout public/index.html）。
    console.log('  ✓ index.html meta 已更新为 ' + VERSION + '（不再还原，确保下次 APK 构建壳内置 meta 正确）');

    // 4. 上传
    console.log('\n  → 连接 Supabase（service_role）...');
    const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    const storagePath = `releases/${VERSION}.zip`;
    console.log(`  → 上传到 app_updates/${storagePath} ...`);
    const zipBuf = await readFile(ZIP_PATH);
    const { error: upErr } = await sb.storage
      .from('app_updates')
      .upload(storagePath, zipBuf, { contentType: 'application/zip', upsert: true });
    if (upErr) throw new Error(`上传失败：${upErr.message}`);
    console.log('  ✓ 上传成功');

    // 5. 写版本表
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
    // 保底：index.html meta 不再还原（保持最新版本号，确保下次 APK 构建壳内置 meta 正确），
    // 只清理临时 zip
    try {
      if (existsSync(ZIP_PATH) && !dryRun) unlinkSync(ZIP_PATH);
    } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('\n✗ 发布失败：', err && err.message ? err.message : err);
  process.exit(1);
});
