#!/usr/bin/env node
/**
 * 待办提醒纯逻辑回归（**零凭据、零 DOM、零网络**，进 CI 的 Node 回归）
 *
 * 为什么要有这个文件：提醒的对账逻辑写错不会报错，只会「该响的不响、
 * 不该响的乱响」—— 而且只在真机上到点才暴露（本地开发时几乎不可能等 5 分钟）。
 * 所以把可判定的部分钉在断言上：合成待办 → 期望的调度/取消计划 → 对齐。
 *
 * 覆盖：
 *   1. notificationIdFor：UUID → 通知 id 的确定性、无溢出（< 2^28）、已知样本钉住、批量不碰撞
 *   2. shouldScheduleReminder：范围三选（both/self/partner）的命中判断、
 *      完成/软删除/过期/缺字段的一票否决
 *   3. planReminderSync：对账 diff —— 新增调度、多余取消、**同 id 改时间要重排**
 *      （这是最容易写错的分支：id 不变时只比 id 会把「改了时间」误判成「无需动」）
 *   4. 快捷档：QUICK_OPTIONS 钉住 [5,10,15,30]（改档位要显式改这条断言，
 *      防止无意中动了用户已习惯的入口）
 *   5. formatReminderTime / isReminderExpired：徽标文案与置灰判断
 *
 * 运行：node scripts/test_reminder_logic.mjs
 * （readonly-guard 不适用：纯函数，不 import supabase/playwright）
 */

import {
  QUICK_OPTIONS,
  quickOptionAt,
  notificationIdFor,
  shouldScheduleReminder,
  planReminderSync,
  formatReminderTime,
  isReminderExpired,
  REMINDER_SYNC_TOLERANCE_MS,
} from '../public/js/reminder-logic.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `期望 ${e}，实际 ${a}`);
}

const NOW = new Date('2026-10-01T04:00:00Z'); // 北京时间 12:00
const ME = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const futureAt = (min) => new Date(NOW.getTime() + min * 60_000).toISOString();

/** 造一条提醒待办（camelCase，与 transforms.toExternal 的形状一致） */
function todoWith(overrides = {}) {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    text: 'E2E-测试-提醒',
    completed: false,
    deletedAt: null,
    reminderAt: futureAt(30),
    reminderScope: 'both',
    reminderBy: ME,
    ...overrides,
  };
}

// ---------------------------------------------------------------- 1. 通知 id
console.log('\n== 1. notificationIdFor（UUID → 确定性通知 id）==');
{
  const id = 'aaaaaaaa-0000-4000-8000-000000000001';
  const n1 = notificationIdFor(id);
  const n2 = notificationIdFor(id);
  check('同一 id 两次派生结果一致（幂等，取消可反推）', n1 === n2);
  check('结果为正整数且 < 2^28（不撞 int32 符号位、不为 0 的系统保留值）',
    Number.isInteger(n1) && n1 > 0 && n1 < 0x10000000, `实际 ${n1}`);
  check('已知样本钉住（改 hash 算法必须显式更新这条）', n1 === 0xaaaaaaa, `实际 ${n1}`);
  check('不同 id 派生不同 id', notificationIdFor('bbbbbbbb-0000-4000-8000-000000000001') !== n1);
  eq('空输入返回 0', notificationIdFor(''), 0);
  eq('null 返回 0', notificationIdFor(null), 0);

  // 批量不碰撞：256 个真随机 UUID（crypto.randomUUID）全不碰撞
  const { randomUUID } = await import('node:crypto');
  const seen = new Set();
  let collided = false;
  for (let i = 0; i < 256; i++) {
    const nid = notificationIdFor(randomUUID());
    if (seen.has(nid)) { collided = true; break; }
    seen.add(nid);
  }
  check('256 个随机 UUID 无碰撞（值域 2^28，理论碰撞率 ~1e-4）', !collided);
}

