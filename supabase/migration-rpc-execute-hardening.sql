-- ============================================================
-- 函数执行权限加固：把「未登录就能调 RPC」这类洞堵死（幂等，可重复执行）
--
-- 执行位置：目标项目 → Supabase Dashboard → SQL Editor → 全选粘贴 → Run
--   · 测试项目 loveListTest：**已执行（2026-09-16）**
--   · 生产项目：**已执行（2026-09-16）**
--   两边的回读结果与独立复验见文件末尾「执行记录」
--
-- ------------------------------------------------------------
-- 起因（2026-09-16，从 RLS 漏洞顺线索查出来的同类问题）
--
--   PostgreSQL 默认把函数的 EXECUTE 授予 **PUBLIC**（不是"什么都没有"）。
--   Supabase 建表/建函数后并不会自动收紧这一点，于是 public schema 里每个
--   SECURITY DEFINER 函数默认都是「拿到公开 anon key 的任何人可调用」。
--   本项目的三个函数都踩在这条默认上：
--
--   | 函数 | security_definer | anon 可执行 | 危害 |
--   |---|---|---|---|
--   | `create_test_user(email,password,username,display_name)` | true | **true** | 任何人可建账号；在本项目 RLS 模型下「有账号」≈「能读写全部数据」。**测试项目已删除**（见下），生产从未存在过 |
--   | `increment_login_count(uuid)` | true | **true** | 未登录即可 `UPDATE profiles`：给对方的打开计数刷数字 |
--   | `consume_login_count(uuid)` | true | **true** | 未登录即可把对方的打开计数清零 |
--
--   实测证据（测试项目，anon key，参数用「必然不存在的 UUID」⇒ 零行受影响）：
--     increment_login_count → HTTP 204（执行成功）
--     consume_login_count   → HTTP 200 返回 0
--     调用前后 `profiles.login_count_for_partner` 为 8 / 0，一字未变（探针没写数据）
--
--   ⚠️ 反向澄清一条容易误信的写法：**只 revoke anon 是没用的**。
--     函数 EXECUTE 来自 PUBLIC，`revoke ... from anon` 只是删掉 anon 自己的那条记录，
--     anon 仍然通过 PUBLIC 拿到权限。PGlite（真 Postgres）实测：
--       默认状态                anon 可执行 = true
--       revoke ... from anon    anon 可执行 = **true**（白做）
--       revoke ... from public, anon, authenticated → anon = false（同时 authenticated 也掉了）
--       再显式 grant 给目标角色 → 目标角色 = true
--     ⇒ 必须带 `public`，并且**必须补 grant**，否则 App 自己也调不了。
--     （`supabase/test-db-schema-sync.sql` 里只有 `GRANT EXECUTE ... TO authenticated`，
--       它并不移除 PUBLIC 的默认授权 —— 看着像加固，其实没堵上。）
--
-- ------------------------------------------------------------
-- 本文件做三件事（全部幂等）
--   1. 诊断：打印 public schema 每个函数的 anon/authenticated 可执行性与 ACL
--   2. 修复：App 的两个 RPC 收回 PUBLIC/anon，只留给 authenticated + service_role
--   3. 顺手：触发器函数 handle_new_user 也收回（让「anon 可执行」这一列恒为 false，
--      以后审计时凡 true 必是问题）
-- ============================================================


-- ============================================================
-- 1. 诊断：谁现在能被未登录的人调用（结果在 SQL Editor 的结果网格里）
-- ============================================================
select p.oid::regprocedure                                      as "函数",
       p.prosecdef                                              as "security_definer",
       has_function_privilege('anon', p.oid, 'execute')          as "anon_可执行",
       has_function_privilege('authenticated', p.oid, 'execute') as "登录用户_可执行",
       coalesce(array_to_string(p.proacl, ' | '), '(未设置 ACL → 默认 PUBLIC 可执行)') as "acl"
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
 order by 3 desc, 1;


-- ============================================================
-- 2. App 的两个 RPC：只允许登录用户与 service_role
--
--    为什么可以收这么紧：两个调用点都在**登录之后**
--      · increment_login_count ← app.js:368（`db.incrementLoginCount(currentUser.id)`，此时
--        已通过 getCurrentUser()，未登录会在前面就跳 login.html 并 return）
--      · consume_login_count   ← db.js:348（爱心光晕，partnerId 存在时才调）
--    ⇒ 收紧后 App 行为不变，而「未登录写生产数据」这条路没了。
-- ============================================================
do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('increment_login_count', 'consume_login_count')
     order by p.proname
  loop
    -- 必须带 public（默认授权在 PUBLIC 上，只 revoke anon 是空动作）
    execute format('revoke execute on function %s from public, anon', r.sig);
    -- 必须补回目标角色，否则 App 自己也没权限了
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
    n := n + 1;
    raise notice '[函数加固] 已收紧 %：仅 authenticated / service_role 可执行', r.sig;
  end loop;

  if n = 0 then
    raise warning '[函数加固] 没找到 increment_login_count / consume_login_count —— 本项目可能还没建这两个函数';
  end if;
