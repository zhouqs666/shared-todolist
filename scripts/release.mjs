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
 *   node scripts/release.mjs 2.7.67 --from-git 2.7.63 --notes "回退到 2.7.63 内容"   # 回退包
 *
 * 流程：
 *   1. 校验版本号格式（x.y.z）+ 版本号必须大于线上出现过的最高版本
 *   2. 把 public/ 复制到暂存目录，在**副本**上把 index.html 的 app-version 改成新版本号
 *   3. 用系统 zip 打包暂存目录内容（zip 根目录即 web 内容，符合 updater 要求）
 *   4. 回读校验：从 zip 里取出 index.html，确认注入的 meta 真的进包了
 *   5. 上传 zip 到 Supabase Storage 的 app_updates bucket
 *   6. 在 app_versions 表插入版本记录
 *
 * 【2026-09-16 加】--from-git <ref>：**真回滚**（把线上退回旧代码）。
 *   背景：把新版本 `enabled=false` 只是"下线"（阻止还没更新的设备拿到它），
 *   已经装上新版本的设备不会退回 —— 客户端判定更新用的是「服务端版本 <= 本地版本 → 无更新」，
 *   本地版本已经是新的了。真要退回去，只能**发一个版本号更高、内容为旧代码**的包。
 *   本选项就是那条路：内容取自 `git archive <ref> public`，版本号用本次传入的新号，
 *   meta 注入到新号上（否则客户端下完又判定"有新版本"，陷入无限重装）。
 *   因为是重发**已经发布过的旧代码**，它天然不会出现在 main 上 —— 所以本模式下
 *   「改动必须先合并到 main」这条前置不适用（内容不是新写的）。
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
import { resolveGitProvenance, upsertWithOptionalColumns } from './_lib-release-meta.mjs';

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
  --from-git <ref>      回退包：内容取自该 git ref（commit/tag/分支）的 public/，
                        版本号仍用本次传入的新号。用于**真回滚**（详见文件头注释）
  -h, --help            显示帮助

