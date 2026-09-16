-- ============================================================
-- RLS 加固：把「表对全体公开」这类洞一次性堵死（幂等，可重复执行）
--
-- 执行位置：目标项目 → Supabase Dashboard → SQL Editor → 全选粘贴 → Run
--   · 测试项目 loveListTest：**必须执行**（2026-09-16 安全顾问告警就在这里）
--   · 生产项目：建议执行（幂等；对本项目的实际影响见文件末尾「预期影响」）
--
-- ------------------------------------------------------------
-- 背景（2026-09-16，来自 Supabase 安全顾问告警）
--
--   测试项目 loveListTest 被报 CRITICAL：`rls_disabled_in_public`
--   「Anyone with your project URL can read, edit, and delete all data in this table
--     because Row-Level Security is not enabled.」
--
-- ------------------------------------------------------------
-- 定位过程（可复现：`node app-e2e/scripts/check-rls.mjs`）
--
--   用 anon key（不带任何登录态 = 「拿到项目 URL 的任何人」）对每张表发一个
--   **必然违反外键**的 INSERT，看回的是什么错：
--     · 42501 `new row violates row-level security policy` → 策略在干活 ✅
--     · 23503 / 23505 等**约束错误** → 请求已经穿过策略层，说明 RLS 没开 🔴
--   （探针为什么安全：payload 的外键/主键必然不存在，RLS 开没开都不会落行。）
--
--   实测结果：
--     todos / daily_notes / reactions / stickers → 42501（正常）
--     profiles                                   → 23503（外键冲突）= RLS 未生效 ← 就是它
--
-- ------------------------------------------------------------
-- 这不是「仓库漏写」——别把根因记错
--
--   supabase/schema.sql 里 profiles 一直写着 `ENABLE ROW LEVEL SECURITY`。
--   是**测试项目上被手工改过，且没有任何回读校验**：同一时期那个测试项目里还留着
--   一个仓库里根本不存在的 `create_test_user` RPC（`git log --all -S` 查无此词），
--   可佐证 9/9–9/13 调试 E2E 时在 SQL Editor 里跑过 ad-hoc SQL。
--   ⇒ 结构性对策 = 新增 `app-e2e/scripts/check-rls.mjs`，把「RLS 真的开着」变成机器判定
--     （preflight + CI 里跑），而不是靠"我记得没关过"。
--
--   ⚠️ 反向教训同样重要：生产的 `disable_signup` 是 true、测试项目是 false
--     —— 两份环境的手工配置会各自漂移，所以**每次都要回读校验**，不能只看某一次。
--
-- ------------------------------------------------------------
-- 本文件做三件事（全部幂等）
--   1. 诊断：打印修复前 RLS 关闭的表（结果出现在 SQL Editor 的 Notices 里）
--   2. 修复：给 public schema 下所有 RLS 关闭的表开启 RLS
--   3. 兜底：把 5 张业务表的策略重建为**与 supabase/schema.sql 一致**（含 profiles 收紧）
--
-- 写法约定：每段都用 `to_regclass` 守卫 + IF/ELSE，**刻意不用 RETURN / CONTINUE**
--   （DO 块里这两个控制流的可用性容易记错，而一旦报错，SQL Editor 里整份脚本会一起回滚）。
-- ============================================================


-- ============================================================
-- 1. 修复前诊断（看 Notices：本次预期会打印 profiles）
-- ============================================================
do $$
declare
  r    record;
  off  text[] := '{}';
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')   -- 普通表 / 分区表
       and not c.relispartition      -- 分区本身不单独管 RLS
       and not c.relrowsecurity      -- RLS 关闭 = 公网可读可写
     order by c.relname
  loop
    off := off || r.relname;
  end loop;

  if array_length(off, 1) is null then
    raise notice '[RLS 加固] 修复前诊断：public schema 下没有 RLS 关闭的表';
  else
    raise notice '[RLS 加固] 修复前诊断：以下表 RLS 未开启（=公网可读可写）→ %', array_to_string(off, ', ');
  end if;
