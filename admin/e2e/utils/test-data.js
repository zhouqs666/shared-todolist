import { createClient } from '@supabase/supabase-js';

/**
 * 测试数据夹具：用 service_role key 直连「独立测试库」造数 / 清数。
 *
 * 设计原则（面试可讲）：
 * - service_role 绕过 RLS，仅用于测试准备与清理，绝不进前端代码（方案 §4.4）
 * - 所有测试数据加 E2E- 前缀标记，清理时只删带标记的数据（防误删，对齐铁律一）
 * - 独立测试库物理隔离，测试数据可物理删除（不软删除，保持库纯净）
 */

const URL = process.env.E2E_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;

export const E2E_PREFIX = 'E2E-';

export function createTestClient() {
  if (!URL || !SERVICE_ROLE_KEY) {
    throw new Error(
      '缺少 E2E_SUPABASE_URL / E2E_SUPABASE_SERVICE_ROLE_KEY' +
        '（复制 admin/.env.test.example 为 .env.test 并填入测试项目值）'
    );
  }
  return createClient(URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * 获取测试账号的 user id。
 * todos.created_by 是 NOT NULL 外键引用 auth.users，造数必须填真实用户 id。
 */
export async function getTestUserId(client, email) {
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
 * 造一条待办（text 加 E2E- 前缀标记）。
 * completed=true 时同步填 completed_by / completed_at，满足表的 CHECK 约束。
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

/** 清理所有 E2E- 前缀的测试数据（独立测试库，允许物理删除） */
export async function cleanupE2EData(client) {
  const { error } = await client
    .from('todos')
    .delete()
    .like('text', `${E2E_PREFIX}%`);
  if (error) throw error;
}
