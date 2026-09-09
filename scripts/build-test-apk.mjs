/**
 * 构建「测试专用 APK」（仅供 app-e2e / Appium 本地与 CI 测试，绝不发布）
 *
 * 背景（铁律一）：正式 APK 内置的 supabase.js 硬编码生产库 URL。
 * 用它跑 APP 自动化 = 拿生产库做测试。本脚本产出指向【独立测试库】的 APK，
 * 与 app-e2e/.env.test（E2E_SUPABASE_URL）同库，实现物理隔离。
 *
 * 流程：
 *   1. 读取 app-e2e/.env.test 的 E2E_SUPABASE_URL / E2E_SUPABASE_ANON_KEY
 *      （只注入 anon key——它本来就是设计公开的，service_role 绝不进 APK）
 *   2. npx cap sync android（public/ → android assets）
 *   3. 替换 android assets 里 supabase.js 的 URL + anon key 为测试库
 *   4. gradlew assembleRelease
 *   5. 校验 APK 内的 supabase.js 确实指向测试库（unzip 抽查）
 *   6. 重新 cap sync 还原 assets 为生产配置（防止后续 release-apk 把测试配置打进正式包）
 *
 * 产出：android/app/build/outputs/apk/release/app-release.apk（测试专用）
 * 安全：不写任何线上版本表、不上传 Storage、不拷贝到桌面（桌面只有正式 有爱.apk）
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const APK_PATH = join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const ASSETS_SUPABASE = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public', 'js', 'supabase.js');

function loadDotenv(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

// 正式包的生产 URL（根 .env），测试 APK 绝不能等于它
const prodUrl = loadDotenv(join(ROOT, '.env')).SUPABASE_URL;

const testEnv = loadDotenv(join(ROOT, 'app-e2e', '.env.test'));
const TEST_URL = testEnv.E2E_SUPABASE_URL;
const TEST_ANON_KEY = testEnv.E2E_SUPABASE_ANON_KEY;

if (!TEST_URL || !TEST_ANON_KEY) {
  console.error('✗ app-e2e/.env.test 缺少 E2E_SUPABASE_URL / E2E_SUPABASE_ANON_KEY');
  process.exit(1);
}
if (TEST_URL === prodUrl) {
  console.error('✗ 测试库 URL 与生产库相同，拒绝构建（铁律一：测试必须物理隔离）');
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  console.log(`  → ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 失败（exit ${r.status}）`);
  }
}

function capSync() {
  run('npx', ['cap', 'sync', 'android'], { cwd: ROOT });
}

try {
  console.log('\n🧪 构建测试专用 APK（Supabase → 独立测试库）\n');
  console.log(`  测试库：${TEST_URL}`);

  // 1. 同步最新 web 资源到 android assets
  capSync();
  if (!existsSync(ASSETS_SUPABASE)) {
    throw new Error(`未找到 ${ASSETS_SUPABASE}，请确认 cap sync 成功`);
  }

  // 2. 替换 assets 内 supabase.js 为测试库配置
  let code = readFileSync(ASSETS_SUPABASE, 'utf8');
  const before = code;
  code = code.replace(/const SUPABASE_URL = '[^']*';/, `const SUPABASE_URL = '${TEST_URL}';`);
  code = code.replace(/const SUPABASE_ANON_KEY = '[^']*';/, `const SUPABASE_ANON_KEY = '${TEST_ANON_KEY}';`);
  if (code === before || !code.includes(TEST_URL)) {
    throw new Error('替换 supabase.js 失败：URL/KEY 字面量未命中，请检查文件结构');
  }
  writeFileSync(ASSETS_SUPABASE, code);
  console.log('  ✓ assets supabase.js 已指向测试库');

  // 3. 打包
  run('./gradlew', ['assembleRelease'], { cwd: join(ROOT, 'android') });
  if (!existsSync(APK_PATH)) throw new Error(`打包完成但未找到 ${APK_PATH}`);

  // 4. 抽查 APK 内 supabase.js 确实是测试库
  const check = spawnSync('unzip', ['-p', APK_PATH, 'assets/public/js/supabase.js'], { encoding: 'utf8' });
  if (check.status !== 0 || !check.stdout.includes(TEST_URL)) {
    throw new Error('APK 内 supabase.js 校验失败：未检出测试库 URL，禁止用于测试');
  }
  const sha256 = createHash('sha256').update(readFileSync(APK_PATH)).digest('hex');
  console.log('\n✅ 测试 APK 构建完成');
  console.log(`   路径：${APK_PATH}`);
  console.log(`   SHA-256：${sha256}`);
  console.log('   ⚠️ 仅测试用：不发布、不上传版本表、不拷贝到桌面');
} finally {
  // 5. 无论成败都还原 assets 为生产配置，防止后续 release-apk 打进测试配置
  if (existsSync(ASSETS_SUPABASE) && readFileSync(ASSETS_SUPABASE, 'utf8').includes(TEST_URL)) {
    console.log('\n  → 还原 android assets 为生产配置（重新 cap sync）...');
    capSync();
    console.log('  ✓ 已还原为生产库配置');
  }
}
