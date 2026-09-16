-- DORA 四指标所需的元数据列（2026-09-16，批次 E）
-- 幂等，可重复执行（全部 add column if not exists）。
--
-- 状态：生产项目 **2026-09-16 已执行**（执行证据与回读结果见文件末尾「执行记录」）；
--       测试项目**刻意不执行**（那里不建热更新表，属结构性隔离）。
--
-- ── 为什么要这几列 ────────────────────────────────────────────────
-- 1) **前置时间**（从提交到上线）需要一个锚点：原来 `app_versions` 只记 `released_at`，
--    表里没有任何"这次的代码是哪个 commit、什么时候提交的"信息 ⇒ 这项指标无法计算。
--    加 `commit_sha` + `commit_at` 后，前置时间 = released_at - commit_at，**表内自足**
--    （不需要事后去 git 里翻，也不会因为 someday 换仓库/重写历史而算不出来）。
-- 2) **变更失败率 / 恢复时间**需要区分「事故下线」与「例行/演练下线」：
--    只看 `enabled = false` 会把**演练**（2026-09-16 那次的 2.7.65）和**例行退役**
--    一并算成失败，失败率立刻失真。所以下线时把「时间 + 原因 + 是不是事故」记下来，
--    由**人**来分类（机器猜不出"这次下线是不是因为出事了"）。
--
-- ── 历史行怎么办 ──────────────────────────────────────────────────
-- 既有的行这些列都是 NULL，**不做任何回填**（那时候的 commit/原因已无从考证，编一个值
-- 比留空更糟）。因此：
--   · 前置时间只覆盖「本迁移之后发布的版本」
--   · 失败率/恢复时间只覆盖「本迁移之后被下线的版本」
-- `dora-metrics.mjs` 会把可计算的样本量与总部署数一起打印出来（不假装覆盖全部历史）。
--
-- ── 语义（新写入要维持的不变式）──────────────────────────────────
--   · `enabled = true`  ⟹  `disabled_at IS NULL`：恢复上线时必须把下线记录清掉，
--     否则"已恢复的版本"会被指标继续算作故障状态（`rollback.mjs --restore` 负责清空）。
--   · 反过来**不成立、也不该成立**：迁移前的老行就是 `enabled = false` 且 `disabled_at IS NULL`
--     —— 它们不是"违规"，而是"无归因的历史数据"。报告会把它们单独列出来、不计入任何指标。
--     （本迁移刻意不做回填，所以这类行会长期存在；断言"双向等价"会把自己的老数据判成错误。）

alter table public.app_versions
  add column if not exists commit_sha           text,
  add column if not exists commit_at            timestamptz,
  add column if not exists commit_dirty         boolean,
  add column if not exists disabled_at          timestamptz,
  add column if not exists disabled_reason      text,
  add column if not exists disabled_is_incident boolean;

alter table public.app_native_versions
  add column if not exists commit_sha           text,
  add column if not exists commit_at            timestamptz,
  add column if not exists commit_dirty         boolean,
  add column if not exists disabled_at          timestamptz,
  add column if not exists disabled_reason      text,
  add column if not exists disabled_is_incident boolean;

comment on column public.app_versions.commit_sha is
  '本次发布内容的来源 commit（回退包 = 旧 ref 的 sha）。NULL = 迁移前的老数据';
comment on column public.app_versions.commit_at is
  '该 commit 的提交时间（git %cI）。与 released_at 相减即前置时间';
comment on column public.app_versions.commit_dirty is
  '发布时 public/ 是否有未提交改动。true ⇒ 这一行不对应某个 commit 的精确内容，DORA 前置时间会跳过它';
comment on column public.app_versions.disabled_at is
  '下线时刻（rollback.mjs 写入）。NULL 且 enabled=false = 迁移前的老行或未记录';
comment on column public.app_versions.disabled_reason is
  '下线原因（rollback.mjs --reason）';
comment on column public.app_versions.disabled_is_incident is
  '是否事故下线。true 才计入 DORA 变更失败率；NULL = 未归类（不计入，但会在报告里单独列出）';

comment on column public.app_native_versions.commit_sha is
  '同 app_versions.commit_sha（通道 B / APK 壳）';
comment on column public.app_native_versions.commit_at is
  '同 app_versions.commit_at（通道 B / APK 壳）';
comment on column public.app_native_versions.commit_dirty is
  '发布时 public/ + android/ 是否有未提交改动（通道 B）';
comment on column public.app_native_versions.disabled_at is
  '同 app_versions.disabled_at（通道 B / APK 壳）';
comment on column public.app_native_versions.disabled_reason is
  '同 app_versions.disabled_reason（通道 B / APK 壳）';
comment on column public.app_native_versions.disabled_is_incident is
  '同 app_versions.disabled_is_incident（通道 B / APK 壳）';

-- ────────────────────────────────────────────────────────────
-- 执行记录
-- ────────────────────────────────────────────────────────────
-- 2026-09-16  生产项目：**已执行**（业主在 Dashboard → SQL Editor 全选粘贴 Run）
--
-- 执行前：本地用 PGlite（真 Postgres 的 WASM 版）把整份迁移**真跑过**
--   —— `node scripts/test_dora_migration.mjs`，36 项断言（幂等 / 12 列齐备且全部可空 /
--   列名与脚本对账 / 迁移前完整 select 会失败）。**没人当第一个试错者。**
--
-- 执行后独立只读复验（不信"我执行过了"这句话，逐项回读）：
--   · 两张表各 6 列全部可读 —— PostgREST 用完整列清单 select 成功 ⇒ 列名与类型都对
--   · 行数不变：app_versions 129 行 / app_native_versions 27 行（纯加列，不动一行数据）
--   · app_versions 129 行 = 129 个不同版本、无同版本多行（顺带核了表结构假设）
--   · 已有溯源/下线记录的行 = 0 —— **预期**，历史行刻意不回填（见文件头「历史行怎么办」）
--   · `dora-metrics.mjs` 不再打「数据库还没有 DORA 元数据列」的警告
--
-- ⚠️ 预期生效时点（别误判成"没生效"）：**下一条记录才产生样本** ——
--   下一次热更新发布写入 commit_*（前置时间出现第一个样本）；
--   下一次用 `rollback.mjs --incident` 下线才产生失败样本。
--   在此之前，报告里前置时间/失败率显示「—」是**正确状态**。
--
-- 测试项目 loveListTest：**刻意不执行** —— 测试库不建热更新表是结构性保证，
--   防止测试环境里的 App 去下载已发布的 bundle（见 AGENTS.md 铁律一）。
