# 有爱待办 App — 代码审查标准与流程

> 目的：让「代码质量参差不齐」这件事可度量、可拦截、可复盘。
> 本项目是**一人公司**，没有 PR、没有第二个 reviewer。所以审查主体是 **AI 代码审查（第二双眼睛）+ 提交前自检 + 自动化兜底**，而不是传统的「同事 review」。

> **与 AGENTS.md 的关系（分工，不重复）**：
> - `AGENTS.md` = **原则层**：铁律（不可违反的红线），短，每次会话注入。只写「必须做 / 禁止做」。
> - 本文档 = **执行层**：审查 SOP（怎么检查的细节），长，审查时才翻。写「分级 + 六维度 + 四时点 + 话术」。
> - **单一事实源**：铁律在 `AGENTS.md` 定义，本文档 checklist 引用不复制；本文档细节不回写 `AGENTS.md`。`AGENTS.md` 铁律六只加一句「提交前必走审查」指向本文档。

---

## 一、审查分级

每条意见都要打标，避免「一条坏味道淹没一个核心 bug」。

| 级别 | 含义 | 处置 |
|------|------|------|
| 🔴 阻断 Blocker | 数据安全、正确性、安全漏洞；不修会丢数据 / 崩溃 / 被攻击 | 必须修复才能 commit / 发布 |
| 🟡 建议 Should Fix | 可维护性、性能、健壮性问题；现在不修会变技术债 | 应修；确有合理解释可豁免并留注释 |
| 💭 建议 Nit | 命名、注释、风格等锦上添花 | 可选，不阻塞 |

**原则**：先抓 🔴，再看 🟡，💭 一笔带过。审查的价值在「拦得住事故」，不在「挑得出毛病」。

---

## 二、审查标准（按维度 Checklist）

### 维度 A：数据安全 —— 本项目最高优先级（对应 AGENTS.md 铁律一）

> 这条是这个项目血泪教训最多的地方，永远排第一，任何维度都要给它让路。

- 🔴 是否触碰生产数据做测试？—— 禁止 `DELETE FROM todos` 等生产库修改，哪怕是「验证一下」。测试用 `E2E-测试-` 前缀标记的数据，只删带标记的。
- 🔴 删除是否走软删除？—— 所有「删除」必须 `deleted_at` 打时间戳，不物理 DELETE（唯一例外：回收站里的「永久删除」按钮）。
- 🔴 批量删除是否显式指定 id？—— 禁止 `.neq('id','全零')` 这种「删全部」模式。
- 🔴 删除前是否备份？—— 任何删除操作前先查再删 / 导出备份。
- 🔴 权限是否靠 RLS 兜底？—— 前端逻辑只做 UX，安全边界在数据库 RLS，不依赖前端判断。
- 🔴 **RLS「开关」与「策略」是两件事，且必须有回读校验**（2026-09-16，顾问报 CRITICAL）
  测试项目的 `profiles` 被报 `rls_disabled_in_public`（未登录可读可写），而仓库 `schema.sql`
  里一直是 `ENABLE ROW LEVEL SECURITY` —— 说明是**项目上被手工改过**，且没人回读。
  ⇒ 审查时问三句：① 这次改动动到表/策略了吗？② **目标项目**上 RLS 真的开着吗（不是"我写进 SQL 了"）？
  ③ 策略的 `TO` 角色写全了吗（漏写 `TO authenticated` = 对 PUBLIC/anon 开放，而 anon key 是公开的）？
  验证手段（都在仓库里，别靠肉眼）：`node app-e2e/scripts/check-rls.mjs`（anon 探针，不写数据）／
  `node scripts/test_rls_migration.mjs`（PGlite 真 Postgres 里跑一遍加固 SQL）。
  **共性**：凡「照文档在控制台粘贴一次」的配置（建表、策略、Auth 开关如 `disable_signup`），
  都会随环境漂移 —— 只有机器判定才算验证过。
- 🔴 迁移 SQL 是否幂等 + 是否在交付回复里贴出可复制版本？—— `ADD COLUMN IF NOT EXISTS` / `ON CONFLICT DO NOTHING`。
  ⚠️ 另外两条同样容易漏：① **中途报错会整体回滚**（SQL Editor 一个事务）⇒ 必须给每个可能不存在的对象
  加 `to_regclass(...) is null` 守卫，否则「修了一半」等于没修；② 交付前用**真解析器**过一遍
  （`pglast` 的 `parse_sql` + `parse_plpgsql_json`，或 PGlite 真跑），别靠"看着对"。
- 🟡 新增字段是否做了降级容错？—— 参考 `db.js` 的 `PGRST204` / `42703` 降级重查模式：迁移没执行时，老环境能不能继续跑？

### 维度 B：正确性

- 🔴 **「记录」是否如实描述了「制品」？**（2026-09-15 从 APK 通道挖出的一类缺陷，值得当独立维度看）
  凡是「数据库里写一行来描述某个即将被用户拿到的东西」，就要问：**这一行说的和那个东西里真的是同一件事吗？**
  实测反例（APK 通道，两个都真实的差点漏过）：
  - **`apk_native_versions.version_name` 可以和 APK 里真实的 `versionName` 不一致**：
    表里的值来自发布命令的入参，而客户端判断"要不要更新"用的是 **APK manifest 里的 versionName**
    （`App.getInfo().version`）。两者不一致 ⇒ App 反复提示同一次更新，**用户陷入无限重装**。
    而这个不一致**一路绿灯**：`versionCode` 有守卫、包内 `shell-version` meta 也校验 ——
    但那个 meta 是脚本自己注入的，**恒等于版本号、必然通过**（校验的是"我以为的值"，不是"制品里的值"）。
  - **`--code` 能让表里的 versionCode 与 APK 里真实的 versionCode 脱钩**（真实值永远取自 build.gradle）。
  ⇒ 判据：**校验必须锚在「制品本身」上，而不是锚在「我们写进去的变量」上**。
  如果只能校验后者，那至少要有一条断言把两者钉在一起（本例的做法：直接读 `build.gradle`，
  因为那正是 gradle 打在包里的那个值）。

- 🔴 状态一致性：`completed_by` / `completed_at` 这类联动字段是否同步维护？（正例：`db.js setCompleted`）
- 🔴 竞态：Realtime 自我回声是否会覆盖本地乐观状态？（正例：`state.js inFlight` 飞行追踪）
- 🔴 错误处理：创建 / 删除 / 完成等关键路径是否 try/catch 或统一 `wrapError`？
- 🔴 幂等：连点、重放是否安全？（正例：`unlockSticker` 用 `onConflict + ignoreDuplicates`；`addReaction` 处理 `23505`）
- 🔴 离线队列：离线重放是否可能重复 / 乱序 / 丢操作？
  ⚠️ **重放必须防重入**（2026-09-16）：队列项是"`createTodo` 回来之后"才出队的，两次并发重放会
  读到同一条 op → 补发出**两条重复待办**。触发条件并不罕见：`online` 事件连续触发两次即可。
  正例见 `app.js` 的 `replaying` 守卫。**验证方式**：不看代码看数据 —— 让 E2E 断言"补发后同文案
  只有一条"（本次就是这么抓到的：断言一加，偶发失败立刻暴露）。
