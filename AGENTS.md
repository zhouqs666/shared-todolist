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
- 任何删除操作前，**必须先备份**（`SELECT * INTO` 导出，或先查再删）
- 批量删除（如 `.neq('id', '全零')` 这种"删全部"的模式）**绝对禁止**，必须显式指定要删的 id
- 模拟器/真机测试时，用独立的测试账号或测试项目，不碰真实用户数据

**血泪教训：** 2026-07-31，为验证空状态 UI，对生产库执行 `supabase.from('todos').delete().neq(...)` 删全部，导致用户所有待办永久丢失，Free 套餐无备份，无法恢复。从此这条列为最高铁律。

---

## 铁律二：交付前必须全面测试，硬限制要列明

**所有功能开发完成、交付前，必须经过模拟器全面测试，不能凭想象宣布"完成"。**

- ✅ **跑测试前必须先起测试专用服务器**（铁律一）：
  ```bash
  node scripts/serve-test.mjs     # 测试服务器，端口 3100，连独立测试库
  node scripts/reset-test-db.mjs  # 归零测试库（清 E2E 残留 + 贴纸）
  python3 scripts/test_undo_complete.py   # 测试脚本自动连 3100 + 自证隔离
  ```
  测试脚本默认连 3100（测试库），**禁止指向 3000**（那是生产库）。指向生产会被 `e2e_common.py` 直接拦下、退出码 2。
- ✅ **测试库必须归零**：`tests` 末尾会自动调 `reset-test-db.mjs` 硬删；`E2E_KEEP_DATA=1` 可保留现场排查。
  **为什么不能只靠测试内部的删除**：那是**软删除**（`deleted_at` 打时间戳），行永远留在表里 —— 看着清了，其实越跑越脏。贴纸更麻烦：`sticker_key` 有 UNIQUE 约束、解锁幂等，一旦解锁就再也测不了「首次解锁」路径（开奖弹窗/庆祝动画/图鉴+1），盲盒的核心卖点在测试环境里失效。
- ✅ 核心流程 / 双端同步：用 Playwright 跑真实业务流程（Python 脚本 `scripts/test_*.py`，双账号 E2E，测试账号来自 `app-e2e/.env.test`）
- ✅ 局部回归：Node 脚本 `scripts/test_*.mjs` 跑在生产服务（:3000）上，**只读** —— 已由 `_lib-readonly-guard.mjs` 在网络层阻断写请求（不是靠自觉，也不是靠 token 恰好无效）
- ✅ 必须覆盖：核心功能、边界情况、错误处理、Realtime 双端同步
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
- 本地直跑：`node scripts/release.mjs <版本号> --notes "<说明>"`
- 远程跑（CD）：GitHub Actions → `CD · Web 热更新发布` → 填版本号，先 `dry_run=true` 看预演报告，
  确认后 `dry_run=false` + `confirm=<版本号>`，在 `production` 环境点 Approve 才真正写生产
- ✅ 发布后必须回读校验：`node scripts/verify-release.mjs [版本号]`（只读，验证版本行 enabled /
  Storage 对象可下载 / 包内 meta 一致）。**写成功 ≠ 客户端拿得到**，脚本没报错不等于交付完成
- ⚠️ 远程发布后仓库 `public/index.html` 的 meta 会落后线上 bundle（CI 运行器一次性），
  工作流会 warning 提示，需人工把制品里的 `index.html` 补提交，否则下次打 APK 多重启一次

**⚠️ 版本号必须比线上高（血泪教训）：**
- 发布前**必须先查线上最新版本**：`supabase.from('app_versions').select('version').eq('enabled',true).order('released_at',{ascending:false}).limit(1)`
- 新版本号必须**语义化大于**线上最新（如线上 2.2.4，新发要 ≥ 2.2.5）
- ❌ 禁止拍脑袋猜版本号（如看 `index.html` 里的 meta 值——那是源码默认值，和线上脱节）
- **血泪教训：** 2026-08-07，没查线上版本直接发 2.0.1，但线上已经 2.2.4，版本号低导致 App 判定"无更新"，用户连开几次都没变化。从此发布前必查线上版本。

### 通道 B：打 APK（原生层改动走这条）

**适用**：改了 Capacitor 插件、Android 配置、`capacitor.config.json`、原生权限等，热更新覆盖不到的地方。

- ✅ 跑 `node scripts/release-apk.mjs <版本号>`（自动：cap sync → gradle 打包 → 写 `app_native_versions` 表 → 上传 APK → 覆盖 `~/Desktop/有爱.apk`）
- ✅ 打包后必须验证：构建时间（确认是最新）、签名通过（`apksigner verify`）、关键改动已入包（unzip 检查）
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

### 发布前 5 步自检（每次发布都要走一遍）