end $$;


-- ============================================================
-- 2. 全量开启 RLS（已开启的表不动 —— 只堵洞，不改行为）
-- ============================================================
do $$
declare
  r        record;
  n_fixed  int := 0;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and not c.relispartition
       and not c.relrowsecurity
     order by c.relname
  loop
    execute format('alter table public.%I enable row level security', r.relname);
    n_fixed := n_fixed + 1;

    -- 开了 RLS 却一条 policy 都没有 → 该表除 service_role 外彻底不可访问。
    -- 对本项目是安全的（业务表在第 3 段显式建了 policy），但必须喊出来，
    -- 免得「修好一个洞」变成「悄悄弄坏一张表」。
    if not exists (
      select 1 from pg_policies p
       where p.schemaname = 'public' and p.tablename = r.relname
    ) then
      raise warning '[RLS 加固] public.% 开启了 RLS 但没有任何 policy → 除 service_role 外将无法访问，请确认这是预期的', r.relname;
    end if;
  end loop;

  raise notice '[RLS 加固] 第 2 步：本次新开启 RLS 的表数量 = %', n_fixed;
end $$;


-- ============================================================
-- 3. 业务表策略兜底（与 supabase/schema.sql 逐条对齐）
--
--    为什么还要重建一遍：RLS 开关和策略是两件事。开关打开、策略却缺失或过宽，洞依然在
--    （例如 profiles 若无 SELECT 策略，登录后 listProfiles() 全空 → 待办不显示创建者）。
--    每张表都用 to_regclass 守卫：表不存在的项目不会被这条 SQL 打断
--    （SQL Editor 里中途报错会整体回滚 ⇒ 前面的修复也一起没了，所以守卫是必需的）。
-- ============================================================

-- ---------- 3.1 profiles：⚠️ 本次唯一的**行为收紧** ----------
-- 收紧点：原策略 `profiles_select_all` 没写 `TO ...`，等于对 PUBLIC（含未登录的 anon）开放。
--        而 anon key 是**公开**的（硬编码在 public/js/supabase.js，随 APK/网页分发）
--        ⇒ 任何人可列举两人的用户名/显示名/最后在线时间/打开计数。
--        现改为 `TO authenticated`。
-- 安全性核对：App 里读 profiles 只有 db.js 的 listProfiles()/updateLastSeen()，
--        都在**登录之后**调用（登录只做 username→伪邮箱映射，不查 profiles），
--        所以收紧不影响登录与启动。
do $$
begin
  if to_regclass('public.profiles') is null then
    raise warning '[RLS 加固] 跳过 profiles：表不存在';
  else
    execute 'alter table public.profiles enable row level security';

    -- 旧的过宽策略（对 PUBLIC/anon 开放）必须清掉，否则收紧无效
    execute 'drop policy if exists "profiles_select_all" on public.profiles';
    execute 'drop policy if exists "profiles_select_auth" on public.profiles';
    execute $sql$
      create policy "profiles_select_auth" on public.profiles
        for select to authenticated using (true)
    $sql$;

    execute 'drop policy if exists "profiles_insert_self" on public.profiles';
    execute $sql$
      create policy "profiles_insert_self" on public.profiles
        for insert to authenticated with check (auth.uid() = id)
    $sql$;

    execute 'drop policy if exists "profiles_update_self" on public.profiles';
    execute $sql$
      create policy "profiles_update_self" on public.profiles
        for update to authenticated using (auth.uid() = id)
    $sql$;

    -- 刻意**不建** DELETE 策略：手机端没有"删档案"功能，保持与现状一致（只有 service_role 能删）
    raise notice '[RLS 加固] profiles：RLS 已开启，SELECT 收紧为 authenticated';
  end if;
end $$;