// ---------------------------------------------------------------- 2. 调度判定
console.log('\n== 2. shouldScheduleReminder（本机要不要调度这条提醒）==');
{
  check('both + 未来 + 未完成 → true', shouldScheduleReminder(todoWith(), ME, NOW) === true);
  check('both：对方设备也响', shouldScheduleReminder(todoWith(), PARTNER, NOW) === true);

  check('self：设置者本机响',
    shouldScheduleReminder(todoWith({ reminderScope: 'self' }), ME, NOW) === true);
  check('self：对方设备不响',
    shouldScheduleReminder(todoWith({ reminderScope: 'self' }), PARTNER, NOW) === false);

  check('partner：对方设备响',
    shouldScheduleReminder(todoWith({ reminderScope: 'partner' }), PARTNER, NOW) === true);
  check('partner：设置者本机不响',
    shouldScheduleReminder(todoWith({ reminderScope: 'partner' }), ME, NOW) === false);

  check('已完成 → 不响', shouldScheduleReminder(todoWith({ completed: true }), ME, NOW) === false);
  check('软删除 → 不响', shouldScheduleReminder(todoWith({ deletedAt: NOW.toISOString() }), ME, NOW) === false);
  check('提醒时间已过 → 不响', shouldScheduleReminder(todoWith({ reminderAt: futureAt(-5) }), ME, NOW) === false);
  check('提醒时间=现在（边界）→ 不响', shouldScheduleReminder(todoWith({ reminderAt: NOW.toISOString() }), ME, NOW) === false);
  check('提醒时间非法 → 不响', shouldScheduleReminder(todoWith({ reminderAt: 'not-a-date' }), ME, NOW) === false);
  check('缺 remindAt → 不响', shouldScheduleReminder(todoWith({ reminderAt: null }), ME, NOW) === false);
  check('缺 remindScope → 不响', shouldScheduleReminder(todoWith({ reminderScope: null }), ME, NOW) === false);
  check('缺 remindBy → 不响（无法判断 self/partner 语义）', shouldScheduleReminder(todoWith({ reminderBy: null }), ME, NOW) === false);
  check('未知 scope 值 → 不响（DB CHECK 挡不住的脏数据走 fail-closed）',
    shouldScheduleReminder(todoWith({ reminderScope: 'everyone' }), ME, NOW) === false);
  check('myUserId 为空 → 不响', shouldScheduleReminder(todoWith(), null, NOW) === false);
  check('离线待办（无真实 id）→ 不响', shouldScheduleReminder(todoWith({ id: 'offline-1727740800-x1' }), ME, NOW) === false);
}

