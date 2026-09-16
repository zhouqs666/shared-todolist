-- DORA 四指标所需的元数据列（2026-09-16，批次 E）
-- 幂等，可重复执行（全部 add column if not exists）。
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
