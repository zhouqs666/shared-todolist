# 有爱待办 💕

双人共享待办清单 PWA，直连 Supabase，支持实时同步。

## CI/CD

[![CI](https://github.com/zhouqs666/shared-todolist/actions/workflows/ci.yml/badge.svg)](https://github.com/zhouqs666/shared-todolist/actions/workflows/ci.yml)
[![Web E2E Full](https://github.com/zhouqs666/shared-todolist/actions/workflows/e2e-web-full.yml/badge.svg)](https://github.com/zhouqs666/shared-todolist/actions/workflows/e2e-web-full.yml)
[![CodeQL](https://github.com/zhouqs666/shared-todolist/actions/workflows/codeql.yml/badge.svg)](https://github.com/zhouqs666/shared-todolist/actions/workflows/codeql.yml)

> 分层触发（有意为之，别改坏）：PR 门禁只跑 `ci.yml`（**快而稳**，required check）；
> 4 个双账号 Web E2E 走 `e2e-web-full.yml`（**慢而全**，每晚 02:00 北京定时 + 可手动触发）。
> 定时那份**刻意不设 required check** —— 它不在 PR 上运行，设了会让 check 永远停在 "Expected" 卡死 PR。

### 两条交付通道（形态完全不同，别混）

| | 通道 A：热更新（默认） | 通道 B：APK（兜底） |
|---|---|---|
| 改什么 | 只改 `public/` | 动原生层（Capacitor 插件 / Android 配置 / 权限） |
| 执行体 | `release.mjs` → `release-web.yml` | `release-apk.mjs` → `release-apk.yml` |
| 产物 | zip → Supabase Storage | APK → Storage + `app_native_versions` 表 |
| 到用户手上 | 冷启动后台下载，**再启动一次**生效 | 弹更新面板 → 下载 → **用户手动点安装** |
| 发布后回读校验 | `verify-release.mjs` | `verify-apk-release.mjs`（多一条 **SHA-256 一致** —— 对不上用户装不上） |

两条通道的工作流工序同构：`workflow_dispatch` 手动触发 → **预演出报告**（不写生产）→ `confirm`
逐字确认 → `production` 环境审批 → 写生产 → **回读校验**。

## 技术栈

- **前端**：原生 HTML/CSS/JS（无框架），ES Module
- **后端**：Supabase（PostgreSQL + Auth + Realtime）
- **打包**：Capacitor → Android APK
- **测试**：Playwright（Web E2E）+ Appium/WebdriverIO（APP E2E）
- **CI/CD**：GitHub Actions

## 本地运行

```bash
npm install
node scripts/serve.mjs  # http://localhost:3000
```

## 测试

> ⚠️ 本项目有两套独立的测试库通道：**admin 后台** 与 **主应用 Web 通道** 都用独立 Supabase 测试项目，
> 但入口不同。跑任何 E2E 前请先确认连的是**测试库**（`app-e2e/.env.test`），
> 绝不要对着生产库跑（见 `AGENTS.md` 铁律一）。

```bash
# 1) admin 后台 E2E（Playwright + Allure）
cd admin && npm ci && npm test

# 2) 主应用 Web E2E（4 个双账号用例：回收站/删除撤销/完成撤销/离线补发/盲盒图鉴）
node scripts/serve-test.mjs &     # 测试服务器 :3100（连测试库、运行时改写 supabase.js）
node scripts/run-web-e2e.mjs      # 逐个归零 + 失败重试一次并显式标记 flaky + 汇总表
# 亦可单跑：python3 scripts/test_trash.py（脚本会自证连的是测试库，指向 :3000 会被拦下）
# 依赖：python3 -m pip install -r scripts/requirements-e2e.txt && python3 -m playwright install chromium

# 3) APP E2E（Appium + WebdriverIO，需模拟器/真机）
cd app-e2e && npm ci && npm test
```
