/**
 * Socket.IO 客户端封装
 *
 * PRD §8.2:
 * - 连接建立后接收 todo:sync（全量替换）
 * - 接收 created/updated/deleted 并合并到 todos 数组
 * - 自动重连（Socket.IO 默认支持）
 * - 提供连接状态回调（用于 UI 显示「已离线」提示）
 */

import { io } from './vendor/socket.io.esm.min.js';
import { sortTodos } from './state.js';

let socket = null;
let stateApi = null;

/**
 * 初始化 Socket 连接
 * @param {Object} state - 状态对象（含 getTodos/setTodos）
 */
export function initSocket(state) {
  stateApi = state;

  socket = io({
    // 同源不需要 transports 显式指定，自动选择
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  // ===== 连接状态 =====
  socket.on('connect', () => {
    console.log('[socket] 已连接', socket.id);
    stateApi.setOnline(true);
  });

  socket.on('disconnect', (reason) => {
    console.warn('[socket] 断开:', reason);
    stateApi.setOnline(false);
  });

  socket.on('connect_error', (err) => {
    console.warn('[socket] 连接错误:', err.message);
    stateApi.setOnline(false);
  });

  // ===== 业务事件 =====

  // 全量同步（连接成功后服务端下发）
  socket.on('todo:sync', (synced) => {
    console.log('[socket] 收到 sync，共', synced.length, '条');
    stateApi.setTodos(sortTodos(synced));
  });

  // 新增（幂等：socket 广播可能快于 HTTP 响应，避免重复添加）
  socket.on('todo:created', (todo) => {
    const todos = stateApi.getTodos();
    if (todos.some((t) => t.id === todo.id)) return;
    stateApi.setTodos(sortTodos([...todos, todo]));
  });

  // 更新（完成/取消）
  socket.on('todo:updated', (todo) => {
    const todos = stateApi.getTodos();
    // 检测"未完成 → 已完成"变化，触发庆祝动画
    const prev = todos.find((t) => t.id === todo.id);
    const becameCompleted = todo.completed && prev && !prev.completed;

    const next = todos.map((t) => (t.id === todo.id ? todo : t));
    stateApi.setTodos(sortTodos(next));

    // 通知 app.js 播放完成动画（仅当从未完成变为已完成）
    if (becameCompleted && stateApi.notifyCompleted) {
      stateApi.notifyCompleted(todo);
    }
  });

  // 删除
  socket.on('todo:deleted', ({ id }) => {
    const todos = stateApi.getTodos();
    stateApi.setTodos(todos.filter((t) => t.id !== id));
  });

  return socket;
}

export function getSocket() {
  return socket;
}
