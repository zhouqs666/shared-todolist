# 项目规则（铁律，不可违反）

> 以下规则由真实事故总结而来，每一条都有代价。违反任何一条都视为严重事故。
> 九条铁律统一按五段组织：**原则 → ✅ 必须做 → ❌ 禁止 → ⚠️ 例外/边界 → 教训**（无对应内容的段省略）。
> 完整事故复盘在 **docs/lessons/**（[索引](docs/lessons/README.md)）；发布通道的操作细节在
> **[docs/release-runbook.md](docs/release-runbook.md)**（铁律三的按需细节）；本机排障手册在
> **[docs/emulator-troubleshooting.md](docs/emulator-troubleshooting.md)**。
> 附一 / 附二是速查（事实与命令），不是行为规则。

---

## 铁律一：绝不触碰生产数据

**原则：永远不要用生产数据库做测试、做演示、做截图。**

**✅ 必须做：**
- 测试用**隔离的测试数据**：插入时打标记（如 text 前缀 "E2E-测试-"），验证完只删带标记的
- 任何删除操作前**必须先备份**：`node scripts/backup-tables.mjs --reason "<原因>"`
  （只读导出到 `backups/`，与 `backups/incident-*.json` 同格式、存**完整行**、可恢复；不含 Storage 图片对象）
- 模拟器/真机测试用独立的测试账号或测试项目，不碰真实用户数据

**❌ 禁止：**
- 为了让列表变空而 `DELETE FROM todos`（哪怕带 WHERE）
- 往生产库插测试数据后不清理，或清理时误删真实数据
- 在生产库上跑任何修改性 SQL（INSERT/UPDATE/DELETE）作为"验证"
- 批量删除（`.neq('id', '全零')` 这种"删全部"模式）——必须显式指定要删的 id

**⚠️ 例外/边界（2026-09-14 明确）：**
- 本律约束的是「为了验证而改生产数据」：测试、演示、截图、排查。**发布（铁律三）与回滚**本身就要写生产表
  （`app_versions` / Storage），属**产品业务动作**，不属本律禁止范围——但必须走审批门（见铁律三）
- 判据一句话：**这个写操作是产品功能的一部分，还是为了「验证一下」？** 后者一律禁止
- 双环境切换后的载体（2026-10-06）：真机侧的「测试隔离」从**包内容**变为
  「`app_env` 标记（测试环境角标可见）+ 测试发版通道分离」——包内含两套 anon 配置是设计
  （anon 本就公开，安全边界仍在 RLS）。配套硬闸：`release-test.mjs` 发布时校验包主默认=测试库
  + 含切换标记（fail-closed）、`check-test-schema` 对最新启用包做同校验、离线队列按环境分键、
  切环境取消提醒；E2E `test_env_switch.py` 断言切环境期间**生产请求零出网**
- 为什么「测试已全面隔离」的今天这条仍然必要（2026-10-03 复评）：① 生产合法写通道仍常用
  （release / rollback / apply-sql / release-apk），上面那句判据是它们的边界定义；② `check-test-guards.mjs`
  等"漏挂守卫直接红"的基建，存在依据就是本条——规则删了，守卫就成了无动机的"死代码"；③ 隔离基建自身会漂移
  （RLS 曾被手工关掉、`test_pinch.mjs` 漏 mock 打到生产）；④ Dashboard 手工 SQL、AI"验证一下"的冲动、
  演示截图——基建管不到的路径

**教训：** [docs/lessons/2026-07-31-prod-data-loss.md](docs/lessons/2026-07-31-prod-data-loss.md)
——为验证空状态 UI 执行谓词批量删，用户全部待办永久丢失，Free 套餐无备份不可恢复。

---

## 铁律二：交付前必须全面测试，硬限制要列明

**原则：功能开发完成、交付前必须经过全面测试，不能凭想象宣布"完成"；没法验证的必须列明，不能把"没测"说成"已验证"。**

**✅ 必须做：**
- 跑测试前先起测试专用服务器（铁律一）：
  ```bash
  node scripts/serve-test.mjs      # 测试服务器，端口 3100，连独立测试库
  node scripts/reset-test-db.mjs   # 归零测试库（清 E2E 残留 + 贴纸）
  node scripts/run-web-e2e.mjs     # 推荐：一次跑完 9 个用例（逐个归零 + 失败重试一次 + flaky 显式标记 + 汇总表）
  python3 scripts/test_undo_complete.py   # 也可单跑某个：脚本自动连 3100 + 自证隔离
  ```
  单跑用例记得自己先归零；`run-web-e2e.mjs` 会在每个用例前自动归零（用例之间不留隐含依赖）
- **测试库必须归零**（`tests` 末尾自动调 `reset-test-db.mjs` 硬删；`E2E_KEEP_DATA=1` 保留现场排查）：
  测试内部的删除是**软删除**（`deleted_at` 打时间戳），行永远留在表里——看着清了，其实越跑越脏；
  贴纸 `sticker_key` 有 UNIQUE 约束、解锁幂等，一旦解锁就测不了「首次解锁」路径（开奖弹窗/庆祝动画/图鉴+1），
  盲盒的核心卖点在测试环境里失效
- 核心流程 / 双端同步：Playwright 双账号 E2E（`scripts/test_*.py`，测试账号来自 `app-e2e/.env.test`）
- 局部回归：Node 脚本跑在生产服务（:3000）上**只读**——`_lib-readonly-guard.mjs` 在网络层阻断写请求
  （不是靠自觉，也不是靠 token 恰好无效）；`check-test-guards.mjs` 在 CI 做结构性检查（漏挂守卫直接红）
- 必须覆盖：核心功能、边界情况、错误处理、Realtime 双端同步；测试要真实验证结果（截图、断言、状态检查）
- 测试前跑三个 preflight：
  - `node scripts/check-test-env.mjs` —— Web 通道隔离（测试库 ≠ 生产库）
  - `node app-e2e/scripts/check-test-schema.mjs` —— schema 契约（缺列/缺表 → `listTodos()` 整体报错、
    界面静默空列表，E2E 只报「元素找不到」，极易误判成定位/时序问题；缺 RPC 函数同理，
    如 `increment_login_count` 缺失时冷启动 404）
  - `node app-e2e/scripts/check-rls.mjs` —— 表 RLS + 函数执行权限真的生效（anon 视角探针）
- **合并前置门 = CI required checks 全绿**（`ci.yml` 三个 job；main 已开分支保护，红灯合不进去）

**❌ 禁止：**
- 测试脚本指向 3000（那是生产库）——`e2e_common.py` 会直接拦下、退出码 2
- 只看"没报错"就算测试通过

**⚠️ 例外/边界：**
- **门禁覆盖 ≠ 测试全覆盖**，这是有意的分层（2026-09-14 定型）：PR 门禁要「快而稳」（Node 回归 + admin
  Playwright E2E + workflow 静态检查——跑得慢拖住合并、跑得不稳让人无视红灯）；全量回归要「慢而全」——
  9 个双账号 E2E（blindbox / offline / trash / undo_complete / pin / reminder / camera_image /
  note_ceremony / env_switch）走 `e2e-web-full.yml`，**每晚 02:17（北京）**定时 + 手动。该工作流**不设 required check**
  （不在 PR 上跑，设了会让 check 停在 "Expected" 卡死 PR）；夜里会跑，但**改动等待期内**要自己先跑一遍
- **CI 绿灯 ≠ 交付物可用**——制品/发布结果单独回读验证（铁律三 `verify-release.mjs`）
- 有硬限制无法验证的功能点：交付时明确列出 + 标注原因（如"无法模拟真机震动"、"无法测试 FCM 推送"）

**教训：** [2026-09-14-web-channel-isolation](docs/lessons/2026-09-14-web-channel-isolation.md)（Web 通道曾把
27 条测试数据写进生产库——所以隔离必须是物理的、守卫必须挂网络层）、
[2026-09-16-rls-disabled](docs/lessons/2026-09-16-rls-disabled.md)（"粘贴过一次"挡不住漂移，必须机器判定）。

---

## 铁律三：交付必须让用户拿到（热更新优先，APK 兜底）

**原则：改完代码 ≠ 交付。用户手机上跑的是 APK 内置的 web 资源，不是你电脑上的源码。改完必须发布，否则用户永远看不到改动。**
（通道细节、CD 逐步流程、下线/回滚完整语义见 [docs/release-runbook.md](docs/release-runbook.md)——本条只留规则与守卫。）

**✅ 必须做：**
- **先合并到 main 再发布**（CD 只从 main 出包且有 dev 守卫；本地发布也在 main、工作区干净时执行）
- **选对通道**：只改 `public/` → 通道 A `node scripts/release.mjs <版本号> --notes "<说明>"`；
  动了原生层（Capacitor 插件、`capacitor.config.json`、`AndroidManifest.xml` 等）→ 通道 B
  `node scripts/release-apk.mjs <版本号>`（cap sync → 打 APK → 写 `app_native_versions` → 上传）
- **发布前查线上版本**：`node scripts/query-latest-version.mjs`；新版本必须语义化大于「历史最高」
  （不只是 enabled 的最新——已下线的版本号也算"用过"）；`release.mjs` 内置 `assertNewerThanLatest()` 兜底
- **发布后回读校验**：通道 A `verify-release.mjs`；通道 B `verify-apk-release.mjs`（只读；B 多一项
  **SHA-256 一致性**——客户端安装前会比对，对不上用户侧"下载完成毫无反应"）。**写成功 ≠ 客户端拿得到**
- **通道 B 的 `build.gradle` 守卫**（`release-apk.mjs` 一次性报出全部不一致）：`versionName` 逐字等于发布号；
  `versionCode` 严格递增（基准含已下线行，Android 不允许同码覆盖安装；2.8.0 的 code 33 已用掉）；
  `--code` 不允许与 `build.gradle` 不一致
- **SQL 交付**：主通道 `node scripts/apply-sql.mjs supabase/xxx.sql --project test --apply`（默认 dry-run，
  写生产需 `--project prod --apply --confirm <文件名>`，应用后自动幂等自证）；兜底（无 PAT / 用户主动要求）
  在回复里贴**完整可复制** SQL；SQL 必须幂等（`ADD COLUMN IF NOT EXISTS` / `ON CONFLICT DO NOTHING` /
  `DROP POLICY IF EXISTS`），附「去哪执行 / 效果 / 不执行会怎样」，保留 `.sql` 档案
- **发布前自检 7 步**：① main + 工作区干净 → ② 查版本号 → ③ 回归测试 + required checks 全绿 →
  ④ SQL 按上规则交付 → ⑤ APK 改动 `apksigner verify` + unzip 确认入包 → ⑥ **设备侧人工冒烟 1 分钟**
  （真机走关键路径：壳启动 → 登录 → 加待办 → 完成 → 切后台再回；壳发布前另做 debug 壳 + CDP 启动链验证，
  见铁律八——模拟器套件 2026-09-17 起已从 CI 整体删除，这是设备侧唯一信号，覆盖通知/震动/热更新/安装器；
  走通道 A 时至少确认打开 App 能看到更新欢迎动画 = 新 bundle 生效）→ ⑦ 发布后回读 + 交付回复列明
  "已做 / 已验证 / 未验证"
- **告知用户**：热更**打开一次 App 即可**（`update.js` 同一会话内完成切换；「重开两次」只在下载完成前
  就杀掉 App 时才需要）

**❌ 禁止：**
- 拍脑袋猜版本号（`index.html` 的 meta 不是权威，唯一权威是 `app_versions` 表）
- 在 feature 分支上发布（= 把没合并的代码发到线上）
- 生成 `有爱-时间戳.apk` 这类带时间戳的文件名（桌面永远只有一个 `~/Desktop/有爱.apk`，打包前先清理历史 APK）
- SQL 只写进 `.sql` 文件说"见某某文件"
- 期待 CI 发布覆盖 `~/Desktop/有爱.apk`（runner 没有你的桌面）

**⚠️ 例外/边界：**
- **「下线」≠「回滚」**：止损用 `rollback.mjs [--native]`（只挡"还没更新的设备"，救不了已更新的），
  真回滚 = 发更高的新版本；完整语义与 `--from-git` 细节见 runbook
- 通道 B 的 `--from-git`（退回旧壳）**决定暂不实现**（2026-10-03 复评维持）：2.8.1 事故实证
  「下线 + 发热更」足以自愈；重新评估条件：出现「新壳启动即崩、旧壳可用」且热更无法覆盖的形态
- 自动兜底只有 `resetWhenUpdate:true`（连续崩溃 3 次回退），只覆盖崩溃类故障

**教训：** [2026-08-07-stale-version-no-update](docs/lessons/2026-08-07-stale-version-no-update.md)
（版本号低于线上 → 判定无更新）、
[2026-09-04-apk-infinite-reinstall](docs/lessons/2026-09-04-apk-infinite-reinstall.md)
（versionName 与表不一致 → 无限重装）。

---

## 铁律四：代码改动需同步更新文档

**原则：代码和文档脱节 = 事故温床。开发前先自查：本次改动是否需要更新文档？需要就先改文档，再改代码。**

**✅ 必须做：**
- 新增/修改数据库表字段 → `PRODUCT-SPEC.md`「数据模型」；产品功能 → 「功能规格」
- 新增/修改发布通道、原生插件、构建机制 → 本文「铁律三」与「附二：技术栈速查」
- 事故/疑难 bug 复盘 → `docs/lessons/`（发生了什么/根因/修复与防回归/关联规则）+ 更新其 README 索引；
  AGENTS.md 只留规则 + 一行教训要点
- 每个批次/阶段收尾 → 判断与踩坑追加到「本机素材库」（四段结构：是什么/常见问法/我的实证/怎么讲清楚）。
  材料**不在本仓库内**，真实路径记在本机记忆 `.workbuddy/memory/MEMORY.md`（本仓库 public，路径本身
  不许写进来）；写完跑该素材库工程的 `npm run build`（那里有自己的 `AGENTS.md`，动手前先读）

**❌ 禁止：**
- 废弃/删除旧机制后留下描述它的文档（"已死代码"的文档）
- 素材攒到"回头一起写"（素材的新鲜度就是它的价值——这条曾被拖到整段阶段 4 空着）
- 素材库相关内容出现在 GitHub 上（2026-09-17 业主明确）：本仓库 public，**提交说明 / PR 标题与正文 /
  仓库内任何文件**都不得出现"求职/招工向"的字眼，也不得出现素材库路径（连本规则也不能把那些词写出来——
  那样仓库里照样搜得到）。提交前自查用的命令记在本机记忆 `.workbuddy/memory/MEMORY.md`

---

## 铁律五：代码改动自动提交（改完即提交，不再每次询问）

**原则：功能/批次开发完成、测试通过后自动 `git commit`，不再每次结尾问"要不要提交"。未测试通过、开发中途状态不提交。**

**✅ 必须做（提交时机）：** 功能开发完成 + 回归测试通过 → 自动 commit；发布（热更/APK）完成 → 自动 commit；
纯文档改动 → 改完即 commit。

**✅ 提交前自检（自动执行，不打扰用户）：** `git status` 确认无敏感文件混入；确认 `.env` / `*.keystore` /
`node_modules` 未进暂存区（`.gitignore` 兜底）；确认无调试残留（`scripts/_debug-*.mjs`、`.release-tmp/`、`.probe/`）。

**❌ 禁止：**
- **直推 main**（分支保护会拒，GH013）。改代码走：
  ```bash
  git switch -c <type>/<简短说明>     # 例如 fix/undo-toast-keyboard
  git commit ...                      # 铁律五照旧：改完即提交
  git push -u origin HEAD             # 推功能分支
  gh pr create --fill                 # 开 PR；CI 必过（required checks）才能合
  gh pr merge --squash --delete-branch  # 合并需用户明确指令
  ```
- 裸 `git add -A` 一把梭（用 `git add` 指定文件/目录）
- 提交 `.workbuddy/`（本机记忆）、调试探针、临时产物
- 把 `release-web.yml`（及任何带 `paths` 过滤 / 仅手动触发的 workflow）的 job 设为 required——
  它们在不匹配的 PR 上**永远不会运行**，check 停在 "Expected" 把 PR 永久卡死

**⚠️ 例外/边界：**
- **合并 PR 等同于改 main**，只在用户明确授权的任务范围内执行（例：「做批次 B」即含该批次所需的分支、
  PR 与合并）；超出授权或不确定 → 先问。push 功能分支 + 开 PR 属常规流程，可自动执行
- required checks 只含 `ci.yml` 三个 job（`Node Regression + Version Check` / `Admin E2E (Playwright + Allure)` /
  `Workflow Lint (actionlint)`）——required checks 生效前 CI 跑得再红也不影响合并，这是唯一让 CI 有牙齿的方式
- CI 分层（2026-09-17 定型，把「自动跑」压到最少）：

  | 层 | 何时跑 | 耗时（实测） | 角色 |
  |---|---|---|---|
  | `ci.yml`（3 job） | 每次 push / PR | 约 70 秒 | 必需门禁：Node 回归 + admin E2E + actionlint |
  | `e2e-web-full.yml` | 每晚 02:17 + 手动 | 约 4–7 分钟 | 全量业务回归（9 个双账号 E2E）+ 三项 preflight |

- **设备侧（模拟器）不进 CI**（2026-09-17 删除 e2e-app.yml，#78）：四条理由与明确接受的代价见
  [docs/lessons/2026-09-17-device-ci-removal.md](docs/lessons/2026-09-17-device-ci-removal.md)。
  要恢复：新建工作流（或从 git 历史取回），`paths` 只留 `android/**` 与 `app-e2e/**`
  （**不要含 `public/**`**），并把 `app-e2e/README.md` 记的 `check-e2e-env-keys.mjs` 生成方列表一并加回
- commit message：Conventional Commits 中文描述（feat / fix / refactor / docs / chore）；**一个功能 = 一个 PR**
  （squash 后在 main 上合成 1 个 commit——「一个功能一个 commit」指 main 粒度，不是分支内粒度）；
  一次发布版本 = 一个原子提交（发布相关改动不混进功能 PR）

**遇到必须停下询问：** 改动中混入不属于本次任务的修改；检测到敏感文件；测试未通过 / 功能未完成。

---

## 铁律六：提交前必须走代码审查（见 CODE-REVIEW.md）

**原则：一人公司没有 reviewer，就用 AI 审查 + Checklist 兜底（代码质量参差的根源是「没有第二双眼睛」）。**

**✅ 必须做：** 功能开发完成、回归测试通过后、**合并 PR 之前**（不是 `git commit` 之前——分支提交不产生
main 变更，真正的门是合并），按 `CODE-REVIEW.md` 六维度 Checklist 审查本次改动。

**❌ 禁止：** 审查结论 🔴 阻断未清零就 commit（🟡 修复或豁免留注释）。

**⚠️ 例外/边界：** 审查优先级 = 数据安全（铁律一）> 正确性 > 安全 > 可维护性 > 性能 > 测试（铁律二）；
发布后事故 / 疑难 bug → 复盘根因，反哺进 `CODE-REVIEW.md` 的 Checklist 与 `docs/lessons/`（防同类问题再犯）。
本文档只写「必须做」——分级、六维度、四时点流程、AI 审查话术都在 `CODE-REVIEW.md`。

---

## 铁律七：凭据卫生 —— 真实值绝不进仓库

**原则：本仓库是 public，任何提交进 git 的凭据都要当成"已经泄露"来处理。凭据卫生的失效不会报错、不会报警，
只会以"莫名其妙的数据/登录"的形式出现——所以它必须是推送前的静态检查，不能靠"我记得没写过"。**

**✅ 必须做：**
- 真值只放两处：本地 `.env*`（已 gitignore）与 **GitHub Secrets**（CI 用）
- 推送前跑自查命令（工作树）——**判据不是「输出为空」**（伪域名 `@todo.local` 会合法地出现在说明文字里），
  而是「逐条都能解释」；**必须自己先跑一遍、并且必须能真的变红**（否则和没有一样）：
  ```bash
  # ① 列出全部凭据类赋值：每一个的「值」都必须是占位符 / process.env 读取 / ${{ secrets.* }}
  #    出现任何真实字面量 = 立即停下，按下方泄露处理顺序的①②③执行
  #    （本命令与历史扫描命令 ③④ 的档案在 docs/lessons/2026-09-15-credential-leak.md，
  #      该文件与 AGENTS.md/CODE-REVIEW.md 同理排除——其中 E2E_TEST_PASSWORD= 是键名不是值；
  #      该文件体量小、被铁律七直接引用，人工审阅覆盖它）
  git grep -nEi '(password|passwd|secret|token|api[_-]?key)[[:space:]]*=[[:space:]]*[^[:space:]]+' -- . \
    ':!package-lock.json' ':!public/js/vendor' ':!AGENTS.md' ':!CODE-REVIEW.md' ':!docs/lessons/2026-09-15-credential-leak.md'

  # ② 列出全部账号标识出现点：逐条确认落在「允许的位置」
  #    允许：客户端登录映射（public/js/auth.js、admin/ 的 AuthContext）、测试账号（e2e-*）、mock JWT payload、
  #    以及复盘文档里描述「形状占位」的出处（目前仅 docs/lessons/2026-09-15-credential-leak.md，已排除）
  #    不允许：文档 / SQL / .example —— 那里只能写形状占位（如 <拼音>@todo.local）
  git grep -n '@todo\.local' -- . ':!AGENTS.md' ':!CODE-REVIEW.md' ':!docs/lessons/2026-09-15-credential-leak.md'
  ```
- 发现泄露时按顺序：**① 先改密码/轮换 key**（让泄露值当场失效）→ ② 再清理文件 → ③ 复核历史提交
  （`git log --all -S` 会告诉你从哪个 commit 开始；扫描命令见教训文档）→ ④ 开 GitHub secret scanning +
  push protection

**❌ 禁止：**
- 真实凭据出现在 `.example` 模板、文档（`*.md`）、代码、测试夹具、注释、SQL 文件、截图
- 真实账号标识（邮箱/用户名）出现在文档 / SQL / `.example`——那里只能写形状占位（如 `<拼音>@todo.local`）。
  ⚠️ 两处功能性例外不算违规：客户端登录映射 `public/js/auth.js`（中文名→邮箱，登录必需）与测试里的
  mock JWT payload（装饰字段，无逻辑读取）——它们不含口令，单独泄露不构成凭据；文档 / SQL / `.example`
  没有这个理由

**⚠️ 例外/边界：**
- **工作树干净 ≠ 没泄露过**——历史提交里的值照样能 `git show` 取出来，必须扫历史（命令在教训文档）
- 删文件不等于修好：历史提交里仍然有，且可能已被克隆；改写历史（force push）不做——main 有分支保护、
  收益小于代价，轮换凭据才是根治

**教训：** [docs/lessons/2026-09-15-credential-leak.md](docs/lessons/2026-09-15-credential-leak.md)
——`.env.test.example` 真实邮箱+密码公开躺一周（生产账号同邮箱，密码复用即全面沦陷）；规则自己的例子
把真值写回了本文档；旧自查命令扫不到 `.sql`/`.js` 且会自匹配永远不绿。

---

## 铁律八：Capacitor 插件代理永不进 Promise 链（thenable）

**原则：Capacitor 插件代理对象是 thenable——被 Promise 二次展开时，native 下会调用不存在的桥接方法。
这类错误浏览器里不出现（`isNative=false` 走 no-op 分支），Web E2E 全绿、只有真机炸，这条规则是唯一防线。**
（2026-10-02 生产事故：2.8.1 壳发布后 App 待办完全不加载，生产不可用。）

**❌ 禁止：**
- 把插件代理对象 `await`、放进 Promise 链、或作为 async/Promise 的返回值
  （async 函数 return 代理对象 → Promise 调用它的 `.then` → `LocalNotifications.then() is not implemented`；
  该调用在启动关键路径时会中断整个 init——首屏 fetch、render、撤开屏全部不执行）

**✅ 必须做：**
- **只能** `await` 它的**方法调用的返回值**（如 `await LocalNotifications.schedule({...})`——那是 bridge promise）
- 跨模块传递插件实例用**同步函数**（见 `notify.js` 的 `getLocalNotifications`，时序由 `ensureCapacitorLoaded()`
  显式管理）；需要等待就 `await ensureCapacitorLoaded()` 再同步取
- 壳发布前：模拟器 + debug 壳 + CDP 直连 WebView，走**产品代码的真实入口**验证；硬指标 =
  `emptyState 或 todoCount > 0`（render 执行过）+ logcat/CDP 无 `exception`（release 壳不可调试；
  **探针直调原生插件成功 ≠ 产品代码路径成功**）。已列入 `CODE-REVIEW.md` 维度 C 检查项

**教训：** [docs/lessons/2026-10-02-capacitor-thenable.md](docs/lessons/2026-10-02-capacitor-thenable.md)
——完整根因、两个测试盲区、CDP 验证流程。

---

## 铁律九：删除只软删、永不自动清理

**原则：鉴于数据丢失的惨痛教训，所有数据的"删除"都采用软删除；不实现自动物理清理（2026-09-14 决策）。
软删除行无限期保留，由用户在回收站自行永久删除。**

**✅ 必须做：**
- 删除只打 `deleted_at` 时间戳，不物理移除（`todos` / `daily_notes` 均已实现）
- 物理删除只经用户显式操作：回收站 → 永久删除（两段式确认）；误删保障 = 撤销 Toast（5 秒）+ 回收站恢复

**❌ 禁止：**
- 新增任何物理删除路径（回收站显式永久删除除外）
- 实现自动清理 / 计划任务物理删除。理由：① 用户已有显式物理删除入口，自动清理 = 删用户没要求删的数据，
  对双人私密应用是纯粹负价值；② 收益≈0（软删除行只有 2 个用户产生，无存储/性能压力）；③ 风险 =
  历史最坏事故的形状（按时间谓词批量物理删真实数据）；④ 行业要义是「有意决定保留多久」，
  本项目的有意决定就是无限期保留

**⚠️ 例外/边界（触发重新评估的条件，满足其一再考虑）：**
软删除数据量级增长到影响查询/存储；或出现隐私合规要求；或用户明确想要「回收站 30 天自动过期」的产品行为。
若将来要实现，**不可削减的硬约束**：默认 dry-run、显式 `--apply` 才真删、先打印行数与 id 清单；
cron 无人值守形态要格外小心（先只报告不删一段，真删时告警与删除一起上）；其余直接适用铁律一
（先备份、禁谓词批量删）与铁律二（测试库验证）。

**教训：** [docs/lessons/2026-07-31-prod-data-loss.md](docs/lessons/2026-07-31-prod-data-loss.md)
——按谓词批量物理删正是 2026-07-31 事故的形状。UI 行为细节见 `PRODUCT-SPEC.md` §5.5（F-05）。

---

## 附一：本机模拟器速查（操作参考，非行为规则）

发版冒烟（铁律三第 6 步）与 debug 壳验证（铁律八）都要起模拟器。

- 启动：`emulator -avd Medium_Phone_API_36.1`（默认命令即可，2026-10-02 已彻底修复三类根因）；
  **就绪唯一标准：`adb shell getprop sys.boot_completed` 返回 1**（通知栏出现「Emulator is performing
  a full startup」= 正常冷启动，2-5 分钟，崩溃循环后首次可能更久；持续 5 分钟以上仍空 / offline =
  真卡死，杀掉再查，**不要原地等**）
- 三类根因均已持久化修复到 AVD `config.ini`：① `hw.gpu.mode=swiftshader_indirect`（软渲染绕开宿主 GPU
  间歇性挂死）；② `hw.ramSize=2048` 纯数字（带 M 带空格会被静默回退 256MB → 内核 panic 无限重启循环）；
  ③ 删除跨版本残留快照。**模拟器升级后若快照加载报错/挂死，直接删
  `~/.android/avd/<名>.avd/snapshots/default_boot`**（只丢开机内存态，不丢 App 数据）
- config.ini 写错会被**静默忽略**，真相在启动后生成的 `hardware-qemu.ini`——改完用它回读校验，别信"写过了"
- 完整排障手册（带内核日志取证、grep 清单、快照回环）：
  [docs/emulator-troubleshooting.md](docs/emulator-troubleshooting.md)

---

## 附二：技术栈速查（事实清单，非行为规则）

- **前端**：原生 HTML/CSS/JS（无框架），ES Module；**后端**：Supabase（PostgreSQL + Auth + Realtime），无自建服务器
- **打包**：Capacitor → Android APK（`com.love.todo`）；**PWA**：`manifest.webmanifest` + `sw.js`
  （仅浏览器环境生效，原生 bypass；版本号见文件内 `VERSION` 常量）
- **发布通道**：A 热更新（`release.mjs` / `release-web.yml` 审批门）+ B APK（`release-apk.mjs` /
  `release-apk.yml` 审批门）+ App 内自更新（`apk-update.js` + 自研 `ApkInstallerPlugin`）+
  测试通道（`release-test.mjs` 热更 / `build-test-apk.mjs --publish` 壳更新，只发【测试项目】——
  真机测试包自动收到，不经审批门，内容护栏强制包内 supabase.js 指向测试库；详见 release-runbook）；
  回读校验 `verify-release.mjs` / `verify-apk-release.mjs`（只读、可当 CI 门禁）；`release-web.yml` publish 后顺带跑
  `dora-metrics.mjs` 写进 Run Summary（`continue-on-error: true`——观测不该把已成功的发布变成红灯）
- **Capacitor 插件（2026-10-03 核实）**：`@capacitor/app`（`App.getInfo()`）/ `LocalNotifications` /
  `SplashScreen` / `@capgo/capacitor-updater`（热更）/ 自研 `ApkInstallerPlugin`；**状态栏无独立插件**
  （原生 `MainActivity` 的 WindowCompat/InsetsController + `styles.xml` 直接控制）
- **Storage bucket**：`todo-attachments`（图片附件，公开读）/ `app_updates`（热更 zip + APK）
- **CI/CD（5 个 workflow）**：`ci.yml`（Node 回归 + admin Playwright E2E + actionlint + 三个结构性检查）、
  `release-web.yml`（仅手动）、`release-apk.yml`（仅手动）、`e2e-web-full.yml`（每晚 02:17 北京，
  9 个双账号 E2E）、`codeql.yml`（静态扫描）。两个写生产的工作流共用 `production` 审批门但**各有
  concurrency 组**（`release-web` / `release-apk`），写不同的表/对象，互不需串行。
  ⚠️ `schedule` cron **按 UTC 解释**（本项目 `17 18 * * *` = 北京 02:17，分钟位不要写 0——整点是调度器
  负载高峰），且定时任务只在**默认分支**运行
- **供应链安全**：所有 `uses:` 固定到完整 commit SHA + `# vX.Y.Z` 注释（注释是 Dependabot 判断当前版本的
  唯一依据，缺了 = 安全补丁静默进不来；"固定 SHA"与"Dependabot 推更新"是一对，缺一不可）；仓库已开
  `sha_pinning_required`、secret scanning + push protection、Dependabot alerts / security updates（版本更新由
  `.github/dependabot.yml` 驱动）、
  `SECURITY.md` 私密上报；Dependabot **刻意不含 gradle**（`android/` 是生成工程，CVE 已由 alerts 覆盖）；
  取 SHA：`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`（`type=tag` 再解一层）
- **双环境切换（2026-10-06）**：一个包测试/生产可切（`env-switch.js`，长按头像 → 账号菜单
  「切换环境」→ 确认 → 写 `app_env` + reload）；测试环境角标在登录页与顶栏；`supabase.js`
  内含两套 anon 配置（主默认 + 显式对）——渠道身份决定无标记设备的默认环境；离线队列
  `@test` 分键、切环境取消提醒（铁律一例外段有完整护栏清单）
- **本地服务**：`serve.mjs`（端口 3000，生产库，仅手动自测）／`serve-test.mjs`（端口 3100，测试库，跑 E2E 必用）
- **测试库维护**：`reset-test-db.mjs`（归零）/ `check-test-env.mjs`（隔离）/ `check-test-schema.mjs`（契约）/
  `check-rls.mjs`（RLS 探针）
- **SQL 自动应用**：`apply-sql.mjs`（铁律三主通道；凭据 = 作用域受限 PAT `.env` 的 `SUPABASE_ACCESS_TOKEN`，
  sbp_fc_ 开头——账号级资产，绝不入库/入日志，怀疑泄露即 Dashboard 撤销重发换 `.env` 一行；
  setup 与安全设计见脚本头部注释；端点官方标注 experimental/Beta）
- **Web E2E 跑批**：`run-web-e2e.mjs`（`--files` / `--keep-data` / `--no-retry` / `--fail-on-flaky`）；
  依赖钉在 `scripts/requirements-e2e.txt`（CI 与本地同版本）
- **结构性检查（CI required job 内，纯静态秒级）**：`check-test-guards.mjs`（只读守卫）/
  `check-e2e-env-keys.mjs`（凭证键三方一致：代码读取/模板/两个工作流生成）/ `check-actions-pinned.mjs`
- **安全回归**：`test_rls_migration.mjs` / `test_rpc_migration.mjs`（PGlite 真 Postgres 跑
  `supabase/migration-rls-hardening.sql` / `supabase/migration-rpc-execute-hardening.sql`：
  复现洞 → 修复 → 幂等，进 CI）+
  `check-rls.mjs`（真实测试库 anon 探针，`admin/scripts/init-test-env.mjs` 第 ④ 步也调用）
- **DORA 四指标**：`dora-metrics.mjs`（只读）；口径唯一事实来源在 `scripts/_lib-dora.mjs` 头部，别在别处抄；
  事故与否由人在 `rollback.mjs --incident` 标注，不标留 NULL（不计入失败率，报告单独提醒），**不猜**；
  纯计算由 `test_dora_metrics.mjs` 用合成夹具钉住（无凭据、进 CI），6 列表结构见 `supabase/migration-dora-metrics.sql`
- **埋点状态**：⚠️ 目前零埋点，无法回答"哪个功能最常用""两人一天互动几次"（北极星 = 双端同日活跃天数，
  在路线图 P0）
