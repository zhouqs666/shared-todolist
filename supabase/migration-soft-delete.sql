-- ============================================================
-- 迁移：软删除（回收站）—— todos + daily_notes 加 deleted_at 字段
--
-- 用法：Supabase Dashboard → SQL Editor → 粘贴 → Run
-- 幂等：可重复执行（字段已存在会跳过）。
--
-- 软删除语义：删除只标记 deleted_at（不物理删除），查询过滤已标记的行。
-- 30 天后由定时任务物理清理（本期不实现清理，仅打标记防误删）。
-- ============================================================

-- 1. todos 表加 deleted_at
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'todos' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE todos ADD COLUMN deleted_at TIMESTAMPTZ;
    COMMENT ON COLUMN todos.deleted_at IS '软删除标记：NULL=正常，非NULL=已删除（回收站保留）';
  END IF;
END $$;

-- 2. daily_notes 表加 deleted_at
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'daily_notes' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE daily_notes ADD COLUMN deleted_at TIMESTAMPTZ;
    COMMENT ON COLUMN daily_notes.deleted_at IS '软删除标记：NULL=正常，非NULL=已删除（阅后即焚标记）';
  END IF;
END $$;

-- 3. 索引：加速"只查未删除"的过滤
CREATE INDEX IF NOT EXISTS idx_todos_not_deleted ON todos (deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_daily_notes_not_deleted ON daily_notes (deleted_at) WHERE deleted_at IS NULL;
