# 📋 我们的清单

一个为**两个人**设计的轻量级共享待办清单 **PWA**：两人看到同一份清单，互相添加、完成、删除任务，所有变更**实时同步**到对方屏幕。

## ✨ 功能

- 👥 双账号共享一份清单
- ➕ 添加 / ✅ 完成 / 🗑 删除
- ⚡ 实时同步（Supabase Realtime，< 1 秒到达对方）
- 📱 移动端友好 + **可安装到手机主屏幕**（PWA）
- 🎨 5 套主题切换 + 完成动画（彩带 / 音效 / 震动 / 计数器）
- 🔒 Supabase Auth + RLS 行级安全
- 🆓 永久免费部署（Supabase 免费层 + Cloudflare Tunnel）

## 🏗️ 架构（V2 / PWA + Supabase 直连）

```
┌──────────────┐         ┌─────────────────────────┐
│  浏览器/PWA   │ ◄────► │   Supabase 云（免费层）  │
│  纯静态前端   │  HTTPS │  ┌──────────────────┐    │
│  (public/)   │  + WSS │  │ Auth（密码登录）  │    │
│              │         │  │ PostgreSQL       │    │
│  supabase-js │         │  │ Realtime（推送）  │    │
│  (本地打包)  │         │  └──────────────────┘    │
└──────────────┘         └─────────────────────────┘
       ▲
       │ 静态托管
       │
┌──────┴───────┐
│ Cloudflare   │
│ Tunnel /任意 │
│ 静态托管服务 │
└──────────────┘
```

**关键设计**：
- **无后端服务器**——前端直接通过 Supabase JS SDK 访问数据库
- **anon key 写在 `public/js/supabase.js`**——这是**设计上公开**的（public key），真正的安全靠 RLS：
  - 未登录（anon 角色）：完全无法读写
  - 已登录（authenticated 角色）：可读写所有 todos（双人共享模式）
- **只有 2 个固定账号**（无公开注册入口），所以"所有 authenticated 用户都能读写全部"是安全的

## 🚀 本地开发

```bash
# 1. 安装依赖（仅 supabase-js + esbuild + sharp）
npm install

# 2. 配置环境变量（仅供 scripts/init-users.mjs 用）
cp .env.example .env
# 编辑 .env 填入 SUPABASE_URL / SUPABASE_KEY / SUPABASE_ANON_KEY

# 3. 启动静态服务器
npm start
# 或开发模式（文件变更自动重启）
npm run dev
```

打开 http://localhost:3000

## ☁️ 部署上线

### 前置条件

1. **Supabase 项目**（已建好 schema）
2. **两个 Auth 用户**已通过 `scripts/init-users.mjs` 创建
3. 一个**静态托管方案**：
   - **方案 A（推荐）**：Cloudflare Tunnel 指向本地静态服务器（地址临时但免费）
   - **方案 B（永久）**：Cloudflare Pages / Netlify / Vercel 托管 `public/` 目录（永久固定域名）
   - **方案 C（最简）**：`npm start` + 任意内网穿透（ngrok / frp）

### Cloudflare Tunnel 示例

```bash
# 终端 1：启动静态服务器
npm start

# 终端 2：启动 tunnel（会输出 https://xxx.trycloudflare.com）
cloudflared tunnel --url http://localhost:3000
```

### Cloudflare Pages 永久部署

1. 把代码推到 GitHub
2. Cloudflare Pages → Create project → Connect to Git
3. Build command：留空（无构建步骤）
4. Build output directory：`public`
5. 部署完成得到永久地址 `https://your-project.pages.dev`

## 🔧 维护命令

```bash
# 重新打包 supabase-js（升级版本后用）
npm run bundle:supabase

# 初始化 Auth 用户（幂等可重复运行）
npm run init-users
```

## 🏗️ 技术栈

| 层 | 技术 |
|----|------|
| 前端 | 原生 HTML5 + CSS3 + ES Module（无构建） |
| 数据/鉴权/实时 | Supabase（PostgreSQL + Auth + Realtime） |
| 客户端 SDK | supabase-js（esbuild 打包到 `public/js/vendor/`） |
| PWA | manifest.webmanifest + Service Worker |
| 静态服务器 | Node 内置 http（零依赖，`scripts/serve.mjs`） |
| 部署 | Cloudflare Tunnel / Pages |

## 📂 项目结构

```
toDoList/
├── public/                       # 前端静态资源（部署根目录）
│   ├── index.html                # 主页
│   ├── login.html                # 登录页
│   ├── manifest.webmanifest      # PWA 清单
│   ├── sw.js                     # Service Worker
│   ├── favicon.svg               # 应用图标（SVG 源）
│   ├── icons/                    # PWA 图标（PNG）
│   ├── css/                      # 样式（style + login）
│   └── js/
│       ├── app.js                # 主页入口
│       ├── login.js              # 登录页逻辑
│       ├── auth.js               # 认证层（Supabase Auth）
│       ├── db.js                 # 数据访问层
│       ├── realtime.js           # Realtime 订阅
│       ├── state.js              # 状态管理
│       ├── theme.js              # 主题切换 + FX 开关
│       ├── utils.js              # 工具函数
│       ├── supabase.js           # Supabase 客户端单例（含 anon key）
│       └── vendor/
│           ├── supabase-js.esm.js         # SDK（本地打包）
│           └── canvas-confetti.esm.min.js # 动画库
├── scripts/
│   ├── serve.mjs                 # 极简静态服务器
│   └── init-users.mjs            # Auth 用户初始化脚本
├── supabase/schema.sql           # 数据库 schema（参考用）
├── PRD.md                        # 产品需求文档
├── .env.example                  # 环境变量模板
└── package.json
```

## 🔒 安全模型

| 资源 | 未登录（anon） | 已登录（authenticated） |
|------|----------------|------------------------|
| `profiles` 表 | 可读（仅显示名） | 可读，只能改自己 |
| `todos` 表 | 完全拒绝（RLS） | 可读写所有 todos |

**为什么所有 authenticated 都能读写所有 todos？**
因为这是"双人共享清单"——两个账号都要能看到/操作同一份数据。安全性靠"只有 2 个固定账号能注册"保证（无公开注册入口，账号通过 `scripts/init-users.mjs` 用 service_role 创建）。

## 📖 文档

- [PRD.md](./PRD.md) — 产品需求文档
- [supabase/schema.sql](./supabase/schema.sql) — 数据库 schema
- [`.env.example`](./.env.example) — 环境变量模板

## 📝 License

MIT