- 🔴 **本地列表的权威性：已删除的项会不会被"装回来"？**（2026-09-16，用户可见 bug）
  删除是"从本地列表移除 + 异步落库"，中间有窗口。这个窗口里任何一次**整份 setTodos** 都会把
  已删项复活 —— 本项目有两条这样的路径：`init` 的首次加载、回前台的 `handleAppVisibility`
  （`db.listTodos()` 拿到的是删除落库前的旧数据）。Realtime **迟到的回声**同理（WebSocket 重连
  期间的事件会补推，实测延迟数秒）。
  ⇒ 做法：删除动作留**墓碑**（session 内记住已删 id），并在 state 的**唯一入口** `setTodos` 上
  过滤墓碑 —— 放在入口而不是各调用方，是因为"再加一条重拉列表的路径"时没人会记得过滤。
  恢复（撤销 / 回收站）时撤墓碑。
  ⚠️ 这类 bug **只在数据层核对时才会现形**：本地列表有它、库里已经没有了（截图看着"删除没生效"，
  实际是界面对不上）。定位手法：在 state 的写入口插桩 + 打调用栈，一次就指名道姓。
- 🔴 **「文档/注释宣称的行为」是否真有一条写入方链路？**（2026-09-16 从盲盒揭晓链路挖出）
  一个特性写在文档和注释里，不等于它真的会发生。判据是**两端都能指出来**：谁**写入**触发条件、
  谁**读取**并做出反应。反例：`rarity_seen` 号称控制"对方端揭晓提示"，但客户端**只写 `true`、
  从不写 `false`**，而 realtime 守卫要求 `=== false` —— 这条链路从上线起一次都没触发过
  （生产库只读实证：12 条隐藏款、`rarity_seen` 全为 true、0 条播过提示；文档却把它列为已实现功能）。
  ⇒ 验证手法（三条缺一条都可能漏）：
  ① 全仓库 grep 写入点（`grep -rn "字段名" public/`，看清写的是 true 还是 false）；
  ② 全历史 grep（`git log --all -S"<可疑写法>"`，确认不是"曾经有过、后来改坏"）；
  ③ **生产库只读统计**（取值分布 + 相关计数对不对得上）——③ 是压舱石：
  代码看不出「有没有真的发生过」，数据能。
- 🔴 **UI 提示类：是否共用一个单例节点、后写的会覆盖先写的？**（2026-09-16）
  本项目 Toast 是单节点 + 单 timer，`showToast()` 每次重置 `className/textContent`。
  于是「一次操作连发两条提示」= 后一条把前一条整条清掉，用户**永远看不到**先写的那条 ——
  本次实际被吞掉的信息：「图鉴已集齐」「图片上传失败，可长按补图」、完成待办提示里的
  **「撤销」按钮**（误完成后没有撤回入口，只留下语义相反的"开出X款！"）。
  ⇒ 判据：新增提示前先问「它会和同一动作里的另一条撞在同一秒吗」；会撞就合并成一条或走队列，
  不要指望"用户两条都能看到"。
- 🟡 边界：空列表、空字符串、超长文本（schema `CHECK char_length <= 200`）、`null` 图片路径。

### 维度 C：安全

- 🔴 XSS：用户输入（todo 文案、留言 content、昵称）渲染时是否转义？`innerHTML` 是否吞了未转义内容？
- 🔴 密钥：是否硬编码了不该出现的东西？—— 明确边界：`anon key` 可公开（靠 RLS），但 **`service_role key` 绝不允许进前端**。
- 🔴 **`.example` / 模板 / 文档 / 测试夹具里是否出现了真实凭据或真实账号标识？**
  真值只能放 `.env*`（已 gitignore）与 GitHub Secrets；仓库里一律占位符（`your-xxx` / `test-user@example.com`）。
  自查：`git grep -nE "PASSWORD=[^y]|@todo\.local" -- '*.example' '*.md'` 应为空或仅注释/占位符。
  **血泪（2026-09-15 发现）**：`admin/.env.test.example` 从 2026-09-08 起在 **public 仓库**里写着
  真实账号邮箱 + 真实密码（值已轮换作废，此处不复述），躺了一周才发现 —— 而生产账号用的是**同一个邮箱**，
  只要密码复用，这就等价于把账号贴在公网。**教训**：删掉文件里的值不够，历史提交里还有 ⇒
  发现即**先改密码**（让泄露值失效），再清理文件；且这类问题本该由 push protection 在推送时拦下（批次 D）。
- 🔴 SQL 注入：本项目直连 PostgREST 风险低，但手写 SQL / RPC 函数要逐一检查。
- 🔴 **函数权限：PostgreSQL 默认把函数的 EXECUTE 授予 `PUBLIC`**（2026-09-16 实测）
  于是 public schema 里每个 `SECURITY DEFINER` 函数默认都是「拿到公开 anon key 的任何人可调用」——
  而 anon key 是公开的（硬编码在客户端、随 APK 分发）。本次实测踩中三个：
  `create_test_user`（anon 可调 ⇒ 任何人能在测试项目建账号，而在"有账号即可读写全部数据"的模型下
  等于全库沦陷）、`increment_login_count` / `consume_login_count`（anon 可调 ⇒ 未登录就能写 `profiles`）。
  两个必须记住的点：① `revoke ... from anon` 是**空动作**（权限来自 PUBLIC），必须
  `from public, anon` **并补** `grant ... to authenticated`（漏了后半句，App 自己就调不动了）；
  ② 只写 `GRANT ... TO authenticated` 同样不移除 PUBLIC 的默认授权 —— 看着像加固，其实没堵上。
  验证：`node app-e2e/scripts/check-rls.mjs`（anon 调 RPC 必须 42501 + 暴露面白名单：多出任何函数都失败）
  ／`node scripts/test_rpc_migration.mjs`（PGlite 真跑一遍权限迁移，含"注册触发器没被弄坏"）。
- 🟡 输入校验：长度、类型、emoji、图片 MIME。
- 🟡 Storage：`todo-attachments` 公开读 bucket 是否会泄露不该公开的内容。
- 🟡 **供应链：本次是否新增了依赖？** 新增前先问「这个依赖值不值得引入」——维护状态、下载量、
  是否锁版本。另外要分清本项目的两道自动扫描（**它们扫的不是同一样东西**）：
  - `Dependabot` 扫**依赖**（package-lock / requirements）→ 找**已知 CVE**，靠 CVE 数据库
  - `CodeQL` 扫**你自己写的代码** → 找注入 / XSS / 路径穿越（本应用大量操作 `innerHTML` + 用户输入，
    正是 XSS 类查询覆盖的地方）
  ⇒ **把依赖全升到最新，也挡不住自己写出的漏洞**，两者不能互相替代。
  CI 里 actions 的固定策略见 F2 的供应链两条。

### 维度 B 补充：「下线 / 失效」能力的自带要求（2026-09-16）

- 🔴 **任何让某个东西"失效"的能力，必须同时给出一条可执行的 undo。**
  反例（本仓库真实缺失过）：`rollback.mjs --native` 若只能把壳版本置 `enabled=false`，
  而壳只有一行启用 —— 关掉之后没有任何脚本能恢复，只能手工写 SQL。
  正例：`--restore` 一个开关撤销。**没有 undo 的"下线"不是止损能力，是单向陷阱。**
