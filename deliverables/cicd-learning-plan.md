# CI/CD 全链路实战方案

> 载体项目：有爱待办（`~/Desktop/toDoList`）
> 学习目标：走通 CI/CD 全链路（开发 + 测试双视角），为测试主管面试做支撑
> 文档版本：v2（行业最佳实践对齐 + MacBook Pro 执行环境接入）
> 文档状态：方案定稿（待逐阶段执行）

---

## 一、目标与前提

### 1.1 学习目标

- 通过「有爱待办」项目实战，理解并亲手走通 CI/CD 全链路。
- 视角不限于测试：既作为开发者（构建、部署、后台开发），也作为测试主管（测试体系、持续测试、质量门禁）。
- 最终目的：掌握 CI/CD 基础知识 + 完整实战经验，能胜任下一份 **web + app** 自动化测试工作。

### 1.2 核心认知（全文立论）

1. **CI/CD 是一条贯穿的流水线，不是某个环节**：覆盖「提交 → 自动验证 → 部署测试环境 → 测试 → 部署预发布 → 部署生产」全过程。
2. **学的是概念，不是工具**：Jenkins 与 GitHub Actions 在概念上同构（trigger → pipeline → job → step），工具可换，理念不变。
3. **测试环境部署也是 CD 的一部分**：测试工程师通常不手动部署，环境由流水线自动更新。
4. **Pipeline as Code**：流水线定义以代码形式（YAML / Groovy）纳入版本管理，可审计、可回滚、可复用——这是现代 CI/CD 与传统脚本的本质区别。
5. **测试左移（Shift Left）**：QA 越早介入越好，CI 是测试左移的核心载体；测试代码与产品代码同库、同 PR、同部署。

### 1.3 关键前提假设

| # | 前提 | 说明 |
|---|---|---|
| 1 | 主线 CI/CD 工具为 GitHub Actions | 代码在 GitHub，托管型、零运维 |
| 2 | web 后台 = React + Supabase | 最小闭环，为 web 自动化测试服务 |
| 3 | 执行环境为 MacBook Pro + 云服务器 + GitHub Actions | Mac 本地调试与构建 + 云服务器部署 web 后台 + GitHub Actions 编排 CI/CD |
| 4 | 云服务器仅作「web 部署目标 + staging」 | 腾讯云 Lighthouse，北京，2核2G，Ubuntu 24.04 |
| 5 | 云服务器 2026-10-07 到期后不续费 | **App 不受影响**：App 依赖 Supabase，不依赖云服务器 |
| 6 | Jenkins 不替换 GitHub Actions | 作为独立补课沙盒，补齐 JD「熟悉 Jenkins」的操作层 |
| 7 | 严格遵守 AGENTS.md 铁律一 | 所有测试使用隔离数据，绝不触碰生产数据 |

---

## 二、技术选型汇总（已定）

### 2.1 工具链

| 项 | 选型 | 选择理由（面试导向） |
|---|---|---|
| CI/CD 工具 | GitHub Actions | 代码在 GitHub，托管型零运维，零服务器 |
| web 后台 | React + Supabase | 贴近真实公司，能讲「被测对象技术栈」 |
| web 自动化 | Playwright | 主流，项目已有 3 个 E2E 基础 |
| APP 自动化 | Appium | 移动测试事实标准，招聘硬门槛 |
| APP 自动化（了解） | Maestro | 新工具，仅作概念了解 |
| 测试报告 | Allure | 行业事实标准，CI/CD 集成最成熟，面试高频 |
| web 部署 | 云服务器（Nginx + SSH） | 自建部署面试含金量高；到期后可降级 Vercel |
| Jenkins | Docker 沙盒补课 | 补 JD「熟悉 Jenkins」操作层 |

### 2.2 执行环境分布（行业最佳实践：本地调试 + CI 兜底）

| 任务 | 执行环境 | 理由 |
|---|---|---|
| 编写 / 调试 Appium 用例 | **MacBook Pro 本地** | Android Studio + 模拟器即时反馈，迭代最快 |
| 编写 / 调试 Playwright 用例 | MacBook Pro 本地 | 本地浏览器跑得快，调试直观 |
| 本地打 APK（调试） | MacBook Pro 本地 | 本地 SDK + gradle 比 CI 快，调试方便 |
| CI 跑测试（门禁） | GitHub Actions ubuntu | 无值守 + 标准化环境 |
| CI 自动打 APK（CD） | GitHub Actions ubuntu | 完整 CD 链路面试可讲 |
| web 后台部署 | 云服务器（Nginx） | 自建部署含金量高 |
| staging 环境 | 云服务器同机不同端口 / 子路径 | 节约资源 |
| 生产环境（web 后台） | 云服务器 | 暂不上线生产，仅作部署能力演示 |

