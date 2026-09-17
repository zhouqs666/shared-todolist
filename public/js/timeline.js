/**
 * 时光章节：把已完成待办按**设备本地时间**分章（纯计算模块：无 DOM、无网络、无副作用）
 *
 * 为什么单独成模块：分组规则里有两处极易写错、且写错了在真机上很难一眼看出的判断
 * （时区日界、章节顺序），抽成纯函数才能用合成夹具钉住 —— scripts/test_timeline_grouping.mjs
 * 不联网、进 CI。渲染（章节头进 DOM、复用人节点）留在 app.js。
 *
 * 本模块导出两个层次：
 *   · groupByLocalPeriod —— **只**负责时光章怎么切（一个区）
 *   · buildTodoLayout   —— **整页**自上而下的章序（置顶 / 要做的 / 时光章）
 *     app.js 的 render() 只按它的产出摆放节点，不再自己决定顺序与文案。
 *
 * ⚠️ 时区（头号陷阱）：completed_at 是 timestamptz，存的是 UTC 瞬时。
 *    分组必须按**设备本地时间**取年月日 —— getFullYear()/getMonth()/getDate()，
 *    **禁止 toISOString().slice(0, 10)**：那按 UTC 切天，北京时间晚上 8 点之后
 *    完成的事会被算成"昨天"（UTC+8 跨过 16:00 就是次日 UTC 零点）。
 *
 * ⚠️ 排序（第二个陷阱）：分章按完成时间 ⇒ 组内也必须按完成时间。
 *    若按 created_at 序遍历再切章，会切出乱序章节：completed_at ≥ created_at，但两者序不单调 ——
 *    「创建 8/20、完成 8/25」那条在 created_at 序里排在「创建 8/1、完成 9/16」之前，
 *    于是先被切进"八月"章，而更晚的"九月"章反而出现在它后面。
 *
 * 章节形态（已定形态，见 docs/design-todo-v2/PLAN-time-chapters-paper2.md）：
 *   今天 · 已完成 N 件 ／ 昨天 · 一起完成 N 件 ／ 更早 · 九月 · 一起完成 N 件 ／ 八月 · 一起完成 N 件
 * 「更早 · <本月>」把本月今天/昨天之前的散天收成一章；更早的月份各自成章。
 *
 * 已知边界（如实列出，当前不做处理）：
 *   completed_at 是**客户端**写进去的（db.js setCompleted 用 new Date().toISOString()），
 *   所以两台设备时钟不一致时，对方那条的完成时间可能落在未来。后果只是**归属/位置偏差**
 *   （轻微未来 → 落「更早 · 本月」；跨月未来 → 自成一章并排在最前），不会丢数据、
 *   也不会改变任何一条待办的计数。处理它需要先决定"以谁的时钟为准"，属产品决策，
 *   故此处不擅自兜底，只保证「一条都不丢」（由 scripts/test_timeline_grouping.mjs 的不变量用例守住）。
 */

/** 月名用中文数字（与设计稿一致：「八月」而不是「8 月」） */
const MONTH_CN = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月',
];

const KIND_TODAY = 'today';
const KIND_YESTERDAY = 'yesterday';
const KIND_EARLY = 'early'; // 本月内、今天/昨天之前
const KIND_MONTH = 'month'; // 更早的整月
const KIND_UNKNOWN = 'unknown';

const pad2 = (n) => String(n).padStart(2, '0');