-- ---------- 3.2 todos ----------
do $$
begin
  if to_regclass('public.todos') is null then
    raise warning '[RLS 加固] 跳过 todos：表不存在';
  else
    execute 'alter table public.todos enable row level security';

    execute 'drop policy if exists "todos_select_auth" on public.todos';
    execute $sql$
      create policy "todos_select_auth" on public.todos
        for select to authenticated using (true)
    $sql$;

    execute 'drop policy if exists "todos_insert_auth" on public.todos';
    execute $sql$
      create policy "todos_insert_auth" on public.todos
        for insert to authenticated with check (created_by = auth.uid())
    $sql$;

    execute 'drop policy if exists "todos_update_auth" on public.todos';
    execute $sql$
      create policy "todos_update_auth" on public.todos
        for update to authenticated using (true) with check (true)
    $sql$;

    execute 'drop policy if exists "todos_delete_auth" on public.todos';
    execute $sql$
      create policy "todos_delete_auth" on public.todos
        for delete to authenticated using (true)
    $sql$;

    raise notice '[RLS 加固] todos：RLS + 4 条策略已就位';
  end if;
end $$;

-- ---------- 3.3 daily_notes（心里话）----------
do $$
begin
  if to_regclass('public.daily_notes') is null then
    raise warning '[RLS 加固] 跳过 daily_notes：表不存在';
  else
    execute 'alter table public.daily_notes enable row level security';

    execute 'drop policy if exists "daily_notes_select_auth" on public.daily_notes';
    execute $sql$
      create policy "daily_notes_select_auth" on public.daily_notes
        for select to authenticated using (true)
    $sql$;

    execute 'drop policy if exists "daily_notes_insert_auth" on public.daily_notes';
    execute $sql$
      create policy "daily_notes_insert_auth" on public.daily_notes
        for insert to authenticated with check (author_id = auth.uid())
    $sql$;

    execute 'drop policy if exists "daily_notes_update_auth" on public.daily_notes';
    execute $sql$
      create policy "daily_notes_update_auth" on public.daily_notes
        for update to authenticated using (true) with check (true)
    $sql$;

    execute 'drop policy if exists "daily_notes_delete_auth" on public.daily_notes';
    execute $sql$
      create policy "daily_notes_delete_auth" on public.daily_notes
        for delete to authenticated using (true)
    $sql$;

    raise notice '[RLS 加固] daily_notes：RLS + 4 条策略已就位';
  end if;
end $$;

-- ---------- 3.4 reactions（爱心反应）----------
do $$
begin
  if to_regclass('public.reactions') is null then
    raise warning '[RLS 加固] 跳过 reactions：表不存在';
  else
    execute 'alter table public.reactions enable row level security';

    execute 'drop policy if exists "reactions_select_auth" on public.reactions';
    execute $sql$
      create policy "reactions_select_auth" on public.reactions
        for select to authenticated using (true)
    $sql$;

    execute 'drop policy if exists "reactions_insert_auth" on public.reactions';
    execute $sql$
      create policy "reactions_insert_auth" on public.reactions
        for insert to authenticated with check (user_id = auth.uid())
    $sql$;

    -- 刻意**不建** UPDATE 策略：反应只有"贴/取消"两种动作，与 schema.sql 一致
    execute 'drop policy if exists "reactions_delete_auth" on public.reactions';
    execute $sql$
      create policy "reactions_delete_auth" on public.reactions
        for delete to authenticated using (user_id = auth.uid())
    $sql$;

    raise notice '[RLS 加固] reactions：RLS + 3 条策略已就位';
  end if;
end $$;

