/**
 * Supabase 客户端单例
 *
 * anon key 是设计上可公开的（public key），真正的安全靠 RLS：
 *   - anon（未登录）：完全无法读写 todos
 *   - authenticated（登录后）：可读写所有 todos（双人共享模式）
 * 所以即使这个 key 进入前端代码、被任何人看到，也无法绕过登录获取数据。
 *
 * 本地打包的 supabase-js（来自 @supabase/supabase-js@2，esbuild bundle），
 * 不依赖 CDN，避免中国网络访问 CDN 的不稳定性。
 */

import { createClient } from './vendor/supabase-js.esm.js';

const SUPABASE_URL = 'https://zyceucmmtstszdnugimn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp5Y2V1Y21tdHN0c3pkbnVnaW1uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1MTYzMjUsImV4cCI6MjEwMDA5MjMyNX0.FoFHr0QLUdfpn9d1rbdbXMo6YdQuUHcusdmIDd1Irlg';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  realtime: {
    params: { eventsPerSecond: 10 },
  },
});
