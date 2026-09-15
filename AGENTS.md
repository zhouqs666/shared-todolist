# 项目规则（铁律，不可违反）

> 以下规则由真实血泪教训总结，每一条都有代价。违反任何一条都视为严重事故。

---

## 铁律一：绝不触碰生产数据

**永远不要用生产数据库做测试、做演示、做截图。**

- ❌ 禁止：为了让列表变空而 `DELETE FROM todos`（哪怕带 WHERE）
- ❌ 禁止：为了演示功能而往生产库插测试数据后不清理，或清理时误删真实数据
- ❌ 禁止：在生产库上跑任何修改性 SQL（INSERT/UPDATE/DELETE）作为"验证"

**正确的做法：**
- 测试用**隔离的测试数据**：插入时打标记（如 text 前缀 "E2E-测试-"），验证完只删带标记的
- 任何删除操作前，**必须先备份**：`node scripts/backup-tables.mjs --reason "<原因>"`
  （只读导出到 `backups/`，与 `backups/incident-*.json` 同格式、存**完整行**、可恢复；
  注意不含 Storage 图片对象）
- 批量删除（如 `.neq('id', '全零')` 这种"删全部"的模式）**绝对禁止**，必须显式指定要删的 id
- 模拟器/真机测试时，用独立的测试账号或测试项目，不碰真实用户数据

**适用范围（2026-09-14 明确，避免两种误用）：**
- 本律约束的是**「为了验证而改生产数据」**：测试、演示、截图、排查。
- **发布（铁律三）与回滚**本身就要写生产表（`app_versions` / Storage），属**产品业务动作**，
  不属本律禁止范围 —— 但必须走审批门（见铁律三 CD 章节）。
- 判据一句话：**这个写操作是产品功能的一部分，还是为了「验证一下」？** 后者一律禁止。

**血泪教训：** 2026-07-31，为验证空状态 UI，对生产库执行 `supabase.from('todos').delete().neq(...)` 删全部，导致用户所有待办永久丢失，Free 套餐无备份，无法恢复。从此这条列为最高铁律。

---

## 铁律二：交付前必须全面测试，硬限制要列明

**所有功能开发完成、交付前，必须经过模拟器全面测试，不能凭想象宣布"完成"。**

- ✅ **跑测试前必须先起测试专用服务器**（铁律一）：
  ```bash
  node scripts/serve-test.mjs      # 测试服务器，端口 3100，连独立测试库
  node scripts/reset-test-db.mjs   # 归零测试库（清 E2E 残留 + 贴纸）
  node scripts/run-web-e2e.mjs     # 推荐：一次跑完 4 个用例（逐个归零 + 失败重试一次 + flaky 显式标记 + 汇总表）
  python3 scripts/test_undo_complete.py   # 也可单跑某个：脚本自动连 3100 + 自证隔离
  ```
  测试脚本默认连 3100（测试库），**禁止指向 3000**（那是生产库）。指向生产会被 `e2e_common.py` 直接拦下、退出码 2。
  单跑用例时记得自己先归零；`run-web-e2e.mjs` 会在每个用例前自动归零（用例之间不留隐含依赖）。
- ✅ **测试库必须归零**：`tests` 末尾会自动调 `reset-test-db.mjs` 硬删；`E2E_KEEP_DATA=1` 可保留现场排查。
  **为什么不能只靠测试内部的删除**：那是**软删除**（`deleted_at` 打时间戳），行永远留在表里 —— 看着清了，其实越跑越脏。贴纸更麻烦：`sticker_key` 有 UNIQUE 约束、解锁幂等，一旦解锁就再也测不了「首次解锁」路径（开奖弹窗/庆祝动画/图鉴+1），盲盒的核心卖点在测试环境里失效。
