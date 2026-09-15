/**
 * 查询线上版本信息（发布前自检第 1 步）
 * 用法：node scripts/query-latest-version.mjs
 * 只读查询 app_versions 表，不触碰任何数据。
 *
 * 输出两个口径（2026-09-16 加第二个）：
 *   · 最新 enabled 版本 —— 「用户现在装的是哪个」
 *   · 历史上出现过的最高版本（含已下线）—— **下一个版本号必须大于它**
 * 为什么两个都要看：客户端判定更新是「服务端版本 ≤ 本地版本 → 无更新」，而设备本地版本可能是
 * 某个曾经下发过、后来被下线的版本（回滚演练就会留下这种行，如 2.7.65 的 enabled=false）。
 * 只比 enabled 行会放行那个号，导致那批设备永远收不到更新。release.mjs 的守卫用的就是这个口径。
 */
import { createClient } from '@supabase/supabase-js';
import { loadEnv, requireSupabaseEnv } from './_lib-env.mjs';
import { compareVersions } from './_lib-version-check.mjs';

loadEnv();
const { url, key } = requireSupabaseEnv();

const sb = createClient(url, key, { auth: { persistSession: false } });

const { data: enabledRows, error: e1 } = await sb
  .from('app_versions')
  .select('version, released_at, notes')
  .eq('enabled', true)
  .order('released_at', { ascending: false });

if (e1) {
  console.error('✗ 查询失败:', e1.message);
  process.exit(1);
}

if (!enabledRows || enabledRows.length === 0) {
  console.log('（线上暂无 enabled 版本记录）');
} else {
  const latest = enabledRows[0];
  console.log('线上最新 enabled 版本:', latest.version);
  console.log('  发布时间:', latest.released_at);
  if (latest.notes) console.log('  说明:', latest.notes);
}

// 全表最高版本（含已下线的行）：下一个号必须严格大于它
const { data: allRows, error: e2 } = await sb
  .from('app_versions')
  .select('version, enabled');

if (e2) {
  console.error('✗ 查询全量版本失败:', e2.message);
  process.exit(1);
}

if (allRows && allRows.length > 0) {
  let highest = allRows[0];
  for (const row of allRows) {
    if (compareVersions(row.version, highest.version) > 0) highest = row;
  }
  const offlineTag = highest.enabled === false ? '（已下线，但号已经用过）' : '';
  console.log('');
  console.log(`历史最高版本: ${highest.version}${offlineTag}`);
  console.log('  → 新版本号必须严格大于它（release.mjs / release-apk.mjs 会强制校验）');
}
