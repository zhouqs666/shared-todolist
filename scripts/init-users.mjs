/**
 * 初始化两个 Auth 用户（幂等可重复运行）
 *
 * 用法：
 *   npm run init-users
 *   （等价于：node --env-file-if-exists=.env scripts/init-users.mjs）
 *
 * 行为：
 *   1. 用 service_role 登录 Supabase admin API
 *   2. 检查两个用户是否已存在
 *   3. 不存在则创建（email_confirm: true 跳过邮箱验证）
 *   4. handle_new_user trigger 会自动建 profile（无需手动）
 *
 * 配置：从 .env 读取 SUPABASE_URL / SUPABASE_KEY（service_role）
 */

import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;

if (!URL || !KEY) {
  console.error('❌ 缺少环境变量 SUPABASE_URL 或 SUPABASE_KEY（service_role）');
  console.error('   请确认 .env 文件存在并配置了上述变量');
  process.exit(1);
}

// 解码 JWT 验证一下是不是 service_role（防止误用 anon key）
try {
  const payload = JSON.parse(Buffer.from(KEY.split('.')[1], 'base64').toString());
  if (payload.role !== 'service_role') {
    console.error(`❌ SUPABASE_KEY 应该是 service_role，当前是 "${payload.role}"`);
    process.exit(1);
  }
} catch (e) {
  console.error('❌ SUPABASE_KEY 不是有效的 JWT 格式');
  process.exit(1);
}

const supabase = createClient(URL, KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// 两个固定账号（与前端 auth.js 的 USERNAME_TO_EMAIL 保持一致）
// 注意：email 是幂等去重的键，不可改；username/display_name 用中文，
// 新建账号时写入 user_metadata，再由 handle_new_user trigger 落到 profiles。
// 已有账号需另外跑 SQL 更新 profiles.display_name（见 README 或会话记录）。
const USERS = [
  { username: '小宝宝', email: 'xiaobaobao@todo.local', password: '5201314', display_name: '小宝宝' },
  { username: '大宝贝', email: 'dabaobei@todo.local',   password: '5271314', display_name: '大宝贝' },
];

console.log('=== 初始化 Auth 用户 ===');
console.log(`Supabase: ${URL}\n`);

// 列出所有现有用户
const { data: listData, error: listErr } = await supabase.auth.admin.listUsers();
if (listErr) {
  console.error('❌ 查询现有用户失败:', listErr.message);
  process.exit(1);
}
const existingEmails = new Set((listData.users || []).map((u) => u.email));

let created = 0;
let skipped = 0;
const ids = {};

for (const u of USERS) {
  if (existingEmails.has(u.email)) {
    const exist = listData.users.find((x) => x.email === u.email);
    console.log(`  ⏭️  ${u.username} 已存在 (${u.email}) id=${exist.id}，跳过`);
    ids[u.username] = exist.id;
    skipped++;
    continue;
  }
  const { data, error } = await supabase.auth.admin.createUser({
    email: u.email,
    password: u.password,
    email_confirm: true, // 跳过邮箱验证（伪邮箱）
    user_metadata: { username: u.username, display_name: u.display_name },
  });
  if (error) {
    console.error(`  ❌ ${u.username} 创建失败: ${error.message}`);
    process.exit(1);
  }
  console.log(`  ✅ ${u.username} 创建成功 id=${data.user.id}`);
  ids[u.username] = data.user.id;
  created++;
}

console.log(`\n--- 结果 ---`);
console.log(`新建: ${created}    跳过: ${skipped}    总数: ${USERS.length}`);
console.log(`\nID 映射（如需手填 profile 时用）:`);
for (const [name, id] of Object.entries(ids)) {
  console.log(`  ${name}: ${id}`);
}
console.log(`\n${created + skipped === USERS.length ? '✅ 完成' : '❌ 不完整'}`);
process.exit(created + skipped === USERS.length ? 0 : 1);
