/**
 * Supabase 客户端单例（含双环境切换，2026-10-06）
 *
 * anon key 是设计上可公开的（public key），真正的安全靠 RLS：
 *   - anon（未登录）：完全无法读写 todos
 *   - authenticated（登录后）：可读写所有 todos（双人共享模式）
 * 所以即使这个 key 进入前端代码、被任何人看到，也无法绕过登录获取数据。
 *
 * 双环境（一个包，测试/生产可切换；切换入口 = 长按头像 → 账号菜单「切换环境」，
 * 见 env-switch.js）：
 *   · 主默认（SUPABASE_URL）：打包/发版渠道的默认环境——生产包 = 生产库；
 *     测试打包（build-test-apk）与测试发版（release-test）会把这两行改写为测试库。
 *     ⚠️ 下面两行的 const 名与字面量格式是 serve-test / build-test-apk / release-test
 *     的改写目标（正则 `/const SUPABASE_URL = '[^']*';/` 的首个匹配必须是它），勿改格式。
 *   · 显式配置对（*_TEST / *_PROD）：环境切换的两个目标。主默认被改写为测试库的包
 *     仍保留完整生产对（反之亦然），两个方向都切得动。
 *   · 生效顺序：localStorage['app_env'] 标记 > 主默认（标记缺省时跟随渠道身份）。
 *     切换 = 写标记 + 整页 reload——单例、Realtime 订阅、登录态都随重载重建，
 *     不做运行时热切（无缝切换要把订阅重连/飞行请求/队列迁移全处理对，收益不值）。
 *   · session 分仓：vendor supabase-js 的 storageKey 按项目 ref 推导
 *     （sb-<ref>-auth-token），两项目登录态天然隔离，切回曾登录过的环境免登录。
 *   · ⚠️ 铁律一：包内含两套 anon 配置 ≠ 隔离失效——隔离载体从「包内容」变为
 *     「app_env 标记（测试环境角标可见）+ 双发版通道分离」，详见 AGENTS.md 铁律一。
 *
 * 本地打包的 supabase-js（来自 @supabase/supabase-js@2，esbuild bundle），
 * 不依赖 CDN，避免中国网络访问 CDN 的不稳定。
 */

import { createClient } from './vendor/supabase-js.esm.js';

// ===== 双环境配置（改写目标：见文件头 ⚠️ 注释，格式勿动）=====
const SUPABASE_URL = 'https://zyceucmmtstszdnugimn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp5Y2V1Y21tdHN0c3pkbnVnaW1uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1MTYzMjUsImV4cCI6MjEwMDA5MjMyNX0.FoFHr0QLUdfpn9d1rbdbXMo6YdQuUHcusdmIDd1Irlg';
const SUPABASE_URL_TEST = 'https://fsmzgpkldwulmzlukvke.supabase.co';
const SUPABASE_ANON_KEY_TEST = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZzbXpncGtsZHd1bG16bHVrdmtlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5MTY0MjEsImV4cCI6MjEwNDQ5MjQyMX0.u6Q3O4_5JnjAVV4zzi6cIG0h-MreGVVa6o0gOHOZ9RE';
const SUPABASE_URL_PROD = 'https://zyceucmmtstszdnugimn.supabase.co';
const SUPABASE_ANON_KEY_PROD = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp5Y2V1Y21tdHN0c3pkbnVnaW1uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1MTYzMjUsImV4cCI6MjEwMDA5MjMyNX0.FoFHr0QLUdfpn9d1rbdbXMo6YdQuUHcusdmIDd1Irlg';

/** 环境标记的 localStorage 键（env-switch.js 写入；'prod' | 'test' | 缺省=跟随主默认） */
export const ENV_OVERRIDE_KEY = 'app_env';

/** 解析当前环境：标记优先；缺省时主默认被改写过（=测试渠道包）即测试环境 */
function resolveEnv() {
  try {
    const m = localStorage.getItem(ENV_OVERRIDE_KEY);
    if (m === 'test' || m === 'prod') return m;
  } catch (_) { /* localStorage 不可用（隐私模式等）→ 跟随主默认 */ }
  return SUPABASE_URL === SUPABASE_URL_TEST ? 'test' : 'prod';
}

/** 本页生命周期内的环境（模块加载时解析一次；切换靠 reload 重建） */
export const CURRENT_ENV = resolveEnv();

const ACTIVE_URL = CURRENT_ENV === 'test' ? SUPABASE_URL_TEST : SUPABASE_URL_PROD;
const ACTIVE_ANON_KEY = CURRENT_ENV === 'test' ? SUPABASE_ANON_KEY_TEST : SUPABASE_ANON_KEY_PROD;

export const supabase = createClient(ACTIVE_URL, ACTIVE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  realtime: {
    params: { eventsPerSecond: 10 },
  },
});
