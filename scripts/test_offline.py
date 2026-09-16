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
from e2e_common import (
    resolve_base,
    load_test_creds,
    make_checker,
    cleanup_test_data,
    add_todo,
    login,
    wait_toast_gone,
    wait_until,
)

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
    check("登录成功进入主页", login(page, BASE, TEST_USER, TEST_PASSWORD), page.url)

    # 清空离线队列（隔离上次残留），不影响登录态
    page.evaluate("() => localStorage.removeItem('youai_offline_queue')")

    test_text = 'E2E-测试-离线待办'

    print("== 2. 断网 ==", flush=True)
    context.set_offline(True)
    check("浏览器判定离线", wait_until(
        page,
        lambda: page.evaluate("() => navigator.onLine === false"),
        desc="navigator.onLine 变为 false",
    ))

    print("== 3. 离线添加待办 → pending ==", flush=True)
    check("离线添加后本地显示", add_todo(page, test_text))
    check("带 pending 态", page.locator(f'.todo--pending:has-text("{test_text}")').count() >= 1)
    check("显示「待同步」小标", page.locator('.todo__pending-badge', has_text='待同步').count() >= 1)
    check("已入队", page.evaluate(
        "() => JSON.parse(localStorage.getItem('youai_offline_queue') || '[]').length === 1"))

    print("== 4. 恢复网络 → 自动补发 ==", flush=True)
    context.set_offline(False)
    # 等 online 事件触发 replay，pending 被真实待办替换后 detach
    page.wait_for_selector('.todo--pending', state='detached', timeout=30000)
    check("补发后 pending 消失", page.locator(f'.todo--pending:has-text("{test_text}")').count() == 0)
    check("补发后真实待办存在", wait_until(
        page,
        lambda: page.locator('.todo', has_text=test_text).count() >= 1,
        desc="补发后真实待办出现",
    ))
    # 回归（2026-09-16）：'online' 事件可能连续触发两次，而队列项要等 createTodo 回来才被移除 ——
    # 并发重放会把同一条 op 补发成两条重复待办（表现为"删掉一条后列表里还有同文案的另一条"）。
    same_text_count = page.locator(f'.todo:has-text("{test_text}")').count()
    check("补发后只有一条（同文案不会重复创建）", same_text_count == 1, f"实际 {same_text_count} 条")
    check("「待同步」小标已移除", page.locator('.todo__pending-badge', has_text='待同步').count() == 0)
    check("队列已清空", wait_until(
        page,
        lambda: page.evaluate("() => JSON.parse(localStorage.getItem('youai_offline_queue') || '[]').length === 0"),
        desc="离线队列清空",
    ))

    print("== 5. 清理测试数据（软删除 + 彻底删除）==", flush=True)
    page.locator('.todo', has_text=test_text).first.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
    # 等「撤销」提示出现：它只在软删除**成功**后弹出，是"删除已落库"的真实信号。
    # 原来直接 wait_toast_gone，可能在请求还没回来时就返回（那时没有提示在显示），
    # 于是紧接着读回收站会读到空列表 —— 2026-09-16 定位到的既有 flake。
    page.wait_for_selector('.toast__action', timeout=8000)
    wait_toast_gone(page)  # 再等 5 秒撤销窗口过去
    check("主列表已移除", wait_until(
        page,
        lambda: page.locator('.todo', has_text=test_text).count() == 0,
        desc="删除后待办离开主列表",
    ))
    # 回归（2026-09-16）：迟到的 Realtime 回声曾把刚删掉的待办塞回主列表
    # —— 在 main 上本机 2/3 复现（列表里又有它，而库里确实已软删除）。
    # 这里刻意再观察 3 秒：断言的不是"某一刻不在"，而是"撤销窗口过后不会自己冒回来"。
    # （这是**观察窗口**，不是用固定 sleep 去赌异步同步，所以不用条件等待替换它。）
    page.wait_for_timeout(3000)
    check("删除后不会自己冒回主列表（迟到回声已被墓碑拦住）",
          page.locator('.todo', has_text=test_text).count() == 0, "删除 3 秒后该待办仍出现在主列表")
    page.locator('.topbar__avatar').click(button='right')
    page.wait_for_selector('.account-menu__item', timeout=5000)
    page.locator('.account-menu__item', has_text='回收站').first.click()
    page.wait_for_selector('.trash-item', timeout=8000)
    page.locator('.trash-item', has_text=test_text).first.locator('.trash-item__btn--purge').click()
    wait_until(
        page,
        lambda: page.locator('.trash-item__btn--armed').count() >= 1,
        desc="彻底删除待确认态出现",
    )
    page.locator('.trash-item__btn--armed').first.click()
    check("测试数据已彻底清理", wait_until(
        page,
        lambda: page.locator('.trash-item', has_text=test_text).count() == 0,
        desc="彻底删除后回收站清空",
    ))

    print("== 5b. 冷启动补发（队列残留 + 联网重开）==", flush=True)
    test_text2 = 'E2E-测试-离线冷启动'
    # 模拟上次离线会话残留的队列项（不入列表，只入队），不依赖 UI
    page.evaluate("""(text) => {
      const q = JSON.parse(localStorage.getItem('youai_offline_queue') || '[]');
      q.push({ localId: 'offline-cold-' + Date.now(), text: text, rarity: 'common', ts: Date.now() });
      localStorage.setItem('youai_offline_queue', JSON.stringify(q));
    }""", test_text2)
    page.reload(wait_until='domcontentloaded')
    page.wait_for_selector('.topbar__avatar', timeout=30000)
    page.wait_for_selector(f'.todo:has-text("{test_text2}")', timeout=30000)
    check("冷启动自动补发并显示", page.locator('.todo', has_text=test_text2).count() >= 1)
    check("冷启动后队列清空", wait_until(
        page,
        lambda: page.evaluate("() => JSON.parse(localStorage.getItem('youai_offline_queue') || '[]').length === 0"),
        desc="冷启动补发后队列清空",
    ))
    # 清理冷启动场景的测试数据
    page.locator('.todo', has_text=test_text2).first.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
    # 同上：等撤销提示（= 软删除成功）再往下走，否则回收站会读到空列表
    page.wait_for_selector('.toast__action', timeout=8000)
    wait_toast_gone(page)
    page.locator('.topbar__avatar').click(button='right')
    page.wait_for_selector('.account-menu__item', timeout=5000)
    page.locator('.account-menu__item', has_text='回收站').first.click()
    page.wait_for_selector('.trash-item', timeout=8000)
    page.locator('.trash-item', has_text=test_text2).first.locator('.trash-item__btn--purge').click()
    wait_until(
        page,
        lambda: page.locator('.trash-item__btn--armed').count() >= 1,
        desc="冷启动待办彻底删除待确认态出现",
    )
    page.locator('.trash-item__btn--armed').first.click()
    check("冷启动测试数据已清理", wait_until(
        page,
        lambda: page.locator('.trash-item', has_text=test_text2).count() == 0,
        desc="冷启动测试数据已彻底删除",
    ))

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
