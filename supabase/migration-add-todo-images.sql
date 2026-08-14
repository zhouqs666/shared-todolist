-- ============================================================
-- 迁移：为 todos 增加「图片附件」（一条待办最多一张图）
--
-- 使用方法：
--   打开 Supabase Dashboard → SQL Editor → 粘贴本文件全部内容 → Run
--
-- 本迁移幂等（可重复执行）：
--   - 列已存在则跳过（IF NOT EXISTS）
--   - bucket 已存在则跳过（ON CONFLICT）
--   - policy 先 DROP IF EXISTS 再 CREATE
--
-- 前置：无（独立于已有迁移，可单独运行）。
-- ============================================================

-- ===== 1. todos 表新增 image_path 列（可空）=====
-- 一条待办最多一张图，存 Storage 对象的完整 public URL；NULL 表示无图。
ALTER TABLE todos ADD COLUMN IF NOT EXISTS image_path TEXT;

-- ===== 2. 创建公开 Storage bucket =====
-- 公开 bucket：拿到 URL 即可读（路径含 todo UUID，不外传则无人猜到）。
-- 安全靠 RLS 控制写（只有 authenticated 能上/删）。
INSERT INTO storage.buckets (id, name, public)
VALUES ('todo-attachments', 'todo-attachments', true)
ON CONFLICT (id) DO NOTHING;

-- ===== 3. Storage RLS 策略（对齐项目"authenticated 共享读写"风格）=====
-- 与 todos 表策略一致：双人共享、互信，所有已登录用户可读写。
-- 安全前提：只有 2 个固定账号能注册（见 schema.sql 注释）。
DROP POLICY IF EXISTS "todo_attachments_select_auth" ON storage.objects;
CREATE POLICY "todo_attachments_select_auth" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'todo-attachments');

DROP POLICY IF EXISTS "todo_attachments_insert_auth" ON storage.objects;
CREATE POLICY "todo_attachments_insert_auth" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'todo-attachments');

DROP POLICY IF EXISTS "todo_attachments_update_auth" ON storage.objects;
CREATE POLICY "todo_attachments_update_auth" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'todo-attachments')
  WITH CHECK (bucket_id = 'todo-attachments');

DROP POLICY IF EXISTS "todo_attachments_delete_auth" ON storage.objects;
CREATE POLICY "todo_attachments_delete_auth" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'todo-attachments');

-- 说明：todos 表本身的 image_path 字段读写，复用现有 todos_*_auth 策略
-- （todos_update_auth 的 WITH CHECK (true) 不限制列内容，无需新增表级策略）。