---

## 三、测试设计原则与最佳实践（贯穿所有阶段）

> 行业最佳实践：测试代码与产品代码同等对待。这节是后续所有阶段的「设计准则」，不是某一阶段的「任务」。

### 3.1 测试金字塔（Mike Cohn 经典 + 现代补充）

```
       /\
      /UI\         ← E2E（少量、关键业务流）
     /----\
    /集成  \       ← API / Service 集成测试（中等）
   /--------\
  /  单元    \     ← 单元测试（大量、快速）
 /--------------\
```

- 本项目重点：UI 层自动化（E2E）+ 必要的集成测试（API 直连 Supabase 验证 schema）。
- 不强求单元测试覆盖率——本项目目标是 CI/CD + 自动化测试，不是补测试覆盖率。
- **面试表达**：能讲清「为什么这个项目做 UI 自动化为主」（核心业务流价值高 + 单元测试收益边际递减）。

### 3.2 Page Object Model（POM）

- **定义**：将每个页面 / 屏幕封装为一个类，元素定位与操作方法集中管理，测试用例只描述业务流程。
- **价值**：
  - 元素改动只改一处（DRY）
  - 用例可读性高（业务流程，而非一堆 selector）
  - 便于维护（自动化测试最痛的不是写，是改）
- **Web 端**：Playwright + Page Object（每个页面一个 class）。
- **APP 端**：Appium + Page Object（每个屏幕一个 class）。

### 3.3 测试独立性

- 每个用例独立：自己准备数据、自己清理、不依赖其他用例顺序。
- 业界实现：Playwright `fixture` + beforeEach/afterEach；Appium `setUp/tearDown`。
- 反例：测试 A 创建数据 → 测试 B 读取 → 测试 C 删除。这种耦合是 CI 上的噩梦。

### 3.4 数据驱动测试（DDT）

- 同一套用例逻辑，不同输入参数。例：登录用 10 组账号密码跑同一用例。
- 工具：Playwright 参数化（`for` 循环 + JSON 数据）；Appium 用 `pytest.mark.parametrize`（Python）或 `@DataProvider`（Java）。

### 3.5 显式等待 vs 隐式等待

- **铁律**：99% 的 flaky 测试源于「等待逻辑不对」。
- 显式等待：等某个条件成立（元素可见 / 文本出现 / API 返回）。
- Playwright：`expect(locator).toBeVisible()` 默认就是显式。
- Appium：`WebDriverWait(driver, 10).until(...)`。
- **面试高频题**：隐式等待有什么坑？（答：难以控制粒度，容易让本该失败的用例被错误"等"成功。）

### 3.6 失败重试与 flaky 测试治理

- 失败重试：CI 跑测试时开启 retry（如 pytest-rerunfailures / Playwright retry），但要标记为 flaky。
- 根本治理：找出 flaky 根因（网络、并发、时序），重试只是兜底，不是解药。
- **面试表达**：能讲清「我如何定位一个 flaky 用例」（答：截图 + trace + 日志 + 复现率统计 + 隔离重跑）。

---

## 四、六阶段路线图

### 阶段 0：CI/CD 底座

- **目标**：第一个 GitHub Actions workflow 跑通，建立「提交即自动验证」的手感。
- **内容**：
  1. 本地预跑：Mac 上跑通 `npm install` + Node 回归测试（`test_*.mjs`，可 mock，不碰生产）+ 版本号递增校验。
  2. 新建 `.github/workflows/ci.yml`，触发条件 `push` / `pull_request`。
  3. Job 步骤：安装依赖 → 跑 Node 回归测试 → 版本号递增校验。
  4. 引入缓存：`actions/cache` 缓存 node_modules，CI 时间从 60s+ 降到 10s 级。
- **验收标准**：push 后流水线自动执行，通过/失败状态在 GitHub 可见，失败日志可定位；本地与 CI 执行结果一致。
- **沉淀的面试知识点**：workflow / job / step 层级；触发事件；runner；secrets；缓存；失败阻断；本地- CI 一致性。

### 阶段 1：web 管理后台

> **状态：✅ 已完成（2026-09-08）**——项目位于 `admin/`（Vite + React + Supabase，同仓库子项目）。构建通过、本地运行正常、登录页冒烟测试通过；「真实读写 E2E 验证」按计划留给阶段 2（独立测试库 + 数据隔离）。