- ✅ 核心流程 / 双端同步：用 Playwright 跑真实业务流程（Python 脚本 `scripts/test_*.py`，双账号 E2E，测试账号来自 `app-e2e/.env.test`）
- ✅ 局部回归：Node 脚本 `scripts/test_*.mjs` 跑在生产服务（:3000）上，**只读** —— 已由 `_lib-readonly-guard.mjs` 在网络层阻断写请求（不是靠自觉，也不是靠 token 恰好无效）；并由 `scripts/check-test-guards.mjs` 在 CI 里做**结构性检查**（漏挂守卫直接红），不靠记忆
- ✅ 必须覆盖：核心功能、边界情况、错误处理、Realtime 双端同步
- ✅ **合并前置门 = CI required checks 全绿**（`ci.yml` 三个 job；main 已开分支保护，红灯合不进去）。
  ⚠️ 但**门禁覆盖 ≠ 测试全覆盖**，这是**有意的分层**（2026-09-14 批次 C 定型）：
  - **PR 门禁要「快而稳」**：只放 Node 回归 + admin Playwright E2E + workflow 静态检查。跑得慢会拖住每次合并，
    跑得不稳会让团队开始无视红灯。
  - **全量回归要「慢而全」**：4 个双账号 Playwright E2E（`scripts/test_blindbox.py` / `test_offline.py` /
    `test_trash.py` / `test_undo_complete.py`）走 **`.github/workflows/e2e-web-full.yml`** ——
    **每晚 02:00（北京）定时**跑（`schedule`，cron 按 UTC 写）+ 可手动 `workflow_dispatch`，
    由 `scripts/run-web-e2e.mjs` 驱动（逐文件归零 / 失败重试一次 / FLAKY 显式标记 / 汇总进 Run Summary）。
  - ⚠️ **该工作流不设 required check**（它不在 PR 上运行；设了会让 check 永远停在 "Expected" 而卡死 PR）。
    本地不跑也仍等于没覆盖 —— 夜里会跑，但**改动等待期内**要自己先跑一遍。
  - 另注意：**CI 绿灯 ≠ 交付物可用** —— 制品/发布结果要单独回读验证（见铁律三 `verify-release.mjs`）