/** 容错转 Date：null / undefined / 非法值一律返回 null（不抛错，调用方决定兜底） */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 本地日键 `YYYY-MM-DD`（本地时区，不是 UTC） */
export function localDayKey(value) {
  const d = toDate(value);
  if (!d) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地月键 `YYYY-MM`（本地时区） */
export function localMonthKey(value) {
  const d = toDate(value);
  if (!d) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 组内排序：完成时间倒序；同刻用创建时间倒序（与 db.js 的服务端序一致），再同则按 id 定序保确定性 */
function cmpCompletedDesc(a, b) {
  const ta = toDate(a.completedAt);
  const tb = toDate(b.completedAt);
  const va = ta ? ta.getTime() : -Infinity;
  const vb = tb ? tb.getTime() : -Infinity;
  if (va !== vb) return vb - va;
  const ca = String(a.createdAt || '');
  const cb = String(b.createdAt || '');
  if (ca !== cb) return cb.localeCompare(ca);
  return String(a.id).localeCompare(String(b.id));
}

/**
 * 把已完成待办切成时光章节。
 *
 * @param {Array<Object>} todos 待办列表（全量，含未完成；未完成的会被跳过）
 * @param {Date|string|number} [now] 「今天」的基准时刻（默认当前时间；测试注入用）
 * @returns {Array<{key:string,label:string,subtitle:string,todos:Array<Object>}>}
 *          按时间倒序的章节；每章内 todos 也按完成时间倒序。
 *          没有已完成项时返回 `[]`。
 */
export function groupByLocalPeriod(todos, now) {
  const list = Array.isArray(todos) ? todos : [];
  const today = toDate(now) || new Date();
  const todayKey = localDayKey(today);
  // 用构造函数做「前一天」：它会把 日=0 规范化成上月最后一天、跨年也正确，
  // 且按本地日历取年月日（setDate 版本在夏令时切换日会差一小时，虽然日键仍对，但没必要冒这个险）
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const yesterdayKey = localDayKey(yesterday);
  const nowMonthKey = localMonthKey(today);
  const nowYear = today.getFullYear();

  const buckets = new Map();

  for (const todo of list) {
    if (!todo || !todo.completed) continue;
    const when = toDate(todo.completedAt);
    const dayKey = when ? localDayKey(when) : null;
    const monthKey = when ? localMonthKey(when) : null;

    let key;
    let kind;
    if (!when) {
      // 数据完整性兜底：completed=true 却没有 completed_at。
      // schema 的 completed_consistent CHECK 保证它不该出现 —— 但「多出一章」远比
      // 「某条待办从列表里凭空消失」轻，所以兜到底部单独一章，不丢数据。
      key = 'unknown';
      kind = KIND_UNKNOWN;
    } else if (dayKey === todayKey) {
      key = `day:${dayKey}`;
      kind = KIND_TODAY;
    } else if (dayKey === yesterdayKey) {
      key = `day:${dayKey}`;
      kind = KIND_YESTERDAY;
    } else if (monthKey === nowMonthKey) {
      key = `month:${monthKey}:early`;
      kind = KIND_EARLY;
    } else {
      key = `month:${monthKey}`;
      kind = KIND_MONTH;
    }

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, kind, when, todos: [] };
      buckets.set(key, bucket);
    }
    bucket.todos.push(todo);
    // 兜底章（无 completed_at）保留 when=null → 排在最后
    if (when && (!bucket.when || when.getTime() > bucket.when.getTime())) bucket.when = when;
  }

  const chapters = [...buckets.values()];

  for (const c of chapters) {
    c.todos.sort(cmpCompletedDesc);

    if (c.kind === KIND_TODAY) {
      c.label = '今天';
    } else if (c.kind === KIND_YESTERDAY) {
      c.label = '昨天';
    } else if (c.kind === KIND_EARLY) {
      c.label = `更早 · ${MONTH_CN[c.when.getMonth()]}`;
    } else if (c.kind === KIND_MONTH) {
      // 跨年时补上年份：否则 2025-08 与 2026-08 会是两章同名「八月」
      c.label = c.when.getFullYear() === nowYear
        ? MONTH_CN[c.when.getMonth()]
        : `${c.when.getFullYear()} · ${MONTH_CN[c.when.getMonth()]}`;
    } else {
      c.label = '更早';
    }
    // 小计只数件数（贴纸小计已决定不做 —— 按月归属口径有歧义）
    c.subtitle = (c.kind === KIND_TODAY ? '已完成 ' : '一起完成 ') + `${c.todos.length} 件`;
  }

  // 章节按「章内最新一条」倒序 —— 这个排序天然处理了 9/1 看「昨天=8/31」这类跨月边界：
  // 昨天章的最新时刻必然晚于「八月」章里更早的那些条目，于是顺序仍是时间倒序。
  chapters.sort((a, b) => {
    const va = a.when ? a.when.getTime() : -Infinity;
    const vb = b.when ? b.when.getTime() : -Infinity;
    if (va !== vb) return vb - va;
    return a.key.localeCompare(b.key);
  });

  return chapters.map((c) => ({
    key: c.key,
    label: c.label,
    subtitle: c.subtitle,
    todos: c.todos,
  }));
}

