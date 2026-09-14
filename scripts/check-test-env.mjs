/**
 * 测试环境就绪检查（铁律一 + 铁律二的交叉守卫）
 *
 * 解决两个问题：
 *   1. 隔离：确认 app-e2e/.env.test 的测试库 ≠ .env 的生产库
 *   2. 保真：确认测试库 schema 不落后于生产库
 *      —— 落后会让 E2E「跑绿但没验证真实行为」（假阴性，铁律二）
 *      实例：测试库曾缺 stickers 表 + rarity 列，盲盒功能在测试库上根本无从触发
 *
 * 用法：node scripts/check-test-env.mjs
 * 退出码：0 = 就绪；1 = 有问题（不可跑 E2E）
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

function loadDotenv(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
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

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const prodEnv = loadDotenv(path.join(ROOT, '.env'));
const testEnv = loadDotenv(path.join(ROOT, 'app-e2e', '.env.test'));

const prodUrl = prodEnv.SUPABASE_URL;
const testUrl = testEnv.E2E_SUPABASE_URL;
const testKey = testEnv.E2E_SUPABASE_SERVICE_ROLE_KEY || testEnv.E2E_SUPABASE_ANON_KEY;

// 期望结构（对齐 supabase/schema.sql + migration-*.sql）
const EXPECTED_TABLES = ['todos', 'profiles', 'reactions', 'daily_notes', 'stickers', 'app_versions', 'app_native_versions'];
const EXPECTED_TODO_COLUMNS = [
  'id', 'text', 'completed', 'completed_by', 'completed_at', 'completed_note',
  'created_by', 'created_at', 'deleted_at', 'pinned', 'rarity', 'rarity_seen',
  'image_path', 'image_paths',
];
const EXPECTED_PROFILE_COLUMNS = ['id', 'username', 'display_name', 'last_seen_at', 'login_count_for_partner'];

let problems = 0;
const fail = (msg) => { problems++; console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

console.log('\n=== 测试环境就绪检查 ===\n');

// ===== 1. 隔离 =====
console.log('[1/4] 生产库隔离');
if (!prodUrl || !testUrl) {
  fail(`读不到库地址（生产:${prodUrl ? '有' : '缺'} 测试:${testUrl ? '有' : '缺'}），请检查 .env 与 app-e2e/.env.test`);
} else if (testUrl === prodUrl) {
  fail(`测试库与生产库相同：${testUrl} —— 铁律一，绝不可跑测试`);
} else if (!testKey) {
  fail('app-e2e/.env.test 缺少 E2E_SUPABASE_SERVICE_ROLE_KEY / ANON_KEY');
} else {
  ok(`测试库 ≠ 生产库`);
  console.log(`      生产: ${prodUrl}`);
  console.log(`      测试: ${testUrl}`);
}

if (problems) {
  console.log('\n✗ 环境不可用，已阻断。\n');
  process.exit(1);
}

const test = createClient(testUrl, testKey);

// ===== 2. 表 =====
console.log('\n[2/4] 表结构（测试库 vs 期望）');
for (const t of EXPECTED_TABLES) {
  const { error } = await test.from(t).select('*').limit(1);
  if (error) fail(`缺表 ${t} —— ${error.message}`);
  else ok(`表 ${t}`);
}

// ===== 3. todos 列 =====
console.log('\n[3/4] todos 列（测试库 vs 期望）');
for (const c of EXPECTED_TODO_COLUMNS) {
  const { error } = await test.from('todos').select(c).limit(1);
  if (error) fail(`缺列 todos.${c}`);
  else ok(`列 todos.${c}`);
}

// ===== 4. profiles 列 =====
console.log('\n[4/4] profiles 列（测试库 vs 期望）');
for (const c of EXPECTED_PROFILE_COLUMNS) {
  const { error } = await test.from('profiles').select(c).limit(1);
  if (error) fail(`缺列 profiles.${c}`);
  else ok(`列 profiles.${c}`);
}

console.log('');
if (problems) {
  console.log(`✗ 共 ${problems} 处问题：测试库 schema 落后，E2E 会「跑绿但没验证真实行为」（铁律二）。`);
  console.log('  修复：测试项目 Dashboard → SQL Editor → 按顺序执行 supabase/ 下缺失的 migration-*.sql');
  console.log('  （这些文件都是幂等的，可整批粘贴执行）\n');
  process.exit(1);
}
console.log('✅ 测试环境就绪：隔离通过 + schema 对齐\n');
