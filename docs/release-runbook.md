# 发布 Runbook（铁律三的操作细节）

> 铁律三只保留规则、命令与守卫；本文是**按需细节**——发布操作进行中、或版本操作出问题时来这里查。
> 结构：通道选择 → 通道 A（热更新）→ 下线≠回滚 → 通道 B（APK）→ APK 自更新机制。

## 通道选择

- 只改 `public/`（HTML/CSS/JS、图片等）→ **通道 A 热更新**
- 动了 Capacitor 插件、`capacitor.config.json`、`AndroidManifest.xml`、原生权限等 → **通道 B APK**（热更覆盖不到）
- 要让**真机测试包**收到（不经生产、不重装 APK）→ **测试通道**（见下方「测试发版通道」）

## 测试发版通道（2026-10-05 新增）

**受众**：`build-test-apk.mjs` 产出的测试包（指向独立测试项目）。生产包与它零交集。

| 场景 | 命令 | 说明 |
|---|---|---|
| web 层改动要真机验证 | `node scripts/release-test.mjs <x.y.z> --notes "..."` | 打包 public/（暂存副本注入版本号 + **supabase.js 改写指向测试库**）→ 上传测试项目 bucket + 写 `app_versions`；真机测试包下次冷启动自动下载 |
| 原生层改动要真机验证 | `node scripts/build-test-apk.mjs --publish` | 构建（assets 改写指向测试库）→ 上传 APK + 写 `app_native_versions`；真机弹壳更新面板 |
| 内容不在当前工作树 | 两个脚本都支持/注意 | `release-test.mjs --from-git <ref>`；`build-test-apk` 永远打当前工作树——共享工作树上停着别的分支时先确认 `git branch --show-current` |

**硬约束（脚本内置 fail-closed）**：
- 目标 URL ≠ 生产库（铁律一物理隔离，启动即校验）
- zip/APK 内 supabase.js 必须指向**测试库**且不得出现生产库 URL（真机热更后读写的是包内 supabase.js 指向的库——指向生产 = 测试设备变成生产客户端）
- 版本号在**测试项目的表内**唯一且语义化递增（含已下线；与生产版本序列相互独立，建议与"打算发的生产版本号"对齐）
- 壳更新：versionName / versionCode 都必须 > 测试项目历史最高（改 `android/app/build.gradle` 后再跑）
- 发布后回读：版本行 enabled + 签名 URL 下载 + 内容/SHA-256 校验（写成功 ≠ 客户端拿得到）

**基线迁移**（新测试项目一次性执行）：
`node scripts/apply-sql.mjs supabase/migration-test-release-channel.sql --project test --apply`
—— 建 `app_versions` / `app_native_versions` / `app_updates` bucket。**严禁在生产项目执行**（生产写入走 service_role 的 release.mjs，不需要也不应该有这些表以外的通道）。

**配套守卫**：`check-test-schema.mjs` 的安全断言已从「测试库不得有启用版本」改为「**启用包必须指向测试库**」——发布脚本同款校验的兜底，防绕过脚本手工塞行。

## 通道 A：热更新

### 命令与自动步骤

```bash
node scripts/release.mjs <版本号> --notes "<说明>"
```
自动：注入版本号 → 打包 public/ 为 zip → 上传 Supabase Storage `app_updates` bucket → 写 `app_versions` 表。

### 执行环境二选一（同一套脚本，不是两条通道）

- **本地直跑**（前置：在 main 上、工作区干净）
- **远程 CD**：GitHub Actions → `CD · Web 热更新发布` → 先 `dry_run=true` 看预演报告 → 确认后
  `dry_run=false` + `confirm=<版本号>` → 在 `production` 环境点 Approve 才真正写生产。
  工作流内有 dev 守卫（非 main 直接失败）。**在 feature 分支上发布** = 把没合并的代码发到线上，
  并让 main 落后于线上（制造出「仓库 meta 与线上 bundle 不一致」的隐患）。

### 版本真相与 meta 机制

- **版本真相 = 发布命令传入的版本号（+ `app_versions` 表），仓库不持有它**（2026-09-14 改）
- `public/index.html` 的两个 meta 恒为**占位值 `0.0.0`**，由构建期注入：热更在 `release.mjs` 的
  **暂存副本**上注入（发布对工作区零改动），APK 由 `release-apk.mjs` 在 cap sync 后注入
  （`app-version` = 线上最新 web 版本，`shell-version` = 本次壳版本）
