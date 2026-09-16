#!/usr/bin/env node
/**
 * No.X（App 累计迭代次数）口径回归 —— **纯逻辑，不连数据库、不开浏览器**
 *
 * 为什么要有这个文件（2026-09-16）：
 * `No.X` 原先是「两张版本表里 enabled=true 的行数」，而 `enabled` 是**可见性开关**
 * （下线止损 / 回滚 / 撤回误发布都靠它），不是「这一版发过没有」的历史事实。
 * 于是每下线一版这个数字就 −1：实测线上按 enabled = 129、全量 = 158，
 * 差的 29 正是被下线的行（26 个壳版本 + 3 个热更新）。
 * 而它要表达的是「这个 App 走到今天一共迭代了多少次」、给两人看同一个数、只增不减 ——
 * 口径写错不会报错，只会安静地少 29，没人能靠肉眼发现。所以把口径钉在断言上。
 *
 * 覆盖：
 *   1. 全量累计：两表行数相加（热更新 + 壳更新缺一不可）
 *   2. **不带 `enabled` 过滤**（回归：一旦有人加回 `.eq('enabled', true)`，这里就红）
 *   3. 查询形状：两条 count-exact-head 查询，各打一张表
 *   4. 拿不到就返回 null（报错 / 计数没回来 / 两表都空 / 客户端未注入 / 抛异常）
 *   5. **绝不兜底成 1**（回归：`No.1` 的由来就是兜底 —— 错数字比没有数字更糟）
 *
 * 运行：node scripts/test_update_count.mjs
 * （readonly-guard 不适用：本文件不 import playwright / supabase-js，用假客户端，无任何网络）
 */

import { getTotalUpdateCount } from '../public/js/update.js';

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

/**
 * 假 supabase 客户端：只实现链式查询里用到的那一小块，并**记录**被调用的方法。
 * `eqCalls` 用来断言「没有按 enabled 过滤」—— 这是本次修正的核心。
 * @param {object} opts
 * @param {number|null} opts.webCount    app_versions 返回的 count
 * @param {number|null} opts.shellCount  app_native_versions 返回的 count
 * @param {string|null} opts.webError    app_versions 返回的 error.message
 * @param {string|null} opts.shellError  app_native_versions 返回的 error.message
 * @param {boolean} opts.hang            永不 resolve（模拟请求悬挂）
 * @param {boolean} opts.throws          select() 直接抛异常
 */
function makeClient(opts = {}) {
  const {
    webCount = 131, shellCount = 27,
    webError = null, shellError = null,
    hang = false, throws = false,
  } = opts;
  const eqCalls = [];
  const selects = [];
  const client = {
    from(table) {
      return {
        select(columns, options) {
          if (throws) throw new Error('boom');
          selects.push({ table, columns, options });
          const payload = table === 'app_versions'
            ? { count: webCount, error: webError ? { message: webError } : null }
            : { count: shellCount, error: shellError ? { message: shellError } : null };
          const promise = hang ? new Promise(() => {}) : Promise.resolve(payload);
          return {
            // 修正前的写法是 `.select(...).eq('enabled', true)`；保留这条链只为**记录**它，
            // 断言里要求它一次都不被调用（口径回归的第一道防线）
            eq(column, value) { eqCalls.push({ table, column, value }); return promise; },
            then: (...args) => promise.then(...args),
            catch: (...args) => promise.catch(...args),
          };
        },
      };
    },
  };
  return { client, eqCalls, selects };
}

// ---------------------------------------------------------- 1. 全量累计
console.log('\n== 1. 累计 = 两表全部行数（热更新 + 壳更新统一累计）==');
{
  const { client } = makeClient({ webCount: 131, shellCount: 27 });
  eq('131 + 27 = 158（线上真实值：全量发布次数）', await getTotalUpdateCount(client), 158);
}
{
  // 只要有一张表被漏掉，数字就会少一整个通道 —— 用极端值把它暴露出来
  const { client } = makeClient({ webCount: 0, shellCount: 27 });
  eq('热更新 0 / 壳 27 → 27（壳更新没被漏掉）', await getTotalUpdateCount(client), 27);
}
{
  const { client } = makeClient({ webCount: 131, shellCount: 0 });
  eq('热更新 131 / 壳 0 → 131（热更新没被漏掉）', await getTotalUpdateCount(client), 131);
}

