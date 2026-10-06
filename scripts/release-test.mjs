/**
 * 测试通道热更新发布脚本（只发【测试项目】，与生产 release.mjs 完全隔离）
 *
 * 用法：
 *   node scripts/release-test.mjs <版本号> [选项]
 *
 * 示例：
 *   node scripts/release-test.mjs 3.5.1
 *   node scripts/release-test.mjs 3.5.1 --notes "引导重教" --from-git origin/main
 *   node scripts/release-test.mjs 3.5.1 --dry-run
 *
 * 与生产 release.mjs 的差异：
 *   - 目标库：app-e2e/.env.test 的 E2E_SUPABASE_URL（测试项目），启动即校验 ≠ 生产库
 *   - 认证：测试项目的 service_role key（E2E_SUPABASE_SERVICE_ROLE_KEY，同生产模式——
 *     release.mjs 用生产 service key）；测试库的表/bucket 由
 *     supabase/migration-test-release-channel.sql 建立（仅测试项目执行）
 *   - 内容护栏（铁律一）：zip 内 supabase.js 必须指向测试库、且不得出现生产库 URL ——
 *     否则真机测试包热更后会读写生产数据（check-test-schema 对启用包做同校验兜底）
 *   - 无审批门/无 required checks/无设备冒烟仪式：测试发版面向业主本人，数据可随写随清
 *
 * 版本序列：独立于生产（各自的表各自唯一），建议与「打算发布的生产版本号」对齐。
 * 生效时机：真机测试包下次冷启动自动下载，再次启动生效（与生产同机制）。
 */

import { createClient } from '@supabase/supabase-js';
import {
  existsSync, mkdirSync, unlinkSync, statSync, cpSync, rmSync, readFileSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertNewerThanLatest } from './_lib-version-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  console.log(`测试通道热更新发布脚本（只发测试项目）

用法：
  node scripts/release-test.mjs <版本号> [选项]

选项：
  --notes "<说明>"      更新说明（可选，自动附带 commit 溯源）
  --from-git <ref>      内容取自该 git ref 的 public/（默认 = 当前工作树；
                        共享工作树上若停着别的分支，用它指定要测的内容）
  --dry-run             只打 zip 不上传，预演
  -h, --help            显示帮助