- 🔴 **演练必须被证明是「状态中性」的**，而不是"跑完没报错"。
  做法：变更前**逐字段**存基线（含 `released_at` 这类"看起来无关但决定排序"的列），
  恢复后逐字段比对，打印"11 个字段完全一致"。
  血泪点：本项目客户端的挑版逻辑是「enabled 里按 `released_at` 倒序取第一条」——
  只比 `enabled` 字段会漏掉"released_at 被顺手动过 ⇒ 谁是最新变了"这类变化。
- 🟡 **破坏性动作的后果要"先打出来"，而不是事后解释**：`--dry-run` 与真跑共用同一段后果计算，
  所以预演看到的告警（如「已无任何启用版本 ⇒ 所有设备都不再收到壳更新提示」）与真跑一字不差。
- 🟡 **未知参数必须报错退出**，不能静默忽略：`--nativ`（打错字）若被忽略会 fallback 到默认通道，
  于是"想操作壳表"变成"操作了热更新表"。**手滑 + 默认值 = 改错表。**

### 维度 D：可维护性

- 🟡 文件规模：单个文件是否过长？—— 现状 `app.js` 1598 行已偏大（已拆出 lightbox / anniversary / action-sheet / confetti-effects，新代码别继续堆回去）。
- 🟡 单一职责：一个函数是否做了多件事？DB 映射是否集中在 `transforms.js`（snake_case → camelCase 不要散落各处）。
- 🟡 注释质量：注释解释「为什么」，不是复述「做了什么」。（正例：`db.js` / `state.js` 的根因注释）
- 🟡 技术债标记：新旧 API 并存是否有迁移提示 + 收口计划？（正例：`state.js` 的 `setRenderFn` vs `subscribe`，旧 API 已 `console.warn` 引导迁移）
- 💭 死代码 / 调试残留：`_debug-*.mjs`、临时探针记得清理。

### 维度 E：性能

- 🟡 N+1 查询：循环里 `await supabase` 调用（应合并为一条 select / 批量）。
- 🟡 Realtime 订阅泄漏：`subscribe` 后是否在页面销毁 / `beforeunload` 时 `unsubscribe`。
- 🟡 Storage 孤儿文件：删 todo 后图片是否成孤儿（现状：**已接受「孤儿无害」，且无任何清理机制** ——
  原先这里写「靠 `cleanup-deleted.mjs` 兜底」，但该脚本从不存在，2026-09-14 已按事实改正；
  若将来引入物理清理，必须遵守 AGENTS.md「软删除」章节列出的四条硬约束）。

### 维度 F：测试（对应铁律二）

- 🔴 核心流程（添加 / 完成 / 删除 / 双端同步）是否过了 E2E？—— Playwright 双账号 `小宝宝` / `大宝贝`。
- 🔴 **低概率 / 难触发路径有没有测试钩子？**（2026-09-16 加）
  "这条路径有测试"不等于"它被测到了"。盲盒的隐藏款是 15% 概率，E2E 随机跑根本撞不到，
  于是「开出 → 解锁贴纸」整条链**零覆盖**，三个真实缺陷（提示互相顶掉、序号撞车静默放弃、
  完成时撤销按钮被清掉）全都测不出来 —— 其中一个在生产库丢了 8 天的解锁量。
  ⇒ 做法：给随机性/外部条件留一个**只在测试里设置**的确定性开关（本次是 localStorage 的
  `__e2e_force_rarity`，生产没有任何入口写它），然后针对该路径写断言。开钩子本身也算改动，
  必须有"生产行为与不加钩子一致"的论证 + 清理断言（测完要删掉钩子）。
- 🔴 涉及 Realtime 的改动是否验证了双端同步（不是只看「没报错」）？
- 🟡 边界 + 错误处理是否覆盖。
- 🔴 无法验证的硬限制，交付时必须明确列出「未验证 X / 原因 Y」，禁止把「没测」说成「已验证」。
- 🔴 **等待是「等条件」还是「等固定毫秒」？** `waitForTimeout(3000)` / `sleep 5` 这类固定等待，
  本质是在赌「这段时间够」——赌注是 CI 机器比本地慢几倍。判断法：**删掉这个 sleep 会不会挂？**
  会挂 → 说明它在偷偷同步某个异步过程，应该换成显式条件等待（Playwright `expect`/`wait_for_selector`、
  pytest 轮询断言、本项目 `e2e_common.wait_until`）。
  血泪：批次 C 把 4 个 `.py` 里的固定 sleep 换成条件等待时，当场暴露出 `#stickerModal` 的
  「可见」早于 12 个格子渲染（`openStickerBook()` 是先显示弹层再 `await listStickers()`）——
  原先的 `sleep(800)` 一直在替这个异步 gap 兜底。**换成条件等待时，条件必须是「就绪」而不是「断言」**
  （等「出现了格子」再断言「是 12 个」，不要把断言本身等掉，那等于删掉了检查）。
- 🟡 测试脚本里是否有「跨通道共用测试库」的清理逻辑？统一用 `E2E-` 前缀过滤会**连其他通道的夹具一起删**
  （`E2E-APP-` 也以 `E2E-` 开头）。清理必须按自己的命名空间精确匹配。

#### F2. 工作流 / CI 改动专项（2026-09-14 批次 A/B 复盘新增；批次 C 补充 2 条；批次 D 补充 4 条；2026-09-16 CI 卡死复盘补充 3 条）

> 触发条件：本次改动碰了 `.github/workflows/**` 或 `scripts/release*.mjs`（发布/CD 类脚本）。

- 🔴 **新增/修改 workflow 后，是否真跑过一次？** 静态检查（`actionlint`）与本地逐块演练都查不出
  「runner 才有的行为」。血泪：`.release-tmp` 是点开头的隐藏目录 → `upload-artifact` 默认
  `include-hidden-files: false` → 制品静默没上传，而 **job 依然绿灯**（只有真跑一次才暴露）。
- 🔴 **产出类步骤是否「宽容」到能吞掉失败？** `if-no-files-found: warn` 会把「没产出」伪装成成功。
  自问：这一步有没有**验证产出确实存在**？
- 🔴 **设为 required check 的 job，是否每次 PR 都必然运行？** 带 `paths` 过滤或仅 `workflow_dispatch`
  的 workflow，在不匹配的 PR 上**永远不会运行** → check 停在 "Expected" → **PR 永久无法合并**。
  本项目只把 `ci.yml` 的三个 job 设为 required（它无路径过滤）。
- 🔴 **CD 类改动是否守住了「写生产必须有人工门」？** 见铁律三；`workflow_dispatch` + `confirm` 逐字确认
  + 版本守卫 + 环境评审人，任何一条都不要为了「自动化得更彻底」而拆掉。
