import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from './config/env.js';
import authRoutes from './routes/auth.js';
import todosRoutes from './routes/todos.js';
import { requireAuthPage, isLoggedIn } from './auth/middleware.js';
import { setupSockets } from './sockets/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, '..', 'public');

const app = express();
const server = http.createServer(app);

// ----- 解析请求体 -----
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ----- Session（共享给 Socket.IO 鉴权） -----
const sessionMiddleware = session({
  name: 'sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd, // production 下 Render 自动提供 HTTPS
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 天
  },
});
app.use(sessionMiddleware);

// ----- 静态资源（CSS/JS/图片等公开资源，无需鉴权） -----
// 只暴露非 HTML 的静态资源，HTML 由显式路由控制（便于鉴权）
app.use(express.static(PUBLIC_DIR, { extensions: [], index: false }));

// ----- API 路由 -----
app.use('/api', authRoutes);
app.use('/api/todos', todosRoutes);

// ----- 健康检查 -----
app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ----- 登录页：已登录则跳主页，否则返回 login.html -----
app.get('/login', (req, res) => {
  if (isLoggedIn(req)) return res.redirect('/');
  return res.sendFile(join(PUBLIC_DIR, 'login.html'));
});

// ----- 主页：需要登录 -----
app.get('/', requireAuthPage, (_req, res) => {
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

// ----- 全局错误处理 -----
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] unhandled error:', err);
  res.status(500).json({ ok: false, error: 'INTERNAL' });
});

// ----- 启动 -----
setupSockets(server, sessionMiddleware);
server.listen(config.port, () => {
  console.log(`✅ Server running at http://localhost:${config.port}`);
  console.log(`   NODE_ENV=${config.nodeEnv} | DB_TYPE=${config.dbType}`);
});

export { app, server };
