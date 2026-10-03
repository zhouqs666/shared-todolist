# 事故复盘库（docs/lessons）

AGENTS.md 里每条铁律背后的完整复盘：**发生了什么 / 根因 / 修复与防回归 / 关联规则**。
AGENTS.md 只保留规则本体和一行教训要点，完整叙事在这里。改动对应规则时，建议先读对应复盘。

| 日期 | 文件 | 一句话 | 关联规则 |
|---|---|---|---|
| 2026-07-31 | [2026-07-31-prod-data-loss.md](2026-07-31-prod-data-loss.md) | 谓词批量删清空生产 todos，永久丢失 | 铁律一 |
| 2026-08-07 | [2026-08-07-stale-version-no-update.md](2026-08-07-stale-version-no-update.md) | 版本号低于线上，App 判定无更新 | 铁律三（版本号纪律） |
| 2026-09-04 | [2026-09-04-apk-infinite-reinstall.md](2026-09-04-apk-infinite-reinstall.md) | versionName 与表不一致 ⇒ 无限重装 | 铁律三（通道 B 前置守卫） |
| 2026-09-14 | [2026-09-14-web-channel-isolation.md](2026-09-14-web-channel-isolation.md) | Web 通道无测试库隔离，测试数据进生产 | 铁律二（物理隔离 + 只读守卫） |
| 2026-09-15 | [2026-09-15-credential-leak.md](2026-09-15-credential-leak.md) | 真实凭据躺在公开仓库一周 | 铁律七 |
| 2026-09-16 | [2026-09-16-rls-disabled.md](2026-09-16-rls-disabled.md) | 测试库 RLS 被手工关掉无人发现 | 铁律二（机器判定漂移） |
| 2026-09-16 | [2026-09-16-backup-branches.md](2026-09-16-backup-branches.md) | 本地 backup/* 分支不是备份 | 铁律三（回滚锚点用 tag） |
| 2026-09-17 | [2026-09-17-device-ci-removal.md](2026-09-17-device-ci-removal.md) | 设备侧 E2E 移出 CI 的完整取舍 | 铁律五（CI 分层） |
| 2026-10-02 | [2026-10-02-capacitor-thenable.md](2026-10-02-capacitor-thenable.md) | 插件代理进 Promise 链，2.8.1 壳不可用 | 铁律八 |

另见：[../emulator-troubleshooting.md](../emulator-troubleshooting.md) —— 本机模拟器黑屏排障手册（2026-10-02）。