- 占位值是 fail-safe：万一漏注入，App 只会多重启一次，不会「本地偏高 → 永远收不到更新」
  ⇒ **发布后不需要任何 meta 补提交**（旧设计下的「补 PR + 模拟器 CI」已随设计消失）

### 版本号纪律（完整版）

- 发布前必查 `node scripts/query-latest-version.mjs`（只读，打印两个口径：最新 enabled 版本 +
  **历史最高版本**）
- 新版本号必须**语义化大于「历史上出现过的最高版本」**，不只是大于 enabled 的最新的那个
  （2026-09-16 收紧）：已下线的版本号也算"用过"——客户端判定更新是「服务端版本 ≤ 本地版本 → 无更新」，
  而设备本地版本可能是某个曾经下发、后来被下线的版本（回滚演练留下的 2.7.65 就是这种行），
  只跟 enabled 行比会放行那批设备
- `release.mjs` 内置 `assertNewerThanLatest()`，版本号不够高直接拒绝发布——不靠记忆
- 教训：[2026-08-07-stale-version-no-update.md](lessons/2026-08-07-stale-version-no-update.md)
  （没查线上直接发 2.0.1，线上已 2.2.4，用户连开几次都没变化）

### 「打开一次 App」的机制（告知用户用）

`update.js` 是 `download → set → 立即 reload()`，**同一个会话内**就完成切换（重载前原生 SplashScreen
盖住，用户看到「粉色爱心 → 平滑过渡」）；「杀掉重开两次」只在用户于下载完成前就把 App 杀掉时才需要。

### 发布后回读校验

`node scripts/verify-release.mjs [版本号]`（只读）：版本行 enabled / Storage 对象可下载 / 包内 meta 一致。
**写成功 ≠ 客户端拿得到**，脚本没报错不等于交付完成。

## 「下线」≠「回滚」（完整语义，别再把前者当后者）

### 下线 / 止损

`node scripts/rollback.mjs <版本号>`（热更新）/ `... <版本号> --native`（APK 壳）——把对应版本表的
`enabled` 置 `false`。另有 `--restore`（撤销误下线）与 `--dry-run`（只看影响不写生产，与真跑共用同一段
后果计算，预演看到的告警与真跑一字不差）。

- 效果：**还没更新的设备 + 新装机**不会再拿到这个版本
- 通道 B 特有：关掉**唯一**的启用壳版本后，**所有设备都不再收到壳更新提示**（脚本会把这个后果先打出来）；
  壳安装是用户手动点的，止损对"已经点了安装的人"无效
- ❌ 它**不能把已经更新的设备退回去**：那些设备本地版本已经更高，服务端"最新"比它低 → 判定无更新 →
  永远停在那儿

### 真回滚 / 恢复（只覆盖通道 A）

`node scripts/release.mjs <新版本号> --from-git <旧 ref>`——内容取自旧 ref 的 `public/`、版本号用更高的
新号、包内 meta 注入**新号**（⚠️ 包内 meta 若是旧号，客户端下完会判定"又有新版本"→ **无限重装**）。

- 任意 git ref 可用（annotated tag 也能直接用——`git rev-parse --verify <ref>^{commit}` 解析）
- 先 `--dry-run` 预演（会打印"本次将回退掉哪些改动"）
- 因为是重发已发布过的旧代码，此模式下「改动必须先合并 main」这条前置不适用

### 回滚锚点用 tag，不要用本地分支（2026-09-16 定型，实测过）

`git tag -a anchor/<版本或日期>-<主题> <sha>` **并 `git push origin <tag>`**，正文写清"为什么留"。
本地 `backup/*` 分支**不是备份**——实测 12 个本地分支 11 个冗余、1 个是某功能唯一副本却只活在硬盘上。
教训：[lessons/2026-09-16-backup-branches.md](lessons/2026-09-16-backup-branches.md)

### 自动兜底只有一种

`resetWhenUpdate:true`（连续启动崩溃 3 次自动回退）——**只覆盖崩溃类故障**。UI / 文案 / 逻辑类问题
（App 照常启动）不会触发它，只能靠上面两条命令。

## 通道 B 的 `--from-git`（退回旧壳）：决定暂不实现

