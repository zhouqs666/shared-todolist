/**
 * 待办留言板迁移的回归测试（不需要任何 Supabase 凭据，可进 CI）
 *
 * 为什么要有它（2026-10-09）：
 *   supabase/migration-add-todo-comments.sql 是本次交付里**唯一不能在本地执行**的产物
 *   （应用通道是 Management API / SQL Editor，需要项目的 Database write 权限）。
 *   一段"看起来对"的 SQL 会以这些方式失效，而它们都不是审代码能可靠发现的：
 *     · 重复执行报错（幂等自证失败 / 手工粘贴第二遍报 already member —— 本仓有过先例）
 *     · 策略写反（"只能动自己的"写成对两人都开放 = 又开一个洞）
 *     · 历史备注搬迁写错作者/时间（数据看着在，其实归错了人）
 *   所以用 PGlite（真 Postgres 编译成 WASM）在本地把迁移**真跑两遍**，逐条断言。
 *
 * 覆盖：
 *   ① 结构：两张表 + 期望的列 + RLS 已启用 + 策略齐全
 *   ② 行为：authenticated 只能插/改/删自己 author_id 的行（越权被 42501 或 0 行挡住）
 *   ③ 幂等：整个迁移文件跑第二遍不报错，且不重复插入历史备注
 *   ④ 搬迁：todos.completed_note → todo_comments 第一条留言（作者取完成人）
 *
 * 用法：node scripts/test_comments_migration.mjs
 * 退出码：0 = 全绿；1 = 有断言失败
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = readFileSync(join(ROOT, 'supabase', 'migration-add-todo-comments.sql'), 'utf8');

let failed = 0;
const check = (cond, m) => {
  if (cond) console.log(`  ✓ ${m}`);
  else {
    failed++;
    console.error(`  ✗ ${m}`);
  }
};

const ME = '11111111-1111-1111-1111-111111111111';
const PARTNER = '22222222-2222-2222-2222-222222222222';
const TODO_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_TODO_ID = '44444444-4444-4444-4444-444444444444';

const db = new PGlite();
/** 单条语句：失败只回错误码（PGlite 默认会把整个 bundle 打到 stderr） */
const q = async (sql, params) => {
  try {
    const r = await db.query(sql, params);
    return { rows: r.rows };
  } catch (e) {
    return { err: e.code || e.message };
  }
};
const asRole = async (role, sql) => {
  await q(`set role ${role}`);
  const r = await q(sql);
  await q('reset role');
  return r;
};

// ============================================================
// 造「与生产同形」的库：auth 桩 + todos（含 completed_note 三件套）+ 真实 publication
// ============================================================
await db.exec(`
create schema auth;
create table auth.users (id uuid primary key);
create role anon;
create role authenticated;
-- auth.uid() 在本测试里固定返回 ME：模拟"登录用户是我"
create function auth.uid() returns uuid language sql stable as 'select ''${ME}''::uuid';

create table todos (
  id           uuid primary key default gen_random_uuid(),
  text         text not null check (char_length(text) <= 200),
  created_by   uuid not null references auth.users(id),
  created_at   timestamptz not null default now(),
  completed    boolean not null default false,
  completed_by uuid references auth.users(id),
  completed_at timestamptz,
  completed_note text
);

-- Realtime publication（Supabase 里预置存在；plain Postgres 要自己建，
-- 否则迁移里的 DO 块会连"publication 不存在"一起报，测不到真正的幂等点）
create publication supabase_realtime;
`);

await db.exec(`
insert into auth.users values ('${ME}'), ('${PARTNER}');
insert into todos (id, text, created_by, completed, completed_by, completed_at, completed_note)
values ('${TODO_ID}', 'E2E-测试-留言-历史备注', '${ME}', true, '${PARTNER}',
        timestamptz '2026-09-01 10:00:00+08', '  书房那只已经打死了  ');
insert into todos (id, text, created_by)
values ('${OTHER_TODO_ID}', 'E2E-测试-留言-无备注', '${ME}');
`);

// ============================================================
// ① 结构 + ④ 搬迁：跑第一遍
// ============================================================
console.log('\n=== ① 第一遍：结构 + 历史备注搬迁 ===');
let first = { err: null };
try {
  await db.exec(MIGRATION);
} catch (e) {
  first.err = e.message;
}
check(!first.err, `迁移第一遍执行成功${first.err ? `（失败：${first.err}）` : ''}`);

