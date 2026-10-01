-- =====================================================================
-- migration-reminders.sql —— 待办到点提醒（本地通知）
--
-- 用途：给 todos 加提醒三件套字段（时间 / 范围 / 设置者），
--       客户端据此在 App 内调度系统级本地通知（AlarmManager，App 被杀也响）。
--
-- 执行位置：Supabase Dashboard → SQL Editor（生产库与测试库各执行一次，
--           两边都要执行；先测试库验证，发布前再上生产库）。
--
-- 幂等性：ADD COLUMN IF NOT EXISTS + 判重再加 CHECK，可重复执行不出错。
-- 安全性：RLS 是表级策略（todos 四条 policy 均 USING/WITH CHECK (true)），
--         新列自动随表可读写，无需新增 policy；不加触发器、不动既有约束。
--
-- 设计说明：
--   · remind_scope 用 TEXT + CHECK 而非 CREATE TYPE 枚举：
--     app-e2e/scripts/check-test-schema.mjs 从 *.sql 推导列契约，
--     枚举类型会让它的自动修复 SQL 引用不存在的类型。
--   · 三列要么全空（无提醒）要么全非空（有提醒），仿 completed_consistent
--     的写法 —— 半空行一定是写入 bug，让 DB 拦住而不是靠前端自觉。
--   · remind_scope 是**相对设置者**的语义：
--       both    = 双方设备都响（默认）
--       self    = 只有设置者自己的设备响
--       partner = 只有对方的设备响
--     判断依据是 remind_by（谁设置的），接收端拿自己的 userId 对比。
-- =====================================================================

ALTER TABLE todos ADD COLUMN IF NOT EXISTS remind_at TIMESTAMPTZ;
COMMENT ON COLUMN todos.remind_at IS '到点提醒时间(UTC ISO;NULL=未设提醒)。客户端据此调度本地通知';

ALTER TABLE todos ADD COLUMN IF NOT EXISTS remind_scope TEXT;
COMMENT ON COLUMN todos.remind_scope IS '提醒范围(相对 remind_by):both=双方都响 / self=仅设置者 / partner=仅对方';

ALTER TABLE todos ADD COLUMN IF NOT EXISTS remind_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
COMMENT ON COLUMN todos.remind_by IS '提醒设置者的 user id(remind_scope 的参照点)';

-- 一致性约束：三列同空或同非空（幂等：存在即跳过）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'remind_consistent'
  ) THEN
    ALTER TABLE todos ADD CONSTRAINT remind_consistent CHECK (
      (remind_at IS NULL AND remind_scope IS NULL AND remind_by IS NULL)
      OR (remind_at IS NOT NULL AND remind_scope IS NOT NULL AND remind_by IS NOT NULL)
    );
  END IF;
END $$;

-- scope 值域约束（幂等：存在即跳过）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'remind_scope_allowed'
  ) THEN
    ALTER TABLE todos ADD CONSTRAINT remind_scope_allowed
      CHECK (remind_scope IN ('both', 'self', 'partner'));
  END IF;
END $$;
