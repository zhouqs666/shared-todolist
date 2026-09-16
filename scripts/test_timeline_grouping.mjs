#!/usr/bin/env node
/**
 * 时光章节分组口径回归 —— **纯计算，不连数据库、不开浏览器**
 * （readonly-guard 不适用：本文件只 import public/js/timeline.js，无 playwright / supabase-js、零网络）
 *
 * 为什么要有这个文件（2026-09-16，第二批 第 2 步）：
 * 分章规则里有三处「写错了不报错、只会安静地分错」的判断，而且都不是肉眼能看出来的：
 *   ① **时区日界**：completed_at 是 timestamptz（UTC 瞬时）。用 toISOString().slice(0,10) 切天
 *      会按 UTC 分组 —— 东八区凌晨完成的事会被算成"昨天"，而界面照常显示，没人会发现。
 *   ② **章节顺序**：分章按完成时间，组内也必须按完成时间。若沿用 created_at 序切章，
 *      「创建 8/20、完成 8/25」会比「创建 8/1、完成 9/16」先落进"八月"章 —— 切出乱序章节。
 *   ③ **跨月/跨年边界**（9/1 看 8/31、1/1 看 12/31）：昨天到底算"昨天"还是算"八月"。
 * 三条都是边界条件，真机上要构造出来很麻烦 —— 所以钉在合成夹具上，进 CI。
 *
 * 运行：node scripts/test_timeline_grouping.mjs
 */

import { groupByLocalPeriod, localDayKey, localMonthKey } from '../public/js/timeline.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** 构造**本地**时刻（测的就是本地口径，所以夹具一律用本地构造函数，不写 'Z' 字面量） */
const L = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min);

/** 造一条待办；completedAt 为 null 表示"只给完成标记、没给时间"（兜底用例） */
function todo(id, opts = {}) {
  const { completed = true, completedAt = null, createdAt = null } = opts;
  return {
    id,
    text: `T-${id}`,
    completed,
    completedAt: completedAt ? completedAt.toISOString() : null,
    createdAt: (createdAt || completedAt || L(2026, 1, 1)).toISOString(),
  };
}

const labels = (chapters) => chapters.map((c) => c.label);
const keys = (chapters) => chapters.map((c) => c.key);
const texts = (chapters) => chapters.map((c) => c.todos.map((t) => t.text));
const counts = (chapters) => chapters.map((c) => c.todos.length);

console.log('\n== 1. localDayKey / localMonthKey：本地口径 + 非法输入 ==');
eq('本地日键', localDayKey(L(2026, 9, 16, 23, 30)), '2026-09-16');
eq('本地月键', localMonthKey(L(2026, 9, 16, 23, 30)), '2026-09');
eq('个位数月/日补零', localDayKey(L(2026, 1, 5, 9, 0)), '2026-01-05');
eq('接受 ISO 字符串', localDayKey(L(2026, 9, 16).toISOString()), '2026-09-16');
eq('接受 epoch 毫秒', localDayKey(L(2026, 9, 16).getTime()), '2026-09-16');
eq('null → null', localDayKey(null), null);
eq('非法字符串 → null（不抛错）', localDayKey('not-a-date'), null);
eq('空串 → null', localMonthKey(''), null);

