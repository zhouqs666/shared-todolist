# 面试 FAQ —— 基于「有爱待办」项目的 CI/CD 实践

> 状态：持续更新中。当前覆盖阶段 0~3 的实践，阶段 4~5 完成后补充。

---

## 1. CI/CD 全链路描述

**面试问题**："介绍一下你的 CI/CD 流程。"

**回答框架**：

我们项目有两条并行的质量线：

**Web 层（Playwright）**：
- push/PR → GitHub Actions → `admin/` 构建 → Playwright E2E 测试（6 个用例，POM 模式）
- 测试用独立 Supabase 测试项目（物理隔离，不碰生产库）
- Allure 报告 + 失败截图归档，测试失败阻断合并

**APP 层（Appium）**：
- push/PR → GitHub Actions macOS runner → cap sync → assembleDebug → Appium + 模拟器
- 5 个用例：登录（正确/错误）、待办列表/创建/标记完成（含写库验证）
- 测试 APK 隔离：assets 注入测试库 URL，自动还原，发布前门禁校验

**发布通道**：
- 热更新（前端改动）：`release.mjs` → zip 上传 Supabase Storage → 写版本表 → App 冷启动自动拉取
- APK（原生改动）：`release-apk.mjs` → cap sync → gradle 打包 → SHA-256 校验 → 上传 Storage → 写版本表 → App 内提示更新

---

## 2. 测试策略

**面试问题**："为什么选 UI 自动化而不是纯单元测试？"

**回答**：

我们是两人共享待办 App，核心价值在实时同步和交互体验。测试金字塔底部的单元测试对 Supabase 直连的业务逻辑收益有限（大部分是 API 调用 + UI 渲染），而顶部的 UI 自动化能覆盖真实用户路径。所以策略是**偏顶部**：E2E 为主，覆盖核心流程（登录、CRUD、双端同步），单元测试辅助关键工具函数。

**面试问题**："POM 模式是什么？为什么用？"

**回答**：

Page Object Model，每个页面一个 class，封装元素定位和业务操作。好处是用例只描述业务流程（`loginPage.login(用户名, 密码)`），不关心底层 XPath。元素变更只需改 Page Object，不影响用例。我们 web 和 APP 两套测试都用 POM，复用同一套设计思路。

---

## 3. 测试数据隔离

**面试问题**："测试数据怎么隔离？怎么保证不碰生产数据？"

**回答**：

**物理隔离**：测试用独立的 Supabase 项目（不同的 URL + API key），与生产库完全分离。

**标记清理**：测试数据加 `E2E-` 前缀（web）或 `E2E-APP-` 前缀（APP），`afterEach` 只删带标记的数据。不用 `.neq('id', '全零')` 这种"删全部"模式——这是我们血泪教训的铁律。

**权限隔离**：测试夹具用 `service_role` key 绕过 RLS 造数/清数，这个 key 只在 CI 和本地测试脚本里，绝不进 APK。

**APK 隔离**：`build-test-apk.mjs` 构建测试专用 APK，把 assets 里的 `supabase.js` URL 替换为测试库，打完包自动还原。`release-apk.mjs` 发布前会校验 assets 必须指向生产库，防止误发布。

---

## 4. APP 测试的坑

**面试问题**："APP 自动化遇到过什么问题？怎么解决的？"

### 坑 1：WebView 输入框 setValue 不生效

**现象**：用 `setValue()` 写密码字段，UI 上看着有值，但表单提交时报"用户名或密码错误"。

**根因**：Capacitor App 是 WebView 装载的网页。`setValue()` 走的是 Android 无障碍的 `ACTION_SET_TEXT`，在 Chromium WebView 里不触发 DOM 的 `input` 事件，JS 读到的仍是空串。

**解决**：改用 `addValue()`（键盘逐字输入），触发真实的键盘事件，JS 能读到。

### 坑 2：hideKeyboard 卡死 a11y 树

**现象**：输入完调用 `hideKeyboard()`，后续所有元素查询超时。

**根因**：`hideKeyboard()` 在 WebView 上抛错（无 native 输入焦点），且让无障碍树卡在过渡态。

**解决**：去掉 `hideKeyboard()`，软键盘不影响按钮点击；如果真需要收起，用 BACK 键触发窗口事件刷新树。

