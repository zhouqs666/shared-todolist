# 2026-09-04：APK 壳 versionName 与版本表不一致 ⇒ 无限重装

**关联规则**：AGENTS.md 铁律三（通道 B 的 CI 发布前置守卫）

## 发生了什么

版本表里记的号和 APK 包里自报的号不一致（表说 2.1.29、装的包自报 2.1.28 这一形状）。
客户端把 **APK manifest 里的 versionName**（`apk-update.js` 用 `App.getInfo().version` 读）
当本地版本，与表里的 `version_name` 比对 —— 两者不等就会反复提示同一次更新，
用户陷入**无限重装**。

## 根因

`versionName` 写在 `android/app/build.gradle` 里，而发布命令传的是另一个版本号 ——
当时**没有任何检查**守这条对应关系：包内 `shell-version` meta 是脚本自己注入的、恒等于版本号、
必然通过，形同虚设。

## 修复与防回归（现在落地在 AGENTS.md 铁律三）

- `release-apk.mjs` 守卫（一次性报出全部不一致，不用来回跑两轮）：
  - `versionName` 必须**逐字等于**本次发布的版本号（2026-09-15 补上）
  - `versionCode` 严格递增，基准是含已下线行的历史最大值
  - `--code` 参数不允许与 `build.gradle` 不一致（真实 code 永远取自 build.gradle）
- 教训：**守卫要守「跨来源的一致性」**，脚本自己注入再自己校验的项等于没守