// ---- 时区日界：这是头号陷阱，必须在一个"本地日 ≠ UTC 日"的时刻上断言 ----
// 若实现用 toISOString().slice(0,10)，它会在东半球（offset>0）的凌晨、西半球（offset<0）的深夜
// 与本地日相差一天。夹具按本机实际 offset 选时刻，保证在任何时区（除 UTC±0）都真的抓得到。
console.log('\n== 2. 时区日界：分组必须按本地时间，不能按 UTC 切天 ==');
{
  const offMin = -new Date().getTimezoneOffset(); // 本地相对 UTC 的分钟数（东为正）
  const earlyLocal = L(2026, 9, 16, 1, 0);   // 本地 01:00
  const lateLocal = L(2026, 9, 16, 23, 0);   // 本地 23:00
  const utcDateOf = (d) => d.toISOString().slice(0, 10);

  eq('本地 01:00 的日键 = 本地日（而不是可能的 UTC 前一天）', localDayKey(earlyLocal), '2026-09-16');
  eq('本地 23:00 的日键 = 本地日（而不是可能的 UTC 后一天）', localDayKey(lateLocal), '2026-09-16');

  if (offMin === 0) {
    console.log('  ⚠️ 本机时区为 UTC±0，本地日与 UTC 日恒等 —— 本组用例在本机不具区分力（CI 上同样如此）');
  } else {
    // 至少有一个夹具的 UTC 日 ≠ 本地日，从而"UTC 切天"的实现必然断言失败
    const distinguishable = [earlyLocal, lateLocal].some((d) => utcDateOf(d) !== '2026-09-16');
    check('夹具确实落在「本地日 ≠ UTC 日」的区域（否则本组抓不到时区错误）', distinguishable,
      `offset=${offMin}min, early=${utcDateOf(earlyLocal)}, late=${utcDateOf(lateLocal)}`);
  }

  // 端到端：本地 9/16 凌晨与深夜完成的两条，都必须在「今天」章里
  const chapters = groupByLocalPeriod(
    [todo('a', { completedAt: earlyLocal }), todo('b', { completedAt: lateLocal })],
    L(2026, 9, 16, 12, 0),
  );
  eq('凌晨/深夜完成的都归入「今天」（按 UTC 切天会各自跑偏）', labels(chapters), ['今天']);
  eq('「今天」章收齐 2 条', counts(chapters), [2]);
}

