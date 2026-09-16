/**
 * 函数权限加固迁移的回归测试（不需要任何 Supabase 凭据，可进 CI）
 *
 * 为什么要有它（2026-09-16）：这份迁移只有 4 段 SQL，但有一处极易写错且**写错了也"看起来成功"**：
 *   PostgreSQL 默认把函数 EXECUTE 授予 **PUBLIC**，所以
 *     `revoke execute ... from anon`          —— 空动作（anon 仍通过 PUBLIC 持有）
 *     `revoke execute ... from public, anon`  —— 真动作，但连 authenticated 一起掉了
 *   必须 `revoke ... from public, anon` **且** 补 `grant ... to authenticated`。
 * 这类"静默无效的安全加固"是最危险的：跑完没报错、界面一片绿，洞还在。
 * 所以这里用 PGlite（真 Postgres 的 WASM 版）把迁移真跑一遍并断言权限的实际状态。
 *
 * 三个断言组：
 *   ① anon 必须调不动那两个 RPC（`has_function_privilege` = false）
 *   ② authenticated 必须还调得动（否则 App 的光晕计数功能就废了 —— 收得太紧同样是 bug）
 *   ③ 触发器函数被 revoke 后，注册链路（往 auth.users 插一行）必须照常写 profiles
 *   另外：整份迁移必须幂等。
 *
 * 用法：node scripts/test_rpc_migration.mjs
 * 退出码：0 = 全绿；1 = 有断言失败
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 可选：传一个文件路径来验证"交付给用户的剥离注释版"与仓库文件等价（默认用仓库文件）
const MIGRATION_PATH = process.argv[2] || join(ROOT, 'supabase', 'migration-rpc-execute-hardening.sql');
const MIGRATION = readFileSync(MIGRATION_PATH, 'utf8');

let failed = 0;
const check = (cond, m) => {
  if (cond) console.log(`  ✓ ${m}`);
  else {
    failed++;
    console.error(`  ✗ ${m}`);
  }
};

const db = new PGlite();
const q = async (sql) => {
  try {
    return { rows: (await db.query(sql)).rows };
  } catch (e) {
    return { err: `${e.code || ''} ${String(e.message).split('\n')[0]}` };
  }
};
const asRole = async (role, sql) => {
  await db.exec(`set role ${role};`);
  const r = await q(sql);
  await db.exec('reset role;');
  return r;
};
/** 某个角色对某个函数是否有 EXECUTE（走真实 ACL 计算，含 PUBLIC 默认授权） */
const canExecute = async (role, sig) =>
  (await q(`select has_function_privilege('${role}', 'public.${sig}', 'execute') as ok`)).rows[0].ok;

console.log('\n=== 造一个「和出事环境同形」的库 ===');
// 复刻：schema.sql 的 handle_new_user + 两个计数 RPC，全部 SECURITY DEFINER，
// 且都处于 Supabase/PostgreSQL 的**默认权限**（EXECUTE 通过 PUBLIC 对所有人开放）
await db.exec(`
create schema auth;
create table auth.users (id uuid primary key, email text);
create table public.profiles (
  id uuid primary key references auth.users(id),
  username text unique not null,
  display_name text not null,
  login_count_for_partner int not null default 0
);

create function public.handle_new_user() returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, username, display_name)
  values (new.id, split_part(new.email,'@',1), split_part(new.email,'@',1));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.increment_login_count(target_uid uuid) returns void
  language plpgsql security definer as $$
begin
  update public.profiles set login_count_for_partner = login_count_for_partner + 1 where id = target_uid;
end $$;

create function public.consume_login_count(target_uid uuid) returns int
  language plpgsql security definer as $$
declare consumed int;
begin
  select login_count_for_partner into consumed from public.profiles where id = target_uid;
  if consumed is null then return 0; end if;
  update public.profiles set login_count_for_partner = 0 where id = target_uid;
  return consumed;
end $$;

create role anon;
create role authenticated;
create role service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant insert on auth.users to service_role;
`);
await db.exec(`insert into auth.users values ('11111111-1111-1111-1111-111111111111','a@todo.local')`);
await db.exec(`update public.profiles set login_count_for_partner = 7 where id = '11111111-1111-1111-1111-111111111111'`);

console.log('\n--- 修复前：复现「未登录可调」---');
check(await canExecute('anon', 'increment_login_count(uuid)'), 'anon 可执行 increment_login_count()（洞成立）');
check(await canExecute('anon', 'consume_login_count(uuid)'), 'anon 可执行 consume_login_count()（洞成立）');
check(await canExecute('anon', 'handle_new_user()'), 'anon 可执行 handle_new_user()（默认权限，非漏洞但想让审计列恒为 false）');

console.log('\n--- 执行迁移 ---');
await db.exec(MIGRATION);

console.log('\n--- 修复后 ---');
check(!(await canExecute('anon', 'increment_login_count(uuid)')), 'anon 已不能执行 increment_login_count()');
check(!(await canExecute('anon', 'consume_login_count(uuid)')), 'anon 已不能执行 consume_login_count()');
check(!(await canExecute('anon', 'handle_new_user()')), 'anon 已不能执行 handle_new_user()');
check(await canExecute('authenticated', 'increment_login_count(uuid)'), 'authenticated 仍可执行 increment_login_count()（App 要用）');
check(await canExecute('authenticated', 'consume_login_count(uuid)'), 'authenticated 仍可执行 consume_login_count()（App 要用）');

// 关键回归：revoke handle_new_user 之后，注册链路（非超级用户插 auth.users）必须照常触发
const ins = await asRole('service_role', `insert into auth.users values ('22222222-2222-2222-2222-222222222222','b@todo.local')`);
check(!ins.err, `非超级用户插入 auth.users 仍成功：${ins.err || 'ok'}`);
const rows = (await q(`select count(*)::int as n from public.profiles`)).rows[0].n;
check(rows === 2, `profiles 行数 = ${rows}（触发器照常写入，注册链路没被弄坏）`);

// 计数器功能本身仍可用（authenticated 真调一次，且确实改了值）
const before = (await q(`select login_count_for_partner as n from public.profiles where id = '11111111-1111-1111-1111-111111111111'`)).rows[0].n;
const called = await asRole('authenticated', `select public.increment_login_count('11111111-1111-1111-1111-111111111111')`);
const after = (await q(`select login_count_for_partner as n from public.profiles where id = '11111111-1111-1111-1111-111111111111'`)).rows[0].n;
check(!called.err && before === 7 && after === 8, `authenticated 调用生效：${before} → ${after}`);

// anon 真调一次必须被拒（与 has_function_privilege 互补：一个查 ACL，一个真打）
const anonCall = await asRole('anon', `select public.increment_login_count('11111111-1111-1111-1111-111111111111')`);
check(/42501|permission denied/i.test(anonCall.err || ''), `anon 真调被拒：${anonCall.err || '(竟然成功)'}`);

console.log('\n--- 幂等：再跑一次 ---');
await db.exec(MIGRATION);
check(!(await canExecute('anon', 'increment_login_count(uuid)')), '第二次执行后 anon 依然不可执行');
check(await canExecute('authenticated', 'increment_login_count(uuid)'), '第二次执行后 authenticated 依然可执行');
const after2 = (await q(`select count(*)::int as n from public.profiles`)).rows[0].n;
check(after2 === 2, `第二次执行没有副作用（profiles 仍 ${after2} 行）`);

console.log(failed ? `\n✗ ${failed} 项失败\n` : '\n✅ 函数权限加固迁移通过：anon 收干净、App 不受影响、注册链路完好、幂等\n');
process.exit(failed ? 1 : 0);
