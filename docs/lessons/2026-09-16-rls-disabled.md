# 2026-09-16：测试库 RLS 被手工关掉，无人发现

**关联规则**：AGENTS.md 铁律二（三个 preflight）、技术栈备忘（安全回归）

## 发生了什么

Supabase 安全顾问对**测试项目**报 CRITICAL `rls_disabled_in_public`：`profiles` 的 RLS 没开 ⇒
「拿到项目 URL 的任何人」可读可写该表（anon key 是公开的，硬编码在 `public/js/supabase.js`、
随 APK 分发）。

## 根因

**不是仓库漏写** —— `supabase/schema.sql` 里 `profiles` 一直是 `ENABLE ROW LEVEL SECURITY`；
是测试项目上被**手工改过**（同一时期那里还留着仓库里不存在的 `create_test_user` RPC，
可佐证跑过 ad-hoc SQL）。建表/改表都靠「粘贴一次」，之后**没有任何回读校验**。

## 关键认知

- `ENABLE ROW LEVEL SECURITY`（开关）与 `CREATE POLICY`（策略）是**两件事**，缺任一个洞都在；
- 「照文档粘贴过一次」挡不住漂移 —— 必须机器判定；
- 两套环境的**手工配置会各自漂移**（实测：生产 `disable_signup=true`、测试项目 `false`）
  ⇒ 每次都要回读校验，不能只看某一次。

## 修复与防回归（现在落地在 AGENTS.md）

- `node app-e2e/scripts/check-rls.mjs` —— 探针：anon + **必然违反外键**的 INSERT
  （42501 = 策略拦下了 / 约束错误 = RLS 没开；**不写任何数据**）
- `node scripts/test_rls_migration.mjs` —— 用 PGlite（真 Postgres 的 WASM 版）把加固 SQL 跑一遍：
  复现洞 → 修复 → 幂等；不需要凭据，进 CI
- `admin/scripts/init-test-env.mjs` 第 ④ 步跑 RLS 自检 ⇒ CI required job 里合并前拦住
