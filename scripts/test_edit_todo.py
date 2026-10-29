"""
编辑待办（改文案）E2E 测试 —— 2026-10-29 事故的回归防线

为什么必须存在（这个 bug 在线上跑了 6 天没人发现）：
    F-04（完成备注升级为留言板）重构时删掉了旧「完成备注」面板和它的 closeNotePanel()，
    但同一文件里的「编辑待办」面板仍在调用它 → 点「保存」抛
    `ReferenceError: closeNotePanel is not defined`。
    致命之处在于**抛出点在 try 之外**：db.updateTodoText 根本没执行，
    而页面因为乐观更新仍显示新文案 —— 刷新才回退。
    于是：① 没有任何报错提示 ② 肉眼一看「像是改了」 ③ 刷新就丢 = 「无法保存」。

    而在此之前，「编辑待办」这个核心功能**一条自动化测试都没有**（app-e2e 里搜不到
    「编辑待办」）。没有测试的功能 = 没有护栏的功能。

本用例钉住四件事：
    1. 保存后**真的落库**（刷新页面后新文案仍在）—— 这条才是核心断言；
       只断言「列表变了」会被乐观更新骗过去（正是原 bug 的伪装形态）。
    2. 面板关闭 + toast「已保存」。
    3. 空文案被拒绝（提示「内容不能为空」）。
    4. 全程零 pageerror —— 同类 ReferenceError 一律当场红。

跑法（铁律二：必须连测试库）：
    node scripts/serve-test.mjs          # :3100 独立测试库
    python3 scripts/test_edit_todo.py    # 本文件自动连 3100 + 自证隔离
"""
import os
import sys
import time

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
    wait_until,
)

BASE = resolve_base()
TEST_USER, TEST_PASSWORD = load_test_creds()
errors = []
check, results = make_checker()

OLD_TEXT = "E2E-测试-编辑前文案"
NEW_TEXT = "E2E-测试-编辑后文案"


def open_edit_panel(page, text):
    """右键（或长按）打开操作菜单 → 点「编辑」，等编辑面板就位。"""
    page.locator(".todo", has_text=text).first.click(button="right")
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="编辑"]', timeout=8000)
    page.locator('.action-sheet__icon-btn[aria-label="编辑"]').click()
    page.wait_for_selector(".note-input-panel__textarea", timeout=8000)


