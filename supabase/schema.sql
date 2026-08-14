-- ============================================================
-- 双人共享待办清单 — Supabase schema（V2 / PWA + Auth 版）
--
-- 这是当前生产环境的 schema 副本，仅作参考。
-- schema 已在 Dashboard SQL Editor 中应用，无需再次运行。
-- 如需在新项目重置，按下面顺序执行即可。
-- ============================================================

-- ===== 0. 清理（如重置） =====
-- DROP TABLE IF EXISTS todos CASCADE;
-- DROP TABLE IF EXISTS profiles CASCADE;
-- DROP FUNCTION IF EXISTS handle_new_user() CASCADE;
-- DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- ===== 1. profiles 表：userId → username / display_name =====
CREATE TABLE IF NOT EXISTS profiles (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username     TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "profiles_select_all" ON profiles;
CREATE POLICY "profiles_select_all" ON profiles FOR SELECT USING (true);
DROP POLICY IF EXISTS "profiles_insert_self" ON profiles;
CREATE POLICY "profiles_insert_self" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
DROP POLICY IF EXISTS "profiles_update_self" ON profiles;
CREATE POLICY "profiles_update_self" ON profiles FOR UPDATE USING (auth.uid() = id);

-- 注册时自动填充 profiles（trigger）
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, username, display_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ===== 2. todos 表（V2：created_by / completed_by 是 UUID 引用 auth.users）=====
CREATE TABLE IF NOT EXISTS todos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text          TEXT NOT NULL CHECK (char_length(text) <= 200),
  completed     BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    UUID NOT NULL REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_by  UUID REFERENCES auth.users(id),
  completed_at  TIMESTAMPTZ,
  -- 轻轻提醒标记：标记人的 user id（NULL=未标记）。克制提醒对方"这条我很关注"
  nudge_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- 图片附件：Storage 对象的完整 public URL（NULL=无图）。一条待办最多一张图。
  image_path    TEXT,
  -- 完成备注：完成后的可选交代/收尾说明（如"蚊子已打死"）。NULL=无备注
  completed_note TEXT,
  -- 软删除标记：NULL=正常，非NULL=已删除（回收站保留，防误删）
  deleted_at    TIMESTAMPTZ,

  CONSTRAINT completed_consistent CHECK (
    (completed = FALSE AND completed_by IS NULL AND completed_at IS NULL)
    OR (completed = TRUE AND completed_by IS NOT NULL AND completed_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_todos_completed_created
  ON todos (completed, created_at DESC);
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

-- 双人共享模式：所有已登录用户都能读写所有 todos
-- （安全前提：只有 2 个固定账号能注册，无公开注册入口）
DROP POLICY IF EXISTS "todos_select_auth" ON todos;
CREATE POLICY "todos_select_auth" ON todos
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "todos_insert_auth" ON todos;
CREATE POLICY "todos_insert_auth" ON todos
  FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
DROP POLICY IF EXISTS "todos_update_auth" ON todos;
CREATE POLICY "todos_update_auth" ON todos
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "todos_delete_auth" ON todos;
CREATE POLICY "todos_delete_auth" ON todos
  FOR DELETE TO authenticated USING (true);

-- ===== 3. 启用 Realtime 推送（INSERT/UPDATE/DELETE 全事件）=====
ALTER PUBLICATION supabase_realtime ADD TABLE todos;
ALTER PUBLICATION supabase_realtime ADD TABLE profiles;

-- ===== 5. daily_notes 表：悄悄留言（阅后即焚）=====
CREATE TABLE IF NOT EXISTS daily_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_key     DATE NOT NULL DEFAULT CURRENT_DATE,
  author_id   UUID NOT NULL REFERENCES auth.users(id),
  content     TEXT NOT NULL CHECK (char_length(content) <= 200),
  read_by     UUID REFERENCES auth.users(id),   -- 谁已读过（NULL=未读）
  deleted_at  TIMESTAMPTZ,                       -- 软删除标记（阅后即焚：NULL=正常）
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_daily_notes_day
  ON daily_notes (day_key DESC, created_at);
ALTER TABLE daily_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "daily_notes_select_auth" ON daily_notes;
CREATE POLICY "daily_notes_select_auth" ON daily_notes
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "daily_notes_insert_auth" ON daily_notes;
CREATE POLICY "daily_notes_insert_auth" ON daily_notes
  FOR INSERT TO authenticated WITH CHECK (author_id = auth.uid());
DROP POLICY IF EXISTS "daily_notes_delete_auth" ON daily_notes;
CREATE POLICY "daily_notes_delete_auth" ON daily_notes
  FOR DELETE TO authenticated USING (true);
DROP POLICY IF EXISTS "daily_notes_update_auth" ON daily_notes;
CREATE POLICY "daily_notes_update_auth" ON daily_notes
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ===== 6. reactions 表：任务表情反应（仅完成后可贴，前端控制） =====
CREATE TABLE IF NOT EXISTS reactions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  todo_id    UUID NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id),
  emoji      TEXT NOT NULL CHECK (char_length(emoji) <= 10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 同一人对同一条同一表情只存一次（toggle 语义）
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

-- ===== 7. 启用新表的 Realtime 推送 =====
ALTER PUBLICATION supabase_realtime ADD TABLE daily_notes;
ALTER PUBLICATION supabase_realtime ADD TABLE reactions;

-- ===== 4. 账号创建参考（不在此处运行，使用 scripts/init-users.mjs）=====
-- 见 scripts/init-users.mjs：用 service_role 调 auth.admin.createUser 创建
-- 底层账号邮箱 xiaobaobao@todo.local / dabaobei@todo.local（注册时 display_name 用英文），
-- 登录名/显示名后续改为中文「小宝宝」「大宝贝」（见 scripts/init-users.mjs 的 USERS 表），
-- 触发上面的 trigger 自动建 profile。
