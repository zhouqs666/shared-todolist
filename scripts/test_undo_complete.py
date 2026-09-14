"""
完成撤销 E2E 测试

测试待办完成后的撤销功能：
  - H1: 完成→庆祝toast撤销按钮→点击→恢复未完成
  - H2: 完成→长按菜单→撤销完成→恢复未完成
测试遵循 AGENTS.md：不碰生产数据，用 "E2E-测试-" 前缀，测后清理。
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
errors = []
results = {"pass": 0, "fail": 0}


def check(name, cond, detail=""):
    if cond:
        results["pass"] += 1
        print(f"  OK {name}", flush=True)
    else:
        results["fail"] += 1
        print(f"  FAIL {name} {detail}", flush=True)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_default_timeout(15000)
    page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

    print("== 1. 登录 ==", flush=True)
    page.goto(f"{BASE}/login.html", wait_until="domcontentloaded")
    page.wait_for_selector('#username', timeout=15000)
    page.fill('#username', '小宝宝')
    page.fill('#password', '5201314')
    page.click('#submitBtn')
    page.wait_for_selector('.topbar__avatar', timeout=15000)
    page.wait_for_timeout(1500)
    check("登录成功进入主页", "login" not in page.url, page.url)

    test_text_h1 = 'E2E-测试-完成撤销-toast撤销'
    test_text_h2 = 'E2E-测试-完成撤销-菜单撤销'

    # ===== H1: toast 撤销 =====
    print("\n== H1: toast 撤销 ==", flush=True)

    print("  2a. 添加测试待办 ==", flush=True)
    page.locator('#fabBtn').click()
    page.wait_for_selector('#addPanel.add-panel--show', timeout=5000)
    page.fill('#todoInput', test_text_h1)
    page.locator('#addBtn').click()
    page.wait_for_selector(f'.todo:has-text("{test_text_h1}")', timeout=8000)
    check("H1 测试待办已添加", page.locator('.todo', has_text=test_text_h1).count() >= 1)

    print("  3a. 点击完成 ==", flush=True)
    todo_card = page.locator('.todo', has_text=test_text_h1).first
    todo_card.locator('.todo__check').click()
    page.wait_for_timeout(500)

    print("  4a. 验证撤销按钮 ==", flush=True)
    page.wait_for_selector('.toast__action', timeout=5000)
    toast_text = page.locator('.toast').inner_text()
    check("H1 完成toast包含撤销按钮", '撤销' in toast_text, f"toast内容: {toast_text}")

    print("  5a. 点击撤销 ==", flush=True)
    page.locator('.toast__action').first.click()
    page.wait_for_timeout(2000)

    print("  6a. 验证恢复未完成 ==", flush=True)
    todo_after = page.locator('.todo', has_text=test_text_h1).first
    has_done_class = 'todo--done' in (todo_after.get_attribute('class') or '')
    check("H1 撤销后待办恢复未完成", not has_done_class, f"class: {todo_after.get_attribute('class')}")

    # 清理 H1 测试数据
    todo_after.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
    page.wait_for_timeout(1000)

    # ===== H2: 长按菜单撤销 =====
    print("\n== H2: 长按菜单撤销 ==", flush=True)

    print("  2b. 添加测试待办 ==", flush=True)
    page.locator('#fabBtn').click()
    page.wait_for_selector('#addPanel.add-panel--show', timeout=5000)
    page.fill('#todoInput', test_text_h2)
    page.locator('#addBtn').click()
    page.wait_for_selector(f'.todo:has-text("{test_text_h2}")', timeout=8000)
    check("H2 测试待办已添加", page.locator('.todo', has_text=test_text_h2).count() >= 1)

    print("  3b. 点击完成 ==", flush=True)
    todo_card2 = page.locator('.todo', has_text=test_text_h2).first
    todo_card2.locator('.todo__check').click()
    page.wait_for_timeout(1000)
    # 等 toast 消失，避免干扰后续菜单操作
    page.wait_for_timeout(5000)

    print("  4b. 长按打开菜单 ==", flush=True)
    todo_card2.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="撤销完成"]', timeout=5000)
    check("H2 菜单包含撤销完成按钮", page.locator('.action-sheet__icon-btn[aria-label="撤销完成"]').count() >= 1)

    print("  5b. 点击撤销完成 ==", flush=True)
    page.locator('.action-sheet__icon-btn[aria-label="撤销完成"]').click()
    page.wait_for_timeout(2000)

    print("  6b. 验证恢复未完成 ==", flush=True)
    todo_after2 = page.locator('.todo', has_text=test_text_h2).first
    has_done_class2 = 'todo--done' in (todo_after2.get_attribute('class') or '')
    check("H2 撤销后待办恢复未完成", not has_done_class2, f"class: {todo_after2.get_attribute('class')}")

    # 清理 H2 测试数据
    todo_after2.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
    page.wait_for_timeout(1000)
    check("H2 测试待办已清理", page.locator('.todo', has_text=test_text_h2).count() == 0)

    # 汇总
    print(f"\n== 结果: {results['pass']} 通过 / {results['fail']} 失败 ==", flush=True)
    if errors:
        print(f"\n控制台错误 ({len(errors)}):", flush=True)
        for e in errors[:10]:
            print(f"  {e}", flush=True)

    browser.close()
    sys.exit(1 if results["fail"] > 0 else 0)
