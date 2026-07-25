/**
 * 把两个账号的"显示名"更新为中文（小宝宝 / 大宝贝）
 *
 * 为什么需要它：init-users.mjs 是幂等的，已存在的账号会被跳过，
 * 不会更新它们的 display_name。所以已有线上账号改名要单独跑这个脚本。
 *
 * 它做两件事（保证登录后界面、待办 meta 都显示中文名）：
 *   1. 更新 auth.users.user_metadata.display_name（getCurrentUser 读这里）
 *   2. 更新 profiles.display_name（listProfiles / userMap 读这里）
 *
 * 用法（用 Node 原生 --env-file-if-exists 注入 .env，与 init-users 一致）：
 *   node --env-file-if-exists=.env scripts/rename-users.mjs
 *
 * 配置：从 .env 读取 SUPABASE_URL / SUPABASE_KEY（service_role）
 * 幂等：可重复运行，已是目标值则跳过。
 */

import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;

if (!URL || !KEY) {
  console.error('❌ 缺少环境变量 SUPABASE_URL 或 SUPABASE_KEY（service_role）');
  console.error('   请确认 .env 文件存在并配置了上述变量');
  process.exit(1);
}

// 校验是 service_role（写操作需要）
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

// 邮箱 → 目标中文显示名（邮箱是账号唯一标识，不变）
const RENAMES = {
  'xiaobaobao@todo.local': '小宝宝',
  'dabaobei@todo.local': '大宝贝',
};

console.log('=== 更新账号显示名为中文 ===\n');

// 1. 列出所有用户，找出要改的
const { data: listData, error: listErr } = await supabase.auth.admin.listUsers();
if (listErr) {
  console.error('❌ 查询用户失败:', listErr.message);
  process.exit(1);
}

const targets = (listData.users || []).filter((u) =>
  Object.prototype.hasOwnProperty.call(RENAMES, u.email)
);

if (targets.length === 0) {
  console.log('⚠️  没找到目标账号（xiaobaobao/dabaobei），请确认账号已创建。');
  process.exit(0);
}

let changed = 0;
let skipped = 0;

for (const user of targets) {
  const newName = RENAMES[user.email];
  const oldMeta = (user.user_metadata && user.user_metadata.display_name) || '';
  console.log(`\n→ ${user.email}  (id=${user.id})`);
  console.log(`    user_metadata.display_name: "${oldMeta}" → "${newName}"`);

  // 1a. 更新 auth.users.user_metadata（getCurrentUser 读这里）
  if (oldMeta !== newName) {
    const { error: updErr } = await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { ...user.user_metadata, username: newName, display_name: newName },
    });
    if (updErr) {
      console.error(`  ❌ 更新 user_metadata 失败: ${updErr.message}`);
      continue;
    }
    console.log(`  ✅ user_metadata 已更新`);
    changed++;
  } else {
    console.log(`  ⏭️  user_metadata 已是目标值，跳过`);
    skipped++;
  }

  // 1b. 更新 profiles.display_name（listProfiles / userMap 读这里）
  const { error: profileErr } = await supabase
    .from('profiles')
    .update({ display_name: newName, username: newName })
    .eq('id', user.id);
  if (profileErr) {
    console.error(`  ❌ 更新 profiles 失败: ${profileErr.message}`);
    continue;
  }
  console.log(`  ✅ profiles.display_name 已更新为 "${newName}"`);
}

console.log(`\n--- 结果 ---`);
console.log(`更新: ${changed}    跳过: ${skipped}    目标总数: ${targets.length}`);
console.log('\n✅ 完成');
process.exit(0);