- ✅ 测试要真实验证结果（截图、断言、状态检查），不能只看"没报错"就算过
- ✅ **测试前跑两个 preflight**：
  - `node scripts/check-test-env.mjs` —— Web 通道隔离（测试库 ≠ 生产库）
  - `node app-e2e/scripts/check-test-schema.mjs` —— 测试库 schema 契约（从 `supabase/*.sql` 推导表/列/**函数**，漂移会打印修复 SQL）
  测试库缺列/缺表会导致 `listTodos()` 整体报错、界面静默空列表，E2E 只报「元素找不到」，极易误判成定位/时序问题（2026-09-14 烧了多轮 CI）。缺 RPC 函数同理（`increment_login_count` 缺失时冷启动 404）。

**血泪教训（2026-09-14）：**
Web 通道原本没有测试库隔离。`scripts/serve.mjs` 托管的是生产 `public/`（其中 `supabase.js` 硬编码生产库 URL），而 `test_*.py` 直连 `localhost:3000` = 生产库。调试撤销完成功能时，在生产库创建 27 条测试待办，并因盲盒开奖发生在「添加」瞬间，误解锁 `legendary_1` 传说贴纸 —— 清待办也撤不回贴纸。
**根因**：隔离只做了 Android APK 通道（`build-test-apk.mjs`），Web 通道漏了。
**修复**：`serve-test.mjs`（运行时改写 supabase.js，生产文件零改动）+ `e2e_common.py`（fail-closed 隔离断言）+ `check-test-env.mjs`（隔离自检）。
**关键认知**：「E2E- 前缀 + 测完清理」这种软约定挡不住事故 —— 必须是物理隔离，不是命名约定。同理，「脚本本意只读」也挡不住事故（实测 `test_pinch.mjs` 漏 mock 了 `rpc/increment_login_count`，请求直接打到生产库，全靠假 JWT 被 401 才没写入）—— 只读必须是网络层阻断。

**如果有硬限制导致无法完整验证：**
- 必须在交付时**明确列出未验证的功能点**
- 标注未验证原因（如"无法模拟真机震动"、"无法测试 FCM 推送"）
- 绝不能把"没测"说成"已验证"或"应该没问题"

---

## 铁律三：交付必须让用户拿到（热更新优先，APK 兜底）

**改完代码 ≠ 交付。用户手机上跑的是 APK 内置的 web 资源，不是你电脑上的源码。改完必须发布，否则用户永远看不到改动。**

有两条交付通道 + 一条 App 内自更新机制：

### 通道 A：热更新（默认，纯前端改动走这条）

**适用**：只改了 `public/` 下的文件（HTML/CSS/JS、图片等），没动 Android 原生层（Capacitor 插件、`capacitor.config.json`、`AndroidManifest.xml` 等）。

- ✅ 改完代码 + 测试通过后，跑 `node scripts/release.mjs <版本号> --notes "<说明>"`
- 脚本自动：注入版本号 → 打包 public/ 为 zip → 上传 Supabase Storage（`app_updates` bucket）→ 写 `app_versions` 表
- 用户下次**冷启动** App 时自动拉取，无需重装 APK
- ✅ 告知用户：杀掉 App 重开两次（首次后台下载，二次生效）

**执行环境二选一（同一套脚本，不是两条通道）：**
- **发布前置（2026-09-14 明确）：目标改动必须已合并到 main。**
  CD 的 `workflow_dispatch` 在默认分支上出包（工作流内已加 dev 守卫：非 main 直接失败）；
  本地发布也应在 main 上、工作区干净时执行。在 feature 分支上发布 = **把没合并的代码发到线上**，
  并让 main 落后于线上（制造出「仓库 meta 与线上 bundle 不一致」那个隐患）。
- 本地直跑：`node scripts/release.mjs <版本号> --notes "<说明>"`
- 远程跑（CD）：GitHub Actions → `CD · Web 热更新发布` → 填版本号，先 `dry_run=true` 看预演报告，
  确认后 `dry_run=false` + `confirm=<版本号>`，在 `production` 环境点 Approve 才真正写生产
- ✅ 发布后必须回读校验：`node scripts/verify-release.mjs [版本号]`（只读，验证版本行 enabled /
  Storage 对象可下载 / 包内 meta 一致）。**写成功 ≠ 客户端拿得到**，脚本没报错不等于交付完成
- ✅ **版本真相 = 发布命令传入的版本号（+ `app_versions` 表），仓库不持有它**（2026-09-14 改）：
  `public/index.html` 里那两个 meta 恒为**占位值 `0.0.0`**，由构建期注入 ——
  热更新在 `release.mjs` 的**暂存副本**上注入（发布对工作区零改动），
  APK 由 `release-apk.mjs` 在 cap sync 后注入（`app-version` = 线上最新 web 版本，`shell-version` = 本次壳版本）。
  占位值是 fail-safe：万一漏注入，App 只会多重启一次，不会「本地偏高 → 永远收不到更新」。
  ⚠️ 因此**发布后不再需要任何 meta 补提交**（旧设计下的「补 PR + 11 分钟模拟器 CI」已随设计一并消失）

**⚠️ 版本号必须比线上高（血泪教训）：**
- 发布前**必须先查线上最新版本**：`node scripts/query-latest-version.mjs`（只读）
- 新版本号必须**语义化大于**线上最新（如线上 2.2.4，新发要 ≥ 2.2.5）
- ❌ 禁止拍脑袋猜版本号。**`index.html` 的 meta 不是权威**（2026-09-14 更正原措辞）：本地发布后
  它会被同步成最新版本，但 CI 发布后它会滞后 —— 唯一权威是 `app_versions` 表。
  好在这步已自动化：`release.mjs` 内置 `assertNewerThanLatest()`，版本号不够高会直接拒绝发布
- **血泪教训：** 2026-08-07，没查线上版本直接发 2.0.1，但线上已经 2.2.4，版本号低导致 App 判定"无更新"，用户连开几次都没变化。从此发布前必查线上版本。

### 通道 B：打 APK（原生层改动走这条）

**适用**：改了 Capacitor 插件、Android 配置、`capacitor.config.json`、原生权限等，热更新覆盖不到的地方。

**两个执行环境（同一套脚本，不是两条通道）：**

1. **本地直跑**：`node scripts/release-apk.mjs <版本号> [--notes "..."]`
2. **远程跑（CD，2026-09-15 起）**：GitHub Actions → `CD · APK 发布（原生壳）` → 先 `dry_run=true`
   看预演报告（**真构建**，产物可从 run 里下载安装验证），确认后 `dry_run=false` + `confirm=<版本号>`，
   在 `production` 环境点 Approve 才真正写生产

脚本自动：**cap sync** → 注入 assets 版本 meta → gradle 打包 → 校验包内 meta + 签名 →
写 `app_native_versions` 表 → 上传 APK → （本地跑时）覆盖 `~/Desktop/有爱.apk`

**⚠️ CI 发布的前置条件（两段式，必须先合再发）：**
版本号是发布命令传入的，但 **`versionCode` 在 `android/app/build.gradle` 里** ——
它属于代码改动，必须**先走 PR 合并到 main**，再触发发布工作流。
工作流内置 `sha_pinning_required` 同级的守卫：`versionCode` 必须大于**历史最大值（含已下线行）**，
否则发布被拒并提示"先去 PR 里升 versionCode"。

- ✅ 打包后必须验证：构建时间（确认是最新）、签名通过（`apksigner verify`，工作流里有独立步骤）、
  关键改动已入包（unzip 检查，脚本第 5b 步）
- ✅ 发布后必须回读校验：`node scripts/verify-apk-release.mjs [版本号]`（只读）——
  版本行 `enabled` / Storage 对象可下载且字节数一致 / **SHA-256 与表里一致** / 包内 meta 一致。
  ⚠️ 其中 SHA-256 这条是 APK 通道独有的关键项：`apk-update.js` 在唤起系统安装器**之前**会比对它，
  对不上就**拒绝安装**，用户侧表现是"下载完成后毫无反应"（服务端全绿）——
  和热更新通道的 `verify-release.mjs` 是同一个「写成功 ≠ 客户端拿得到」的道理
- ⚠️ **CI 发布不覆盖 `~/Desktop/有爱.apk`**（runner 没有你的桌面）。需要桌面留档时从 run 的
  artifact 下载，或本地跑一次；「桌面只留一个固定文件名」的纪律仍然只适用于本地打包
- ✅ 告知用户明确的 APK 路径和构建时间

### APK 自更新机制（App 内提示升级，与"打 APK"区分）

- `public/js/apk-update.js`：冷启动 + 前台切回（60 秒节流）时，用 `App.getInfo()` 读**真实 versionName**（非热更新 meta 值），与线上 `app_native_versions` 最新版本比对
- 命中更新 → 原生插件 `ApkInstaller` 下载（**sha256 校验**）→ 唤起系统安装器
- **强制更新**：`is_force_update=true` 或本地 < `min_supported_version` 时，更新面板不可关闭
- **版本号纪律**：`versionCode` 必须**严格递增**（脚本强制校验）

### APK 文件名固定，必须覆盖（不要堆积）

**桌面 APK 永远只有一个文件：`~/Desktop/有爱.apk`，每次打包直接覆盖它。**

- ✅ 打包后用固定文件名覆盖：`cp app-release.apk ~/Desktop/有爱.apk`（不是带时间戳的 `有爱-20260803_0705.apk`）
- ✅ 打包前先清理桌面的历史 APK（含旧时间戳文件名），只留覆盖后的那一个
- ❌ 禁止生成 `有爱-时间戳.apk` 这类带版本/时间的文件名，会造成一堆 APK 堆积，用户分不清哪个是最新
- **血泪教训：** 多次打包用了带时间戳文件名，桌面累积了一堆，用户困惑哪个能装。从此固定单一文件名 + 覆盖。

### SQL 迁移要可直接复制，不要只放文件里

**任何需要用户在 Supabase Dashboard 执行的 SQL，必须在交付回复里直接贴出可复制的完整 SQL，不能只写进 `.sql` 文件让用户自己去找。**

- ✅ 在对话回复里用代码块贴出**完整、可直接复制**的 SQL（用户全选 → 粘到 SQL Editor → Run）
- ✅ SQL 必须幂等（`ADD COLUMN IF NOT EXISTS` / `ON CONFLICT DO NOTHING` / `DROP POLICY IF EXISTS`），可重复执行不出错
- ✅ 附简短说明：去哪执行（Dashboard → SQL Editor）、执行后什么效果、不执行会怎样
- ✅ 同时保留 `.sql` 文件作为项目档案（方便后续查阅/版本管理），但**对话里必须再贴一次**
- ❌ 禁止只创建 `.sql` 文件然后说"见某某文件"，用户得自己打开文件复制
- **血泪教训：** 图片功能交付时 SQL 只写进了 `migration-add-todo-images.sql`，用户没看到可复制版本，差点漏执行，导致功能装上用不了。

### 发布前自检（每次发布都要走一遍）

1. **确认在 main 上、改动已合并、工作区干净**（CD 只从 main 出包；工作流内有 dev 守卫）
2. 查线上 `app_versions` 最新版本号（`node scripts/query-latest-version.mjs`），新版本必须语义化更大
3. 跑回归测试（`scripts/test_*.py` + `scripts/test_*.mjs`），截图/断言确认；**PR 的 required checks 必须全绿**
4. 涉及 SQL 改动 → 对话里贴可复制完整 SQL（不是只放 `.sql` 文件）
5. 涉及 APK 改动 → `apksigner verify` + 检查构建时间 + unzip 确认改动入包
6. 发布后回读校验 `node scripts/verify-release.mjs`（版本行 / Storage 对象 / 包内 meta）；
   若走 CI 发布，另外把 `index.html` 的 meta 通过 **PR** 补回（见通道 A 的「已知限制」）；
   交付回复列明"已做 X / 已验证 Y / 未验证 Z"（铁律二的硬限制要标）

---

## 铁律四：代码改动需同步更新文档

**代码和文档脱节 = 事故温床。任何改动都必须同步到对应文档。**

- 新增 / 修改数据库表字段 → 同步更新 `PRODUCT-SPEC.md` 的「数据模型」章节
- 新增 / 修改发布通道、原生插件、构建机制 → 同步更新本文档「铁律三」与「技术栈备忘」
- 新增 / 修改产品功能 → 同步更新 `PRODUCT-SPEC.md` 的「功能规格」章节
- 废弃 / 删除旧机制 → 同步清理相关文档描述（不要留下"已死代码"的文档）
- **开发前先自查**：本次改动是否需要更新文档？需要就先改文档，再改代码。

---

## 铁律五：代码改动自动提交（改完即提交，不再每次询问）

**原则**：一个功能/批次开发完成、测试通过后，自动 `git commit`，不再每次结尾问"要不要提交"。未测试通过、开发中途状态不提交。

### 提交时机（自动触发）
- 功能开发完成 + 回归测试通过 → 自动 commit
- 发布（热更新/APK）完成后 → 自动 commit
- 纯文档改动 → 改完即 commit

### 提交前自检（自动执行，不打扰用户）
1. `git status` 查看改动清单，确认无敏感文件混入
2. 确认 `.env` / `*.keystore` / `node_modules` 未进暂存区（已 `.gitignore` 兜底）
3. 确认无调试残留（`scripts/_debug-*.mjs`、`.release-tmp/`、`.probe/`）

### 提交边界（安全红线）
- **不直推 main**（`git push` 到 main 会被分支保护拒绝；直推一律不做）
- **合并 PR 等同于改 main**，只在**用户明确授权的任务范围内**执行（例：「做批次 B」即含完成该批次所需的分支、PR 与合并）；
  超出授权范围、或不确定是否属于当前任务 → 先问，不自动合并
- **push 功能分支 + 开 PR 属常规流程**（不直接改 main，且必须过 CI 才能合并），可自动执行
- 永不提交：`.workbuddy/`（本机记忆）、调试探针、临时产物
- 用 `git add` 指定文件/目录，不用裸 `git add -A` 一把梭

### main 分支保护（2026-09-14 起，流程变化必读）
main 现在是 protected，**直接 `git push` 到 main 会被拒**（GH013）。改代码走：
```bash
git switch -c <type>/<简短说明>     # 例如 fix/undo-toast-keyboard
git commit ...                      # 铁律五照旧：改完即提交
git push -u origin HEAD             # 推功能分支
gh pr create --fill                 # 开 PR；CI 必过（required checks）才能合
gh pr merge --squash --delete-branch  # 合并需用户明确指令
```
- **required checks 只含 `ci.yml` 的三个 job**（`Node Regression + Version Check` /
  `Admin E2E (Playwright + Allure)` / `Workflow Lint (actionlint)`）
- ⚠️ **不要把 `e2e-app.yml` / `release-web.yml` 的 job 设为 required**：前者有 `paths` 过滤、
  后者只在手动触发 → 它们在不匹配的 PR 上**永远不会运行**，check 会一直停在 "Expected"，把 PR 永久卡死
- 为什么这是唯一让 CI 有牙齿的方式：required checks 生效前，CI 跑得再红也不影响合并

### commit message 规范（Conventional Commits，中文描述）
- `feat:` 新功能 / `fix:` 修复 / `refactor:` 重构 / `docs:` 文档 / `chore:` 杂项
- **一个功能 = 一个 PR**（2026-09-14 对齐 squash merge）：分支内可以自由拆多个 commit 方便回溯，
  合并时 `gh pr merge --squash` 在 main 上合成 1 个 commit —— 所以「一个功能一个 commit」
  现在是指 **main 上的粒度**，不是分支内的粒度
- 一次发布版本 = 一个原子提交（发布相关的改动不要混进功能 PR）

### 例外（遇到必须停下询问）
- 改动中混入不属于本次任务的修改 → 先确认范围再提交
- 检测到敏感文件 → 停下
- 测试未通过 / 功能未完成 → 不提交

---

## 铁律六：提交前必须走代码审查（见 CODE-REVIEW.md）

**代码质量参差不齐的根源是「没有第二双眼睛」。一人公司没有 reviewer，就用 AI 审查 + Checklist 兜底。**

- 功能开发完成、回归测试通过后、**合并 PR 之前**（不是 `git commit` 之前 —— 现在提交到分支不产生 main 变更，真正的门是合并），必须按 `CODE-REVIEW.md` 的六维度 Checklist 审查本次改动
- 审查结论分 🔴 阻断 / 🟡 建议 / 💭 建议：🔴 必须清零才能 commit；🟡 修复或豁免留注释
- 审查优先级：数据安全（铁律一）> 正确性 > 安全 > 可维护性 > 性能 > 测试（铁律二）
- 发布后发生事故 / 疑难 bug → 复盘根因，反哺进 `CODE-REVIEW.md` 的 Checklist（防同类问题再犯）
- **本文档只写「必须做」，不复制审查细节**：分级、六维度、四时点流程、AI 审查话术都在 `CODE-REVIEW.md`

---

## 补充：凭据卫生（真实值绝不进仓库）

**本仓库是 public。任何提交进 git 的凭据都要当成"已经泄露"来处理。**

- ✅ 真值只放两处：本地 `.env*`（已 gitignore）与 **GitHub Secrets**（CI 用）
- ❌ 禁止出现在：`.example` 模板、文档（`*.md`）、代码、测试夹具、注释、SQL 文件、截图
  - 包括**真实账号标识**（邮箱 / 用户名）—— 它们不是密码，但和密码凑在一起就是完整凭据
- ✅ 自查命令：`git grep -nE "PASSWORD=[^y]|@todo\.local" -- '*.example' '*.md'`（应为空或仅占位符）
- ✅ **发现泄露时的正确顺序**：① **先改密码/轮换 key**（让泄露值当场失效）→ ② 再清理文件
  → ③ 复核历史提交里是否还有（`git log --all -S "<泄露值>"`）→ ④ 开 GitHub **secret scanning + push protection**
  - 删文件**不等于**修好：历史提交里仍然有，且可能已被克隆（`git log --all -S` 会告诉你从哪个 commit 开始）
  - 改写历史（force push）在本项目**不做**：main 有分支保护、收益小于代价 —— 轮换凭据才是根治

**血泪教训（2026-09-15）：** `admin/.env.test.example` 里写着真实账号邮箱 `xiaobaobao@todo.local` +
真实密码（值已在轮换时作废，此处不复述），**从 2026-09-08 起在公开仓库里躺了一周**。而生产账号用的是**同一个邮箱**
（App 的用户名/邮箱映射就写在 `public/js/auth.js` 里）—— 只要密码复用，"邮箱 + 密码"就是完全公开的，
任何人都能登进这个双人私密应用读写全部数据。发现时的排查线索：生产库里出现了一条
**查不到来源**的留言（软删除表里没有、代码里也没有物理删除路径），且 App 端表现"今早才出现、随后消失"。

**推论写进规则**：凭据卫生的失效**不会报错、不会报警**，只会以"莫名其妙的数据/登录"的形式出现 ——
所以它必须是**推送前的静态检查**（人工自查命令 + GitHub push protection），不能靠"我记得没写过"。

---

## 补充：软删除（回收站）机制

鉴于数据丢失的惨痛教训，所有数据的"删除"操作都采用**软删除**：
- ✅ **数据层已实现**：`todos.deleted_at`、`daily_notes.deleted_at` 字段，删除只打时间戳，不物理移除
- ✅ **UI 层已实现**：回收站入口 + 恢复 / 永久删除（H1）、删除撤销 Toast（H2）
- 这是防止误删/恶意删除的最后保障

### 保留策略：**决定不实现自动物理清理**（2026-09-14 决策，非遗漏）

**先纠正一处文档错误**：本节原写「30 天后物理清理（`scripts/cleanup-deleted.mjs` 占位，可手动跑）」，
但**该脚本从来不存在** —— 属铁律四禁止的「已死代码的文档」。现已按事实改正。

**决策：不做自动清理。** 理由（按重要性）：

1. **用户已经有了显式的物理删除入口**（回收站 → 永久删除）。自动清理会让系统**删掉用户没要求删的数据** ——
   对一个双人私密应用，这是纯粹的负价值。
2. **收益接近零**：软删除行只有 2 个用户产生，体量可忽略；不存在存储或性能压力。
3. **风险是本项目历史上最严重的那一类**：按时间谓词批量物理删真实数据。2026-07-31 的事故就是这个形状。
   「收益≈0、风险=历史最坏事故」的改动，正确做法是不做。
4. **行业实践并不要求它**：数据保留策略的要义是「**有意决定**保留多久」，而不是「默认必须清」。
   本项目的有意决定 = **无限期保留软删除数据，由用户在回收站自行永久删除**。

**触发重新评估的条件**（满足其一再考虑）：软删除数据量级增长到影响查询/存储；或出现隐私合规要求；
或用户明确想要「回收站 30 天自动过期」的产品行为。

**若将来要实现，硬约束如下**（不可削减）：
1. **默认 dry-run**，必须显式 `--apply` 才真删；先打印将要删除的行数与 id 清单
2. **先备份再删**：用 `node scripts/backup-tables.mjs --reason "..."`（与 `backups/incident-*.json` 同格式、
   存完整行、可恢复；不含 Storage 图片）
3. **禁止按谓词批量删**（铁律一）：先 SELECT 出 id 列表 → 落备份 → 再按**显式 id 列表**删
4. 只处理 `deleted_at` 超过保留期的行，并支持 `--keep-days N` 覆盖
5. **上线形态是「计划任务」要格外小心**：`schedule`（cron）触发 = **无人值守**，没有人在旁边看报告。
   因此必须：默认 dry-run → 先跑一段只报告不删 → 真要删时把删除与告警/报告一起上，
   且失败要能被看见（job 失败通知 / 制品留痕）
6. **在测试库上验证**（这正是独立测试项目的价值）：测试库有 `deleted_at` 数据且
   `scripts/reset-test-db.mjs` 会硬删——清理逻辑可以在这里跑通全流程，再碰生产

---

## 技术栈备忘

- **前端**：原生 HTML/CSS/JS（无框架），ES Module
- **后端**：Supabase（PostgreSQL + Auth + Realtime），无自建服务器
- **打包**：Capacitor → Android APK（`com.love.todo`）
- **发布**：**通道 A 热更新**（`release.mjs`；本地直跑 或 GitHub Actions `release-web.yml` 审批门跑）
  + **通道 B APK**（`release-apk.mjs`；本地直跑 或 `release-apk.yml` 审批门跑）
  + App 内自更新（`apk-update.js` + `ApkInstaller`）；
  发布后回读校验：通道 A 用 `verify-release.mjs`，通道 B 用 `verify-apk-release.mjs`（两者都是只读、可当 CI 门禁）
- **PWA**：`manifest.webmanifest` + `sw.js`（Service Worker v15，仅浏览器环境生效，原生环境 bypass）
- **Capacitor 插件**：`SystemBars` / `LocalNotifications` / `SplashScreen` / `CapacitorUpdater`（热更）/ 自研 `ApkInstaller`（APK 自更）
- **存储 bucket**：`todo-attachments`（图片附件，公开读）/ `app_updates`（热更新 zip + APK）
- **测试**：Playwright（Python 双账号 E2E，连测试库）+ Node 局部回归（可 mock）
- **CI/CD**：GitHub Actions **六个** workflow —— `ci.yml`（Node 回归 + admin Playwright E2E + **workflow 静态检查 actionlint** + 三个结构性检查）、
  `e2e-app.yml`（构建测试 APK + 模拟器 + Appium，有 `paths` 过滤）、
  `release-web.yml`（**通道 A 热更新 CD**，仅手动触发）、
  `release-apk.yml`（**通道 B APK 发布 CD**，仅手动触发；工序与 release-web.yml 同构：
  预演真构建 → 审批门 → 发布 → 回读校验）、
  `e2e-web-full.yml`（**定时全量回归**：每晚 02:00 北京 / `schedule` + `workflow_dispatch`，跑 4 个双账号 Python E2E）、
  `codeql.yml`（**静态代码扫描**：push / PR / 每周一定时；`security-events: write` 是它唯一需要的写权限）。
  main 已开**分支保护**，required checks 取 `ci.yml` 三个 job；改代码走分支 + PR（见「铁律五 → main 分支保护」）
  ⚠️ `schedule` 的 cron **按 UTC 解释**，且定时任务只在**默认分支**上运行（夜里跑的是 main 上已合并的代码）
  ⚠️ 两个「写生产」的工作流（release-web / release-apk）**共用 `contents: read` + `environment: production` 审批门**，
  但**各有各的 concurrency 组**（`release-web` / `release-apk`）—— 它们写的是不同的表/对象，互不冲突，不需要串行
- **供应链安全（2026-09-15 批次 D 起）**：所有 `uses:` **固定到完整 commit SHA**（+ `# vX.Y.Z` 注释，Dependabot 靠它识别版本）；
  仓库已开 `sha_pinning_required`（硬门禁）、secret scanning + push protection、Dependabot alerts / security updates、
  私密漏洞上报（`SECURITY.md`）；依赖版本更新由 `.github/dependabot.yml` 驱动
  （⚠️ **刻意不含 gradle**：`android/` 是 Capacitor 生成工程，兼容区间由上游定，盲升大概率红，
  而"有没有 CVE"已由 alerts 覆盖 —— 原生层只要可见性，不要自动改代码）
  ⚠️ **"固定 SHA" 与 "Dependabot 推更新" 是一对，缺一不可**：只固定 = 冻在旧版本、安全补丁进不来
  ⚠️ 取 SHA：`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`（`type=tag` 时再解一层 `git/tags/<sha>`）
- **本地服务**：`node scripts/serve.mjs`（端口 3000，**生产库**，仅手动自测）／`node scripts/serve-test.mjs`（端口 3100，**测试库**，跑 E2E 必须用这个）
- **测试库维护**：`node scripts/reset-test-db.mjs`（归零，硬删 web 通道 E2E 残留 + 贴纸）／`node scripts/check-test-env.mjs`（隔离自检）／`node app-e2e/scripts/check-test-schema.mjs`（schema 契约）
- **Web E2E 跑批**：`node scripts/run-web-e2e.mjs`（逐个归零 + 失败重试一次 + flaky 显式标记 + Run Summary；`--files` / `--keep-data` / `--no-retry` / `--fail-on-flaky`）；
  依赖钉在 `scripts/requirements-e2e.txt`（Python playwright，CI 与本地同版本）
- **结构性检查（CI required job 里跑，都是纯静态、秒级失败）**：`check-test-guards.mjs`（只读守卫）／
  `check-e2e-env-keys.mjs`（凭证键三方一致：代码读取 / 模板 / 两个工作流生成）／
  `check-actions-pinned.mjs`（**actions 必须固定到完整 SHA 且带 `# vX.Y.Z` 注释** —— 仓库设置里的
  `sha_pinning_required` 也拦得住未固定（实测：该 job 在 "Set up job" 阶段就失败并给出明确报错）；
  但它**不查版本注释**，而注释是 Dependabot 判断当前版本的唯一依据，缺了 = 安全补丁静默进不来。
  所以本脚本的价值是「本地秒级反馈 + 补上开关查不了的那条规则」）
- **埋点状态**：⚠️ 目前零埋点，无法回答"哪个功能最常用""两人一天互动几次"。补基础埋点（北极星 = 双端同日活跃天数）在路线图 P0。
