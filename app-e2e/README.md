# APP 自动化测试（Appium + WebdriverIO）

## 技术栈

- **框架**：WebdriverIO v9 + Mocha
- **驱动**：Appium 3.x + UiAutomator2（Android）
- **报告**：Allure Report
- **定位策略**：XPath + resource-id（WebView HTML id → Android 无障碍树）

## ⚠️ 铁律一：测试必须与生产库物理隔离

本工程**绝不允许**使用正式 APK（内置生产 Supabase）跑测试。

- 本地：`node scripts/build-test-apk.mjs` 构建测试 APK（assets 指向独立测试库）
- CI：`assembleDebug`（assets 来自 cap sync + 测试环境变量注入）
- `release-apk.mjs` 发布前会校验 assets 指向生产库，拦截误发布

## 目录结构

```
app-e2e/
├── wdio.conf.js              # WebdriverIO 配置（APK 路径、capabilities）
├── pages/
│   ├── LoginPage.js          # 登录页 Page Object
│   └── DashboardPage.js      # 主界面 Page Object（添加/列表/复选框）
├── tests/
│   ├── login.spec.js         # 登录用例（2 个）
│   └── todo.spec.js          # 待办管理用例（3 个）
├── utils/
│   └── test-data.js          # 测试数据夹具（Supabase service_role 造数/清数）
├── .env.test.example         # 环境变量模板
├── .env.test                 # 实际配置（gitignore，不提交）
└── package.json
```

## 环境准备

```bash
cd app-e2e && npm install
cp .env.test.example .env.test  # 填入测试项目 Supabase URL + keys
node scripts/build-test-apk.mjs  # 构建指向测试库的 APK
```

## 运行测试

```bash
cd app-e2e && npm test               # 跑全部用例
bash scripts/app-e2e-report.sh        # 生成 + 打开 Allure 报告
```

## 测试用例

### 登录（login.spec.js）

| 用例 | 描述 |
|------|------|
| 正确登录 | 小宝宝 + 正确密码 → 进入主界面，待办列表可见 |
| 错误密码 | 错误密码 → 提示"错误"，停留在登录页 |

### 待办管理（todo.spec.js）

| 用例 | 描述 |
|------|------|
| 列表显示已有待办 | service_role 造数 → 登录后 UI 可见 |
| 创建新待办 | FAB → 输入 → 列表出现 + 测试库落库验证 |
| 标记完成/未完成 | 点击复选框 → 轮询测试库确认 completed 状态翻转 |

## 关键设计决策

### POM 模式

与阶段 2 web E2E 一致：
- `LoginPage` / `DashboardPage` 封装元素定位和业务操作
- 用例只描述业务流程，不关心底层 XPath

### 元素定位策略

Android WebView 的 HTML 元素通过无障碍树暴露为：
- `id="username"` → `resource-id="username"`（优先用）
- `role=checkbox` + `aria-label` → 映射为 `android.widget.CheckBox`，label 落在 `@text` 而非 `@content-desc`
- 容器 `id="todoList"` → `resource-id="todoList"`

### 输入方式

WebView 上 `setValue()`（accessibility SET_TEXT）不回写 DOM——JS 读到的仍是空串。必须用 `addValue()`（键盘逐字输入）。

### 测试数据隔离

- 复用独立 Supabase 测试项目（物理隔离生产库）
- 所有测试数据加 `E2E-APP-` 前缀标记，清理时只删带标记的
- `beforeEach` 造数 + `afterEach` 清数，保证用例独立性
- `noReset:false`（fastReset）：每会话清应用数据，保证从未登录状态起步

### 运行方式（2026-09-17 起：**不进 CI**）

本套件**不再由 GitHub Actions 自动运行** —— 原先的 `.github/workflows/e2e-app.yml`
已于 2026-09-17 删除。理由与替代方案见 `AGENTS.md` 的「CI 分层」一节，摘要：

- 一次约 11 分钟（打 APK ~2 + 模拟器 ~9），却只覆盖「登录 + 待办增删改查」，
  而这些已被 **web 双账号 E2E**（`ci.yml` 必需门禁）等价覆盖；
- 它**常态掉线**（`adb` 失去响应 = 模拟器进程级死亡，仓库侧修不了），
  把 main 变长期红灯、训练人忽略红色；
- 本仓双人私用、单一 APK、**没有机型矩阵需求** —— 云设备的核心价值不存在。

**那设备侧谁验**：发布时人工在真机走一遍冒烟（`AGENTS.md`「发布前自检」第 6 步），
它同时覆盖本套件**从未覆盖**的通知 / 震动 / 热更新 / APK 安装器。

**需要时怎么跑**（本地接模拟器或真机）：

```bash
node scripts/build-test-apk.mjs   # 产出指向测试库的 APK（脚本自带还原）
cd app-e2e && npm test            # WebdriverIO + Appium
bash scripts/app-e2e-report.sh    # Allure 报告
```

⚠️ 若将来要恢复 CI 自动触发：把 `push/pull_request + paths` 加回一个新工作流即可，
`paths` 建议只留 `android/**` 与 `app-e2e/**`，**不要含 `public/**`**（那正是它当初被
拖进每次前端改动的原因）；同时记得把路径加回 `scripts/check-e2e-env-keys.mjs` 的生成方列表。
`app-e2e/scripts/ci-run*.sh` 两个脚本就是为 CI 写的，现在不再被调用（头部已标注），可直接复用。
