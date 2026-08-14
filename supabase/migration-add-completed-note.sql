-- 迁移：给 todos 表加 completed_note 字段（完成备注/交代）
--
-- 用途：
--   - 完成待办后，可选地留一句话给对方（如"蚊子已打死"）
--   - 长按已完成待办 → 备注 → 底部滑出输入面板 → 保存（覆盖原备注）
--
-- 执行位置：Supabase Dashboard → SQL Editor → 粘贴 → Run
-- 幂等：可重复执行（IF NOT EXISTS）
-- 不影响现有约束：
--   - completed_consistent CHECK 只校验 completed/completed_by/completed_at，不涉及 note
--   - todos_update_auth RLS 是 USING(true) WITH CHECK(true)，note 自动可写
--   - todos 已在 supabase_realtime publication，对方改备注会自动推送

ALTER TABLE todos ADD COLUMN IF NOT EXISTS completed_note TEXT;