- 🟡 上传制品路径含隐藏目录（点开头）时，是否显式 `include-hidden-files: true`？
- 🟡 是否在 CI 里执行上游脚本（`bash <(curl .../main/scripts/...`）？应改为下 pinned 版本的二进制/产物。
- 🟡 **`run:` 块里的「仪式性代码」是不是空操作？** 照抄同一段 shell 时先确认它在当前环境真的做事。
  实测（2026-09-15）：`e2e-app.yml` 的 keystore 块里有 `sed -i 's/^          //'` 去 heredoc 缩进 ——
  但 **YAML 的 `run: |` 块标量会先按公共缩进 dedent**，进到 shell 时 heredoc 每行已经没有前导空格，
  所以那行是**空操作**（已用 Ruby 解析 YAML 实测），它的注释「移除 heredoc 缩进」也是错的。
  更实际的问题是 `sed -i` 在 macOS 上必须写成 `sed -i ''`，照抄会让那段**在本地根本跑不起来**
  （报 `command a expects \ followed by text` —— 因为 BSD sed 把脚本参数当成了备份后缀）。
  判据：**这段 run 块能不能原样在本地执行一遍？** 不能 → 它要么在 CI 才第一次被执行（返工风险），
  要么本来就是死代码。同一批还顺手统一了 `openssl base64 -d -A`（BSD 的 `base64` 历史参数是 `-D`，
  只有较新 macOS 才认 `-d`），把「本地与 CI 行为不一致」的坑一起消掉。
- 🟡 **「预演」是否真的覆盖了要验的那条断言？** 带 `--dry-run` 的预演若跳过了关键步骤，
  它证明的只是「前几行没报错」。实测：APK 通道的 `--dry-run` 原先**跳过 gradle 构建** ⇒
  没有 APK ⇒ 三重守卫里最关键的「包内 meta == 本次版本」（防"发了个旧包"）**根本没被执行**，
  而报告却是绿的。修法是加 `--build` 让它预演时也真构建 —— **预演的价值取决于它跑到了哪一步**，
  不是取决于它绿了。
- 🟡 静态检查工具「某条规则被静默跳过」是否被察觉？`actionlint` 缺 `shellcheck` 时只在 `-verbose` 里
  说一句 `Rule "shellcheck" was disabled` —— 不看 verbose 会误以为已经全查过。
  **2026-09-15 补：这个缺口已经可以彻底关掉，不要再靠「逐块抽出来手跑」兜底** ——
  下个 shellcheck 静态二进制即可（无需 brew）：
  ```bash
  # 装到 ~/.local/bin 而不是 /tmp：/tmp 会被系统或工具清掉，清掉之后 actionlint 又会**静默退化**
  # 成「不查 run 块」—— 而这个退化的表现恰好就是「本地绿、CI 红」。
  # 把工具装在会被清理的地方，等于给这个坑装了个定时器（2026-09-16 实测被清过）。
  mkdir -p ~/.local/bin
  curl -sSfL -o /tmp/sc.tar.xz https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.darwin.x86_64.tar.xz
  tar -xJf /tmp/sc.tar.xz -C /tmp && mv /tmp/shellcheck-v0.11.0/shellcheck ~/.local/bin/ && chmod +x ~/.local/bin/shellcheck
  PATH="$HOME/.local/bin:$PATH" actionlint -verbose .github/workflows/*.yml   # verbose 里不再出现 "was disabled"
  ```
  **代价与收益的实测对照**：装之前，我新写的 workflow 本地 actionlint **exit 0**、CI 上却 5 秒红
  （`SC2012: Use find instead of ls`）—— 一次 push 白跑。装之后同一份文件本地立刻报出全部 run 块问题。
  **结论：本地工具缺一条规则 ≠ 少一个提示，而是「本地绿灯的可信度」被悄悄扣掉一块。**
- 🟡 **`run:` 块里别让任何一行以 `# shellcheck` 开头** —— 那是 shellcheck 的**指令**语法，
  它会把该行当指令解析并报 `SC1072/SC1073 Couldn't parse this shellcheck directive`。
  实测踩到（2026-09-15）：我写了一段注释解释「没装 shellcheck 时 actionlint 会静默跳过 run 块」，
  **换行后正好断在「# shellcheck」处**，于是这条注释自己把 lint 弄红了。改写措辞即可，
  不需要禁用规则。**这条也是「装了本地 shellcheck 才看得见」的那一类** —— 与本文件 F2 的另一条同源。
- 💭 失败诊断是否可从 CLI 读到？Run Summary 用 `tee -a "$GITHUB_STEP_SUMMARY"` 同时进日志，
  `gh run view --log` 即可核查，不必开浏览器。
- 🔴 **CI 生成的环境文件是否与本地「同形」？** 本地 `.env.test` 是手写的、什么都有；CI 那份是
  `printf` 出来的，少一个键就是「本地绿 / CI 红」。血泪（批次 C）：CI 只注入了 `E2E_TEST_EMAIL`，
  而 python 侧靠 `E2E_TEST_USERNAME` 登录 → CI 上必然拿不到凭证。
  已有机器判定：`node scripts/check-e2e-env-keys.mjs`（代码读取 / 模板 / 两个工作流三方一致，
  已进 CI required job）。
- 🔴 **带 `schedule` 的定时任务，cron 是否按 UTC 写的？** GitHub 的 cron **一律按 UTC** 解释
  （北京 = UTC+8：要跑 02:00 CST 就得写 `0 18 * * *`），且定时任务只在**默认分支**上运行。
  写成本地时间会得到「时间对不上」而无人报错的静默错位。
  🟡 **分钟位是否刻意避开了 `0`？** 整点是调度器负载最高的时候，官方文档点名
  "high load times include the start of every hour" 并建议错开。实测（2026-09-15）：
  `0 18 * * *` 的 run **迟到 2 小时 39 分**（创建于 20:39:44Z）—— 已改为 `17 18 * * *`。
  **配套认知**：定时任务「时间不保证」⇒ **到点了没看到 run ≠ 坏了**，先查
  `gh run list --workflow=<name>` 里有没有 `event=schedule` 的 run 再下结论
  （此前交接文档曾把"cron 会不会触发"列为未验证项，实测结论是**会触发、只是会晚**）。
- 🟡 **同一个测试库/环境是否会被多个工作流并发使用？** 各套用例的「归零」会互删对方夹具。
  要么共用同一个仓库级 `concurrency.group`（同名即互斥），要么按命名空间精确隔离；
  「概率很低」不是设计，是运气。
  **实测过（2026-09-15）**：定时全量回归与 APP E2E 时间重叠 → Appium 报 `no such element`，
  同一次提交在**独跑时是绿的**（A/B 对照）。机制：归零删掉全部贴纸 → 被测 App 重新开奖 →
  开奖 toast/特效盖住界面 → 找不到元素。**并发跑共享环境，红灯会变成随机噪声**。
- 🔴 **共享并发组里的每个 job，是否都设了 `timeout-minutes`？**
  组是「**谁持有谁独占**」：一个挂死的 job 会把它后面的**另一个工作流**一起挡在门外。
  实测（2026-09-16）：`e2e-app.yml` 两个 job 都没设 ⇒ 走 GitHub 默认的 **360 分钟** ——
  一个挂死的 Appium job 独占 `e2e-test-db` **4 小时 09 分**，期间定时全量回归的 run
  被挡了 **3h37m**。⚠️ 而它的表现是 **pending 且 `jobs` 接口返回 `total_count: 0`**
  （工作流级 concurrency 是「拿到组之前不建 job」）—— 看起来像"工作流没触发"，
  极易误诊成配置错误。**往共享组里加作业 = 必须同时给它一个超时上限。**
