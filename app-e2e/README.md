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

### CI 集成

GitHub Actions（`.github/workflows/e2e-app.yml`）：
- push/PR 自动触发
- Mac runner：cap sync → assembleDebug → Appium → 模拟器内跑测试
- Allure 报告归档 14 天，失败截图上传 artifact
# 验证公开仓库 CI
