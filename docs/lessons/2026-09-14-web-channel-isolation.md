# 2026-09-14：Web 通道没有测试库隔离，测试数据进了生产库

**关联规则**：AGENTS.md 铁律二（物理隔离 + 网络层只读守卫 + 三个 preflight）

## 发生了什么

调试「撤销完成」功能时，E2E 测试通过 `localhost:3000` 直连了**生产库**：创建了 27 条测试待办；
更麻烦的是盲盒开奖发生在「添加」瞬间，**误解锁了 `legendary_1` 传说贴纸** —— 清掉待办也撤不回贴纸。

## 根因

1. 测试库隔离只做了 Android APK 通道（`build-test-apk.mjs`），**Web 通道漏了**：
   `scripts/serve.mjs` 托管的是生产 `public/`（其中 `supabase.js` 硬编码生产库 URL），
   而 `test_*.py` 直连 `localhost:3000` = 生产库。
2. 同一时期的 `test_pinch.mjs` 漏 mock 了 `rpc/increment_login_count`，请求直接打到生产库 ——
   全靠假 JWT 被 401 拦下才没写入。「脚本本意只读」挡不住事故，**只读必须是网络层阻断**。

## 关键认知

「E2E- 前缀 + 测完清理」这种**软约定挡不住事故** —— 必须是物理隔离，不是命名约定。

## 修复与防回归（现在落地在 AGENTS.md 铁律二）

- `scripts/serve-test.mjs`（端口 3100，运行时改写 supabase.js 指向测试库，生产文件零改动）
- `scripts/e2e_common.py` fail-closed 隔离断言（指向生产直接拦下、退出码 2）
- `scripts/check-test-env.mjs` 隔离自检（测试前 preflight）
- `scripts/_lib-readonly-guard.mjs` 在**网络层**阻断 Node 局部回归的写请求（不靠自觉、不靠 token 恰好无效），
  `scripts/check-test-guards.mjs` 在 CI 里做结构性检查（漏挂守卫直接红）