- 🔴 **`run:` 块里的外部命令（`adb` / `curl` / `ssh` / 云 CLI…）套超时了吗？**
  很多工具**自身没有任何超时**：对端异常时它会永久阻塞，而你的 job 只能等 GitHub 的默认 6 小时。
  血泪（2026-09-16）：设备侧 UiAutomator2 的 instrumentation 崩溃后，失败路径里的
  `adb logcat -d` 再没返回 —— 测试其实 7 分钟就跑完了，是这行**诊断输出**把 job 卡了 4 小时。
  **判据：只是给人看的诊断信息，绝不允许决定 job 的命运。** 正确形状是
  「`timeout N` 包裹 + 超时可见地告警 + 超时后跳过，不影响退出码」，例如：
  ```bash
  if timeout_t adb logcat -d -t 120 > "$LOGCAT_FILE" 2>&1; then
    grep -iE "love.todo|ANR|FATAL" "$LOGCAT_FILE" | tail -120 || true
  else
    echo "[ci-run] ⚠️ adb logcat 超时/失败（设备可能已失联）—— 跳过诊断"
  fi
  ```
  ⚠️ 两个配套细节：① 别再写 `2>/dev/null` —— 它把「超时/设备失联」这类**要命的信息**一起吞掉；
  ② macOS 没有 GNU `timeout`（是 `gtimeout`）⇒ 包装函数要 `command -v` 探测并**显式告警**
  退化为不包裹，否则「命令不存在」会被 `|| true` 静默吞掉、设备准备全部空转。
- 🔴 **`pull_request` 的 `paths` 是否漏了 workflow 自身？** 只改 workflow 的 PR 会因此
  **一个相关 E2E 都不跑**，改动只能等合并后在 main 上第一次执行 —— 与「改完必须真跑过一次」直接冲突。
  实测（2026-09-15）：`e2e-app.yml` 的 `push` 侧有 `.github/workflows/e2e-app.yml`、`pull_request` 侧没有；
  给串行化改动推第一版时 `gh pr checks` 里根本没有 App E2E，补上该路径后 `Build Test APK` 立刻出现。
  自查法：`on.push.paths` 与 `on.pull_request.paths` 是否**逐条对齐**（除非有意不同，且写明原因）。
- 🟡 定时/全量回归是否被误加进 required checks？**不该** —— 它不在 PR 上运行，设成 required
  会让 check 永远停在 "Expected"（与上面 `paths` 过滤那条同因）。分层触发的分工是：
  PR 门禁要**快而稳**，全量回归可以**慢而全**。
- 🔴 **所有 `uses:` 是否固定到完整 commit SHA，且带 `# vX.Y.Z` 注释？**（批次 D 供应链安全）
  tag 与分支都是**可变**的 —— 上游能把 `v4` 重新指向任意 commit，而你的工作流会照跑不误；
  这是 "SolarWinds 式" 供应链攻击最省力的入口。注释不是装饰：**Dependabot 靠它判断当前版本**，
  没有注释 = 它看不到这个依赖 = 永远不会提更新（静默盲区）。
  机器判定：`node scripts/check-actions-pinned.mjs`（已进 CI required job，秒级失败）。
  取 SHA：`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`（`type=tag` 时再解一层 `git/tags/<sha>`）。
- 🔴 **「固定 SHA」与「Dependabot 版本更新」是否成对存在？** 固定 = 再也不会自动变新，
  所以**必须有 `dependabot.yml` 的 `github-actions` ecosystem 来推**，否则安全补丁永远进不来。
  两者缺一个都不成立：只固定不更 = 冻在旧版本上；只更不固定 = 门敞开。
  ⚠️ 另注意：仓库开了 `sha_pinning_required` 后，**用到未固定 action 的那个 job 会在 "Set up job"
  阶段直接失败**（报错 `The action actions/checkout@v4 is not allowed in <repo> because all actions
  must be pinned to a full-length commit SHA.`，一个 step 都不执行）—— **2026-09-15 实测**
  （canary 分支 A/B：同一 run 里含 `@v4` 的 job 这样挂掉，另外两个只用固定 SHA 的 job 正常跑绿）。
  这条**推翻了我一开始写进文档的推断**（原文写"工作流根本不启动、check 不出现"）。
  教训：**推断性的机制描述，写进文档前必须被实测检验**，否则文档就在传播错误结论。
  也正因为失败发生在 runner 上（要推了才知道），`check-actions-pinned.mjs` 的本地秒级反馈仍有价值；
  更重要的是它还能查 `# vX.Y.Z` 注释 —— 那是开关**完全不管**、而 Dependabot 赖以工作的一环。
- 🟡 **依赖升级 PR 是否按「minor/patch 合组、major 各自单独」配？** 合组是为了降噪
  （一周 15 个 PR 没人看 = 等于没有 Dependabot）；但 major 刻意**不**合并 ——
  major 有 breaking change，合在一个 PR 里一旦 CI 红了**没法二分定位**是哪个依赖的锅。
- 🟡 **`permissions:` 是否显式声明了最小权限？** 本仓库默认已是 `read`，但
  **默认值是别人能在 Settings 里点一下改掉的东西**，而工作流文件里的声明会跟着代码一起被 review。
  最低要求：只读代码的 job 显式写 `contents: read`；CodeQL 那类需要 `security-events: write` 的单独声明。
- 🟡 **引入静态扫描（CodeQL）时，是否想清楚它的结论性质？** 它产出的是"**待定级的告警**"，
  不是"通过与失败"。在还没逐条定级之前就设成 required check，团队的第一反应会是给所有告警
  打 "won't fix" —— **门禁由此变成一张白纸**。正确路径与 `test_sticker_wiggle.mjs` 同构：
  观察若干周 → 统计真实告警/误报率 → 再谈能否当门禁。

---

## 三、审查流程（一人公司四时点）

### 时点 1：编码中 —— 即时自审（成本最低，收益最高）

- 写完一个函数 / 模块，直接问 AI：`审查 db.js 的 createTodo`。
- 只看新增 / 改动的代码（diff 思维），不重审全库。

### 时点 2：功能完成 —— 提交前审查（铁律五的 gate）

在 `git commit` **之前**，走一遍：
1. AI 按本 Checklist 审查本次改动的文件，输出 🔴/🟡/💭 清单。
2. 🔴 全清，🟡 有结论（修或豁免留注释）→ 才允许 commit。
3. 跑回归测试（`scripts/test_*.py` + `scripts/test_*.mjs`），断言 / 截图确认。

### 时点 3：发布前 —— 发布审查（复用铁律三的「发布前 5 步自检」）

1. 查线上 `app_versions` 最新版本号，新版本必须语义化更大。
2. 跑回归测试。
3. 涉及 SQL → 对话里贴可复制完整 SQL。
4. 涉及 APK → `apksigner verify` + 检查构建时间 + unzip 确认改动入包。
5. 交付回复列明「已做 X / 已验证 Y / 未验证 Z」。

### 时点 4：发布后 —— 复盘沉淀

- 出现线上事故 / 疑难 bug → 复盘根因，把「这次没拦住的点」加进本 Checklist，避免同类问题再犯。

> 铁律一的数据丢失、铁律三的版本号事故，本质上都是「发布前少了一道审查」。这四个时点就是把那道审查补上。

---

## 四、AI 审查用法（怎么在对话里触发我）

审查前把上下文给足，我才能给出「针对本项目」的意见，而不是通用套话。推荐话术：

```
审查本次改动：我改了 public/js/db.js 的 forceDeleteTodo（物理删除 + 清理 Storage），
请按 CODE-REVIEW.md 的标准，重点看数据安全和竞态，输出 🔴/🟡/💭 清单。
```

