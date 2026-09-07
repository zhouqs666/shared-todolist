-- 壳更新：强制更新 + 最低支持版本
-- 幂等，可重复执行

alter table public.app_native_versions
  add column if not exists is_force_update boolean not null default false;

alter table public.app_native_versions
  add column if not exists min_supported_version text;

-- is_force_update=true 时：当前版本 < 新版本 且 之间有任何 force 版本 → 必须更到最新
-- min_supported_version：当前壳版本低于此值时，即使本版本不是 force，也强制更（兜底保护）
