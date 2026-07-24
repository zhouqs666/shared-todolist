/**
 * Socket.IO 服务
 *
 * PRD §8.2：
 * - 客户端连接时下发全量 todo:sync
 * - 订阅 eventBus，把 created/updated/deleted 广播给所有在线连接
 * - 连接时校验 session 鉴权（未登录拒绝连接）
 * - 广播时跳过发起者本人（避免乐观更新被自己的回声覆盖）
 */

import { Server as SocketServer } from 'socket.io';
import cookie from 'cookie';
import { todoStore } from '../store/todoStore.js';
import { bus, EVENTS } from './eventBus.js';

/** userId → Set<socketId>，用于广播时跳过发起者本人 */
const userSockets = new Map();

function addUserSocket(userId, socketId) {
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socketId);
}
function removeUserSocket(userId, socketId) {
  const set = userSockets.get(userId);
  if (set) {
    set.delete(socketId);
    if (set.size === 0) userSockets.delete(userId);
  }
}
/** 广播给除了指定 userId 之外的所有连接 */
function broadcastExcept(userId, event, payload) {
  for (const [uid, socketIds] of userSockets.entries()) {
    if (uid === userId) continue;
    for (const sid of socketIds) {
      io.to(sid).emit(event, payload);
    }
  }
}

let io;

/**
 * 挂载 Socket.IO 到 HTTP server
 * @param {import('http').Server} server
 * @param {import('express').RequestHandler} sessionMiddleware - Express session 中间件实例
 */
export function setupSockets(server, sessionMiddleware) {
  io = new SocketServer(server, {
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
    const userId = socket.data.userId;
    addUserSocket(userId, socket.id);
    console.log(`[socket] 已连接 userId=${userId} socketId=${socket.id}`);

    // 下发当前全量数据（PRD §8.2 todo:sync）
    try {
      const todos = await todoStore.listAll();
      socket.emit('todo:sync', todos);
    } catch (err) {
      console.error('[socket] 下发 sync 失败:', err);
    }

    socket.on('disconnect', (reason) => {
      removeUserSocket(userId, socket.id);
      console.log(`[socket] 断开 userId=${userId} reason=${reason}`);
    });
  });

  // ===== 订阅总线，广播给除发起者外的连接 =====
  // bus 事件携带 (payload, senderUserId)
  bus.on(EVENTS.TODO_CREATED, (todo, senderUserId) => {
    if (senderUserId) {
      broadcastExcept(senderUserId, EVENTS.TODO_CREATED, todo);
    } else {
      io.emit(EVENTS.TODO_CREATED, todo);
    }
  });
  bus.on(EVENTS.TODO_UPDATED, (todo, senderUserId) => {
    if (senderUserId) {
      broadcastExcept(senderUserId, EVENTS.TODO_UPDATED, todo);
    } else {
      io.emit(EVENTS.TODO_UPDATED, todo);
    }
  });
  bus.on(EVENTS.TODO_DELETED, (payload, senderUserId) => {
    if (senderUserId) {
      broadcastExcept(senderUserId, EVENTS.TODO_DELETED, payload);
    } else {
      io.emit(EVENTS.TODO_DELETED, payload);
    }
  });

  return io;
}
