import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase.js';

const AuthContext = createContext(null);

/**
 * 认证上下文：管理登录态（loading / user），暴露 login / logout。
 * 登录复用 Supabase Auth 的两个固定账号（伪邮箱映射，与 App 端一致）。
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 冷启动恢复本地持久化的 session
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ?? null);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const login = useCallback(async (usernameOrEmail, password) => {
    const email = usernameToEmail(usernameOrEmail);
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      // Supabase 统一返回 "Invalid login credentials"，不区分用户名/密码错
      const e = new Error('用户名或密码错误');
      e.code = 'INVALID_CREDENTIALS';
      throw e;
    }
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = { user, loading, login, logout };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}

// 用户名 → 伪邮箱映射（与 App 端 public/js/auth.js 保持一致）
const USERNAME_TO_EMAIL = {
  小宝宝: 'xiaobaobao@todo.local',
  大宝贝: 'dabaobei@todo.local',
  XiaoBaoBao: 'xiaobaobao@todo.local',
  DaBaoBei: 'dabaobei@todo.local',
};

function usernameToEmail(input) {
  const trimmed = (input || '').trim();
  if (USERNAME_TO_EMAIL[trimmed]) return USERNAME_TO_EMAIL[trimmed];
  // 已是邮箱形式则直接使用
  if (trimmed.includes('@')) return trimmed;
  // 兜底：未知名 → 拼伪邮箱（不会登录成功，保留扩展性）
  return `${trimmed.toLowerCase()}@todo.local`;
}
