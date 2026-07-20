/**
 * 登录态工具与中间件
 */

/**
 * 从 session 取当前登录用户 ID
 * @param {import('express').Request} req
 */
export function getCurrentUserId(req) {
  return req.session?.userId || null;
}

/** 判断是否已登录 */
export function isLoggedIn(req) {
  return !!getCurrentUserId(req);
}

/**
 * 登录态校验中间件
 * - 用于 API：返回 401 JSON
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireAuthApi(req, res, next) {
  if (isLoggedIn(req)) return next();
  return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
}

/**
 * 登录态校验中间件（页面用）
 * - 未登录跳转到 /login
 */
export function requireAuthPage(req, res, next) {
  if (isLoggedIn(req)) return next();
  return res.redirect('/login');
}