-- ---------- 3.5 stickers（贴纸图鉴）----------
do $$
begin
  if to_regclass('public.stickers') is null then
    raise warning '[RLS 加固] 跳过 stickers：表不存在';
  else
    execute 'alter table public.stickers enable row level security';

    execute 'drop policy if exists "stickers_select_auth" on public.stickers';
    execute $sql$
      create policy "stickers_select_auth" on public.stickers
        for select to authenticated using (true)
    $sql$;

    execute 'drop policy if exists "stickers_insert_auth" on public.stickers';
    execute $sql$
      create policy "stickers_insert_auth" on public.stickers
        for insert to authenticated with check (unlocked_by = auth.uid())
    $sql$;

    execute 'drop policy if exists "stickers_update_auth" on public.stickers';
    execute $sql$
      create policy "stickers_update_auth" on public.stickers
        for update to authenticated using (true) with check (true)
    $sql$;

    execute 'drop policy if exists "stickers_delete_auth" on public.stickers';
    execute $sql$
      create policy "stickers_delete_auth" on public.stickers
        for delete to authenticated using (true)
    $sql$;

    raise notice '[RLS 加固] stickers：RLS + 4 条策略已就位';
  end if;
end $$;

-- ---------- 3.6 app_versions / app_native_versions（版本清单）----------
-- 这两张表在 migration-app-hot-update.sql / migration-app-native-versions.sql 里
-- 已声明为「登录用户只读、写仅 service_role」。这里只**确保 RLS 是开的**
-- （策略缺失时故意不补：补错方向会让客户端拿到不该有的写能力，见那两份迁移的注释）。
do $$
declare
  r record;
begin
  for r in
    select t.name
      from (values ('app_versions'), ('app_native_versions')) as t(name)
     where to_regclass('public.' || t.name) is not null
     order by t.name
  loop
    execute format('alter table public.%I enable row level security', r.name);

    if not exists (
      select 1 from pg_policies p
       where p.schemaname = 'public' and p.tablename = r.name
    ) then
      raise warning '[RLS 加固] public.% 没有 policy → 客户端将读不到版本信息；请执行对应的 migration 补策略', r.name;
    else
      raise notice '[RLS 加固] %：RLS 已确保开启', r.name;
    end if;
  end loop;
end $$;


-- ============================================================
-- 4. 回读校验（SQL Editor 会显示这一条 SELECT 的结果）
--    期望：每张业务表「RLS 已开启」= true，且 profiles 的「适用角色」里**没有 anon**
-- ============================================================
select c.relname                                  as "表名",
       c.relrowsecurity                           as "RLS 已开启",
       (select count(*)
          from pg_policies p
         where p.schemaname = 'public' and p.tablename = c.relname) as "策略数",
       coalesce((select string_agg(distinct p.roles::text, ', ')
                   from pg_policies p
                  where p.schemaname = 'public' and p.tablename = c.relname), '—') as "适用角色"
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind in ('r', 'p')
   and not c.relispartition
 order by c.relrowsecurity, c.relname;


-- ============================================================
-- 预期影响（跑之前先读）
--
-- 测试项目 loveListTest：
--   profiles 从「RLS 关闭」变成「RLS 开启 + 仅 authenticated 可读」。
--   对 E2E 无影响：测试脚本走 service_role / 登录后的会话，都不依赖 anon 读 profiles。
--
-- 生产项目：
--   ① 已在仓库 schema.sql 里声明过的表（profiles/todos/daily_notes/reactions）→ 策略重建后
--      与现状**逐字一致**，唯一变化是 profiles 的 SELECT 收紧为 authenticated。
--      已知消费方只有 `public/js/db.js` 的 listProfiles()/updateLastSeen()（都在登录后），
--      故对 App 无可见影响；但它**确实**改变了「未登录能否读 profiles」，属需知会的变化。
--   ② app_versions / app_native_versions → 只确保 RLS 开着，策略不动。
--   ③ 若本项目 public schema 下还有**别的不在仓库里**的表，而它恰好 RLS 关闭：
--      本脚本会把它开启，且因为没有任何 policy，它将变成「只有 service_role 能访问」。
--      第 1 步的 Notices 会先打印出这些表名 —— 如果你的库里真有这种表，先看清楚再 Run。
-- ============================================================