### 坑 3：列表重渲染导致 stale element

**现象**：`$$()` 获取所有待办元素后逐个 `getText()`，报 "Index out of bounds"。

**根因**：新待办插入触发列表重渲染，`$$()` 返回的元素句柄瞬间失效。

**解决**：改用单条 XPath 存在性探测 `waitForExist()`，不持有多个句柄。

### 坑 4：元素树间歇性不暴露

**现象**：偶尔登录页 20 秒内找不到 `username` 元素。

**根因**：WebView 无障碍树需要时间构建，首次安装或冷启动后可能有延迟。

**解决**：用 `getPageSource()` 导出真实元素树做校准；等不到时重试。

---

## 5. 移动测试工具选型

**面试问题**："为什么选 Appium 而不是 Maestro/Espresso？"

**回答**：

- **Appium**：行业标准，WebDriver 协议，跨平台（Android/iOS），生态成熟，招聘硬门槛。适合我们这种需要深度控制 WebView 的混合 App。
- **Maestro**：新兴工具，YAML 驱动，上手快，但对 WebView 支持有限，生态还在发展。
- **Espresso**：Google 官方，速度快，但只能测原生 UI，不支持 WebView。

我们是 Capacitor 混合 App，核心 UI 都在 WebView 里，必须选对 WebView 支持好的工具 → Appium。

---

## 6. 构建与发布

**面试问题**："热更新和 APK 更新有什么区别？"

**回答**：

- **热更新**：只改 `public/` 下的 web 资源（HTML/CSS/JS），打成 zip 上传 Storage，App 冷启动时自动下载替换内置资源。用户无感，无需重装。
- **APK 更新**：改了原生层（Capacitor 插件、权限、配置），必须重打包 APK。App 内提示更新 → 下载 → SHA-256 校验 → 唤起系统安装器。需要用户手动安装。

我们的策略是**热更新优先**（覆盖 90% 的前端改动），APK 兜底（原生层改动）。

---

## 7. Secrets 管理

**面试问题**："API key 怎么管理？"

**回答**：

**分级**：
- `anon key`：设计公开的，靠 RLS 保护数据，可以进前端代码。
- `service_role key`：绕过 RLS，仅 CI/脚本用，存 GitHub Secrets，绝不进代码。
- APK keystore：签名密钥，base64 存 GitHub Secrets，本地 `keystore.properties`（已 gitignore）。
- SSH 密钥：部署专用，与本地开发密钥分离。

**原则**：最小权限、定期轮换、严禁进代码或日志。

---

## 8. 回滚策略

**面试问题**："出了问题怎么回滚？"

**回答**：

- **热更新**：`app_versions` 表的 `enabled=false`，App 下次冷启动不再拉取该版本，回退到内置版本。
- **APK**：`app_native_versions` 表的 `enabled=false`，App 不再提示更新。
- **Web 后台**：部署脚本保留上一版本目录，CD 失败秒级切回。
- **预防**：发布前必查线上最新版本号，新版本必须语义化更大，防止版本号倒挂。

---

## 9. 关键技术决策

| 决策 | 选型 | 理由 |
|------|------|------|
| 前端框架 | 原生 HTML/CSS/JS | 无构建步骤，Capacitor 直接打包，学习成本低 |
| 后端 | Supabase（BaaS） | 零运维，内置 Auth/Realtime/Storage，双人小项目够用 |
| 测试框架（Web） | Playwright | 跨浏览器，auto-wait，trace，POM 友好 |
| 测试框架（APP） | Appium + WebdriverIO | 行业标准，WebView 支持好，与 Playwright 设计思路一致 |
| 数据隔离 | 独立测试项目 | 物理隔离比逻辑隔离（同库不同 schema）更安全 |
| CI | GitHub Actions | 与代码仓库一体，免费额度够用，生态丰富 |

---

## 10. 待补充（阶段 4~5 完成后）

- [ ] CD 全链路：提交 → 构建 → 部署 → 上线
- [ ] 回滚演练实战
- [ ] Nginx 反向代理 + HTTPS（Let's Encrypt）
- [ ] 设备农场概念（BrowserStack / Sauce Labs）
- [ ] Jenkins vs GitHub Actions 选型对比
- [ ] 录制演示视频
