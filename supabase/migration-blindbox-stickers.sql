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
