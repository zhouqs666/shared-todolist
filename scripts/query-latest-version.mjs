/**
 * 查询线上最新 enabled 版本（发布前自检第 1 步）
 * 用法：node scripts/query-latest-version.mjs
 * 只读查询 app_versions 表，不触碰任何数据。
 */
import { createClient } from '@supabase/supabase-js';
import { loadEnv, requireSupabaseEnv } from './_lib-env.mjs';

loadEnv();
const { url, key } = requireSupabaseEnv();

const sb = createClient(url, key, { auth: { persistSession: false } });
const { data, error } = await sb
  .from('app_versions')
  .select('version, released_at, notes')
  .eq('enabled', true)
  .order('released_at', { ascending: false })
  .limit(1);

if (error) {
  console.error('✗ 查询失败:', error.message);
  process.exit(1);
}
if (!data || data.length === 0) {
  console.log('（线上暂无 enabled 版本记录）');
  process.exit(0);
}
const latest = data[0];
console.log('线上最新 enabled 版本:', latest.version);
console.log('  发布时间:', latest.released_at);
if (latest.notes) console.log('  说明:', latest.notes);
