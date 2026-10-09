-- ============================================================
-- 迁移：待办留言板（todo_comments + comment_likes）+ 历史完成备注搬迁
--
-- 使用方法（铁律三主通道）：
--   测试库：node scripts/apply-sql.mjs supabase/migration-add-todo-comments.sql --project test --apply
--   生产库：node scripts/apply-sql.mjs supabase/migration-add-todo-comments.sql --project prod --apply --confirm migration-add-todo-comments.sql
--   （无 PAT 时兜底：打开 Supabase Dashboard → SQL Editor → 粘贴本文件全部内容 → Run）
--
-- 本迁移幂等（可重复执行，apply-sql 会自动跑第二遍自证）。
--
-- 效果：
--   1. 建 todo_comments（同一待办下两人各自的留言，可回复某条）+ comment_likes（留言上的爱心）
--   2. 把 todos.completed_note 的历史备注搬迁为各待办的**第一条留言**（作者取完成人，未完成取创建人）
--   3. 两张表开放 Realtime 推送
--
-- 不执行会怎样：新版前端读不到留言表 → 留言功能整体不可见（拉取失败静默降级，App 其余功能不受影响）；
--   但历史完成备注仍在 todos.completed_note 列里，不会丢（本迁移只 INSERT，不动原列）。
--
-- 顺序硬约束：先应用本迁移，再发热更新包。
-- 回滚安全：completed_note 列与数据**保留不删**，旧包回滚后仍能看到旧备注。
-- ============================================================

-- ===== 1. todo_comments 表：待办留言（平铺 + 回复引用）=====
CREATE TABLE IF NOT EXISTS todo_comments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  todo_id    UUID NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  author_id  UUID NOT NULL REFERENCES auth.users(id),
  -- 回复目标（NULL=主留言）。SET NULL 而非 CASCADE：万一父留言被物理删除，
  -- 不能连带删掉对方写的回复（物理删除只发生在「回收站彻底删除待办」的级联里）
  parent_id  UUID REFERENCES todo_comments(id) ON DELETE SET NULL,
  content    TEXT NOT NULL CHECK (char_length(content) <= 100),
  edited_at  TIMESTAMPTZ,                        -- 编辑过的时间（UI 显示「已编辑」）
  deleted_at TIMESTAMPTZ,                        -- 软删除（铁律九：只打时间戳，不物理移除）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_todo_comments_todo
  ON todo_comments (todo_id, created_at);

ALTER TABLE todo_comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "todo_comments_select_auth" ON todo_comments;
CREATE POLICY "todo_comments_select_auth" ON todo_comments
  FOR SELECT TO authenticated USING (true);
-- 写操作收紧到「只能动自己的」：由数据库硬保证，不依赖 UI 自觉
DROP POLICY IF EXISTS "todo_comments_insert_auth" ON todo_comments;
CREATE POLICY "todo_comments_insert_auth" ON todo_comments
  FOR INSERT TO authenticated WITH CHECK (author_id = auth.uid());
DROP POLICY IF EXISTS "todo_comments_update_auth" ON todo_comments;
CREATE POLICY "todo_comments_update_auth" ON todo_comments
  FOR UPDATE TO authenticated USING (author_id = auth.uid()) WITH CHECK (author_id = auth.uid());
DROP POLICY IF EXISTS "todo_comments_delete_auth" ON todo_comments;
CREATE POLICY "todo_comments_delete_auth" ON todo_comments
  FOR DELETE TO authenticated USING (author_id = auth.uid());

-- ===== 2. comment_likes 表：留言上的爱心 =====
-- 独立表而非数组列：toggle 走 UNIQUE 约束（插/删各一条），没有「读-改-写」竞态。
-- 仅一个爱心，故不需要 emoji 列（与 reactions 的三表情不同）。
CREATE TABLE IF NOT EXISTS comment_likes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id UUID NOT NULL REFERENCES todo_comments(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (comment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_comment_likes_comment ON comment_likes (comment_id);

ALTER TABLE comment_likes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "comment_likes_select_auth" ON comment_likes;
CREATE POLICY "comment_likes_select_auth" ON comment_likes
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "comment_likes_insert_auth" ON comment_likes;
CREATE POLICY "comment_likes_insert_auth" ON comment_likes
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "comment_likes_delete_auth" ON comment_likes;
CREATE POLICY "comment_likes_delete_auth" ON comment_likes
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ===== 3. 历史完成备注搬迁为第一条留言 =====
-- 只 INSERT 不删原列（回滚安全）。按 todo 幂等：该待办已有任意留言（含软删）就跳过，
-- 所以重复执行不会补出第二条；用户删掉搬迁来的那条后也不会被"复活"。
INSERT INTO todo_comments (todo_id, author_id, content, created_at)
SELECT t.id,
       COALESCE(t.completed_by, t.created_by),
       btrim(t.completed_note),
       COALESCE(t.completed_at, t.created_at)
FROM todos t
WHERE t.completed_note IS NOT NULL
  AND btrim(t.completed_note) <> ''
  -- 历史备注没有作者字段，作者只能推断：完成人优先，未完成时取创建人（已知近似）
  AND COALESCE(t.completed_by, t.created_by) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM todo_comments c WHERE c.todo_id = t.id);

-- ===== 4. 启用 Realtime 推送（幂等写法，重复执行不会报 already member）=====
-- REPLICA IDENTITY FULL：DELETE/UPDATE 事件的 payload 带完整旧行，
-- 前端据此按内容反查（reactions 表同款处理，见 migration-reactions-replica-identity.sql）
ALTER TABLE todo_comments REPLICA IDENTITY FULL;
ALTER TABLE comment_likes REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'todo_comments') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE todo_comments;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'comment_likes') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE comment_likes;
  END IF;
END $$;
