/**
 * 全局状态管理
 * - todos：当前待办列表（唯一真相）
 * - online：socket 连接状态
 * - render：渲染回调（setTodos 后触发）
 *
 * 抽出此模块是为了让 socket.js 与 app.js 共享同一份状态，
 * 避免 import 循环依赖。
 */

let todos = [];
let online = true;
let renderFn = null;
let onlineFn = null;
let completeFn = null;

// 图鉴（stickers）平行状态：两人共享一本，独立于 todos 的"唯一真相"
let stickers = [];
let stickersRenderFn = null;

export function getTodos() {
  return todos;
}

export function setTodos(next) {
  todos = next;
  if (renderFn) renderFn(todos);
}

export function isOnline() {
  return online;
}

export function setOnline(v) {
  online = v;
  if (onlineFn) onlineFn(online);
}

export function setRenderFn(fn) {
  renderFn = fn;
}

export function setOnlineFn(fn) {
  onlineFn = fn;
}

/**
 * 注册"远端完成"回调
 * 当 socket 收到 todo:updated 且从"未完成→已完成"时触发，用于播放完成动画
 * @param {(todo: Object)=>void} fn
 */
export function setCompleteFn(fn) {
  completeFn = fn;
}

/**
 * 通知"完成"事件（由 socket.js 调用）
 * @param {Object} todo 完成后的 todo 对象
 */
export function notifyCompleted(todo) {
  if (completeFn) completeFn(todo);
}

/** PRD §4.2 Q2 排序：未完成在上、新的在上、完成的下沉 */
export function sortTodos(list) {
  return [...list].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

// ===== 本端完成操作的飞行追踪（竞态保护）=====
// 解决"完成→取消完成→再点无法完成"的根因：Realtime 自我回声乱序到达，
// 会把陈旧的 DB 真实状态覆盖回本地乐观状态（例：第一次"完成"的回声延迟
// 到达，把刚"取消"的乐观状态又改回完成态，导致下一次点完成被幂等检查误判）。
//
// 这里追踪每个 id 的飞行中操作：Realtime 回声在"与本端最新意图相反"时被忽略。
// 用计数器而非单值：同一 id 可能有多个并发 toggleComplete（用户连点），
// 只有全部收尾后才解除保护。
const inFlight = new Map(); // id → { intent: boolean, count: number }

/** 发起一次完成切换：记录意图并增加飞行计数（供 Realtime 回声守卫） */
export function beginToggle(id, intent) {
  const cur = inFlight.get(id) || { intent, count: 0 };
  cur.intent = intent;
  cur.count += 1;
  inFlight.set(id, cur);
}

/** 一次完成切换收尾：减少计数，归零后清除保护 */
export function endToggle(id) {
  const cur = inFlight.get(id);
  if (!cur) return;
  cur.count -= 1;
  if (cur.count <= 0) inFlight.delete(id);
}

/** 该 id 当前飞行中的最新意图；无飞行操作返回 undefined（Realtime 不再守卫） */
export function getInFlightIntent(id) {
  const cur = inFlight.get(id);
  return cur ? cur.intent : undefined;
}

// ===== 图鉴状态（stickers，两人共享）=====

export function getStickers() {
  return stickers;
}

export function setStickers(next) {
  stickers = next;
  if (stickersRenderFn) stickersRenderFn(stickers);
}

/** 增量更新：新增或替换一张贴纸（Realtime 解锁回调用） */
export function addOrUpdateSticker(sticker) {
  if (!sticker) return;
  const idx = stickers.findIndex((s) => s.stickerKey === sticker.stickerKey);
  if (idx >= 0) {
    stickers[idx] = sticker;
  } else {
    stickers = [...stickers, sticker];
  }
  if (stickersRenderFn) stickersRenderFn(stickers);
}

export function setStickersRenderFn(fn) {
  stickersRenderFn = fn;
}
