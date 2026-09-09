/**
 * APK（原生壳）发布脚本
 *
 * 用法：
 *   node scripts/release-apk.mjs <版本号> [选项]
 *
 * 示例：
 *   node scripts/release-apk.mjs 2.1.0 --notes "App 内更新能力 + 震动权限"
 *   node scripts/release-apk.mjs 2.1.0 --code 3                    # 显式指定 versionCode
 *   node scripts/release-apk.mjs 2.1.0 --apk ~/Desktop/有爱.apk     # 指定 APK 路径
 *   node scripts/release-apk.mjs 2.1.0 --dry-run                   # 只校验不上传，预演
 *
 * 流程：
 *   1. 校验版本号格式（x.y.z）
 *   2. 【铁律】先查线上 app_native_versions 最新启用版本，新版本必须语义化大于线上，
 *      否则中止（防止版本号倒挂导致 App 判定"无更新"——2026-08-07 的血泪教训）
 *   3. 定位 APK（默认 ~/Desktop/有爱.apk，fallback 到 gradle 输出目录）
 *   4. 计算 SHA-256 与体积（客户端下载后按此校验）
 *   5. 上传到 Supabase Storage 的 app_updates bucket（apks/youai-<版本>.apk）
 *   6. 在 app_native_versions 表 upsert 版本记录
 *
 * 安全：用 service_role key（.env 里的 SUPABASE_KEY），仅本地运行
 *
 * 生效时机：App 冷启动 1.8s 后检查，弹更新面板 → 下载 → 唤起系统安装器（用户手动点安装）。
 */

import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertNewerThanLatest } from './_lib-version-check.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  console.log(`APK（原生壳）发布脚本

用法：
  node scripts/release-apk.mjs <版本号> [选项]

选项：
  --notes "<说明>"   更新说明（面板里展示）
  --code <n>         versionCode（缺省从 android/app/build.gradle 读取）
  --apk <path>       APK 文件路径（默认 ~/Desktop/有爱.apk，fallback gradle 输出）
  --dry-run          只校验不上传，预演
  -h, --help         显示帮助

示例：
  node scripts/release-apk.mjs 2.1.0 --notes "App 内更新 + 震动权限"
