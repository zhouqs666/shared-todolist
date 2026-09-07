"""
已完成历史功能 E2E 测试（真实 UI / 双账号之一：小宝宝）

覆盖：主页只渲染未完成、完成即移出主页、历史弹层出现、顶栏徽标计数、
历史页取消完成回流到主页、弹层开合。

遵循 AGENTS.md：测试待办用 "E2E-测试-" 前缀，测完彻底清理（回收站+彻底删除）。
注意：用精确 data-id 匹配，避免 has_text 对长中文/特殊字符的误匹配。
用法：先 node scripts/serve.mjs，再 python3 scripts/test_history.py
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
TEST_TEXT = "E2E-测试-历史页"
errors = []
results = {"pass": 0, "fail": 0}


def check(name, cond, detail=""):
    if cond:
        results["pass"] += 1
        print(f"  OK {name}", flush=True)
    else:
        results["fail"] += 1
        print(f"  FAIL {name} {detail}", flush=True)


def add_todo(page, text):
    page.locator('#fabBtn').click()
    page.wait_for_selector('#addPanel.add-panel--show', timeout=5000)
    page.fill('#todoInput', text)
    page.locator('#addBtn').click()
    page.wait_for_selector(f'#todoList .todo:has-text("{text}")', timeout=8000)


def cleanup(page, data_id):
    """按 data-id 定位，右键→删除→等待撤销 toast 消失→回收站→彻底删除"""
    sel = f'.todo[data-id="{data_id}"]'
    try:
        page.locator(sel).first.click(button='right')
        page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
        page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
        page.wait_for_timeout(5500)
        page.locator(sel).first.wait_for(state='detached', timeout=5000)

        page.locator('.topbar__avatar').click(button='right')
        page.wait_for_selector('.account-menu__item', timeout=5000)
        page.locator('.account-menu__item', has_text='回收站').first.click()
        page.wait_for_selector('.trash-item', timeout=8000)
        purge = page.locator(f'.trash-item[data-id="{data_id}"] .trash-item__btn--purge')
        if purge.count() == 0:
            purge = page.locator('.trash-item', has_text=TEST_TEXT).first.locator('.trash-item__btn--purge')
        purge.click()
        page.wait_for_timeout(500)
        armed = page.locator('.trash-item__btn--armed')
        if armed.count() >= 1:
            armed.first.click()
            page.wait_for_timeout(3000)
    except Exception as e:
        print(f"  [warn] 清理异常: {e}", flush=True)


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

    print("== 2. 添加测试待办 ==", flush=True)
    add_todo(page, TEST_TEXT)
    item = page.locator('#todoList .todo', has_text=TEST_TEXT).first
    data_id = item.get_attribute('data-id')
    check("主列表含新待办", page.locator(f'#todoList .todo[data-id="{data_id}"]').count() == 1)
    check("历史入口存在", page.locator('#historyEntry').count() == 1)
    check("历史徽标元素存在", page.locator('#historyBadge').count() == 1)

    print("== 3. 标记完成 → 移出主页 + 进入历史 ==", flush=True)
    page.locator(f'#todoList .todo[data-id="{data_id}"] .todo__check').click()
    page.wait_for_timeout(1000)
    check("主页已移除该待办", page.locator(f'#todoList .todo[data-id="{data_id}"]').count() == 0)
    page.locator('#historyEntry').click()
    page.wait_for_selector('#historyModal:not(.hidden)', timeout=5000)
    check("历史弹层已打开", True)
    check("历史列表出现该待办", page.locator(f'#historyList .todo[data-id="{data_id}"]').count() == 1)

    print("== 4. 关闭弹层 ==", flush=True)
    page.locator('#historyModalClose').click()
    page.wait_for_function("document.getElementById('historyModal').classList.contains('hidden')", timeout=5000)
    check("历史弹层已关闭", True)

    print("== 5. 历史页取消完成 → 回流到主页 ==", flush=True)
    page.locator('#historyEntry').click()
    page.locator(f'#historyList .todo[data-id="{data_id}"]').first.wait_for(state='attached', timeout=5000)
    page.locator(f'#historyList .todo[data-id="{data_id}"]').first.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="取消完成"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="取消完成"]').first.click()
    # 等待历史列表移除该精确 data-id 的节点
    try:
        page.locator(f'#historyList .todo[data-id="{data_id}"]').first.wait_for(state='detached', timeout=6000)
        history_gone = True
    except Exception:
        history_gone = page.locator(f'#historyList .todo[data-id="{data_id}"]').count() == 0
    check("历史列表已移除该待办", history_gone)
    check("主页重新出现该待办", page.locator(f'#todoList .todo[data-id="{data_id}"]').count() == 1)
    # 关闭弹层（若仍开）
    if not page.evaluate("document.getElementById('historyModal').classList.contains('hidden')"):
        page.locator('#historyModalClose').click()
        page.wait_for_timeout(400)

    print("== 6. 清理测试数据 ==", flush=True)
    cleanup(page, data_id)
    page.wait_for_timeout(1500)
    # 主列表与历史列表都不应再出现该 data-id
    left_main = page.locator(f'#todoList .todo[data-id="{data_id}"]').count()
    left_hist = page.locator(f'#historyList .todo[data-id="{data_id}"]').count()
    check("测试待办已彻底清除(主列表)", left_main == 0, f"main={left_main}")
    check("测试待办已彻底清除(历史列表)", left_hist == 0, f"hist={left_hist}")

    print("== 7. 页面报错检查 ==", flush=True)
    real = [e for e in errors if "Failed to fetch" not in e and "net::" not in e and "favicon" not in e]
    check("无模块级报错", len(real) == 0, f"错误数 {len(real)}")
    for e in real[:5]:
        print(f"    {e}", flush=True)

    browser.close()

print("=" * 40, flush=True)
print(f"通过: {results['pass']}  失败: {results['fail']}", flush=True)
sys.exit(0 if results["fail"] == 0 else 1)