1. 查线上 `app_versions` 最新版本号，新版本必须语义化更大
2. 跑回归测试（`scripts/test_*.py` + `scripts/test_*.mjs`），截图/断言确认
3. 涉及 SQL 改动 → 对话里贴可复制完整 SQL（不是只放 `.sql` 文件）
4. 涉及 APK 改动 → `apksigner verify` + 检查构建时间 + unzip 确认改动入包
5. 发布后回读校验 `node scripts/verify-release.mjs`（版本行 / Storage 对象 / 包内 meta），
   并 `git commit` 同步 `index.html` 的 meta；交付回复列明"已做 X / 已验证 Y / 未验证 Z"（铁律二的硬限制要标）

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
- 一个功能一个 commit，说清"做了什么"；一次发布版本 = 一个原子提交

### 例外（遇到必须停下询问）
- 改动中混入不属于本次任务的修改 → 先确认范围再提交
- 检测到敏感文件 → 停下
- 测试未通过 / 功能未完成 → 不提交

---

## 铁律六：提交前必须走代码审查（见 CODE-REVIEW.md）

**代码质量参差不齐的根源是「没有第二双眼睛」。一人公司没有 reviewer，就用 AI 审查 + Checklist 兜底。**

- 功能开发完成、回归测试通过后、`git commit` 之前，必须按 `CODE-REVIEW.md` 的六维度 Checklist 审查本次改动
- 审查结论分 🔴 阻断 / 🟡 建议 / 💭 建议：🔴 必须清零才能 commit；🟡 修复或豁免留注释
- 审查优先级：数据安全（铁律一）> 正确性 > 安全 > 可维护性 > 性能 > 测试（铁律二）
- 发布后发生事故 / 疑难 bug → 复盘根因，反哺进 `CODE-REVIEW.md` 的 Checklist（防同类问题再犯）
- **本文档只写「必须做」，不复制审查细节**：分级、六维度、四时点流程、AI 审查话术都在 `CODE-REVIEW.md`

---

## 补充：软删除（回收站）机制

鉴于数据丢失的惨痛教训，所有数据的"删除"操作都采用**软删除**：
- ✅ **数据层已实现**：`todos.deleted_at`、`daily_notes.deleted_at` 字段，删除只打时间戳，不物理移除
- ✅ **UI 层已实现**：回收站入口 + 恢复 / 永久删除（H1）、删除撤销 Toast（H2）
- ⏳ **定期清理**：30 天后真正物理清理（`scripts/cleanup-deleted.mjs` 占位，可手动跑）
- 这是防止误删/恶意删除的最后保障

---

## 技术栈备忘

- **前端**：原生 HTML/CSS/JS（无框架），ES Module
- **后端**：Supabase（PostgreSQL + Auth + Realtime），无自建服务器
- **打包**：Capacitor → Android APK（`com.love.todo`）
- **发布**：热更新（`release.mjs`；本地直跑 或 GitHub Actions `release-web.yml` 审批门跑）+ APK（`release-apk.mjs`）+ App 内自更新（`apk-update.js` + `ApkInstaller`）；发布后回读校验 `verify-release.mjs`
- **PWA**：`manifest.webmanifest` + `sw.js`（Service Worker v15，仅浏览器环境生效，原生环境 bypass）
- **Capacitor 插件**：`SystemBars` / `LocalNotifications` / `SplashScreen` / `CapacitorUpdater`（热更）/ 自研 `ApkInstaller`（APK 自更）
- **存储 bucket**：`todo-attachments`（图片附件，公开读）/ `app_updates`（热更新 zip + APK）
- **测试**：Playwright（Python 双账号 E2E，连测试库）+ Node 局部回归（可 mock）
- **CI/CD**：GitHub Actions 三个 workflow —— `ci.yml`（Node 回归 + admin Playwright E2E + **workflow 静态检查 actionlint**）、
  `e2e-app.yml`（构建测试 APK + 模拟器 + Appium，有 `paths` 过滤）、`release-web.yml`（热更新 CD，仅手动触发）。
  main 已开**分支保护**，required checks 取 `ci.yml` 三个 job；改代码走分支 + PR（见「铁律五 → main 分支保护」）
- **本地服务**：`node scripts/serve.mjs`（端口 3000，**生产库**，仅手动自测）／`node scripts/serve-test.mjs`（端口 3100，**测试库**，跑 E2E 必须用这个）
- **测试库维护**：`node scripts/reset-test-db.mjs`（归零，硬删 E2E 残留 + 贴纸）／`node scripts/check-test-env.mjs`（隔离自检）／`node app-e2e/scripts/check-test-schema.mjs`（schema 契约）
- **埋点状态**：⚠️ 目前零埋点，无法回答"哪个功能最常用""两人一天互动几次"。补基础埋点（北极星 = 双端同日活跃天数）在路线图 P0。
