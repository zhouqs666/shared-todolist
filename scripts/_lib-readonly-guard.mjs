/**
 * 只读守卫：在**网络层阻断**这些 Node 脚本对 Supabase 的写请求。
 *
 * 背景（2026-09-14 事故的同源风险）：
 *   scripts/test_*.mjs 这几个 Node 回归脚本跑在 http://localhost:3000（生产库托管的
 *   public/）。它们本意只读，但实测 test_pinch.mjs 会向生产库发
 *       POST /rest/v1/rpc/increment_login_count（冷启动计数 RPC）
 *   —— 它只 mock 了 6 个端点，漏了这个 RPC，请求直接漏到生产库，全靠假 JWT 被
 *   401 拒掉才没写入。「靠 token 恰好无效」不能算安全设计。
 *
 * 设计取舍：只「检测 + 报错」不够（写入可能已经发生），所以改成结构性阻断 ——
 *   注册一条兜底路由，凡是打到 /rest/v1/ 的写请求就地 abort，永远到不了生产库。
 *   未匹配其它路由的读请求用 route.fallback() 正常放行。
 *   （Playwright 路由按注册逆序执行：脚本自己注册的 mock 后注册，优先级更高，
 *     所以正常 mock 不受影响；只有「没被 mock 到的写请求」才会落到本守卫。）
 *
 * 用法：
 *   import { guardReadOnly } from './_lib-readonly-guard.mjs';
 *   const page = await browser.newPage();
 *   const guard = guardReadOnly(page);   // 必须在脚本自己的 page.route 之前调用
 *   ...
 *   guard.assertClean();                 // 结尾调用：有拦截就 exitCode=1
 */

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function guardReadOnly(...initialPages) {
  const blocked = [];

  function attach(page) {
    page.route('**/rest/v1/**', (route) => {
      const req = route.request();
      if (!WRITE_METHODS.has(req.method())) return route.fallback(); // 读请求放行给脚本自己的 mock
      blocked.push(`${req.method()} ${req.url().split('?')[0]}`);
      return route.abort('blockedbyclient');
    });
    return page;
  }

  for (const p of initialPages) attach(p);

  return {
    attach,

    get blocked() {
      return blocked.slice();
    },

    /** 结尾调用：有写请求被拦截说明脚本不封闭，报错退出 */
    assertClean() {
      if (!blocked.length) {
        console.log('\n✓ 只读守卫通过：未向 Supabase 发起写请求');
        return true;
      }
      console.error(`\n✗ 只读守卫拦截了 ${blocked.length} 个写请求（已阻断，未落库）：`);
      for (const b of blocked) console.error(`    ${b}`);
      console.error(
        '\n  这些脚本跑在生产服务（:3000）上。请求被就地 abort 了，所以没有数据写入，\n' +
          '  但说明脚本没有把该端点 mock 掉 —— 请像其它端点一样补上 page.route 兜底，\n' +
          '  或改用测试服务器（node scripts/serve-test.mjs，:3100）+ Python E2E。\n'
      );
      process.exitCode = 1;
      return false;
    },
  };
}
