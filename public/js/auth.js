/**
 * 认证层（基于 Supabase Auth）
 *
 * 对外暴露与原 api.js 风格一致的方法：
 *   - login(username, password)
 *   - logout()
 *   - getCurrentUser()
 *   - onAuthChange(callback)
 *
 * 内部把"用户名"映射成 Supabase 必需的"邮箱"形式。
 * 两个固定账号的伪邮箱地址在此声明（不暴露给上层）。
 */

import { supabase } from './supabase.js';

// 用户名 → 伪邮箱映射
// 用伪邮箱是因为 Supabase Auth 必须以邮箱为账号唯一标识，
// 但我们的应用不需要真实邮箱通信（已关闭邮箱验证）。
const USERNAME_TO_EMAIL = {
  XiaoBaoBao: 'xiaobaobao@todo.local',
  DaBaoBei: 'dabaobei@todo.local',
};

function usernameToEmail(username) {
  // 大小写敏感的精确匹配
  if (USERNAME_TO_EMAIL[username]) return USERNAME_TO_EMAIL[username];
  // 兜底：未知名 → 拼伪邮箱（不会登录成功，但保留扩展性）
  return `${username.toLowerCase()}@todo.local`;
}

export const auth = {
  /**
   * 登录
   * @returns {Promise<{id, username, displayName}>}
   * @throws {Error} 失败时 err.code = 'INVALID_CREDENTIALS'
   */
  async login(username, password) {
    if (!username || !password) {
      const e = new Error('请输入用户名和密码');
      e.code = 'INVALID_INPUT';
      throw e;
    }
    const { data, error } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(username.trim()),
      password,
    });
    if (error) {
      // Supabase 统一返回 "Invalid login credentials"，不区分用户名错还是密码错
      const e = new Error('用户名或密码错误');
      e.code = 'INVALID_CREDENTIALS';
      throw e;
    }
    return this._shapeUser(data.user, username);
  },

  /** 退出登录 */
  async logout() {
    await supabase.auth.signOut();
  },

  /**
   * 获取当前登录用户（基于本地持久化的 session）
   * @returns {Promise<{id, username, displayName}|null>}
   */
  async getCurrentUser() {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    return this._shapeUser(data.user);
  },

  /**
   * 注册 auth 状态变化回调
   * @param {('SIGNED_IN'|'SIGNED_OUT'|'TOKEN_REFRESHED')=>void} cb
   * @returns {() => void} 取消订阅函数
   */
  onAuthChange(cb) {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      const simpleEvent =
        event === 'SIGNED_IN' ? 'SIGNED_IN' :
        event === 'SIGNED_OUT' ? 'SIGNED_OUT' :
        event === 'TOKEN_REFRESHED' ? 'TOKEN_REFRESHED' :
        'OTHER';
      cb(simpleEvent, session);
    });
    return () => data.subscription.unsubscribe();
  },

  /** 把 Supabase user 对象规整成应用内统一形状 */
  _shapeUser(user, fallbackUsername) {
    if (!user) return null;
    const meta = user.user_metadata || {};
    return {
      id: user.id,
      username: meta.username || fallbackUsername || null,
      displayName: meta.display_name || meta.username || fallbackUsername || '我',
    };
  },
};
