#!/usr/bin/env node
/**
 * DORA 口径 + 发布元数据的回归测试（**纯逻辑，不连数据库、不开浏览器**）
 *
 * 为什么要有这个文件：DORA 的四个指标全是**口径**问题 —— 「哪些样本算、哪些跳过、
 * 分母是谁」写错了不会报错，只会安静地输出一个看着合理的数字。
 * 那种错误没人能靠肉眼发现（半年后回看，你会以为当时的失败率真的是 0%）。
 * 所以把口径钉在断言上：合成夹具 → 期望值 → 对齐。
 *
 * 覆盖：
 *   1. 部署频率：窗口边界（正好在 from/to 上）、分通道计数
 *   2. 前置时间：脏工作区被跳过、无 commit 被跳过、负值被跳过、中位数/平均数/p90
 *   3. 变更失败率：只有 `disabled_is_incident === true` 才计入；未归类单独列出；
 *      迁移前的老行（enabled=false 但无 disabled_at）不算失败
 *   4. 恢复时间：取同通道的下一个版本；跨通道不算；无后续版本 = 未恢复（不编数字）
 *   5. `humanizeMinutes` 的分档
 *   6. `upsertWithOptionalColumns` 的**退化写入**：新增列不存在时自动去掉重写；
 *      其它报错必须照旧上抛（不能把"真失败"吞成"发布成功"）
 *
 * 运行：node scripts/test_dora_metrics.mjs
 * （readonly-guard 不适用：本文件不 import playwright / supabase-js，纯函数无网络）
 */

import { computeDora, humanizeMinutes, normalizeRow, formatDoraReport } from './_lib-dora.mjs';
import { upsertWithOptionalColumns } from './_lib-release-meta.mjs';

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

const NOW = new Date('2026-09-16T12:00:00Z');
const daysAgo = (d, h = 0) => new Date(NOW.getTime() - (d * 24 + h) * 3600 * 1000).toISOString();

// ---------------------------------------------------------------- 1. 部署频率
console.log('\n== 1. 部署频率（窗口边界 + 分通道）==');
{
  const web = [
    { version: '1.0.0', released_at: daysAgo(5), enabled: false },         // 窗口内
    { version: '1.0.1', released_at: daysAgo(30), enabled: true },         // 正好 = from，算窗口内
    { version: '1.0.2', released_at: daysAgo(31), enabled: true },         // 窗口外
  ];
  const native = [{ version_name: '9.9.9', released_at: daysAgo(1), enabled: true }];
  const m = computeDora({ web, native, now: NOW, days: 30 });
  eq('窗口内部署数 = 3（含正好落在 from 上的那条，不含更早的）', m.deployFrequency.total, 3);
  eq('分通道：web 2 / native 1', m.deployFrequency.byChannel, { web: 2, native: 1 });
  eq('窗口 30 天 → 0.10 次/天', Number(m.deployFrequency.perDay.toFixed(4)), 0.1);
  eq('窗口 30 天 → 0.7 次/周', Number(m.deployFrequency.perWeek.toFixed(4)), 0.7);
}

// ---------------------------------------------------------------- 2. 前置时间
console.log('\n== 2. 前置时间（提交 → 上线）==');
{
  const web = [
    // 正常：提交后 60 分钟上线
    { version: '2.0.0', released_at: daysAgo(2), enabled: true,
      commit_sha: 'a'.repeat(40), commit_at: daysAgo(2, 1), commit_dirty: false },
    // 正常：提交后 120 分钟上线
    { version: '2.0.1', released_at: daysAgo(1), enabled: true,
      commit_sha: 'b'.repeat(40), commit_at: daysAgo(1, 2), commit_dirty: false },
    // 脏工作区 → 跳过
    { version: '2.0.2', released_at: daysAgo(1), enabled: true,
      commit_sha: 'c'.repeat(40), commit_at: daysAgo(1, 5), commit_dirty: true },
    // 无 commit（迁移前的老行）→ 跳过
    { version: '2.0.3', released_at: daysAgo(1), enabled: true,
      commit_sha: null, commit_at: null, commit_dirty: null },
    // 负前置时间（时钟错乱 / 用了未来的 ref）→ 跳过
    { version: '2.0.4', released_at: daysAgo(1), enabled: true,
      commit_sha: 'd'.repeat(40), commit_at: daysAgo(0, -3), commit_dirty: false },
  ];
  const m = computeDora({ web, native: [], now: NOW, days: 30 });
  eq('可算样本 = 2', m.leadTime.samples, 2);
  eq('中位数 = 90 分钟', m.leadTime.medianMin, 90);
  eq('平均数 = 90 分钟', m.leadTime.meanMin, 90);
  eq('跳过的"脏工作区" = 1', m.leadTime.skippedDirty, 1);
  eq('跳过的"无 commit / 负值" = 2', m.leadTime.skippedNoCommit, 2);
}

