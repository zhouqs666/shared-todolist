/**
 * 一键初始化「独立 Supabase 测试项目」环境（幂等，可重复执行）。
 *
 * 三步：
 *   ① 检测核心表是否已建（todos / profiles）——未建则提示去 SQL Editor 执行 schema.sql
 *   ② 幂等创建两个测试账号
 *   ③ 端到端登录自检（anon key + 测试账号 signInWithPassword）
 *
 * 用法：cd admin && npm run init:test-env（先配好 .env.test）
 *
 * 关于建表：Supabase 官方没有「用 service_role key 执行任意建表 SQL」的通道，
 * 自动跑 schema.sql 需要数据库密码（pg 直连）或 Management API token，反而多一个
 * secret。因此建表保留在测试项目 SQL Editor 手动执行一次（约 1 分钟），本脚本
 * 负责检测 + 给指引，把人工动作降到「粘贴一次」。
 */
import { createClient } from '@supabase/supabase-js';
import { loadTestEnv, createTestUsers } from './lib/test-env.js';

const { URL, ANON_KEY, SERVICE_ROLE_KEY, EMAIL, PASSWORD } = loadTestEnv();

const admin = createClient(URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ① 建表检测
console.log('▶ [1/3] 检测核心表是否已建…');
const { error: todosErr } = await admin.from('todos').select('id').limit(1);
const { error: profilesErr } = await admin.from('profiles').select('id').limit(1);
if (todosErr || profilesErr) {
  const which = todosErr ? 'todos' : 'profiles';
  const err = todosErr || profilesErr;
  console.error(`✗ 表 ${which} 不可访问：${err.message}`);
  console.error('  请到测试项目 Dashboard → SQL Editor，粘贴执行仓库根目录 supabase/schema.sql（约 1 分钟）');
  console.error('  完成后重跑：npm run init:test-env');
  process.exit(1);
}
console.log('  ✓ 核心表已建（todos / profiles 可访问）');

// ② 建账号
console.log('▶ [2/3] 创建测试账号…');
const { failed } = await createTestUsers(admin, PASSWORD);
if (failed) {
  console.error('✗ 账号创建未完全成功，中止');
  process.exit(1);
}

// ③ 登录自检（验证 anon key + 账号 + profiles trigger 全链路）
console.log('▶ [3/3] 端到端登录自检…');
const anon = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
const { data, error: signinErr } = await anon.auth.signInWithPassword({
  email: EMAIL,
  password: PASSWORD,
});
if (signinErr) {
  console.error(`✗ 登录自检失败：${signinErr.message}`);
  console.error('  请检查 E2E_SUPABASE_ANON_KEY 是否正确、账号是否已创建');
  process.exit(1);
}
console.log(`  ✓ 登录成功：${data.user.email} (id=${data.user.id})`);

console.log('');
console.log('✅ 测试环境初始化完成，可运行 E2E：npm run test:e2e');
