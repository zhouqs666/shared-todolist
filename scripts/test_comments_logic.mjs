#!/usr/bin/env node
/**
 * 待办留言板纯逻辑回归（**零凭据、零 DOM、零网络**，进 CI 的 Node 回归）
 *
 * 为什么要有这个文件：留言板的"未读"是**只有一条判断、却最容易写错**的地方 ——
 * 写错的形态不是报错，而是「明明有新留言却不亮红点」（功能静默失效，你不点开就永远不知道）
 * 或「自己刚说的话也标成未读」（每次打开都误报，用户很快不再相信红点）。
 * 这两种在浏览器里都看不出来，所以把判据钉在断言上。
 *
 * 覆盖：
 *   1. summarize / visibleComments：软删行不进条数、不进"最新一条"
 *   2. isUnread：自己的不算未读、软删的不算、水位之后才算、无水位记录时算未读
 *   3. firstUnreadIndex：下标是**可见列表**里的位置（软删行不能顶偏它，否则定位到别人身上）
 *   4. watermark：取可见行最大 created_at（用服务端时间戳，不用本地时钟）
 *   5. sortByCreatedAt：正序、不改原数组（Realtime 追加后回正用）
 *   6. replyPrefix：有父 → 「回复 @昵称：」，父缺失 → 无名前缀，昵称查不到 → ta
 *   7. parseSeenStore / withWatermark：坏 JSON 当空、水位只增不减、不改原对象
 *
 * 运行：node scripts/test_comments_logic.mjs
 * （readonly-guard 不适用：纯函数，不 import supabase/playwright）
 */

import {
  visibleComments,
  summarize,
  isUnread,
  unreadCount,
  firstUnreadIndex,
  watermark,
  sortByCreatedAt,
  replyPrefix,
  parseSeenStore,
  withWatermark,
} from '../public/js/comment-logic.js';

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

const ME = 'me-0000';
const TA = 'ta-0000';
const T = (n) => `2026-10-09T10:0${n}:00.000Z`;
/** 造一条留言（默认：对方写的、未删除） */
const row = (over = {}) => ({
  id: over.id || `c-${over.createdAt || T(0)}`,
  todoId: 'todo-1',
  authorId: TA,
  parentId: null,
  content: 'x',
  editedAt: null,
  deletedAt: null,
  createdAt: T(0),
  ...over,
});

console.log('\n=== 1. summarize / visibleComments（软删行不计） ===');
{
  const rows = [
    row({ id: 'a', authorId: ME, createdAt: T(0) }),
    row({ id: 'b', createdAt: T(1), deletedAt: T(2) }), // 软删
    row({ id: 'c', createdAt: T(3) }),
  ];
  eq('visibleComments 过滤软删行', visibleComments(rows).map((r) => r.id), ['a', 'c']);
  const s = summarize(rows);
  eq('条数只算未删除的', s.count, 2);
  eq('最新一条取未删除的最后一条', s.latest.id, 'c');
  eq('空数组：0 条 + latest 为 null', summarize([]), { count: 0, latest: null });
  eq('undefined 输入不炸', summarize(undefined), { count: 0, latest: null });
}

console.log('\n=== 2. isUnread（三条规则） ===');
{
  check('对方写 + 水位之前 → 已读', !isUnread(row({ createdAt: T(1) }), ME, T(5)));
  check('对方写 + 水位之后 → 未读', isUnread(row({ createdAt: T(6) }), ME, T(5)));
  check('水位相同（同一毫秒）→ 已读（>= 即已读，不会永远差一条）', !isUnread(row({ createdAt: T(5) }), ME, T(5)));
  check('自己写的永不算未读', !isUnread(row({ authorId: ME, createdAt: T(9) }), ME, T(1)));
  check('软删的不算未读', !isUnread(row({ createdAt: T(9), deletedAt: T(9) }), ME, T(1)));
  check('没有水位记录（从未看过该待办）→ 算未读', isUnread(row({ createdAt: T(1) }), ME, null));
  check('拿不到当前用户 id → 保守算已读（不误报红点）', !isUnread(row({ createdAt: T(9) }), null, null));
}