（2026-09-16 决策；2026-10-03 复评**维持结论、理由更新为事实版**）

- 壳已发布多个版本（2.8.0 误发布后已 `enabled=false`、2.8.1 事故壳），「还没发过壳版本、没有真实基线」
  的前提已不存在
- 2.8.1 事故的实际止损 = `rollback --native` 下线 + 热更 2.7.78 修复，坏壳设备拉热更后**自愈**——
  实证了「发一个修好的更高版本」足以止损
- Android 不允许 versionCode 更低的包覆盖安装，"退回旧壳"只能是「旧壳代码 + 更高的 versionCode」，
  实现路径重、易写错，收益未超过成本
- 坏壳止损手段（在它落地之前）：`rollback.mjs <版本号> --native`（停止推送）+ 发一个修好的更高版本——
  ⚠️ 前者救不了已经装了坏包的人
- 重新评估触发条件：出现「新壳启动即崩、旧壳可用」且热更无法覆盖的故障形态

## 通道 B：APK

### 命令与自动步骤

```bash
node scripts/release-apk.mjs <版本号> [--notes "..."]
```
自动：**cap sync** → 注入 assets 版本 meta → gradle 打包 → 校验包内 meta + 签名 → 写 `app_native_versions`
表 → 上传 APK → （本地跑时）覆盖 `~/Desktop/有爱.apk`。

CD：GitHub Actions → `CD · APK 发布（原生壳）` → 先 `dry_run=true` 看预演报告（**真构建**，产物可从 run
里下载安装验证）→ 确认后 `dry_run=false` + `confirm=<版本号>` → `production` 环境点 Approve。
工序与 release-web.yml 同构。

### CI 发布前置（两段式，必须先合再发）

版本号是发布命令传入的，但 **`versionCode` 与 `versionName` 都在 `android/app/build.gradle` 里**——
它们属于代码改动，必须**先走 PR 合并到 main**。`release-apk.mjs` 守卫（**一次性报出全部不一致**）：

- **`versionName` 必须逐字等于本次发布的版本号**：客户端把 APK manifest 里的 versionName 当本地版本
  （`apk-update.js` 用 `App.getInfo().version`）与表里的 `version_name` 比，不等 ⇒ **无限重装**。
  教训：[lessons/2026-09-04-apk-infinite-reinstall.md](lessons/2026-09-04-apk-infinite-reinstall.md)
- **`versionCode` 必须严格递增**，基准是**含已下线行**的历史最大值（Android 不允许同码覆盖安装；
  2.8.0 误发布后已 `enabled=false`，但它的 code 33 已经用掉了）
- `--code` 参数**不允许**与 `build.gradle` 不一致：APK 里真实的 code 永远取自 `build.gradle`，
  用 `--code` 覆盖只会让表里记的号和包里装的不一致

### 打包后验证

构建时间（确认是最新）、签名通过（`apksigner verify`，工作流里有独立步骤）、关键改动已入包
（unzip 检查，脚本第 5b 步）。

### 发布后回读校验

`node scripts/verify-apk-release.mjs [版本号]`（只读）：版本行 `enabled` / Storage 对象可下载且字节数一致 /
**SHA-256 与表里一致** / 包内 meta 一致。

SHA-256 是 APK 通道独有的关键项：`apk-update.js` 在唤起系统安装器**之前**会比对它，对不上就**拒绝安装**，
用户侧表现是"下载完成后毫无反应"（服务端全绿）——和热更通道的 `verify-release.mjs` 是同一个
「写成功 ≠ 客户端拿得到」的道理。

⚠️ **CI 发布不覆盖 `~/Desktop/有爱.apk`**（runner 没有你的桌面）。需要桌面留档时从 run 的 artifact 下载，
或本地跑一次。

## APK 自更新机制（App 内提示升级，与"打 APK"区分）

- `public/js/apk-update.js`：冷启动 + 前台切回（60 秒节流）时，用 `App.getInfo()` 读**真实 versionName**
  （非热更新 meta 值），与线上 `app_native_versions` 最新版本比对
- 命中更新 → 原生插件 `ApkInstaller` 下载（**sha256 校验**）→ 唤起系统安装器
- **强制更新**：`is_force_update=true` 或本地 < `min_supported_version` 时，更新面板不可关闭
- **版本号纪律**：`versionCode` 必须**严格递增**（脚本强制校验）
