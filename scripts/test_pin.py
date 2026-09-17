"""
置顶章节 E2E 测试（v2.7.72：置顶从「排序优先级」改成「页首独立章节」）

为什么这个文件必须存在（2026-09-17 补）：
置顶从上线到 v2.7.72 之间**一条测试都没有** —— 于是它在两次改版里静默失效而没人发现：
  · v2.7.68「纸与光」把卡片背景改成不透明纸质渐变后，`.todo--pinned` 的半透明覆盖成了
    页面上唯一没有纸面的卡（视觉语义反转）；
  · v2.7.70 时光章节上线后，分章会对章内重排（按完成时间），`sortTodos` 的置顶优先级被
    整条丢掉 —— 线上两条置顶（迪士尼计划 / 拉臭恐惧消除计划）实际"置顶了却纹丝不动"。
两次都是"点了没反应/看着不对"，但没有任何自动化能发现。本文件把新契约钉住：
置顶项搬到页首「置顶」章、只出现一次、章头小计记"账"并点出差额、名下条目全被置顶时不留空章。

跑法（铁律二：必须连测试库）：
    node scripts/serve-test.mjs          # :3100 独立测试库
    python3 scripts/test_pin.py          # 本文件自动连 3100 + 自证隔离

⚠️ **同一测试库上不要并发跑两个 E2E**（2026-09-17 实测踩到）：本文件有几处断言依赖
"页面上只有我造的这两条"（例如"某天唯一一条被置顶后该天章头消失"）。另一个用例同时在同一
测试库造数据时，页面会多出别人的卡片，这些断言会失败 —— 而报告看起来像布局 bug，实际是
测试环境串台。走 `run-web-e2e.mjs` 时它是**逐个串行**且在每例前归零，不存在这个问题；
手工单跑时请确认没有别的用例在跑。
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

# 页内探针：读章节结构。用 evaluate 而不是散落的 locator 断言 —— 判断"某条待办属于哪个章"
# 必须看**兄弟顺序**（章节头与卡片是 #todoList 的平级子节点），CSS 选择器表达不了这层关系。
JS_CHAPTERS = """() => [...document.querySelectorAll('#todoList > .tl-chap')].map((el) => ({
  key: el.dataset.chapKey,
  label: (el.querySelector('.tl-chap__label') || {}).textContent || '',
  sum: (el.querySelector('.tl-chap__sum') || {}).textContent || '',
  isPinned: el.classList.contains('tl-chap--pinned'),
}))"""

JS_CHAPTER_OF = """(text) => {
  let cur = null;
  for (const el of document.getElementById('todoList').children) {
    if (el.classList.contains('tl-chap')) cur = el.dataset.chapKey;
    else if (el.classList.contains('todo') && el.textContent.includes(text))
      return { key: cur, isPinned: !!(el.className || '').includes('todo--pinned') };
  }
  return null;
}"""

JS_CARD_COUNT = """(text) =>
  [...document.querySelectorAll('#todoList > .todo')].filter((el) => el.textContent.includes(text)).length"""


def chapters(page):
    return page.evaluate(JS_CHAPTERS)


def chapter_of(page, text):
    return page.evaluate(JS_CHAPTER_OF, text)


def card_count(page, text):
    return page.evaluate(JS_CARD_COUNT, text)


def keys(page):
    return [c["key"] for c in chapters(page)]


def pinned_chapter(page):
    return next((c for c in chapters(page) if c["isPinned"]), None)


def day_chapter(page):
    return next((c for c in chapters(page) if c["key"].startswith("day:")), None)


def pin(page, text):
    """右键该卡片 → 菜单 → 置顶/取消置顶（按钮文案由 todo.pinned 决定）"""
    page.locator(".todo", has_text=text).first.click(button="right")
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="置顶"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="置顶"]').click()


def unpin(page, text):
    page.locator(".todo", has_text=text).first.click(button="right")
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="取消置顶"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="取消置顶"]').click()


A = "E2E-测试-置顶甲"
B = "E2E-测试-置顶乙"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_default_timeout(15000)
    page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

    print("== 1. 登录 ==", flush=True)
    check("登录成功进入主页", login(page, BASE, TEST_USER, TEST_PASSWORD), page.url)

    print("== 2. 添加两条并都完成（构出「今天章有 2 件」）==", flush=True)
    check("甲已添加", add_todo(page, A))
    wait_add_settled(page, A)
    check("乙已添加", add_todo(page, B))
    wait_add_settled(page, B)
    for t in (A, B):
        page.locator(".todo", has_text=t).first.locator(".todo__check").click()
    wait_toast_gone(page)  # 完成后的撤销 toast 会挡住紧接着的右键
    check("两条都落在「今天」章", wait_until(
        page,
        lambda: chapter_of(page, A) and chapter_of(page, A)["key"] == chapter_of(page, B)["key"]
        and (chapter_of(page, A)["key"] or "").startswith("day:"),
        desc="两条完成项归入同一个 day: 章",
    ))
    check("今天章小计 = 已完成 2 件", (day_chapter(page) or {}).get("sum") == "已完成 2 件",
          f"实际 {(day_chapter(page) or {}).get('sum')!r}")
    check("此时没有置顶章（无置顶项 ⇒ 整章不渲染）", pinned_chapter(page) is None)

    print("== 3. 置顶「甲」⇒ 搬到页首「置顶」章 ==", flush=True)
    pin(page, A)
    check("页首出现带图钉的「置顶」章", wait_until(
        page, lambda: (pinned_chapter(page) or {}).get("key") == "__pinned__", desc="置顶章出现",
    ))
    pc = pinned_chapter(page) or {}
    check("置顶章在列表最前（页首）", (keys(page) or [None])[0] == "__pinned__", f"实际章的次序 {keys(page)}")
    check("置顶章文案 = 「置顶 · 1」", (pc.get("label"), pc.get("sum")) == ("置顶", "· 1"),
          f"实际 {(pc.get('label'), pc.get('sum'))!r}")
    check("甲落在置顶章内", (chapter_of(page, A) or {}).get("key") == "__pinned__",
          f"实际 {(chapter_of(page, A) or {}).get('key')!r}")
    check("甲只出现一次（不在时光章里重复出现）", card_count(page, A) == 1, f"实际 {card_count(page, A)} 次")
    check("乙仍在今天章", (chapter_of(page, B) or {}).get("key", "").startswith("day:"),
          f"实际 {(chapter_of(page, B) or {}).get('key')!r}")
    check("今天章小计仍记那天的账，并把差额点出来",
          (day_chapter(page) or {}).get("sum") == "已完成 2 件（1 件在置顶）",
          f"实际 {(day_chapter(page) or {}).get('sum')!r}")
    page.screenshot(path="/tmp/pin-e2e-pinned.png", full_page=True)

    print("== 4. 冷启动（持久化 + 冷启动渲染）==", flush=True)
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("body[data-app-ready='1']", timeout=30000)
    check("冷启动后置顶章仍在页首", wait_until(
        page, lambda: (keys(page) or [None])[0] == "__pinned__", desc="冷启动后置顶章仍在最前",
    ))
    check("冷启动后甲仍在置顶章内", (chapter_of(page, A) or {}).get("key") == "__pinned__",
          f"实际 {(chapter_of(page, A) or {}).get('key')!r}")

    print("== 5. 取消置顶 ⇒ 卡片回原位、章消失 ==", flush=True)
    unpin(page, A)
    check("取消置顶后置顶章消失", wait_until(
        page, lambda: pinned_chapter(page) is None, desc="无置顶项时置顶章不再渲染",
    ))
    check("甲回到今天章", (chapter_of(page, A) or {}).get("key", "").startswith("day:"),
          f"实际 {(chapter_of(page, A) or {}).get('key')!r}")
    check("今天章小计回到「已完成 2 件」（差额提示随之消失）",
          (day_chapter(page) or {}).get("sum") == "已完成 2 件",
          f"实际 {(day_chapter(page) or {}).get('sum')!r}")

    print("== 6. 名下条目全被置顶 ⇒ 不留空章头 ==", flush=True)
    page.locator(".todo", has_text=B).first.click(button="right")
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="删除"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="删除"]').click()
    wait_toast_gone(page)
    check("乙已离开主列表（今天章只剩甲）", wait_until(
        page, lambda: card_count(page, B) == 0, desc="乙从主列表消失",
    ))
    pin(page, A)
    check("唯一一条被置顶后，该天章头不再渲染（不留只有标签的空章）", wait_until(
        page,
        lambda: not any(k.startswith("day:") for k in keys(page)),
        desc="day: 章头消失",
    ))
    check("此时页面上只剩置顶章", keys(page) == ["__pinned__"], f"实际 {keys(page)}")

    print("== 7. 取消置顶 ⇒ 该天章头回来 ==", flush=True)
    unpin(page, A)
    check("取消置顶后 day: 章头恢复，甲回到其中", wait_until(
        page,
        lambda: (chapter_of(page, A) or {}).get("key", "").startswith("day:"),
        desc="day: 章头恢复且甲在其内",
    ))

    print("== 8. 对端设备（Realtime 双账号）==", flush=True)
    # 为什么要这一节：置顶的写入方是本端，但「卡片搬到页首」必须**对方端也照着变** ——
    # 两个人共用一个列表，一端置顶而另一端看不到，就等于这功能只对一半人有效。
    # 前面的步骤都只在本端往返（含冷启动），碰不到 Realtime 这条链。
    context2 = browser.new_context()
    page2 = context2.new_page()
    page2.set_default_timeout(15000)
    second_user = os.environ.get("E2E_SECOND_ACCOUNT", "e2e-beta")
    check("第二账号登录成功", login(page2, BASE, second_user, TEST_PASSWORD), page2.url)
    # 等 Realtime 订阅真正开始推送：本项目已记录「订阅变 SUBSCRIBED 后仍需 ~2-3 秒」，
    # 这里等的是一个观察窗口（被测对象的已知时序），不是拿固定毫秒去赌某个异步过程。
    page2.wait_for_timeout(4000)
    check("对端此时没有置顶章（基线：本端已取消置顶）", (page2.evaluate(JS_CHAPTERS) or [None])[0] is not None
          and not any(c["isPinned"] for c in page2.evaluate(JS_CHAPTERS)),
          f"对端章节 {page2.evaluate(JS_CHAPTERS)}")

    pin(page, A)  # 本端置顶
    check("对端**不刷新**就看到置顶章出现（Realtime）", wait_until(
        page2,
        lambda: (page2.evaluate(JS_CHAPTERS) or [None])[0].get("isPinned"),
        desc="对端出现置顶章",
    ))
    check("对端置顶章内就是甲", wait_until(
        page2,
        lambda: (page2.evaluate(JS_CHAPTER_OF, A) or {}).get("key") == "__pinned__",
        desc="对端甲落在置顶章内",
    ))

    unpin(page2, A)  # 对端取消置顶 → 反方向也要同步
    check("本端**不刷新**看到置顶章消失（反方向 Realtime）", wait_until(
        page,
        lambda: pinned_chapter(page) is None,
        desc="本端置顶章消失",
    ))

    print("== 9. 页面报错检查 ==", flush=True)
    real = [e for e in errors if "Failed to fetch" not in e and "net::" not in e and "favicon" not in e]
    check("无模块级报错", len(real) == 0, f"错误数 {len(real)}")
    for e in real[:5]:
        print(f"    {e}", flush=True)

    cleanup_test_data()
    browser.close()

print("=" * 40, flush=True)
print(f"通过: {results['pass']}  失败: {results['fail']}", flush=True)
sys.exit(0 if results["fail"] == 0 else 1)