with sync_playwright() as p:
    # 先归零测试库：保证「页面上只有我造的这一条」。
    # 单跑本文件时（不经 run-web-e2e.mjs）库里可能有上一轮的残留 —— 那会让
    # 「刷新后旧文案已消失」这类断言在**别的用例的残留**上失败，报告指向错误的方向。
    cleanup_test_data()

    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_default_timeout(15000)
    page.on("console", lambda m: errors.append(f"[console.{m.type}] {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

    print("== 1. 登录 ==", flush=True)
    check("登录成功进入主页", login(page, BASE, TEST_USER, TEST_PASSWORD), page.url)

    print("== 2. 添加待办 ==", flush=True)
    check("测试待办已添加", add_todo(page, OLD_TEXT))
    wait_add_settled(page, OLD_TEXT)

    print("== 3. 打开编辑面板 ==", flush=True)
    open_edit_panel(page, OLD_TEXT)
    check("编辑面板已打开", page.locator(".note-input-panel__textarea").count() == 1)
    check(
        "编辑面板预填原文案",
        page.locator(".note-input-panel__textarea").input_value() == OLD_TEXT,
        page.locator(".note-input-panel__textarea").input_value(),
    )

    print("== 4. 空文案应被拒绝 ==", flush=True)
    page.locator(".note-input-panel__textarea").fill("   ")
    page.locator(".note-input-panel__save").click()
    time.sleep(0.6)
    check("空文案提示「内容不能为空」", "内容不能为空" in page.locator("#toast").inner_text())
    check("空文案时面板不关闭", page.locator(".note-input-overlay").count() == 1)

    print("== 5. 改文案并保存 ==", flush=True)
    page.locator(".note-input-panel__textarea").fill(NEW_TEXT)
    page.locator(".note-input-panel__save").click()
    # 落库是异步的（面板先关、DB 后写），**必须等 toast 出现**再判成功：
    # 立刻读 toast 会读到上一条 toast（空文案提示），把「还没写完」误判成「没保存」。
    check(
        "出现「已保存」提示",
        wait_until(
            page,
            lambda: "已保存" in page.locator("#toast").inner_text(),
            timeout_ms=15000,
            desc="保存成功 toast",
        ),
        page.locator("#toast").inner_text(),
    )
    check(
        "保存后面板关闭",
        wait_until(
            page,
            lambda: page.locator(".note-input-overlay").count() == 0,
            timeout_ms=5000,
            desc="编辑面板关闭",
        ),
    )

    print("== 6. 核心断言：刷新后仍在 = 真的落库 ==", flush=True)
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("body[data-app-ready='1']", timeout=20000)
    time.sleep(1.5)
    check(
        "刷新后新文案仍在（已落库）",
        page.locator(".todo", has_text=NEW_TEXT).count() >= 1,
        "乐观更新会骗过「列表变了」这条断言 —— 必须刷新后验",
    )
    check(
        "刷新后旧文案已消失",
        page.locator(".todo", has_text=OLD_TEXT).count() == 0,
    )

    print("== 7. ESC 可关闭面板 ==", flush=True)
    # 上一步没落库时新文案不存在 —— 此时再去找它会抛 Playwright 超时，
    # 报告就会变成一堆栈而不是「哪条断言红了」。这里显式判一次再决定要不要继续。
    if page.locator(".todo", has_text=NEW_TEXT).count() == 0:
        check("ESC 关闭编辑面板（前置：落库失败，跳过）", False, "新文案不在列表里，后续步骤无法执行")
    else:
        open_edit_panel(page, NEW_TEXT)
        page.keyboard.press("Escape")
        check(
            "ESC 关闭编辑面板",
            wait_until(
                page,
                lambda: page.locator(".note-input-overlay").count() == 0,
                timeout_ms=5000,
                desc="ESC 关闭编辑面板",
            ),
    )
        # 监听器泄漏回归：编辑面板关掉后，残留的 ESC 监听器会在下次按键时误伤别的面板。
        # 这里再打开一次编辑面板走保存路径 —— 面板必须能被保存按钮正常关掉
        # （旧实现的监听器只在「自己触发 ESC」时摘，点保存关闭就会漏掉）。
        page.locator(".todo", has_text=NEW_TEXT).first.click(button="right")
        page.wait_for_selector('.action-sheet__icon-btn[aria-label="编辑"]', timeout=8000)
        page.locator('.action-sheet__icon-btn[aria-label="编辑"]').click()
        page.wait_for_selector(".note-input-panel__textarea", timeout=8000)
        page.locator(".note-input-panel__textarea").fill(NEW_TEXT + "-改2")
        page.locator(".note-input-panel__save").click()
        check(
            "二次编辑也成功保存",
            wait_until(
                page,
                lambda: "已保存" in page.locator("#toast").inner_text(),
                timeout_ms=15000,
                desc="二次保存 toast",
            ),
            page.locator("#toast").inner_text(),
        )
        check(
            "二次保存后面板关闭",
            wait_until(
                page,
                lambda: page.locator(".note-input-overlay").count() == 0,
                timeout_ms=5000,
                desc="二次保存关闭面板",
            ),
        )

    print("\n===== 页面错误（同类 ReferenceError 一律红）=====", flush=True)
    real_errors = [e for e in errors if "favicon" not in e.lower()]
    for e in real_errors:
        print("  " + e, flush=True)
    check("全程零页面错误", len(real_errors) == 0, f"{len(real_errors)} 条")

    page.screenshot(path="/tmp/e2e-edit-todo-final.png", full_page=True)
    browser.close()

cleanup_test_data()

print("\n===== 汇总 =====", flush=True)
print(f"通过 {results['pass']} / 失败 {results['fail']}", flush=True)
sys.exit(0 if results["fail"] == 0 else 1)
