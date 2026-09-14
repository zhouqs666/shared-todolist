-- ============================================
-- 测试库 schema 补齐（幂等，可重复执行）
--
-- 背景（2026-09-14 血泪教训）：
--   测试库 schema 落后于迁移 → App 的 listTodos() 查询带 .order('pinned')，
--   而测试库 todos 没有 pinned 列 → PostgREST 报 42703（column does not exist）
--   → 整个列表请求失败 → 界面静默显示「空列表」。
--   E2E 侧表现为「元素找不到 / 期望 true 收到 false」，极易误判成元素定位或
--   时序问题（实际排查烧了好几轮 CI）。
--
-- 执行位置：测试项目 Supabase Dashboard → SQL Editor → 粘贴全部 → Run
-- 对应生产迁移：migration-pin.sql / migration-blindbox-stickers.sql /
--              migration-multi-images.sql / migration-add-last-seen.sql /
--              migration-login-count-glow.sql
-- 校验：cd app-e2e && node scripts/check-test-schema.mjs（应输出 ✅ 无漂移）
-- ============================================

-- ===== 1. todos 缺列（App 查询/写入依赖）=====

-- pinned：置顶。缺失会让 listTodos 的 ORDER BY 整体报错（本次故障根因）
ALTER TABLE todos ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT false;
COMMENT ON COLUMN todos.pinned IS '是否置顶，置顶项显示在列表最上方';

-- rarity / rarity_seen：盲盒隐藏款
ALTER TABLE todos ADD COLUMN IF NOT EXISTS rarity TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS rarity_seen BOOLEAN NOT NULL DEFAULT true;
COMMENT ON COLUMN todos.rarity IS '稀有度：common(普通)/rare(稀有)/epic(史诗)/legendary(传说)。隐藏款盲盒功能';

-- image_paths：多图附件（image_path 单图列测试库已存在）
ALTER TABLE todos ADD COLUMN IF NOT EXISTS image_paths JSONB;

-- ===== 2. pinned 复合索引（与生产一致）=====
CREATE INDEX IF NOT EXISTS idx_todos_pinned_completed_created
  ON todos (pinned DESC, completed ASC, created_at DESC);

-- ===== 3. profiles 缺列 =====
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS login_count_for_partner INT NOT NULL DEFAULT 0;

-- ===== 4. stickers 表：收集图鉴（两人共享）=====
CREATE TABLE IF NOT EXISTS stickers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sticker_key TEXT NOT NULL,
  rarity      TEXT NOT NULL CHECK (rarity IN ('rare','epic','legendary')),
  unlocked_by UUID NOT NULL REFERENCES auth.users(id),
  todo_id     UUID REFERENCES todos(id) ON DELETE SET NULL,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sticker_key)
);

CREATE INDEX IF NOT EXISTS idx_stickers_rarity ON stickers (rarity);

ALTER TABLE stickers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stickers_select_auth" ON stickers;
CREATE POLICY "stickers_select_auth" ON stickers
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "stickers_insert_auth" ON stickers;
CREATE POLICY "stickers_insert_auth" ON stickers
  FOR INSERT TO authenticated WITH CHECK (unlocked_by = auth.uid());
DROP POLICY IF EXISTS "stickers_update_auth" ON stickers;
CREATE POLICY "stickers_update_auth" ON stickers
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "stickers_delete_auth" ON stickers;
CREATE POLICY "stickers_delete_auth" ON stickers
  FOR DELETE TO authenticated USING (true);

-- ===== 5. 启用 Realtime（幂等写法，重复执行不报错）=====
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'stickers'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE stickers;
  END IF;
END $$;

-- ===== 6. RPC 函数（migration-login-count-glow.sql）=====
-- 遗漏后果：App 冷启动调用 increment_login_count 拿到 404，爱心光晕计数失效。
-- 契约检查器原先只校验表/列，漏了这个（假绿），现已补上函数维度。
CREATE OR REPLACE FUNCTION increment_login_count(target_uid UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE profiles SET login_count_for_partner = login_count_for_partner + 1
    WHERE id = target_uid;
END;
$$;

CREATE OR REPLACE FUNCTION consume_login_count(target_uid UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  consumed INT;
BEGIN
  SELECT login_count_for_partner INTO consumed
    FROM profiles WHERE id = target_uid;
  IF consumed IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE profiles SET login_count_for_partner = 0 WHERE id = target_uid;
  RETURN consumed;
END;
$$;

GRANT EXECUTE ON FUNCTION increment_login_count(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION consume_login_count(UUID) TO authenticated;

-- ===== 7. 验证 =====
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'todos'
--     AND column_name IN ('pinned','rarity','rarity_seen','image_paths');
-- 函数是否就位：看 PostgREST OpenAPI 的 /rpc/* 路径清单
--   curl -s "$E2E_SUPABASE_URL/rest/v1/" -H "apikey: $E2E_SUPABASE_ANON_KEY" | grep -o '/rpc/[a-z_]*'
