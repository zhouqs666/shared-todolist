# 2026-10-02：Capacitor 插件代理是 thenable，2.8.1 壳发布后 App 不可用

**关联规则**：AGENTS.md「补充：Capacitor 插件对象是 thenable —— 永不进 Promise 链」（🔴 级铁则）

## 事故

2.8.1 壳发布后，App 端**待办完全不加载**（开屏不撤、列表永不渲染），生产不可用；
网页 / PWA 不受影响。止损：热更 2.7.78 修复 + 壳 2.8.1 下线，装了坏壳的设备拉到热更后自愈。

## 根因（一行）

`notify.js` 新增的 `getLocalNotifications()` 曾是 **async 函数直接 return 插件代理对象**。
Capacitor 的插件代理（`registerPlugin` 的返回值）是 **thenable** —— async 函数返回它时，
Promise 机制会二次展开（调用它的 `.then`），native 下这变成一次**不存在的桥接方法调用**，抛
`LocalNotifications.then() is not implemented on android`。而该调用位于**启动关键路径**
（`initReminder` 在撤开屏与首屏拉取之前），异常中断整个 init IIFE —— 后面的首屏 fetch、render、
撤开屏全部不执行。

**为什么浏览器里发现不了**：浏览器 `isNative=false` 返回 null，走不到出错分支。

## 为什么既有测试体系没拦住（两个盲区叠加）

1. 全部 Web E2E 跑在浏览器，`isNative=false` 走 no-op 分支 —— **native-only 路径零自动覆盖**
   （2026-09-17 删模拟器 CI 时已明确接受的代价，见 [2026-09-17-device-ci-removal.md](2026-09-17-device-ci-removal.md)，这次事故就是那个代价变现）；
2. `node --check` 只查语法不查引用，`e2eMode is not defined`（同批第 2 个 bug）就是它漏掉的。

## 修复与防回归

- **铁则（🔴，代码审查检查项）**：
  - Capacitor 插件代理对象**永远不能**被 `await`、放进 Promise 链、或作为 async/Promise 的返回值
  - **只能** `await` 它的**方法调用的返回值**（如 `await LocalNotifications.schedule({...})` —— 那是 bridge promise）
  - 跨模块传递插件实例用**同步函数**（见 `notify.js` 的 `getLocalNotifications`），时序由
    `ensureCapacitorLoaded()` 显式管理；需要等待就 `await ensureCapacitorLoaded()` 再同步取
- **对策（壳发布前必做，实测成本 ≈ 10 分钟）**：
  1. **模拟器 + debug 壳 + CDP 直连 WebView** 复现/验证：`build-test-apk.mjs` 同款流程改
     `assembleDebug`（debug 包自动开 WebView 调试）→ 装 AVD → `adb forward` + `/json` 拿 page 级
     WebSocket → `Runtime.evaluate` 登录/操作/断言（Playwright 的 `connect_over_cdp` 与 WebView
     不兼容，用原生 page 级 CDP）
  2. 判定「启动链完整」的硬指标：`emptyState 或 todoCount > 0`（render 执行过）+ logcat/CDP 无 `exception`
  3. release 壳不可调试（CDP 关闭），复现必须用 debug 壳；**探针直调原生插件成功 ≠ 产品代码路径成功**
     —— 要走产品代码的真实入口（本次探针直调成功掩盖了第一轮误判，最终靠复现用户操作定位）
