-- ============================================================
-- 测试库 schema 同步（把独立测试项目补齐到与生产一致）
--
-- 用途：Web 通道 E2E 现在跑在独立测试库上（scripts/serve-test.mjs）。
--       测试库 schema 若落后于生产，E2E 会「跑绿但没验证真实行为」（铁律二的假阴性）。
--       实例：测试库曾缺 stickers 表 + pinned/rarity 列，导致盲盒功能无从触发、
--             两个测试因 "column todos.pinned does not exist" 直接失败。
--
-- 执行位置：**测试项目** Dashboard → SQL Editor → 粘贴全选 → Run
--          （URL 见 app-e2e/.env.test 的 E2E_SUPABASE_URL）
--          ⚠️ 绝不要在生产项目执行本文件（虽然幂等，但没必要）
--
-- 幂等：可重复执行不出错。本文件由以下源文件拼接而成，单独执行它们亦可：
--   migration-pin.sql / migration-multi-images.sql / migration-blindbox-stickers.sql
--   migration-add-last-seen.sql / migration-login-count-glow.sql
--   migration-app-hot-update.sql / migration-app-native-versions.sql（仓库根目录）
--   migration-app-native-versions-force.sql / migration-reactions-replica-identity.sql
--
-- 执行后自检：node scripts/check-test-env.mjs   （应输出「测试环境就绪」）
-- ============================================================


-- ============================================================
-- 来源：supabase/migration-pin.sql
-- ============================================================
-- ============================================
-- 迁移：为 todos 表添加置顶（pin）功能
-- 执行位置：Supabase Dashboard → SQL Editor
-- 执行后效果：待办可置顶，置顶项显示在列表最上方
-- ============================================

-- 1. 添加 pinned 字段（BOOLEAN，默认 false = 未置顶）
ALTER TABLE todos ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT false;

-- 2. 添加字段注释
COMMENT ON COLUMN todos.pinned IS '是否置顶，置顶项显示在列表最上方';

-- 3. 创建复合索引：优化置顶查询性能
--    排序规则：pinned DESC（置顶在前）→ completed ASC（未完成在前）→ created_at DESC（新的在前）
CREATE INDEX IF NOT EXISTS idx_todos_pinned_completed_created
  ON todos (pinned DESC, completed ASC, created_at DESC);

-- 幂等设计：可重复执行，不会报错


-- ============================================================
-- 来源：supabase/migration-multi-images.sql
-- ============================================================
-- 迁移：多图支持（image_paths JSONB 数组）
-- 旧 image_path 列不删不改，保留只读兼容；新功能读写 image_paths。
-- 幂等：可重复执行不出错。
-- 执行位置：Supabase Dashboard → SQL Editor → 粘贴 → Run

-- 1. 加 image_paths JSONB 列（存 URL 数组，如 ["https://...", "https://..."]）
ALTER TABLE todos ADD COLUMN IF NOT EXISTS image_paths JSONB;

-- 2. 迁移：把旧 image_path 单值复制到 image_paths 单元素数组
--    只填 image_paths 为 NULL 的行（已迁移过的不再覆盖，幂等）
UPDATE todos
SET image_paths = jsonb_build_array(image_path)
WHERE image_path IS NOT NULL AND image_paths IS NULL;

-- 说明：
-- - image_path 列保留不删（只读兼容，前端 toExternal 会优先读 image_paths、回退 image_path）
-- - 新待办/编辑图片都走 image_paths
-- - 执行后旧图自动出现在 image_paths，无需重新上传


-- ============================================================
-- 来源：supabase/migration-blindbox-stickers.sql
-- ============================================================
-- ============================================================
-- 迁移：隐藏款盲盒 + 收集图鉴
--
-- 功能说明：
--   1. todos 表加 rarity（稀有度）+ rarity_seen（对方是否已看过）字段
--      —— 添加待办时有概率开出"隐藏款"，稀有度分 rare/epic/legendary
--   2. 新建 stickers 表（图鉴，两人共享一本）
--      —— 添加待办开出隐藏款时即解锁对应贴纸（无需完成），任一方解锁即对双方可见
--
-- 使用方法：
--   打开 Supabase Dashboard → SQL Editor → 粘贴本文件全部内容 → Run
--
-- 本迁移幂等（可重复执行）：字段用 IF NOT EXISTS，policy 先 DROP 再 CREATE，
-- 表用 CREATE TABLE IF NOT EXISTS。
-- ============================================================

-- ===== 1. todos 表加字段 =====

-- rarity：稀有度。null 或 'common' = 普通款；'rare'/'epic'/'legendary' = 隐藏款
ALTER TABLE todos ADD COLUMN IF NOT EXISTS rarity TEXT;
-- rarity_seen：隐藏款是否已被对方"看过"（用于对方端首次见到时播惊喜提示）
-- 新建自己的隐藏款时为 true；通过 Realtime 同步到对方端，对方播完提示后回标 true
ALTER TABLE todos ADD COLUMN IF NOT EXISTS rarity_seen BOOLEAN NOT NULL DEFAULT true;

