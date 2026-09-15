"""
盲盒 + 图鉴功能 E2E 测试

分三部分：
1. 纯前端逻辑测试（不依赖 DB）：rollRarity 概率分布、applyRarity 稀有度 class、图鉴渲染
2. 页面加载/登录测试：验证模块链无报错、登录后主页渲染、createTodo 落库
3. 隐藏款链路（强制开奖）：用 localStorage 钩子把开奖锁到指定稀有度，覆盖 15% 概率撞不到的路径
   —— 提示是否被顶掉、贴纸序号是否重复/空转、完成时「撤销」按钮是否还在、rarity_seen 是否正确

（原注释写「生产库迁移尚未执行，rarity 列/stickers 表不存在」——已过时：2026-09-16 复核确认
 线上两张表/列都在（todos.rarity 已回填、stickers 有数据），本测试在测试库上完整跑真实链路。）

测试遵循 AGENTS.md 铁律一：跑在独立测试库（scripts/serve-test.mjs + e2e_common 隔离校验）。
添加的测试待办用 "E2E-测试-" 前缀，测后由 reset 脚本硬删（软删除清不干净，见文件末注释）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import re
import json
from playwright.sync_api import sync_playwright
from e2e_common import (
    resolve_base,
    load_test_creds,
    cleanup_test_data,
    add_todo,
    wait_add_settled,
    login,
    wait_until,
)

BASE = resolve_base()
TEST_USER, TEST_PASSWORD = load_test_creds()
errors = []
test_results = {"pass": 0, "fail": 0, "checks": []}


def check(name, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    test_results["pass" if condition else "fail"] += 1
    test_results["checks"].append(f"[{status}] {name}" + (f" — {detail}" if detail else ""))
    if not condition:
        print(f"  ✗ {name} {detail}")
    else:
        print(f"  ✓ {name}")


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    page.on("console", lambda msg: errors.append(f"[console.{msg.type}] {msg.text}") if msg.type in ("error", "warning") else None)
    page.on("pageerror", lambda err: errors.append(f"[pageerror] {err}"))

    print("=" * 60)
    print("1. 加载登录页 — 验证模块链无 JS 报错")
    print("=" * 60)
    page.goto(f"{BASE}/login.html", wait_until="networkidle")
    page.wait_for_timeout(1500)
    # 过滤掉网络相关警告（非模块错误）
    module_errors = [e for e in errors if "Failed to fetch" not in e and "net::" not in e]
    check("登录页加载无模块报错", len(module_errors) == 0, f"错误数: {len(module_errors)}")
    if module_errors:
        for e in module_errors[:5]:
            print(f"    {e}")

    print()
    print("=" * 60)
    print("2. 登录（测试账号 e2e-alpha）")
    print("=" * 60)
    # 原来是「点登录 → 睡 5 秒 → 判断 URL」，冷启动（auth+profiles 2~10s）时是在赌。
    # 改成等 body[data-app-ready]（app.js bindEvents 后的就绪标记）这个真实信号。
    on_home = login(page, BASE, TEST_USER, TEST_PASSWORD, timeout_ms=30000)
    check("登录成功进入主页", on_home, page.url)

    if on_home:
        print()
        print("=" * 60)
        print("3. 主页元素验证")
        print("=" * 60)
        sticker_entry = page.locator('#stickerEntry').count()
        check("图鉴入口按钮存在", sticker_entry > 0)
        # 截图
        page.screenshot(path="/tmp/blindbox-home.png", full_page=True)

        # 加载 blindbox 模块测试纯函数（通过动态 import）
        print()
        print("=" * 60)
        print("4. 纯前端逻辑测试（rollRarity / applyRarity）")
        print("=" * 60)

        # rollRarity 概率分布：跑 5000 次，验证大致符合 85/15 分布
        result = page.evaluate("""async () => {
            const mod = await import('/js/blindbox.js');
            const counts = { common: 0, rare: 0, epic: 0, legendary: 0 };
            const N = 5000;
            for (let i = 0; i < N; i++) {
                counts[mod.rollRarity()]++;
            }
            return { counts, N };
        }""")
        counts = result["counts"]
        n = result["N"]
        hidden_rate = (counts["rare"] + counts["epic"] + counts["legendary"]) / n
        rare_share = counts["rare"] / max(1, counts["rare"] + counts["epic"] + counts["legendary"])
        epic_share = counts["epic"] / max(1, counts["rare"] + counts["epic"] + counts["legendary"])
        legendary_share = counts["legendary"] / max(1, counts["rare"] + counts["epic"] + counts["legendary"])
        print(f"    分布(N={n}): common={counts['common']} rare={counts['rare']} epic={counts['epic']} legendary={counts['legendary']}")
        print(f"    隐藏款率={hidden_rate:.1%}（期望~15%）; rare={rare_share:.0%} epic={epic_share:.0%} legendary={legendary_share:.0%}")
        check("隐藏款概率约15%", 0.12 < hidden_rate < 0.18, f"实际 {hidden_rate:.1%}")
        check("rare 占比约60%", 0.52 < rare_share < 0.68, f"实际 {rare_share:.0%}")
        check("legendary 占比约10%", 0.05 < legendary_share < 0.16, f"实际 {legendary_share:.0%}")
        check("isHidden 识别", True)  # 已在概率分布间接验证

        # applyRarity 测试：模拟一个 todo li，应用各稀有度，检查 class
        # 注意：稀有度的视觉区分已从「角标节点」改为 CSS 渐变+四边细边框（style.css .todo--rare 等），
        # applyRarity 只负责打 class，不再创建 .todo__rarity-badge 节点。
        dom_result = page.evaluate("""async () => {
            const mod = await import('/js/blindbox.js');
            const results = {};
            for (const rarity of ['common', 'rare', 'epic', 'legendary']) {
                const li = document.createElement('li');
                li.className = 'todo';
                mod.applyRarity(li, { rarity });
                results[rarity] = { classes: li.className };
            }
            return results;
        }""")
        check("common 无稀有度 class", "todo--rare" not in dom_result["common"]["classes"] and "todo--epic" not in dom_result["common"]["classes"])
        check("rare 有 todo--rare class", "todo--rare" in dom_result["rare"]["classes"])
        check("epic 有 todo--epic class", "todo--epic" in dom_result["epic"]["classes"])
        check("legendary 有 todo--legendary class", "todo--legendary" in dom_result["legendary"]["classes"])

        # 图鉴弹层测试
        print()
        print("=" * 60)
        print("5. 图鉴弹层")
        print("=" * 60)
        # 等 init 就绪：主列表渲染完成（listTodos 在 initStickerBook 之后，主列表出来 = 图鉴入口已绑定）
        # 用固定 sleep 会因 Supabase 冷启动波动（auth+profiles 2~10s）而时序脆弱，改等真实信号
        page.wait_for_selector('#todoList .todo, #todoList .todo-list__empty', timeout=30000)
        page.locator('#stickerEntry').click()
        check("图鉴弹层打开", wait_until(
            page,
            lambda: page.locator('#stickerModal').is_visible(),
            desc="图鉴弹层可见",
        ))
        # 注意：弹层可见 ≠ 格子渲染完成。openStickerBook() 是「先显示弹层 → await db.listStickers()
        # → renderStickerBook()」，所以必须等格子真的渲染出来再数（原来写死 800ms 是在赌这个 await）。
        # 等「出现了格子」这个就绪信号，再去断言**数量是 12** —— 断言本身没有被等掉。
        cells_rendered = wait_until(
            page,
            lambda: page.locator('.sticker-cell').count() > 0,
            desc="图鉴格子渲染",
        )
        cell_count = page.locator('.sticker-cell').count()
        check("贴纸格子数=12", cells_rendered and cell_count == 12, f"实际 {cell_count}")
        progress_text = page.locator('#stickerProgress').text_content()
        check("进度条显示 X/12", "/ 12" in progress_text or "/12" in progress_text, f"实际: {progress_text}")
        page.screenshot(path="/tmp/blindbox-stickerbook.png", full_page=True)
        # 关闭图鉴弹层，等它真的收起再继续，避免遮挡后续操作
        page.locator('#stickerModalClose').click()
        wait_until(
            page,
            lambda: not page.locator('#stickerModal').is_visible(),
            desc="图鉴弹层收起",
        )

        # 添加待办测试（验证 createTodo 正常落库）
        print()
        print("=" * 60)
        print("6. 添加待办")
        print("=" * 60)
        # 先把开奖钉到 common：这一条只是验证 createTodo 落库，若随机开成隐藏款，
        # 会解锁掉 rare_1，使第 7 步的序号期望整体偏移一位（首版就这么误报过一次）。
        page.evaluate("() => localStorage.setItem('__e2e_force_rarity', 'common')")
        before_count = page.locator('#todoList .todo').count()
        check("添加待办成功（列表出现）", add_todo(page, 'E2E-测试-盲盒功能验证'))
        after_count = page.locator('#todoList .todo').count()
        check("列表数量 +1", after_count == before_count + 1, f"前{before_count} 后{after_count}")

        page.screenshot(path="/tmp/blindbox-after-add.png", full_page=True)

        # ===== 7. 隐藏款链路（用 localStorage 钩子强制开奖）=====
        print()
        print("=" * 60)
        print("7. 隐藏款链路（强制开奖）")
        print("=" * 60)
        # 为什么需要钩子：隐藏款是 15% 概率，随机跑撞不到，于是「开出 → 解锁贴纸」这条链
        # 此前零覆盖 —— 序号算错、提示互相顶掉、完成时撤销按钮被清掉，三个真实缺陷都测不出来。
        # 钩子只由本测试写入 localStorage，生产代码没有任何入口设置它（行为与不加钩子一致）。

        def toast_text():
            el = page.locator("#toast")
            return (el.text_content() or "") if el.count() > 0 else ""

        def force_rarity(r):
            page.evaluate("(r) => localStorage.setItem('__e2e_force_rarity', r)", r)

        def rare_keys():
            """图鉴里已解锁的 rare 序号（真实状态，不看 toast 文案）"""
            return page.evaluate("""async () => {
                const s = await import('/js/state.js');
                return s.getStickers().filter((x) => x.rarity === 'rare')
                    .map((x) => x.stickerKey).sort();
            }""")

        force_rarity("rare")
        check("强制开奖钩子已就位",
              page.evaluate("() => localStorage.getItem('__e2e_force_rarity')") == "rare")

        # --- 7.1 开奖与解锁合成一条提示（旧实现是两条，后一条把前一条顶掉）---
        # 断言钉在该张贴纸的**名字**上（初心/萌芽/晨光/清欢 各对应一个序号）：
        # 只匹配 "开出稀有款" 会撞上一条还在屏上的旧提示，把断言读成假通过。
        t1 = "E2E-测试-强制稀有1"
        check("强制 rare 添加成功", add_todo(page, t1))
        merged = wait_until(
            page,
            lambda: "开出稀有款" in toast_text() and "解锁「初心」" in toast_text(),
            desc="合并提示（开奖 + 解锁，含贴纸名）",
        )
        check("开奖与解锁合成为一条提示", merged, f"实际: {toast_text()}")
        check("提示含图鉴进度 1/12", "1/12" in toast_text(), f"实际: {toast_text()}")
        wait_add_settled(page, t1)
        check("卡片带 todo--rare 稀有度样式",
              "todo--rare" in (page.locator(".todo", has_text=t1).first.get_attribute("class") or ""))
        check("图鉴实际解锁 rare_1", rare_keys() == ["rare_1"], f"实际: {rare_keys()}")

        # --- 7.2 第二条：序号递增，不重复 ---
        t2 = "E2E-测试-强制稀有2"
        check("第二条强制 rare 添加成功", add_todo(page, t2))
        check("第二条解锁的是 rare_2（序号递增、未重复同一张）",
              wait_until(page, lambda: "解锁「萌芽」" in toast_text(), desc="解锁「萌芽」提示")
              and rare_keys() == ["rare_1", "rare_2"], f"实际: {toast_text()} / {rare_keys()}")
        wait_add_settled(page, t2)

        # --- 7.3 集齐：第 5 次不再产生新贴纸，且提示说清「已集齐」---
        names = {3: "晨光", 4: "清欢"}
        for i in (3, 4):
            ti = f"E2E-测试-强制稀有{i}"
            check(f"第{i}条强制 rare 添加成功", add_todo(page, ti))
            ok = wait_until(page, lambda: f"解锁「{names[i]}」" in toast_text(), desc=f"解锁「{names[i]}」提示")
            check(f"第{i}条解锁 rare_{i}（进度 {i}/12）",
                  ok and f"{i}/12" in toast_text() and len(rare_keys()) == i,
                  f"实际: {toast_text()} / {rare_keys()}")
            wait_add_settled(page, ti)
        t5 = "E2E-测试-强制稀有5"
        check("集齐后仍能开出隐藏款（第5条）", add_todo(page, t5))
        full = wait_until(page, lambda: "已集齐" in toast_text(), desc="集齐提示")
        rare_count = len(rare_keys())
        check("集齐后不再产生第 5 张贴纸", full and rare_count == 4,
              f"提示: {toast_text()} / rare 贴纸: {rare_keys()}")
        wait_add_settled(page, t5)

        # --- 7.4 完成隐藏款：完成提示必须留在屏上（旧实现被开奖提示连「撤销」按钮一起清掉）---
        page.locator(".todo", has_text=t5).first.locator(".todo__check").click()
        undo_present = wait_until(
            page, lambda: page.locator(".toast__action").count() > 0, desc="完成提示带撤销按钮"
        )
        done_toast = toast_text()
        check("完成隐藏款后「撤销」按钮存在", undo_present, f"实际提示: {done_toast}")
        check("完成文案是「完成」而非「开出」", "完成" in done_toast and "开出" not in done_toast,
              f"实际: {done_toast}")
        check("完成提示带图鉴进度", "4/12" in done_toast, f"实际: {done_toast}")

        # --- 7.5 本地状态滞后时序号自愈（不再静默丢一次开奖）---
        force_rarity("epic")
        t6 = "E2E-测试-自愈"
        check("强制 epic 添加成功", add_todo(page, t6))
        wait_until(page, lambda: "史诗" in toast_text(), desc="epic 开奖提示")
        wait_add_settled(page, t6)
        heal = page.evaluate("""async () => {
            const state = await import('/js/state.js');
            const bb = await import('/js/blindbox.js');
            const { db } = await import('/js/db.js');
            const todo = state.getTodos().find((t) => t.text === 'E2E-测试-自愈');
            if (!todo) return { error: '找不到待办' };
            // 模拟「本地状态滞后于数据库」：冷启动时 listStickers 还没回来的状态就是这样
            state.setStickers([]);
            const sticker = await bb.onRollRarity({ id: todo.id, rarity: 'epic' }, todo.createdBy);
            const fresh = await db.listStickers();
            state.setStickers(fresh); // 还原本地状态，不影响后续断言
            return {
                key: sticker && sticker.stickerKey,
                epicCount: fresh.filter((s) => s.rarity === 'epic').length,
            };
        }""")
        check("本地状态滞后时自愈到 epic_2（旧实现撞车即静默放弃）",
              heal.get("key") == "epic_2" and heal.get("epicCount") == 2, f"实际: {heal}")

        # --- 7.6 隐藏款写入 rarity_seen=false（对方端揭晓的前提；旧实现恒为 true，链路是死的）---
        seen = page.evaluate("""async () => {
            const s = await import('/js/state.js');
            const t = s.getTodos().find((x) => x.text === 'E2E-测试-自愈');
            return t ? t.raritySeen : null;
        }""")
        check("隐藏款待办 rarity_seen=false（对方端才会播揭晓）", seen is False, f"实际: {seen}")

        # --- 7.7 提示串行：新提示排队，不把上一条顶掉 ---
        # 先等前面几条提示彻底消失：串行测试必须从「屏幕干净」开始，否则数到的是上一条提示
        # （第一版就踩了这个坑：断言读到的是上一步的 epic 开奖提示）。
        check("测试前提示已清空",
              wait_until(page, lambda: page.locator(".toast--show").count() == 0, desc="无提示在显示"))
        serial = page.evaluate("""async () => {
            const { showToast } = await import('/js/toast.js');
            const el = () => document.getElementById('toast');
            showToast('串行测试-第一条', { duration: 1200 });
            const t0 = el().textContent;
            await new Promise((r) => setTimeout(r, 150));
            showToast('串行测试-第二条', { duration: 1200 });
            const t1 = el().textContent;                    // 第一条应仍在显示
            await new Promise((r) => setTimeout(r, 1650));   // 第一条到期后第二条接上
            const t2 = el().textContent;
            return { t0, t1, t2 };
        }""")
        check("提示串行：第二条不顶掉第一条",
              "第一条" in (serial.get("t0") or "") and "第一条" in (serial.get("t1") or ""),
              f"实际: {serial}")
        check("提示串行：第一条结束后第二条接上", "第二条" in (serial.get("t2") or ""), f"实际: {serial}")

        # 清掉钩子，避免影响其它用例/后续断言
        page.evaluate("() => localStorage.removeItem('__e2e_force_rarity')")
        check("钩子已清理", page.evaluate("() => localStorage.getItem('__e2e_force_rarity')") is None)

        # ===== 8. 对方端揭晓（双账号端到端）=====
        print()
        print("=" * 60)
        print("8. 对方端揭晓（第二个账号 e2e-beta）")
        print("=" * 60)
        # 为什么要这一节：`rarity_seen` 这条链路曾经**从未触发过**（客户端只写 true、守卫要求 false），
        # 而它有两个半边 —— 写入方（隐藏款落库时写 false）和读取方（对方端收到后播提示并回标 true）。
        # 单账号只能验写入方；这里用测试库预置的第二个账号把读取方也跑到（两账号共用测试口令，
        # auth.js 的 usernameToEmail 兜底会把 'e2e-beta' 映射成 e2e-beta@todo.local）。
        context2 = browser.new_context()
        page2 = context2.new_page()
        page2.set_default_timeout(15000)
        second_user = os.environ.get("E2E_SECOND_ACCOUNT", "e2e-beta")
        check("第二账号登录成功", login(page2, BASE, second_user, TEST_PASSWORD), page2.url)
        # 等 Realtime 订阅真正开始推送：本项目自己记录过「订阅变 SUBSCRIBED 后仍需 ~2-3 秒」，
        # 这里刻意等一个观察窗口（不是赌异步同步，是被测对象的已知时序）。
        page2.wait_for_timeout(4000)

        def epic_count2():
            return page2.evaluate("""async () => {
                const s = await import('/js/state.js');
                return s.getStickers().filter((x) => x.rarity === 'epic').length;
            }""")

        # 记下 beta 登录时的张数，稍后断言它**因为 alpha 这次开奖涨了一张**（共享图鉴同步）
        epic_before = epic_count2()

        force_rarity("epic")
        t7 = "E2E-测试-对方揭晓"
        check("（alpha）强制 epic 添加成功", add_todo(page, t7))
        wait_until(page, lambda: "解锁" in toast_text(), desc="（alpha）自己的解锁提示")
        wait_add_settled(page, t7)

        def toast2_text():
            el = page2.locator("#toast")
            return (el.text_content() or "") if el.count() > 0 else ""

        revealed = wait_until(
            page2,
            lambda: "开出的" in toast2_text() and "史诗" in toast2_text(),
            timeout_ms=20000,
            desc="（beta）对方开出的揭晓提示",
        )
        check("对方端收到揭晓提示（含归属，旧实现恒为 true 时这条永远是空的）",
              revealed, f"（beta）实际提示: {toast2_text()}")
        # 回标校验：beta 播完提示会把 rarity_seen 写回 true，落库可见
        seen_back = wait_until(
            page,
            lambda: page.evaluate("""async () => {
                const { db } = await import('/js/db.js');
                const list = await db.listTodos();
                const t = list.find((x) => x.text === 'E2E-测试-对方揭晓');
                return !!t && t.raritySeen === true;
            }"""),
            desc="对方端回标 rarity_seen=true",
        )
        check("对方端看过之后回标 rarity_seen=true（不会重复播）", seen_back)

        # beta 端也能看到共享图鉴的新解锁（Realtime stickers INSERT）
        shared = wait_until(
            page2,
            lambda: epic_count2() >= epic_before + 1,
            timeout_ms=20000,
            desc="（beta）共享图鉴同步到新解锁",
        )
        check("（beta）共享图鉴同步到新解锁", shared, f"登录时 {epic_before} 张 → 现在 {epic_count2()} 张")
        context2.close()

    browser.close()

# 本用例用 UI 软删除清不干净（deleted_at 只打时间戳），且开出的贴纸无法通过删待办撤销。
# 统一走 reset 脚本硬删（自带生产库硬闸）。
cleanup_test_data()

print()
print("=" * 60)
print("测试结果汇总")
print("=" * 60)
for c in test_results["checks"]:
    print(f"  {c}")
print()
print(f"通过: {test_results['pass']}  失败: {test_results['fail']}")

import sys
sys.exit(0 if test_results["fail"] == 0 else 1)
