"""
心里话 · 珍藏仪式 v2 E2E 测试（2026-10 动画重设计）

覆盖（对应动画升级清单 P0 + P1）：
  1. 发送路径两段收点（P1-8）：回响出现 → 弹窗先关 → 顶栏桃心接收跳动**在弹窗消失后**触发
  2. 铃铛首亮（P1-10）：hidden→show 含 note-bell--arrive 入场 class
  3. 充能可见（P0#5）：长按中途抽样逐字点亮（.note-read__char--lit）
  4. 珍藏仪式两段收点（P0#1）：note-read--ceremony 暗场 → 印章桃心 note-read__seal--receive
     （第一收点，弹窗内可见）→ 弹窗淡出 → 顶栏 topbar__heart--receive（第二收点，弹窗已隐）
  5. 阅后即焚：仪式结束后留言真的从库里焚毁（B 重载后铃铛熄灭）
  6. 多条翻页（P1-12 实测点）：「下一条」点按翻页，逐条即焚直到铃铛熄灭
  7. reduced-motion 降级：无动画也要完成仪式 + 焚毁（不卡死、不留数据）

测试遵循 AGENTS.md 铁律一：跑独立测试库（scripts/serve-test.mjs + e2e_common 隔离校验），
数据带 E2E-测试- 前缀，收尾 reset-test-db.mjs 归零（含 daily_notes）。
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
    login,
    wait_until,
)

BASE = resolve_base()
TEST_USER, TEST_PASSWORD = load_test_creds()
SECOND_USER = os.environ.get("E2E_SECOND_ACCOUNT", "e2e-beta")
errors = []
check, results = make_checker()

# 事件顺序探针：记录弹窗 hidden 与桃心 receive 出现的相对时刻（与时序解耦的顺序断言用）
ORDER_PROBE = """() => {
  window.__order = {modalHidden: null, heartAdd: null};
  const t0 = performance.now();
  const h = document.getElementById('anniHeart');
  const m = document.getElementById('noteModal');
  new MutationObserver(() => {
    if (m.hidden && window.__order.modalHidden === null) window.__order.modalHidden = Math.round(performance.now() - t0);
  }).observe(m, {attributes: true, attributeFilter: ['hidden']});
  new MutationObserver(() => {
    if (h.className.includes('topbar__heart--receive') && window.__order.heartAdd === null) {
      window.__order.heartAdd = Math.round(performance.now() - t0);
    }
  }).observe(h, {attributes: true});
}"""

NOTE_SEND = "E2E-测试-心里话-发送收点"
NOTE_FLIP_A = "E2E-测试-心里话-翻页甲"
NOTE_FLIP_B = "E2E-测试-心里话-翻页乙"
NOTE_RM = "E2E-测试-心里话-降级"


def watch(page, tag):
    page.on("console", lambda m: errors.append(f"[{tag}][{m.type}] {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"[{tag}][pageerror] {e}"))


def send_note(page, text, wait_closed=True):
    """A 端经 UI 发一条心里话（纪念日面板 → 写信 → 悄悄送达）。

    wait_closed=False 时立即返回（供第 1 节观察回响/按钮中间态）；
    默认 True 等本次发送闭环 —— 连发多条时不等会互踩（弹窗未关时下一次点击被遮挡）。
    """
    page.click("#anniHeart")
    page.wait_for_selector("#writeNoteBtn", state="visible", timeout=8000)
    page.click("#writeNoteBtn")
    page.wait_for_selector("#noteInput", state="visible", timeout=8000)
    page.fill("#noteInput", text)
    page.click("#noteSend")
    if wait_closed:
        page.wait_for_selector("#noteModal", state="hidden", timeout=8000)


def long_press_cherish(page, hold_ms=700, sample_lit=True):
    """在「长按珍藏」按钮上真实长按；可抽样中途的逐字点亮。返回抽样结果。"""
    box = page.locator("#noteDismiss").bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    lit_mid = 0
    if sample_lit:
        page.wait_for_timeout(min(300, hold_ms // 2))
        lit_mid = page.locator(".note-read__char--lit").count()
    page.wait_for_timeout(max(0, hold_ms - (300 if sample_lit else 0)))
    page.mouse.up()
    return lit_mid


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx_a = browser.new_context(viewport={"width": 390, "height": 844})
    ctx_b = browser.new_context(viewport={"width": 390, "height": 844})
    a = ctx_a.new_page()
    b = ctx_b.new_page()
    a.set_default_timeout(15000)
    b.set_default_timeout(15000)
    watch(a, "A")
    watch(b, "B")

    print("\n" + "=" * 60)
    print("1. 发送路径：两段收点（弹窗先关，顶栏接收随后可见）")
    print("=" * 60)
    check("A 登录成功", login(a, BASE, TEST_USER, TEST_PASSWORD), a.url)
    # 事件顺序探针：P1-8 的语义是「弹窗先关、接收后至」（接收动作必须可见）。
    # 不用绝对时序断言 —— Playwright click 的 actionability 会把整个时间轴推后数百 ms，
    # 绝对窗口断言因此 flaky；顺序语义与时序解耦才是稳的。
    a.evaluate(ORDER_PROBE)
    send_note(a, NOTE_SEND, wait_closed=False)
    check("回响文案出现", wait_until(a, lambda: not a.locator("#noteEcho").is_hidden(), 6000, "回响"))
    check("按钮化作光点（gone class）",
          wait_until(a, lambda: "note-write__send--gone" in (a.locator("#noteSend").get_attribute("class") or ""), 6000, "按钮消失"))
    a.wait_for_timeout(1200)  # 让飞行与接收落定（不依赖 click 的绝对时刻）
    seq = a.evaluate("() => window.__order")
    check("发送收点顺序正确：弹窗先关、桃心接收后至（接收可见）",
          seq.get("modalHidden") is not None and seq.get("heartAdd") is not None
          and seq["modalHidden"] < seq["heartAdd"], f"轨迹: {seq}")

    print("\n" + "=" * 60)
    print("2. 铃铛首亮（B 端 Realtime 收到）+ 阅读态")
    print("=" * 60)
    check("B 登录成功", login(b, BASE, SECOND_USER, TEST_PASSWORD), b.url)
    # Realtime 双端同步：不刷新页面，等铃铛自己亮（订阅惯性 2-3s，给 15s 窗口）
    check("铃铛经 Realtime 首亮",
          wait_until(b, lambda: b.locator("#noteBell").is_visible(), 15000, "铃铛出现"))
    check("铃铛含入场动画 class（P1-10）",
          wait_until(b, lambda: "note-bell--arrive" in (b.locator("#noteBell").get_attribute("class") or ""), 3000, "铃铛入场"))
    b.click("#noteBell")
    check("阅读态打开", wait_until(b, lambda: b.locator("#noteRead").is_visible(), 5000, "阅读态"))
    content = b.locator("#noteContent").inner_text()
    check("留言内容正确", NOTE_SEND in content, f"实际: {content[:30]}")
    check("单条按钮文案为「长按珍藏」", b.locator(".note-read__dismiss-text").inner_text() == "长按珍藏")

    print("\n" + "=" * 60)
    print("3. 充能 + 珍藏仪式 v2：两段收点 + 阅后即焚")
    print("=" * 60)
    lit_mid = long_press_cherish(b, hold_ms=700)
    check("长按中途逐字点亮（充能感，P0#5）", lit_mid > 0, f"点亮字数 {lit_mid}")
    check("仪式暗场开启（note-read--ceremony）",
          wait_until(b, lambda: "note-read--ceremony" in (b.locator("#noteRead").get_attribute("class") or ""), 3000, "暗场"))
    # 收点必须「弹窗仍在」才可见：曾有 bug 被长按抬起的 click 穿透遮罩误关弹窗（2026-10-03），
    # 单看 class 会假绿 —— 必须连弹窗可见性一起断言
    check("第一收点：印章桃心接收（且弹窗仍在，收点可见）",
          wait_until(b, lambda: b.locator(".note-read__seal--receive").count() > 0 and b.locator("#noteModal").is_visible(),
                     6000, "印章接收"))
    check("弹窗在仪式尾段淡出（onModalFade）",
          wait_until(b, lambda: b.locator("#noteModal").is_hidden(), 8000, "弹窗关闭"))
    check("第二收点：顶栏桃心接收（弹窗已隐，全程可见）",
          wait_until(b, lambda: "topbar__heart--receive" in (b.locator("#anniHeart").get_attribute("class") or ""), 4000, "顶栏接收"))
    # 阅后即焚：重载后铃铛应熄灭（库里那条已删）
    b.wait_for_timeout(3000)  # 等 done 里焚毁链（markNoteRead → deleteNote）落定（reload 会掐断在途 fetch）
    b.reload(wait_until="domcontentloaded")
    b.wait_for_selector("body[data-app-ready='1']", timeout=20000)
    check("阅后即焚：重载后铃铛熄灭（留言已从库中焚毁）",
          wait_until(b, lambda: b.locator("#noteBell").is_hidden(), 8000, "铃铛熄灭"))

    print("\n" + "=" * 60)
    print("4. 多条翻页：逐条即焚（P1-12 实测点）")
    print("=" * 60)
    send_note(a, NOTE_FLIP_A)
    send_note(a, NOTE_FLIP_B)
    check("B 铃铛再次亮起（Realtime）",
          wait_until(b, lambda: b.locator("#noteBell").is_visible(), 15000, "铃铛出现"))
    b.click("#noteBell")
    check("多条时按钮文案为「下一条」",
          wait_until(b, lambda: b.locator(".note-read__dismiss-text").inner_text() == "下一条", 5000, "下一条文案"))
    first_content = b.locator("#noteContent").inner_text()
    b.click("#noteDismiss")
    check("点按翻页到第二条（内容变化，非同条）",
          wait_until(b, lambda: b.locator("#noteContent").inner_text() != first_content, 5000, "翻页"))
    second_content = b.locator("#noteContent").inner_text()
    check("第二条内容正确", NOTE_FLIP_A in second_content or NOTE_FLIP_B in second_content, f"实际: {second_content[:30]}")
    long_press_cherish(b, hold_ms=700, sample_lit=False)
    check("最后一条仪式完成（弹窗关闭）",
          wait_until(b, lambda: b.locator("#noteModal").is_hidden(), 10000, "弹窗关闭"))
    b.wait_for_timeout(3000)
    b.reload(wait_until="domcontentloaded")
    b.wait_for_selector("body[data-app-ready='1']", timeout=20000)
    check("两条均焚毁：铃铛熄灭",
          wait_until(b, lambda: b.locator("#noteBell").is_hidden(), 8000, "铃铛熄灭"))

    print("\n" + "=" * 60)
    print("5. reduced-motion 降级：无动画也要完成 + 焚毁")
    print("=" * 60)
    ctx_rm = browser.new_context(viewport={"width": 390, "height": 844}, reduced_motion="reduce")
    b2 = ctx_rm.new_page()
    b2.set_default_timeout(15000)
    watch(b2, "B2")
    send_note(a, NOTE_RM)
    check("降级端登录成功", login(b2, BASE, SECOND_USER, TEST_PASSWORD), b2.url)
    check("降级端铃铛亮起",
          wait_until(b2, lambda: b2.locator("#noteBell").is_visible(), 15000, "铃铛出现"))
    b2.click("#noteBell")
    check("降级端阅读态打开",
          wait_until(b2, lambda: b2.locator("#noteRead").is_visible(), 5000, "阅读态"))
    long_press_cherish(b2, hold_ms=700, sample_lit=False)
    # 降级路径应立即收尾（textToHeart 直接 done），不进 5s 仪式
    check("降级路径立即关闭弹窗（不等 5s 仪式）",
          wait_until(b2, lambda: b2.locator("#noteModal").is_hidden(), 8000, "弹窗关闭"))
    b2.wait_for_timeout(3000)
    b2.reload(wait_until="domcontentloaded")
    b2.wait_for_selector("body[data-app-ready='1']", timeout=20000)
    check("降级路径照常焚毁",
          wait_until(b2, lambda: b2.locator("#noteBell").is_hidden(), 8000, "铃铛熄灭"))

    # 汇总
    print(f"\n== 结果: {results['pass']} 通过 / {results['fail']} 失败 ==", flush=True)
    if errors:
        print(f"\n控制台错误 ({len(errors)}):", flush=True)
        for e in errors[:10]:
            print(f"  {e}", flush=True)

    browser.close()

cleanup_test_data()
sys.exit(1 if results["fail"] > 0 else 0)
