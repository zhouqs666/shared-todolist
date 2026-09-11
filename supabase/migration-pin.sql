-- ============================================
-- 迁移：为 todos 表添加置顶（pin）功能
-- 执行位置：Supabase Dashboard → SQL Editor
-- 执行后效果：待办可置顶，置顶项显示在列表最上方
-- ============================================

-- 1. 添加 pinned 字段（BOOLEAN，默认 false = 未置顶）
ALTER TABLE todos ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT false;

-- 2. 添加字段注释
COMMENT ON COLUMN todos.pinned IS '是否置顶，置顶项显示在列表最上方';

-- 3. 创建复合索引：优化置顶查询性能
--    排序规则：pinned DESC（置顶在前）→ completed ASC（未完成在前）→ created_at DESC（新的在前）
CREATE INDEX IF NOT EXISTS idx_todos_pinned_completed_created
  ON todos (pinned DESC, completed ASC, created_at DESC);

-- 幂等设计：可重复执行，不会报错