// ---- 上面那组断言只在**非 UTC** 主机上有区分力，而 CI runner 恰好是 UTC ----
// 于是把同样的夹具放进固定 TZ 的子进程再跑一遍：无论宿主机是什么时区，这组都有牙齿
// （2026-09-16 追加。理由同 AGENTS.md 铁律二：跑不红的测试等于没测）。
console.log('\n== 2b. 固定时区复验（子进程 TZ=…，宿主机是 UTC 也照样抓 UTC 切天）==');
{
  const here = dirname(fileURLToPath(import.meta.url));
  const timelineUrl = pathToFileURL(resolve(here, '../public/js/timeline.js')).href;
  const dir = mkdtempSync(join(tmpdir(), 'tl-tz-'));
  const childFile = join(dir, 'child.mjs');
  writeFileSync(childFile, `
import { groupByLocalPeriod } from ${JSON.stringify(timelineUrl)};
const L = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi || 0);
const mk = (id, when) => ({ id, text: id, completed: true, completedAt: when.toISOString(), createdAt: when.toISOString() });
const now = L(2026, 9, 16, 12, 0);
const ch = groupByLocalPeriod([
  mk('early', L(2026, 9, 16, 1, 0)),
  mk('late', L(2026, 9, 16, 23, 0)),
  mk('prev', L(2026, 9, 15, 23, 0)),
], now);
process.stdout.write(JSON.stringify(ch.map((c) => [c.label, c.todos.map((t) => t.id)])));
`);

  // 期望与宿主机时区无关：本地 9/16 的凌晨与深夜都在「今天」，本地 9/15 深夜在「昨天」
  const expected = JSON.stringify([['今天', ['late', 'early']], ['昨天', ['prev']]]);
  for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
    let out = '';
    let err = '';
    try {
      out = execFileSync(process.execPath, [childFile], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      });
    } catch (e) {
      err = e.message;
    }
    check(`TZ=${tz} 下分组一致（凌晨/深夜都是「今天」）`, out === expected,
      err || `期望 ${expected}，实际 ${out}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n== 3. 章节形态与文案 ==');
{
  const now = L(2026, 9, 16, 12, 0);
  const chapters = groupByLocalPeriod([
    todo('t1', { completedAt: L(2026, 9, 16, 9, 0) }),
    todo('y1', { completedAt: L(2026, 9, 15, 9, 0) }),
    todo('y2', { completedAt: L(2026, 9, 15, 20, 0) }),
    todo('e1', { completedAt: L(2026, 9, 14, 9, 0) }),
    todo('e2', { completedAt: L(2026, 9, 13, 9, 0) }),
    todo('m1', { completedAt: L(2026, 8, 20, 9, 0) }),
    todo('m2', { completedAt: L(2026, 8, 1, 9, 0) }),
    todo('o1', { completed: false, completedAt: null }),
  ], now);

  eq('章节标签（今天 / 昨天 / 更早·本月 / 更早整月）', labels(chapters),
    ['今天', '昨天', '更早 · 九月', '八月']);
  eq('章节 key 稳定可复用（day: / month: 前缀）', keys(chapters),
    ['day:2026-09-16', 'day:2026-09-15', 'month:2026-09:early', 'month:2026-08']);
  eq('小计只数件数', counts(chapters), [1, 2, 2, 2]);
  eq('「今天」用「已完成 N 件」，其余用「一起完成 N 件」',
    chapters.map((c) => c.subtitle),
    ['已完成 1 件', '一起完成 2 件', '一起完成 2 件', '一起完成 2 件']);
  eq('未完成的待办不进任何章', texts(chapters), [['T-t1'], ['T-y2', 'T-y1'], ['T-e1', 'T-e2'], ['T-m1', 'T-m2']]);
}

console.log('\n== 4. 组内排序按完成时间倒序（不是创建时间）==');
{
  const now = L(2026, 9, 16, 12, 0);
  // 同一章（八月）内：createdAt 与 completedAt 顺序相反，必须按 completedAt 排
  const chapters = groupByLocalPeriod([
    todo('old-created', { createdAt: L(2026, 8, 1), completedAt: L(2026, 8, 25) }),
    todo('new-created', { createdAt: L(2026, 8, 20), completedAt: L(2026, 8, 5) }),
  ], now);
  eq('章内按完成时间倒序（创建更早但完成更晚的排在前面）', texts(chapters), [['T-old-created', 'T-new-created']]);

  // 同刻完成：按 createdAt 倒序定序（与 db.js 服务端序一致），保证两端一致
  const sameMs = L(2026, 8, 8, 10, 0);
  const tie = groupByLocalPeriod([
    todo('c1', { createdAt: L(2026, 8, 1), completedAt: sameMs }),
    todo('c2', { createdAt: L(2026, 8, 7), completedAt: sameMs }),
  ], now);
  eq('同刻完成 → 按创建时间倒序（确定性，两端一致）', texts(tie), [['T-c2', 'T-c1']]);
}

console.log('\n== 5. 章节顺序：created_at 序会切出乱序章节（本方案要修的就是它）==');
{
  const now = L(2026, 9, 16, 12, 0);
  // 「创建 8/20、完成 8/25」在 created_at 序里排在「创建 8/1、完成 9/16」之前。
  // 若按 created_at 序遍历再切章，九月章会出现在八月章之后 —— 这里钉死正确顺序。
  const input = [
    todo('aug', { createdAt: L(2026, 8, 20), completedAt: L(2026, 8, 25) }),
    todo('sep', { createdAt: L(2026, 8, 1), completedAt: L(2026, 9, 16, 10, 0) }),
  ];
  const chapters = groupByLocalPeriod(input, now);
  eq('九月章在八月章之前（与 created_at 序相反）', labels(chapters), ['今天', '八月']);
  eq('九月那条落在「今天」', chapters[0].todos.map((t) => t.text), ['T-sep']);
  // 输入顺序反过来，结果必须一致（纯函数 / 顺序无关）
  eq('输入顺序不影响输出', labels(groupByLocalPeriod([...input].reverse(), now)), ['今天', '八月']);
  // 输入数组本身不被改动
  eq('不修改入参数组', labels(groupByLocalPeriod(input, now)), ['今天', '八月']);
}

console.log('\n== 6. 跨月边界（9/1 看 8/31）==');
{
  const now = L(2026, 9, 1, 10, 0);
  const chapters = groupByLocalPeriod([
    todo('last-night', { completedAt: L(2026, 8, 31, 23, 59) }),
    todo('mid-aug', { completedAt: L(2026, 8, 15, 10, 0) }),
  ], now);
  eq('8/31 23:59 归「昨天」，不是「八月」', labels(chapters), ['昨天', '八月']);
  eq('「昨天」章的最新时刻仍排在「八月」之前', counts(chapters), [1, 1]);

  // 同一天（9/1）完成的另一条应与它无关：没有「今天」章就不出现
  const onlyYesterday = groupByLocalPeriod([todo('y', { completedAt: L(2026, 8, 31, 23, 59) })], now);
  eq('没有今天完成项时不产出「今天」章', labels(onlyYesterday), ['昨天']);
}

console.log('\n== 7. 跨年边界（1/1 看 12/31）==');
{
  const now = L(2026, 1, 1, 10, 0);
  const chapters = groupByLocalPeriod([
    todo('ny', { completedAt: L(2026, 1, 1, 9, 0) }),
    todo('dec31', { completedAt: L(2025, 12, 31, 23, 30) }),
    todo('dec-mid', { completedAt: L(2025, 12, 15, 10, 0) }),
    todo('nov', { completedAt: L(2025, 11, 20, 10, 0) }),
    todo('jan-early', { completedAt: L(2026, 1, 1, 8, 0) }),
  ], now);
  eq('跨年：昨天（12/31）→ 2025·十二月 → 2025·十一月', labels(chapters),
    ['今天', '昨天', '2025 · 十二月', '2025 · 十一月']);
  eq('跨年月份补年份（否则两章都叫「十二月」分不清）', keys(chapters),
    ['day:2026-01-01', 'day:2025-12-31', 'month:2025-12', 'month:2025-11']);
  eq('1/1 完成的都归「今天」', texts(chapters)[0], ['T-ny', 'T-jan-early']);
}

console.log('\n== 8. 不变量：一条都不丢 ==');
{
  const now = L(2026, 9, 16, 12, 0);
  const input = [
    todo('a', { completedAt: L(2026, 9, 16, 1, 0) }),
    todo('b', { completedAt: L(2026, 9, 15, 1, 0) }),
    todo('c', { completedAt: L(2026, 9, 1, 1, 0) }),
    todo('d', { completedAt: L(2026, 7, 4, 1, 0) }),
    todo('e', { completedAt: L(2025, 7, 4, 1, 0) }),
    todo('f', { completed: false, completedAt: null }),
    todo('g', { completed: false, completedAt: L(2026, 9, 16, 1, 0) }),
  ];
  const chapters = groupByLocalPeriod(input, now);
  const grouped = chapters.reduce((n, c) => n + c.todos.length, 0);
  const open = input.filter((t) => !t.completed).length;
  eq('未完成 + 各章条数 === 总条数（没有任何一条凭空消失）', grouped + open, input.length);
  const ids = chapters.flatMap((c) => c.todos.map((t) => t.id)).sort();
  eq('每一条已完成都恰好出现一次', ids, ['a', 'b', 'c', 'd', 'e']);
  eq('同年 7 月与去年 7 月不同名（后者带年份）', labels(chapters),
    ['今天', '昨天', '更早 · 九月', '七月', '2025 · 七月']);
}

console.log('\n== 9. 兜底：completed 但没有 completed_at ==');
{
  // schema 的 completed_consistent CHECK 保证不该出现；但"多出一章"远比"某条待办从列表里
  // 凭空消失"轻 —— 所以钉住「兜底且排在最后、不丢数据」。
  const now = L(2026, 9, 16, 12, 0);
  const chapters = groupByLocalPeriod([
    todo('normal', { completedAt: L(2026, 9, 16, 9, 0) }),
    todo('broken', { completedAt: null }),
  ], now);
  eq('兜底章排在最后', labels(chapters), ['今天', '更早']);
  eq('兜底章的 key 固定', keys(chapters)[1], 'unknown');
  eq('兜底章不丢数据', chapters[1].todos.map((t) => t.text), ['T-broken']);
  eq('兜底章也有小计', chapters[1].subtitle, '一起完成 1 件');
}

console.log('\n== 10. 空输入 / 无已完成 ==');
eq('无已完成 → 空数组', groupByLocalPeriod([], L(2026, 9, 16)), []);
eq('全是未完成 → 空数组', groupByLocalPeriod([todo('a', { completed: false })], L(2026, 9, 16)), []);
eq('非数组入参 → 空数组（不抛错）', groupByLocalPeriod(null, L(2026, 9, 16)), []);
eq('数组里有 null 元素也不抛错', labels(groupByLocalPeriod([null, todo('a', { completedAt: L(2026, 9, 16) })], L(2026, 9, 16, 12, 0))), ['今天']);

console.log(`\n== 结果: ${pass} 通过 / ${fail} 失败 ==\n`);
process.exit(fail > 0 ? 1 : 0);
