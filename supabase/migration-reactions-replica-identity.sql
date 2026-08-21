-- ============================================================
-- 迁移：reactions 表开启 REPLICA IDENTITY FULL（修复取消点赞不同步）
--
-- 使用方法：
--   打开 Supabase Dashboard → SQL Editor → 粘贴本文件全部内容 → Run
--
-- 背景（2026-08-21 排查「长按点赞显示 2 次」时发现）：
--   Supabase Realtime 对启用了 RLS 的表，在默认 replica identity 下
--   【不会向客户端推送 DELETE 事件】（官方文档明确要求 REPLICA IDENTITY FULL）。
--   后果：A 取消爱心后，B 的屏幕上爱心不会消失（要等刷新重拉），
--         且 B 本地残留"僵尸行"，后续自己取消时计数显示错乱。
--   表情的新增（INSERT/UPDATE）不受影响，此前双端贴表情一直是正常的。
--
-- 本语句幂等，可重复执行。
-- ============================================================

ALTER TABLE reactions REPLICA IDENTITY FULL;