console.log('\n=== 3. unreadCount / firstUnreadIndex（下标对着可见列表） ===');
{
  const rows = [
    row({ id: 'a', createdAt: T(0) }),                                  // 已读（在水位前）
    row({ id: 'b', createdAt: T(2), deletedAt: T(3) }),                 // 软删（不能顶偏下标）
    row({ id: 'c', authorId: ME, createdAt: T(4) }),                    // 自己的（不算未读）
    row({ id: 'd', createdAt: T(5) }),                                  // 未读（水位后）
    row({ id: 'e', createdAt: T(6) }),                                  // 未读
  ];
  eq('未读条数', unreadCount(rows, ME, T(1)), 2);
  eq('第一条未读在可见列表中的下标', firstUnreadIndex(rows, ME, T(1)), 2); // 可见列表 = a, c, d, e
  eq('全部已读 → -1', firstUnreadIndex(rows, ME, T(9)), -1);
  eq('从未看过 → 指向第一条对方留言（自己的仍跳过）', firstUnreadIndex(rows, ME, null), 0);
}

console.log('\n=== 4. watermark（服务端时间戳，不是本地时钟） ===');
{
  eq('取可见行最大 created_at', watermark([row({ createdAt: T(1) }), row({ createdAt: T(7) })]), T(7));
  eq('软删行不参与水位', watermark([row({ createdAt: T(1) }), row({ createdAt: T(7), deletedAt: T(8) })]), T(1));
  eq('没有可见留言 → null', watermark([]), null);
  eq(
    '打乱顺序也取最大（不依赖输入顺序）',
    watermark([row({ createdAt: T(7) }), row({ createdAt: T(2) })]),
    T(7)
  );
  // 乐观临时行带本机时钟：若把水位抬到"未来"，对方随后的留言会被误判成已读（漏红点）
  eq(
    '忽略乐观临时行的本机时间戳',
    watermark([row({ createdAt: T(2) }), row({ createdAt: '2099-01-01T00:00:00.000Z', __temp: true })]),
    T(2)
  );
  eq(
    '只有临时行（第一条留言发送中）→ 无可信水位',
    watermark([row({ createdAt: '2099-01-01T00:00:00.000Z', __temp: true })]),
    null
  );
}

console.log('\n=== 5. sortByCreatedAt（正序、不改原数组） ===');
{
  const input = [row({ id: 'x', createdAt: T(5) }), row({ id: 'y', createdAt: T(1) })];
  const sorted = sortByCreatedAt(input);
  eq('正序', sorted.map((r) => r.id), ['y', 'x']);
  eq('原数组未被改动（Realtime 追加依赖它）', input.map((r) => r.id), ['x', 'y']);
  eq('空输入安全', sortByCreatedAt(null), []);
}

console.log('\n=== 6. replyPrefix（回复引用文案） ===');
{
  const parent = row({ authorId: TA });
  const nameOf = (uid) => (uid === TA ? '老婆' : '我');
  eq('有父留言 → 带昵称', replyPrefix(parent, nameOf), '回复 @老婆：');
  eq('父留言不在缓存里 → 无名前缀（不阻塞渲染）', replyPrefix(null, nameOf), '回复：');
  eq('昵称查不到 → 兜底 ta', replyPrefix(parent, () => ''), '回复 @ta：');
  eq('没传 nameOf → 兜底 ta', replyPrefix(parent), '回复 @ta：');
}

console.log('\n=== 7. parseSeenStore / withWatermark（本机存储的健壮性） ===');
{
  eq('正常解析', parseSeenStore('{"t1":"2026-10-09T10:00:00.000Z"}'), { t1: T(0) });
  eq('坏 JSON 当空（不能因一条坏记录让留言板整体失效）', parseSeenStore('{oops'), {});
  eq('数组当空', parseSeenStore('[1,2]'), {});
  eq('null / undefined / 空串当空', [parseSeenStore(null), parseSeenStore(undefined), parseSeenStore('')], [{}, {}, {}]);
  eq('非字符串值被剔除', parseSeenStore('{"t1":"ok","t2":123,"t3":null}'), { t1: 'ok' });

  const base = { t1: T(5) };
  const advanced = withWatermark(base, 't1', T(7));
  eq('水位推进', advanced.t1, T(7));
  eq('原对象未被改动', base.t1, T(5));
  eq('水位只增不减（旧值不回退，否则已读会重新变未读）', withWatermark({ t1: T(7) }, 't1', T(3)).t1, T(7));
  eq('新待办新增水位', withWatermark({}, 't2', T(1)), { t2: T(1) });
  eq('无水位值时不写入空键', withWatermark({}, 't3', null), {});
}

console.log('');
if (fail) {
  console.error(`✗ 留言板纯逻辑回归失败：${fail} 项未通过（通过 ${pass}）`);
  process.exit(1);
}
console.log(`✓ 留言板纯逻辑回归全绿（${pass} 项）`);
