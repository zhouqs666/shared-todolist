/**
 * 鉴权路由：/api/login, /api/logout, /api/me
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { findByUsername, findById } from '../auth/userService.js';
import { isLoggedIn } from '../auth/middleware.js';

const router = Router();

/**
 * POST /api/login
 * body: { username, password }
 */
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};

  // 输入校验
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  }

  const user = findByUsername(username.trim());
  // 即使找不到用户也走一次 bcrypt 比对，规避时序侧信道（统一耗时）
  const dummyHash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
  const hashToCompare = user?.passwordHash || dummyHash;
  const ok = await bcrypt.compare(password, hashToCompare);

  if (!user || !ok) {
    // PRD §4.2 F-01：不区分「用户不存在」与「密码错」
    return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
  }

  // 写入 session
  req.session.userId = user.id;

  return res.json({
    ok: true,
    user: { id: user.id, username: user.username, displayName: user.displayName },
  });
});

/**
 * POST /api/logout
 */
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('[auth] logout error:', err);
      return res.status(500).json({ ok: false, error: 'INTERNAL' });
    }
    // 清除客户端 cookie
    res.clearCookie('sid');
    return res.json({ ok: true });
  });
});

/**
 * GET /api/me
 * 返回当前登录用户（无敏感字段）
 */
router.get('/me', (req, res) => {
  if (!isLoggedIn(req)) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }
  const user = findById(req.session.userId);
  if (!user) {
    // session 里的用户已失效，清掉
    req.session.destroy(() => res.clearCookie('sid'));
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }
  return res.json({
    ok: true,
    user: { id: user.id, username: user.username, displayName: user.displayName },
  });
});

export default router;