// ------------------------------------------------- 3. 变更失败率（口径的关键）
console.log('\n== 3. 变更失败率 ==');
{
  const web = [
    // 事故下线（计入）
    { version: '3.0.0', released_at: daysAgo(10), enabled: false, disabled_at: daysAgo(9),
      disabled_reason: '列表空白', disabled_is_incident: true },
    // 演练/例行下线（**不计入**）
    { version: '3.0.1', released_at: daysAgo(8), enabled: false, disabled_at: daysAgo(8),
      disabled_reason: '回滚演练', disabled_is_incident: false },
    // 未归类（不计入，但要在报告里单独列出）
    { version: '3.0.2', released_at: daysAgo(6), enabled: false, disabled_at: daysAgo(6),
      disabled_reason: null, disabled_is_incident: null },
    // 迁移前的老行：enabled=false 但没有下线记录（不算失败，因为无法归因）
    { version: '3.0.3', released_at: daysAgo(4), enabled: false, disabled_at: null,
      disabled_reason: null, disabled_is_incident: null },
    // 在线的正常版本
    { version: '3.0.4', released_at: daysAgo(1), enabled: true, disabled_at: null,
      disabled_reason: null, disabled_is_incident: null },
  ];
  const m = computeDora({ web, native: [], now: NOW, days: 30 });
  eq('分母 = 窗口内全部部署（5 条）', m.changeFailure.deploys, 5);
  eq('分子 = 只有事故那一条', m.changeFailure.failed, 1);
  eq('失败率 = 1/5 = 20%', Number((m.changeFailure.rate * 100).toFixed(1)), 20);
  eq('未归类单独列出（1 条）', m.changeFailure.unclassified.map((x) => x.version), ['3.0.2']);
  eq('迁移前老行单独列出（1 条）', m.changeFailure.legacyDisabled.map((x) => x.version), ['3.0.3']);
  const report = formatDoraReport(m);
  check('报告里点明"1 次下线未归类"', report.includes('未归类'), report.slice(0, 200));
  check('报告里点出老版本无法归因', report.includes('迁移前的行') || report.includes('无法归因'));
}

// ---------------------------------------------------------------- 4. 恢复时间
console.log('\n== 4. 恢复时间 ==');
{
  const web = [
    { version: '4.0.0', released_at: daysAgo(20), enabled: false, disabled_at: daysAgo(19),
      disabled_reason: '崩了', disabled_is_incident: true },
    { version: '4.0.1', released_at: daysAgo(18), enabled: true },   // 修复版：发布 → 上线 = 2 天
    { version: '4.1.0', released_at: daysAgo(10), enabled: false, disabled_at: daysAgo(10),
      disabled_reason: '又一个事故', disabled_is_incident: true },
    { version: '4.1.1', released_at: daysAgo(9, 12), enabled: true }, // 12 小时
    // 同一个通道里更早的版本（恢复时间只取"之后"的，不能取到之前的）
    { version: '3.9.9', released_at: daysAgo(25), enabled: false },
  ];
  const native = [
    // 跨通道不算恢复：native 的后续版本不应该给 web 的事故当"恢复"
    { version_name: '9.0.0', released_at: daysAgo(19.5), enabled: true, disabled_at: null },
    // 通道 B 自己的事故，且**没有**后续版本 → 未恢复
    { version_name: '9.0.1', released_at: daysAgo(2), enabled: false, disabled_at: daysAgo(2),
      disabled_reason: '壳崩', disabled_is_incident: true },
  ];
  const m = computeDora({ web, native, now: NOW, days: 30 });
  eq('已恢复样本 = 2', m.recovery.samples, 2);
  // 2 天 = 2880 分；12 小时 = 720 分 → 中位数 = (720+2880)/2 = 1800
  eq('恢复时间中位数 = 30 小时（(720+2880)/2）', m.recovery.medianMin, 1800);
  eq('未恢复的列出通道 B 的 9.0.1', m.recovery.unrecovered, [{ channel: 'native', version: '9.0.1' }]);
  eq('跨通道不参与恢复（web 事故的恢复版是 4.0.1/4.1.1）',
    m.recovery.list.map((x) => x.recoveredBy).sort(), ['4.0.1', '4.1.1']);
  const report = formatDoraReport(m);
  check('报告提到"尚无后续版本"', report.includes('尚无后续版本'));
}

// ---------------------------------------------------------------- 5. 空数据
console.log('\n== 5. 空窗口（指标必须显示"—"而不是 0）==');
{
  const m = computeDora({ web: [], native: [], now: NOW, days: 30 });
  eq('部署数 0', m.deployFrequency.total, 0);
  eq('前置时间中位数 = null', m.leadTime.medianMin, null);
  eq('失败率 = null（不是 0！）', m.changeFailure.rate, null);
  eq('恢复时间中位数 = null', m.recovery.medianMin, null);
  const report = formatDoraReport(m);
  check('报告里没有把空数据渲染成 0.0%', !report.includes('0.0%'), report);
  check('报告提示窗口内没有部署', report.includes('没有部署'));
}

// ------------------------------------------------------- 6. humanizeMinutes
console.log('\n== 6. humanizeMinutes ==');
dr: {
  eq('null → —', humanizeMinutes(null), '—');
  eq('0.5 分 → 30 秒', humanizeMinutes(0.5), '30 秒');
  eq('90 分 → 1 小时 30 分', humanizeMinutes(90), '1 小时 30 分');
  eq('2880 分 → 2.0 天', humanizeMinutes(2880), '2.0 天');
}

