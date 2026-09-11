# 有爱待办 💕

双人共享待办清单 PWA，直连 Supabase，支持实时同步。

## CI/CD

[![CI](https://github.com/zhouqs666/shared-todolist/actions/workflows/ci.yml/badge.svg)](https://github.com/zhouqs666/shared-todolist/actions/workflows/ci.yml)
[![APP E2E](https://github.com/zhouqs666/shared-todolist/actions/workflows/e2e-app.yml/badge.svg)](https://github.com/zhouqs666/shared-todolist/actions/workflows/e2e-app.yml)

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

```bash
# Web E2E（Playwright）
cd admin && npm ci && npm test

# APP E2E（Appium）
cd app-e2e && npm ci && npm test
```
