-- ============================================================
-- 打开计数光晕：记录"对方没看到时我打开了 App 几次"
-- ============================================================
-- 用途：A 每次冷启动 App（不管登录态）给自己 login_count_for_partner +1；
--       B 打开 App 时读 A 的计数 N，爱心闪 N 下光晕，然后清零 A 的计数。
--       就像"未读消息"——看完即清零。
--
-- 注意：计数的是"打开 App 次数"，不是"登录次数"。
--       Supabase 用持久化 session，登录一次后下次打开是登录态，但仍算一次"打开"。
--
-- 执行位置：Supabase Dashboard → SQL Editor → 粘贴全选 → Run
-- 幂等：可重复执行不出错
-- ============================================================

-- 1. profiles 加字段：给对方看的打开计数（对方看过后会清零）
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS login_count_for_partner INT NOT NULL DEFAULT 0;

-- 回填现有用户
UPDATE profiles SET login_count_for_partner = 0 WHERE login_count_for_partner IS NULL;

-- 2. RPC 函数：原子地自增自己的打开计数
--    用 RPC 而非前端 read-modify-write，避免双人同时打开时的竞态丢失。
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

-- 3. RPC 函数：原子地"读取并清零指定用户的计数"
--    为什么用 RPC：RLS 只允许改自己，但 B 要清零 A 的计数，必须绕过 RLS。
--    SECURITY DEFINER 以函数 owner（postgres）权限执行，绕过调用者的 RLS。
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

-- 4. 允许登录用户调用这两个 RPC
GRANT EXECUTE ON FUNCTION increment_login_count(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION consume_login_count(UUID) TO authenticated;

-- ============================================================
-- 执行结果验证（可在 SQL Editor 单独跑）：
--   select id, username, login_count_for_partner from profiles;
--   select consume_login_count('<某个用户id>');  -- 测试读取并清零
-- ============================================================