- **目标**：搭一个最小可用的 React 管理后台，作为 web 自动化测试的对象。
- **内容**：
  1. 新建后台项目（React + Supabase，复用现有 Supabase 项目与表）。
  2. Supabase 连接走**环境变量**（`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`），便于测试/生产环境隔离。
  3. 关键实践：组件上加 `data-testid` 属性，便于 Playwright 稳定定位（这是面试高频题）。
  4. 最小闭环功能（3~5 个）：登录、查看待办列表、搜索、删除待办、（可选）数据统计。
- **验收标准**：本地能跑，能读写 Supabase 数据；切换环境变量后能连不同 Supabase 实例。
- **沉淀的面试知识点**：web 应用结构；前后端分离（BaaS）；React 被测对象技术栈（组件、异步渲染、`data-testid` 定位）；环境变量管理。

### 阶段 2：web 自动化测试 + CI

- **目标**：Playwright 测后台，接入 CI 自动跑，形成「持续测试」闭环。
- **内容**：
  1. 编写后台 E2E 用例（登录、查看、搜索、删除），**采用 POM 模式**（每个页面一个 class）。
  2. 数据隔离：使用**独立 Supabase 测试项目**（物理隔离，测试数据随便增删）。后台 Supabase 连接通过环境变量切换，测试环境指向测试库、生产环境指向生产库。
  3. 接入 GitHub Actions：push 自动跑，**失败阻断合并**（branch protection rules）。
  4. 集成 **Allure 报告**：HTML 报告 + 失败截图 + trace + 历史趋势。
- **验收标准**：push 自动跑 E2E，失败阻断合并，Allure 报告可查看（含历史趋势）。
- **沉淀的面试知识点**：持续测试；测试金字塔；POM；测试数据隔离；Playwright 特性（auto-wait、trace、fixtures、并行）；Allure 集成；branch protection rules。

### 阶段 3：APP 自动化最小闭环

- **目标**：用 Appium 跑通 1~2 个核心 APP 用例，**本地 Mac 跑通**为最低门槛，CI 兜底为加分项。
- **内容**：
  1. **本地 Mac 环境搭建**：Android Studio（模拟器）+ Appium Server + Appium Inspector（元素查看）+ Java + Maven/Gradle 测试工程。
  2. 编写核心用例（**POM 模式**，每个屏幕一个 class）：登录、添加待办、（进阶）双端同步。
  3. 元素定位策略：**优先 `resource-id` > `accessibility id` > xpath**（这是行业最佳实践，面试必问）。
  4. **本地跑通**后再考虑接入 CI（GitHub Actions ubuntu 镜像）：用 `reactivecircus/android-emulator-runner` 起模拟器跑 Appium。
- **验收标准**：
  - **必达**：本地 Mac 跑通核心用例，Allure 报告可看。
  - **加分**：CI 上 ubuntu 镜像跑通同一套用例（验证「无本地环境依赖也能跑」）。
- **沉淀的面试知识点**：Appium 架构（WebDriver 协议、client-server、driver）；UIAutomator2；desired capabilities；元素定位策略；POM；本地与 CI 环境差异；模拟器 vs 真机的取舍；设备农场概念（BrowserStack / Sauce Labs）。
- **重要事实**：有爱待办是 Capacitor 混合 App（webview 装载 web 资源）。此前的 Playwright 测试测的是 web 资源，属 web 层自动化；本阶段才是真正的 APP 原生层自动化。

### 阶段 4：CD 持续交付

- **目标**：自动构建 + 自动部署，走通「提交 → 上线」的后半段。
- **内容**：
  1. **web 后台**：GitHub Actions 通过 SSH 自动部署到云服务器（Nginx + HTTPS + 域名）。本机预跑 SSH 流程验证，再上 CI。
  2. **APP 热更新**：Mac 本地跑通 `release.mjs`（带 `--dry-run` 出报告），再上 GitHub Actions 自动跑（同样保留 dry-run 报告 + 人工审批门）。
  3. **APK 自动打**：Mac 本地打 + CI ubuntu 兜底双轨（面试讲「CD 完整链路」用 CI 轨迹）。
  4. 接入 **secrets 分级**（GitHub Secrets + 云服务器环境变量）：
     - **Supabase service_role key**：绕过 RLS，仅 CI/部署脚本使用，绝不进前端代码
     - **APK keystore**：base64 编码后存 GitHub Secrets，CI 构建时解码使用
     - **SSH 私钥**：部署专用，与本地开发密钥分离
     - **原则**：最小权限分级、定期轮换、严禁进代码或日志
  5. **回滚演练**：`rollback.mjs` 验证；web 后台保留上一版本目录，CD 失败秒级切回。
