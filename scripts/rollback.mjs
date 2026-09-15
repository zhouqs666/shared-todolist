/**
 * 紧急**下线**脚本：把指定版本置 enabled=false（止损），并说明它与"回滚"的区别
 *
 * 用法：
 *   node scripts/rollback.mjs <版本号>
 *   node scripts/rollback.mjs 2.7.57
 *
 * 原理与边界（2026-09-16 更正原措辞）：
 *   客户端拉版本时会忽略 enabled=false 的行，所以下线后**还没更新 + 新装机**会拿到更早的启用版本；
 *   但**已经更新到该版本的设备不会退回去** —— 客户端判定更新用的是「服务端版本 ≤ 本地版本 → 无更新」
 *   （update.js / apk-update.js），这些设备本地版本已经更高，会一直停在上面。
 *   要让它们退回来，只能发一个「版本号更高、内容为旧代码」的包：
 *       node scripts/release.mjs <更高的新版本号> --from-git <旧 ref>
 *   详见 AGENTS.md 铁律三「下线 ≠ 回滚」。
 *
 * 安全：使用 service_role key，仅本地运行。只改 enabled 一列（不动 Storage、不删记录）。
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const ENV_PATH = resolve(ROOT, '.env');

// 简易 .env 解析（避免引入 dotenv 依赖）
function loadEnv() {
  if (!existsSync(ENV_PATH)) {
    throw new Error(`.env 不存在：${ENV_PATH}`);
  }
  const env = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('用法：node scripts/rollback.mjs <版本号>');
  process.exit(1);
}
const VERSION = args[0];
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error(`✗ 版本号格式错误：${VERSION}，应为 x.y.z`);
  process.exit(1);
}

const env = loadEnv();
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

console.log(`\n→ 查询版本 ${VERSION} 的当前状态…`);
const { data: rows, error: qErr } = await supabase
  .from('app_versions')
  .select('id, version, enabled, released_at, notes')
  .eq('version', VERSION)
  .order('released_at', { ascending: false });

if (qErr) throw new Error(`查询失败：${qErr.message}`);
if (!rows || rows.length === 0) {
  console.error(`✗ 找不到版本 ${VERSION}（已下线？）`);
  process.exit(1);
}
console.table(rows);

const target = rows[0];
if (target.enabled === false) {
  console.log(`✓ 版本 ${VERSION} 已经是 enabled=false，无需操作`);
  process.exit(0);
}

console.log(`\n→ 正在把版本 ${VERSION} 置为 enabled=false…`);
const { error: uErr } = await supabase
  .from('app_versions')
  .update({ enabled: false })
  .eq('id', target.id);

if (uErr) throw new Error(`回滚失败：${uErr.message}`);

const { data: verify, error: vErr } = await supabase
  .from('app_versions')
  .select('id, version, enabled')
  .eq('id', target.id)
  .single();

if (vErr) throw new Error(`回滚后校验失败：${vErr.message}`);
if (verify.enabled === false) {
  // 动态查当前最新 enabled 版本，只用于说明"新设备会拿到哪个"（不是"设备会退到哪个"，见下）
  const { data: latest } = await supabase
    .from('app_versions')
    .select('version')
    .eq('enabled', true)
    .order('released_at', { ascending: false })
    .limit(1);
  const fallback =
    latest && latest.length > 0 ? `（还没更新的设备将装到 ${latest[0].version}）` : '';
  console.log(`\n✅ 已下线（止损完成）`);
  console.log(`   版本 ${VERSION} 已在 ${new Date().toLocaleString('zh-CN')} 下线`);
  console.log(`   生效时机：用户下次冷启动 App 时（已打开的需要杀掉重开 1 次）${fallback}`);
  console.log('');
  console.log('   ⚠️ 这只是「下线」，不是「回滚」：');
  console.log('      已经更新到该版本的设备**不会退回去** —— 客户端判定更新用的是');
  console.log('      「服务端版本 ≤ 本地版本 → 无更新」，它们的本地版本已经更高了。');
  console.log('      要让那些设备退回来，得发一个「版本号更高、内容为旧代码」的包：');
  console.log(`        node scripts/release.mjs <更高的新版本号> --from-git <旧 ref> --dry-run`);
  console.log('      （先 dry-run 预演：会打印将回退掉哪些改动 + 回读校验包内 meta）');
} else {
  console.error(`✗ 校验失败：enabled 仍为 ${verify.enabled}`);
  process.exit(1);
}