`);
  process.exit(0);
}

const VERSION = args[0];
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error(`✗ 版本号格式错误：${VERSION}，应为 x.y.z（如 2.1.0）`);
  process.exit(1);
}

let notes = '';
let code = null;
let apkPath = null;
let dryRun = false;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--notes') notes = args[++i] || '';
  else if (args[i] === '--code') code = parseInt(args[++i], 10);
  else if (args[i] === '--apk') apkPath = args[++i] || null;
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
  console.log(`\n📦 发布 APK 版本 ${VERSION}\n`);
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // 1.【铁律】先查线上最新启用版本，版本号必须语义化大于线上
  console.log('  → 查询线上最新壳版本（铁律：不允许版本号倒挂）...');
  const onlineLatest = await assertNewerThanLatest(sb, 'app_native_versions', 'version_name', VERSION,
    '  血泪教训 2026-08-07：壳版本号低，App 判定无更新，用户永远收不到。');
  // 后续会用 onlineLatest.version_code（L257）做 versionCode 校验；首发时为 null，逻辑已处理

  // 1.5【铁律一门禁】assets 里的 supabase.js 必须指向生产库。
  // build-test-apk.mjs 会把 assets 临时换成测试库，若还原步骤没跑，正式包就会带上测试库
  // （用户视角 = 账号登不上、待办"全丢"），发布前在这里硬性拦截。
  const assetsSupabasePath = resolve(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public', 'js', 'supabase.js');
  if (existsSync(assetsSupabasePath)) {
    const assetsSupabase = readFileSync(assetsSupabasePath, 'utf8');
    const embeddedUrl = assetsSupabase.match(/const SUPABASE_URL = '([^']*)'/)?.[1];
    if (embeddedUrl !== SUPABASE_URL) {
      console.error('✗ android assets 的 supabase.js 未指向生产库（疑似测试构建残留），中止发布。');
      console.error(`   assets 内是：${embeddedUrl ?? '(未检出)'}`);
      console.error(`   生产库是：  ${SUPABASE_URL}`);
      console.error('   修复：npx cap sync android 后重试。');
      process.exit(1);
    }
    console.log('  ✓ android assets supabase.js 指向生产库');
  }

  // 2. 先检查 android assets 旧 meta 值（判断是否需要 gradle rebuild）
  const androidIndexPath = resolve(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public', 'index.html');
  let oldAndroidMeta = null;
  if (existsSync(androidIndexPath)) {
    const h = readFileSync(androidIndexPath, 'utf8');
    const m = h.match(/<meta name="shell-version" content="([^"]*)"/);
    oldAndroidMeta = m ? m[1] : null;
  }
  const needRebuild = (oldAndroidMeta !== VERSION);

  // 3. 更新两份 index.html shell-version meta（写在 gradle build 之前）
  const indexPath = resolve(ROOT, 'public/index.html');
  let indexHtml = readFileSync(indexPath, 'utf8');
  const oldMeta = indexHtml.match(/<meta name="shell-version" content="([^"]*)"/)?.[1] || '(无)';
  indexHtml = indexHtml.replace(
    /<meta name="shell-version" content="[^"]*"/,
    `<meta name="shell-version" content="${VERSION}"`
  );
  writeFileSync(indexPath, indexHtml);
  console.log(`  ✓ shell-version meta（public/）：${oldMeta} → ${VERSION}`);

  // 同步更新 android assets（build 前写，APK 壳才能打包进去）
  if (existsSync(androidIndexPath)) {
    let androidHtml = readFileSync(androidIndexPath, 'utf8');
    if (androidHtml.includes('shell-version')) {
      androidHtml = androidHtml.replace(
        /<meta name="shell-version" content="[^"]*"/,
        `<meta name="shell-version" content="${VERSION}"`
      );
    } else {
      androidHtml = androidHtml.replace(
        /<meta name="app-version" content="[^"]*" \/>/,
        `<meta name="app-version" content="2.4.6" />\n  <meta name="shell-version" content="${VERSION}" />`
      );
    }
    writeFileSync(androidIndexPath, androidHtml);
    console.log(`  ✓ shell-version meta（android assets/）同步为 ${VERSION}`);
  }

  // 4. 自动 gradle build（旧 meta != 新版本 → rebuild）
  if (needRebuild && !dryRun) {
    const { spawnSync } = await import('node:child_process');
    console.log(`  → android assets meta ${oldAndroidMeta ?? '(无)'} → ${VERSION}，自动 gradle assembleRelease ...`);
    const gradleResult = spawnSync('./gradlew', ['assembleRelease'], {
      cwd: join(ROOT, 'android'),
      stdio: 'inherit',
      shell: true,
    });
    if (gradleResult.status !== 0) {
      console.error('✗ gradle build 失败');
      process.exit(1);
    }
    console.log('  ✓ gradle build 完成');
  }

  // 5. 定位 APK
  // 顺序：显式 --apk > gradle 产物（自动 build 后永远是最新）> 桌面副本（兜底）
  // 血泪教训：桌面副本排前面时，会把旧 APK 直接上传（2026-09-04，2.1.26 发了个旧包）
  const candidates = [
    apkPath,
    join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    join(homedir(), 'Desktop', '有爱.apk'),
  ].filter(Boolean);
  const apkFile = candidates.find((p) => existsSync(p));
  if (!apkFile) {
    console.error(`✗ 找不到 APK 文件，依次找过：