// ------------------------------------- 7. normalizeRow（两条通道列名归一）
console.log('\n== 7. normalizeRow ==');
{
  const w = normalizeRow({ version: '1.2.3', released_at: daysAgo(1), enabled: true }, 'web');
  eq('web 取 version 列', w.version, '1.2.3');
  const n = normalizeRow({ version_name: '9.8.7', released_at: daysAgo(1), enabled: true }, 'native');
  eq('native 取 version_name 列', n.version, '9.8.7');
  check('缺失的 commit_dirty 归一为 null（不是 false）',
    w.commitDirty === null, `实际 ${w.commitDirty}`);
}

// --------------------------- 8. upsertWithOptionalColumns 的退化（含反向用例）
console.log('\n== 8. 写版本表：新列缺失时退化，其它错误不上吞 ==');
{
  // 假 client：第一次带新列 → 报"列不存在"；退化成去掉新列 → 成功
  const calls = [];
  const fakeMissingCol = {
    from: () => ({
      upsert: (payload) => {
        calls.push(Object.keys(payload).sort());
        return { error: 'commit_sha' in payload
          ? { code: 'PGRST204', message: "Could not find the 'commit_sha' column of 'app_versions' in the schema cache" }
          : null };
      },
    }),
  };
  const r1 = await upsertWithOptionalColumns(
    fakeMissingCol, 'app_versions', { version: '1.0.0', commit_sha: 'x', commit_at: 'y', commit_dirty: false },
    ['commit_sha', 'commit_at', 'commit_dirty'], 'version');
  check('退化：返回 degraded（带原因）而不是抛错', !!r1.degraded && r1.error === null, JSON.stringify(r1));
  eq('退化后确实重写了一次（第二次不带新列）', calls.length, 2);
  check('第二次的 payload 里没有新列', !calls[1].includes('commit_sha'), JSON.stringify(calls[1]));

  // 反向：真失败（比如 RLS 拒绝）不能被吞成"发布成功"
  const fakeRealError = {
    from: () => ({ upsert: () => ({ error: { message: 'new row violates row-level security policy' } }) }),
  };
  const r2 = await upsertWithOptionalColumns(
    fakeRealError, 'app_versions', { version: '1.0.0', commit_sha: 'x', commit_at: 'y', commit_dirty: false },
    ['commit_sha', 'commit_at', 'commit_dirty'], 'version');
  check('真失败照旧上抛（error 非空、不退化）', !!r2.error && r2.degraded === null, JSON.stringify(r2));

  // 正向：一次成功
  const fakeOk = { from: () => ({ upsert: () => ({ error: null }) }) };
  const r3 = await upsertWithOptionalColumns(
    fakeOk, 'app_versions', { version: '1.0.0', commit_sha: 'x' }, ['commit_sha'], 'version');
  check('正常路径无退化、无错误', r3.error === null && r3.degraded === null, JSON.stringify(r3));

  // 部分缺失（迁移只跑了一半）：仍应退化成功，且只去掉真缺的那一列
  const partial = [];
  const fakePartial = {
    from: () => ({
      upsert: (payload) => {
        partial.push(Object.keys(payload).sort());
        return { error: 'commit_sha' in payload
          ? { code: 'PGRST204', message: "Could not find the 'commit_sha' column of 'app_versions' in the schema cache" }
          : null };
      },
    }),
  };
  const r4 = await upsertWithOptionalColumns(
    fakePartial, 'app_versions',
    { version: '1.0.0', commit_sha: 'x', commit_at: 'y', commit_dirty: false },
    ['commit_sha', 'commit_at', 'commit_dirty'], 'version');
  check('部分缺失也能退化（不要求"全部缺失"）', !!r4.degraded && r4.error === null, JSON.stringify(r4));
  check('只去掉被报缺失的那一列，其余保留',
    !partial[1].includes('commit_sha') && partial[1].includes('commit_at') && partial[1].includes('commit_dirty'),
    JSON.stringify(partial[1]));

  // 退化重试**仍然失败**时：必须报错，不能把真失败伪装成发布成功
  let n = 0;
  const fakeAlwaysFail = {
    from: () => ({
      upsert: () => {
        n++;
        return { error: n === 1
          ? { code: 'PGRST204', message: "Could not find the 'commit_sha' column of 'app_versions' in the schema cache" }
          : { message: 'permission denied for table app_versions' } };
      },
    }),
  };
  const r5 = await upsertWithOptionalColumns(
    fakeAlwaysFail, 'app_versions', { version: '1.0.0', commit_sha: 'x' }, ['commit_sha'], 'version');
  check('退化后仍失败 ⇒ 上抛重试的报错（不吞成成功）',
    !!r5.error && r5.degraded === null && r5.error.includes('permission denied'), JSON.stringify(r5));
}

console.log(`\n== 结果: ${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail > 0 ? 1 : 0);