// ---------------------------------------------------------------- 3. 对账 diff
console.log('\n== 3. planReminderSync（多退少补）==');
{
  // 场景 A：本机一条都没调度 → 全部新建
  // （两条夹具 id 前缀刻意不同：通知 id 取 UUID 前 7 位 hex，前缀相同会碰撞成同一个通知 id）
  {
    const todos = [todoWith(), todoWith({ id: 'bbbbbbbb-0000-4000-8000-000000000002', reminderAt: futureAt(60) })];
    const plan = planReminderSync([], todos, ME, NOW);
    eq('场景A：空 pending → 全部进 toSchedule', plan.toSchedule.map((s) => s.id),
      [notificationIdFor(todos[0].id), notificationIdFor(todos[1].id)]);
    eq('场景A：toCancel 为空', plan.toCancel, []);
  }

  // 场景 B：pending 与期望完全一致（容差内）→ 不动（幂等，防每次渲染都重排）
  {
    const todos = [todoWith()];
    const pending = [{ id: notificationIdFor(todos[0].id), schedule: { at: futureAt(30) } }];
    const plan = planReminderSync(pending, todos, ME, NOW);
    eq('场景B：一致 → 不重排', plan, { toCancel: [], toSchedule: [] });
  }

  // 场景 C：改时间 —— id 不变但触发时刻漂移超出容差 → cancel + 重排
  {
    const todos = [todoWith({ reminderAt: futureAt(90) })]; // 已从 30 改到 90
    const pending = [{ id: notificationIdFor(todos[0].id), schedule: { at: futureAt(30) } }];
    const plan = planReminderSync(pending, todos, ME, NOW);
    eq('场景C：改时间 → cancel 旧调度', plan.toCancel, [notificationIdFor(todos[0].id)]);
    eq('场景C：改时间 → 重排新时刻', plan.toSchedule.map((s) => s.id), [notificationIdFor(todos[0].id)]);
  }

  // 场景 D：容差内的小漂移（原生层读回的亚秒误差）→ 不动
  {
    const todos = [todoWith()];
    const pending = [{
      id: notificationIdFor(todos[0].id),
      schedule: { at: new Date(NOW.getTime() + 30 * 60_000 - REMINDER_SYNC_TOLERANCE_MS / 2).toISOString() },
    }];
    const plan = planReminderSync(pending, todos, ME, NOW);
    eq('场景D：容差内漂移 → 不重排', plan, { toCancel: [], toSchedule: [] });
  }

  // 场景 E：pending 里的 id 已不该响（完成/删除/范围变化）→ cancel
  {
    const doneTodo = todoWith({ id: 'aaaaaaaa-0000-4000-8000-000000000003', completed: true });
    const plan = planReminderSync(
      [{ id: notificationIdFor(doneTodo.id), schedule: { at: futureAt(30) } }],
      [doneTodo], ME, NOW
    );
    eq('场景E：已完成的不再期望 → cancel', plan.toCancel, [notificationIdFor(doneTodo.id)]);
    eq('场景E：无新增', plan.toSchedule, []);
  }

  // 场景 F：pending 记录缺 schedule.at（旧数据/读回缺字段）→ 保守重排
  {
    const todos = [todoWith()];
    const plan = planReminderSync([{ id: notificationIdFor(todos[0].id) }], todos, ME, NOW);
    eq('场景F：缺触发时刻 → cancel+重排（保守正确）',
      { c: plan.toCancel.length, s: plan.toSchedule.length }, { c: 1, s: 1 });
  }

  // 场景 G：scope 变化导致本机退出提醒对象（self → partner 且我是设置者）→ cancel
  {
    const todos = [todoWith({ reminderScope: 'partner' })];
    const plan = planReminderSync(
      [{ id: notificationIdFor(todos[0].id), schedule: { at: futureAt(30) } }],
      todos, ME, NOW
    );
    eq('场景G：本机不再命中 → cancel', plan.toCancel, [notificationIdFor(todos[0].id)]);
  }

  // 场景 H：pending 的 id 是数字形状校验（字符串 id 被忽略，不误 cancel）
  {
    const plan = planReminderSync([{ id: 'not-a-number' }], [todoWith()], ME, NOW);
    eq('场景H：非法 pending 记录跳过', plan.toCancel, []);
  }
}

// ---------------------------------------------------------------- 4. 快捷档
console.log('\n== 4. 快捷档（写死在代码里的入口，改动必须显式）==');
{
  eq('快捷档 = [5, 10, 15, 30] 分钟', QUICK_OPTIONS, [5, 10, 15, 30]);
  const at = quickOptionAt(10, NOW);
  check('quickOptionAt(10) = now+10分钟',
    Math.abs(at.getTime() - (NOW.getTime() + 10 * 60_000)) < 1000, `实际 ${at.toISOString()}`);
}

// ---------------------------------------------------------------- 5. 展示辅助
console.log('\n== 5. formatReminderTime / isReminderExpired（徽标文案与置灰）==');
{
  // 北京时区语义验证用固定时区偏移构造：NOW 是 12:00（+08:00），同日 12:30
  const sameDay = new Date(NOW.getTime() + 30 * 60_000).toISOString();
  check('同一天 → 只显示 HH:mm（不含日期）', /^\d{2}:\d{2}$/.test(formatReminderTime(sameDay, NOW)),
    `实际「${formatReminderTime(sameDay, NOW)}」`);
  const nextDay = new Date(NOW.getTime() + 26 * 3600_000).toISOString();
  check('跨天 → 含月日', /\d{1,2}\/\d{1,2}/.test(formatReminderTime(nextDay, NOW)),
    `实际「${formatReminderTime(nextDay, NOW)}」`);
  eq('空值 → 空串', formatReminderTime(null, NOW), '');

  check('未来 → 未过期', isReminderExpired(todoWith(), NOW) === false);
  check('已过 → 过期（徽标置灰）', isReminderExpired(todoWith({ reminderAt: futureAt(-1) }), NOW) === true);
  check('无提醒 → 不过期（无提醒就没有过期态）', isReminderExpired(todoWith({ reminderAt: null }), NOW) === false);
}

console.log(`\n== 结果: ${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail > 0 ? 1 : 0);
