/**
 * Supabase Realtime 订阅（替代 Socket.IO）
 *
 * 监听 todos 表的 INSERT / UPDATE / DELETE，转发给 state 层。
 * 同时维护"在线状态"（订阅成功 = 在线）。
 *
 * 重要时序：
 *   订阅状态变 SUBSCRIBED 后，仍需 ~2-3 秒才真正开始推送。
 *   所以 app.js 启动时先拉一次 listTodos() 兜底，弥补订阅期间的事件。
 *
 * 自我回声处理：
 *   Supabase Realtime 会把本端的 INSERT/UPDATE/DELETE 也推回来，
 *   这里用 id 幂等去重 + state 比较避免重复/抖动。
 */

import { supabase } from './supabase.js';
import { sortTodos } from './state.js';

// 复用 db.js 同款的字段转换（避免循环依赖，内联）
function toExternal(row) {
  if (!row) return null;
  return {
    id: row.id,
    text: row.text,
    completed: !!row.completed,
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedBy: row.completed_by || null,
    completedAt: row.completed_at || null,
  };
}

/**
 * 初始化 Realtime 订阅
 * @param {Object} handlers
 * @param {()=>Array} handlers.getTodos
 * @param {(todos)=>void} handlers.setTodos
 * @param {(todo)=>void} handlers.notifyCompleted 远端完成时触发（用于动画）
 * @param {(online:boolean)=>void} handlers.setOnline
 * @returns {Object} channel（用于 unsubscribe）
 */
export function initRealtime({ getTodos, setTodos, notifyCompleted, setOnline }) {
  let ready = false;

  const channel = supabase
    .channel('todos-changes')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'todos' },
      (payload) => {
        const todo = toExternal(payload.new);
        const todos = getTodos();
        // 幂等去重（本端插入会回声）
        if (todos.some((t) => t.id === todo.id)) return;
        setTodos(sortTodos([...todos, todo]));
      }
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'todos' },
      (payload) => {
        const todo = toExternal(payload.new);
        const todos = getTodos();
        const prev = todos.find((t) => t.id === todo.id);
        if (!prev) {
          // 没找到 prev（可能在订阅前已存在），当作 insert
          if (!todos.some((t) => t.id === todo.id)) {
            setTodos(sortTodos([...todos, todo]));
          }
          return;
        }
        const becameCompleted = todo.completed && !prev.completed;
        setTodos(sortTodos(todos.map((t) => (t.id === todo.id ? todo : t))));
        if (becameCompleted && notifyCompleted) notifyCompleted(todo);
      }
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'todos' },
      (payload) => {
        const id = payload.old?.id;
        if (!id) return;
        setTodos(getTodos().filter((t) => t.id !== id));
      }
    )
    .subscribe((status, err) => {
      // SUBSCRIBED / CLOSED / CHANNEL_ERROR / TIMED_OUT
      const online = status === 'SUBSCRIBED';
      if (online && !ready) ready = true;
      if (setOnline) setOnline(online);
      if (err) console.warn('[realtime] 订阅错误:', err.message);
    });

  return {
    channel,
    /** 取消订阅 */
    unsubscribe() {
      supabase.removeChannel(channel);
    },
  };
}
