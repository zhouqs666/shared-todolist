import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

// Load .env.test from app-e2e directory
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../.env.test') });

/**
 * APP E2E 测试数据夹具：复用阶段2的独立测试库（物理隔离生产库）。
 * 通过 service_role key 绕过 RLS，仅用于测试准备与清理，绝不进 APK。
 */

const URL = process.env.E2E_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
// 支持两种命名：本地用 E2E_TEST_USERNAME（中文），CI 用 E2E_TEST_EMAIL（邮箱）
const TEST_USERNAME = process.env.E2E_TEST_USERNAME || emailToUsername(process.env.E2E_TEST_EMAIL);
const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD;

export const E2E_PREFIX = 'E2E-APP-';

// 邮箱→中文用户名反向映射（CI 的 E2E_TEST_EMAIL 可能是邮箱，需要转回用户名）
const EMAIL_TO_USERNAME = {
  'xiaobaobao@todo.local': '小宝宝',
  'dabaobei@todo.local': '大宝贝',
};
function emailToUsername(email) {
  if (!email) return undefined;
  return EMAIL_TO_USERNAME[email] || email.split('@')[0];
}

// 与 public/js/auth.js 的 usernameToEmail 保持一致（中文用户名 toLowerCase 不变，
// 必须走拼音映射，否则在测试库里查不到用户）
const USERNAME_TO_EMAIL = {
  小宝宝: 'xiaobaobao@todo.local',
  大宝贝: 'dabaobei@todo.local',
};

function usernameToEmail(username) {
  return USERNAME_TO_EMAIL[username] || `${username.toLowerCase()}@todo.local`;
}

export function createTestClient() {
  if (!URL || !SERVICE_ROLE_KEY) {
    throw new Error(
      '缺少 E2E_SUPABASE_URL / E2E_SUPABASE_SERVICE_ROLE_KEY' +
        '（复制 app-e2e/.env.test.example 为 .env.test 并填入测试项目值）'
    );
  }
  return createClient(URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * 获取测试账号的 user id
 */
export async function getTestUserId(client, username) {
  const email = usernameToEmail(username);
  const { data, error } = await client.auth.admin.listUsers();
  if (error) throw error;
  const user = data.users.find((u) => u.email === email);
  if (!user) {
    throw new Error(
      `测试账号不存在：${email}，请先在 admin/ 下运行 npm run init:test-env`
    );
  }
  return user.id;
}

/**
 * 造一条待办（text 加 E2E-APP- 前缀标记，与 web E2E 区分）
 */
export async function seedTodo(client, { userId, text, completed = false }) {
  const row = {
    text: `${E2E_PREFIX}${text}`,
    completed,
    created_by: userId,
  };
  if (completed) {
    row.completed_by = userId;
    row.completed_at = new Date().toISOString();
  }
  const { data, error } = await client
    .from('todos')
    .insert(row)
    .select('id, text, completed')
    .single();
  if (error) throw error;
  return data;
}

/**
 * 按 text 精确查待办
 */
export async function findTodosByText(client, text) {
  const { data, error } = await client
    .from('todos')
    .select('id, text, completed')
    .eq('text', text);
  if (error) throw error;
  return data;
}

/**
 * 轮询等待某条待办达到期望的 completed 状态
 * （UI 点击 → Supabase 写入有网络延迟，不能点击后立刻查库）
 */
export async function waitForTodoCompleted(client, text, expected, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const rows = await findTodosByText(client, text);
    last = rows[0] ?? null;
    if (last && last.completed === expected) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `等待超时：待办「${text}」completed 未变为 ${expected}（当前：${JSON.stringify(last)}）`
  );
}

/**
 * 清理所有 E2E-APP- 前缀的测试数据（只删带标记的，铁律一）
 */
export async function cleanupE2EData(client) {
  const { data, error } = await client
    .from('todos')
    .delete()
    .like('text', `${E2E_PREFIX}%`)
    .select('id');
  if (error) throw error;
  return data ?? [];
}

/**
 * 获取测试账号凭证
 */
export function getTestCredentials() {
  if (!TEST_USERNAME || !TEST_PASSWORD) {
    throw new Error(
      '缺少 E2E_TEST_USERNAME / E2E_TEST_PASSWORD（配置 app-e2e/.env.test）'
    );
  }
  return { username: TEST_USERNAME, password: TEST_PASSWORD };
}