end $$;


-- ============================================================
-- 3. handle_new_user()：触发器函数，同样收回 PUBLIC/anon
--
--    先说清楚它**不是**漏洞，别被 `anon 可执行 = true` 吓到：
--      · 它 `RETURNS trigger` —— 直接调用会被数据库拒绝，实测报
--        `0A000 trigger functions can only be called as triggers`；
--      · PostgREST 也不暴露返回 trigger 的函数（读 OpenAPI 的 /rpc/ 清单里没有它）。
--
--    那为什么还要动它？两个理由：
--      ① 让「anon 可执行」这一列**恒为 false**：以后审计时，凡出现 true 就一定是问题，
--         不需要每次重新判断"这个 true 是不是无害的"；
--      ② 它现在返回 true 只是因为默认权限，没有任何业务需要它。
--
--    ⚠️ 会不会把注册链路弄坏？不会 —— PGlite（真 Postgres）实测：以**非超级用户**
--      向 auth.users 插入（模拟 GoTrue 建账号），revoke 前后触发器都照常写入 profiles。
--      触发器是否触发不取决于调用者对新函数是否有 EXECUTE 权限。
-- ============================================================
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'handle_new_user'
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
    raise notice '[函数加固] 已收紧 %（触发器函数，无法被直接调用，收权限只为让审计列恒为 false）', r.sig;
  end loop;
end $$;


-- ============================================================
-- 4. 回读校验：期望每行「anon_可执行 = false」
--    「登录用户_可执行」对两个 RPC 应为 true（App 要用），对 handle_new_user 无所谓
-- ============================================================
select p.oid::regprocedure                                      as "函数",
       has_function_privilege('anon', p.oid, 'execute')          as "anon_可执行",
       has_function_privilege('authenticated', p.oid, 'execute') as "登录用户_可执行",
       coalesce(array_to_string(p.proacl, ' | '), '(默认 PUBLIC)') as "acl"
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
 order by 2 desc, 1;


-- ============================================================
-- 执行记录（2026-09-16，测试项目与生产项目**都执行了**本文件）
--
--   · 审计来源：从 RLS 告警顺线索查出来的同类问题（都是「默认权限 + 手工改过、没人回读」）
--   · 测试项目：`create_test_user` 已删除（本文件不负责删除，它是 ad-hoc 调试函数、
--     仓库与 git 全历史都查不到；仓库任何代码都没引用它 ⇒ 直接 DROP 无副作用）。
--     删除后 PostgREST 暴露面只剩已登记的两个 RPC，`check-rls.mjs` 的白名单核对可以守住这条。
--   · 生产项目：不存在 `create_test_user`；其余三个函数的 `anon_可执行` 原为 true。
--
--   · 执行结果（两个项目一致，回读最后那条 SELECT）：
--       | 函数                        | anon_可执行 | 登录用户_可执行 |
--       | handle_new_user()           | false       | true            |
--       | increment_login_count(uuid) | false       | true            |
--       | consume_login_count(uuid)   | false       | true            |
--     ACL 由 `=X/postgres | postgres=X/postgres | anon=X/postgres | authenticated=X/postgres`
--     变为 `postgres=X/postgres | authenticated=X/postgres | service_role=X/postgres`
--     —— 开头的 `=X/postgres`（PUBLIC）与 `anon=` 两条**都消失**了，这才是"真收干净"的准确形态；
--     若只 revoke anon，ACL 里会仍留着 `=X/postgres`，anon 照旧可调（本文件头部有实测记录）。
--
--   · 独立复验（不看回读表格，而是重新用 anon 打一遍测试项目）：
--     `node app-e2e/scripts/check-rls.mjs` → 9 项全绿、退出码 0：
--       5 张表的 RLS + anon 读 profiles 0 行 + 两个 RPC 均 42501 + 暴露面白名单仅 2 个已登记函数。
--     生产侧刻意**没有**用探针复验：那个调用形式上是个写请求，铁律一不允许拿生产做验证；
--     生产只看只读的审计查询（上表）。
--
--   · 与 `migration-rls-hardening.sql` 的关系：那个管**表**（RLS 开关 + 策略），
--     本文件管**函数**（EXECUTE 权限）。两件事必须都做，缺任一个「未登录」都还有路可走：
--     表收紧后 anon 读不到任何 UUID，但 `increment_login_count` 依然可调（只是打不到具体行）。
--   · 为什么这次也要机器判定：`create_test_user` 是靠人工翻函数清单才发现的。
--     `app-e2e/scripts/check-rls.mjs` 现已增加「anon 调 RPC 必须被拒」+「暴露面白名单」两条断言，
--     并由 `admin/scripts/init-test-env.mjs` 第 ④ 步带入 CI required job。
-- ============================================================
