-- ============================================================
-- 迁移：新增「每日留言板」+「任务表情反应」+ 留言已读状态
--
-- 使用方法：
--   打开 Supabase Dashboard → SQL Editor → 粘贴本文件全部内容 → Run
--
-- 本迁移幂等（可重复执行）。如果你之前执行过旧版（daily_notes 无 read_by），
-- 本文件会自动用 ALTER TABLE 补上 read_by 字段并更新 delete 策略。
-- ============================================================

-- ===== 1. daily_notes 表：悄悄留言（阅后即焚）=====
CREATE TABLE IF NOT EXISTS daily_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_key     DATE NOT NULL DEFAULT CURRENT_DATE,
  author_id   UUID NOT NULL REFERENCES auth.users(id),
  content     TEXT NOT NULL CHECK (char_length(content) <= 200),
  read_by     UUID REFERENCES auth.users(id),   -- 谁已读过（NULL=未读）。阅后即焚的依据
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_daily_notes_day
  ON daily_notes (day_key DESC, created_at);

-- 兼容：若表已存在但缺 read_by 字段（之前执行过旧版迁移），补上
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'daily_notes' AND column_name = 'read_by'
  ) THEN
    ALTER TABLE daily_notes ADD COLUMN read_by UUID REFERENCES auth.users(id);
  END IF;
END $$;

ALTER TABLE daily_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "daily_notes_select_auth" ON daily_notes;
CREATE POLICY "daily_notes_select_auth" ON daily_notes
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "daily_notes_insert_auth" ON daily_notes;
CREATE POLICY "daily_notes_insert_auth" ON daily_notes
  FOR INSERT TO authenticated WITH CHECK (author_id = auth.uid());
-- delete：共享可删（接收方阅后即焚需要删掉对方发来的）
DROP POLICY IF EXISTS "daily_notes_delete_auth" ON daily_notes;
CREATE POLICY "daily_notes_delete_auth" ON daily_notes
  FOR DELETE TO authenticated USING (true);
-- update：允许标记 read_by（阅后即焚的第一步）
DROP POLICY IF EXISTS "daily_notes_update_auth" ON daily_notes;
CREATE POLICY "daily_notes_update_auth" ON daily_notes
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ===== 2. reactions 表：任务表情反应 =====
CREATE TABLE IF NOT EXISTS reactions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  todo_id    UUID NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id),
  emoji      TEXT NOT NULL CHECK (char_length(emoji) <= 10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (todo_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_todo ON reactions (todo_id);

ALTER TABLE reactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reactions_select_auth" ON reactions;
CREATE POLICY "reactions_select_auth" ON reactions
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "reactions_insert_auth" ON reactions;
CREATE POLICY "reactions_insert_auth" ON reactions
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "reactions_delete_auth" ON reactions;
CREATE POLICY "reactions_delete_auth" ON reactions
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ===== 3. 启用 Realtime =====
ALTER PUBLICATION supabase_realtime ADD TABLE daily_notes;
ALTER PUBLICATION supabase_realtime ADD TABLE reactions;
