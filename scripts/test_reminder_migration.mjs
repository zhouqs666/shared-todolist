#!/usr/bin/env node
/**
 * 待办提醒迁移的回归测试（不需要任何 Supabase 凭据，可进 CI）
 *
 * 为什么要有它：migration-reminders.sql 的核心风险不在「加列」（ADD COLUMN IF NOT EXISTS
 * 基本不会错），而在**两条 CHECK 约束的语义** —— remind_consistent（三列同空/同非空）
 * 与 remind_scope_allowed（值域）。写反了不会报错，只会安静地拦下合法写入或放过脏数据，
 * 第一次发现是在用户设置提醒失败的那一刻。所以用 PGlite（真 Postgres 的 WASM 版）
 * 把迁移真跑一遍，断言：合法形状能写、半空行/非法 scope 被 23514 拦下、重复执行幂等。
 *
 * 与 test_rls_migration.mjs 同模式：本地真 Postgres，不连任何 Supabase 项目（铁律一）。
 *
 * 用法：node scripts/test_reminder_migration.mjs
 * 退出码：0 = 全绿；1 = 有断言失败
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = readFileSync(join(ROOT, 'supabase', 'migration-reminders.sql'), 'utf8');

let failed = 0;
// 签名统一为 (描述, 条件)——与 test_reminder_logic.mjs 的 check 一致，
// 避免「条件/描述传反 → 恒真假绿灯」（本文件第一版就踩了这个：输出全是 ✓ true）。
const check = (m, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${m}`);
  else {
    failed++;
    console.error(`  ✗ ${m}${detail ? ' —— ' + detail : ''}`);
  }
};

const db = new PGlite();
/** 单条语句：失败只回错误码 */
const q = async (sql) => {
  try {
    const r = await db.query(sql);
    return { rows: r.rows };
  } catch (e) {
    return { err: e.code || e.message };
  }
};

const ME = '11111111-1111-1111-1111-111111111111';

// 造最小环境：todos 表 + auth.users 外键目标（迁移的 remind_by 引用它）
await db.exec(`
create schema auth;
create table auth.users (id uuid primary key);
insert into auth.users values ('${ME}');
create table todos (
  id uuid primary key default gen_random_uuid(),
  text text not null check (char_length(text) <= 200),
  completed boolean not null default false,
  created_by uuid not null references auth.users(id)
);
`);

console.log('\n--- 执行迁移 ---');
await db.exec(MIGRATION);

const cols = async () => {
  const { rows } = await q(`
    select column_name from information_schema.columns
     where table_schema='public' and table_name='todos'
     order by column_name`);
  return rows.map((r) => r.column_name);
};
const after = await cols();
check('remind_at 列已创建', after.includes('remind_at'));
check('remind_scope 列已创建', after.includes('remind_scope'));
check('remind_by 列已创建', after.includes('remind_by'));

const addRow = async (remindAt, remindScope, remindBy) =>
  q(`insert into todos (text, created_by, remind_at, remind_scope, remind_by)
     values ('测试', '${ME}', ${remindAt}, ${remindScope}, ${remindBy})`);

console.log('\n--- 约束语义 ---');
{
  const ok = await addRow('null', 'null', 'null');
  check('全空（无提醒）→ 可写', !ok.err, `实际 ${ok.err}`);

  const full = await addRow(`'2026-10-01T05:00:00Z'`, `'both'`, `'${ME}'`);
  check('全非空 → 可写', !full.err, `实际 ${full.err}`);

  const half1 = await addRow(`'2026-10-01T05:00:00Z'`, 'null', 'null');
  check('只有 remind_at（半空）→ 23514 拦下', half1.err === '23514', `实际 ${half1.err}`);

  const half2 = await addRow('null', `'self'`, `'${ME}'`);
  check('只有 scope/by（半空）→ 23514 拦下', half2.err === '23514', `实际 ${half2.err}`);

  const half3 = await addRow(`'2026-10-01T05:00:00Z'`, `'both'`, 'null');
  check('缺 remind_by（半空）→ 23514 拦下', half3.err === '23514', `实际 ${half3.err}`);

  const badScope = await addRow(`'2026-10-01T05:00:00Z'`, `'everyone'`, `'${ME}'`);
  check('非法 scope → 23514 拦下', badScope.err === '23514', `实际 ${badScope.err}`);

  const okScope = await addRow(`'2026-10-01T05:00:00Z'`, `'partner'`, `'${ME}'`);
  check('partner 是合法值 → 可写', !okScope.err, `实际 ${okScope.err}`);

  // 清除提醒：三列一起置 NULL（clearReminder 的写法）必须合法
  const upd = await q(`update todos set remind_at=null, remind_scope=null, remind_by=null
                        where remind_scope='partner'`);
  check('三列一起置 NULL（清除提醒）→ 可写', !upd.err, `实际 ${upd.err}`);
}

console.log('\n--- 幂等：再跑一次 ---');
await db.exec(MIGRATION);
const again = await cols();
check('第二次执行成功（列集合不变）', JSON.stringify(again) === JSON.stringify(after));
const cons = await q(`
  select conname from pg_constraint
   where conrelid = 'todos'::regclass and conname in ('remind_consistent','remind_scope_allowed')
   order by conname`);
check('两条 CHECK 约束仍然只有各一条（DO $$ 判重生效）', cons.rows?.length === 2, `实际 ${JSON.stringify(cons.rows)}`);
const stillWorks = await addRow(`'2026-10-01T06:00:00Z'`, `'self'`, `'${ME}'`);
check('幂等后仍可正常写入合法形状', !stillWorks.err, `实际 ${stillWorks.err}`);

console.log(failed ? `\n✗ ${failed} 项失败\n` : '\n✅ 提醒迁移通过：约束语义正确 + 在真实 Postgres 上幂等\n');
process.exit(failed ? 1 : 0);
