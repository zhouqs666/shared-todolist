"""
离线 addTodo E2E 测试（批3：M2 离线待办 MVP）

验证：断网添加待办 → 本地半透明 pending 显示 + 「待同步」小标
      → 恢复网络 → 自动补发 → pending 被真实待办替换（变实色、标移除、队列清空）。

遵循 AGENTS.md 铁律一：跑在独立测试库（scripts/serve-test.mjs + e2e_common 隔离校验）。
测试待办用 "E2E-测试-" 前缀，测后软删除 + 回收站彻底删除。
用 wait_for 精准等待，避免固定 sleep 超时。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from e2e_common import resolve_base, load_test_creds, make_checker, cleanup_test_data

BASE = resolve_base()
TEST_USER, TEST_PASSWORD = load_test_creds()
errors = []
check, results = make_checker()


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context()
    page = context.new_page()
    page.set_default_timeout(15000)
    page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

    print("== 1. 登录 ==", flush=True)
    page.goto(f"{BASE}/login.html", wait_until="domcontentloaded")
    page.wait_for_selector('#username', timeout=15000)
    page.fill('#username', TEST_USER)
    page.fill('#password', TEST_PASSWORD)
    page.click('#submitBtn')
    page.wait_for_selector('.topbar__avatar', timeout=15000)
    page.wait_for_timeout(1500)
    check("登录成功进入主页", "login" not in page.url, page.url)

    # 清空离线队列（隔离上次残留），不影响登录态
    page.evaluate("() => localStorage.removeItem('youai_offline_queue')")

    test_text = 'E2E-测试-离线待办'

    print("== 2. 断网 ==", flush=True)
    context.set_offline(True)
    page.wait_for_timeout(600)
    check("浏览器判定离线", page.evaluate("() => navigator.onLine === false"))

    print("== 3. 离线添加待办 → pending ==", flush=True)
    page.locator('#fabBtn').click()
    page.wait_for_selector('#addPanel.add-panel--show', timeout=5000)
    page.fill('#todoInput', test_text)
    page.locator('#addBtn').click()
    page.wait_for_selector(f'.todo:has-text("{test_text}")', timeout=8000)
    check("离线添加后本地显示", page.locator('.todo', has_text=test_text).count() >= 1)
    check("带 pending 态", page.locator(f'.todo--pending:has-text("{test_text}")').count() >= 1)
    check("显示「待同步」小标", page.locator('.todo__pending-badge', has_text='待同步').count() >= 1)
    check("已入队", page.evaluate(
        "() => JSON.parse(localStorage.getItem('youai_offline_queue') || '[]').length === 1"))

    print("== 4. 恢复网络 → 自动补发 ==", flush=True)
    context.set_offline(False)
    # 等 online 事件触发 replay，pending 被真实待办替换后 detach
    page.wait_for_selector('.todo--pending', state='detached', timeout=20000)
    page.wait_for_timeout(1500)
    check("补发后 pending 消失", page.locator(f'.todo--pending:has-text("{test_text}")').count() == 0)
    check("补发后真实待办存在", page.locator('.todo', has_text=test_text).count() >= 1)
    check("「待同步」小标已移除", page.locator('.todo__pending-badge', has_text='待同步').count() == 0)
    check("队列已清空", page.evaluate(
        "() => JSON.parse(localStorage.getItem('youai_offline_queue') || '[]').length === 0"))

    print("== 5. 清理测试数据（软删除 + 彻底删除）==", flush=True)
    page.locator('.todo', has_text=test_text).first.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
    page.wait_for_timeout(5500)  # 等撤销 toast 消失
    check("主列表已移除", page.locator('.todo', has_text=test_text).count() == 0)
    page.locator('.topbar__avatar').click(button='right')
    page.wait_for_selector('.account-menu__item', timeout=5000)
    page.locator('.account-menu__item', has_text='回收站').first.click()
    page.wait_for_selector('.trash-item', timeout=8000)
    purge = page.locator('.trash-item', has_text=test_text).first.locator('.trash-item__btn--purge')
    purge.click()
    page.wait_for_timeout(500)
    page.locator('.trash-item__btn--armed').first.click()
    page.wait_for_timeout(3000)
    check("测试数据已彻底清理", page.locator('.trash-item', has_text=test_text).count() == 0)

    print("== 5b. 冷启动补发（队列残留 + 联网重开）==", flush=True)
    test_text2 = 'E2E-测试-离线冷启动'
    # 模拟上次离线会话残留的队列项（不入列表，只入队），不依赖 UI
    page.evaluate("""(text) => {
      const q = JSON.parse(localStorage.getItem('youai_offline_queue') || '[]');
      q.push({ localId: 'offline-cold-' + Date.now(), text: text, rarity: 'common', ts: Date.now() });
      localStorage.setItem('youai_offline_queue', JSON.stringify(q));
    }""", test_text2)
    page.reload(wait_until='domcontentloaded')
    page.wait_for_selector('.topbar__avatar', timeout=15000)
    page.wait_for_selector(f'.todo:has-text("{test_text2}")', timeout=15000)
    check("冷启动自动补发并显示", page.locator('.todo', has_text=test_text2).count() >= 1)
    check("冷启动后队列清空", page.evaluate(
        "() => JSON.parse(localStorage.getItem('youai_offline_queue') || '[]').length === 0"))
    # 清理冷启动场景的测试数据
    page.locator('.todo', has_text=test_text2).first.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
    page.wait_for_timeout(5500)
    page.locator('.topbar__avatar').click(button='right')
    page.wait_for_selector('.account-menu__item', timeout=5000)
    page.locator('.account-menu__item', has_text='回收站').first.click()
    page.wait_for_selector('.trash-item', timeout=8000)
    page.locator('.trash-item', has_text=test_text2).first.locator('.trash-item__btn--purge').click()
    page.wait_for_timeout(500)
    page.locator('.trash-item__btn--armed').first.click()
    page.wait_for_timeout(3000)
    check("冷启动测试数据已清理", page.locator('.trash-item', has_text=test_text2).count() == 0)

    print("== 6. 页面报错检查 ==", flush=True)
    real = [e for e in errors if "Failed to fetch" not in e and "net::" not in e and "favicon" not in e]
    check("无模块级报错", len(real) == 0, f"错误数 {len(real)}")
    for e in real[:5]:
        print(f"    {e}", flush=True)

    # UI 删除是软删除，行仍在表里；统一硬删一次
    cleanup_test_data()
    browser.close()

print("=" * 40, flush=True)
print(f"通过: {results['pass']}  失败: {results['fail']}", flush=True)
sys.exit(0 if results["fail"] == 0 else 1)
