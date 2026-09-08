/**
 * 测试项目账号初始化：在「独立 Supabase 测试项目」中创建两个测试账号（幂等）。
 *
 * 用途：阶段 2 E2E 测试的登录账号。独立测试库物理隔离，与生产账号无关。
 * 用法：cd admin && npm run init:test-users（先配好 .env.test）
 *
 * 说明：
 *   - 邮箱复用 xiaobaobao@todo.local / dabaobei@todo.local（伪邮箱，测试项目独立注册）
 *   - 密码从 .env.test 的 E2E_TEST_PASSWORD 读取（init 脚本与测试用例共用同一份）
 *   - email_confirm: true 跳过邮件验证，创建后即可登录
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '.env.test' });

const URL = process.env.E2E_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

if (!URL || !SERVICE_ROLE_KEY) {
  console.error('✗ 缺少 E2E_SUPABASE_URL / E2E_SUPABASE_SERVICE_ROLE_KEY');
  console.error('  请先复制 admin/.env.test.example 为 admin/.env.test 并填入测试项目值');
  process.exit(1);
}
if (!PASSWORD) {
  console.error('✗ 缺少 E2E_TEST_PASSWORD（测试账号密码，供 E2E 登录用）');
  process.exit(1);
}

const USERS = [
  { email: 'xiaobaobao@todo.local', username: 'xiaobaobao', display_name: '小宝宝' },
  { email: 'dabaobei@todo.local', username: 'dabaobei', display_name: '大宝贝' },
];

const admin = createClient(URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let failed = false;
for (const u of USERS) {
  const { data, error } = await admin.auth.admin.createUser({
    email: u.email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { username: u.username, display_name: u.display_name },
  });
  if (error) {
    // 幂等：已存在则跳过（不同 Supabase 版本文案略有差异，统一按「已注册」处理）
    if (/(already|duplicate|been registered|already exists)/i.test(error.message)) {
      console.log(`✓ 已存在，跳过：${u.email}`);
      continue;
    }
    console.error(`✗ 创建失败 ${u.email}：${error.message}`);
    failed = true;
    continue;
  }
  console.log(`✓ 创建成功：${u.email} (id=${data.user.id})`);
}

if (failed) {
  console.error('测试账号初始化未完全成功');
  process.exit(1);
}
console.log('测试账号初始化完成');