-- 回填：历史待办统一视为已看过的普通款（兼容旧数据）
UPDATE todos SET rarity = 'common' WHERE rarity IS NULL;

COMMENT ON COLUMN todos.rarity IS '稀有度：common(普通)/rare(稀有)/epic(史诗)/legendary(传说)。隐藏款盲盒功能';
COMMENT ON COLUMN todos.rarity_seen IS '隐藏款是否已被对方看过（首次推送对方端时用于触发惊喜提示）';

-- ===== 2. stickers 表：收集图鉴（两人共享）=====

CREATE TABLE IF NOT EXISTS stickers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sticker_key TEXT NOT NULL,                              -- 如 'rare_1'/'epic_3'/'legendary_4'，每张贴纸的唯一标识
  rarity      TEXT NOT NULL CHECK (rarity IN ('rare','epic','legendary')), -- 该贴纸所属稀有度
  unlocked_by UUID NOT NULL REFERENCES auth.users(id),   -- 谁开出隐藏款触发的解锁（标记用，图鉴本身共享）
  todo_id     UUID REFERENCES todos(id) ON DELETE SET NULL, -- 触发解锁的那条隐藏款待办（可空，软删除时置 null）
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sticker_key)                                    -- 共享图鉴：每个 key 全局唯一，重复解锁被忽略
);

CREATE INDEX IF NOT EXISTS idx_stickers_rarity ON stickers (rarity);

ALTER TABLE stickers ENABLE ROW LEVEL SECURITY;
-- 共享语义（沿用 todos 模式）：两个固定账号互信，authenticated 可读写所有行
DROP POLICY IF EXISTS "stickers_select_auth" ON stickers;
CREATE POLICY "stickers_select_auth" ON stickers
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "stickers_insert_auth" ON stickers;
CREATE POLICY "stickers_insert_auth" ON stickers
  FOR INSERT TO authenticated WITH CHECK (unlocked_by = auth.uid());
DROP POLICY IF EXISTS "stickers_update_auth" ON stickers;
CREATE POLICY "stickers_update_auth" ON stickers
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "stickers_delete_auth" ON stickers;
CREATE POLICY "stickers_delete_auth" ON stickers
  FOR DELETE TO authenticated USING (true);

-- ===== 3. 启用 Realtime（双端同步图鉴解锁）=====
ALTER PUBLICATION supabase_realtime ADD TABLE stickers;

-- ===== 4. 验证（可选，执行后应看到相关行）=====
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'todos' AND column_name IN ('rarity','rarity_seen');
-- SELECT count(*) AS sticker_table_exists FROM information_schema.tables WHERE table_name = 'stickers';


-- ============================================================
-- 来源：supabase/migration-add-last-seen.sql
-- ============================================================
-- 迁移：给 profiles 表加 last_seen_at 字段（最后在线时间）
--
-- 用途：
--   - 顶栏爱心"开场光晕"判断：对方今天是否来过（last_seen_at >= 今天 00:00）
--   - 与 Realtime presence 互补：presence 断开即丢，last_seen_at 持久化跨会话
--
-- 执行位置：Supabase Dashboard → SQL Editor → 粘贴 → Run
-- 幂等：可重复执行不出错（IF NOT EXISTS）
-- RLS：无需改动。profiles_select_all 已允许读对方，profiles_update_self 已允许改自己。

-- 1. 加字段
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- 2. 回填现有用户（避免 NULL 判断麻烦）
UPDATE profiles SET last_seen_at = now() WHERE last_seen_at IS NULL;


-- ============================================================
-- 来源：supabase/migration-login-count-glow.sql
-- ============================================================
-- ============================================================
-- 打开计数光晕：记录"对方没看到时我打开了 App 几次"
-- ============================================================
-- 用途：A 每次冷启动 App（不管登录态）给自己 login_count_for_partner +1；
--       B 打开 App 时读 A 的计数 N，爱心闪 N 下光晕，然后清零 A 的计数。
--       就像"未读消息"——看完即清零。
--
-- 注意：计数的是"打开 App 次数"，不是"登录次数"。
--       Supabase 用持久化 session，登录一次后下次打开是登录态，但仍算一次"打开"。
--
-- 执行位置：Supabase Dashboard → SQL Editor → 粘贴全选 → Run
-- 幂等：可重复执行不出错
-- ============================================================

-- 1. profiles 加字段：给对方看的打开计数（对方看过后会清零）
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS login_count_for_partner INT NOT NULL DEFAULT 0;

-- 回填现有用户
UPDATE profiles SET login_count_for_partner = 0 WHERE login_count_for_partner IS NULL;

