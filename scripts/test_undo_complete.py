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


# ===== 完成提示的形状不变量（2026-09-18 加）=====
#
# 为什么必须有它：这套不变量曾经**静默错了很久，而所有测试都是绿的**。
#   `.toast` 是 `left:50%` + `right:auto` 的绝对定位 ⇒ 宽度按 shrink-to-fit 算时可用宽只有 50vw，
#   于是写在样式里的 `max-width: 80vw` 从未生效：「完成待办」那条（永远带「撤销」按钮）的文案被压成
#   3 行、传说款 5 行，盒子成了窄长砖 —— 而断言只问「撤销按钮在不在」，不问它长什么样。
#   业主报出「很难看」才被发现。同类还会借 `bottom` 静默退化（提示啃进右下角 FAB / 压住安卓手势条）。
# 四条都是**可机器判定的形状不变量**，不涉及像素级外观（好不好看仍归人眼）：
#   ① 文案单行  ② 宽度 ≤ min(80vw, 380px)  ③ 不与 FAB 重叠  ④ 主文案对比度 ≥ 4.5（曾只有 2.53:1）
TOAST_GEOMETRY_JS = r"""() => {
  const t = document.getElementById('toast');
  if (!t) return { exists: false };
  const r = t.getBoundingClientRect();
  const cs = getComputedStyle(t);
  const fab = document.querySelector('.fab');
  const fr = fab ? fab.getBoundingClientRect() : null;
  const node = [...t.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
  let lines = null;
  if (node) { const rg = document.createRange(); rg.selectNodeContents(node); lines = rg.getClientRects().length; }
  const nums = (s) => (s.match(/[\d.]+/g) || []).map(Number);
  const parse = (s) => nums(s).slice(0, 3);
  const alpha = (s) => { const p = nums(s); return p.length > 3 ? p[3] : 1; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  // 半透明底色要合成到**真正画在它下面的那个颜色**上（向上找第一个不透明背景）
  let under = [255, 255, 255];
  for (let el = t.parentElement; el; el = el.parentElement) {
    const c = getComputedStyle(el).backgroundColor;
    if (alpha(c) > 0.99) { under = parse(c); break; }
  }
  let eff = parse(cs.backgroundColor);
  const a = alpha(cs.backgroundColor);
  if (a < 1) eff = eff.map((v, i) => v * a + under[i] * (1 - a));
  const [hi, lo] = [lum(parse(cs.color)), lum(eff)].sort((x, y) => y - x);
  return {
    exists: true, width: Math.round(r.width), lines,
    gradient: cs.backgroundImage !== 'none',
    maxAllowed: Math.min(innerWidth * 0.8, 380),
    bottomGap: Math.round(innerHeight - r.bottom),
    fabOverlap: fr ? !(fr.right <= r.left || fr.left >= r.right || fr.bottom <= r.top || fr.top >= r.bottom) : false,
    contrast: Number(((hi + 0.05) / (lo + 0.05)).toFixed(2)),
  };
}"""


