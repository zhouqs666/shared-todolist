"""
待办到点提醒 E2E 测试（长按菜单 → 提醒面板 → 落库 → 徽标 → 对账 stub）

为什么有这个文件：提醒功能的「对账逻辑」写错不报错，只会该响的不响；UI 链路
（长按入口 → 面板 → 三件套落库 → 徽标 → Realtime 同步到对端）断在哪一环都静默。
本文件把可自动化的部分钉住 —— 真机「到点真的弹通知」属于系统行为，浏览器测不了，
由发布后的真机冒烟覆盖（见 AGENTS.md 发布自检第 6 步与交付说明的未验证清单）。

覆盖：
  H1 长按菜单出现「设提醒」入口（E2E 钩子启用；生产网页端刻意不显示）
  H2 快捷档（5分钟后）→ 保存 → 徽标出现 + remind_at ≈ now+5min（±25s）+ scope=both + remind_by=我
  H3 范围三选（只提醒我）→ remind_scope='self' 落库
  H4 自定义时间（datetime-local 填 +2h）→ 落库值一致
  H5 清除提醒 → 三件套全 NULL + 对账 stub 记录了取消
  H6 完成待办 → 已调度的提醒被对账取消（stub pendingIds 不再包含）
  H7 冷启动徽标仍在 + 对端（Realtime 双账号）不刷新就看到徽标（transforms 映射链路）
  H8 提醒时刻已过 → 徽标置灰（--expired）+ 对账不再调度过期提醒

E2E 钩子说明：?e2e_reminder=1 → localStorage 标记 → 网页也启用 UI 入口；
调度走内存 stub（window.__reminderTestLog：scheduled/canceled/pendingIds），
数据（remind 三件套）真实落测试库 —— UI 与数据全真，只有「系统弹通知」是 stub。

跑法（铁律二：必须连测试库）：
    node scripts/serve-test.mjs          # :3100 独立测试库
    python3 scripts/test_reminder.py     # 本文件自动连 3100 + 自证隔离

⚠️ 同一测试库不要并发跑两个 E2E（同 test_pin.py 的说明）；走 run-web-e2e.mjs 串行无此问题。
"""
import json
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

# 本机/CI 的 Python 都可能没有配置系统 CA(macOS python.org 发行版常见)，
# urllib 直连 Supabase 会 SSL: CERTIFICATE_VERIFY_FAILED。certifi 是 playwright
# 的既有依赖（requirements-e2e.txt 装它必带上），用它做 CA 源两端都成立。
try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:  # 极旧环境：退回系统默认（至少不比修复前差）
    _SSL_CTX = ssl.create_default_context()

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
check, results = make_checker()

# ===== 测试库只读/修复通道（service_role；仅对 E2E- 前缀的测试数据操作，铁律一）=====
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_env(path):
    env = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            t = line.strip()
            if t and not t.startswith("#") and "=" in t:
                k, v = t.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


_ENV = _load_env(os.path.join(ROOT, "app-e2e", ".env.test"))
SUPABASE_URL = _ENV["E2E_SUPABASE_URL"]
SERVICE_KEY = _ENV["E2E_SUPABASE_SERVICE_ROLE_KEY"]


def parse_iso(ts):
    """解析 PostgREST 返回的 timestamptz（可变小数秒位数），Python 3.9 兼容。"""
    if not ts:
        return None
    t = ts.replace("Z", "+00:00")
    if "." in t:
        head, tail = t.split(".", 1)
        digits = ""
        i = 0
        while i < len(tail) and tail[i].isdigit():
            digits += tail[i]
            i += 1
        t = f"{head}.{digits.ljust(6, '0')}{tail[i:]}"
    return datetime.fromisoformat(t)


