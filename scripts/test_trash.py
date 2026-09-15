"""
回收站 + 删除撤销 E2E 测试（批1：H1 回收站 + H2 删除撤销）

测试遵循 AGENTS.md 铁律一：跑在独立测试库（scripts/serve-test.mjs + e2e_common 隔离校验）。
所有测试待办用 "E2E-测试-" 前缀，测后彻底清理。用 wait_for 精准等待，避免超时。
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

    test_text = 'E2E-测试-回收站验证'

    print("== 2. 添加测试待办 ==", flush=True)
    check("测试待办已添加", add_todo(page, test_text))
    wait_add_settled(page, test_text)  # 开奖 toast 会浮在列表底部，可能拦住紧接着的右键点击

    print("== 3. H2 删除→撤销 ==", flush=True)
    page.locator('.todo', has_text=test_text).first.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
    page.wait_for_selector('.toast__action', timeout=5000)
    check("删除后出现「撤销」按钮", True)
    page.locator('.toast__action').first.click()
    check("撤销后待办恢复", wait_until(
        page,
        lambda: page.locator('.todo', has_text=test_text).count() >= 1,
        desc="撤销后待办回到主列表",
    ))

    print("== 4. H1 删除→回收站可见 ==", flush=True)
    page.locator('.todo', has_text=test_text).first.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
    # 等 5 秒撤销窗口真的过去（原来写死 5000ms，靠固定毫秒数去对赌客户端定时器）
    wait_toast_gone(page)
    check("主列表已移除", wait_until(
        page,
        lambda: page.locator('.todo', has_text=test_text).count() == 0,
        desc="删除后待办离开主列表",
    ))

    page.locator('.topbar__avatar').click(button='right')
    page.wait_for_selector('.account-menu__item', timeout=5000)
    check("账号菜单出现「回收站」", page.locator('.account-menu__item', has_text='回收站').count() >= 1)
    page.locator('.account-menu__item', has_text='回收站').first.click()
    page.wait_for_selector('.trash-item', timeout=8000)
    check("回收站可见已删待办", page.locator('.trash-item', has_text=test_text).count() >= 1)

    print("== 5. H1 回收站恢复 ==", flush=True)
    page.locator('.trash-item', has_text=test_text).first.locator('.trash-item__btn--restore').click()
    wait_until(
        page,
        lambda: page.locator('.trash-item', has_text=test_text).count() == 0,
        desc="恢复后该行离开回收站",
    )
    page.locator('.trash-sheet__close').click()
    check("恢复后回到主列表", wait_until(
        page,
        lambda: page.locator('.todo', has_text=test_text).count() >= 1,
        desc="恢复后主列表出现该待办",
    ))

    print("== 6. H1 彻底删除（两段确认）==", flush=True)
    page.locator('.todo', has_text=test_text).first.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
    wait_toast_gone(page)
    page.locator('.topbar__avatar').click(button='right')
    page.wait_for_selector('.account-menu__item', timeout=5000)
    page.locator('.account-menu__item', has_text='回收站').first.click()
    page.wait_for_selector('.trash-item', timeout=8000)
    purge = page.locator('.trash-item', has_text=test_text).first.locator('.trash-item__btn--purge')
    purge.click()
    check("彻底删除需二次确认", wait_until(
        page,
        lambda: page.locator('.trash-item__btn--armed').count() >= 1,
        desc="第一段点击后出现待确认态",
    ))
    print(f"    [诊断] 二次点击前 purge 文本={page.locator('.trash-item', has_text=test_text).first.locator('.trash-item__btn--purge').text_content()}", flush=True)
    page.locator('.trash-item__btn--armed').first.click()
    # 超时给到 25s（默认 10s 不够）：物理删除是一次真实请求，测试库免费层冷启动时实测会挂住
    # 十几秒 —— 现场证据是按钮停在「删除中…」（截图 /tmp/e2e-timeout-彻底删除后回收站清空-*.png），
    # 那是环境延迟，不是删除逻辑出错（2026-09-16 观测到 1 次，随后 6 次连跑全过）。
    check("彻底删除后回收站清空", wait_until(
        page,
        lambda: page.locator('.trash-item', has_text=test_text).count() == 0,
        timeout_ms=25000,
        desc="彻底删除后回收站清空",
    ))
    if page.locator('.trash-item', has_text=test_text).count() > 0:
        page.screenshot(path="/tmp/trash-purge-fail.png", full_page=True)

    print("== 7. 页面报错检查 ==", flush=True)
    real = [e for e in errors if "Failed to fetch" not in e and "net::" not in e and "favicon" not in e]
    check("无模块级报错", len(real) == 0, f"错误数 {len(real)}")
    for e in real[:5]:
        print(f"    {e}", flush=True)

    # UI 删除/彻底删除后仍有行残留（软删除打时间戳），统一硬删一次
    cleanup_test_data()
    browser.close()

print("=" * 40, flush=True)
print(f"通过: {results['pass']}  失败: {results['fail']}", flush=True)
sys.exit(0 if results["fail"] == 0 else 1)