- **验收标准**：合并 main 后自动部署后台 + 自动发版 APP（dry-run + 人工审批），支持回滚。
- **沉淀的面试知识点**：持续交付 vs 持续部署（见 §六易错点）；环境流转（test / staging / prod）；SSH 部署；回滚机制；secrets 分级与轮换；HTTPS 证书（Let's Encrypt）；Nginx 反向代理；artifact 归档。

### 阶段 5：全链路整合 + 面试准备

- **目标**：把 CI + CD + 测试串成一条完整的故事，产出可面试的材料。
- **内容**：
  1. 绘制全链路架构图（提交 → CI → 测试环境 → 测试 → 预发布 → 生产）。
  2. **Allure TestOps / 报告聚合**：把 web 和 APP 的测试报告统一入口，趋势可视化。
  3. **复盘踩坑记录**：版本号、数据安全、Mac 资源、网络、缓存策略等。
  4. 整理**面试 FAQ**（重点覆盖）：
     - Jenkins vs GitHub Actions（选型逻辑、什么场景选哪个）
     - CI/CD 全链路描述（每个环节你在做什么、为什么）
     - 测试策略（为什么 UI 自动化为主、POM、数据驱动、显式等待）
     - 移动测试挑战（真机 vs 模拟器、flaky、Capacitor 混合 App 的特殊性）
     - Secrets 管理（怎么存、怎么轮换、最小权限）
     - 回滚策略（怎么发现、怎么回、多久生效）
  5. （可选）录制演示视频 5 分钟。
- **验收标准**：能完整讲 30 分钟，能应对常见追问；面试材料 ready。
- **沉淀的面试知识点**：端到端串联；可观测性；质量度量；从项目实践提炼的面试叙事。

---

## 五、Jenkins 补课（独立小节，插在阶段 2 之后）

- **目的**：补齐 JD「熟悉 Jenkins」的**操作层**（概念层已由 GitHub Actions 覆盖）。
- **方式**：Mac 本地 Docker 起 Jenkins 沙盒，学完即弃，不占用云服务器。
- **操作步骤**（每一步对应一个面试考点）：

  1. `docker run -p 8080:8080 -p 50000:50000 -v jenkins_home:/var/jenkins_home jenkins/jenkins:lts` → 学会「安装 Jenkins」
  2. 访问 `localhost:8080`，解锁安装（按提示输 initialPassword） → 学会「首次配置」
  3. 安装推荐插件 + Git 插件 + Pipeline 插件 → 学会「插件管理」
  4. 建 Freestyle Job，配置 Git 仓库地址 → 学会「Job 与源码管理」
  5. 加「执行 shell」步骤，跑 `npm test` → 学会「构建步骤」
  6. 跑一次，看控制台日志与测试结果 → 学会「构建与报告」
  7. 建 Pipeline Job，写 `stages { stage('Build') { steps { ... } } }` → 学会「Declarative Pipeline」
  8. 配定时触发器（cron）→ 学会「触发器」
  9. （加分）写 Jenkinsfile 用 `agent { docker { image '...' } }` → 学会「Agent 与容器化构建」

- **面试对照**：

| 维度 | Jenkins | GitHub Actions |
|---|---|---|
| 部署形态 | 自建型（自己服务器） | 托管型（GitHub 提供） |
| 配置语言 | Groovy（Jenkinsfile） | YAML |
| 插件生态 | 极丰富（1500+） | 中等（市场 + Actions） |
| 适用场景 | 自建 GitLab / 内网 / iOS 打包 / 复杂流水线 | GitHub 项目 / 标准流水线 |
| 学习曲线 | 陡（自维护） | 平（托管零运维） |

- **何时选 Jenkins（面试必考）**：
  1. 代码仓库不在 GitHub（自建 GitLab / SVN / 内网）
  2. 需要自托管 runner（内网安全合规、或 iOS 打包必须 Mac）
  3. 团队已有 Jenkins 存量资产

- **Pipeline 类型速记**：
  - **Freestyle Job**：UI 配置，自由度高但不可版本化。
  - **Declarative Pipeline**（推荐）：结构化（stages / steps），YAML-like Groovy，可纳入版本管理。
  - **Scripted Pipeline**：纯 Groovy 脚本，灵活但难维护。

---

## 六、测试报告与可观测性

