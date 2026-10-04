-- ============================================================
-- 迁移：图鉴升星（闪卡 / 烫金）—— docs/sticker-book-roadmap.md §7（批次 4）
--
-- 功能说明：
--   stickers 表加 star_level（星级）。升星期（已上线的册全部集齐后，D12）开出隐藏款
--   不再解锁新贴纸，而是给「该册该档最低序号的未满星贴纸」+1 星：
--     0 = 普通 → 1 = 闪卡 → 2 = 烫金（上限 2）
--   图鉴可收集空间由此从 12 态扩到 36 态（每册 12 张 × 3 星级）。
--
-- 使用方法：
--   主通道：node scripts/apply-sql.mjs supabase/migration-sticker-star.sql --project test --apply
--           （生产：--project prod --apply --confirm migration-sticker-star.sql）
--   兜底：Supabase Dashboard → SQL Editor → 粘贴本文件全部内容 → Run
--
-- 本迁移幂等（可重复执行）：字段用 IF NOT EXISTS，重复执行无副作用。
-- 纯加列（带默认值），老版本客户端 SELECT 指定列不受影响；新客户端在
-- 未升列的库上会因缺列报错 —— 故发布顺序必须先应用本迁移、再发热更。
-- ============================================================

-- 星级：0=普通 / 1=闪卡 / 2=烫金。历史行回填为 0（默认值），已解锁贴纸视为普通态
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS star_level SMALLINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN stickers.star_level IS '图鉴升星（批次 4）：0=普通/1=闪卡/2=烫金，上限 2。升星期内开出隐藏款时按"该册该档最低序号的未满星贴纸"+1';

-- 验证（可选，执行后应看到 star_level / smallint / yes）
-- SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns WHERE table_name = 'stickers' AND column_name = 'star_level';
