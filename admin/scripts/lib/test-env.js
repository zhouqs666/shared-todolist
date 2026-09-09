/**
 * 测试环境共享工具：读取 .env.test + 幂等创建测试账号。
 *
 * 供两个脚本复用，避免重复（DRY）：
 *   - scripts/init-test-users.mjs   只建账号（旧命令，兼容保留）
 *   - scripts/init-test-env.mjs     一键初始化总入口（建账号 + 建表检测 + 登录自检）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/lib -> scripts -> admin 根目录，固定定位到 admin/.env.test，与 cwd 无关
const ADMIN_ROOT = path.resolve(__dirname, '../..');
const ENV_PATH = path.join(ADMIN_ROOT, '.env.test');

/** 读取并校验 .env.test，缺失即报错退出。返回测试环境配置。 */
export function loadTestEnv() {
  dotenv.config({ path: ENV_PATH });

  const URL = process.env.E2E_SUPABASE_URL;
  const ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY;
  const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
  const EMAIL = process.env.E2E_TEST_EMAIL;
  const PASSWORD = process.env.E2E_TEST_PASSWORD;

  const missing = [];
  if (!URL) missing.push('E2E_SUPABASE_URL');
  if (!ANON_KEY) missing.push('E2E_SUPABASE_ANON_KEY');
  if (!SERVICE_ROLE_KEY) missing.push('E2E_SUPABASE_SERVICE_ROLE_KEY');
  if (!EMAIL) missing.push('E2E_TEST_EMAIL');
  if (!PASSWORD) missing.push('E2E_TEST_PASSWORD');

  if (missing.length) {
    console.error(`✗ 缺少环境变量：${missing.join(' / ')}`);
    console.error(`  请编辑 ${ENV_PATH}（参考 .env.test.example 填入测试项目值）`);
    process.exit(1);
  }

  return { URL, ANON_KEY, SERVICE_ROLE_KEY, EMAIL, PASSWORD };
}

/** 两个固定测试账号（伪邮箱，独立测试项目注册，与生产账号无关） */
export const TEST_USERS = [
  { email: 'xiaobaobao@todo.local', username: 'xiaobaobao', display_name: '小宝宝' },
  { email: 'dabaobei@todo.local', username: 'dabaobei', display_name: '大宝贝' },
];

/**
 * 幂等创建测试账号（已存在则跳过）。返回 { failed }。
 *
 * 使用 Auth API（auth.admin.createUser）创建用户，trigger 自动建 profile。
 * 已存在时跳过（catch duplicate error）。
 */
export async function createTestUsers(client, password) {
  let failed = false;
  for (const u of TEST_USERS) {
    const { data, error } = await client.auth.admin.createUser({
      email: u.email,
      password: password,
      email_confirm: true,
      user_metadata: { username: u.username, display_name: u.display_name },
    });

    if (error) {
      if (/already exists|duplicate|23505/i.test(error.message)) {
        console.log(`  ✓ 已存在，跳过：${u.email}`);
        continue;
      }
      console.error(`   创建失败 ${u.email}：${error.message}`);
      failed = true;
      continue;
    }
    console.log(`  ✓ 创建成功：${u.email} (id=${data.user.id})`);
  }
  return { failed };
}
