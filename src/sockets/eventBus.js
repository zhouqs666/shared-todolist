/**
 * 进程内事件总线
 *
 * 用途：解耦 REST 路由与 Socket.IO 广播层
 * 路由处理完数据变更后 emit 事件，Socket 层订阅并广播给所有在线连接
 *
 * 事件参数约定：(payload, senderUserId) — senderUserId 用于服务端排除发送者本人
 */

import { EventEmitter } from 'events';

export const bus = new EventEmitter();
bus.setMaxListeners(50);

/** 事件名常量，与前端约定一致 */
export const EVENTS = Object.freeze({
  TODO_CREATED: 'todo:created',
  TODO_UPDATED: 'todo:updated',
  TODO_DELETED: 'todo:deleted',
});
