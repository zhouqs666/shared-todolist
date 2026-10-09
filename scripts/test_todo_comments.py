"""
待办留言板 E2E 测试（F-04 升级：单条完成备注 → 双人平铺留言 + 回复，2026-10-09）

为什么这个文件必须存在：
本功能换掉了「完成备注」这条**有历史数据**的老路径（备注列保留、内容搬迁为第一条留言），
而它自己的关键行为全是"看着有、其实可能静默错"的类型：
  · 未读圆点（产品的唯一发现机制：情感事件不推系统通知）——错了没人会知道
  · 「只能动自己的」（RLS 硬保证，UI 只是第二层）——错了会改掉对方的话
  · 软删除（铁律九）与"被删父留言仍要能解析昵称"（回复前缀）
  · Realtime 双向同步（不刷新就看到对方的新留言）
所以把判据钉死在断言上，而不是靠手点一遍觉得没问题。

跑法（铁律二：必须连测试库）：
    node scripts/serve-test.mjs            # :3100 独立测试库
    node scripts/apply-sql.mjs supabase/migration-add-todo-comments.sql --project test --apply
    python3 scripts/test_todo_comments.py  # 本文件自动连 3100 + 自证隔离

⚠️ 未读语义（本用例有两条断言依赖它，别当成 bug 改掉）：
   升级后**首次**运行会把"每条待办现有的最大 created_at"播种为已读水位（历史留言不算未读，
   避免升级那一刻全体亮红点）。所以第二个浏览器上下文第一次登录时，早先那条留言**不该**有圆点；
   圆点必须在播种之后、对方再发新留言时出现 —— 这正是本用例第 4/6 步分别断言的两件事。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright

from e2e_common import(
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

# 页内探针：卡片上的留言徽标（气泡 + 条数 + 未读态）。
# 断言"徽标在不在、几条、有没有未读"，必须读 DOM 而不是靠 CSS 选择器拼 —— 三态耦合在一处。
JS_BADGE = """(text) => {
  const card = [...document.querySelectorAll('#todoList .todo')].find((el) => el.textContent.includes(text));
  if (!card) return null;
  const b = card.querySelector('.todo__comment-badge');
  if (!b) return { exists: false };
  return {
    exists: true,
    count: (b.querySelector('.todo__comment-badge-count') || {}).textContent || '',
    unread: b.classList.contains('todo__comment-badge--unread'),
    aria: b.getAttribute('aria-label') || '',
  };
}"""

# 页内探针：留言板弹层内容（每条的头像/昵称/内容/已编辑/操作按钮/爱心/是不是我的）
JS_SHEET = """() => {
  const s = document.querySelector('.comment-sheet');
  if (!s) return null;
  const rows = [...s.querySelectorAll('.comment-row')].map((r) => ({
    id: r.dataset.id,
    name: (r.querySelector('.comment-row__name') || {}).textContent || '',
    content: (r.querySelector('.comment-row__content') || {}).textContent || '',
    edited: !!r.querySelector('.comment-row__edited'),
    actions: [...r.querySelectorAll('.comment-row__action')].map((b) => b.textContent.trim()),
    mine: r.classList.contains('comment-row--mine'),
    likes: (r.querySelector('.comment-row__like-count') || {}).textContent || '',
    likeMine: !!(r.querySelector('.comment-row__like--mine')),
  }));
  return {
    subtitle: (s.querySelector('.comment-sheet__subtitle') || {}).textContent || '',
    divider: !!s.querySelector('.comment-sheet__divider'),
    empty: !!s.querySelector('.comment-sheet__empty'),
    hint: (s.querySelector('.comment-sheet__hint-text') || {}).textContent || '',
    sendLabel: (s.querySelector('.comment-sheet__send') || {}).textContent || '',
    rows,
  };
}"""


def badge(page, text):
    return page.evaluate(JS_BADGE, text)


def sheet(page):
    return page.evaluate(JS_SHEET)


def open_sheet_via_menu(page, text):
    """长按菜单 → 「留言」（aria-label 在有留言时是「留言 N 条」，用前缀匹配）"""
    page.locator(".todo", has_text=text).first.click(button="right")
    page.wait_for_selector('.action-sheet__icon-btn[aria-label^="留言"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label^="留言"]').click()
    page.wait_for_selector(".comment-sheet", timeout=5000)


def open_sheet_via_badge(page, text):
    page.locator(".todo", has_text=text).first.locator(".todo__comment-badge").click()
    page.wait_for_selector(".comment-sheet", timeout=5000)


def close_sheet(page):
    """关闭留言板（幂等：没开着就当无事发生，省得每个调用点都要先判断状态）"""
    if page.locator(".comment-sheet").count() == 0:
        return
    page.locator(".comment-sheet__close").click()
    # 等退场动画把节点摘掉再继续：否则下一次 querySelector('.comment-sheet')
    # 可能读到正在退场的旧弹层（数据是旧的 → 断言假红），也可能遮住卡片点击
    page.wait_for_selector(".comment-sheet", state="detached", timeout=5000)


def comment_row(page, text):
    return page.locator(".comment-row", has_text=text).first


def row_of(rows, text):
    """按内容取行（取不到返回 None）。断言里一律先判存在再判属性，
    否则 all()/any() 在空列表上会真空成立 —— 那种断言看着绿，其实什么都没验。"""
    return next((r for r in (rows or []) if text in r["content"]), None)


def send_comment(page, text):
    page.fill(".comment-sheet__input", text)
    page.locator(".comment-sheet__send").click()


def reply_to(page, target_text, reply_text):
    """点某条留言的「回复」→ 底部输入条进入回复态 → 发送"""
    comment_row(page, target_text).locator(".comment-row__action", has_text="回复").click()
    page.wait_for_selector(".comment-sheet__hint:not([hidden])", timeout=5000)
    page.fill(".comment-sheet__input", reply_text)
    page.locator(".comment-sheet__send").click()


TODO = "E2E-测试-留言-基础"
C1 = "第一条：记得买低脂的"
C2 = "第二条：别忘了"
REPLY = "收到啦"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_default_timeout(15000)
    page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

    print("== 1. 登录 + 造宿主待办 ==", flush=True)
    check("登录成功进入主页", login(page, BASE, TEST_USER, TEST_PASSWORD), page.url)
    check("待办已添加", add_todo(page, TODO))
    check("添加已完成（撤销 toast 退场）", wait_add_settled(page, TODO))
    b = badge(page, TODO)
    check("没有留言时卡片上**没有**任何留言痕迹（零侵入）", b and b.get("exists") is False, f"实际 {b}")

    print("== 2. 本端从长按菜单发第一条 ==", flush=True)
    open_sheet_via_menu(page, TODO)
    s = sheet(page)
    check("留言板打开且标题带待办文案", s and s.get("subtitle") == TODO, f"实际 {s and s.get('subtitle')!r}")
    check("空态文案在（还没有留言）", s and s.get("empty") is True, f"实际 {s}")
    send_comment(page, C1)
    check("本端立刻看到自己那条（乐观更新）", wait_until(
        page, lambda: any(r["content"] == C1 for r in (sheet(page) or {}).get("rows", [])),
        desc="留言出现在列表里",
    ))
    check("自己那条带「回复/编辑/删除」三个操作", wait_until(
        page,
        lambda: (lambda r: r is not None and all(a in r["actions"] for a in ("回复", "编辑", "删除")))(
            row_of((sheet(page) or {}).get("rows"), C1)
        ),
        desc="自己那条的操作按钮",
    ))
    check("自己那条没有回复前缀（主留言）", (row_of((sheet(page) or {}).get("rows"), C1) or {}).get("content") == C1)
    close_sheet(page)
    check("卡片出现气泡徽标：条数 1", wait_until(
        page, lambda: (badge(page, TODO) or {}).get("count") == "1",
        desc="徽标条数为 1",
    ))
    check("自己的留言不产生未读圆点", (badge(page, TODO) or {}).get("unread") is False, f"实际 {badge(page, TODO)}")

    print("== 3. 冷启动后留言仍在（持久化）==", flush=True)
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("body[data-app-ready='1']", timeout=30000)
    check("冷启动后徽标仍是 1 条", wait_until(
        page, lambda: (badge(page, TODO) or {}).get("count") == "1", desc="冷启动后徽标仍在",
    ))

    print("== 4. 对方端首登：能看到条数，但历史留言不算未读（播种语义）==", flush=True)
    context2 = browser.new_context()
    page2 = context2.new_page()
    page2.set_default_timeout(15000)
    page2.on("console", lambda m: errors.append(f"[p2/{m.type}] {m.text}") if m.type == "error" else None)
    page2.on("pageerror", lambda e: errors.append(f"[p2/pageerror] {e}"))
    second_user = os.environ.get("E2E_SECOND_ACCOUNT", "e2e-beta")
    check("第二账号登录成功", login(page2, BASE, second_user, TEST_PASSWORD), page2.url)
    page2.wait_for_timeout(4000)  # 等 Realtime 订阅真正开始推送（本项目已知 2-3s 惯性）
    check("对方端看到徽标 1 条", wait_until(
        page2, lambda: (badge(page2, TODO) or {}).get("count") == "1", desc="对方端徽标出现",
    ))
    check("首次运行播种：对方端**不**给升级前的历史留言亮未读", (badge(page2, TODO) or {}).get("unread") is False,
          f"实际 {badge(page2, TODO)}")
    open_sheet_via_badge(page2, TODO)
    check("对方端点徽标能看到本端那条留言（带昵称）", wait_until(
        page2,
        lambda: (lambda r: r is not None and bool(r["name"]))(row_of((sheet(page2) or {}).get("rows"), C1)),
        desc="对方端看到留言与作者",
    ))
    check("对方端看别人的留言没有编辑/删除按钮（只能动自己的）", wait_until(
        page2,
        lambda: (lambda r: r is not None and not any(a in ("编辑", "删除") for a in r["actions"]))(
            row_of((sheet(page2) or {}).get("rows"), C1)
        ),
        desc="别人的留言没有编辑/删除",
    ))
    close_sheet(page2)

    print("== 5. 本端再发一条 ⇒ 对方端不刷新亮未读 ==", flush=True)
    open_sheet_via_badge(page, TODO)
    send_comment(page, C2)
    check("本端条数变 2", wait_until(
        page, lambda: (badge(page, TODO) or {}).get("count") == "2", desc="本端徽标 2 条",
    ))
    # 关掉本端弹层再去验证对方的未读：弹层开着时，对方的新留言会被"即时已读"
    # （你正看着它出现）—— 这是设计行为，留在开着状态会验不到未读路径
    close_sheet(page)
    check("对方端**不刷新**出现未读圆点（Realtime + 产品唯一发现机制）", wait_until(
        page2, lambda: (badge(page2, TODO) or {}).get("unread") is True, desc="对方端未读圆点出现",
    ))
    check("对方端条数同步为 2", (badge(page2, TODO) or {}).get("count") == "2", f"实际 {badge(page2, TODO)}")

    print("== 6. 对方端打开 ⇒ 未读分隔线 + 定位 + 圆点消失 ==", flush=True)
    open_sheet_via_badge(page2, TODO)
    s2 = sheet(page2)
    check("出现「以下为新留言」分隔线", s2 and s2.get("divider") is True, f"实际 {s2 and s2.get('divider')}")
    check("新留言（第二条）在分隔线之后渲染", wait_until(
        page2, lambda: any(C2 in r["content"] for r in (sheet(page2) or {}).get("rows", [])),
        desc="对方端看到第二条",
    ))
    close_sheet(page2)
    check("看过之后未读圆点消失", wait_until(
        page2, lambda: (badge(page2, TODO) or {}).get("unread") is False, desc="对方端圆点消失",
    ))

    print("== 7. 对方端回复某一条（平铺 + 引用前缀）==", flush=True)
    open_sheet_via_badge(page2, TODO)
    reply_to(page2, C1, REPLY)
    check("回复以「回复 @昵称：」平铺显示", wait_until(
        page2,
        lambda: any(
            r["content"].startswith("回复 @") and "：" in r["content"] and REPLY in r["content"]
            for r in (sheet(page2) or {}).get("rows", [])
        ),
        desc="回复前缀渲染",
    ))
    close_sheet(page2)

    print("== 8. 本端不刷新：未读 + 条数同步 ==", flush=True)
    check("本端条数变 3（Realtime）", wait_until(
        page, lambda: (badge(page, TODO) or {}).get("count") == "3", desc="本端 3 条",
    ))
    check("本端出现未读圆点（对方的回复）", wait_until(
        page, lambda: (badge(page, TODO) or {}).get("unread") is True, desc="本端圆点出现",
    ))
    close_sheet(page)  # 本端第 5 步开着弹层，先关掉再重新打开看未读定位
    open_sheet_via_badge(page, TODO)
    check("本端打开看到未读分隔线 + 对方那条回复", wait_until(
        page,
        lambda: (sheet(page) or {}).get("divider") is True
        and any(REPLY in r["content"] for r in (sheet(page) or {}).get("rows", [])),
        desc="本端未读分隔线与回复",
    ))

    print("== 9. 编辑自己的留言（对端同步 + 已编辑标记）==", flush=True)
    # 对方端弹层必须**开着**才能验到「不刷新」：Realtime 把改动落进缓存后，
    # 开着的那份列表会当场重绘（关着的话只能证明"重新打开后能看到"）
    open_sheet_via_badge(page2, TODO)
    edited = "第一条：记得买低脂的（改）"
    comment_row(page, C1).locator(".comment-row__action", has_text="编辑").click()
    page.wait_for_selector('.comment-sheet__hint-text:text-is("编辑留言")', timeout=5000)
    check("输入条切到编辑态（提示条 + 按钮变「保存」）",
          (sheet(page) or {}).get("sendLabel") == "保存" and (sheet(page) or {}).get("hint") == "编辑留言",
          f"实际 {sheet(page) and (sheet(page).get('hint'), sheet(page).get('sendLabel'))}")
    page.fill(".comment-sheet__input", edited)
    page.locator(".comment-sheet__send").click()
    check("本端内容已改", wait_until(
        page, lambda: any(edited in r["content"] for r in (sheet(page) or {}).get("rows", [])),
        desc="本端看到新内容",
    ))
    check("带「已编辑」标记", wait_until(
        page,
        lambda: any(edited in r["content"] and r["edited"] for r in (sheet(page) or {}).get("rows", [])),
        desc="已编辑标记",
    ))
    check("对方端**不刷新**看到新内容 + 已编辑（Realtime UPDATE）", wait_until(
        page2,
        lambda: any(edited in r["content"] and r["edited"] for r in (sheet(page2) or {}).get("rows", [])),
        desc="对方端同步编辑",
    ))

    print("== 10. 贴爱心 / 取消（双向计数）==", flush=True)
    # 双方弹层都开着：对方端贴 → 本端不刷新就要看到计数变化
    comment_row(page2, C2).locator(".comment-row__like").click()
    check("对方端爱心计数 1", wait_until(
        page2, lambda: any(r["likeMine"] and r["likes"] == "1" for r in (sheet(page2) or {}).get("rows", [])),
        desc="对方端爱心 1",
    ))
    check("本端**不刷新**看到自己那条被贴了爱心", wait_until(
        page,
        lambda: any(C2 in r["content"] and r["likes"] == "1" for r in (sheet(page) or {}).get("rows", [])),
        desc="本端爱心同步",
    ))
    comment_row(page2, C2).locator(".comment-row__like").click()
    check("取消后计数归零（两端）", wait_until(
        page2, lambda: all(r["likes"] != "1" for r in (sheet(page2) or {}).get("rows", []) if C2 in r["content"]),
        desc="对方端计数归零",
    ) and wait_until(
        page, lambda: all(r["likes"] != "1" for r in (sheet(page) or {}).get("rows", []) if C2 in r["content"]),
        desc="本端计数归零",
    ))

    print("== 11. 删自己的留言（两段式确认 + 软删除 + 被删父留言仍能解析昵称）==", flush=True)
    # 两端弹层都保持开着：本端删，对方端要当场看到它消失
    del_row = comment_row(page, edited)
    del_row.locator(".comment-row__action", has_text="删除").click()
    check("第一次点删除进入两段式确认（不直接删）", wait_until(
        page,
        lambda: page.locator('.comment-row__action:text-is("再点一次确认")').count() > 0,
        desc="两段式确认按钮",
    ))
    page.locator('.comment-row__action:text-is("再点一次确认")').first.click()
    check("本端不再显示该留言（软删除）", wait_until(
        page, lambda: row_of((sheet(page) or {}).get("rows"), edited) is None,
        desc="本端留言消失",
    ))
    check("条数回到 2", wait_until(
        page, lambda: (badge(page, TODO) or {}).get("count") == "2", desc="徽标 2 条",
    ))
    check("对方端那条回复仍在，且前缀仍解析出被删父留言的昵称", wait_until(
        page2,
        lambda: (lambda r: r is not None and r["content"].startswith("回复 @"))(
            row_of((sheet(page2) or {}).get("rows"), REPLY)
        ),
        desc="对方端回复未受影响",
    ))
    check("对方端当场也不显示被删的那条（Realtime UPDATE 软删）", wait_until(
        page2, lambda: row_of((sheet(page2) or {}).get("rows"), edited) is None,
        desc="对方端留言消失",
    ))

    print("== 12. 菜单入口与报错检查 ==", flush=True)
    close_sheet(page)  # 弹层开着会遮住卡片，右键点不到
    wait_toast_gone(page)  # 删除后的提示 toast 会挡住右键（本仓既有约定）
    page.locator(".todo", has_text=TODO).first.click(button="right")
    page.wait_for_selector('.action-sheet__icon-btn[aria-label^="留言"]', timeout=5000)
    aria = page.locator('.action-sheet__icon-btn[aria-label^="留言"]').first.get_attribute("aria-label")
    check("长按菜单入口文案带条数（原「加备注/修改备注」已升级）", aria == "留言 2 条", f"实际 {aria!r}")

    real = [e for e in errors if "Failed to fetch" not in e and "net::" not in e and "favicon" not in e]
    check("无模块级报错", len(real) == 0, f"错误数 {len(real)}")
    for e in real[:5]:
        print(f"    {e}", flush=True)

    cleanup_test_data()
    browser.close()

print("=" * 40, flush=True)
print(f"通过: {results['pass']}  失败: {results['fail']}", flush=True)
sys.exit(0 if results["fail"] == 0 else 1)