`);
  process.exit(0);
}

const VERSION = args[0];
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error(`✗ 版本号格式错误：${VERSION}，应为 x.y.z`);
  process.exit(1);
}

let notes = '';
let dryRun = false;
let fromGit = null;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--notes') notes = args[++i] || '';
  else if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--from-git') fromGit = args[++i] || null;
}
if (fromGit === '') {
  console.error('✗ --from-git 需要跟一个 git ref（commit / tag / 分支名）');
  process.exit(1);
}

// ---------- 凭据（全部来自本地 env 文件，不入库） ----------
function loadDotenv(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const eq = t.indexOf('=');
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}
const testEnv = loadDotenv(join(ROOT, 'app-e2e', '.env.test'));
const TEST_URL = testEnv.E2E_SUPABASE_URL;
const TEST_ANON_KEY = testEnv.E2E_SUPABASE_ANON_KEY; // 进包：设备端应用就是用它访问测试项目
const TEST_SERVICE_KEY = testEnv.E2E_SUPABASE_SERVICE_ROLE_KEY;
const PROD_URL = loadDotenv(join(ROOT, '.env')).SUPABASE_URL;

if (!TEST_URL || !TEST_ANON_KEY || !TEST_SERVICE_KEY) {
  console.error('✗ app-e2e/.env.test 缺少 E2E_SUPABASE_URL / E2E_SUPABASE_ANON_KEY / E2E_SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
// 【铁律一 fail-closed】目标必须是测试项目：URL 与生产库相同直接拒绝
if (!PROD_URL) {
  console.error('✗ 根 .env 读不到 SUPABASE_URL（生产库地址），无法做隔离比对');
  process.exit(1);
}
if (TEST_URL === PROD_URL) {
  console.error('✗ 测试库 URL 与生产库相同，拒绝发版（铁律一：测试必须物理隔离）');
  process.exit(1);
}

// ---------- 主流程 ----------
async function main() {
  console.log(`\n🧪 测试通道发布热更新版本 ${VERSION}（→ 测试项目）\n`);
  console.log(`  测试库：${TEST_URL}`);

  // 1. service_role 客户端（与生产 release.mjs 同构；写权限绕 RLS，读用于守卫与回读）
  const sb = createClient(TEST_URL, TEST_SERVICE_KEY, { auth: { persistSession: false } });
  const { error: pingErr } = await sb.from('app_versions').select('version').limit(1);
  if (pingErr) {
    console.error(`✗ 测试项目热更新表不可用（${pingErr.message}）\n`
      + '  → 先对测试项目执行基线迁移：node scripts/apply-sql.mjs supabase/migration-test-release-channel.sql --project test --apply');
    process.exit(1);
  }
  console.log('  ✓ 热更新表就绪（service_role 写通道）');

  // 2. 版本守卫：测试项目内版本号必须语义化大于历史最高（含已下线，同生产语义）
  await assertNewerThanLatest(sb, 'app_versions', 'version', VERSION,
    '  测试通道同理：版本号低，测试包判定无更新，永远收不到。');

  const META_RE = /<meta name="app-version" content="[^"]*" \/>/;

  // 3. 溯源（记进 notes，翻表就知道这个测试包是哪个 commit）
  let sha = null;
  try {
    const ref = fromGit || 'HEAD';
    sha = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { /* 溯源失败不阻塞 */ }

  const TMP_DIR = join(ROOT, '.release-tmp');
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR);
  const ZIP_PATH = join(TMP_DIR, `release-test-${VERSION}.zip`);
  if (existsSync(ZIP_PATH)) unlinkSync(ZIP_PATH);
  const STAGE_DIR = join(TMP_DIR, 'stage-test');
  const GIT_SRC_DIR = join(TMP_DIR, 'git-src-test');
  const GIT_TAR_PATH = join(TMP_DIR, 'public-from-git-test.tar');

  try {
    // 4. 暂存副本 + 注入版本号（不动仓库工作区——工作树可能停着别的分支）
    rmSync(STAGE_DIR, { recursive: true, force: true });
    if (fromGit) {
      let shaRef;
      try {
        shaRef = execFileSync('git', ['rev-parse', '--verify', `${fromGit}^{commit}`],
          { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      } catch {
        console.error(`✗ 找不到 git ref：${fromGit}`);
        process.exit(1);
      }
      try {
        execFileSync('git', ['cat-file', '-e', `${shaRef}:public/index.html`], { cwd: ROOT, stdio: 'pipe' });
      } catch {
        console.error(`✗ ${fromGit} 里没有 public/index.html，不能作为发版内容来源`);
        process.exit(1);
      }
      console.log(`  → 内容取自 ${fromGit}（${shaRef.slice(0, 8)}）`);
      rmSync(GIT_SRC_DIR, { recursive: true, force: true });
      mkdirSync(GIT_SRC_DIR, { recursive: true });
      execFileSync('git', ['archive', `--output=${GIT_TAR_PATH}`, shaRef, 'public'], { cwd: ROOT });
      execFileSync('tar', ['-xf', GIT_TAR_PATH, '-C', GIT_SRC_DIR]);
      cpSync(join(GIT_SRC_DIR, 'public'), STAGE_DIR, { recursive: true });
    } else {
      console.log('  → 复制当前工作树 public/ 到暂存目录并注入版本号 ...');
      cpSync(PUBLIC_DIR, STAGE_DIR, { recursive: true });
    }
    const stagedIndex = join(STAGE_DIR, 'index.html');
    const stagedHtml = await readFile(stagedIndex, 'utf8');
    if (!META_RE.test(stagedHtml)) {
      console.error('✗ index.html 未找到 <meta name="app-version">');
      process.exit(1);
    }
    await writeFile(stagedIndex, stagedHtml.replace(
      META_RE, `<meta name="app-version" content="${VERSION}" />`
    ), 'utf8');

    // 4b. 测试包专属改写：supabase.js 指向测试库（build-test-apk.mjs 对 APK assets 做的
    //     同一件事——不发这步，真机测试包热更后会读写生产库，铁律一）。anon key 本就是
    //     设计公开的；service key 绝不进包。
    const stagedSbPath = join(STAGE_DIR, 'js', 'supabase.js');
    let stagedSb = await readFile(stagedSbPath, 'utf8');
    const sbBefore = stagedSb;
    stagedSb = stagedSb
      .replace(/const SUPABASE_URL = '[^']*';/, `const SUPABASE_URL = '${TEST_URL}';`)
      .replace(/const SUPABASE_ANON_KEY = '[^']*';/, `const SUPABASE_ANON_KEY = '${TEST_ANON_KEY}';`);
    if (stagedSb === sbBefore || !stagedSb.includes(TEST_URL)) {
      console.error('✗ supabase.js 改写失败：URL/KEY 字面量未命中，请检查文件结构');
      process.exit(1);
    }
    await writeFile(stagedSbPath, stagedSb, 'utf8');
    console.log('  ✓ supabase.js 已改写指向测试库');

    // 5. 打包（zip 根目录即 web 内容，@capgo 要求）
    console.log('  → 打包为 zip ...');
    try {
      execFileSync('zip', ['-r', '-q', ZIP_PATH, '.', '-x', './.*'],
        { cwd: STAGE_DIR, stdio: 'pipe' });
    } catch (e) {
      throw new Error(`zip 命令失败：${e.message}（请确认系统已安装 zip）`);
    }
    const zipSize = statSync(ZIP_PATH).size;
    console.log(`  ✓ 已打包：${ZIP_PATH}（${(zipSize / 1024).toFixed(1)} KB）`);

    // 6. 回读校验①：meta 进包
    let inZipIndex = '';
    try {
      inZipIndex = execFileSync('unzip', ['-p', ZIP_PATH, 'index.html'],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    } catch (e) {
      console.error(`✗ 回读校验失败：读不出 zip 内的 index.html（${e.message}）`);
      process.exit(1);
    }
    if (!inZipIndex.includes(`<meta name="app-version" content="${VERSION}" />`)) {
      console.error(`✗ 回读校验不过：包内 app-version 不是 ${VERSION}，拒绝发布。`);
      process.exit(1);
    }
    console.log(`  ✓ 回读校验：包内 meta = ${VERSION}`);

    // 7.【铁律一内容护栏，fail-closed】zip 内 supabase.js 必须指向测试库、不得出现生产库。
    //    这条是测试通道的命门：真机测试包热更后读写的是包里 supabase.js 指向的库——
    //    指向生产 = 测试设备直接变成生产客户端（check-test-schema 对启用包做同校验兜底）。
    let inZipSb = '';
    try {
      inZipSb = execFileSync('unzip', ['-p', ZIP_PATH, 'js/supabase.js'],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    } catch (e) {
      console.error(`✗ 内容护栏校验失败：读不出 zip 内 js/supabase.js（${e.message}）`);
      process.exit(1);
    }
    if (!inZipSb.includes(TEST_URL)) {
      console.error(`✗ 内容护栏不过：包内 supabase.js 未指向测试库（${TEST_URL}），拒绝发布。`);
      process.exit(1);
    }
    if (PROD_URL && inZipSb.includes(PROD_URL)) {
      console.error(`✗ 内容护栏不过：包内 supabase.js 出现生产库 URL，拒绝发布（铁律一）。`);
      process.exit(1);
    }
    console.log('  ✓ 内容护栏：包内 supabase.js 指向测试库，无生产库 URL');

    if (dryRun) {
      console.log('\n🟡 --dry-run：跳过上传。zip 保留在 .release-tmp/ 供检查。');
      return;
    }

    // 8. 上传 + 写版本表
    const storagePath = `releases/${VERSION}.zip`;
    console.log(`  → 上传到 app_updates/${storagePath} ...`);
    const zipBuf = await readFile(ZIP_PATH);
    const { error: upErr } = await sb.storage
      .from('app_updates')
      .upload(storagePath, zipBuf, { contentType: 'application/zip', upsert: true });
    if (upErr) throw new Error(`上传失败：${upErr.message}（测试项目缺 app_updates bucket 或写策略？见 migration-test-release-channel.sql）`);
    console.log('  ✓ 上传成功');

    const finalNotes = `[test] ${sha ? `main内容溯源 ${sha.slice(0, 8)}${fromGit ? `（${fromGit}）` : ''}` : '溯源失败'}`
      + `${notes ? '：' + notes : ''}`;
    console.log('  → 写入 app_versions 表...');
    const { error: insErr } = await sb.from('app_versions').insert({
      version: VERSION,
      storage_path: storagePath,
      enabled: true,
      notes: finalNotes,
    });
    if (insErr) throw new Error(`写 app_versions 失败：${insErr.message}（缺表或缺写策略？见 migration-test-release-channel.sql）`);
    console.log('  ✓ 版本行已写入（enabled=true）');

    // 9. 发布后回读校验（写成功 ≠ 客户端拿得到，铁律三同款语义）
    const { data: row, error: rowErr } = await sb.from('app_versions')
      .select('version, storage_path, enabled').eq('version', VERSION).single();
    if (rowErr || !row || row.enabled !== true) {
      throw new Error(`回读失败：版本行不是 enabled=true（${rowErr ? rowErr.message : JSON.stringify(row)}）`);
    }
    const { data: signed, error: signErr } = await sb.storage
      .from('app_updates').createSignedUrl(storagePath, 60);
    if (signErr || !signed?.signedUrl) throw new Error(`签名 URL 生成失败：${signErr?.message}`);
    const dl = await fetch(signed.signedUrl);
    if (!dl.ok) throw new Error(`回读下载失败：HTTP ${dl.status}`);
    const dlBuf = Buffer.from(await dl.arrayBuffer());
    const TMP_DL = join(TMP_DIR, `readback-test-${VERSION}.zip`);
    await writeFile(TMP_DL, dlBuf);
    const dlMeta = execFileSync('unzip', ['-p', TMP_DL, 'index.html'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (!dlMeta.includes(`<meta name="app-version" content="${VERSION}" />`)) {
      throw new Error('回读校验不过：下载到的包内 meta 不是本次版本');
    }
    const dlSb = execFileSync('unzip', ['-p', TMP_DL, 'js/supabase.js'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (!dlSb.includes(TEST_URL) || (PROD_URL && dlSb.includes(PROD_URL))) {
      throw new Error('回读校验不过：下载到的包 supabase.js 指向不对（铁律一）');
    }
    console.log(`  ✓ 回读校验通过：版本行 enabled、对象可下载（${(dlBuf.length / 1024).toFixed(1)} KB）、内容指向测试库`);

    console.log(`
✅ 测试通道发布成功！
   版本：${VERSION}（测试项目 app_versions）
   说明：${finalNotes}
   真机测试包下次冷启动自动下载，再次启动生效。`);
  } finally {
    rmSync(STAGE_DIR, { recursive: true, force: true });
    rmSync(GIT_SRC_DIR, { recursive: true, force: true });
    try { if (existsSync(GIT_TAR_PATH)) unlinkSync(GIT_TAR_PATH); } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