示例：
  node scripts/release.mjs 2.0.1
  node scripts/release.mjs 2.0.1 --notes "修复留言板滚动 bug"
  node scripts/release.mjs 2.0.1 --min-app 2.0.0 --dry-run
  node scripts/release.mjs 2.7.67 --from-git 2.7.63 --notes "回退到 2.7.63 内容"
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
let fromGit = null;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--notes') notes = args[++i] || '';
  else if (args[i] === '--min-app') minApp = args[++i] || null;
  else if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--from-git') fromGit = args[++i] || null;
}
if (fromGit === '') {
  console.error('✗ --from-git 需要跟一个 git ref（commit / tag / 分支名）');
  process.exit(1);
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
  const highest = await assertNewerThanLatest(sb, 'app_versions', 'version', VERSION,
    '  血泪教训 2026-08-07：热更新版本号低，App 判定无更新，用户连开几次都收不到。');

  // 用 regex.test 检测"是否找到 meta"，而非 strict equal —— V8 的 String.replace 优化
  // 在 replacement 与原文一致时会返回同一字符串引用，导致 strict equal 误判"未找到"。
  const META_RE = /<meta name="app-version" content="[^"]*" \/>/;

  // 2.【DORA 溯源】这次发布的代码是哪个 commit —— 在打包之前解析。
  // 放在这里（而不是写库前）是为了 **--dry-run 也能看到会记什么**：
  // 「预演的价值取决于它跑到了哪一步，不是取决于它绿了」（批次 F 的教训）。
  const provenance = resolveGitProvenance({ ref: fromGit, paths: ['public'] });
  if (provenance.sha) {
    console.log(`  → 溯源：${provenance.sha.slice(0, 8)}（${provenance.committedAt}）`
      + `${provenance.dirty ? ' ⚠️ 工作区有未提交改动（该行不算进 DORA 前置时间）' : ' ✓ 工作区干净'}`);
  } else {
    console.log(`  ⚠️ ${provenance.reason}`);
  }

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
  const GIT_SRC_DIR = join(TMP_DIR, 'git-src');
  const GIT_TAR_PATH = join(TMP_DIR, 'public-from-git.tar');

  try {
    // 1. 准备暂存副本 + 注入版本号（不动仓库里的任何文件）
    rmSync(STAGE_DIR, { recursive: true, force: true });
    let effectiveMinApp = minApp;
    if (fromGit) {
      // ===== 回退包：内容取自旧 ref，版本号用新号 =====
      let sha;
      try {
        sha = execFileSync('git', ['rev-parse', '--verify', `${fromGit}^{commit}`],
          { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      } catch {
        console.error(`✗ 找不到 git ref：${fromGit}`);
        process.exit(1);
      }
      // 该 ref 里必须真有 public/：否则打出来是空包，装上就是白屏
      try {
        execFileSync('git', ['cat-file', '-e', `${sha}:public/index.html`], { cwd: ROOT, stdio: 'pipe' });
      } catch {
        console.error(`✗ ${fromGit} 里没有 public/index.html，不能作为回退内容的来源`);
        process.exit(1);
      }
      console.log(`  → 回退模式：内容取自 ${fromGit}（${sha.slice(0, 8)}）`);
      // 让人一眼看到这次会把线上退回成什么样（相对当前工作区丢了哪些改动）
      try {
        const stat = execFileSync('git', ['diff', '--stat', `${sha}..HEAD`, '--', 'public'],
          { cwd: ROOT, encoding: 'utf8' }).trim();
        if (stat) {
          console.log('    与当前工作区的差异（本次发布将回退掉这些）：');
          for (const line of stat.split('\n')) console.log(`      ${line}`);
        }
      } catch { /* 差异只是辅助信息，取不到不阻塞发布 */ }

      rmSync(GIT_SRC_DIR, { recursive: true, force: true });
      mkdirSync(GIT_SRC_DIR, { recursive: true });
      execFileSync('git', ['archive', `--output=${GIT_TAR_PATH}`, sha, 'public'], { cwd: ROOT });
      execFileSync('tar', ['-xf', GIT_TAR_PATH, '-C', GIT_SRC_DIR]);
      cpSync(join(GIT_SRC_DIR, 'public'), STAGE_DIR, { recursive: true });
      // 回退包本身不再声明壳版本要求：沿用线上最高行的（避免退回后突然要求更高的壳）
      if (!effectiveMinApp && highest && highest.min_app_version) {
        effectiveMinApp = highest.min_app_version;
        console.log(`    最低壳版本沿用线上：${effectiveMinApp}`);
      }
    } else {
      console.log('  → 复制 public/ 到暂存目录并在副本上注入版本号 ...');
      cpSync(PUBLIC_DIR, STAGE_DIR, { recursive: true });
    }
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

    // 2b. 回读校验：从 zip 里取出 index.html，确认注入的 meta 真的进包了。
    // 防的是「包内版本号与实际发布号不一致」→ 客户端下完又判定"有新版本"→ 无限重装
    // （2026-09-04 事故形态；APK 通道的同类校验在 release-apk.mjs 第 5b 步）。
    let inZip = '';
    try {
      inZip = execFileSync('unzip', ['-p', ZIP_PATH, 'index.html'],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    } catch (e) {
      console.error(`✗ 回读校验失败：读不出 zip 内的 index.html（${e.message}）`);
      process.exit(1);
    }
    if (!inZip.includes(`<meta name="app-version" content="${VERSION}" />`)) {
      console.error(`✗ 回读校验不过：包内 app-version 不是 ${VERSION}，拒绝发布。`);
      process.exit(1);
    }
    console.log(`  ✓ 回读校验：包内 meta = ${VERSION}`);

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

    // 4. 写版本表（回退包自动在备注里标出来源，事后翻表就知道这次是回的哪一版）
    const finalNotes = fromGit
      ? `【回退包】内容取自 ${fromGit}${notes ? '：' + notes : ''}`
      : (notes || null);
    console.log('  → 写入 app_versions 表...');
    // DORA 前置时间的锚点：这次发布的代码是哪个 commit（回退模式取旧 ref 的 sha）。
    // 解析在打包之前已完成（见上面第 2 步），这里直接用 —— 保证 dry-run 与正式发布看到同一个值。
    const row = {
      version: VERSION,
      storage_path: storagePath,
      min_app_version: effectiveMinApp,
      enabled: true,
      notes: finalNotes,
      released_at: new Date().toISOString(),
      commit_sha: provenance.sha,
      commit_at: provenance.committedAt,
      commit_dirty: provenance.dirty,
    };
    const { degraded, error: dbErr } = await upsertWithOptionalColumns(
      sb, 'app_versions', row, ['commit_sha', 'commit_at', 'commit_dirty'], 'version');
    if (dbErr) throw new Error(dbErr);
    if (degraded) {
      console.warn('    ⚠️ 已发布，但溯源没写进表：数据库还没执行 supabase/migration-dora-metrics.sql');
      console.warn(`      （${degraded}）⇒ DORA 的前置时间会缺这一行`);
    }

    console.log('\n✅ 发布成功！');
    console.log(`   版本：${VERSION}`);
    if (notes) console.log(`   说明：${notes}`);
    if (minApp) console.log(`   最低壳版本：${minApp}`);
    console.log(`\n   App 下次冷启动时自动检查并下载；下载完成后再次启动生效。\n`);

  } finally {
    // 清理：临时 zip（成功时）、暂存副本、以及 --from-git 的中间产物（始终）
    // （中间产物漏清会在 .release-tmp/ 里留下多份旧 public/ 快照，一次几十 MB）
    try {
      rmSync(STAGE_DIR, { recursive: true, force: true });
      rmSync(GIT_SRC_DIR, { recursive: true, force: true });
      if (existsSync(GIT_TAR_PATH)) unlinkSync(GIT_TAR_PATH);
      if (existsSync(ZIP_PATH) && !dryRun) unlinkSync(ZIP_PATH);
    } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('\n✗ 发布失败：', err && err.message ? err.message : err);
  process.exit(1);
});
