/**
 * Supabase 客户端单例（管理后台）
 *
 * 连接信息走 Vite 环境变量（import.meta.env.VITE_*），而非硬编码：
 *   - 便于「测试库 / 生产库」切换（改 .env 两个值即可，见 .env.example）
 *   - 阶段 2 的 E2E 测试数据隔离依赖此机制
 *
 * anon key 是设计上可公开的 public key，真正的安全靠 Supabase RLS（行级安全）：
 *   - anon（未登录）：无法读写 todos
 *   - authenticated（登录后）：可读写所有 todos（双人共享模式）
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    '缺少 Supabase 环境变量：请复制 admin/.env.example 为 admin/.env，' +
      '并填入 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY（见 Supabase Dashboard → Project Settings → API）'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