> 行业最佳实践：测试报告是测试工程师最常被问「你这个测试结果到底靠不靠谱」的载体。报告不可视化 = 测试不可信。

### 6.1 Allure 报告

- **地位**：行业事实标准（Java 生态起源，跨语言，CI/CD 集成最成熟）。
- **能力**：HTML 报告 + 历史趋势 + 失败截图 + trace + 测试步骤细化。
- **集成**：
  - Playwright：`@playwright/test` + `allure-playwright` 适配器
  - Appium（Python）：`pytest` + `allure-pytest`
  - Appium（Java）：`allure-junit` 或 `allure-testng`
- **CI 集成**：生成报告 → 归档为 artifact → 可选部署到 GitHub Pages 或自建 Allure Server

### 6.2 报告「可观测」标准

- ✅ 失败用例必带截图（视觉证据）
- ✅ 失败用例必带 trace（操作回放）
- ✅ 历史趋势（这次比上次好了还是坏了）
- ✅ 用例分类（按 feature / priority / owner）
- ✅ 失败分类（产品 bug / 环境问题 / flaky）

### 6.3 缺陷闭环（可选进阶段 5）

- 失败用例自动建 issue（GitHub Issues API）
- 失败用例 → Jira / 飞书 webhook 通知
- 面试表达：能讲清「失败用例如何被发现 → 通知 → 修复 → 验证」的全链路

---

## 七、概念易错点（面试避坑，务必记牢）

1. **CI ≠ 测试**：CI 是「频繁集成 + 每次自动验证」，测试只是验证手段之一。CI 还可以做：lint、静态分析、安全扫描、构建产物验证。
2. **CD 有两个含义，不可混用**：
   - **持续交付（Continuous Delivery）**：自动构建 + 自动部署到类生产环境，但**上线需人工批准**。
   - **持续部署（Continuous Deployment）**：通过验证后**全自动上线**，无人干预。
   - 本项目阶段 4 采用「持续交付」。
3. **影子模式 ≠ 影子部署**：本项目说的「影子模式」是通俗说法，准确对应是「dry-run 演练 + 人工审批门」；而业界的「影子部署（Shadow Deployment）」指新旧版本并行运行、用影子流量对比。两者不要混。
4. **Appium 是框架/协议，不是用例**：它基于 WebDriver 协议，测试用例仍要自己写。
5. **Jenkins 是工具，CI/CD 是理念**：工具可换，理念不变。面试被问「为什么不用 Jenkins」要能答选型逻辑。
6. **测试环境部署也是 CD 的一部分**：CD 不只是「生产部署」，环境流转的每一步自动部署都属于 CD。
7. **本地跑通 ≠ CI 跑通**：CI 环境是干净的 ubuntu runner，没有你的 IDE、缓存、网络代理。能在本地跑不代表能在 CI 跑——这是新人最常踩的坑。
8. **持续测试（Continuous Testing）≠ CI**：持续测试是 CI/CD 流水线中「测试这一环节」的持续化，强调「每次变更都自动验证、失败即阻断、结果可视化」。它是 CI/CD 的一部分，但不是 CI/CD 本身。
9. **Pipeline as Code**：CI/CD 配置本身要被版本管理。面试被问「你们的 CI 配置怎么管理」要能答「YAML/Groovy 文件入库 + PR review」。

---

## 八、风险与注意事项

1. **数据安全（最高优先级）**：任何自动化测试接 CI 前，必须先落实数据隔离，违反 AGENTS.md 铁律一即事故。
2. **时间约束**：云服务器 2026-10-07 到期。若想用它练「自建部署」，需在一个月内走到阶段 4；错过可降级本地 Docker / Vercel 继续，不影响学习。
3. **2核2G 服务器跑不动 Android 模拟器**：Appium 执行环境用 Mac 本地或 GitHub Actions，不用云服务器。
4. **Mac 资源占用**：Android Studio + 模拟器 + Appium Server 同时跑，内存吃紧（建议 16GB+；8GB 勉强可跑但要错开启动顺序）。CI 镜像更稳。
5. **CI ubuntu runner 网络**：到中国大陆网络可能慢，第一次拉镜像（Android SDK ~2GB）会等。建议 `actions/cache` 缓存 SDK。
6. **React + Appium 学习成本高**：属为面试该付的学费；节奏上先走主线（阶段 0→2 快速闭环），再并行加码。
7. **Jenkins 沙盒资源**：Docker Jenkins 镜像约 1GB，磁盘预留 5GB+。
8. **Allure 报告持久化**：GitHub Pages 公开可见，敏感测试数据不要写进报告（截图前先脱敏）。