def check_toast_geometry(page, label, max_lines=1):
    """断言完成提示的形状不变量（见上方注释：这些值曾经静默错了很久而测试全绿）。

    ⚠️ **必须切到手机宽度再量**（本函数第一版就是在桌面视口量的，结果对修复前的代码全绿 ——
    变异验证当场戳穿）。原因：这个缺陷是「宽度被锁死成视口的一半」，桌面 1280 宽下 50vw=640px
    比文案还宽，换行根本不会发生；而产品是安卓 App（360~430 CSS px），那里 50vw=180~215px，
    文案才被压成 3 行。**在错的前提下量，等于没量** —— 所以这里显式切到手机尺寸，量完还原。

    max_lines：普通款鼓励语最长 11 字 + 撤销，修好后必然单行；隐藏款完成文案自带
    「图鉴 N/12」（最长约 24 字），在 380px 上限内**有意**占两行 —— 那里传 2。
    """
    prev = page.viewport_size
    page.set_viewport_size({"width": 390, "height": 844})
    g = page.evaluate(TOAST_GEOMETRY_JS)
    if prev:
        page.set_viewport_size(prev)
    if not g.get("exists"):
        check(f"{label} 几何自检", False, "页面上没有 #toast")
        return
    check(f"{label} 文案行数 ≤{max_lines}", g["lines"] <= max_lines, f"实际 {g['lines']} 行（宽度上限丢了？）")
    check(f"{label} 宽度未超上限", g["width"] <= g["maxAllowed"] + 1, f"{g['width']}px > {round(g['maxAllowed'])}px")
    check(f"{label} 不压住 FAB", not g["fabOverlap"], f"底边距屏底 {g['bottomGap']}px")
    if g.get("gradient"):
        # 渐变底色的实际色无法从 computed style 取固定值（backgroundColor 是 transparent，
        # 颜色在 background-image 里）⇒ 显式跳过并留痕，不假装检过（隐藏款深底白字不在此列）
        print(f"  [跳过] {label} 主文案对比度（渐变底色，须人工或截图判定）", flush=True)
    else:
        check(f"{label} 主文案对比度 ≥4.5", g["contrast"] >= 4.5, f"实际 {g['contrast']}:1")


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
            # 隐藏款完成文案自带「图鉴 N/12」，在宽度上限内有意占两行；普通款必须单行
            check_toast_geometry(page, f"{label} 完成toast", max_lines=2 if rarity != 'common' else 1)
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

    # ===== H3 回归（v2.7.75）：收起后的撤销按钮不得可点 =====
    # 为什么单独守这一条：.toast 靠 opacity:0 收起（opacity 不参与命中测试），
    # 而 .toast__action 原先是无条件 pointer-events:auto —— 于是提示早就消失、
    # 屏幕底部却留着一个**透明但可点**的热区，误触会真的执行「撤销恢复/撤销完成」；
    # 且它 z-index 高于添加面板，会吃掉点输入框的抬手（键盘弹不出来）。
    # 修法是把恢复可点门控到 .toast--show 上。这里直接钉住这个 CSS 契约：
    # 收起态必须是 none；展开态必须回到 auto（否则撤销就点不了了）。
    h3 = page.evaluate("""() => {
      const t = document.createElement('div');
      t.className = 'toast';
      const b = document.createElement('button');
      b.className = 'toast__action';
      t.appendChild(b);
      document.body.appendChild(t);
      const hidden = getComputedStyle(b).pointerEvents;
      t.classList.add('toast--show');
      const shown = getComputedStyle(b).pointerEvents;
      t.remove();
      return { hidden, shown };
    }""")
    check("H3 收起态撤销按钮不可点（pointer-events: none）", h3["hidden"] == "none", f"实际 {h3}")
    check("H3 展开态撤销按钮可点（pointer-events: auto）", h3["shown"] == "auto", f"实际 {h3}")

    # ===== H4：提示形状不变量（CSS 级，确定性）=====
    # 为什么要单开一段：H1 里的几何自检用的是**真实完成链路**，而鼓励语是随机抽的 ——
    # 抽到「太棒了！」（4 字）时，宽到被锁成 50vw 也照样单行，断言就躲过去了
    # （变异验证实测：修复前的 CSS 在普通分支绿、稀有度分支才红 —— 一半靠运气）。
    # 这里改为喂**最长的一条**鼓励语 + 撤销（完成路径必然带撤销），把 CSS 不变量钉死；
    # 走的是产品自己的 showToast（同一套 DOM/类名），不是另造一个假元素。
    SEED = "E2E-测试-完成撤销-形状不变量"
    print("\n== H4: 提示形状不变量（最长文案 + 撤销，手机宽度）==", flush=True)
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("body[data-app-ready='1']", timeout=20000)  # 重载清空 toast 队列，避免排队
    page.set_viewport_size({"width": 390, "height": 844})
    page.evaluate(
        """() => import('/js/toast.js').then((m) => m.showToast('这就去掉了心头一件事。', {
             variant: 'success',
             icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
             duration: 60000,
             action: { label: '撤销', onClick: () => {} },
           }))"""
    )
    if wait_until(page, lambda: page.locator(".toast--show").count() > 0, timeout_ms=5000, desc="形状不变量用的提示出现"):
        check_toast_geometry(page, "H4 完成提示(最长文案)", max_lines=1)
    else:
        check("H4 完成提示(最长文案) 已显示", False, "提示没弹出来")

    # 基类长文案（深灰胶囊）：同一个宽度上限缺陷曾把「图片上传失败，可长按待办补图」压成 2 行，
    # 还断在"待办/办补图"处 —— 一并钉住（这一条与稀有度无关，是最常出现的提示形态）
    # ⚠️ 必须再次 reload：toast 模块是单例 + 串行队列，上一条还在显示时新提示会**排队**而不是
    #    替换（这行代码的第一版就是手动摘掉 .toast--show 类再发的 —— 类摘了、模块内的 showing
    #    标志还在，量到的仍是上一条。reload 是唯一能把队列真正清空的动作）。
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("body[data-app-ready='1']", timeout=20000)
    page.evaluate("() => import('/js/toast.js').then((m) => m.showToast('图片上传失败，可长按待办补图', { duration: 60000 }))")
    if wait_until(page, lambda: page.locator(".toast--show").count() > 0, timeout_ms=5000, desc="基类长文案提示出现"):
        check_toast_geometry(page, "H4 基类长文案", max_lines=1)
    else:
        check("H4 基类长文案 已显示", False, "提示没弹出来")
    page.set_viewport_size({"width": 1280, "height": 720})

    # 汇总
    print(f"\n== 结果: {results['pass']} 通过 / {results['fail']} 失败 ==", flush=True)
    if errors:
        print(f"\n控制台错误 ({len(errors)}):", flush=True)
        for e in errors[:10]:
            print(f"  {e}", flush=True)

    browser.close()
    sys.exit(1 if results["fail"] > 0 else 0)
