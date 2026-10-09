/**
 * 待办留言板的纯逻辑（无 DOM / 无网络 / 无模块状态）
 *
 * 与 comments.js 的分工：本模块只做「一堆留言行 → 结论」的纯计算，
 * 因此能被 Node 直接 import 做单测（scripts/test_comments_logic.mjs，进 CI）。
 * DOM、缓存、Realtime、数据访问都在 comments.js。
 *
 * 数据约定（comments.js 缓存里每行的字段形状，来自 transforms.toTodoComment）：
 *   { id, todoId, authorId, parentId, content, editedAt, deletedAt, createdAt }
 *   · deletedAt 非空 = 软删除（不渲染、不计条数，但仍需保留：回复前缀要解析被删父留言的昵称）
 *   · createdAt 是**服务端**时间戳（ISO），所有"未读"判断都基于它，不用本地时钟
 */

/** 可见留言（未软删除）。输入须已按时间正序 —— 调用方（缓存）保证顺序 */
export function visibleComments(rows) {
  return (rows || []).filter((r) => r && !r.deletedAt);
}

/** 摘要：条数 + 最后一条（卡片徽标只显示这两个事实） */
export function summarize(rows) {
  const list = visibleComments(rows);
  return { count: list.length, latest: list.length ? list[list.length - 1] : null };
}

/**
 * 某条留言对「我」是否未读。
 * 三条规则：① 软删除的不算 ② 自己写的永不算未读 ③ 只算已读水位之后的
 * @param {Object} row
 * @param {string|null} myId
 * @param {string|null} seenAt 该待办的已读水位（上次查看时可见留言的最大 created_at；null=无记录）
 */
export function isUnread(row, myId, seenAt) {
  if (!row || row.deletedAt) return false;
  if (!myId || row.authorId === myId) return false;
  if (!seenAt) return true;
  // ISO 8601 同格式字符串可直接比较（都来自服务端，无时区/精度歧义）
  return String(row.createdAt) > String(seenAt);
}

/** 未读条数（卡片徽标：>0 显示主色 + 圆点） */
export function unreadCount(rows, myId, seenAt) {
  return visibleComments(rows).filter((r) => isUnread(r, myId, seenAt)).length;
}

/**
 * 第一条未读在**可见列表**中的下标；无未读 → -1。
 * 打开留言板时用它定位（有未读滚到第一条未读，无未读滚到最新）。
 */
export function firstUnreadIndex(rows, myId, seenAt) {
  return visibleComments(rows).findIndex((r) => isUnread(r, myId, seenAt));
}

/**
 * 已读水位 = 可见留言里最大的 created_at（null = 没有可见留言）。
 * 两条约束：
 *   · 用**服务端**时间戳而非本地时钟：两端时钟偏差不会造成"永远未读"或"永远已读"
 *   · 忽略乐观临时行（`__temp`，发送中的那条）—— 它带的是本机时钟，
 *     若它比服务器快几分钟，水位被抬到未来会把对方随后的留言全判成"已读"（漏红点）
 * 不依赖输入顺序（Realtime 追加 + 乐观插入都可能让缓存短暂非严格有序）。
 */
export function watermark(rows) {
  let max = null;
  visibleComments(rows).forEach((r) => {
    if (r.__temp) return;
    const t = String(r.createdAt || '');
    if (!t) return;
    if (!max || t > max) max = t;
  });
  return max;
}

/** 按时间正序排序（Realtime 追加、乐观临时行插入后回正用） */
export function sortByCreatedAt(rows) {
  return [...(rows || [])].sort((a, b) => {
    const x = String(a.createdAt || '');
    const y = String(b.createdAt || '');
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** 回复前缀文案。父留言不在缓存里时退化为无名前缀（不阻塞渲染） */
export function replyPrefix(parent, nameOf) {
  if (!parent) return '回复：';
  const name = (typeof nameOf === 'function' && nameOf(parent.authorId)) || 'ta';
  return `回复 @${name}：`;
}

/**
 * 已读水位存储的解析：损坏 / 非对象 / 值非字符串一律当空 —— 
 * localStorage 是外部输入，坏数据不能让留言板整体失效。
 */
export function parseSeenStore(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    Object.keys(parsed).forEach((k) => {
      if (typeof parsed[k] === 'string') out[k] = parsed[k];
    });
    return out;
  } catch (_) {
    return {};
  }
}

/** 推进某待办的水位（只增不减；返回新对象，不改原对象） */
export function withWatermark(store, todoId, at) {
  const next = { ...(store || {}) };
  if (!todoId || !at) return next;
  const prev = next[todoId];
  next[todoId] = prev && prev > at ? prev : at;
  return next;
}
