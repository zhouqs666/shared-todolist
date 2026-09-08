/**
 * 测试项目账号初始化（旧命令，兼容保留）：只创建两个测试账号。
 * 推荐改用一键总入口：npm run init:test-env（含建表检测 + 登录自检）。
 */
import { createClient } from '@supabase/supabase-js';
import { loadTestEnv, createTestUsers } from './lib/test-env.js';

const { URL, SERVICE_ROLE_KEY, PASSWORD } = loadTestEnv();
const admin = createClient(URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { failed } = await createTestUsers(admin, PASSWORD);
if (failed) {
  console.error('测试账号初始化未完全成功');
  process.exit(1);
}
console.log('测试账号初始化完成');
