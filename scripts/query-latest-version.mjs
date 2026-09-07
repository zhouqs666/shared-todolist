/**
 * 查询线上最新 enabled 版本（发布前自检第 1 步）
 * 用法：node scripts/query-latest-version.mjs
 * 只读查询 app_versions 表，不触碰任何数据。
 */
import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const envPath = join(ROOT, '.env');

if (!existsSync(envPath)) {
  console.error('✗ 找不到 .env');
  process.exit(1);
}
const lines = readFileSync(envPath, 'utf8').split('\n');
for (const line of lines) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq < 0) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[k]) process.env[k] = v;
}

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;
if (!URL || !KEY) {
  console.error('✗ .env 缺少 SUPABASE_URL / SUPABASE_KEY');
  process.exit(1);
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } });
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
