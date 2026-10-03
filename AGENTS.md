# 项目规则（铁律，不可违反）

> 以下规则由真实事故总结而来，每一条都有代价。违反任何一条都视为严重事故。
> 完整事故复盘（发生了什么 / 根因 / 修复与防回归）在 **docs/lessons/**（索引见
> [docs/lessons/README.md](docs/lessons/README.md)），本文件只保留规则本体 + 一行教训要点。

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
  不属本律禁止范围 —— 但必须走审批门（见铁律三）。
- 判据一句话：**这个写操作是产品功能的一部分，还是为了「验证一下」？** 后者一律禁止。

**为什么「测试已全面隔离」的今天这条仍然必要（2026-10-03 复评）：**
① 生产合法写通道仍常用（release / rollback / apply-sql / release-apk），上面那句判据是它们的边界定义；
② `check-test-guards.mjs` 等"漏挂守卫直接红"的基建，存在依据就是本条 —— 规则删了，守卫就成了无动机的"死代码"；
③ 隔离基建自身会漂移（RLS 曾被手工关掉、`test_pinch.mjs` 漏 mock 打到生产），本条是基建失效时的不变量；
④ Dashboard 手工 SQL、AI"验证一下"的冲动、演示截图 —— 基建管不到的路径。

**教训：** [docs/lessons/2026-07-31-prod-data-loss.md](docs/lessons/2026-07-31-prod-data-loss.md)
—— 为验证空状态 UI 执行谓词批量删，用户全部待办永久丢失，Free 套餐无备份不可恢复。

---

## 铁律二：交付前必须全面测试，硬限制要列明

**所有功能开发完成、交付前，必须经过全面测试，不能凭想象宣布"完成"。**

- ✅ **跑测试前必须先起测试专用服务器**（铁律一）：
  ```bash
  node scripts/serve-test.mjs      # 测试服务器，端口 3100，连独立测试库
  node scripts/reset-test-db.mjs   # 归零测试库（清 E2E 残留 + 贴纸）
  node scripts/run-web-e2e.mjs     # 推荐：一次跑完 8 个用例（逐个归零 + 失败重试一次 + flaky 显式标记 + 汇总表）
  python3 scripts/test_undo_complete.py   # 也可单跑某个：脚本自动连 3100 + 自证隔离
  ```
  测试脚本默认连 3100（测试库），**禁止指向 3000**（那是生产库）。指向生产会被 `e2e_common.py` 直接拦下、退出码 2。
  单跑用例时记得自己先归零；`run-web-e2e.mjs` 会在每个用例前自动归零（用例之间不留隐含依赖）。
- ✅ **测试库必须归零**：`tests` 末尾会自动调 `reset-test-db.mjs` 硬删；`E2E_KEEP_DATA=1` 可保留现场排查。
  **为什么不能只靠测试内部的删除**：那是**软删除**（`deleted_at` 打时间戳），行永远留在表里 —— 看着清了，其实越跑越脏。
  贴纸更麻烦：`sticker_key` 有 UNIQUE 约束、解锁幂等，一旦解锁就再也测不了「首次解锁」路径
  （开奖弹窗/庆祝动画/图鉴+1），盲盒的核心卖点在测试环境里失效。
- ✅ 核心流程 / 双端同步：用 Playwright 跑真实业务流程（Python 脚本 `scripts/test_*.py`，双账号 E2E，
  测试账号来自 `app-e2e/.env.test`）
- ✅ 局部回归：Node 脚本 `scripts/test_*.mjs` 跑在生产服务（:3000）上，**只读** —— 已由 `_lib-readonly-guard.mjs`
  在网络层阻断写请求（不是靠自觉，也不是靠 token 恰好无效）；并由 `scripts/check-test-guards.mjs` 在 CI 里做
  **结构性检查**（漏挂守卫直接红），不靠记忆
- ✅ 必须覆盖：核心功能、边界情况、错误处理、Realtime 双端同步
- ✅ 测试要真实验证结果（截图、断言、状态检查），不能只看"没报错"就算过
- ✅ **测试前跑三个 preflight**：
  - `node scripts/check-test-env.mjs` —— Web 通道隔离（测试库 ≠ 生产库）
  - `node app-e2e/scripts/check-test-schema.mjs` —— 测试库 schema 契约（从 `supabase/*.sql` 推导表/列/**函数**，
    漂移会打印修复 SQL）。缺列/缺表会导致 `listTodos()` 整体报错、界面静默空列表，E2E 只报「元素找不到」，
    极易误判成定位/时序问题（2026-09-14 烧了多轮 CI）。缺 RPC 函数同理（`increment_login_count` 缺失时冷启动 404）
  - `node app-e2e/scripts/check-rls.mjs` —— 测试库**表 RLS + 函数执行权限**是否真的生效（anon 视角探针）
- ✅ **合并前置门 = CI required checks 全绿**（`ci.yml` 三个 job；main 已开分支保护，红灯合不进去）。
  ⚠️ 但**门禁覆盖 ≠ 测试全覆盖**，这是**有意的分层**（2026-09-14 批次 C 定型）：
  - **PR 门禁要「快而稳」**：只放 Node 回归 + admin Playwright E2E + workflow 静态检查。跑得慢会拖住每次合并，
    跑得不稳会让团队开始无视红灯。
  - **全量回归要「慢而全」**：8 个双账号 Playwright E2E（`scripts/test_blindbox.py` / `test_offline.py` /
    `test_trash.py` / `test_undo_complete.py` / `test_pin.py` / `test_reminder.py` / `test_camera_image.py` /
    `test_note_ceremony.py`）走 **`.github/workflows/e2e-web-full.yml`** ——
    **每晚 02:17（北京）定时**跑（`schedule`，cron 按 UTC 写）+ 可手动 `workflow_dispatch`，
    由 `scripts/run-web-e2e.mjs` 驱动（逐文件归零 / 失败重试一次 / FLAKY 显式标记 / 汇总进 Run Summary）。
  - ⚠️ **该工作流不设 required check**（它不在 PR 上运行；设了会让 check 永远停在 "Expected" 而卡死 PR）。
    本地不跑也仍等于没覆盖 —— 夜里会跑，但**改动等待期内**要自己先跑一遍。
  - 另注意：**CI 绿灯 ≠ 交付物可用** —— 制品/发布结果要单独回读验证（见铁律三 `verify-release.mjs`）
- ✅ 为什么隔离必须是物理的、守卫必须挂网络层（Web 通道曾把 27 条测试数据写进生产库）：
  [docs/lessons/2026-09-14-web-channel-isolation.md](docs/lessons/2026-09-14-web-channel-isolation.md)；
  为什么"粘贴过一次"挡不住漂移（测试库 RLS 被手工关掉无人发现）：
  [docs/lessons/2026-09-16-rls-disabled.md](docs/lessons/2026-09-16-rls-disabled.md)

**如果有硬限制导致无法完整验证：**
- 必须在交付时**明确列出未验证的功能点**，标注未验证原因（如"无法模拟真机震动"、"无法测试 FCM 推送"）
- 绝不能把"没测"说成"已验证"或"应该没问题"

---

## 铁律三：交付必须让用户拿到（热更新优先，APK 兜底）

**改完代码 ≠ 交付。用户手机上跑的是 APK 内置的 web 资源，不是你电脑上的源码。改完必须发布，否则用户永远看不到改动。**

有两条交付通道 + 一条 App 内自更新机制。

### 通道 A：热更新（默认，纯前端改动走这条）

**适用**：只改了 `public/` 下的文件（HTML/CSS/JS、图片等），没动 Android 原生层（Capacitor 插件、
`capacitor.config.json`、`AndroidManifest.xml` 等）。

- ✅ 改完代码 + 测试通过后，跑 `node scripts/release.mjs <版本号> --notes "<说明>"`
  （自动：注入版本号 → 打包 public/ 为 zip → 上传 Supabase Storage `app_updates` bucket → 写 `app_versions` 表）
- ✅ 告知用户：**打开一次 App 即可**（不是"重开两次"）。`update.js` 是 `download → set → 立即 reload()`，
  **同一个会话内**就完成切换（重载前用原生 SplashScreen 盖住，用户看到「粉色爱心 → 平滑过渡」）；
  「杀掉重开两次」只在用户于下载完成前就把 App 杀掉时才需要
- ✅ **发布前置（2026-09-14 明确）：目标改动必须已合并到 main。**
  CD 的 `workflow_dispatch` 在默认分支上出包（工作流内已加 dev 守卫：非 main 直接失败）；
  本地发布也应在 main 上、工作区干净时执行。在 feature 分支上发布 = **把没合并的代码发到线上**
- 执行环境二选一（同一套脚本，不是两条通道）：本地直跑；或远程 CD —— GitHub Actions → `CD · Web 热更新发布` →
  先 `dry_run=true` 看预演报告，确认后 `dry_run=false` + `confirm=<版本号>`，在 `production` 环境点 Approve 才真正写生产
- ✅ 发布后必须回读校验：`node scripts/verify-release.mjs [版本号]`（只读：版本行 enabled / Storage 对象可下载 /
  包内 meta 一致）。**写成功 ≠ 客户端拿得到**，脚本没报错不等于交付完成
- ✅ **版本真相 = 发布命令传入的版本号（+ `app_versions` 表），仓库不持有它**（2026-09-14 改）：
  `public/index.html` 里那两个 meta 恒为**占位值 `0.0.0`**，由构建期注入 —— 热更在 `release.mjs` 的**暂存副本**上注入
  （发布对工作区零改动），APK 由 `release-apk.mjs` 在 cap sync 后注入。占位值是 fail-safe：万一漏注入，
  App 只会多重启一次，不会「本地偏高 → 永远收不到更新」。⚠️ 因此**发布后不再需要任何 meta 补提交**

**⚠️ 版本号必须比线上高：**
- 发布前**必须先查线上版本信息**：`node scripts/query-latest-version.mjs`（只读，打印两个口径：
  最新 enabled 版本 + **历史最高版本**）
- 新版本号必须**语义化大于「历史上出现过的最高版本」**，不只是大于 enabled 的最新的那个（2026-09-16 收紧）：
  已下线的版本号也算"用过" —— 客户端判定更新是「服务端版本 ≤ 本地版本 → 无更新」，而设备本地版本
  可能是某个曾经下发、后来被下线的版本，只跟 enabled 行比会放行那批设备
- ❌ 禁止拍脑袋猜版本号。**`index.html` 的 meta 不是权威**，唯一权威是 `app_versions` 表
- 好在这步已自动化：`release.mjs` 内置 `assertNewerThanLatest()`，版本号不够高会直接拒绝发布
- 教训：[docs/lessons/2026-08-07-stale-version-no-update.md](docs/lessons/2026-08-07-stale-version-no-update.md)
  （没查线上直接发 2.0.1，线上已 2.2.4，用户连开几次都没变化）

**⚠️ 「下线」≠「回滚」（别再把前者当后者）：**

- **下线 / 止损**：`node scripts/rollback.mjs <版本号>`（热更新）/ `... <版本号> --native`（APK 壳）——
  把对应版本表的 `enabled` 置 `false`。另有 `--restore`（撤销误下线）与 `--dry-run`（只看影响不写生产）。
  效果是**还没更新的设备 + 新装机**不会再拿到这个版本。
  ⚠️ 通道 B 特有：关掉**唯一**的启用壳版本后，**所有设备都不再收到壳更新提示**（脚本会把这个后果先打出来）；
  壳安装是用户手动点的，止损对"已经点了安装的人"无效。
  ❌ 它**不能把已经更新的设备退回去**：那些设备本地版本已经更高，服务端"最新"比它低 → 判定无更新 → 永远停在那儿。
- **真回滚 / 恢复（通道 A）**：`node scripts/release.mjs <新版本号> --from-git <旧 ref>` ——
  内容取自旧 ref 的 `public/`、版本号用更高的新号、包内 meta 注入**新号**
  （⚠️ 包内 meta 若是旧号，客户端下完会判定"又有新版本"→ **无限重装**）。
  任意 git ref 可用（annotated tag 也能直接用）。先 `--dry-run` 预演（会打印"本次将回退掉哪些改动"）。
  因为是重发已发布过的旧代码，此模式下「改动必须先合并 main」这条前置不适用。
- **回滚锚点用 tag，不要用本地分支**（2026-09-16 定型，实测过）：`git tag -a anchor/<版本或日期>-<主题> <sha>`
  **并 `git push origin <tag>`**。本地 `backup/*` 分支**不是备份** ——
  教训：[docs/lessons/2026-09-16-backup-branches.md](docs/lessons/2026-09-16-backup-branches.md)
- **通道 B 的 `--from-git`（退回旧壳）：决定暂不实现**（2026-09-16 决策；2026-10-03 复评，**结论维持、理由更新为事实版**）：
  - 复评依据：壳已发布多个版本（2.8.0 误发布后已 `enabled=false`、2.8.1 事故壳），「还没发过壳版本、没有真实基线」
    的前提已不存在；2.8.1 事故的实际止损 = `rollback --native` 下线 + 热更 2.7.78 修复，坏壳设备拉热更后**自愈** ——
    实证了「发一个修好的更高版本」足以止损；且 Android 不允许 versionCode 更低的包覆盖安装，"退回旧壳"只能是
    「旧壳代码 + 更高的 versionCode」，实现路径重、易写错，收益未超过成本
  - 坏壳止损手段（在它落地之前）：`rollback.mjs <版本号> --native`（停止推送）+ 发一个修好的更高版本 ——
    ⚠️ 前者救不了已经装了坏包的人
  - 重新评估触发条件：出现「新壳启动即崩、旧壳可用」且热更无法覆盖的故障形态
- **自动兜底只有一种**：`resetWhenUpdate:true`（连续启动崩溃 3 次自动回退）—— **只覆盖崩溃类故障**。
  UI / 文案 / 逻辑类问题（App 照常启动）不会触发它，只能靠上面两条命令。

### 通道 B：打 APK（原生层改动走这条）

**适用**：改了 Capacitor 插件、Android 配置、`capacitor.config.json`、原生权限等，热更新覆盖不到的地方。

- 执行环境二选一（同一套脚本）：本地 `node scripts/release-apk.mjs <版本号> [--notes "..."]`；
  或远程 CD —— GitHub Actions → `CD · APK 发布（原生壳）` → 先 `dry_run=true` 看预演报告（**真构建**，
  产物可从 run 里下载安装验证），确认后 `dry_run=false` + `confirm=<版本号>`，在 `production` 环境点 Approve
- 脚本自动：**cap sync** → 注入 assets 版本 meta → gradle 打包 → 校验包内 meta + 签名 →
  写 `app_native_versions` 表 → 上传 APK → （本地跑时）覆盖 `~/Desktop/有爱.apk`

**⚠️ CI 发布的前置条件（两段式，必须先合再发）：**
版本号是发布命令传入的，但 **`versionCode` 与 `versionName` 都在 `android/app/build.gradle` 里** ——
它们属于代码改动，必须**先走 PR 合并到 main**，再触发发布工作流。
`release-apk.mjs` 对这两项都有守卫，任一对不上就拒绝发布（并**一次性报出全部不一致**，不用来回跑两轮）：

- **`versionName` 必须逐字等于本次发布的版本号。** 客户端把 **APK manifest 里的 versionName**
  当本地版本（`apk-update.js` 用 `App.getInfo().version`），再和表里的 `version_name` 比 ——
  两者不等就会「表说 A、装的包自报 B」⇒ App **反复提示同一次更新，用户陷入无限重装**。
  教训：[docs/lessons/2026-09-04-apk-infinite-reinstall.md](docs/lessons/2026-09-04-apk-infinite-reinstall.md)
- **`versionCode` 必须严格递增**，基准是**含已下线行**的历史最大值（Android 不允许同码覆盖安装；
  2.8.0 误发布后已 `enabled=false`，但它的 code 33 已经用掉了）
- `--code` 参数**不允许**与 `build.gradle` 不一致：APK 里真实的 code 永远取自 `build.gradle`，
  用 `--code` 覆盖只会让**表里记的号和包里装的不一致**

- ✅ 打包后必须验证：构建时间（确认是最新）、签名通过（`apksigner verify`，工作流里有独立步骤）、
  关键改动已入包（unzip 检查，脚本第 5b 步）
- ✅ 发布后必须回读校验：`node scripts/verify-apk-release.mjs [版本号]`（只读）——
  版本行 `enabled` / Storage 对象可下载且字节数一致 / **SHA-256 与表里一致** / 包内 meta 一致。
  ⚠️ SHA-256 是 APK 通道独有的关键项：`apk-update.js` 在唤起系统安装器**之前**会比对它，
  对不上就**拒绝安装**，用户侧表现是"下载完成后毫无反应"（服务端全绿）——
  和热更新通道的 `verify-release.mjs` 是同一个「写成功 ≠ 客户端拿得到」的道理
- ⚠️ **CI 发布不覆盖 `~/Desktop/有爱.apk`**（runner 没有你的桌面）。需要桌面留档时从 run 的
  artifact 下载，或本地跑一次

### APK 自更新机制（App 内提示升级，与"打 APK"区分）

- `public/js/apk-update.js`：冷启动 + 前台切回（60 秒节流）时，用 `App.getInfo()` 读**真实 versionName**
  （非热更新 meta 值），与线上 `app_native_versions` 最新版本比对
- 命中更新 → 原生插件 `ApkInstaller` 下载（**sha256 校验**）→ 唤起系统安装器
- **强制更新**：`is_force_update=true` 或本地 < `min_supported_version` 时，更新面板不可关闭
- **版本号纪律**：`versionCode` 必须**严格递增**（脚本强制校验）

### APK 文件名固定，必须覆盖（不要堆积）

**桌面 APK 永远只有一个文件：`~/Desktop/有爱.apk`，每次打包直接覆盖它。**

- ✅ 打包前先清理桌面的历史 APK（含旧时间戳文件名），打包后用固定文件名覆盖
- ❌ 禁止生成 `有爱-时间戳.apk` 这类带版本/时间的文件名，会堆积一堆、用户分不清哪个是最新

### SQL 迁移怎么交付（2026-10-03 更新：apply-sql.mjs 为主，Dashboard 粘贴为兜底）

- ✅ **主通道**：`node scripts/apply-sql.mjs supabase/xxx.sql --project test --apply` ——
  走 Management API 把幂等迁移打到指定项目；默认 dry-run，写生产需
  `--project prod --apply --confirm <文件名>`，应用后自动**再跑第二遍做幂等自证**（详见技术栈备忘「SQL 自动应用」）
- ✅ **兜底**（本机没有 PAT / 用户主动要求走 Dashboard）：在对话回复里直接贴出**完整、可直接复制**的 SQL
  （用户全选 → 粘到 SQL Editor → Run），**不能只写进 `.sql` 文件说"见某某文件"**
- ✅ SQL 必须幂等（`ADD COLUMN IF NOT EXISTS` / `ON CONFLICT DO NOTHING` / `DROP POLICY IF EXISTS`），可重复执行不出错
- ✅ 附简短说明：去哪执行、执行后什么效果、不执行会怎样；同时保留 `.sql` 文件作为项目档案
- 教训：图片功能交付时 SQL 只写进了 `.sql` 文件，用户没看到可复制版本，差点漏执行，功能装上用不了

### 发布前自检（每次发布都要走一遍）

1. **确认在 main 上、改动已合并、工作区干净**（CD 只从 main 出包；工作流内有 dev 守卫）
2. 查线上 `app_versions` 最新版本号（`node scripts/query-latest-version.mjs`），新版本必须语义化更大
3. 跑回归测试（`scripts/test_*.py` + `scripts/test_*.mjs`），截图/断言确认；**PR 的 required checks 必须全绿**
4. 涉及 SQL 改动 → 按上节规则交付
5. 涉及 APK 改动 → `apksigner verify` + 检查构建时间 + unzip 确认改动入包
6. **设备侧冒烟（人工，1 分钟）**：把 dry-run 制品装到真机上走一遍关键路径 ——
   壳能启动 → 登录 → 加一条待办 → 完成一条 → 切后台再回来。
   **为什么必须有这一步**（2026-09-17 定型）：模拟器套件当天起**已从 CI 整体删除**（不是"仅手动触发"），
   设备侧不再有自动信号；而这条人工冒烟同时覆盖了模拟器套件**从来没覆盖**的部分 ——
   系统通知、震动、热更新、APK 安装器。走通道 A 时至少确认一次：打开 App 能看到更新欢迎动画（= 新 bundle 已生效）。
   壳发布前另做「模拟器 + debug 壳 + CDP」启动链验证（见下方 thenable 铁则一节）。
7. 发布后回读校验 `node scripts/verify-release.mjs`（通道 A）/ `verify-apk-release.mjs`（通道 B）；
   交付回复列明"已做 X / 已验证 Y / 未验证 Z"（铁律二的硬限制要标）

---

## 铁律四：代码改动需同步更新文档

**代码和文档脱节 = 事故温床。任何改动都必须同步到对应文档。**

- 新增 / 修改数据库表字段 → 同步更新 `PRODUCT-SPEC.md` 的「数据模型」章节
- 新增 / 修改发布通道、原生插件、构建机制 → 同步更新本文档「铁律三」与「技术栈备忘」
- 新增 / 修改产品功能 → 同步更新 `PRODUCT-SPEC.md` 的「功能规格」章节
- 事故 / 疑难 bug 复盘 → 完整叙事追加到 `docs/lessons/`（结构：发生了什么/根因/修复与防回归/关联规则），
  并更新其 README 索引；AGENTS.md 里只留规则 + 一行教训要点
- 废弃 / 删除旧机制 → 同步清理相关文档描述（不要留下"已死代码"的文档）
- **每个批次/阶段收尾 → 把可讲的判断与踩坑追加到「本机素材库」**（四段结构：是什么 / 常见问法 /
  我的实证 / 怎么讲清楚）。材料**不在本仓库内**，真实路径记在本机记忆 `.workbuddy/memory/MEMORY.md`
  （本仓库是 public，路径本身也不许写进来）。
  ⚠️ **不要攒到"回头一起写"**：这条曾被拖到整段阶段 4 空着，等到补写时细节只能靠翻 commit message 回忆
  —— 素材的新鲜度就是它的价值。写完跑该素材库工程的 `npm run build`（那个目录有自己的 `AGENTS.md`，动手前先读）。
  ⚠️ **这类内容一律不许出现在 GitHub 上**（2026-09-17 业主明确）：本仓库 public，**提交说明 / PR 标题与
  正文 / 仓库内任何文件**都不得出现"求职/招工向"的字眼，也不得出现素材库路径（连本规则也不能把那些词
  写出来 —— 那样仓库里照样搜得到）。提交前自查用的命令记在本机记忆 `.workbuddy/memory/MEMORY.md`。
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
- ⚠️ **不要把 `release-web.yml`（以及将来任何带 `paths` 过滤 / 仅手动触发的 workflow）的 job 设为 required**：
  它们在不匹配的 PR 上**永远不会运行**，check 会一直停在 "Expected"，把 PR 永久卡死
- 为什么这是唯一让 CI 有牙齿的方式：required checks 生效前，CI 跑得再红也不影响合并

### CI 分层：哪些改动该跑哪一层（2026-09-17 定型）

分层目标是**把「自动跑」压到最少**：让「改一个颜色」的反馈从十几分钟降到 70 秒。

| 层 | 何时跑 | 耗时（实测） | 角色 |
|---|---|---|---|
| `ci.yml`（3 个 job） | **每次 push / PR** | **约 70 秒** | **必需门禁**：Node 回归 + admin Playwright E2E + actionlint |
| `e2e-web-full.yml` | 每晚 02:17 + 手动 | 约 4–7 分钟 | 全量业务回归（8 个双账号 E2E）+ 测试库三项 preflight |

### 设备侧（模拟器）**不进 CI** —— 2026-09-17 删除 e2e-app.yml（#78）

四条理由（占串行队列十几分钟 / 覆盖内容已被 web E2E 等价且无一条发现缺陷的记录 / adb 常态掉线把 main 变
长期红灯 / 设备 E2E 不挂 PR 门禁是行业主流且本项目无机型矩阵需求）与**明确接受的代价**（设备侧验证 100%
依赖发布时人工冒烟；`android/` 改坏要到下次发 APK 才发现；`app-e2e/` 套件保留在仓库、可按需本机跑但无自动信号）
的完整论证见 **[docs/lessons/2026-09-17-device-ci-removal.md](docs/lessons/2026-09-17-device-ci-removal.md)**。

**要恢复设备测试**：新建一个工作流（或从 git 历史取回 `e2e-app.yml`），`paths` 只留
`android/**` 与 `app-e2e/**`（**不要含 `public/**`**），并把 `app-e2e/README.md` 里记的
`check-e2e-env-keys.mjs` 生成方列表一并加回。

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

- 功能开发完成、回归测试通过后、**合并 PR 之前**（不是 `git commit` 之前 —— 现在提交到分支不产生 main 变更，
  真正的门是合并），必须按 `CODE-REVIEW.md` 的六维度 Checklist 审查本次改动
- 审查结论分 🔴 阻断 / 🟡 建议 / 💭 建议：🔴 必须清零才能 commit；🟡 修复或豁免留注释
- 审查优先级：数据安全（铁律一）> 正确性 > 安全 > 可维护性 > 性能 > 测试（铁律二）
- 发布后发生事故 / 疑难 bug → 复盘根因，反哺进 `CODE-REVIEW.md` 的 Checklist 与 `docs/lessons/`（防同类问题再犯）
- **本文档只写「必须做」，不复制审查细节**：分级、六维度、四时点流程、AI 审查话术都在 `CODE-REVIEW.md`

---

## 补充：凭据卫生（真实值绝不进仓库）

**本仓库是 public。任何提交进 git 的凭据都要当成"已经泄露"来处理。**

- ✅ 真值只放两处：本地 `.env*`（已 gitignore）与 **GitHub Secrets**（CI 用）
- ❌ 禁止出现在：`.example` 模板、文档（`*.md`）、代码、测试夹具、注释、SQL 文件、截图
  - 包括**真实账号标识**（邮箱 / 用户名）—— 它们不是密码，但和密码凑在一起就是完整凭据
  - ⚠️ **两处功能性例外（不算违规）**：客户端登录映射 `public/js/auth.js`（中文名→邮箱，登录必需）
    与测试里的 mock JWT payload（装饰字段，无逻辑读取）。它们不含口令，单独泄露不构成凭据。
    **文档 / SQL / `.example` 没有这个功能理由**，那里出现真实账号标识一律算违规。
- ✅ 自查命令（工作树）——**判据不是「输出为空」**（伪域名 `@todo.local` 会合法地出现在说明文字里），
  而是「逐条都能解释」；**必须自己先跑一遍、并且必须能真的变红**（否则和没有一样）：
  ```bash
  # ① 列出仓库里全部凭据类赋值：每一个的「值」都必须是占位符 / process.env 读取 / ${{ secrets.* }}
  #    出现任何真实字面量 = 立即停下，按下方泄露处理顺序的①②③执行
  git grep -nEi '(password|passwd|secret|token|api[_-]?key)[[:space:]]*=[[:space:]]*[^[:space:]]+' -- . \
    ':!package-lock.json' ':!public/js/vendor' ':!AGENTS.md' ':!CODE-REVIEW.md'

  # ② 列出全部账号标识出现点：逐条确认落在「允许的位置」
  #    允许：客户端登录映射（public/js/auth.js、admin/ 的 AuthContext）、测试账号（e2e-*）、mock JWT payload、
  #    以及复盘文档里描述「形状占位」的出处（目前仅 docs/lessons/2026-09-15-credential-leak.md，已排除）
  #    不允许：文档 / SQL / .example —— 那里只能写形状占位（如 <拼音>@todo.local）
  git grep -n '@todo\.local' -- . ':!AGENTS.md' ':!CODE-REVIEW.md' ':!docs/lessons/2026-09-15-credential-leak.md'
  ```
  ⚠️ **工作树干净 ≠ 没泄露过** —— 历史提交里的值照样能 `git show` 取出来。所以还要扫历史：
  ```bash
  # ③ 刻意**不写死**泄露值（写死就等于又把它存进仓库一次）；列出该键历史上出现过的所有赋值人工过目
  git log --all -p -S'E2E_TEST_PASSWORD' -- '*.example' \
    | grep -E '^\+.*E2E_TEST_PASSWORD=' | sort -u

  # ④ 生产数据文件是否曾入库（实例：supabase/backup-stickers-*.json 曾进过历史，含真实 UUID）
  git log --all --diff-filter=A --name-only --pretty=format: | sort -u | grep -Ei 'backup|incident'
  ```
- ✅ **发现泄露时的正确顺序**：① **先改密码/轮换 key**（让泄露值当场失效）→ ② 再清理文件
  → ③ 复核历史提交里是否还有（上面的 ③④）→ ④ 开 GitHub **secret scanning + push protection**
  - 删文件**不等于**修好：历史提交里仍然有，且可能已被克隆（`git log --all -S` 会告诉你从哪个 commit 开始）
  - 改写历史（force push）在本项目**不做**：main 有分支保护、收益小于代价 —— 轮换凭据才是根治
- **推论写进规则**：凭据卫生的失效**不会报错、不会报警**，只会以"莫名其妙的数据/登录"的形式出现 ——
  所以它必须是**推送前的静态检查**（人工自查命令 + GitHub push protection），不能靠"我记得没写过"。
- 教训：[docs/lessons/2026-09-15-credential-leak.md](docs/lessons/2026-09-15-credential-leak.md)
  —— `.env.test.example` 真实邮箱+密码公开躺一周（生产账号同邮箱，密码复用即全面沦陷）；
  规则自己的例子把真值写回了本文档；旧自查命令扫不到 `.sql`/`.js` 且会自匹配永远不绿。

---

## 补充：Capacitor 插件对象是 thenable —— 永不进 Promise 链（2026-10-02 生产事故）

**事故一句话**：2.8.1 壳发布后，App 端**待办完全不加载**（开屏不撤、列表永不渲染），生产不可用；
网页/PWA 不受影响。热更 2.7.78 修复 + 壳 2.8.1 下线止损，装了坏壳的设备拉到热更后自愈。
根因、两个测试盲区、CDP 验证流程的完整复盘：
**[docs/lessons/2026-10-02-capacitor-thenable.md](docs/lessons/2026-10-02-capacitor-thenable.md)**

**铁则（代码审查检查项，🔴 级）**：
- Capacitor 插件代理对象**永远不能**被 `await`、放进 Promise 链、或作为 async/Promise 的返回值
  （插件代理是 thenable —— async 函数返回它时 Promise 会二次展开 `.then`，native 下变成一次
  不存在的桥接方法调用；而该调用位于启动关键路径时会中断整个 init，浏览器里 `isNative=false`
  走不到出错分支，所以 Web E2E 全绿只有真机暴露）
- **只能** `await` 它的**方法调用的返回值**（如 `await LocalNotifications.schedule({...})` —— 那是 bridge promise）
- 跨模块传递插件实例用**同步函数**（见 `notify.js` 的 `getLocalNotifications`，时序由
  `ensureCapacitorLoaded()` 显式管理），需要等待就 `await ensureCapacitorLoaded()` 再同步取

**对策（壳发布前必做，实测成本 ≈ 10 分钟）**：
模拟器 + debug 壳 + CDP 直连 WebView，走**产品代码的真实入口**复现/验证；
判定「启动链完整」的硬指标：`emptyState 或 todoCount > 0`（render 执行过）+ logcat/CDP 无 `exception`。
release 壳不可调试（CDP 关闭）；**探针直调原生插件成功 ≠ 产品代码路径成功**。

---

## 补充：软删除（回收站）机制

鉴于数据丢失的惨痛教训，所有数据的"删除"操作都采用**软删除**：
- ✅ **数据层已实现**：`todos.deleted_at`、`daily_notes.deleted_at` 字段，删除只打时间戳，不物理移除
- ✅ **UI 层已实现**：回收站入口 + 恢复 / 永久删除（H1）、删除撤销 Toast（H2）
- 这是防止误删/恶意删除的最后保障

### 保留策略：**决定不实现自动物理清理**（2026-09-14 决策，非遗漏）

**理由（按重要性）**：
1. **用户已有显式的物理删除入口**（回收站 → 永久删除）。自动清理 = 系统删掉用户没要求删的数据，
   对双人私密应用是纯粹的负价值
2. **收益≈0**：软删除行只有 2 个用户产生，无存储/性能压力
3. **风险是本项目历史上最严重的那一类**：按时间谓词批量物理删真实数据（2026-07-31 事故就是这个形状）——
   「收益≈0、风险=历史最坏」的正确做法是不做
4. **行业实践并不要求它**：保留政策的要义是「**有意决定**保留多久」；本项目的有意决定 =
   无限期保留软删除数据，由用户在回收站自行永久删除

**触发重新评估的条件**（满足其一再考虑）：软删除数据量级增长到影响查询/存储；或出现隐私合规要求；
或用户明确想要「回收站 30 天自动过期」的产品行为。

**若将来要实现，硬约束如下**（不可削减）：
1. **默认 dry-run**，必须显式 `--apply` 才真删；先打印将要删除的行数与 id 清单
2. **先备份再删**：`node scripts/backup-tables.mjs --reason "..."`（完整行、可恢复；不含 Storage 图片）
3. **禁止按谓词批量删**（铁律一）：先 SELECT 出 id 列表 → 落备份 → 再按**显式 id 列表**删
4. 只处理 `deleted_at` 超过保留期的行，并支持 `--keep-days N` 覆盖
5. **「计划任务」形态要格外小心**（cron = 无人值守，没人在旁边看报告）：默认 dry-run → 先只报告不删一段
   → 真删时删除与告警/报告一起上，失败要能被看见
6. **在测试库上验证**：测试库有 `deleted_at` 数据且 `reset-test-db.mjs` 会硬删，清理逻辑可在这里跑通全流程再碰生产

---

## 本机模拟器（Medium_Phone_API_36.1）—— 发版冒烟 / debug 壳验证必用

- 启动：`emulator -avd Medium_Phone_API_36.1`（默认命令即可，2026-10-02 已彻底修复三类根因）；
  **就绪唯一标准：`adb shell getprop sys.boot_completed` 返回 1**
  （通知栏出现「Emulator is performing a full startup」= 正常冷启动，2-5 分钟，崩溃循环后首次可能更久；
  持续 5 分钟以上仍空 / offline = 真卡死，杀掉再查，**不要原地等**）
- 三类根因均已持久化修复到 AVD `config.ini`：① `hw.gpu.mode=swiftshader_indirect`（软渲染绕开宿主 GPU
  间歇性挂死）；② `hw.ramSize=2048` 纯数字（带 M 带空格会被静默回退 256MB → 内核 panic 无限重启循环）；
  ③ 删除跨版本残留快照。**模拟器升级后若快照加载报错/挂死，直接删
  `~/.android/avd/<名>.avd/snapshots/default_boot`**（只丢开机内存态，不丢 App 数据）
- config.ini 写错会被**静默忽略**，真相在启动后生成的 `hardware-qemu.ini` —— 改完用它回读校验，别信"写过了"
- 完整排障手册（带内核日志取证、grep 清单、快照回环）：
  [docs/emulator-troubleshooting.md](docs/emulator-troubleshooting.md)

---

## 技术栈备忘

- **前端**：原生 HTML/CSS/JS（无框架），ES Module
- **后端**：Supabase（PostgreSQL + Auth + Realtime），无自建服务器
- **打包**：Capacitor → Android APK（`com.love.todo`）
- **发布**：**通道 A 热更新**（`release.mjs`；本地直跑 或 GitHub Actions `release-web.yml` 审批门跑）
  + **通道 B APK**（`release-apk.mjs`；本地直跑 或 `release-apk.yml` 审批门跑）
  + App 内自更新（`apk-update.js` + `ApkInstaller`）；
  发布后回读校验：通道 A 用 `verify-release.mjs`，通道 B 用 `verify-apk-release.mjs`（两者都是只读、可当 CI 门禁）；
  另：`release-web.yml` 的 publish 作业在回读校验后**顺带跑一次 `dora-metrics.mjs`** 写进 Run Summary
  （`continue-on-error: true` —— 观测不该把一次已成功的发布变成红灯）
- **PWA**：`manifest.webmanifest` + `sw.js`（Service Worker，仅浏览器环境生效，原生环境 bypass；版本号见文件内 `VERSION` 常量）
- **Capacitor 插件（2026-10-03 修正，与 package.json 实际一致）**：`@capacitor/app`（`App.getInfo()`，apk-update 用）/
  `LocalNotifications` / `SplashScreen` / `@capgo/capacitor-updater`（热更）/ 自研 `ApkInstallerPlugin`（APK 自更）；
  **状态栏外观没有独立插件** —— 由原生 `MainActivity`（WindowCompat/InsetsController）+ `styles.xml` 直接控制
- **存储 bucket**：`todo-attachments`（图片附件，公开读）/ `app_updates`（热更新 zip + APK）
- **测试**：Playwright（Python 双账号 E2E，连测试库）+ Node 局部回归（可 mock）
- **CI/CD**：GitHub Actions **五个** workflow —— `ci.yml`（Node 回归 + admin Playwright E2E + **workflow 静态检查 actionlint** +
  三个结构性检查）、`release-web.yml`（**通道 A 热更新 CD**，仅手动触发）、
  `release-apk.yml`（**通道 B APK 发布 CD**，仅手动触发；工序与 release-web.yml 同构：预演真构建 → 审批门 → 发布 → 回读校验）、
  `e2e-web-full.yml`（**定时全量回归**：每晚 02:17 北京 / `schedule` + `workflow_dispatch`，跑 8 个双账号 Python E2E）、
  `codeql.yml`（**静态代码扫描**：push / PR / 每周一定时；`security-events: write` 是它唯一需要的写权限）。
  main 已开**分支保护**，required checks 取 `ci.yml` 三个 job；改代码走分支 + PR（见「铁律五 → main 分支保护」）
  ⚠️ `schedule` 的 cron **按 UTC 解释**，且定时任务只在**默认分支**上运行（夜里跑的是 main 上已合并的代码）；
  本项目用 `17 18 * * *` = 北京 02:17，**分钟位不要写 0**（整点是 GitHub 调度器负载高峰）
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
- **测试库维护**：`node scripts/reset-test-db.mjs`（归零，硬删 web 通道 E2E 残留 + 贴纸）／`node scripts/check-test-env.mjs`（隔离自检）／`node app-e2e/scripts/check-test-schema.mjs`（schema 契约）／`node app-e2e/scripts/check-rls.mjs`（RLS 生效自检）
- **SQL 自动应用（2026-10-02 起，SQL 交付的主通道，见铁律三）**：`node scripts/apply-sql.mjs supabase/xxx.sql --project test --apply` ——
  走 Management API（`/v1/projects/{ref}/database/query`）把 supabase/*.sql 幂等迁移打到指定项目；
  默认 dry-run、写生产需 `--confirm <文件名>`、应用后自动**再跑第二遍做幂等自证**、`--query` 提供 read_only 只读探针。
  凭据是**作用域受限 PAT**（`.env` 的 `SUPABASE_ACCESS_TOKEN`，sbp_fc_ 开头，只勾两项目 Database 读写）；
  setup 与安全设计见脚本头部注释。⚠️ 端点官方标注 experimental/Beta（CLI `db query --linked` 底层同源）；
  ⚠️ PAT 是账号级资产：绝不入库/入日志，怀疑泄露即 Dashboard 撤销重发（换 .env 一行）
- **Web E2E 跑批**：`node scripts/run-web-e2e.mjs`（8 个用例：逐个归零 + 失败重试一次 + flaky 显式标记 + Run Summary；
  `--files` / `--keep-data` / `--no-retry` / `--fail-on-flaky`）；
  依赖钉在 `scripts/requirements-e2e.txt`（Python playwright，CI 与本地同版本）
- **结构性检查（CI required job 里跑，都是纯静态、秒级失败）**：`check-test-guards.mjs`（只读守卫）／
  `check-e2e-env-keys.mjs`（凭证键三方一致：代码读取 / 模板 / 两个工作流生成）／
  `check-actions-pinned.mjs`（**actions 必须固定到完整 SHA 且带 `# vX.Y.Z` 注释** —— 仓库设置里的
  `sha_pinning_required` 也拦得住未固定（实测：该 job 在 "Set up job" 阶段就失败并给出明确报错）；
  但它**不查版本注释**，而注释是 Dependabot 判断当前版本的唯一依据，缺了 = 安全补丁静默进不来。
  所以本脚本的价值是「本地秒级反馈 + 补上开关查不了的那条规则」）
- **安全回归（前两个不需要凭据、进 CI 的 Node 回归；第三个需要测试库凭据）**：
  `scripts/test_rls_migration.mjs`（PGlite 真 Postgres 跑 `supabase/migration-rls-hardening.sql`：复现洞 → 修复 → 幂等）／
  `scripts/test_rpc_migration.mjs`（同法跑 `supabase/migration-rpc-execute-hardening.sql`：anon 收干净 / App 仍可用 / 注册触发器完好）／
  `app-e2e/scripts/check-rls.mjs`（对真实测试库的 anon 探针：表 RLS + RPC 执行权限 + 暴露面白名单；也由 `admin/scripts/init-test-env.mjs` 第 ④ 步调用 ⇒ 属 required job）
- **DORA 四指标（2026-09-16 起，回答"CI/CD 到底好不好"）**：
  `node scripts/dora-metrics.mjs [--days 30] [--json] [--fail-on-degraded]`（**只读**）——
  部署频率 / 前置时间（`released_at − commit_at`）/ 变更失败率 / 恢复时间。
  口径与已知限制写在 `scripts/_lib-dora.mjs` 头部（**唯一事实来源，别在别处再抄一份**）；
  纯计算部分由 `scripts/test_dora_metrics.mjs` 用合成夹具钉住（无凭据、进 CI）。
  数据来源是两张版本表，靠 `supabase/migration-dora-metrics.sql` 补的 6 列
  （`commit_sha` / `commit_at` / `commit_dirty` / `disabled_at` / `disabled_reason` / `disabled_is_incident`）；
  写入方是 `release.mjs` / `release-apk.mjs` / `rollback.mjs`（**写失败不阻断发布** —— 观测不该成为交付通道的单点故障）。
  ⚠️ 事故与否由**人**在 `rollback.mjs --incident` 时标注：机器判不出"下线是因为出事了还是例行退役/演练"，
  不标就留 `NULL`（不计入失败率，报告里单独列出来提醒），**不猜**。
- **埋点状态**：⚠️ 目前零埋点，无法回答"哪个功能最常用""两人一天互动几次"。补基础埋点（北极星 = 双端同日活跃天数）在路线图 P0。
