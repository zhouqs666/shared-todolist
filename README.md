# 📋 我们的清单

一个为**两个人**设计的轻量级共享待办清单网页应用：两人看到同一份清单，互相添加、完成、删除任务，所有变更**实时同步**到对方屏幕。

## ✨ 功能

- 👥 双账号共享一份清单
- ➕ 添加 / ✅ 完成 / 🗑 删除
- ⚡ 实时同步（WebSocket，< 1 秒到达对方）
- 📱 移动端友好（自适应手机/桌面）
- 🔒 密码 bcrypt 哈希、登录态 cookie 鉴权
- 🆓 免费部署（Render + Supabase 免费层）

## 🚀 本地开发

```bash
# 1. 安装依赖
npm install

# 2. 复制环境变量模板
cp .env.example .env

# 3. 启动
npm start
# 或开发模式（文件变更自动重启）
npm run dev
```

打开 http://localhost:3000 即可。

**默认账号**（本地开发，明文都是 `password`）：
- `alice` / `password`
- `bob` / `password`

## ☁️ 部署上线（Render + Supabase）

整体流程：**GitHub 推代码 → Supabase 建表 → Render 部署 → 设置环境变量 → 访问**

### 第 1 步：把代码推到 GitHub

```bash
# 在项目根目录
git init
git add .
git commit -m "init: 双人共享待办清单"
git branch -M main
git remote add origin <你的 GitHub 仓库地址>
git push -u origin main
```

> 仓库可以设为 Public 或 Private（Render 两者都支持）。

### 第 2 步：创建 Supabase 项目并建表

1. 访问 https://supabase.com 注册（GitHub 登录最快）
2. **New Project** → 取个名字（如 `shared-todo`）→ 设置数据库密码 → 选免费区域（Singapore 离国内最近）
3. 等待 1~2 分钟项目创建完成
4. 进入项目 → **SQL Editor** → **New query**
5. 把 [`supabase/schema.sql`](./supabase/schema.sql) 整个文件内容粘进去 → **Run**
6. 进入 **Project Settings** → **API**，记下两个值（后面 Render 要用）：
   - **Project URL**（形如 `https://xxxxx.supabase.co`）
   - **service_role secret key**（⚠️ 注意是 service_role，不是 anon！这是绕过 RLS 的服务端密钥）

### 第 3 步：生成你自己的密码 hash

本地执行（用你想给 Alice/Bob 设置的真实密码）：

```bash
# 安装依赖后
node scripts/gen-password-hash.js "你的真实密码"
# 会输出形如 $2a$10$xxxxx... 的 hash，复制下来

# 再给第二个用户生成一次
node scripts/gen-password-hash.js "第二个用户的密码"
```

> ⚠️ 生产环境**务必**改掉默认的 `password`，否则任何人都能登录你的清单。

### 第 4 步：在 Render 创建 Web Service

1. 访问 https://render.com 注册（GitHub 登录）
2. **New +** → **Blueprint**
3. 选择刚才推送代码的 GitHub 仓库
4. Render 会自动识别 `render.yaml`，确认服务名 `shared-todolist`
5. **Apply** 创建服务
6. 进入服务 → **Environment** 标签页，**手动添加**以下环境变量（`render.yaml` 里被注释掉的那些）：

   | Key | Value | 说明 |
   |-----|-------|------|
   | `SESSION_SECRET` | （用 `openssl rand -hex 32` 生成） | Session 加密 |
   | `USER_A_USERNAME` | 如 `alice` | 用户 A 登录名 |
   | `USER_A_DISPLAY_NAME` | 如 `Alice` | 用户 A 显示名 |
   | `USER_A_PASSWORD_HASH` | 第 3 步生成的 hash | 用户 A 密码 hash |
   | `USER_B_USERNAME` | 如 `bob` | 用户 B 登录名 |
   | `USER_B_DISPLAY_NAME` | 如 `Bob` | 用户 B 显示名 |
   | `USER_B_PASSWORD_HASH` | 第 3 步生成的 hash | 用户 B 密码 hash |
   | `SUPABASE_URL` | 第 2 步记下的 Project URL | Supabase 地址 |
   | `SUPABASE_KEY` | 第 2 步记下的 service_role key | Supabase 服务密钥 |

7. **Save Changes** → Render 自动重新部署
8. 部署完成后，服务顶部会显示访问地址，形如：
   `https://shared-todolist-xxxx.onrender.com`

### 第 5 步：手机访问

- 用任意手机浏览器打开 Render 给的地址
- 输入你设置的用户名 + 密码
- 把网址加到桌面（iOS Safari → 分享 → 添加到主屏幕），体验接近原生 App

## ⚠️ 已知限制（免费层）

| 限制 | 影响 | 应对 |
|------|------|------|
| Render 15 分钟无访问会休眠 | 首次唤醒等 30~50s | 接受；或升级 7 美元/月消除休眠 |
| Supabase 免费层 500MB / 50k 行 | 双人场景完全够用 | — |
| 不支持 HTTPS 自定义域名 | 用 onrender.com 域名 | 想用自有域名需付费 |

## 🏗️ 技术栈

| 层 | 技术 |
|----|------|
| 前端 | 原生 HTML5 + CSS3 + ES Module（无构建） |
| 后端 | Node.js + Express |
| 实时通信 | Socket.IO |
| 数据存储 | 开发：JSON 文件 / 生产：Supabase PostgreSQL |
| 鉴权 | Cookie + express-session + bcrypt |
| 部署 | Render（Web）+ Supabase（DB） |

## 📂 项目结构

```
toDoList/
├── src/                    # 后端
│   ├── index.js            # 入口
│   ├── routes/             # REST 路由（auth, todos）
│   ├── sockets/            # Socket.IO 服务
│   ├── store/              # 数据访问层（json/supabase 双实现）
│   ├── auth/               # 鉴权中间件与用户服务
│   ├── config/             # 环境变量集中读取
│   └── utils/              # 校验工具
├── public/                 # 前端静态资源
│   ├── index.html          # 主页
│   ├── login.html          # 登录页
│   ├── css/                # 样式
│   ├── js/                 # 主逻辑、socket、state、api
│   └── favicon.svg         # 应用图标
├── supabase/schema.sql     # 数据库建表脚本
├── scripts/                # 工具脚本
│   └── gen-password-hash.js
├── render.yaml             # Render 部署配置
├── PRD.md                  # 产品需求文档
└── package.json
```

## 📖 文档

- [PRD.md](./PRD.md) — 产品需求文档（功能、架构、决策）
- [README.md](./README.md) — 本文件（部署指引）
- [`.env.example`](./.env.example) — 环境变量模板

## 📝 License

MIT
