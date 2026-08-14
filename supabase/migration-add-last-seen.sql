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