要点：
- 说清**改了哪个文件、改了什么功能**。
- 指定**重点维度**（数据安全 / 竞态 / 性能……）。
- 我输出的每条意见都会带「为什么 + 建议改法」，按 🔴→🟡→💭 排序。

---

## 五、自动化增强（可选，逐步引入，不搞过度工程化）

当前项目无 linter。一人公司场景建议「够用就行」，按需引入，不追求全家桶：

| 工具 | 兜住的低级错误 | 优先级 |
|------|----------------|--------|
| ESLint（`no-undef` / `no-unused-vars`） | 未定义变量、未使用导入、拼错函数名 | 🟡 建议 |
| Prettier | 格式统一 | 💭 可选 |
| 提交钩子（husky + lint-staged） | 提交前自动拦低级错误 | 💭 可选 |

> 注意：自动化只兜「机器能判定的错误」，兜不住「数据安全 / 竞态 / 业务正确性」——那些必须靠 AI 审查 + Checklist。

---

## 六、审查记录（可选）

每次提交前审查，可留一行结论到 commit message 或本文件附录，方便日后回溯：

```
[2026-09-07] forceDeleteTodo 重构：🔴0 🟡1（孤儿文件靠 cleanup-deleted 兜底）→ 通过
  ⚠️ 事后更正（2026-09-14）：那次豁免所依赖的 `cleanup-deleted.mjs` 从未存在，"兜底"不成立 ——
  该 🟡 实为未闭环（现状见维度 E：已接受孤儿无害 + 无清理机制）。
[2026-09-14] 批次 A 热更新接入 CD：🔴1（.release-tmp 隐藏目录致制品静默未上传，真跑 CI 才暴露；已修）🟡2（actionlint 缺 shellcheck 静默跳过 / 抽 _lib-env 时残留 2 个脚本未迁移，已留注释豁免）→ 通过
[2026-09-14] 批次 B actionlint 进 CI + 分支保护：🔴0 🟡0（新增 F2 工作流专项 8 条，把批次 A/B 的坑固化成检查项）→ 通过
[2026-09-14] 铁律审计第一批（两条 🔴）：🔴2（① `test_sticker_wiggle.mjs` 缺只读守卫，实测会向生产库发 PATCH profiles + 两个 RPC 写请求；② 文档引用了从不存在的 `cleanup-deleted.mjs`）→ 已修，🟡1（该脚本长期被记为「CI flaky」，真因是竞态 + 3 处从没跑到过的测试代码 bug；已修但仍有残余时序敏感，未并入 CI，留待批次 C 治理）
[2026-09-14] 批次 C 4 个 Web E2E 进定时全量回归 + flaky 治理：🔴0 🟡0 → 通过
  ⚠️ 附带发现 1 个**产品缺陷（未修，用户决定「先记录在案，后续批次修」）**：
  **隐藏款待办完成时，toast 上的「撤销」按钮会被抹掉（约 15% 命中，命中即必现）**
  - 链路：`confetti-effects.js` 的 `celebrateCompletion()` 先 `showToast(phrase, {action:{label:'撤销'}})`，
    紧接着调 `celebrateRarity()`；而 `blindbox.js:191` 的 `celebrateRarity()` 又 `showToast(meta.toast)`
    → `toast.js` 的 `showToast` **复用单例 `#toast` 元素**（先 `textContent = ''` 再写）
    → 第二次调用把第一次的内容**连同操作按钮一起清空**
  - 影响：隐藏款（rare/epic/legendary，合计 ~15%）待办完成后 **toast 的撤销入口不可用**；
    长按菜单的「撤销完成」不受影响（绕行路径存在，非数据安全类缺陷）
  - 怎么发现的（方法论）：用例表现为「15% 概率超时的 flaky」。给用例加失败现场快照后拿到
    `{cls:'todo todo--done todo--rare', toastText:'✨ 开出稀有款！', actionButtons:0}` ——
    **随机 flaky 的根因可以是确定性的**：随机的是「命中哪种稀有度」，不是「会不会出问题」。
    教训：**先拿现场证据（快照/截图），再谈"时序问题"**；「按经验调超时/加 sleep」会让这类缺陷永远查不出来。
  - 当前处置：用例对该缺陷做**隔离（quarantine）**——普通款断言 toast 撤销按钮，命中隐藏款时
    打印已知缺陷标注并改走菜单撤销路径验证状态可恢复。**隔离必须显式留痕**（不许静默跳过）：
    只有输出了「跳过理由」才算合规，否则等于把缺陷洗成绿灯。
