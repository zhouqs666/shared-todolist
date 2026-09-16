"""
E2E 测试公共模块 —— 铁律一：测试必须物理隔离生产库

背景（2026-09-14 事故）：
    scripts/test_*.py 原本直连 http://localhost:3000（生产库托管的 public/），
    调试期间在生产库创建 27 条测试待办，并误解锁 legendary_1 传说贴纸。

    「测试用 E2E- 前缀 + 测完清理」这种软约定挡不住事故——清理在软删除语义下
    只是进回收站，且盲盒开奖发生在「添加」瞬间，开出的贴纸无法通过清待办撤销。

本模块提供两道硬闸：
    1. resolve_base()      —— 默认指向测试服务器（3100），不再默认 3000
    2. assert_test_server() —— 连上后必须自证是测试库，否则拒绝运行（fail-closed）

用法（每个 scripts/test_*.py 开头）：
    import os, sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from e2e_common import resolve_base, load_test_creds, make_checker

    BASE = resolve_base()                    # 隔离校验不过就直接退出
    USERNAME, PASSWORD = load_test_creds()   # 测试库账号，非生产密码
    check = make_checker()
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

# 与本项目生产库对应的「测试服务器」默认端口（见 scripts/serve-test.mjs）
DEFAULT_TEST_BASE = "http://localhost:3100"
# 生产库托管端口——明确禁止测试脚本使用
FORBIDDEN_PROD_PORTS = {"3000"}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _fail(msg):
    bar = "=" * 62
    print(f"\n{bar}", flush=True)
    print("✗ 铁律一拦截：测试不可连生产库，已拒绝运行", flush=True)
    print(bar, flush=True)
    print(msg, flush=True)
    print(f"{bar}\n", flush=True)
    sys.exit(2)


def _load_dotenv(path):
    if not os.path.exists(path):
        return {}
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            t = line.strip()
            if not t or t.startswith("#") or "=" not in t:
                continue
            k, v = t.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def resolve_base():
    """解析测试基址并做隔离校验。校验不过 → sys.exit(2)。

    环境变量 E2E_BASE 可覆盖，但仍必须通过隔离校验。
    """
    base = os.environ.get("E2E_BASE", DEFAULT_TEST_BASE).rstrip("/")

    # 显式拦 3000：那是 scripts/serve.mjs（生产库）的端口
    port = base.rsplit(":", 1)[-1]
    if port in FORBIDDEN_PROD_PORTS:
        _fail(
            f"E2E_BASE 指向 {base}（端口 {port}），那是托管生产库的服务。\n"
            "  请改用测试服务器：node scripts/serve-test.mjs   → http://localhost:3100"
        )

    assert_test_server(base)
    return base


def assert_test_server(base):
    """向 {base}/__dbinfo 求证：这必须是测试库服务器（fail-closed）。"""
    url = f"{base}/__dbinfo"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.URLError as e:
        _fail(
            f"无法连接测试服务器 {base}（{e}）。\n"
            "  请先启动：node scripts/serve-test.mjs"
        )

    try:
        info = json.loads(raw)
    except (ValueError, TypeError):
        _fail(
            f"{base}/__dbinfo 未返回合法 JSON。\n"
            "  说明该服务的隔离性无法自证（可能是生产服务器 scripts/serve.mjs），拒绝运行。"
        )

    if info.get("project") != "test" or info.get("isolated") is not True:
        _fail(f"{base}/__dbinfo 自证不是测试库：{info}")

    prod = info.get("prodUrl")
    if not prod or info.get("supabaseUrl") == prod:
        _fail(f"{base} 的 supabaseUrl 与生产库相同：{info}")

    print(f"[隔离校验通过] 测试库: {info.get('supabaseUrl')}", flush=True)
    print(f"[隔离校验通过] 生产库: {prod}（本测试绝不触碰）", flush=True)


def load_test_creds():
    """从 app-e2e/.env.test 读测试账号（测试库专用密码，非生产密码）。"""
    env = _load_dotenv(os.path.join(ROOT, "app-e2e", ".env.test"))
    user = env.get("E2E_TEST_USERNAME")
    pwd = env.get("E2E_TEST_PASSWORD")
    if not user or not pwd:
        _fail(
            "app-e2e/.env.test 缺少 E2E_TEST_USERNAME / E2E_TEST_PASSWORD。\n"
            "  测试账号必须来自测试库，禁止使用生产账号密码。"
        )
    return user, pwd


def make_checker():
    """返回 (check, results)，与原各测试脚本的 check 签名保持一致。"""
    results = {"pass": 0, "fail": 0}

    def check(name, cond, detail=""):
        if cond:
            results["pass"] += 1
            print(f"  OK {name}", flush=True)
        else:
            results["fail"] += 1
            print(f"  FAIL {name} {detail}", flush=True)

    return check, results


# ============================================================================
# 显式等待与交互助手（flaky 治理）
#
# 为什么要有这一段（2026-09-14 批次 C）：
#   原 4 个脚本里散落 20 多处 page.wait_for_timeout(N)，其中多数不是「需要等这么久」，
#   而是「在赌这段时间够」——赌注是 CI 机器比本地慢几倍。本项目已经为同一类错误
#   付过学费：模拟器 E2E 的超时值按本地手感设，CI 上连挂 4 轮（见学习方案阶段 3 坑 4）。
#   行业实践（测试金字塔 §3.5）：99% 的 flaky 来自等待逻辑 —— 把「等多久」换成「等什么条件」，
#   命中即返回，慢机器上自动延长，快机器上不浪费时间。
# ============================================================================


def wait_until(page, fn, timeout_ms=10000, desc="条件", interval_ms=150):
    """显式等待：轮询 fn() 直到为真。返回 True/False（不抛异常，交给调用方 check 判定）。

    fn 里可以抛异常（元素暂时不存在等），异常视为「条件未成立」，最后会把最后一次的值打出来
    便于失败时定位 —— 失败信息必须能回答问题，而不是只报一个超时。

    超时**必然留证据**：截图存到 /tmp，并把路径打出来。CI（e2e-web-full.yml）失败时会
    归档 `/tmp/*.png`，于是「失败 → 先看截图」这条方法论在流水线里成立，
    不用等人肉复现（阶段 3 的教训：日志里的「元素找不到」永远只是表层现象）。
    """
    deadline = time.monotonic() + timeout_ms / 1000
    last = None
    while time.monotonic() < deadline:
        try:
            last = fn()
            if last:
                return True
        except Exception as e:  # noqa: BLE001 - 条件探测期的异常一律视为「未成立」
            last = f"{type(e).__name__}: {e}"
        page.wait_for_timeout(interval_ms)
    print(f"    [等待超时] {desc}（{timeout_ms}ms）；最后一次取值：{last}", flush=True)
    try:
        slug = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "-", desc)[:40].strip("-") or "timeout"
        shot = f"/tmp/e2e-timeout-{slug}-{int(time.time())}.png"
        page.screenshot(path=shot, full_page=True)
        print(f"    [超时证据] 截图已存 {shot}（CI 会作为制品归档）", flush=True)
    except Exception as e:  # noqa: BLE001 - 截图失败不能掩盖原本的超时
        print(f"    [超时证据] 截图失败：{e}", flush=True)
    return False


def login(page, base, username, password, timeout_ms=30000):
    """登录并等到应用**可交互**为止。返回是否已离开登录页。

    就绪信号用 body[data-app-ready]（app.js 在 bindEvents() 之后打上的标记），
    而不是「等 1500ms 猜事件绑好了」。这一处不是洁癖：头像（renderMe）出现时，
    app 还差一个 await db.listProfiles() 才走到 bindEvents()，此时点 FAB / 图鉴入口
    会点在尚未绑定的处理器上 —— 本项目的 test_sticker_wiggle.mjs 就被这个竞态
    长期误诊为「CI flaky」（2026-09-14 定位，见 CODE-REVIEW F2）。
    """
    page.goto(f"{base}/login.html", wait_until="domcontentloaded")
    page.wait_for_selector("#username", timeout=timeout_ms)
    page.fill("#username", username)
    page.fill("#password", password)
    page.click("#submitBtn")
    page.wait_for_selector(".topbar__avatar", timeout=timeout_ms)
    page.wait_for_selector("body[data-app-ready='1']", timeout=timeout_ms)
    return "login" not in page.url


def open_add_panel(page, timeout_ms=15000, attempts=3):
    """点 FAB 打开添加面板，带重试（点击被投递到未绑定的处理器上时由重试兜住）。

    openAddPanel 只是加 class + 聚焦输入框，重复点击无副作用，所以重试是安全的。
    点击本身也纳入 try：底部 toast（撤销条）与 FAB 位置相近时可能拦截点击，
    Playwright 会以「元素被遮挡」抛错 —— 那种情况下重试比直接崩掉测试更有意义。
    """
    per_try = max(1000, timeout_ms // attempts)
    for i in range(attempts):
        try:
            page.locator("#fabBtn").click(timeout=per_try)
            page.wait_for_selector("#addPanel.add-panel--show", timeout=per_try)
            return True
        except Exception:  # noqa: BLE001 - 没打开就再点一次
            print(f"    [重试] FAB 第 {i + 1} 次点击未打开面板", flush=True)
    return False


def add_todo(page, text, timeout_ms=15000):
    """通过 UI 添加一条待办，等到它（或它的 pending 占位）出现在列表里。返回是否出现。

    用「等元素出现」而不是「点完等 3 秒再数」：后者在 CI 上会在 createTodo 还没回来时
    就数数，把「还没渲染」误报成「添加失败」。
    离线场景下出现的是 .todo--pending，:has-text 一样能命中。

    注意：本函数**只保证「待办出现了」**，不保证「添加这条链已经落定」——
    若后面紧接着要点击这条待办或读 toast，请再调 wait_add_settled()。
    """
    if not open_add_panel(page):
        return False
    page.fill("#todoInput", text)
    page.locator("#addBtn").click()
    try:
        page.wait_for_selector(f'.todo:has-text("{text}")', timeout=timeout_ms)
        return True
    except Exception:  # noqa: BLE001 - 由调用方 check 判定失败
        return False


def wait_add_settled(page, text, quiet_ms=2500, timeout_ms=20000):
    """等「添加待办」这条链彻底安静下来，再执行下一个动作。

    为什么需要（2026-09-14 用诊断日志定位到的真实竞态，不是猜的）：
      addTodo() 命中隐藏款时的顺序是「插入成功 → 渲染待办 → 补两条 toast」：
        ① setTimeout(celebrateRarity, 60)      → 「🌟 开出史诗款！」（本地，60ms 后）
        ② onRollRarity(todo, ...)（网络往返）   → 「🎨 解锁贴纸「初心」！图鉴 1/12」
      而 toast 是**单例元素**：showToast() 复用 #toast，先 `textContent = ''` 清空再写。
      于是紧跟「添加」的下一个动作会撞上这些 toast —— 实测到的失败长这样：

          点击完成 → 出现「撤销」按钮 → 开奖/解锁 toast 到达 → 按钮被连内容一起清掉
          诊断快照：{cls: 'todo todo--done todo--epic',
                     toastText: '🌟 开出史诗款！', actionButtons: 0}

      命中隐藏款约 15%，且**第一条 toast 消失后第二条才到**，所以「等一条 toast 出现再等它消失」
      是不够的（第一版就是这么写的，实测仍然 1/5 失败）。真正的就绪条件是「安静」：
      连续 quiet_ms 内没有任何 toast 在显示 —— 这条链的后续 toast 都在 ~1.5s 内到齐、
      每条持续 2.5~4s，所以 2.5s 的安静窗口足以覆盖（判定窗口来自实测时序，不是随手取的数）。

    判定依据不是猜时间，而是读这条待办自己的**稀有度 class**（applyRarity 在渲染时打上）：
      - 普通款：添加流程不产生任何 toast → 立刻返回（85% 的路径零额外开销）
      - 隐藏款：等「安静窗口」

    【2026-09-16 更新】上面那个「按钮被清掉」的缺陷已在产品侧修掉：toast 改为**串行展示**
    （上一条还在显示时新提示排队，不再覆盖），且一次开奖只发**一条**合并提示（开奖文案 + 解锁结果），
    完成待办时的那种提示也不再被开奖提示顶掉。本函数保留 —— 「等这条链彻底安静」仍然是
    点击下一条待办前该有的就绪条件，且对未来的提示改动不敏感。
    """
    row = page.locator('.todo', has_text=text).first
    cls = row.get_attribute('class') or ''
    if not any(k in cls for k in ('todo--rare', 'todo--epic', 'todo--legendary')):
        return True

    deadline = time.monotonic() + timeout_ms / 1000
    quiet_since = None
    while time.monotonic() < deadline:
        if page.locator('.toast--show').count() > 0:
            quiet_since = None
        elif quiet_since is None:
            quiet_since = time.monotonic()
        elif (time.monotonic() - quiet_since) * 1000 >= quiet_ms:
            return True
        page.wait_for_timeout(150)
    print(f"    [等待超时] 添加后的 toast 一直没安静下来（quiet_ms={quiet_ms}）", flush=True)
    return False


def wait_toast_gone(page, timeout_ms=15000):
    """等到撤销 toast 收起（即「5 秒撤销窗口」真的过去了）。

    原来写的是固定 `wait_for_timeout(5500)`（对应 app.js 里 duration: 5000），
    表面安全，实际是拿客户端定时器去对赌固定毫秒数。这里改成等真实信号：
    toast 的收起由浏览器端 setTimeout 驱动，与 CI 机器快慢无关。
    """
    return wait_until(
        page,
        lambda: page.locator(".toast--show").count() == 0,
        timeout_ms=timeout_ms,
        desc="撤销 toast 收起",
    )


def dump_dom_state(page, errors=None, tag="诊断"):
    """失败时的现场快照：列表里有什么、toast 什么状态、控制台报了什么。

    为什么需要它：断言失败时最没用的信息是「Timeout 5000ms exceeded」——
    它只说明「没等到」，不说明「当时屏幕上是什么」。E2E 排查的第一动作本来是看截图，
    但在 CI 里没法回放，所以把关键状态直接打进日志（与超时自动截图配套）。
    """
    try:
        state = page.evaluate(
            """() => {
              const t = document.getElementById('toast');
              return {
                todos: [...document.querySelectorAll('#todoList .todo')].map(
                  (li) => ({ cls: li.className, text: (li.querySelector('.todo__text') || {}).textContent || '' })
                ),
                toastExists: !!t,
                toastClass: t ? t.className : null,
                toastText: t ? t.textContent : null,
                actionButtons: document.querySelectorAll('.toast__action').length,
              };
            }"""
        )
        print(f"    [{tag}] {state}", flush=True)
    except Exception as e:  # noqa: BLE001 - 诊断本身不能掩盖原始失败
        print(f"    [{tag}] 抓取失败：{e}", flush=True)
    if errors:
        print(f"    [{tag}] 控制台报错 {len(errors)} 条，前 5 条：", flush=True)
        for e in errors[:5]:
            print(f"        {e}", flush=True)


def cleanup_test_data():
    """硬删测试库里的 E2E 数据（待办 + 贴纸）。

    为什么不能只靠测试内部的 UI 删除：那是**软删除**（deleted_at 打时间戳），
    行永远留在表里 —— 看起来清了，其实越跑越脏。贴纸更麻烦：sticker_key 有
    UNIQUE 约束，一旦解锁就幂等，之后再也测不了「首次解锁」路径。
    所以清理以 scripts/reset-test-db.mjs 为准（它自带生产库硬闸）。

    设 E2E_KEEP_DATA=1 可跳过（排查失败用例时保留现场）。
    返回 True 表示清理成功。
    """
    if os.environ.get("E2E_KEEP_DATA") == "1":
        print("\n[清理] E2E_KEEP_DATA=1，跳过清理（保留现场）")
        return True
    import subprocess

    script = os.path.join(ROOT, "scripts", "reset-test-db.mjs")
    print("\n[清理] 归零测试库…", flush=True)
    r = subprocess.run(["node", script], capture_output=True, text=True)
    tail = [l for l in (r.stdout or "").splitlines() if l.strip()][-3:]
    for l in tail:
        print(f"  {l}")
    if r.returncode != 0:
        print("  ⚠️ 清理未完全成功（见上方输出）")
        return False
    return True
