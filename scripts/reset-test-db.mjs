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
 *   - 只删 web 通道的 E2E- 前缀待办（含回收站）与图鉴贴纸；发现非 E2E 待办只报告不删
 *   - **APP 通道（`E2E-APP-`）的数据一律不碰**：那个前缀也以 `E2E-` 开头，按前缀一刀切
 *     会删掉正在跑的 Appium 用例的夹具（2026-09-14 批次 C 发现两通道命名空间重叠）
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

// 生产 URL：本地读 .env，CI 用环境变量注入（与 serve-test.mjs / check-test-env.mjs 同一条约定）。
// 拿不到就 fail-closed（下面的硬闸一），「必须证明隔离」这条没有放松。
const prodUrl = process.env.SUPABASE_URL || loadDotenv(path.join(ROOT, '.env')).SUPABASE_URL;
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
// APP 通道（app-e2e / Appium）用 `E2E-APP-` 前缀。**它同样以 `E2E-` 开头**，
// 所以按 `E2E-` 过滤会连它一起删 —— 正在跑的 Appium 用例会因此丢夹具而失败
// （2026-09-14 批次 C 发现：两个通道的命名空间其实是重叠的）。
// 跨通道只读不删：这是铁律一「不要删不属于你的数据」在测试库内部的对应要求。
const APP_PREFIX = 'E2E-APP-';
const isWebE2E = (t) => Boolean(t.text) && t.text.startsWith(E2E_PREFIX) && !t.text.startsWith(APP_PREFIX);
const isAppE2E = (t) => Boolean(t.text) && t.text.startsWith(APP_PREFIX);

console.log('\n=== 测试库归零 ===');
console.log(`  目标库：${testUrl}`);
console.log(`  生产库：${prodUrl}  ← 绝不触碰`);
console.log(`  模式：${DRY_RUN ? 'DRY-RUN（只报告不删）' : '实际执行'}\n`);

// ===== 1. 收集待删对象（显式 id）=====
const { data: allTodos, error: e1 } = await sb
  .from('todos')
  .select('id, text, deleted_at');
if (e1) abort(`读取 todos 失败：${e1.message}`);

const targets = allTodos.filter(isWebE2E);
const appData = allTodos.filter(isAppE2E);
const others = allTodos.filter((t) => !isWebE2E(t) && !isAppE2E(t));

const { data: allStickers, error: e2 } = await sb.from('stickers').select('id, sticker_key, unlocked_at');
if (e2) abort(`读取 stickers 失败：${e2.message}`);

// daily_notes（心里话）全清：阅后即焚数据在测试库纯属残留，且**残留会改变被测行为**——
// 2026-10-02 实证：库里多一条未读，「长按珍藏」就变成「下一条」翻页，珍藏仪式根本测不到。
const { data: allNotes, error: e3 } = await sb.from('daily_notes').select('id, content, deleted_at');
if (e3) abort(`读取 daily_notes 失败：${e3.message}`);

// 待办留言（todo_comments）全清：与心里话同理 —— 残留会改变被测行为。
// 实证场景：库里已有留言 → 卡片上气泡已亮、未读圆点已消、留言板非空态，
// 于是「首次留言 / 未读提示 / 空态」这三条路径根本测不到（和贴纸一个道理）。
// 关联 comment_likes 由 comment_id 的 ON DELETE CASCADE 处理。
//
// 表可能尚未在测试库建（迁移刚合入、还没应用的窗口期）：此时**跳过并警告**，
// 不能让"没有这张表"把整套 E2E 卡死 —— schema 漂移的判据是 check-test-schema.mjs
// （契约检查器，会把缺表判红），留言 E2E 自己也会因为功能不可用而红，两道闸都不缺。
const missingTable = (err) =>
  err.code === 'PGRST205' || err.code === '42P01' || /schema cache|does not exist/i.test(err.message || '');

/** 读一张表；表不存在（迁移未应用）→ 返回 null 并警告 */
async function readTable(table, select) {
  const { data, error } = await sb.from(table).select(select);
  if (error) {
    if (missingTable(error)) {
      console.log(`\n⚠️ ${table} 不在测试库（迁移未应用？）—— 本轮跳过对它的清理与校验；相关 E2E 断言本轮不可验证`);
      return null;
    }
    abort(`读取 ${table} 失败：${error.message}`);
  }
  return data || [];
}

