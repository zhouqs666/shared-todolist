"""
双环境切换 E2E（测试环境 ↔ 生产环境，一个包；2026-10-06）

覆盖链路：
  1. 测试环境角标：登录后顶栏显示「测试」（主默认探测生效 = 包是测试渠道身份）
  2. 长按头像（桌面右键兜底）→ 账号菜单含「切换环境」
  3. 确认条：文案 + 取消不生效（标记不写、不重载）
  4. 离线队列按环境分键：测试环境入队落在 @test 键，生产键不受影响
     （铁律一形状防线：测试草稿绝不允许在切回生产后重放进生产库）
  5. 真实切换：确认 → 写标记 → reload → 生产环境（角标隐藏）
  6. 【隔离硬闸】整个切换过程对生产库 host 的请求全部被 route 拦截出网
     （auth.getUser 等探测请求在真实设备上会打到目标库——E2E 里一个都不许真出去，
      铁律一：测试不碰生产库，哪怕只是 401 探测）
  7. 环境草稿保留：测试键队列在生产环境仍原样保留
  8. 清理：移除标记 → reload → 回到测试环境、角标重现（现场还原）

数据安全：全程零库写入（标记/队列都是 localStorage；登录只产生 session 读）。
测试遵循 AGENTS.md 铁律一：跑在独立测试服务器（3100，e2e_common 隔离校验）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from e2e_common import (
    resolve_base,
    load_test_creds,
    cleanup_test_data,
    login,
    wait_until,
)

BASE = resolve_base()
TEST_USER, TEST_PASSWORD = load_test_creds()
errors = []
test_results = {"pass": 0, "fail": 0, "checks": []}

PROD_HOST = "zyceucmmtstszdnugimn"  # 生产库 host 片段（隔离拦截判据）


def check(name, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    test_results["pass" if condition else "fail"] += 1
    test_results["checks"].append(f"[{status}] {name}" + (f" — {detail}" if detail else ""))
    print(f"  {'✓' if condition else '✗'} {name}" + (f"  {detail}" if detail and not condition else ""))


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_default_timeout(15000)
    page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

    print("=" * 60)
    print("1. 登录 + 测试环境角标")
    print("=" * 60)
    check("登录成功进入主页", login(page, BASE, TEST_USER, TEST_PASSWORD), page.url)
    badge = page.locator(".topbar__env")
    check("顶栏显示「测试」角标（测试环境身份可见）",
          wait_until(page, lambda: badge.is_visible() and "测试" in (badge.text_content() or ""),
                     desc="顶栏测试角标"),
          f"hidden={badge.get_attribute('hidden')}")
    # 标记缺省（serve-test 改写主默认 → 测试库）：app_env 不应存在
    marker0 = page.evaluate("() => localStorage.getItem('app_env')")
    check("app_env 标记缺省（跟随渠道身份）", marker0 is None, f"got {marker0}")

    print()
    print("=" * 60)
    print("2. 账号菜单（长按头像；桌面右键兜底）")
    print("=" * 60)
    page.locator(".topbar__avatar").click(button="right")
    menu_visible = wait_until(page, lambda: page.locator('[data-testid="switch-env"]').is_visible(),
                              desc="切换环境菜单项")
    check("右键头像 → 账号菜单弹出", menu_visible)
    check("菜单含「切换环境」", menu_visible)
    check("菜单仍含回收站与退出登录",
          page.locator(".account-menu__label", has_text="回收站").count() == 1
          and page.locator(".account-menu__label", has_text="退出登录").count() == 1)

    print()
    print("=" * 60)
    print("3. 确认条：取消不切换")
    print("=" * 60)
    page.locator('[data-testid="switch-env"]').click()
    confirm_visible = wait_until(page, lambda: page.locator('[data-testid="confirm-switch-env"]').is_visible(),
                                 desc="切换确认条")
    # role=dialog 区分确认条与账号菜单（菜单关闭有 250ms 淡出，两者会短暂并存）
    preview_text = (page.locator('.action-sheet[role="dialog"] .action-sheet__preview').text_content() or "")
    check("确认条弹出（文案指向生产环境）", confirm_visible and "切换到生产环境" in preview_text,
          f"实际: {preview_text}")
    page.locator('.action-sheet[role="dialog"] .action-sheet__close').click()
    page.wait_for_timeout(400)
    check("取消后标记未写、未重载",
          page.evaluate("() => localStorage.getItem('app_env')") is None
          and page.locator(".topbar__avatar").count() > 0)

    print()
    print("=" * 60)
    print("4. 离线队列按环境分键")
    print("=" * 60)
    q = page.evaluate("""async () => {
        const q = await import('/js/offline-queue.js');
        q.enqueueOffline({ localId: 'e2e-envswitch-1', text: 'E2E-测试-环境切换草稿', rarity: 'common', ts: Date.now() });
        return {
            testKey: localStorage.getItem('youai_offline_queue@test'),
            prodKey: localStorage.getItem('youai_offline_queue'),
        };
    }""")
    check("测试环境入队落在 @test 键", q["testKey"] is not None and "e2e-envswitch-1" in q["testKey"],
          f"got {q}")
    check("生产键未被污染", q["prodKey"] is None, f"got {q['prodKey']}")

    print()
    print("=" * 60)
    print("5. 真实切换到生产环境（生产请求全部拦截出网）")
    print("=" * 60)
    blocked = []
    page.route(f"**{PROD_HOST}**", lambda route: (blocked.append(route.request.url), route.abort()))

    page.locator(".topbar__avatar").click(button="right")
    wait_until(page, lambda: page.locator('[data-testid="switch-env"]').is_visible(), desc="再次打开菜单")
    page.locator('[data-testid="switch-env"]').click()
    wait_until(page, lambda: page.locator('[data-testid="confirm-switch-env"]').is_visible(), desc="确认条")
    page.locator('[data-testid="confirm-switch-env"]').click()

    # reload 后：marker=prod → getCurrentUser 对生产 auth 的探测被拦截 → error → 跳登录页
    landed_login = wait_until(page, lambda: "login" in page.url, timeout_ms=20000,
                              desc="切换后落在登录页")
    marker1 = page.evaluate("() => localStorage.getItem('app_env')")
    check("确认切换：标记写入 prod", marker1 == "prod", f"got {marker1}")
    check("切换后落在登录页（生产环境无该 origin 的 session）", landed_login, page.url)
    badge_hidden = page.locator('[data-env-badge]').first
    check("生产环境角标隐藏", wait_until(
        page, lambda: page.locator('[data-env-badge]').first.is_hidden(), desc="角标隐藏"))
    check("对生产库的请求全部被拦截出网（铁律一）", len(blocked) > 0,
          f"拦截 {len(blocked)} 条（0 条说明流程没走到网络层，隔离未被真正考验）")
    for u in blocked[:5]:
        print(f"      拦截: {u[:90]}")

    q2 = page.evaluate("""() => ({
        testKey: localStorage.getItem('youai_offline_queue@test'),
        prodKey: localStorage.getItem('youai_offline_queue'),
    })""")
    check("测试草稿在生产环境仍原样保留（不串键）",
          q2["testKey"] is not None and "e2e-envswitch-1" in q2["testKey"], f"got {q2}")
    check("生产键仍未被污染", q2["prodKey"] is None, f"got {q2['prodKey']}")

    print()
    print("=" * 60)
    print("6. 清理：回测试环境")
    print("=" * 60)
    page.unroute(f"**{PROD_HOST}**")
    page.evaluate("() => localStorage.removeItem('app_env')")
    page.evaluate("""() => {
        const arr = JSON.parse(localStorage.getItem('youai_offline_queue@test') || '[]');
        localStorage.setItem('youai_offline_queue@test',
            JSON.stringify(arr.filter((op) => op.localId !== 'e2e-envswitch-1')));
    }""")
    page.goto(BASE + "/", wait_until="domcontentloaded")
    check("回测试环境：角标重现", wait_until(
        page, lambda: page.locator(".topbar__env").is_visible(), desc="角标重现"))
    check("标记已清理", page.evaluate("() => localStorage.getItem('app_env')") is None)

    check("全程无页面 JS 错误", len(errors) == 0, " | ".join(errors[:4]))
    browser.close()

cleanup_test_data()

print()
print("=" * 60)
print("测试结果汇总")
print("=" * 60)
for c in test_results["checks"]:
    print(f"  {c}")
print()
print(f"通过: {test_results['pass']}  失败: {test_results['fail']}")
sys.exit(0 if test_results["fail"] == 0 else 1)
