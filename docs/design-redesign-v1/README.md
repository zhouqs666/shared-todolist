# 「有爱」App · 视觉重构 · 设计改版方案 v1

> **Phase 3 交付物** · 概念稿 · 2026·01 · 由 prototype-builder 筑原型（Zhu）产出

「有爱」是一款基于 Capacitor 的情侣共享待办清单 App。**这是已有产品的视觉重构方案**，保留所有现有功能，重新设计视觉语言、交互节奏与情感仪式。

**设计定位**：克制浪漫 · 暖奢呼吸感 · 双主角对称
**主方案**：Warm Editorial 基底 + Notion 排版节奏 + Apple HIG 移动模式
**完整设计令牌文档**：`/Users/admin/.workbuddy/有爱-app-design-tokens.md`

---

## 📦 交付清单（9 个文件）

| # | 文件 | 用途 | 视口 |
|---|------|------|------|
| 1 | `prototype-01-login.html` | 登录页（开屏爱心动画 + 配对码 / Touch ID） | 390×844 |
| 2 | `prototype-02-main.html` | 主界面（混合状态待办列表 + FAB 长按花瓣菜单） | 390×844 |
| 3 | `prototype-03-anniversary.html` | 纪念日面板（在一起 N 天 + 倒计时行） | 390×844 |
| 4 | `prototype-04-notes.html` | 心里话 · 写信 + 阅读（双屏并排） | 390×844 × 2 |
| 5 | `prototype-05-stickers.html` | 贴纸图鉴（12 格分 3 档稀有度） | 390×844 |
| 6 | `prototype-06-overlays.html` | 4 个浮层合集（长按 / 添加 / 看图 / 更新） | 390×844 × 4 |
| 7 | `prototype-07-states.html` | 3 个状态合集（空 / 加载 / 出错） | 390×844 × 3 |
| 8 | `prototype-overview.html` | **入口页 · 所有原型合集预览**（推荐先打开这个） | 桌面浏览器 |
| 9 | `design-proposal.html` | **设计改版说明文档**（前后对比 / 策略 / IA / 动效 / 实施路径 / 决策记录） | 桌面浏览器 |

**建议打开顺序**：`prototype-overview.html` → 浏览各张 → `design-proposal.html` 阅读完整改版方案。

---

## 🎨 设计令牌速览

> 所有 HTML 文件内嵌 `:root` 完整变量，无需外部依赖。

```
主色  rose-500  #c2410c  焦糖玫瑰（5% 点缀）
底色  cream-100 #faf6f1  米杏白（主底）
强调  rose-700  #872a08  active / 按压
文字  stone-700 #2f2820  正文（11.8:1 AAA）
烫金  legendary #c1932e  隐藏款 / 印章
藏蓝  ink-500   #2f456a  大宝贝徽章
稀有·粉 rare-500 #ec6680
稀有·紫 epic-500 #8b6db8
```

字体三轨：
- **LXGW WenKai 霞鹜文楷** — 中文诗意正文 / 心里话
- **Inter** — 英文 / 按钮 / 标签
- **Berkeley Mono** — 计时器 / 倒计时 / 日期戳

---

## 🚫 严守的「不」清单

- ❌ 任何 emoji ❤💕🌹 当图标（全部 SVG 双心交错）
- ❌ 任何「全圆 pill」按钮（圆角上限 12px）
- ❌ 任何冷蓝色调（最多 ink-500 藏蓝）
- ❌ 任何冷灰阴影（必须 `rgba(194,65,12, ...)` 暖玫瑰染色）
- ❌ 任何 < 11px 字号
- ❌ 任何 < 44pt 点击区
- ❌ 任何「弹窗广告 / 强制引导」

---

## ✅ 推荐做法

- ✓ 所有颜色 / 圆角 / 阴影从 design token 取，禁止 primitive 直引
- ✓ 动效慢半拍：280ms 基准 / 480ms 慢 / 720–1200ms 仪式
- ✓ 双主角对称落在身份徽章 + 卡片角色条（不靠布局）
- ✓ FAB 长按 400ms 展开花瓣菜单（点击 = 快速添加）
- ✓ `prefers-reduced-motion: reduce` 全局降级
- ✓ 所有 HTML 单文件可独立运行，无外部 CDN 依赖

---

## 📐 7 个原型场景一览

| # | 场景 | 核心改动点 |
|---|------|----------|
| 01 | 登录页 | 双心呼吸动画 + 配对码 / 手机号双入口 + Touch ID |
| 02 | 主界面 | 单列纵深 + Hero 数字 + 待办角色条 + FAB 长按花瓣 |
| 03 | 纪念日面板 | 在一起 N 天烫金 + 3 倒计时行 + 心里话入口 |
| 04 | 心里话 | 米杏信纸横线 + 双心 logo + 「小 宝 贝」印章 |
| 05 | 贴纸图鉴 | 三色稀有度（粉 / 紫 / 金）+ 进度条 shimmer |
| 06 | 浮层合集 | 长按菜单 6 行 / 添加面板 5 段 / 看图 3 动作 / APK 进度 |
| 07 | 状态合集 | 空状态邀请 / 加载骨架 shimmer / 错误诊断重试 |

---

## 🎬 5 套仪式动效

| 名称 | 时长 | 用途 |
|------|------|------|
| **heart-beat** | 2.4s 循环 | FAB idle 心跳 |
| **breath** | 4.8s 循环 | 主桃心慢呼吸（双心错开 240ms） |
| **petal** | 1.6s spring | FAB 长按展开花瓣菜单 |
| **stamp** | 720ms ease-out | 隐藏款烫金揭晓 |
| **smoke** | 1.2s ease-in | 心里话长按删除烟化 |

---

## 📁 目录结构

```
design-redesign-v1/
├── README.md                  ← 本文件
├── prototype-overview.html    ← 入口预览页（推荐先看）
├── design-proposal.html       ← 设计改版说明文档
├── prototype-01-login.html    ← 原型 #01 登录页
├── prototype-02-main.html     ← 原型 #02 主界面
├── prototype-03-anniversary.html  ← 原型 #03 纪念日
├── prototype-04-notes.html    ← 原型 #04 心里话
├── prototype-05-stickers.html ← 原型 #05 贴纸图鉴
├── prototype-06-overlays.html ← 原型 #06 浮层合集
└── prototype-07-states.html   ← 原型 #07 状态合集
```

---

## 🛠️ 后续步骤

**Phase 3.5**（可选）：把原型转 Figma / 接入 Capacitor
**Phase 4**：分 3 阶段渐进上线（先 token 切换 → 关键页面重构 → 仪式动效补齐），详见 `design-proposal.html` §8。

---

**签字**：prototype-builder · 筑原型（Zhu）· v1.0 · 2026·01
**上游文档**：`/Users/admin/.workbuddy/有爱-app-design-tokens.md` · v1.0 · 设计系统专家「彩格调（Cai）」出品