"""
完成撤销 E2E 测试

测试待办完成后的撤销功能：完成→出现撤销按钮→点击撤销→恢复未完成。
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

    test_text = 'E2E-测试-完成撤销验证'

    print("== 2. 添加测试待办 ==", flush=True)
    page.locator('#fabBtn').click()
    page.wait_for_selector('#addPanel.add-panel--show', timeout=5000)
    page.fill('#todoInput', test_text)
    page.locator('#addBtn').click()
    page.wait_for_selector(f'.todo:has-text("{test_text}")', timeout=8000)
    check("测试待办已添加", page.locator('.todo', has_text=test_text).count() >= 1)

    print("== 3. 点击完成 ==", flush=True)
    todo_card = page.locator('.todo', has_text=test_text).first
    # 复选框在卡片右上角
    checkbox = todo_card.locator('.todo__check')
    checkbox.click()
    page.wait_for_timeout(500)

    print("== 4. 验证撤销按钮 ==", flush=True)
    page.wait_for_selector('.toast__action', timeout=5000)
    toast_text = page.locator('.toast').inner_text()
    check("完成toast包含撤销按钮", '撤销' in toast_text, f"toast内容: {toast_text}")

    print("== 5. 点击撤销 ==", flush=True)
    page.locator('.toast__action').first.click()
    page.wait_for_timeout(2000)

    print("== 6. 验证恢复未完成 ==", flush=True)
    # 撤销后待办应恢复为未完成（没有 .todo--done 类）
    todo_after = page.locator('.todo', has_text=test_text).first
    has_done_class = 'todo--done' in (todo_after.get_attribute('class') or '')
    check("撤销后待办恢复未完成", not has_done_class, f"class: {todo_after.get_attribute('class')}")

    # 等待"已撤销完成"toast
    page.wait_for_timeout(500)
    toast_texts = page.locator('.toast').all_inner_texts()
    has_confirm = any('已撤销完成' in t for t in toast_texts)
    check("显示已撤销完成确认", has_confirm, f"toasts: {toast_texts}")

    print("== 7. 清理测试数据 ==", flush=True)
    # 右键打开菜单→删除
    todo_after.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
    page.wait_for_timeout(1000)
    check("测试待办已清理", page.locator('.todo', has_text=test_text).count() == 0)

    # 汇总
    print(f"\n== 结果: {results['pass']} 通过 / {results['fail']} 失败 ==", flush=True)
    if errors:
        print(f"\n控制台错误 ({len(errors)}):", flush=True)
        for e in errors[:10]:
            print(f"  {e}", flush=True)

    browser.close()
    sys.exit(1 if results["fail"] > 0 else 0)
