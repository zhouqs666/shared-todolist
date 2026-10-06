-- ============================================================
-- 测试发版通道基线表（仅测试项目执行 —— 严禁在生产项目运行）
--
-- 执行方式：node scripts/apply-sql.mjs supabase/migration-test-release-channel.sql \
--             --project test --apply
--
-- 为什么存在：测试包（build-test-apk.mjs 产出，指向独立测试库）要支持自动热更新，
-- 但测试库此前**刻意不建热更新表**（当年的安全姿态 = 表不存在 → 无从热更）。
-- 有了 scripts/release-test.mjs / build-test-apk.mjs --publish 之后，通道有了
-- 发布侧的 fail-closed 内容护栏（zip 必须指向测试库），表可以安全地存在——
-- check-test-schema 的安全断言已同步改为「启用包必须指向测试库」。
--
-- 写入认证：与生产同构 —— release 脚本用 **测试项目的 service_role key**
-- （app-e2e/.env.test 的 E2E_SUPABASE_SERVICE_ROLE_KEY）绕过 RLS 写入；
-- 客户端（真机测试包）只有 authenticated 读权限，与生产行为一致。
--
-- 幂等：全部 IF NOT EXISTS / DROP POLICY IF EXISTS，可重复执行。
-- ============================================================

-- 1) Storage bucket（私有；shell 更新的 APK 与 web 的 zip 都放这里）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'app_updates',
  'app_updates',
  false,
  52428800,
  array['application/zip', 'application/x-zip-compressed', 'application/octet-stream']
)
on conflict (id) do nothing;

-- 2) bundle 版本清单表（DDL 与 migration-app-hot-update.sql 一致）
create table if not exists public.app_versions (
  id              uuid primary key default gen_random_uuid(),
  version         text        not null unique,
  storage_path    text        not null,
  released_at     timestamptz not null default now(),
  min_app_version text,
  enabled         boolean     not null default true,
  notes           text
);

create index if not exists idx_app_versions_enabled_released
  on public.app_versions (enabled, released_at desc);

-- 3) 原生壳版本清单表（列与生产对齐的测试通道子集）
create table if not exists public.app_native_versions (
  id                    uuid primary key default gen_random_uuid(),
  version_name          text        not null unique,
  version_code          integer     not null unique,
  storage_path          text        not null,
  apk_size_bytes        bigint,
  apk_sha256            text,
  notes                 text,
  enabled               boolean     not null default true,
  released_at           timestamptz not null default now(),
  is_force_update       boolean     not null default false,
  min_supported_version text
);

create index if not exists idx_app_native_enabled_released
  on public.app_native_versions (enabled, released_at desc);

-- 4) RLS：登录可读（真机 App 启动时拉版本清单 + 生成下载签名 URL 的前提）；
--    写不建 policy = 仅 service_role（发布脚本），与生产同一语义。
alter table public.app_versions enable row level security;
alter table public.app_native_versions enable row level security;

drop policy if exists "app_versions 读：登录用户" on public.app_versions;
create policy "app_versions 读：登录用户"
  on public.app_versions for select to authenticated using (true);

drop policy if exists "app_native 读：登录用户" on public.app_native_versions;
create policy "app_native 读：登录用户"
  on public.app_native_versions for select to authenticated using (true);

-- 5) Storage 对象：登录可读（签名 URL 前提）；写仅 service_role（发布脚本）
drop policy if exists "app_updates 读：登录用户" on storage.objects;
create policy "app_updates 读：登录用户"
  on storage.objects for select to authenticated using (bucket_id = 'app_updates');

-- ============================================================
-- 执行结果验证（SQL Editor 单独跑）：
--   select version, enabled, released_at from app_versions order by released_at desc limit 5;
--   select version_name, version_code, enabled from app_native_versions order by version_code desc limit 5;
--   select id, name, public from storage.buckets where id = 'app_updates';
-- ============================================================
