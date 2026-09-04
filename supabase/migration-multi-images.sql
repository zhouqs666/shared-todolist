-- 迁移：多图支持（image_paths JSONB 数组）
-- 旧 image_path 列不删不改，保留只读兼容；新功能读写 image_paths。
-- 幂等：可重复执行不出错。
-- 执行位置：Supabase Dashboard → SQL Editor → 粘贴 → Run

-- 1. 加 image_paths JSONB 列（存 URL 数组，如 ["https://...", "https://..."]）
ALTER TABLE todos ADD COLUMN IF NOT EXISTS image_paths JSONB;

-- 2. 迁移：把旧 image_path 单值复制到 image_paths 单元素数组
--    只填 image_paths 为 NULL 的行（已迁移过的不再覆盖，幂等）
UPDATE todos
SET image_paths = jsonb_build_array(image_path)
WHERE image_path IS NOT NULL AND image_paths IS NULL;

-- 说明：
-- - image_path 列保留不删（只读兼容，前端 toExternal 会优先读 image_paths、回退 image_path）
-- - 新待办/编辑图片都走 image_paths
-- - 执行后旧图自动出现在 image_paths，无需重新上传
