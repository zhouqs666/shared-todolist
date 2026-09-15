# 安全策略

## 报告漏洞

**请通过 GitHub 的私密漏洞上报通道提交，不要开公开 issue。**

👉 [Report a vulnerability](https://github.com/zhouqs666/shared-todolist/security/advisories/new)

（仓库已开启 Private vulnerability reporting，见 Settings → Code security。走这条通道的讨论是私密的，
只有仓库维护者能看到；公开 issue 会把「哪里有问题、怎么利用」直接摊在互联网上。）

**请不要在报告里附带真实的第三方个人数据。** 这是一个双人私密待办应用，仓库里的代码是公开的，
但用户数据不是 —— 如果你在测试过程中碰到了任何真实数据，请只描述**访问路径**，不要粘贴内容。

## 适用范围

本仓库 = 一个双人共享待办 App 的全部代码：

| 目录 | 内容 | 是否随产品分发 |
|---|---|---|
| `public/` | 主应用前端（原生 HTML/CSS/JS）+ Supabase 客户端 | ✅ 随 APK 与热更新分发 |
| `android/` | Capacitor 生成的 Android 壳工程 | ✅ 打进 APK |
| `admin/` | web 管理后台（React + Vite） | ❌ 仅本地/CI 使用 |
| `scripts/` / `app-e2e/` | 测试与发布脚本 | ❌ 仅开发/CI 使用 |

后端是 Supabase 托管（PostgreSQL + Auth + Realtime + Storage）。**Supabase 平台本身的漏洞不归本仓库**，
请直接报给 Supabase。

## 已知的、**已接受**的风险（有意不修，别重复上报）

### 1. 依赖告警集中在开发工具链（`scope=development`）

Dependabot 的告警里，**没有任何一条属于随产品分发或生产运行的代码**。
2026-09-15 复核时的存量是 10 条（5 high / 5 moderate），分布如下：

| 包 | 条数 | 位置 | 补丁 | 可达性（这条最关键） |
|---|---|---|---|---|
| `vite` | 3 | `admin/package-lock.json` | 6.4.2 / 6.4.3 | **可达**，但是 major（现为 `^5.4.11`）⇒ 走 major PR 由 CI 验证 |
| `esbuild` | 2 | `package-lock.json` | 0.25.0 | **可达**（现为 `^0.21.5`；0.x 的 minor 视为 breaking，需一并验证 `bundle:supabase`） |
| `glob` | 1 | `app-e2e/package-lock.json` | 10.5.0 | **可达**（现为 `^10.4.5`，落在同一 major 内，能直接打补丁） |
| `serialize-javascript` | 2 | `app-e2e/package-lock.json` | 7.0.3 / 7.0.5 | ❌ **不可达**：`@wdio/mocha-framework` → `mocha@11.8.0` 把范围钉在 `^6.0.2`，7.x 装不进去 |
| `extract-zip` | 2 | `app-e2e/package-lock.json` | **无** | ❌ **无补丁可打**：`@wdio/cli` → `@wdio/utils` → `@puppeteer/browsers` 传递依赖，上游尚无修复版本 |

**关于 `serialize-javascript`：Dependabot 的 job 会周期性报红，这是预期行为，不是配置错误。**
它的判定是 `security_update_not_possible` —— 补丁存在（7.0.5）但**升级路径被父依赖堵死**
（`latest-resolvable-version: 6.0.2` vs `lowest-non-vulnerable-version: 7.0.5`，`fix_available: false`）。
硬装的办法是 npm `overrides` 强制 7.x，但那等于绕过 mocha 声明的兼容范围 —— 对一个**只在本地/CI 跑的
E2E 工具链**来说，收益（威胁模型里几乎没有真实攻击面）远小于风险（把 E2E 环境搞成非受支持组合，
而 E2E 正是用来验证别的东西的）。**结论：接受，等上游放开范围**。
（看到这条红不要"顺手修"，先读这段。）

处置方式：可达的那 6 条交给 `.github/dependabot.yml` 的每周版本更新 PR 逐个评估（major 单独开、由 CI 验证）。
不可达的 4 条在此登记为**已接受**。

### 2. `sharp` 是未被引用的遗留 devDependency（已无告警）

`package.json` 里声明了 `sharp`，但**全仓库没有任何地方 import 它**
（`grep -rn "\bsharp\b"` 只命中 `package.json` 自己与 `release-web.yml` 里一句解释性注释；
`npm ls sharp` 也只有一条直接边、没有传递使用者）。
它是历史遗留 —— 原先带着 2 条告警，2026-09-15 由 Dependabot 升到 0.35.4 后告警已清零。
**留着不影响安全**（dev-only 且从不执行），移除它纯属清理，留待后续：
修掉告警的正规路径是让 Dependabot 升版本，而不是顺手改 `package.json`（那会污染依赖 PR 的可读性）。

## 已知的安全设计（先看这里，避免重复上报）

- **`public/js/supabase.js` 里的 `anon` key 是公开的，这不是泄露。** Supabase 的 anon key 设计上就随客户端分发，
  它是「匿名身份」而非凭据；真正的边界是数据库的 RLS 策略与 `service_role` key。
- **`service_role` key 从不进前端代码**，只存在于本地 `.env*`（已 gitignore）与 GitHub Secrets（仅发布链路使用）。
- **仓库已开启**：secret scanning + push protection（阻止误提交密钥）、Dependabot alerts / security updates、
  CodeQL 静态扫描、Actions 必须固定到完整 commit SHA。配置见 `.github/workflows/codeql.yml`、
  `.github/dependabot.yml`、`scripts/check-actions-pinned.mjs`。

## 如果你在报告「凭据泄露」

本仓库是 **public**。任何进过 git 的凭据都要按「已经泄露」处理。正确的处置顺序是：

1. **先轮换**（改密码 / 撤销 key，让泄露值当场失效）—— 这一步不能等，也不依赖代码修好
2. 再清理文件
3. 复核历史提交里是否还有（`git log --all -S "<泄露值>"`）
4. 确认 secret scanning / push protection 已开

删掉文件**不等于**修好：历史提交里仍然有，且可能已被克隆。

> 本项目在 2026-09-15 真的经历过一次：`.env.test.example` 里写着真实账号邮箱与密码，
> 在公开仓库里躺了一周。**凭据卫生的失效不会报错、不会报警**，只会以「莫名其妙的数据/登录」的形式出现 ——
> 详见 `AGENTS.md` 的「补充：凭据卫生」。
