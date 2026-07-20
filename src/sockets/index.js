/**
 * Socket.IO 服务
 *
 * PRD §8.2：
 * - 客户端连接时下发全量 todo:sync
 * - 订阅 eventBus，把 created/updated/deleted 广播给所有在线连接
 * - 连接时校验 session 鉴权（未登录拒绝连接）
 */

import { Server as SocketServer } from 'socket.io';
import cookie from 'cookie';
import { todoStore } from '../store/todoStore.js';
import { bus, EVENTS } from './eventBus.js';

/**
 * 挂载 Socket.IO 到 HTTP server
 * @param {import('http').Server} server
 * @param {import('express').RequestHandler} sessionMiddleware - Express session 中间件实例
 */
export function setupSockets(server, sessionMiddleware) {
  const io = new SocketServer(server, {
    cors: { origin: true, credentials: true },
  });

  // ===== 连接鉴权：复用 Express session 中间件 =====
  io.use((socket, next) => {
    const req = socket.request;
    req.cookies = cookie.parse(socket.handshake.headers.cookie || '');
    sessionMiddleware(req, {}, () => {
      if (req.session && req.session.userId) {
        socket.data.userId = req.session.userId;
        next();
      } else {
        next(new Error('UNAUTHORIZED'));
      }
    });
  });

  // ===== 连接建立 =====
  io.on('connection', async (socket) => {
    console.log(`[socket] 已连接 userId=${socket.data.userId} socketId=${socket.id}`);

    // 下发当前全量数据（PRD §8.2 todo:sync）
    try {
      const todos = await todoStore.listAll();
      socket.emit('todo:sync', todos);
    } catch (err) {
      console.error('[socket] 下发 sync 失败:', err);
    }

    socket.on('disconnect', (reason) => {
      console.log(`[socket] 断开 userId=${socket.data.userId} reason=${reason}`);
    });
  });

  // ===== 订阅总线，广播给所有连接 =====
  bus.on(EVENTS.TODO_CREATED, (todo) => {
    io.emit(EVENTS.TODO_CREATED, todo);
  });
  bus.on(EVENTS.TODO_UPDATED, (todo) => {
    io.emit(EVENTS.TODO_UPDATED, todo);
  });
  bus.on(EVENTS.TODO_DELETED, (payload) => {
    io.emit(EVENTS.TODO_DELETED, payload);
  });

  return io;
}
