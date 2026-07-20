-- ============================================================
-- 双人共享待办清单 — Supabase 建表脚本
-- 使用方法：
--   1. 登录 https://supabase.com
--   2. 创建项目（免费层即可）
--   3. 进入项目 → SQL Editor → New query
--   4. 粘贴本文件全部内容 → Run
-- ============================================================

-- 待办表
CREATE TABLE IF NOT EXISTS todos (
  id            TEXT PRIMARY KEY DEFAULT ('t_' || encode(genrandom_bytes(12), 'hex')),
  text          TEXT NOT NULL CHECK (char_length(text) <= 200),
  completed     BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_by  TEXT,
  completed_at  TIMESTAMPTZ,

  -- 完成时必须有完成者
  CONSTRAINT completed_consistent CHECK (
    (completed = FALSE AND completed_by IS NULL AND completed_at IS NULL)
    OR
    (completed = TRUE AND completed_by IS NOT NULL AND completed_at IS NOT NULL)
  )
);

-- 排序查询用到的索引
CREATE INDEX IF NOT EXISTS idx_todos_completed_created
  ON todos (completed, created_at DESC);

-- 启用行级安全（Row Level Security）
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

-- 由于本应用是服务端用 service_role key 访问（绕过 RLS），
-- 这里给 anon 角色完全禁止策略（最安全）。
-- 应用层鉴权已通过登录态校验。
-- 如果你希望 anon 也能读取（不推荐），可以放开下面注释。
--
-- CREATE POLICY "anon_read_todos" ON todos
--   FOR SELECT TO anon USING (true);

-- 注：service_role 默认绕过所有 RLS，应用用此角色。
