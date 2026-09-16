/**
 * RLS 加固迁移的回归测试（不需要任何 Supabase 凭据，可进 CI）
 *
 * 为什么要有它（2026-09-16，测试项目被报 `rls_disabled_in_public` 之后）：
 *   一个「修复安全漏洞的 SQL 文件」如果没人跑过，它只是**一段看起来对的文本**：
 *   SQL Editor 里中途报错会整体回滚（洞还在，但你可能以为修好了）；
 *   策略写反了（例如把 `to authenticated` 写成对 PUBLIC 开放）会让「修复」
 *   变成另一个洞。这两类都不是"审一遍代码"能可靠发现的。
 *
 * 做法（两层，都在本地、都不连任何 Supabase 项目 —— 铁律一）：
 *   ① 静态一致性：迁移文件里的每条策略，必须与仓库其它 SQL（schema.sql /
 *      migration-blindbox-stickers.sql / …）逐字一致；只允许一处**显式登记**的有意更名。
 *      作用：防止「迁移悄悄和 schema.sql 走散」——那是下次事故的种子。
 *   ② 行为验证：用 PGlite（真 Postgres 编译成 WASM）造一个「和出事环境同形」的库
 *      （profiles 的 RLS 关闭 + 旧的过宽策略），把迁移**真跑一遍**，断言：
 *      洞被复现 → 修复后 anon 读不到、写被 42501 拦下 → 登录用户仍可读 → 再跑一次幂等。
 *
 * 用法：node scripts/test_rls_migration.mjs
 * 退出码：0 = 全绿；1 = 有断言失败或一致性漂移
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_PATH = join(ROOT, 'supabase', 'migration-rls-hardening.sql');
const MIGRATION = readFileSync(MIGRATION_PATH, 'utf8');

let failed = 0;
const check = (cond, m) => {
  if (cond) console.log(`  ✓ ${m}`);
  else {
    failed++;
    console.error(`  ✗ ${m}`);
  }
};

/** 归一化：折叠空白、去掉 public. 前缀、统一小写（只比语义，不比排版） */
const norm = (s) => s.replace(/\s+/g, ' ').replace(/\bpublic\./gi, '').trim().toLowerCase();

/** 从一段 SQL 里抽出所有 create policy 语句（按名字索引） */
function extractPolicies(text) {
  const out = new Map();
  const re = /create\s+policy\s+"([^"]+)"[\s\S]*?(?=;|\$sql\$\s*;?|$)/gi;
  for (const m of text.matchAll(re)) out.set(m[1].toLowerCase(), norm(m[0]));
  return out;
}

// ============================================================
// ① 静态一致性：迁移的策略必须与仓库 SQL 对得上
// ============================================================
console.log('\n=== ① 与仓库 SQL 的一致性 ===');

const repoSqlFiles = [
  ...readdirSync(join(ROOT, 'supabase')).filter((f) => f.endsWith('.sql')).map((f) => join('supabase', f)),
  'migration-app-native-versions.sql',
];
const repoPolicies = new Map();
for (const rel of repoSqlFiles) {
  if (rel.endsWith('migration-rls-hardening.sql')) continue; // 自己不比
  for (const [name, stmt] of extractPolicies(readFileSync(join(ROOT, rel), 'utf8'))) {
    if (!repoPolicies.has(name)) repoPolicies.set(name, stmt);
  }
}
const migrationPolicies = extractPolicies(MIGRATION);

/**
 * 一致性规则：迁移里的策略 ↔ 仓库 SQL 里的策略，**双向逐字相等**（只比语义不比排版）。
 *
 * 为什么不留"有意更名"的白名单：本次那处更名（`profiles_select_all` → `profiles_select_auth`，
 * 从对 PUBLIC 开放收紧为 authenticated）已经**同步改进 supabase/schema.sql**，
 * 所以两边现在应当直接一致。留白名单等于给自己开一个"以后可以悄悄改名"的口子，
 * 而这条检查的价值恰恰在于：任何不一致都必须被看见。
 */
