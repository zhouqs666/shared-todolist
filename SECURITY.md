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