[2026-09-15] 批次 D 供应链安全（actions 按 SHA 固定 + CodeQL + Dependabot 版本更新 + 最小权限）：🔴0 🟡0 → 通过
  · 4 个既有 workflow 共 32 处 `uses:` 全部固定到完整 SHA + `# vX.Y.Z` 注释（行为等价：固定的是
    当前 `@v4`/`@v2` 指向的那个 commit，只换不可变性，不换版本）
  · 新增 `scripts/check-actions-pinned.mjs`（机器判定）+ 4 个负向用例（unpinned / 短 SHA / 缺注释 / 无 @ref）
    与 1 个正向用例（含「注释掉的行不算已声明」）全部实测过
  · 新增 `.github/workflows/codeql.yml`（advanced setup，刻意不含 Python：scripts/*.py 全是测试工具链）
    与 `.github/dependabot.yml`（5 个 ecosystem；**刻意不启用 gradle**：android/ 是 Capacitor 生成工程，
    AGP/Gradle 兼容区间由上游定，盲升大概率红，而"有没有 CVE"已由 alerts 覆盖 —— 原生层只要可见性，不要自动改代码）
  · 三个只读 workflow 补显式 `permissions: contents: read`
  · 顺带确认：`secret_scanning_non_provider_patterns` / `validity_checks` **API 不接受**（第二次实测，
    返回 200 但值仍为 disabled）⇒ 需人工在 Settings → Code security 勾选，已列入待办
[2026-09-16] 通道 B 下线能力 + 真实演练（`rollback.mjs --native / --restore / --dry-run`）：🔴0 🟡0 → 通过
  · 与业主并行会话的术语对齐：`#41` 把「回滚」重定义为两层（**下线/止损** = `rollback.mjs`；
    **真回滚/恢复** = `release.mjs --from-git`），但两者当时**都只覆盖 web**。
    本批按该术语体系给通道 B 补上「下线」这一层，并在文档中明确「通道 B 的真回滚尚未实现」。
  · 真实演练（写生产，两次；均为业务动作，见铁律一「适用范围」）：
    下线 `2.1.28 --native` → **反向验证**（`verify-apk-release.mjs` 无参以「线上没有任何 enabled
    壳版本」失败 ⇒ 效果在客户端视角可见，不是脚本自报）→ `--restore` 恢复 → 正向验证通过 →
    **逐字段比对基线：11 个字段完全一致（含 `released_at`）** ⇒ 演练状态中性。
  · 只读/负向用例：`--help` exit 0；**无参数 exit 1**（原脚本行为，曾被我改成 0 后自查修回 ——
    按退出码判断成败的包装脚本会把"忘传参数"当成"下线完成"）；格式错 / 版本不存在 / 未知参数
    全部 exit 1 且报对原因；`--dry-run` 不写生产。
  · 顺带结清 `_lib-env.mjs` 头部挂了很久的待办：`rollback.mjs` 迁移（当初留的理由正是
    "迁移应当配一次真实下线演练一起做"，本批配着做了）。
[2026-09-15] 批次 D 收尾：实测证据 + 一处**文档推断被推翻**
  · **正向**：PR #15 七个 check 全绿（含 `Analyze (javascript-typescript)` 1m6s、APP E2E 8m55s ——
    第三方 `reactivecircus/android-emulator-runner` 固定 SHA 后照常跑通，证明固定是**行为等价**改动）；
    开启 `sha_pinning_required` 后 dispatch `ci.yml@main` 仍正常（门没误伤正常流水线）
  · **负向**：canary 分支把 `checkout` 改回 `@v4` → 该 job 在 **"Set up job" 阶段失败**、零 step 执行，
    报错 `The action actions/checkout@v4 is not allowed … must be pinned to a full-length commit SHA.`；
    **同一 run 的另外两个 job（只用固定 SHA）照常全绿** —— 单次 run 内完成 A/B 对照
  · ⚠️ **推翻了原文推断**：我原先把 `sha_pinning_required` 的失败方式写成「工作流根本不启动、
    check 直接不出现」，实测是「per-job、响亮、带明确报错」。已按实测更正 4 处文档
    （本文件 F2 / AGENTS.md / ci.yml 步骤注释 / check-actions-pinned.mjs 头部）。
    **方法论**：推断性的机制描述写进文档前必须被实测检验 —— 否则文档在传播错误结论，
    而它看上去和正确答案一模一样地自信。
  · **CodeQL 查询集实测对照**（同一份代码、只换一个参数）：default → 87 规则 / 0 告警；
    security-extended → 103 规则 / **6 告警**（1 条可证伪的 XSS 误报 + 3 条 release 脚本的 TOCTOU
    + 2 条 check-test-schema 按设计的"读凭据发请求"）。**逐条定级结论与升级步骤已写进
    `codeql.yml` 的注释**；本次刻意不翻档：dismiss 掉发布链路里的 TOCTOU 属 owner 判断（铁律三）。
  · **Dependabot 存量**：22 条告警（15 high / 7 medium）→ 合并 #12/#13 后 **10 条**
    （全部 dev-scope，无一条随产品分发）。顺带发现 `sharp` 是**声明了但全仓库无人 import** 的
    遗留 devDependency —— 记在 SECURITY.md，是否移除留给后续。
[2026-09-17] 置顶改为页首「置顶」章节（v2.7.72）：🔴0 🟡2（均已修/已记）→ 通过
  · **起点是一次只读排查，不是"顺手重构"**：线上 2 条置顶**都是已完成项、且都是带图的资料**
    （「迪士尼计划」6 图 /「拉臭恐惧消除计划」2 图 + 备注），按旧实现分别排在页面第 **7**、第 **16** 行
    —— 置顶**根本没生效**（分章会给章内重排，`sortTodos` 的 pinned 优先级被整条丢掉），
    而不是"效果变弱"。业主的诉求是"随手翻得到"，不是"排第一"，故改成页首独立章节。
  · 🔴0：无生产写入、无 schema/RLS 改动、无删除动作；E2E 全在测试库（三个 preflight 先过）。
  · 🟡1（已修，本次最有价值的一条）：新单测第一版用**位置断言**取章（`l2[3].todos`）。
    变异实验（把置顶项整段丢掉）证明：实现"少一章"时位置断言抛 TypeError ⇒ **文件后面的 21 条用例
    （含"每条待办恰好出现一次"这条最要命的不变量）全部不跑**，报告只显示 5 条红 —— 属于维度 F
    的"测试写了却抓不到 bug"同类坑，且比它更隐蔽：**是断言的取章方式让不变量被跳过**。
    已改成按 key 取章 + 不变量提到最前 + 对**每份夹具**都跑；三处变异现在都被抓到
    （一条重复出现 / 一条凭空消失 / 差额提示永不显示）。
  · 🟡2（已记入文件头）：`test_pin.py` 有断言依赖"页面上只有我造的这两条"，与另一个 E2E 并发跑
    同一测试库时会串台（实测踩到：后台全量回归 + 手工单跑同时进行，报告像布局 bug、实为环境串台）。
    走 `run-web-e2e.mjs`（串行 + 每例前归零）不存在该问题；已在文件头写明这条限制。
  · **顺带更正一处「文档与代码不符」**：PRODUCT-SPEC 原写"对已完成的卡片置顶，它落在该章**内**第一位"
    （v2.7.71 的实测记录）—— 用仓库里的 `state.js` + `timeline.js` 复现不出：一条置顶、但完成时间
    最早的项，章内位置是 **2/4**。已按事实改写（并记下"为什么当时不做、现在为什么做"的翻案理由）。
  · **零覆盖问题闭环**：置顶此前**一条测试都没有**（这正是它在 v2.7.68「纸与光」、v2.7.70「时光章节」
    两次改版里静默失效而没人发现的原因）。本次补两层：纯函数不变量（`test_timeline_grouping.mjs`
    第 11 组，进 CI required job）+ 双账号 E2E（`test_pin.py`，含**对端 Realtime** 同步与冷启动，
    进夜间全量回归）。全套 5 用例：5 直接通过 / 0 flaky / 248.1s。
```

---

## 附：本 Checklist 与 AGENTS.md 铁律的对应关系

| 审查维度 | 对应铁律 |
|----------|----------|
| A 数据安全 | 铁律一（绝不触碰生产数据）、软删除机制 |
| F 测试 | 铁律二（交付前全面测试） |
| 时点 3 发布审查 | 铁律三（发布前 5 步自检） |
| 时点 2 提交前审查 | 铁律五（改完即提交的 gate） |
| 文档同步 | 铁律四 |
[2026-09-16] 第二批 第 2 步 · 时光章节（已完成按完成时间分章，v2.7.70）：🔴0 🟡2 💭1 → 通过
  · 数据安全（维度 A）：**零写操作** —— 纯前端渲染 + 新增一个纯函数模块，无 SQL、无迁移、
    不碰生产数据。新增的纯计算单测不 import playwright / supabase-js，按 `check-test-guards.mjs`
    的判据不需要只读守卫（该判据已由 CI 结构性检查兜住，不是靠自觉）。
  · 正确性（维度 B）—— 本次两个坑都在这里，处理方式与证据：
    ① **时区日界**：`completed_at` 是 timestamptz，分组必须按设备本地年月日。
       验证不是"跑绿了"，是**变异测试**：把实现改成 `toISOString().slice(0,10)` → 测试红；
       改成按创建时间排 → 测试红。两个变异体都被抓住。
       ⚠️ 过程中发现一个**绿着的假测试**：时区断言只在非 UTC 主机有区分力，而 **CI runner 是 UTC**。
       对策：同一组夹具放进 `TZ` 固定的子进程再跑（UTC / 上海 / 纽约 / 基里巴斯 / 加尔各答）。
       （已沉淀到本机素材库 #39）
    ② **章节顺序**：分章按完成时间 ⇒ 组内也必须按完成时间，否则会切出乱序章节
       （`completed_at ≥ created_at` 但两者序不单调）。跨月（9/1 看 8/31）与跨年（1/1 看 12/31）
       由既有"章节按章内最新一条排序"自然处理，**没有写特判** —— 并补用例把"不加特判也成立"钉住。
       （已沉淀到本机素材库 #40）
    ③ 渲染重排：章节头与卡片进**同一个** fragment（PLAN 的头号实现坑）。用改前/改后 DOM 逐节点对照
       验证，并**专门断言"第二次 render 之后"**的位置 —— 不是看代码推。
       （已沉淀到本机素材库 #41）
  · 🟡 **1｜「置顶且已完成」的位置变了 —— PLAN 未覆盖，是我审查时自己挖出来的**
    根因：`sortTodos` 第一优先级是 `pinned`，所以旧实现里「置顶且已完成」排**列表第 1 位**（在所有未完成之前）；
    分章后它随完成时间进入章节，不再占顶部。⚠️ 这是本次**唯一一处超出"纯排序"的行为变化**，必须上报业主。
    实测取证（临时探针，跑完已删）：置顶 B → 完成后落在「今天」章内（第 5 位）；对已完成的卡片置顶 →
    落在该章内第一位；卡片仍带 `todo--pinned`（📌 照旧）；**撤销完成立刻回到列表顶部**。
    定级理由：不是缺陷（新结构下"上面是要做的事、下面是走过的日子"，把已划掉的卡片摆在「要做的」之上
    会破坏整页读法，而 pinned 的本意"别淹没在待办里"对未完成项完全保留），但**属未闭环的产品判断** ——
    已写进 `PRODUCT-SPEC.md`（含"若将来要保留，应新开『置顶』章节而不是塞回未完成区"）。
  · 🟡 **2｜`completed_at` 由客户端写入 ⇒ 设备时钟不一致会影响归属**
    `db.js setCompleted` 用 `new Date().toISOString()`，对方设备时钟偏快时完成时间可能落在未来。
    后果**只是归属/位置偏差**（轻微未来 → 落「更早 · 本月」；跨月未来 → 自成一章并排最前），
    **不丢数据、不影响计数**（不变量用例守着）。要修必须先决定"以谁的时钟为准"，属产品决策 →
    本次**不擅自兜底**，只如实写进 `timeline.js` 头部注释与 PLAN 的"硬限制"清单。
    附：这不是本方案引入的 —— 旧实现按 `created_at` 排，而 `created_at` 同样是客户端写的，暴露面等价。
  · 💭｜`takeChapter` 回写复用池（防同一 key 被取两次时静默出现两个同名章节头）；首次创建时
    `createChapter` + `updateChapter` 有一次冗余写入（可读性换一次无谓的 textContent 比较，保留）。
  · 测试（维度 F，全绿，且**最后一版代码重跑过**）：
    三个 preflight ✅ ／ `run-web-e2e.mjs` 4 用例 ✅（0 flaky；改完最后一处代码后**重跑**，
    190.3s）／ 新增 `test_timeline_grouping.mjs` 45 项 ✅（进 CI 显式列表）／
    `check-test-guards` + `check-e2e-env-keys` + `check-actions-pinned` ✅ ／
    其余 Node 回归 ✅（compress / pinch / sakura_colors / rls_migration / rpc_migration / dora×2 / update_count）
  · 改前/改后 DOM 逐节点对照（临时探针，跑完已删）27 项 ✅，含：未完成段与改前**逐字一致**、
    已完成段从"创建序"变成"完成序"（本次目的被钉住）、隐藏款（`todo--done todo--legendary`）
    计算样式仍是 `linear-gradient(155deg,…)`（CSS 级联陷阱未被触发）。
    ⚠️ 该探针第一遍曾误报"卡片重复渲染" —— 真因是探针自己跑了第二遍、测试库里有两份同名数据。
    教训：**调试探针必须自带归零**，否则会把自身的脏数据读成产品缺陷。
  · 遗留（明示不做，非遗漏）：`.todo--rare.todo--done` 的 `saturate(0.7)`、其余 9 处悬空 CSS 变量
    （会改顶栏/空状态观感，另开小 PR）。
[2026-09-16] 修 Appium 用例跟上 v2.7.69 契约（取消完成改走「撤销」Toast）：🔴0 🟡1 💭0 → 通过（**由 CI 验证**）
  · 背景：v2.7.69（#59）有意移除「再点已完成卡的复选框取消完成」入口，但
    `app-e2e/tests/todo.spec.js:84` 仍在断言旧契约 ⇒ 该作业**在 main 上连红 3 个 commit**
    （#58 是设备抖动、#59/#60 是这同一条用例，两次重试同一处失败：
    `elementClick` 返回成功、库里 `completed` 回不到 false）。
    危险的不只是红，而是它**不是 required check** —— 一条被工作流自己判为「按真回归处理」的信号
    静静挂了 3 个 commit 没人处理。
  · 修法：改为点击**完成瞬间那条「撤销」Toast**（v2.7.69 起取消完成的两个可达入口之一），
    并补 UI 侧同验（`isTodoMarkedDone`：读复选框无障碍标签）。
  · 🟡 **1｜本地验证没跑通，如实记录**：我最初按"最贴近用户路径"选了长按卡片菜单，
    但长按手势在模拟器上弹不出菜单，连跑 6 轮（每轮 2–5 分钟）仍分不清是手势写法错还是菜单没出来。
    ⇒ 换成同套件**已跑通**的元素点击原语，断言语义不变。**验证手段本身必须先被证明可靠**，
    否则无法归因（已验证手段本身改坏了东西？还是被测对象真的坏了？）。
    最终结论：**由 CI 的 `APP E2E (Appium)` 判定** —— 结果 ✅ 一次通过（3 passing，未触发重试）。
  · **附：一个未查清的产品级疑点（本次调查的主要产出，业主已知情）**
    v2.7.69 用 `opacity:0 + pointer-events:none` 堵「点右上角静默取消完成」。取证结论**互相矛盾**：
    - 桌面 Chromium：**有效**。`elementFromPoint(复选框中心)` 返回 `.todo__headline`；
      `page.mouse.click` 真实坐标点击**不翻转**状态；正对照（`page.mouse.click` 点 FAB 能开面板）
      证明点击确实送达 ⇒ 浏览器侧 `pointer-events:none` 成立。
    - Android 模拟器：**矛盾**。`adb shell input tap` 打在该坐标上 `completed` 确实翻了；
      但同一坐标**快速点未完成卡片**的复选框又完全没有反应（而同一次 adb tap 点 FAB 能开面板，
      说明坐标与注入都正常）。
    ⇒ 机制没查清之前：**不写断言**（写了就是替未验证的结论背书）、**不擅自改产品代码**。
    已建议的下一步：开 WebView 调试（`setWebContentsDebuggingEnabled`）后在设备内直接读
    `getComputedStyle` 与 `elementFromPoint`——本次 Appium 只暴露 `NATIVE_APP` 上下文，
    拿不到页内取证能力。
  · 安全（维度 A）：两个文件都是**测试代码**，不进发布包（`release.mjs` 只打 `public/`）；
    模拟器跑测期间 `build-test-apk.mjs` 按设计先指向测试库、跑完自动还原为生产库配置（已回读核对）。
    本地用过的临时探针（`app-e2e/tests/_probe*.spec.js`、`scripts/_debug-*.mjs`）**已全部删除**。