for (const [name, stmt] of migrationPolicies) {
  const repoStmt = repoPolicies.get(name);
  if (!repoStmt) {
    check(false, `迁移里的策略「${name}」在仓库其它 SQL 里找不到来源（新策略要同步写进 schema.sql，否则下次重置就丢了）`);
  } else {
    check(repoStmt === stmt, `策略「${name}」与仓库 SQL 逐字一致`);
  }
}

// 反向：本迁移**负责的 5 张业务表**上，仓库声明过的策略一条都不能漏
// （否则迁移跑完仍是缺策略的状态）。注意范围：storage.objects / app_versions 等
// 由各自的迁移负责，不归本文件管 —— 把它算进来是误报，会让这条检查失去意义。
const OWNED_TABLES = new Set(['profiles', 'todos', 'daily_notes', 'reactions', 'stickers']);
const tableOf = (stmt) => (stmt.match(/on ([a-z_][a-z0-9_]*)/) || [])[1];
for (const [name, stmt] of repoPolicies) {
  if (!OWNED_TABLES.has(tableOf(stmt))) continue;
  check(migrationPolicies.has(name), `仓库 SQL 里的策略「${name}」迁移里也有`);
}

// 收紧点必须真的是收紧
check(
  migrationPolicies.has('profiles_select_auth') &&
    /to authenticated using \(true\)/.test(migrationPolicies.get('profiles_select_auth')),
  'profiles 的 SELECT 策略明确限定为 authenticated（不是又留成对 PUBLIC 开放）'
);
check(
  !/create\s+policy\s+"profiles_select_all"/i.test(MIGRATION),
  '迁移里没有任何地方**新建**旧的过宽策略（只允许 drop）'
);

// ============================================================
// ② 行为验证：在真 Postgres（WASM）里跑一遍
// ============================================================
console.log('\n=== ② 在隔离 Postgres 上真跑一遍（PGlite） ===');