// ---------------------------------------------------------- 2. 不带 enabled 过滤
console.log('\n== 2. 不带 enabled 过滤（回归：加回过滤就红）==');
{
  const { client, eqCalls } = makeClient();
  await getTotalUpdateCount(client);
  eq('一次都没调过 .eq(...)（尤其没有 .eq("enabled", true)）', eqCalls, []);
}
{
  const { client, selects } = makeClient();
  await getTotalUpdateCount(client);
  eq('两张表都查了，且各查一次',
    selects.map((s) => s.table).sort(), ['app_native_versions', 'app_versions']);
  eq('查询形状 = 只要 count（head + count exact，不拉行）',
    selects.map((s) => s.options), [{ count: 'exact', head: true }, { count: 'exact', head: true }]);
}

// ---------------------------------------------------------- 3. 拿不到 = null
console.log('\n== 3. 拿不到计数 → null（调用方不显示印记）==');
{
  const { client } = makeClient({ webError: 'permission denied' });
  eq('热更新表报错 → null', await getTotalUpdateCount(client), null);
}
{
  const { client } = makeClient({ shellError: 'permission denied' });
  eq('壳版本表报错 → null', await getTotalUpdateCount(client), null);
}
{
  const { client } = makeClient({ webCount: null });
  eq('count 没回来（null）→ null', await getTotalUpdateCount(client), null);
}
{
  const { client } = makeClient({ webCount: 0, shellCount: 0 });
  eq('两表都空 → null（不显示 No.0）', await getTotalUpdateCount(client), null);
}
{
  const { client } = makeClient({ throws: true });
  eq('查询抛异常 → null（不把异常抛给动画）', await getTotalUpdateCount(client), null);
}
{
  eq('客户端未注入（null）→ null', await getTotalUpdateCount(null), null);
  eq('客户端未注入（undefined）→ null', await getTotalUpdateCount(undefined), null);
}

// ---------------------------------------------------------- 4. 绝不兜底成 1
console.log('\n== 4. 绝不兜底成 1（No.1 的由来）==');
{
  // 未登录时 anon 对这两张表可见 0 行 —— 旧实现 `(a||0)+(b||0) || 1` 会显示成 No.1
  const zero = makeClient({ webCount: 0, shellCount: 0 });
  const err = makeClient({ webError: 'JWT expired', shellError: 'JWT expired' });
  const nulls = makeClient({ webCount: null, shellCount: null });
  const results = [
    await getTotalUpdateCount(zero.client),
    await getTotalUpdateCount(err.client),
    await getTotalUpdateCount(nulls.client),
    await getTotalUpdateCount(null),
  ];
  check('四种失败路径都不返回 1', results.every((r) => r !== 1), `实际 ${JSON.stringify(results)}`);
  check('四种失败路径都返回 null', results.every((r) => r === null), `实际 ${JSON.stringify(results)}`);
}

// ---------------------------------------------------------- 5. 悬挂不能卡住调用方
console.log('\n== 5. 请求悬挂时不得卡住调用方（由调用方决定不 await）==');
{
  const { client } = makeClient({ hang: true });
  const settled = await Promise.race([
    getTotalUpdateCount(client).then(() => 'resolved'),
    new Promise((r) => setTimeout(() => r('pending'), 300)),
  ]);
  eq('计数未返回前，调用方可以继续（动画不被拖住）', settled, 'pending');
}

// ---------------------------------------------------------- 汇总
console.log(`\n${'='.repeat(48)}`);
if (fail === 0) {
  console.log(`✓ No.X 口径回归全部通过（${pass} 项）`);
  process.exit(0);
}
console.error(`✗ No.X 口径回归失败：${fail} 项失败 / 共 ${pass + fail} 项`);
process.exit(1);