/** 页首置顶章的 key（与时光章的 day:/month: 前缀不撞，也与下面的 __open__ 不撞） */
export const PINNED_CHAPTER_KEY = '__pinned__';
/** 未完成区小标题的 key */
export const OPEN_CHAPTER_KEY = '__open__';

/** 差额提示：某章有 N 条被置顶章收走时挂在章头。全角括号把它明确标成"附注"，不与小计混读 */
const pinnedNote = (n) => (n > 0 ? `（${n} 件在置顶）` : '');

/**
 * 整页布局：**置顶 → 要做的 → 时光章节**，自上而下。
 *
 * 为什么要单独一层（而不是在 render 里拼三遍 filter）：这次改动的头号风险是
 * 「某条待办从页面上凭空消失」—— 它不报错、不告警，用户会以为数据丢了。
 * 把"谁摆在哪个章、每个章头写什么"收进一个纯函数，才能用不变量钉住它
 * （scripts/test_timeline_grouping.mjs 第 11 组：每条恰好出现一次）。
 *
 * 三条口径（都是决策，不是实现细节）：
 *   ① **置顶是一层，不是排序优先级**。置顶项搬到页首独立成章，且**只在这里出现一次**
 *      （一个 id 一个 DOM 节点：app.js 的复用池按 data-id 索引，同一节点不可能同时摆在两处）。
 *      为什么要独立成章：分章会给每个章内重排（cmpCompletedDesc），置顶作为"排序优先级"
 *      在分章这一步会被整条丢掉 —— 实测一条置顶的已完成项仍排在它所属章的中间。
 *   ② **小计记"账"，不记"可见卡片"**。时光章的小计是"那天一起完成了几件"，不该因为
 *      某条被拿到页首就少记一笔 ⇒ 分组与计数永远按**全量**算，只把置顶项从**卡片列表**里摘掉，
 *      差额用「（N 件在置顶）」写在章头，读者能当场对上账（N 张卡 + N 件在置顶 = 章头总数）。
 *   ③ **空章头不渲染**。某章名下条目全被置顶时，只剩一个标签没有卡片 —— 看起来像 bug，
 *      那天的时间信息由置顶章卡片的 meta（"谁完成 · 完成于何时"）承担。
 *
 * 置顶章内**保持传入顺序**（不在此处重排）：app.js 传入的是 sortTodos 的结果
 * （未完成在前 → 创建时间倒序），排序语义留在 state.js 一处。
 *
 * @param {Array<Object>} todos 全量待办（含未完成）
 * @param {Date|string|number} [now] 「今天」的基准时刻（测试注入用）
 * @returns {Array<{key:string,label:string,subtitle:string,modifier?:string,todos:Array<Object>}>}
 */
export function buildTodoLayout(todos, now) {
  const list = Array.isArray(todos) ? todos : [];
  const chapters = [];

  // ① 置顶章（页首）
  const pinned = list.filter((t) => t && t.pinned);
  if (pinned.length > 0) {
    chapters.push({
      key: PINNED_CHAPTER_KEY,
      label: '置顶',
      subtitle: `· ${pinned.length}`,
      modifier: 'tl-chap--pinned',
      todos: pinned,
    });
  }

  // ② 未完成区：小标题「要做的 · N」。没有它，下面「今天」章节头会紧跟在未完成卡片后面，
  //    读起来像"这些是今天的待办"。
  const openAll = list.filter((t) => t && !t.completed);
  const openVisible = openAll.filter((t) => !t.pinned);
  if (openVisible.length > 0) {
    chapters.push({
      key: OPEN_CHAPTER_KEY,
      label: '要做的',
      subtitle: `· ${openAll.length}${pinnedNote(openAll.length - openVisible.length)}`,
      modifier: 'tl-chap--open',
      todos: openVisible,
    });
  }

  // ③ 已完成区：按完成时间分章（分组规则在 groupByLocalPeriod —— 纯函数、有单测）
  for (const chap of groupByLocalPeriod(list, now)) {
    const visible = chap.todos.filter((t) => !t.pinned);
    if (visible.length === 0) continue; // 口径③：空章头不渲染
    chapters.push({
      key: chap.key,
      label: chap.label,
      subtitle: chap.subtitle + pinnedNote(chap.todos.length - visible.length),
      todos: visible,
    });
  }

  return chapters;
}
