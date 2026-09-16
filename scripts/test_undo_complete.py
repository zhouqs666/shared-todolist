"""
完成撤销 E2E 测试

测试待办完成后的撤销功能：
  - H1: 完成→庆祝toast撤销按钮→点击→恢复未完成（**普通款与隐藏款各跑一次**，稀有度用
        localStorage 钩子钉死 —— 隐藏款原来靠 15% 的随机命中，那正是它被漏测的原因）
  - H2: 完成→长按菜单→撤销完成→恢复未完成
测试遵循 AGENTS.md 铁律一：跑在独立测试库（scripts/serve-test.mjs + e2e_common 隔离校验）。
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
    dump_dom_state,
    login,
    wait_add_settled,
    wait_toast_gone,
    wait_until,
)

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
    check("登录成功进入主页", login(page, BASE, TEST_USER, TEST_PASSWORD), page.url)

    test_text_h2 = 'E2E-测试-完成撤销-菜单撤销'

    # ===== H1: toast 撤销（普通款 / 隐藏款各跑一次，稀有度用钩子钉死）=====
    #
    # ⚠️ 这里曾有一条**隔离分支**（2026-09-16 撤除，撤前先跑过验证）。原委：
    #   confetti-effects.js 的 celebrateCompletion 先 showToast(带「撤销」)，紧接着
    #   celebrateRarity() 又 showToast 一次 —— 而 showToast 复用单例 #toast，第二次调用
    #   把内容连按钮一起清空 ⇒ 隐藏款完成时撤销入口**必然不可用**（不是时序问题，
    #   快照实测 {cls: 'todo--rare', toastText: '✨ 开出稀有款！', actionButtons: 0}）。
    #   当时的处置是「普通款断言 toast 撤销，隐藏款改走菜单撤销」。
    # #41 已把 showToast 改成**串行排队**（上一条还在显示时新提示排队，不再覆盖），缺陷消失
    # ⇒ 隔离随即变成**仓库在说谎**：那条路径只剩一个"绕行"断言，坏了也没人知道
    # （它已经咬过两次：web 通道 + Appium 通道）。
    # 撤除后做得比原来更强：两种稀有度都由 localStorage 钩子 `__e2e_force_rarity` 钉死
    # （生产代码没有任何入口写这个 key，行为与不加钩子一致）—— 隐藏款不再靠 15% 的运气
    # 被覆盖，而**恰恰是因为撞不到，当初才漏掉了这个缺陷**。
    print("\n== H1: toast 撤销 ==", flush=True)

    def h1_toast_undo(rarity, text):
        """完成待办 → 断言 toast 上有「撤销」→ 点它 → 断言真的恢复未完成。"""
        label = f"H1[{rarity}]"
        page.evaluate("(r) => localStorage.setItem('__e2e_force_rarity', r)", rarity)

        print(f"  2a. 添加测试待办（{rarity}）==", flush=True)
        check(f"{label} 测试待办已添加", add_todo(page, text))
        wait_add_settled(page, text)

        print(f"  3a. 点击完成（{rarity}）==", flush=True)
        card = page.locator('.todo', has_text=text).first
        card.locator('.todo__check').click()

        # 等条件而不是裸 wait_for_selector：裸等待超时会以 TimeoutError **中止整个脚本**，
        # 后面用例的结果全部丢失（只剩一个 traceback，现场也留不下来）。
        # 超时给 15s：隐藏款在点击前还可能有开奖/解锁提示在排队，串行展示会把它推到后面。
        toast_ok = wait_until(
            page,
            lambda: page.locator('.toast__action').count() > 0,
            timeout_ms=15000,
            desc=f"{label} 完成后出现带撤销按钮的 toast",
        )
        if toast_ok:
            toast_text = page.locator('.toast').inner_text()
            check(f"{label} 完成toast包含撤销按钮", '撤销' in toast_text, f"toast内容: {toast_text}")
        else:
            dump_dom_state(page, errors, tag=f"{label} 无撤销 toast")
            check(f"{label} 完成toast包含撤销按钮", False, "未出现撤销按钮（现场见上）")

        print(f"  4a. 点击撤销（{rarity}）==", flush=True)
        page.locator('.toast__action').first.click()

        print(f"  5a. 验证恢复未完成（{rarity}）==", flush=True)
        # 等状态成立，而不是「睡 2 秒再读 class」——后者在慢机器上读到的还是旧状态。
        # 超时给 15s（不是 10s）：撤销是一次网络往返，冷启动的 CI 上留足余量。
        restored = wait_until(
            page,
            lambda: 'todo--done' not in (
                page.locator('.todo', has_text=text).first.get_attribute('class') or ''
            ),
            timeout_ms=15000,
            desc=f"{label} 撤销后待办恢复未完成",
        )
        after = page.locator('.todo', has_text=text).first
        check(f"{label} 撤销后待办恢复未完成", restored, f"class: {after.get_attribute('class')}")

        print(f"  6a. 清理本条数据（{rarity}）==", flush=True)
        after.click(button='right')
        page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
        page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
        page.wait_for_timeout(1000)

    h1_toast_undo('common', 'E2E-测试-完成撤销-toast撤销-普通款')
    # legendary 是当初暴露该缺陷的那一档（稀有度 toast 文案与配色最重，顶掉撤销按钮最明显）
    h1_toast_undo('legendary', 'E2E-测试-完成撤销-toast撤销-隐藏款')
    # 钩子用完即清：别让它影响后续用例（H2 也会完成待办，虽不关心稀有度）
    page.evaluate("() => localStorage.removeItem('__e2e_force_rarity')")

    # ===== H2: 长按菜单撤销 =====
    print("\n== H2: 长按菜单撤销 ==", flush=True)

    print("  2b. 添加测试待办 ==", flush=True)
    check("H2 测试待办已添加", add_todo(page, test_text_h2))
    wait_add_settled(page, test_text_h2)

    print("  3b. 点击完成 ==", flush=True)
    todo_card2 = page.locator('.todo', has_text=test_text_h2).first
    todo_card2.locator('.todo__check').click()
    # 等撤销 toast 收起（5 秒撤销窗口过去）再开菜单，否则菜单会被 toast 的层级/状态干扰
    wait_toast_gone(page)

    print("  4b. 长按打开菜单 ==", flush=True)
    todo_card2.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="撤销完成"]', timeout=5000)
    check("H2 菜单包含撤销完成按钮", page.locator('.action-sheet__icon-btn[aria-label="撤销完成"]').count() >= 1)

    print("  5b. 点击撤销完成 ==", flush=True)
    page.locator('.action-sheet__icon-btn[aria-label="撤销完成"]').click()

    print("  6b. 验证恢复未完成 ==", flush=True)
    restored2 = wait_until(
        page,
        lambda: 'todo--done' not in (
            page.locator('.todo', has_text=test_text_h2).first.get_attribute('class') or ''
        ),
        timeout_ms=15000,
        desc="H2 撤销后待办恢复未完成",
    )
    todo_after2 = page.locator('.todo', has_text=test_text_h2).first
    check("H2 撤销后待办恢复未完成", restored2, f"class: {todo_after2.get_attribute('class')}")

    # 清理 H2 测试数据
    todo_after2.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
    check("H2 测试待办已清理", wait_until(
        page,
        lambda: page.locator('.todo', has_text=test_text_h2).count() == 0,
        desc="H2 待办从主列表移除",
    ))

    # UI 删除是软删除，行仍在表里；统一硬删一次（自带生产库硬闸）
    cleanup_test_data()

    # 汇总
    print(f"\n== 结果: {results['pass']} 通过 / {results['fail']} 失败 ==", flush=True)
    if errors:
        print(f"\n控制台错误 ({len(errors)}):", flush=True)
        for e in errors[:10]:
            print(f"  {e}", flush=True)

    browser.close()
    sys.exit(1 if results["fail"] > 0 else 0)