const db = new PGlite();
/** 单条语句：失败只回错误码（PGlite 默认会把整个 bundle 打到 stderr） */
const q = async (sql) => {
  try {
    const r = await db.query(sql);
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
const GHOST = '00000000-0000-0000-0000-0000000000de';

// 造「与出事环境同形」的库：profiles 的 RLS 关闭 + 旧过宽策略；其余表正常。
// 并按 Supabase 的默认授权把表权限给 anon/authenticated —— 否则
// permission denied 会先于 RLS 生效，测出来的就不是策略行为。
await db.exec(`
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as 'select null::uuid';
create role anon;
create role authenticated;

create table profiles (
  id uuid primary key references auth.users(id),
  username text unique not null,
  display_name text not null,
  last_seen_at timestamptz,
  login_count_for_partner int not null default 0
);
create table todos (
  id uuid primary key default gen_random_uuid(),
  text text not null check (char_length(text) <= 200),
  created_by uuid not null references auth.users(id)
);
alter table todos enable row level security;
create table daily_notes (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id),
  content text not null
);
alter table daily_notes enable row level security;
create table reactions (
  id uuid primary key default gen_random_uuid(),
  todo_id uuid not null references todos(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  emoji text not null check (char_length(emoji) <= 10)
);
alter table reactions enable row level security;
create table stickers (
  id uuid primary key default gen_random_uuid(),
  sticker_key text unique not null,
  rarity text not null check (rarity in ('rare','epic','legendary')),
  unlocked_by uuid not null references auth.users(id)
);
alter table stickers enable row level security;
`);

// 业务表的策略：直接抄仓库 SQL（顺带验证「迁移后策略集合不变」）
for (const name of [
  'todos_select_auth', 'todos_insert_auth', 'todos_update_auth', 'todos_delete_auth',
  'daily_notes_select_auth', 'daily_notes_insert_auth', 'daily_notes_update_auth', 'daily_notes_delete_auth',
  'reactions_select_auth', 'reactions_insert_auth', 'reactions_delete_auth',
  'stickers_select_auth', 'stickers_insert_auth', 'stickers_update_auth', 'stickers_delete_auth',
]) {
  await db.exec(repoPolicies.get(name) + ';');
}
// profiles 的**出事状态**：RLS 没开 + 旧的三条策略（含对 PUBLIC 开放的 SELECT）
await db.exec(`
create policy "profiles_select_all"  on profiles for select using (true);
create policy "profiles_insert_self" on profiles for insert with check (auth.uid() = id);
create policy "profiles_update_self" on profiles for update using (auth.uid() = id);
grant usage on schema public to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
insert into auth.users values ('11111111-1111-1111-1111-111111111111');
insert into profiles (id, username, display_name)
  values ('11111111-1111-1111-1111-111111111111', 'xiaobaobao', '小宝宝');
`);

const state = async () => {
  const { rows } = await q(`
    select c.relname as t, c.relrowsecurity as rls,
           coalesce((select string_agg(p.policyname, ',' order by p.policyname)
                       from pg_policies p
                      where p.schemaname = 'public' and p.tablename = c.relname), '—') as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and c.relname in ('profiles','todos','daily_notes','reactions','stickers')
     order by c.relname`);
  return Object.fromEntries(rows.map((r) => [r.t, { rls: r.rls, policies: r.policies }]));
};
const anonReadProfiles = async () => (await asRole('anon', 'select count(*)::int as n from profiles')).rows?.[0]?.n;
const anonWriteProfiles = () =>
  asRole('anon', `insert into profiles (id, username, display_name) values ('${GHOST}', 'probe', 'probe')`);

console.log('\n--- 修复前：先证明洞是真的（不然这个测试可能什么也没测）---');
const before = await state();
check(before.profiles.rls === false, `profiles 的 RLS = false（复现出事的配置）`);
check((await anonReadProfiles()) === 1, 'anon 读 profiles 能拿到 1 行 ⇒ 未登录可见（洞成立）');
const bWrite = await anonWriteProfiles();
check(bWrite?.err === '23503', `anon 写 profiles 撞到的是外键约束(${bWrite?.err})而不是策略 ⇒ 可写（洞成立）`);

console.log('\n--- 执行迁移 ---');
await db.exec(MIGRATION);

console.log('\n--- 修复后 ---');
const after = await state();
check(after.profiles.rls === true, 'profiles 的 RLS 已开启');
check(!after.profiles.policies.includes('profiles_select_all'), '旧的过宽策略 profiles_select_all 已删除');
check(after.profiles.policies === 'profiles_insert_self,profiles_select_auth,profiles_update_self', `profiles 策略 = ${after.profiles.policies}`);
check(
  after.todos.policies === before.todos.policies &&
    after.daily_notes.policies === before.daily_notes.policies &&
    after.reactions.policies === before.reactions.policies &&
    after.stickers.policies === before.stickers.policies,
  '其余 4 张表的策略集合未变（只堵洞，不乱动）'
);
check((await anonReadProfiles()) === 0, 'anon 读 profiles = 0 行（已堵住）');
const aWrite = await anonWriteProfiles();
check(aWrite?.err === '42501', `anon 写 profiles 被策略拦下（42501），实际：${aWrite?.err}`);
check(
  (await asRole('authenticated', 'select count(*)::int as n from profiles')).rows?.[0]?.n === 1,
  'authenticated 读 profiles 仍为 1 行 ⇒ App 的 listProfiles() 不受影响'
);

console.log('\n--- 幂等：再跑一次 ---');
await db.exec(MIGRATION);
check(JSON.stringify(await state()) === JSON.stringify(after), '第二次执行后状态与第一次完全一致');
check((await anonReadProfiles()) === 0, '第二次执行后 anon 依然读不到（没有把洞弄回来）');

console.log(failed ? `\n✗ ${failed} 项失败\n` : '\n✅ RLS 加固迁移通过：与仓库 SQL 一致 + 在真实 Postgres 上有效且幂等\n');
process.exit(failed ? 1 : 0);
