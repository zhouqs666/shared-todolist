/**
 * 生产数据备份（铁律一：任何删除操作前，必须先备份）
 *
 * 存在理由：2026-07-31 数据丢失事故时，备份是**临时手写脚本**产出的
 * （见 `backups/incident-2026-09-14-*.json` 的形状）。紧急时手写脚本最容易出错、也最容易被跳过 ——
 * 把那个形状固化成一条命令，「先备份再删」才真的执行得下去。
 *
 * 用法：
 *   node scripts/backup-tables.mjs --reason "删除 30 天前的软删除行"   # 真导出
 *   node scripts/backup-tables.mjs --reason "看看会导出什么" --dry-run  # 只报告不落盘
 *
 * 只读：仅 SELECT（service_role 绕过 RLS 以读到全量行），不写任何数据库数据。
 * 产物：backups/backup-<时间戳>.json —— 含**完整行**（可直接用于恢复），文件已在 .gitignore
 *       （`backups/` 被忽略，含用户数据，绝不提交）。
 *
 * ⚠️ 覆盖范围：数据库行（todos / stickers / daily_notes / reactions）。
 * **不含 Storage 图片对象**（todo-attachments bucket）—— 图片恢复需要单独导出，目前未实现。
 */

import { createClient } from '@supabase/supabase-js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireSupabaseEnv, ROOT } from './_lib-env.mjs';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`生产数据备份（只读）

用法：
  node scripts/backup-tables.mjs --reason "<为什么要备份>" [--dry-run]

选项：
  --reason "<文字>"   备份原因（必填，写进产物便于事后追溯）
  --dry-run           只报告将要导出什么，不落盘
  -h, --help          显示帮助`);
  process.exit(0);
}

const reasonIdx = args.indexOf('--reason');
const REASON = reasonIdx >= 0 ? args[reasonIdx + 1] || '' : '';
const DRY_RUN = args.includes('--dry-run');

if (!REASON || REASON.length < 4) {
  console.error('✗ 必须用 --reason "<为什么要备份>" 说明原因（至少 4 个字）');
  console.error('  例：node scripts/backup-tables.mjs --reason "清理前备份"');
  process.exit(1);
}

loadEnv();
const { url, key } = requireSupabaseEnv();
const sb = createClient(url, key, { auth: { persistSession: false } });

// 与 incident-*.json 保持一致的四张表
const TABLES = ['todos', 'stickers', 'daily_notes', 'reactions'];

console.log(`\n💾 导出生产数据（只读）\n  原因：${REASON}${DRY_RUN ? '\n  模式：--dry-run（不落盘）' : ''}\n`);

const tables = {};
const counts = {};

for (const t of TABLES) {
  const { data, error } = await sb.from(t).select('*');
  if (error) {
    console.error(`  ✗ ${t} 导出失败：${error.message}`);
    console.error('    （备份不完整就不要继续做删除。缺表/缺列可能是迁移未执行，先跑 check-test-schema 看契约）');
    process.exit(1);
  }
  tables[t] = data ?? [];
  counts[t] = tables[t].length;
  console.log(`  ✓ ${t}: ${counts[t]} 行`);
}

// todo_ids 冗余一份：与历史备份文件形状一致，便于人工快速核对"这次备份里有哪些待办"
const payload = {
  incident: REASON,
  backed_up_at: new Date().toISOString(),
  reason: REASON,
  counts,
  todo_ids: (tables.todos ?? []).map((r) => r.id),
  tables,
};

const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);

if (DRY_RUN) {
  console.log(`\n🟡 --dry-run：共 ${totalRows} 行，未落盘。`);
  console.log('   去掉 --dry-run 即写入 backups/（该目录已在 .gitignore，绝不提交）\n');
  process.exit(0);
}

const BACKUP_DIR = join(ROOT, 'backups');
if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = join(BACKUP_DIR, `backup-${stamp}.json`);
writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');

console.log(`\n✅ 备份完成：${file}`);
console.log(`   共 ${totalRows} 行（todos ${counts.todos} / stickers ${counts.stickers} / ` +
  `daily_notes ${counts.daily_notes} / reactions ${counts.reactions}）`);
console.log('   ⚠️ 不含 Storage 图片对象，图片恢复需另行导出');
console.log('   ⚠️ 该文件含用户数据，已在 .gitignore，绝不提交\n');