def db_get_todo(text):
    """按 text 精确查测试库 todos 行（service_role，只读）。"""
    url = f"{SUPABASE_URL}/rest/v1/todos?select=id,text,remind_at,remind_scope,remind_by,completed&text=eq.{urllib.parse.quote(text)}"
    req = urllib.request.Request(url, headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"})
    with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
        rows = json.loads(resp.read().decode("utf-8"))
    return rows[0] if rows else None


def db_patch_remind_past(todo_id):
    """把一条测试待办的 remind_at 改到过去（H8 造过期态；scope/by 不动，CHECK 仍满足）。"""
    past = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    url = f"{SUPABASE_URL}/rest/v1/todos?id=eq.{todo_id}"
    req = urllib.request.Request(
        url,
        data=json.dumps({"remind_at": past}).encode("utf-8"),
        method="PATCH",
        headers={
            "apikey": SERVICE_KEY,
            "Authorization": f"Bearer {SERVICE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise SystemExit(f"PATCH 测试库失败 HTTP {e.code}：{detail}") from e


# ===== 页内探针 =====
JS_REMINDER_LOG = """() => {
  const log = window.__reminderTestLog;
  if (!log) return null;
  return { scheduled: log.scheduled, canceled: log.canceled, pendingIds: log.pendingIds, syncCount: log.syncCount };
}"""

JS_BADGE_OF = """(text) => {
  const li = [...document.querySelectorAll('#todoList .todo')].find((el) => el.textContent.includes(text));
  if (!li) return null;
  const b = li.querySelector('.todo__reminder-badge');
  return b ? { text: (b.textContent || '').trim(), expired: b.classList.contains('todo__reminder-badge--expired') } : null;
}"""


def badge_of(page, text):
    return page.evaluate(JS_BADGE_OF, text)


def log_of(page):
    return page.evaluate(JS_REMINDER_LOG)


def wait_db_todo(text, pred, desc, timeout_ms=15000):
    """轮询测试库直到该待办满足谓词（返回行或 None）。为什么必须有它：
    保存是「乐观更新 + 异步落库」，UI 徽标出现 ≠ PATCH 已被服务端受理 ——
    在途请求被后续操作（清除覆盖 / reload 中止）打断时，库里就是旧值。
    任何「设置后立刻做下一步」的用例都必须先等落库确认。"""
    deadline = time.monotonic() + timeout_ms / 1000
    last = None
    while time.monotonic() < deadline:
        last = db_get_todo(text)
        try:
            if last and pred(last):
                return last
        except Exception:  # noqa: BLE001 - 谓词异常视为未成立
            pass
        page.wait_for_timeout(300)
    print(f"    [等待超时] {desc}（{timeout_ms}ms）；最后取值：{last}", flush=True)
    return None


def open_reminder_panel(page, text, label):
    """右键卡片 → 菜单 → 提醒按钮（label 因已有提醒而异：设提醒/修改提醒）。"""
    page.locator(".todo", has_text=text).first.click(button="right")
    page.wait_for_selector(f'.action-sheet__icon-btn[aria-label="{label}"]', timeout=5000)
    page.locator(f'.action-sheet__icon-btn[aria-label="{label}"]').click()
    page.wait_for_selector(".reminder-panel-overlay", timeout=5000)


def set_scope(page, key):
    """点范围三选之一（key: both/self/partner → 按钮文案）。"""
    labels = {"both": "我们俩都响", "self": "只提醒我", "partner": "只提醒 ta"}
    page.locator(".reminder-panel__scope-btn", has_text=labels[key]).first.click()


A = "E2E-测试-提醒甲"
B = "E2E-测试-提醒乙"
C = "E2E-测试-提醒丙"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_default_timeout(15000)
    errors = []
    page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

    print("== 0. 置 E2E 钩子（未登录先过一遍 index，把 localStorage 标记写上）==", flush=True)
    # login() 走 login.html → 登录后整页跳 index，查询参数会丢；
    # 钩子靠 localStorage 持久，这里只负责让 reminder.js 的模块级检测跑一次。
    page.goto(f"{BASE}/index.html?e2e_reminder=1", wait_until="domcontentloaded")
    page.wait_for_timeout(500)

    print("== 1. 登录 ==", flush=True)
    check("登录成功进入主页", login(page, BASE, TEST_USER, TEST_PASSWORD), page.url)
    check("E2E 钩子生效（testLog 已暴露）", wait_until(
        page, lambda: log_of(page) is not None, desc="window.__reminderTestLog 出现",
    ))

    print("== 2. H1 长按菜单出现「设提醒」入口 ==", flush=True)
    check("甲已添加", add_todo(page, A))
    wait_add_settled(page, A)
    page.locator(".todo", has_text=A).first.click(button="right")
    check("菜单里有「设提醒」按钮（App/E2E 才有；生产网页端不显示）", wait_until(
        page,
        lambda: page.locator('.action-sheet__icon-btn[aria-label="设提醒"]').count() == 1,
        desc="设提醒按钮出现",
    ))
    page.locator('.action-sheet__icon-btn[aria-label="设提醒"]').click()
    check("提醒面板打开", wait_until(
        page, lambda: page.locator(".reminder-panel-overlay").count() == 1, desc="面板出现",
    ))
    page.screenshot(path="/tmp/reminder-e2e-panel.png", full_page=True)

    print("== 3. H2 快捷档 5 分钟 → 保存 ==", flush=True)
    saved_at = datetime.now(timezone.utc)
    page.locator(".reminder-panel__quick-btn", has_text="5分钟后").first.click()
    page.locator(".reminder-panel__actions .note-input-panel__save").click()
    check("面板已关闭（保存成功）", wait_until(
        page, lambda: page.locator(".reminder-panel-overlay").count() == 0, desc="面板关闭",
    ))
    check("徽标出现在卡片上（铃铛 + 时间）", wait_until(
        page, lambda: badge_of(page, A) is not None, desc="提醒徽标出现",
    ))
    check("徽标未置灰（提醒在未来）", (badge_of(page, A) or {}).get("expired") is False,
          f"实际 {badge_of(page, A)}")
    check("测试库可查到甲（SSL 查询通道正常）", wait_until(
        page, lambda: db_get_todo(A) is not None, desc="测试库可查到甲",
    ))
    row = db_get_todo(A)
    got_at = parse_iso(row and row["remind_at"])
    check("remind_at ≈ now+5min（±25s）", got_at is not None and abs(
        (got_at - (saved_at + timedelta(minutes=5))).total_seconds()
    ) <= 25, f"实际 remind_at={row and row['remind_at']}")
    check("remind_scope 默认 both", row and row["remind_scope"] == "both", f"实际 {row and row['remind_scope']}")
    check("remind_by 已记录（本人 id，非空）", row and bool(row["remind_by"]))
    log = log_of(page)
    check("对账 stub 已调度该提醒", log and any(
        s.get("todoId") == (row or {}).get("id") for s in (log.get("scheduled") or [])
    ), f"实际 scheduled={log and log.get('scheduled')}")

    print("== 4. H3 范围三选（只提醒我）==", flush=True)
    open_reminder_panel(page, A, "修改提醒")
    set_scope(page, "self")
    page.locator(".reminder-panel__actions .note-input-panel__save").click()
    wait_until(page, lambda: page.locator(".reminder-panel-overlay").count() == 0, desc="面板关闭")
    check("scope=self 落库", wait_until(
        page, lambda: (db_get_todo(A) or {}).get("remind_scope") == "self", desc="scope=self 落库",
    ))
    row = db_get_todo(A)
    check("remind_scope='self' 已落库", row and row["remind_scope"] == "self", f"实际 {row and row['remind_scope']}")

    print("== 5. H4 自定义时间（+2 小时）==", flush=True)
    custom_local = (datetime.now().astimezone() + timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M")
    open_reminder_panel(page, A, "修改提醒")
    page.locator(".reminder-panel__custom").fill(custom_local)
    set_scope(page, "partner")
    page.locator(".reminder-panel__actions .note-input-panel__save").click()
    wait_until(page, lambda: page.locator(".reminder-panel-overlay").count() == 0, desc="面板关闭")
    expect_utc = datetime.fromisoformat(custom_local).astimezone(timezone.utc)
    check("scope=partner 落库", wait_until(
        page,
        lambda: (db_get_todo(A) or {}).get("remind_scope") == "partner",
        desc="scope=partner 落库",
    ))
    row = db_get_todo(A)
    got = parse_iso(row and row["remind_at"])
    check("自定义时刻落库（UTC 换算一致，±60s）", got and abs((got - expect_utc).total_seconds()) <= 60,
          f"期望≈{expect_utc.isoformat()} 实际 {row and row['remind_at']}")
    check("remind_scope='partner' 已落库", row and row["remind_scope"] == "partner",
          f"实际 {row and row['remind_scope']}")

    print("== 6. H6 完成待办 → 提醒被对账取消 ==", flush=True)
    todo_id_a = row["id"]
    page.locator(".todo", has_text=A).first.locator(".todo__check").click()
    wait_toast_gone(page)
    check("完成后徽标消失", wait_until(
        page, lambda: badge_of(page, A) is None, desc="已完成不显示提醒徽标",
    ))
    check("对账已取消该提醒（stub pendingIds 不再包含）", wait_until(
        page,
        lambda: todo_id_a not in json.dumps(log_of(page).get("pendingIds", []))
        and not any(s.get("todoId") == todo_id_a for s in log_of(page).get("scheduled", []) if not s.get("viaSync")),
        desc="stub 取消记录出现",
    ))

    print("== 7. H5 清除提醒（新条目走完整设置→清除）==", flush=True)
    check("乙已添加", add_todo(page, B))
    wait_add_settled(page, B)
    open_reminder_panel(page, B, "设提醒")
    page.locator(".reminder-panel__quick-btn", has_text="10分钟后").first.click()
    page.locator(".reminder-panel__actions .note-input-panel__save").click()
    check("乙的徽标出现", wait_until(page, lambda: badge_of(page, B) is not None, desc="乙徽标"))
    # 落库确认后再动下一步:清除 PATCH 若赶在设置的 PATCH 之前/同时到达,
    # 清除会覆盖还没落地的设置(两请求不同连接,到达序不保证)—— 先等设置真正受理
    row_b = wait_db_todo(B, lambda r: r["remind_at"] is not None and r["remind_scope"] == "both",
                         "乙的提醒落库")
    check("乙的设置已落库（remind_at 非空 + scope=both）", row_b is not None,
          f"实际 {row_b}")
    before_cancel = len((log_of(page) or {}).get("canceled") or [])
    open_reminder_panel(page, B, "修改提醒")
    page.locator(".reminder-panel__clear").click()
    wait_until(page, lambda: page.locator(".reminder-panel-overlay").count() == 0, desc="面板关闭")
    check("清除后徽标消失", wait_until(page, lambda: badge_of(page, B) is None, desc="乙徽标消失"))
    row_b2 = wait_db_todo(B, lambda r: all(r.get(k) is None for k in ("remind_at", "remind_scope", "remind_by")),
                          "乙的三件套置 NULL")
    check("remind_at/scope/by 全部 NULL", row_b2 is not None, f"实际 {row_b2}")
    check("remind_at/scope/by 全部 NULL", all(
        row_b2.get(k) is None for k in ("remind_at", "remind_scope", "remind_by")
    ), f"实际 {row_b2}")
    check("对账记录了取消", len((log_of(page) or {}).get("canceled") or []) > before_cancel,
          f"实际 canceled={log_of(page) and log_of(page).get('canceled')}")

    print("== 8. H7 冷启动 + 对端 Realtime ==", flush=True)
    check("丙已添加并设提醒（both）", add_todo(page, C))
    wait_add_settled(page, C)
    open_reminder_panel(page, C, "设提醒")
    page.locator(".reminder-panel__quick-btn", has_text="15分钟后").first.click()
    page.locator(".reminder-panel__actions .note-input-panel__save").click()
    check("丙的徽标出现", wait_until(page, lambda: badge_of(page, C) is not None, desc="丙徽标"))
    # reload 会中止在途的 PATCH(导航取消请求)—— 必须等设置真正落库再冷启动
    row_c0 = wait_db_todo(C, lambda r: r["remind_at"] is not None and r["remind_scope"] == "both",
                          "丙的提醒落库")
    check("丙的设置已落库（再冷启动）", row_c0 is not None, f"实际 {row_c0}")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("body[data-app-ready='1']", timeout=30000)
    check("冷启动后丙的徽标仍在（数据持久化）", wait_until(
        page, lambda: badge_of(page, C) is not None, desc="冷启动徽标",
    ))

    context2 = browser.new_context()
    page2 = context2.new_page()
    page2.set_default_timeout(15000)
    # 对端也要过一遍钩子（各自 context 的 localStorage 独立）
    page2.goto(f"{BASE}/index.html?e2e_reminder=1", wait_until="domcontentloaded")
    page2.wait_for_timeout(500)
    second_user = os.environ.get("E2E_SECOND_ACCOUNT", "e2e-beta")
    check("第二账号登录成功", login(page2, BASE, second_user, TEST_PASSWORD), page2.url)
    page2.wait_for_timeout(4000)  # Realtime 订阅生效窗口（已知时序，同 test_pin.py）
    check("对端**不刷新**就看到丙的提醒徽标（transforms 映射 + Realtime）", wait_until(
        page2, lambda: badge_of(page2, C) is not None, desc="对端徽标出现",
    ))
    log2 = log_of(page2)
    row_c = db_get_todo(C)
    check("对端也调了度（both 范围：两台设备各自响）", log2 and any(
        s.get("todoId") == (row_c or {}).get("id") for s in (log2.get("scheduled") or [])
    ), f"对端 scheduled={log2 and log2.get('scheduled')}")
    page2.screenshot(path="/tmp/reminder-e2e-partner.png", full_page=True)

    print("== 9. H8 过期提醒 → 徽标置灰 + 不再调度 ==", flush=True)
    db_patch_remind_past(row_c["id"])
    # Realtime 会把 PATCH 推到两端；本端等 UPDATE 落地（徽标置灰）
    check("提醒时刻已过 → 本端徽标置灰", wait_until(
        page, lambda: (badge_of(page, C) or {}).get("expired") is True, desc="本端过期徽标",
    ))
    check("对端徽标同步置灰", wait_until(
        page2, lambda: (badge_of(page2, C) or {}).get("expired") is True, desc="对端过期徽标",
    ))
    # 过期后对账不得再调度它：清掉本端 stub 再触发一次对账（回前台路径 = reload）
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("body[data-app-ready='1']", timeout=30000)
    page.wait_for_timeout(1500)  # 等首次对账（防抖 300ms + stub 往返）
    log_after = log_of(page)
    check("过期提醒未被重新调度（pendingIds 为空或不含丙）",
          (row_c or {}).get("id") not in json.dumps(log_after.get("pendingIds", [])),
          f"实际 pendingIds={log_after and log_after.get('pendingIds')}")
    page.screenshot(path="/tmp/reminder-e2e-expired.png", full_page=True)

    print("== 10. 页面报错检查 ==", flush=True)
    real = [e for e in errors if "Failed to fetch" not in e and "net::" not in e and "favicon" not in e]
    check("无模块级报错", len(real) == 0, f"错误数 {len(real)}")
    for e in real[:5]:
        print(f"    {e}", flush=True)

    cleanup_test_data()
    browser.close()

print("=" * 40, flush=True)
print(f"通过: {results['pass']}  失败: {results['fail']}", flush=True)
sys.exit(0 if results["fail"] == 0 else 1)
