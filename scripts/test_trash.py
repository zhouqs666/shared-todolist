"""
回收站 + 删除撤销 E2E 测试（批1：H1 回收站 + H2 删除撤销）

测试遵循 AGENTS.md 铁律一：跑在独立测试库（scripts/serve-test.mjs + e2e_common 隔离校验）。
所有测试待办用 "E2E-测试-" 前缀，测后彻底清理。用 wait_for 精准等待，避免超时。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from e2e_common import resolve_base, load_test_creds, make_checker

BASE = resolve_base()
TEST_USER, TEST_PASSWORD = load_test_creds()
errors = []
check, results = make_checker()


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_default_timeout(15000)
    page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

    print("== 1. 登录 ==", flush=True)
    page.goto(f"{BASE}/login.html", wait_until="domcontentloaded")
    page.wait_for_selector('#username', timeout=15000)
    page.fill('#username', TEST_USER)
    page.fill('#password', TEST_PASSWORD)
    page.click('#submitBtn')
    # 等应用就绪：头像出现（renderMe 已执行）后再等一会，确保 bindEvents 完成
    page.wait_for_selector('.topbar__avatar', timeout=15000)
    page.wait_for_timeout(1500)
    check("登录成功进入主页", "login" not in page.url, page.url)

    test_text = 'E2E-测试-回收站验证'

    print("== 2. 添加测试待办 ==", flush=True)
    page.locator('#fabBtn').click()
    page.wait_for_selector('#addPanel.add-panel--show', timeout=5000)
    page.fill('#todoInput', test_text)
    page.locator('#addBtn').click()
    page.wait_for_selector(f'.todo:has-text("{test_text}")', timeout=8000)
    check("测试待办已添加", page.locator('.todo', has_text=test_text).count() >= 1)

    print("== 3. H2 删除→撤销 ==", flush=True)
    page.locator('.todo', has_text=test_text).first.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
    page.wait_for_selector('.toast__action', timeout=5000)
    check("删除后出现「撤销」按钮", True)
    page.locator('.toast__action').first.click()
    page.wait_for_timeout(2000)
    check("撤销后待办恢复", page.locator('.todo', has_text=test_text).count() >= 1)

    print("== 4. H1 删除→回收站可见 ==", flush=True)
    page.locator('.todo', has_text=test_text).first.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
    page.wait_for_timeout(5000)  # 等撤销 toast 消失
    check("主列表已移除", page.locator('.todo', has_text=test_text).count() == 0)

    page.locator('.topbar__avatar').click(button='right')
    page.wait_for_selector('.account-menu__item', timeout=5000)
    check("账号菜单出现「回收站」", page.locator('.account-menu__item', has_text='回收站').count() >= 1)
    page.locator('.account-menu__item', has_text='回收站').first.click()
    page.wait_for_selector('.trash-item', timeout=8000)
    check("回收站可见已删待办", page.locator('.trash-item', has_text=test_text).count() >= 1)

    print("== 5. H1 回收站恢复 ==", flush=True)
    page.locator('.trash-item', has_text=test_text).first.locator('.trash-item__btn--restore').click()
    page.wait_for_timeout(2000)
    page.locator('.trash-sheet__close').click()
    page.wait_for_timeout(800)
    check("恢复后回到主列表", page.locator('.todo', has_text=test_text).count() >= 1)

    print("== 6. H1 彻底删除（两段确认）==", flush=True)
    page.locator('.todo', has_text=test_text).first.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
    page.wait_for_timeout(5500)
    page.locator('.topbar__avatar').click(button='right')
    page.wait_for_selector('.account-menu__item', timeout=5000)
    page.locator('.account-menu__item', has_text='回收站').first.click()
    page.wait_for_selector('.trash-item', timeout=8000)
    purge = page.locator('.trash-item', has_text=test_text).first.locator('.trash-item__btn--purge')
    purge.click()
    page.wait_for_timeout(500)
    armed = page.locator('.trash-item__btn--armed')
    check("彻底删除需二次确认", armed.count() >= 1, f"armed数={armed.count()}")
    print(f"    [诊断] 二次点击前 purge 文本={page.locator('.trash-item', has_text=test_text).first.locator('.trash-item__btn--purge').text_content()}", flush=True)
    armed.click()
    page.wait_for_timeout(3000)
    remaining = page.locator('.trash-item', has_text=test_text).count()
    if remaining > 0:
        all_texts = page.locator('.trash-item').all_text_contents()
        print(f"    [诊断] 回收站剩余含目标: {remaining}", flush=True)
        page.screenshot(path="/tmp/trash-purge-fail.png", full_page=True)
    check("彻底删除后回收站清空", remaining == 0)

    print("== 7. 页面报错检查 ==", flush=True)
    real = [e for e in errors if "Failed to fetch" not in e and "net::" not in e and "favicon" not in e]
    check("无模块级报错", len(real) == 0, f"错误数 {len(real)}")
    for e in real[:5]:
        print(f"    {e}", flush=True)

    browser.close()

print("=" * 40, flush=True)
print(f"通过: {results['pass']}  失败: {results['fail']}", flush=True)
sys.exit(0 if results["fail"] == 0 else 1)
