-- ============================================================
-- 热更新（OTA）：app_updates bucket + app_versions 表
-- ============================================================
-- 用途：配合 @capgo/capacitor-updater 自建模式，把前端资源 zip
--       放在 Supabase Storage，App 启动时检查版本并下载。
--
-- 执行位置：Supabase Dashboard → SQL Editor → 粘贴全选 → Run
-- 幂等：可重复执行，不会报错
-- ============================================================

-- 1) Storage bucket：存放前端资源 zip（私有，仅本人两个账号可读）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'app_updates',
  'app_updates',
  false,                          -- 私有 bucket：必须用签名 URL 才能下载
  52428800,                       -- 50MB 上限（前端资源目前 ~700KB，留足余量）
  array['application/zip', 'application/x-zip-compressed']
)
on conflict (id) do nothing;

-- 2) 版本清单表：记录每个发布的版本元信息
create table if not exists public.app_versions (
  id              uuid primary key default gen_random_uuid(),
  -- 语义化版本号，如 '2.0.1'，App 用它与本地版本比较
  version         text        not null unique,
  -- Storage 对象路径，如 'releases/有爱-2.0.1.zip'
  storage_path    text        not null,
  -- 发布时间
  released_at     timestamptz not null default now(),
  -- 最低兼容的 App 原生壳版本（versionName），低于此版本的 App 不下发该包
  min_app_version text,
  -- 是否对客户端可见（false = 草稿/回滚后下线）
  enabled         boolean     not null default true,
  -- 更新说明（可选，给开发者自己看 / 未来可在 App 内展示）
  notes           text
);

-- 列出/查询版本时按发布时间倒序的索引
create index if not exists idx_app_versions_enabled_released
  on public.app_versions (enabled, released_at desc);

-- 3) RLS：仅登录用户可读版本清单（双人 App 就两个账号）
alter table public.app_versions enable row level security;

-- 读：登录用户可查（App 启动时拉最新版本）
drop policy if exists "app_versions 读：登录用户" on public.app_versions;
create policy "app_versions 读：登录用户"
  on public.app_versions for select
  to authenticated
  using (true);

-- 写：只允许 service_role（发布脚本用，普通客户端 key 写不了）
-- 不建 insert/update policy for authenticated → 客户端永远无法写，只能 service_role 绕过 RLS

-- 4) Storage 对象权限：bucket 私有，读权限用 Storage Policies 控制
--    读：登录用户可读（生成签名 URL 的前提是 RLS 允许读对象）
--    写：仅 service_role（发布脚本）
--    这里给 authenticated 读权限，因为创建签名 URL 的客户端需要能访问对象
--    （注意：私有 bucket 即使有 policy 也必须带签名才能下载，URL 一旦过期即失效）

-- Storage 的 policy 在 storage.schema 里
drop policy if exists "app_updates 读：登录用户" on storage.objects;
create policy "app_updates 读：登录用户"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'app_updates');

drop policy if exists "app_updates 写：仅 service_role" on storage.objects;
create policy "app_updates 写：仅 service_role"
  on storage.objects for insert
  to service_role
  with check (bucket_id = 'app_updates');

drop policy if exists "app_updates 删：仅 service_role" on storage.objects;
create policy "app_updates 删：仅 service_role"
  on storage.objects for delete
  to service_role
  using (bucket_id = 'app_updates');

-- ============================================================
-- 执行结果验证（可在 SQL Editor 单独跑，确认建好了）：
--   select id, version, enabled, released_at from app_versions order by released_at desc limit 5;
--   select id, name, public from storage.buckets where id = 'app_updates';
-- ============================================================