const colsOf = async (t) => {
  const { rows } = await q(
    `select column_name from information_schema.columns where table_name = '${t}' order by column_name`
  );
  return (rows || []).map((r) => r.column_name);
};
const commentsCols = await colsOf('todo_comments');
const likesCols = await colsOf('comment_likes');
const wantComments = ['author_id', 'content', 'created_at', 'deleted_at', 'edited_at', 'id', 'parent_id', 'todo_id'];
const wantLikes = ['comment_id', 'created_at', 'id', 'user_id'];
check(
  wantComments.every((c) => commentsCols.includes(c)) && commentsCols.length === wantComments.length,
  `todo_comments 列齐全（${commentsCols.join(', ')}）`
);
check(
  wantLikes.every((c) => likesCols.includes(c)) && likesCols.length === wantLikes.length,
  `comment_likes 列齐全（${likesCols.join(', ')}）`
);

const rlsOf = async (t) => {
  const { rows } = await q(`select relrowsecurity from pg_class where relname = '${t}'`);
  return rows && rows[0] && rows[0].relrowsecurity;
};
check(await rlsOf('todo_comments'), 'todo_comments 已启用 RLS');
check(await rlsOf('comment_likes'), 'comment_likes 已启用 RLS');

const policies = async (t) => {
  const { rows } = await q(
    `select policyname, cmd, qual, with_check from pg_policies where tablename = '${t}' order by policyname`
  );
  return rows || [];
};
const cPol = await policies('todo_comments');
const lPol = await policies('comment_likes');
check(cPol.length === 4, `todo_comments 四条策略（实际 ${cPol.length}）`);
check(lPol.length === 3, `comment_likes 三条策略（实际 ${lPol.length}）`);
const normSql = (s) => String(s || '').replace(/\s+/g, ' ').toLowerCase();
const insPolicy = cPol.find((p) => p.cmd === 'INSERT');
const updPolicy = cPol.find((p) => p.cmd === 'UPDATE');
const delPolicy = cPol.find((p) => p.cmd === 'DELETE');
check(
  normSql(insPolicy && insPolicy.with_check).includes('author_id = auth.uid()'),
  'INSERT 策略：只能以自己的身份插入（author_id = auth.uid()）'
);
check(
  normSql(updPolicy && updPolicy.qual).includes('author_id = auth.uid()') &&
    normSql(updPolicy.with_check).includes('author_id = auth.uid()'),
  'UPDATE 策略：只能改自己的行（USING 与 WITH CHECK 双收紧）'
);
check(
  normSql(delPolicy && delPolicy.qual).includes('author_id = auth.uid()'),
  'DELETE 策略：只能删自己的行'
);

