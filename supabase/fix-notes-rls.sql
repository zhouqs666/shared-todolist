-- ============================================================
-- 修复脚本：专门解决「发送留言失败」问题
-- 无论之前迁移执行成什么样，本脚本强制把 daily_notes 重置为正确状态。
--
-- 用法：Supabase Dashboard → SQL Editor → 粘贴 → Run
-- 安全：可重复执行，所有语句都做了容错。
-- ============================================================

-- 1. 确保 read_by 字段存在（之前若没加上，这里补）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'daily_notes' AND column_name = 'read_by'
  ) THEN
    ALTER TABLE daily_notes ADD COLUMN read_by UUID REFERENCES auth.users(id);
  END IF;
END $$;

-- 2. 确保表存在（万一没建）
CREATE TABLE IF NOT EXISTS daily_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_key     DATE NOT NULL DEFAULT CURRENT_DATE,
  author_id   UUID NOT NULL REFERENCES auth.users(id),
  content     TEXT NOT NULL CHECK (char_length(content) <= 200),
  read_by     UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. 强制开启 RLS
ALTER TABLE daily_notes ENABLE ROW LEVEL SECURITY;

-- 4. 删掉所有旧策略，重建正确的（这是发送失败的关键修复点）
DROP POLICY IF EXISTS "daily_notes_select_auth" ON daily_notes;
DROP POLICY IF EXISTS "daily_notes_insert_auth" ON daily_notes;
DROP POLICY IF EXISTS "daily_notes_delete_auth" ON daily_notes;
DROP POLICY IF EXISTS "daily_notes_update_auth" ON daily_notes;
-- 兜底：删掉任何其他可能的旧策略名
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'daily_notes' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON daily_notes', r.policyname);
  END LOOP;
END $$;

-- 重建：authenticated 用户可读全部、只能插入自己的、可删任意、可更新任意
CREATE POLICY "daily_notes_select_auth" ON daily_notes
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "daily_notes_insert_auth" ON daily_notes
  FOR INSERT TO authenticated WITH CHECK (author_id = auth.uid());
CREATE POLICY "daily_notes_delete_auth" ON daily_notes
  FOR DELETE TO authenticated USING (true);
CREATE POLICY "daily_notes_update_auth" ON daily_notes
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- 5. 清掉可能存在的脏数据（旧的不符合约束的行），避免干扰
DELETE FROM daily_notes WHERE content IS NULL OR author_id IS NULL;

-- 6. 验证：跑完下面这句（取消注释）能看到 4 条策略就对了
-- SELECT policyname, polcmd FROM pg_policies WHERE tablename = 'daily_notes' ORDER BY polcmd;