${candidates.map((p) => '   - ' + p).join('\n')}
  请先打包（gradlew assembleRelease）并覆盖到 ~/Desktop/有爱.apk，或用 --apk 指定路径`);
    process.exit(1);
  }
  console.log(`  ✓ APK：${apkFile}`);

  // 5b.【铁律】校验 APK 内的 shell-version meta == 本次版本号
  // 防止把旧 APK（meta 过期）发出去——所有"发了个旧包"的事故都死在这里
  {
    const { execFileSync } = await import('node:child_process');
    const apkIndexHtml = execFileSync('unzip', ['-p', apkFile, 'assets/public/index.html'], { encoding: 'utf8' });
    const apkMeta = apkIndexHtml.match(/<meta name="shell-version" content="([^"]*)"/)?.[1];
    if (apkMeta !== VERSION) {
      console.error(`✗ APK 内 shell-version meta 是 ${apkMeta ?? '(无)'}，不等于本次版本 ${VERSION}！
  这个 APK 是旧的（gradle 没打包进最新 assets）。
  排查：npx cap sync android 后重跑 gradlew assembleRelease，或删掉 android/app/build 再 build。`);
      process.exit(1);
    }
    console.log(`  ✓ APK 内 shell-version meta = ${VERSION}（防旧包校验通过）`);
  }

  // 6. versionCode：显式指定 > build.gradle 读取
  if (code == null) {
    const gradle = await readFile(join(ROOT, 'android', 'app', 'build.gradle'), 'utf8');
    const m = gradle.match(/versionCode\s+(\d+)/);
    if (!m) {
      console.error('✗ 无法从 android/app/build.gradle 解析 versionCode，请用 --code 显式指定');
      process.exit(1);
    }
    code = parseInt(m[1], 10);
  }
  if (onlineLatest && code <= onlineLatest.version_code) {
    console.error(`✗ versionCode 必须大于线上（线上 ${onlineLatest.version_code}，本次 ${code}）。
  请先升 android/app/build.gradle 里的 versionCode 再发布。`);
    process.exit(1);
  }
  console.log(`  ✓ versionCode：${code}`);

  // 7. SHA-256 + 体积
  const buf = await readFile(apkFile);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const size = buf.length;
  console.log(`  ✓ 体积 ${(size / 1024 / 1024).toFixed(1)} MB · SHA-256 ${sha256.slice(0, 16)}…`);

  if (dryRun) {
    console.log('\n🟡 --dry-run：校验通过，跳过上传。');
    return;
  }

  // 8. 上传 Storage
  const storagePath = `apks/youai-${VERSION}.apk`;
  console.log(`  → 上传到 app_updates/${storagePath} ...`);
  const { error: upErr } = await sb.storage
    .from('app_updates')
    .upload(storagePath, buf, { contentType: 'application/octet-stream', upsert: true });
  if (upErr) throw new Error(`上传失败：${upErr.message}`);
  console.log('  ✓ 上传成功');

  // 9. 写版本表
  console.log('  → 写入 app_native_versions 表...');
  const { error: dbErr } = await sb.from('app_native_versions').upsert({
    version_name: VERSION,
    version_code: code,
    storage_path: storagePath,
    apk_size_bytes: size,
    apk_sha256: sha256,
    enabled: true,
    notes: notes || null,
    // 可选参数（等 SQL 迁移 add column 后生效；缺省时显式写 false/null）
    is_force_update: false,
    min_supported_version: null,
    released_at: new Date().toISOString(),
  }, { onConflict: 'version_name' });
  if (dbErr) throw new Error(`写版本表失败：${dbErr.message}`);

  console.log('\n✅ 发布成功！');
  console.log(`   版本：${VERSION}（code ${code}）`);
  if (notes) console.log(`   说明：${notes}`);
  console.log(`\n   App 下次冷启动时自动弹出更新面板：下载 → 校验 → 唤起系统安装器。`);
  console.log(`   注意：对方首次安装需在系统弹窗里允许「来自此来源的应用」（仅一次）。\n`);
}

main().catch((err) => {
  console.error('\n✗ 发布失败：', err && err.message ? err.message : err);
  process.exit(1);
});
