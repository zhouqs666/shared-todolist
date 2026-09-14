/**
 * 测试库归零（E2E 前置：保证每次从干净初态起跑）
 *
 * 为什么需要：
 *   1. 「测完清理」是假象 —— 测试调 deleteTodo() 走的是软删除（deleted_at 打时间戳），
 *      行永远留在表里。看似清干净，实际测试库越跑越脏。
 *   2. stickers 表对 sticker_key 有 UNIQUE 约束，解锁幂等。一旦 epic_1/legendary_1
 *      在测试库被解锁，之后再也无法验证「首次解锁」那条路径（开奖弹窗/庆祝动画/图鉴+1）
 *      —— 盲盒功能的核心卖点在测试环境里变得不可测。
 *
 * 安全设计（铁律一）：
 *   - 硬闸一：只认 app-e2e/.env.test 的测试库；URL 等于 .env 的生产库则拒绝执行
 *   - 硬闸二：先 SELECT 列出待删 id 清单并打印，再按**显式 id** 删除（不用 LIKE 一把梭）
 *   - 只删 E2E- 前缀待办（含回收站）与图鉴贴纸；发现非 E2E 待办只报告不删
 *
 * 用法：node scripts/reset-test-db.mjs [--dry-run]
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));

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

const prodUrl = loadDotenv(path.join(ROOT, '.env')).SUPABASE_URL;
const testEnv = loadDotenv(path.join(ROOT, 'app-e2e', '.env.test'));
const testUrl = testEnv.E2E_SUPABASE_URL;
const testKey = testEnv.E2E_SUPABASE_SERVICE_ROLE_KEY;

// ===== 硬闸一：必须是隔离的测试库 =====
function abort(msg) {
  console.error('\n✗ 拒绝执行（铁律一）\n');
  console.error(`  ${msg}\n`);
  process.exit(1);
}
if (!testUrl || !testKey) abort('app-e2e/.env.test 缺少 E2E_SUPABASE_URL / E2E_SUPABASE_SERVICE_ROLE_KEY');
if (!prodUrl) abort('读不到 .env 的 SUPABASE_URL，无法确认隔离性（fail-closed）');
if (testUrl === prodUrl) abort(`测试库 URL 与生产库相同：${testUrl}`);

const sb = createClient(testUrl, testKey);
const E2E_PREFIX = 'E2E-';

console.log('\n=== 测试库归零 ===');
console.log(`  目标库：${testUrl}`);
console.log(`  生产库：${prodUrl}  ← 绝不触碰`);
console.log(`  模式：${DRY_RUN ? 'DRY-RUN（只报告不删）' : '实际执行'}\n`);

// ===== 1. 收集待删对象（显式 id）=====
const { data: allTodos, error: e1 } = await sb
  .from('todos')
  .select('id, text, deleted_at');
if (e1) abort(`读取 todos 失败：${e1.message}`);

const targets = allTodos.filter((t) => t.text && t.text.startsWith(E2E_PREFIX));
const others = allTodos.filter((t) => !(t.text && t.text.startsWith(E2E_PREFIX)));

const { data: allStickers, error: e2 } = await sb.from('stickers').select('id, sticker_key, unlocked_at');
if (e2) abort(`读取 stickers 失败：${e2.message}`);

console.log(`待删待办：${targets.length} 条（${E2E_PREFIX} 前缀）`);
targets.forEach((t) => console.log(`   ${t.deleted_at ? '[回收站]' : '[活跃  ]'} "${t.text}"  ${t.id}`));

console.log(`\n待删贴纸：${allStickers.length} 张（图鉴归零，让「首次解锁」路径重新可测）`);
allStickers.forEach((s) => console.log(`   ${s.sticker_key}  ${s.id}`));

if (others.length) {
  console.log(`\n⚠️ 非 ${E2E_PREFIX} 前缀待办 ${others.length} 条 —— 不在清理范围内，仅报告：`);
  others.forEach((t) => console.log(`   "${t.text}"  ${t.id}`));
}

if (!targets.length && !allStickers.length) {
  console.log('\n✅ 测试库已是干净初态，无需清理。\n');
  process.exit(0);
}

if (DRY_RUN) {
  console.log('\n（DRY-RUN 结束，未做任何删除）\n');
  process.exit(0);
}

// ===== 2. 按显式 id 删除 =====
const todoIds = targets.map((t) => t.id);
const stickerIds = allStickers.map((s) => s.id);

if (stickerIds.length) {
  const { error } = await sb.from('stickers').delete().in('id', stickerIds);
  if (error) abort(`删除贴纸失败：${error.message}`);
  console.log(`\n✓ 已删除贴纸 ${stickerIds.length} 张`);
}

if (todoIds.length) {
  // 关联 reactions 由 ON DELETE CASCADE 处理
  const { data: deleted, error } = await sb.from('todos').delete().in('id', todoIds).select('id');
  if (error) abort(`删除待办失败：${error.message}`);
  console.log(`✓ 已删除待办 ${deleted.length} 条`);
}

// ===== 3. 验证 =====
const { data: leftTodos } = await sb.from('todos').select('id, text');
const { data: leftStickers } = await sb.from('stickers').select('id');
const leftE2E = leftTodos.filter((t) => t.text && t.text.startsWith(E2E_PREFIX));

console.log('\n--- 验证 ---');
console.log(`  剩余 ${E2E_PREFIX} 待办：${leftE2E.length} 条`);
console.log(`  剩余贴纸：${leftStickers.length} 张`);
console.log(`  剩余其它待办：${leftTodos.length - leftE2E.length} 条（非测试数据，未动）`);

if (leftE2E.length === 0 && leftStickers.length === 0) {
  console.log('\n✅ 测试库已归零\n');
} else {
  console.log('\n⚠️ 仍有残留，请检查\n');
  process.exit(1);
}
