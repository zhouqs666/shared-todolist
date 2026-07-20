/**
 * 进程内事件总线
 *
 * 用途：解耦 REST 路由与 Socket.IO 广播层
 * 路由处理完数据变更后 emit 事件，Socket 层订阅并广播给所有在线连接
 *
 * 设计原则：
 * - 简单的 EventEmitter，单进程内通信（V1 双人场景够用）
 * - 如未来扩展多进程/多实例，可替换为 Redis Pub/Sub
 */

import { EventEmitter } from 'events';

export const bus = new EventEmitter();
bus.setMaxListeners(50); // 多个 Socket 连接 + 路由都会监听

/** 事件名常量，与前端约定一致 */
export const EVENTS = Object.freeze({
  TODO_CREATED: 'todo:created',
  TODO_UPDATED: 'todo:updated',
  TODO_DELETED: 'todo:deleted',
});
