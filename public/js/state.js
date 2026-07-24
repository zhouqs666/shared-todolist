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