const pubTables = async () => {
  const { rows } = await q(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`);
  return (rows || []).map((r) => r.tablename);
};
const pub = await pubTables();
check(pub.includes('todo_comments') && pub.includes('comment_likes'), '两张表都进了 supabase_realtime 发布');

const migratedRes = await q(
  `select todo_id, author_id, content, created_at, parent_id from todo_comments order by created_at`
);
const migrated = migratedRes.rows || [];
check(migrated.length === 1, `历史备注搬迁出 1 条留言（实际 ${migrated.length}${migratedRes.err ? `，查询失败：${migratedRes.err}` : ''}）`);
if (migrated.length === 1) {
  check(migrated[0].todo_id === TODO_ID, '搬迁到了正确的待办');
  check(migrated[0].author_id === PARTNER, '作者取完成人（completed_by）');
  check(migrated[0].content === '书房那只已经打死了', '内容去掉了首尾空白');
  check(migrated[0].parent_id === null, '搬迁出来的是主留言（parent_id 为空）');
}

const trig = await q(`select tgrelid::regclass::text as t, tgdeferrable from pg_trigger where tgname like '%replica%'`);
check(!trig.err, 'REPLICA IDENTITY 语句可执行（无语法/权限问题）');

// ============================================================
// ③ 幂等：整份文件再跑一遍
// ============================================================
console.log('\n=== ③ 幂等：整个迁移再跑一遍 ===');
let second = { err: null };
try {
  await db.exec(MIGRATION);
} catch (e) {
  second.err = e.message;
}
check(!second.err, `迁移第二遍执行成功${second.err ? `（失败：${second.err}）` : ''}（重复 ADD TABLE 报 already member 是历史踩坑）`);
const { rows: afterSecond } = await q(`select count(*)::int as n from todo_comments`);
check(afterSecond[0].n === 1, `第二遍没有重复搬迁（仍是 1 条，实际 ${afterSecond[0].n}）`);
const { rows: polAfter } = await q(`select count(*)::int as n from pg_policies where tablename = 'todo_comments'`);
check(polAfter[0].n === 4, `第二遍策略没有翻倍（仍是 4 条，实际 ${polAfter[0].n}）`);

// ============================================================
// ② 行为：RLS 真的拦得住越权写
// ============================================================
console.log('\n=== ② 行为：authenticated 只能动自己的行 ===');
await db.exec(`grant usage on schema public to authenticated; grant all on all tables in schema public to authenticated;`);

const mineInsert = await asRole(
  'authenticated',
  `insert into todo_comments (todo_id, author_id, content) values ('${TODO_ID}', '${ME}', '我的留言') returning id`
);
check(!mineInsert.err && (mineInsert.rows || []).length === 1, '可以插入自己的留言');
const myCommentId = mineInsert.rows && mineInsert.rows[0] && mineInsert.rows[0].id;

const forgedInsert = await asRole(
  'authenticated',
  `insert into todo_comments (todo_id, author_id, content) values ('${TODO_ID}', '${PARTNER}', '冒充对方的留言')`
);
check(!!forgedInsert.err, `冒用对方 author_id 插入被拦下（${forgedInsert.err || '竟然成功了'}）`);

// 对方的一条留言（用 superuser 直接插，模拟历史数据）
await q(
  `insert into todo_comments (todo_id, author_id, content) values ('${TODO_ID}', '${PARTNER}', '对方的留言') returning id`
);
const partnerCommentId = (await q(
  `select id from todo_comments where author_id = '${PARTNER}' limit 1`
)).rows[0].id;

// ⚠️ 每条 UPDATE/DELETE 都带 returning：PGlite 的 rows 只反映 RETURNING 的结果，
//    不带 returning 时"影响 0 行"与"影响 N 行"看起来都一样 —— 断言会变成空转
const editOthers = await asRole(
  'authenticated',
  `update todo_comments set content = '被改掉' where id = '${partnerCommentId}' returning id`
);
check((editOthers.rows || []).length === 0, '改对方的留言：RLS 让该行不可见 → 影响 0 行');
const delOthers = await asRole(
  'authenticated',
  `delete from todo_comments where id = '${partnerCommentId}' returning id`
);
check((delOthers.rows || []).length === 0, '删对方的留言：影响 0 行');

const editMine = await asRole(
  'authenticated',
  `update todo_comments set content = '改过了', edited_at = now() where id = '${myCommentId}' returning id`
);
check((editMine.rows || []).length === 1, '改自己的留言：允许');
const softDeleteMine = await asRole(
  'authenticated',
  `update todo_comments set deleted_at = now() where id = '${myCommentId}' returning id`
);
check((softDeleteMine.rows || []).length === 1, '软删除自己的留言：允许（只打 deleted_at，铁律九）');

const likeMine = await asRole(
  'authenticated',
  `insert into comment_likes (comment_id, user_id) values ('${partnerCommentId}', '${ME}') returning id`
);
check(!likeMine.err && (likeMine.rows || []).length === 1, '可以贴自己的爱心');
const likeDuplicate = await asRole(
  'authenticated',
  `insert into comment_likes (comment_id, user_id) values ('${partnerCommentId}', '${ME}')`
);
check(/23505|duplicate/i.test(String(likeDuplicate.err || '')), '同一条重复贴爱心被 UNIQUE 拦下（幂等语义）');
const likeForged = await asRole(
  'authenticated',
  `insert into comment_likes (comment_id, user_id) values ('${partnerCommentId}', '${PARTNER}')`
);
check(!!likeForged.err, '冒用对方 user_id 贴爱心被拦下');

// ============================================================
// 收尾
// ============================================================
console.log('');
if (failed) {
  console.error(`✗ 留言板迁移测试失败：${failed} 项断言未通过`);
  process.exit(1);
}
console.log('✓ 留言板迁移测试全绿（结构 / 行为 / 幂等 / 搬迁）');
process.exit(0);