-- 2. RPC 函数：原子地自增自己的打开计数
--    用 RPC 而非前端 read-modify-write，避免双人同时打开时的竞态丢失。
CREATE OR REPLACE FUNCTION increment_login_count(target_uid UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE profiles SET login_count_for_partner = login_count_for_partner + 1
    WHERE id = target_uid;
END;
$$;

-- 3. RPC 函数：原子地"读取并清零指定用户的计数"
--    为什么用 RPC：RLS 只允许改自己，但 B 要清零 A 的计数，必须绕过 RLS。
--    SECURITY DEFINER 以函数 owner（postgres）权限执行，绕过调用者的 RLS。
CREATE OR REPLACE FUNCTION consume_login_count(target_uid UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  consumed INT;
BEGIN
  SELECT login_count_for_partner INTO consumed
    FROM profiles WHERE id = target_uid;
  IF consumed IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE profiles SET login_count_for_partner = 0 WHERE id = target_uid;
  RETURN consumed;
END;
$$;

-- 4. 允许登录用户调用这两个 RPC
GRANT EXECUTE ON FUNCTION increment_login_count(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION consume_login_count(UUID) TO authenticated;

-- ============================================================
-- 执行结果验证（可在 SQL Editor 单独跑）：
--   select id, username, login_count_for_partner from profiles;
--   select consume_login_count('<某个用户id>');  -- 测试读取并清零
-- ============================================================


-- ============================================================
-- 来源：supabase/migration-app-hot-update.sql
-- ============================================================
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


-- ============================================================
-- 来源：migration-app-native-versions.sql
-- ============================================================
-- ============================================================
-- App 内 APK 更新：原生壳版本表 app_native_versions
-- 执行位置：Supabase Dashboard → SQL Editor → 全选粘贴 → Run
-- 幂等：可重复执行不出错（IF NOT EXISTS / DROP POLICY IF EXISTS）
--
-- 作用：存放 APK 发布记录（版本号/下载路径/SHA256/更新说明），
--       App 冷启动时查询此表判断是否有新壳版本可更新。
-- 不执行的影响：App 查询报错但静默降级（不影响使用），
--       只是无法收到"App 内更新 APK"的提示。
-- ============================================================

create table if not exists public.app_native_versions (
  id bigint generated by default as identity primary key,
  -- 壳版本号（语义化，与 build.gradle 的 versionName 一致，如 2.1.0）
  version_name text not null unique,
  -- 内部版本号（与 build.gradle 的 versionCode 一致，单调递增）
  version_code integer not null,
  -- APK 在 app_updates bucket 里的存储路径（如 apks/youai-2.1.0.apk）
  storage_path text not null,
  -- APK 文件字节数（面板展示体积用）
  apk_size_bytes bigint,
  -- APK 的 SHA-256（客户端下载后校验，防坏包/防篡改）
  apk_sha256 text,
  -- 更新说明（面板展示改了什么）
  notes text,
  enabled boolean not null default true,
  released_at timestamptz not null default now()
);

-- 行级安全：写入仅 service_role（发布脚本用，绕过 RLS，无需额外 policy）；
-- 登录用户只读。
alter table public.app_native_versions enable row level security;

drop policy if exists "authenticated read app_native_versions"
  on public.app_native_versions;
create policy "authenticated read app_native_versions"
  on public.app_native_versions
  for select
  to authenticated
  using (true);

-- 索引：客户端按 enabled + released_at 查最新一条
create index if not exists idx_app_native_versions_latest
  on public.app_native_versions (enabled, released_at desc);


-- ============================================================
-- 来源：supabase/migration-app-native-versions-force.sql
-- ============================================================
-- 壳更新：强制更新 + 最低支持版本
-- 幂等，可重复执行

alter table public.app_native_versions
  add column if not exists is_force_update boolean not null default false;

alter table public.app_native_versions
  add column if not exists min_supported_version text;

-- is_force_update=true 时：当前版本 < 新版本 且 之间有任何 force 版本 → 必须更到最新
-- min_supported_version：当前壳版本低于此值时，即使本版本不是 force，也强制更（兜底保护）


-- ============================================================
-- 来源：supabase/migration-reactions-replica-identity.sql
-- ============================================================
-- ============================================================
-- 迁移：reactions 表开启 REPLICA IDENTITY FULL（修复取消点赞不同步）
--
-- 使用方法：
--   打开 Supabase Dashboard → SQL Editor → 粘贴本文件全部内容 → Run
--
-- 背景（2026-08-21 排查「长按点赞显示 2 次」时发现）：
--   Supabase Realtime 对启用了 RLS 的表，在默认 replica identity 下
--   【不会向客户端推送 DELETE 事件】（官方文档明确要求 REPLICA IDENTITY FULL）。
--   后果：A 取消爱心后，B 的屏幕上爱心不会消失（要等刷新重拉），
--         且 B 本地残留"僵尸行"，后续自己取消时计数显示错乱。
--   表情的新增（INSERT/UPDATE）不受影响，此前双端贴表情一直是正常的。
--
-- 本语句幂等，可重复执行。
-- ============================================================

ALTER TABLE reactions REPLICA IDENTITY FULL;