const allComments = (await readTable('todo_comments', 'id, todo_id, content, parent_id, deleted_at')) || [];

console.log(`待删待办：${targets.length} 条（web 通道，${E2E_PREFIX} 前缀且非 ${APP_PREFIX}）`);
targets.forEach((t) => console.log(`   ${t.deleted_at ? '[回收站]' : '[活跃  ]'} "${t.text}"  ${t.id}`));

console.log(`\n待删贴纸：${allStickers.length} 张（图鉴归零，让「首次解锁」路径重新可测）`);
allStickers.forEach((s) => console.log(`   ${s.sticker_key}  ${s.id}`));

console.log(`\n待删心里话：${allNotes.length} 条（daily_notes 全清，阅后即焚残留无保留价值）`);
allNotes.forEach((n) => console.log(`   ${n.deleted_at ? '[已焚]' : '[活跃]'} "${String(n.content).slice(0, 18)}"  ${n.id}`));

console.log(`\n待删留言：${allComments.length} 条（todo_comments 全清，残留会让"未读/空态"路径测不到）`);
allComments.forEach((c) =>
  console.log(`   ${c.deleted_at ? '[已删]' : '[活跃]'}${c.parent_id ? '[回复]' : '      '} "${String(c.content).slice(0, 18)}"  ${c.id}`)
);

if (appData.length) {
  console.log(`\nℹ️ APP 通道待办 ${appData.length} 条（${APP_PREFIX}）—— 不属于本通道，刻意不删：`);
  appData.forEach((t) => console.log(`   "${t.text}"  ${t.id}`));
}

if (others.length) {
  console.log(`\n⚠️ 非测试前缀待办 ${others.length} 条 —— 不在清理范围内，仅报告：`);
  others.forEach((t) => console.log(`   "${t.text}"  ${t.id}`));
}

if (!targets.length && !allStickers.length && !allNotes.length && !allComments.length) {
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
const noteIds = allNotes.map((n) => n.id);
const commentIds = allComments.map((c) => c.id);

if (stickerIds.length) {
  const { error } = await sb.from('stickers').delete().in('id', stickerIds);
  if (error) abort(`删除贴纸失败：${error.message}`);
  console.log(`\n✓ 已删除贴纸 ${stickerIds.length} 张`);
}

if (noteIds.length) {
  const { error } = await sb.from('daily_notes').delete().in('id', noteIds);
  if (error) abort(`删除心里话失败：${error.message}`);
  console.log(`✓ 已删除心里话 ${noteIds.length} 条`);
}

if (commentIds.length) {
  // 关联 comment_likes 由 comment_id 的 ON DELETE CASCADE 处理
  const { data: deleted, error } = await sb.from('todo_comments').delete().in('id', commentIds).select('id');
  if (error) abort(`删除留言失败：${error.message}`);
  console.log(`✓ 已删除留言 ${deleted.length} 条`);
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
const { data: leftNotes } = await sb.from('daily_notes').select('id');
const leftComments = (await readTable('todo_comments', 'id')) || [];
const leftE2E = leftTodos.filter(isWebE2E);
const leftApp = leftTodos.filter(isAppE2E);

console.log('\n--- 验证 ---');
console.log(`  剩余 web 通道待办：${leftE2E.length} 条`);
console.log(`  剩余贴纸：${leftStickers.length} 张`);
console.log(`  剩余心里话：${leftNotes.length} 条`);
console.log(`  剩余留言：${leftComments.length} 条`);
console.log(`  剩余 APP 通道待办：${leftApp.length} 条（不属于本通道，未动）`);
console.log(`  剩余其它待办：${leftTodos.length - leftE2E.length - leftApp.length} 条（非测试数据，未动）`);

if (leftE2E.length === 0 && leftStickers.length === 0 && leftNotes.length === 0 && leftComments.length === 0) {
  console.log('\n✅ 测试库已归零\n');
} else {
  console.log('\n⚠️ 仍有残留，请检查\n');
  process.exit(1);
}
