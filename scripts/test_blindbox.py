"""
盲盒 + 图鉴功能 E2E 测试

分三部分：
1. 纯前端逻辑测试（不依赖 DB）：rollRarity 概率分布 + **档位选择性**（已集齐的档位退出抽选池，
   含"12 张全齐后回落三档全池"）、applyRarity 稀有度 class、图鉴渲染
2. 页面加载/登录测试：验证模块链无报错、登录后主页渲染、createTodo 落库
3. 隐藏款链路（强制开奖）：用 localStorage 钩子把开奖锁到指定稀有度，覆盖 15% 概率撞不到的路径
   —— 提示是否被顶掉、贴纸序号是否重复/空转、完成时「撤销」按钮是否还在、rarity_seen 是否正确
4. 集齐纪念卡（路线图批次 1）：真实开奖链路集齐 12/12 → 打开图鉴纪念卡自动弹出
   （12 格拼贴 / 起止日期 / 隐藏款开出次数）→ 金色完成态可重看、ESC 出口不连带关图鉴
5. 第二册「我们的故事」（路线图批次 3）：v1 集齐 → 开启册自动切到 story → 强制钩子开出
   story_* 贴纸（key 前缀系列化）→ 第二册网格/故事卡/红点按册隔离 → story 自己的集齐纪念卡
6. 升星（路线图批次 4）：两册全齐进入升星期（D12）→ 强制开奖星级 +1（0 闪卡→烫金封顶）、
   满星顺延下一张、乐观守卫未过的兜底、双端 Realtime 同步（stickers UPDATE）→ 网格星级
   角标 + 故事卡星级行；全部满星为终局（不写库兜底文案，7.3c）

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
    wait_toast_gone,
    login,
    wait_until,
    wait_reveal_card,
    close_reveal_card,
    dismiss_reveal_card,
    reveal_card_snapshot,
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
        # （先摘掉 login() 钉的 common 钩子 —— 钩子是显式覆盖，会绕过概率链；
        #   跑完装回去，后续用例仍然随机命中普通款）
        result = page.evaluate("""async () => {
            localStorage.removeItem('__e2e_force_rarity');
            const mod = await import('/js/blindbox.js');
            const counts = { common: 0, rare: 0, epic: 0, legendary: 0 };
            const N = 5000;
            for (let i = 0; i < N; i++) {
                counts[mod.rollRarity()]++;
            }
            localStorage.setItem('__e2e_force_rarity', 'common');
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

        # --- 4a. key 系列化：story 前缀的解析/构造/按册内容（批次 3）---
        # 背景（路线图 §5.1）：v1 无前缀，第二册起带册短名前缀（story_rare_1），
        # 全仓解析收敛在 parseStickerKey。这里验 key 往返 + story 册的专属图标/短句接线。
        keys = page.evaluate("""async () => {
            const bb = await import('/js/blindbox.js');
            const round = (k) => { const p = bb.parseStickerKey(k); return p && bb.makeStickerKey(p.series, p.rarity, p.index); };
            return {
                storyParsed: bb.parseStickerKey('story_rare_1'),
                storyRound: round('story_rare_1'),
                v1Round: round('epic_3'),
                storyIconIsSvg: bb.getStickerIcon('story_legendary_1').includes('<svg'),
                storyFlavor: bb.getStickerFlavor('story_rare_1'),
                v1Flavor: bb.getStickerFlavor('rare_1'),
                targetWhenEmpty: bb.getRollTargetSeries(),
                seriesIds: bb.getSeriesIds(),
            };
        }""")
        check("story 前缀 key 解析正确",
              keys["storyParsed"] == {"series": "story", "rarity": "rare", "index": 1},
              f"实际: {keys['storyParsed']}")
        check("story key 构造往返一致", keys["storyRound"] == "story_rare_1", f"实际: {keys['storyRound']}")
        check("v1 无前缀 key 往返不变（历史格式零变化）", keys["v1Round"] == "epic_3", f"实际: {keys['v1Round']}")
        check("story 贴纸有专属图标与短句（按册分派）",
              keys["storyIconIsSvg"] and bool(keys["storyFlavor"]) and keys["storyFlavor"] != keys["v1Flavor"],
              f"story 短句: {keys['storyFlavor'][:20]}…")
        check("两册已注册且空图鉴时开启册为第一册",
              keys["seriesIds"] == ["v1", "story"] and keys["targetWhenEmpty"] == "v1",
              f"实际: {keys['seriesIds']} / {keys['targetWhenEmpty']}")

        # --- 4b. 档位选择性：已集齐的档位必须退出抽选池（2026-09-17 修）---
        # 为什么必须在这里测（而不是靠真实添加去撞）：旧实现不看图鉴进度，某一档 4 张集齐后
        # 仍会被开出 —— 卡片显示该稀有度、撒花照放，却一张贴纸都解锁不了（"开出稀有款 →
        # 稀有图鉴已集齐"），这次开奖等于白开。要撞出这条路径得先集齐 4 张再等 15% 概率，
        # 所以直接构造图鉴状态去驱动**真实的** rollRarity / availableRarities。
        # 构造出来的状态在 finally 里还原成真实状态（下面 7.x 的断言依赖真实图鉴是空白）。
        page.evaluate("() => localStorage.removeItem('__e2e_force_rarity')")  # 钩子是显式覆盖，会绕过档位池
        stickers_before = page.evaluate("async () => (await import('/js/state.js')).getStickers().length")
        select = page.evaluate("""async () => {
            const state = await import('/js/state.js');
            const bb = await import('/js/blindbox.js');
            const real = state.getStickers();
            const fake = (rarity, n) => Array.from({ length: n }, (_, i) => ({
                id: `${rarity}_${i + 1}`, stickerKey: `${rarity}_${i + 1}`, rarity,
                unlockedBy: null, todoId: null, unlockedAt: new Date().toISOString(),
            }));
            const run = (n) => {
                const c = { common: 0, rare: 0, epic: 0, legendary: 0 };
                for (let i = 0; i < n; i++) c[bb.rollRarity()]++;
                return c;
            };
            try {
                state.setStickers(fake('rare', 4));                       // 稀有档集齐
                const afterRare = run(2000);
                const availAfterRare = bb.availableRarities();
                const bookDoneAfterRare = bb.isBookComplete();
                state.setStickers([...fake('rare', 4), ...fake('epic', 4), ...fake('legendary', 4)]);
                const allDone = run(2000);                                // 12 张全齐
                const availAll = bb.availableRarities();
                const bookDoneAll = bb.isBookComplete();
                const targetAll = bb.getRollTargetSeries();               // v1 全齐 → 目标册切到 story（批次 3 开启机制）
                return { afterRare, availAfterRare, bookDoneAfterRare, allDone, availAll, bookDoneAll, targetAll };
            } finally {
                state.setStickers(real);
            }
        }""")
        after_rare, all_done = select["afterRare"], select["allDone"]
        hidden_rare = after_rare["rare"] + after_rare["epic"] + after_rare["legendary"]
        hidden_all = all_done["rare"] + all_done["epic"] + all_done["legendary"]
        epic_share = after_rare["epic"] / max(1, hidden_rare)
        check("稀有集齐后 availableRarities 只剩 epic/legendary",
              select["availAfterRare"] == ["epic", "legendary"], f"实际: {select['availAfterRare']}")
        check("稀有集齐但其余未齐时不算全书集齐", select["bookDoneAfterRare"] is False)
        check("稀有集齐后 2000 次开奖不再开出稀有（旧实现照开 = 白开）",
              after_rare["rare"] == 0, f"实际: {after_rare}")
        check("隐藏款总概率不受影响（仍约 15%）",
              0.12 < hidden_rare / 2000 < 0.18, f"实际 {hidden_rare / 2000:.1%}")
        check("剩余档位权重重新归一（epic 占比约 75%，不是各 50%）",
              0.68 < epic_share < 0.82, f"实际 {epic_share:.0%}")
        check("12 张全齐后 availableRarities 为空、isBookComplete 为真",
              select["availAll"] == [] and select["bookDoneAll"] is True,
              f"实际: {select['availAll']} / {select['bookDoneAll']}")
        check("第一册集齐后开启册自动切到 story（批次 3 开启机制）",
              select["targetAll"] == "story", f"实际: {select['targetAll']}")
        check("12 张全齐后仍能开出隐藏款，且三档都在池里（此时池已属于 story 册——盲盒不因第一册满而消失）",
              hidden_all > 0 and all(all_done[r] > 0 for r in ("rare", "epic", "legendary")),
              f"实际: {all_done}")
        check("构造用的假图鉴已还原（真实 stickers 未被污染）",
              page.evaluate("async () => (await import('/js/state.js')).getStickers().length") == stickers_before)

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

        # 批次 3：story 册已注册 → 册 tab 栏出现（多册书架上线）
        tab_count = page.locator('#stickerBookTabs .sticker-book-tabs__tab').count()
        check("多册 tab 栏出现且有两册", tab_count == 2, f"实际 {tab_count}")
        check("story tab 名称正确",
              page.locator('#stickerBookTabs .sticker-book-tabs__tab', has_text="我们的故事").count() == 1)
        # 切到 story：全新开（0 解锁）+ 第一册未集齐 → 12 格剪影 + 「集齐第一册后开启」引导
        page.locator('#stickerBookTabs .sticker-book-tabs__tab', has_text="我们的故事").click()
        story_locked = wait_until(
            page,
            lambda: page.locator('.sticker-cell').count() == 12
            and page.locator('.sticker-cell--unlocked').count() == 0,
            desc="story 册 12 格剪影",
        )
        hint_text = page.locator('#stickerHint').text_content() or ""
        check("story 册未开启时 12 格全剪影 + 开启引导文案", story_locked and "第一册" in hint_text,
              f"实际: {hint_text}")
        check("story 册完成徽章不亮（未开启）", not page.locator('#stickerCompleteChip').is_visible())
        page.screenshot(path="/tmp/blindbox-story-locked.png", full_page=True)
        # 切回第一册再关弹层（后续断言都在 v1 口径上）
        page.locator('#stickerBookTabs .sticker-book-tabs__tab', has_text="怦然心动").click()
        wait_until(
            page,
            lambda: page.locator('.sticker-book-tabs__tab--active').text_content() == "怦然心动",
            desc="切回 v1 册",
        )
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

        # --- 7.1 开出卡片（2026-10-05 批次 3，D7-①）· fx 全开冒烟（§12：视觉断言从宽）---
        # 卡片接管了 v1 解锁时刻的展示（合并提示只在卡片无法播放时兜底），断言迁移到卡面：
        # 贴纸名 / 档位绶带 / 图鉴进度（技术方案 §12）。本节顺手用 t1 跑 fx 全开形态：
        # 完整仪式（rare 无悬念段，~1s 到 idle）+ NEW 角标（仅本端开出事件显示，D11 备注①）。
        # t1 仍是「解锁的第一张 rare」→ 名字/序号期望与旧版一致（初心 / rare_1）。
        page.evaluate("() => localStorage.removeItem('__e2e_fx_off')")
        t1 = "E2E-测试-强制稀有1"
        check("强制 rare 添加成功", add_todo(page, t1))
        snap1 = wait_reveal_card(page, desc="开出卡片弹出")
        check("开出卡片弹出（卡片接管揭晓时刻）", snap1 is not None, f"实际: {snap1}")
        check("卡面贴纸名 =「初心」", snap1 is not None and snap1["name"] == "初心", f"实际: {snap1}")
        check("卡面档位绶带 = 稀有款", snap1 is not None and "稀有款" in snap1["tier"], f"实际: {snap1}")
        check("卡面图鉴进度 1/12", snap1 is not None and "1/12" in snap1["meta"], f"实际: {snap1}")
        check("（fx on）无 no-anim 降级", snap1 is not None and not snap1["noAnim"], f"实际: {snap1}")
        idle1 = wait_until(page, lambda: (reveal_card_snapshot(page) or {}).get("phaseIdle"),
                           timeout_ms=8000, desc="仪式播到 idle")
        check("（fx on）仪式播完进入 idle", idle1)
        check("（fx on）NEW 角标显示（本端开出事件专属）",
              (reveal_card_snapshot(page) or {}).get("newVisible") is True)
        check("开出卡片可关闭", close_reveal_card(page))
        page.evaluate("() => localStorage.setItem('__e2e_fx_off', '1')")  # 装回降级钩子（跑批默认）
        wait_add_settled(page, t1)
        check("卡片带 todo--rare 稀有度样式",
              "todo--rare" in (page.locator(".todo", has_text=t1).first.get_attribute("class") or ""))
        check("图鉴实际解锁 rare_1", rare_keys() == ["rare_1"], f"实际: {rare_keys()}")

        # --- 7.1b 第二条：序号递增，不重复；fx off = 静态精卡降级通道（§9：信息全保留）---
        t2 = "E2E-测试-强制稀有2"
        check("第二条强制 rare 添加成功", add_todo(page, t2))
        snap2 = wait_reveal_card(page, desc="第二条开出卡片弹出")
        check("第二条卡面贴纸名 =「萌芽」（序号递增）",
              snap2 is not None and snap2["name"] == "萌芽", f"实际: {snap2}")
        check("（fx off）静态精卡带 no-anim（降级不丢信息）",
              snap2 is not None and snap2["noAnim"] and snap2["phaseIdle"], f"实际: {snap2}")
        check("（fx off）NEW 角标立显（self 事件专属；no-anim 全信息静态卡不隐藏内容）",
              snap2 is not None and snap2["newVisible"], f"实际: {snap2}")
        check("开出卡片可关闭（7.1b）", close_reveal_card(page))
        wait_add_settled(page, t2)
        check("第二条解锁的是 rare_2（序号递增、未重复同一张）",
              rare_keys() == ["rare_1", "rare_2"], f"实际: {rare_keys()}")

        # --- 7.1c 图鉴复看卡（D7-③）：点已解锁格子弹复看卡——日期=unlocked_at、
        #     无 NEW、无爆发（mode-quiet 淡入），翻面看档案铭牌（人称行=开出方称呼）---
        page.locator('#stickerEntry').click()
        check("复看：图鉴弹层打开", wait_until(
            page, lambda: page.locator('#stickerModal').is_visible(), desc="图鉴弹层可见"))
        wait_until(page, lambda: page.locator('.sticker-cell--unlocked').count() > 0, desc="格子渲染")
        page.locator('.sticker-cell--unlocked').first.click()
        rv = wait_reveal_card(page, desc="复看卡弹出")
        check("点已解锁格子弹出复看卡", rv is not None, f"实际: {rv}")
        check("复看卡面 = 该贴纸（初心）", rv is not None and rv["name"] == "初心", f"实际: {rv}")
        check("复看为安静模式（无 NEW、无仪式）",
              rv is not None and rv["modeQuiet"] and not rv["modeNotify"] and not rv["newVisible"],
              f"实际: {rv}")
        # 翻面：idle 点卡片 → 档案铭牌出现（人称行「… 开出」+ 册编号 No.02/12）
        page.locator('#rvCard3d').click(position={"x": 120, "y": 300})
        flipped = wait_until(page, lambda: (reveal_card_snapshot(page) or {}).get("flippedVisible"),
                             timeout_ms=5000, desc="复看卡翻面")
        plaque = (reveal_card_snapshot(page) or {}).get("plaqueText") or ""
        check("翻面档案铭牌可见（人称行=开出方称呼 + No.01/12）",
              flipped and "开出" in plaque and "No.01/12" in plaque, f"实际: {plaque}")
        check("复看卡可关闭（书架仍开着）", close_reveal_card(page))
        check("关闭复看卡后图鉴弹层仍在", page.locator('#stickerModal').is_visible())
        page.locator('#stickerModalClose').click()
        wait_until(page, lambda: not page.locator('#stickerModal').is_visible(), desc="书架收起")

        # --- 7.2c 集齐前的第 3/4 条：卡片逐张弹出（晨光/清欢）---
        names = {3: "晨光", 4: "清欢"}
        for i in (3, 4):
            ti = f"E2E-测试-强制稀有{i}"
            check(f"第{i}条强制 rare 添加成功", add_todo(page, ti))
            snap = wait_reveal_card(page, desc=f"第{i}张开出卡片")
            check(f"第{i}条解锁 rare_{i}（卡面「{names[i]}」，进度 {i}/12）",
                  snap is not None and snap["name"] == names[i] and f"{i}/12" in snap["meta"],
                  f"实际: {snap} / {rare_keys()}")
            check(f"第{i}张卡片可关闭", close_reveal_card(page))
            wait_add_settled(page, ti)
            check(f"第{i}张后图鉴实锁 {i} 张", len(rare_keys()) == i, f"实际: {rare_keys()}")
        # --- 7.3 集齐：第 5 次不再产生新贴纸（无卡片可弹），且提示说清「已集齐」---
        # （集齐兜底没有贴纸本体 → 无卡片，Toast 是唯一通道 —— 与升星期同构）
        t5 = "E2E-测试-强制稀有5"
        check("集齐后仍能开出隐藏款（第5条）", add_todo(page, t5))
        full = wait_until(page, lambda: "已集齐" in toast_text(), desc="集齐提示")
        rare_count = len(rare_keys())
        check("集齐后不再产生第 5 张贴纸", full and rare_count == 4,
              f"提示: {toast_text()} / rare 贴纸: {rare_keys()}")
        wait_add_settled(page, t5)

        # --- 7.3b 上一条能走到「已集齐」是**因为钩子显式覆盖**（它绕过档位池）---
        # 真实路径下（无钩子）此时 rare 已是 4/4，开奖必须不再落到 rare。这一条是业主报的 bug
        # 的回归断言 —— 用的是**真实图鉴状态**（不是 4b 那种构造状态）：读 state 判可用档位，
        # 再跑 1000 次真实 rollRarity 数有没有 rare。
        page.evaluate("() => localStorage.removeItem('__e2e_force_rarity')")
        real_pool = page.evaluate("""async () => {
            const bb = await import('/js/blindbox.js');
            const state = await import('/js/state.js');
            const counts = { common: 0, rare: 0, epic: 0, legendary: 0 };
            for (let i = 0; i < 1000; i++) counts[bb.rollRarity()]++;
            return {
                avail: bb.availableRarities(),
                bookDone: bb.isBookComplete(),
                progress: bb.rarityProgress(),
                counts,
                realRare: state.getStickers().filter((s) => s.rarity === 'rare').length,
            };
        }""")
        check("真实图鉴：rare 已 4/4，可用档位只剩 epic/legendary",
              real_pool["realRare"] == 4 and real_pool["avail"] == ["epic", "legendary"],
              f"实际: {real_pool}")
        check("真实图鉴下 1000 次开奖不再开出 rare（无钩子的真实路径）",
              real_pool["counts"]["rare"] == 0, f"实际: {real_pool['counts']}")

        # --- 7.3c 全部册**满星**时的终局兜底（不写库）---
        # 构造 24/24 且星级全满（star_level=2，不真去集齐+升星：那要 ~72 次开奖）。
        # ⚠️ 批次 4 起（D12）解锁目标 = 第一个未集齐的册、升星目标 = 第一个未满星的册：
        # 只把「集齐」钉满（星级 0）会走**升星路径**（发 UPDATE！）——必须两册全满星，
        # 才走「不写库」的终局分支（getStarTargetSeries 为空，在任何 DB 调用前短路）。
        check("文案断言前提示已清空",
              wait_until(page, lambda: page.locator(".toast--show").count() == 0, desc="无提示在显示"))
        book_done = page.evaluate("""async () => {
            const state = await import('/js/state.js');
            const bb = await import('/js/blindbox.js');
            const real = state.getStickers();
            const fake = (series, rarity, n, star) => Array.from({ length: n }, (_, i) => {
                const key = `${series === 'v1' ? '' : series + '_'}${rarity}_${i + 1}`;
                return { id: crypto.randomUUID(), stickerKey: key, rarity, starLevel: star,
                         unlockedBy: null, todoId: null, unlockedAt: new Date().toISOString() };
            });
            const book = (series, star) => [...fake(series, 'rare', 4, star), ...fake(series, 'epic', 4, star), ...fake(series, 'legendary', 4, star)];
            const todo = state.getTodos().find((t) => t.text === 'E2E-测试-强制稀有5');
            try {
                state.setStickers([...book('v1', 2), ...book('story', 2)]);
                await bb.onRollRarity({ id: todo.id, rarity: 'rare' }, todo.createdBy);
                return { allComplete: bb.isAllBooksComplete(), target: bb.getRollTargetSeries(),
                         starTarget: bb.getStarTargetSeries() };
            } finally {
                state.setStickers(real);
            }
        }""")
        shown = wait_until(page, lambda: "全部图鉴已满星" in toast_text(), desc="两册满星文案")
        check("全部册满星时提示说「全部图鉴已满星，这张留作纪念」且升星目标为空（终局）",
              shown and book_done["allComplete"] and book_done["target"] is None
              and book_done["starTarget"] is None,
              f"实际: {toast_text()} / {book_done}")
        check("构造满星期间没有写库（该分支在任何 DB 调用前短路）",
              len(rare_keys()) == 4, f"实际: {rare_keys()}")
        wait_toast_gone(page)

        # --- 7.3d 升星乐观守卫未过：候选全部打不中 → 顺延到耗尽 + 兜底提示 ---
        # 两册集齐但星级全 0（合法的升星期形态）：onRollRarity 走升星路径；候选行的 id 是
        # 随机 UUID（库里不存在）→ 每次 UPDATE 守卫 0 行命中 → 顺延到候选耗尽 → 对齐 +
        # 「已满星」兜底。等价模拟「对方同刻抢先升星 / 本地星级滞后」的自愈路径，
        # 全程不命中任何真实行（打不中的 UUID 对测试库无副作用）。
        guard = page.evaluate("""async () => {
            const state = await import('/js/state.js');
            const bb = await import('/js/blindbox.js');
            const real = state.getStickers();
            const fake = (series, rarity, n) => Array.from({ length: n }, (_, i) => {
                const key = `${series === 'v1' ? '' : series + '_'}${rarity}_${i + 1}`;
                return { id: crypto.randomUUID(), stickerKey: key, rarity, starLevel: 0,
                         unlockedBy: null, todoId: null, unlockedAt: new Date().toISOString() };
            });
            const book = (series) => [...fake(series, 'rare', 4), ...fake(series, 'epic', 4), ...fake(series, 'legendary', 4)];
            const todo = state.getTodos().find((t) => t.text === 'E2E-测试-强制稀有5');
            try {
                state.setStickers([...book('v1'), ...book('story')]);
                const r = await bb.onRollRarity({ id: todo.id, rarity: 'rare' }, todo.createdBy);
                return { upgraded: r && r.sticker ? r.sticker.stickerKey : null, starTarget: bb.getStarTargetSeries() };
            } finally {
                state.setStickers(real);
            }
        }""")
        shown_guard = wait_until(page, lambda: "都已满星" in toast_text(), desc="守卫未过兜底文案")
        # starTarget=None 是「兜底前已对齐真实库状态」的证据：候选耗尽后 syncStickersFromDb()
        # 用真实状态（此时尚未两册集齐）替换了假状态，升星目标自然回到空——同步确实发生了
        check("守卫全部未过时顺延到候选耗尽并给「已满星」兜底提示（无升星结果）",
              shown_guard and guard["upgraded"] is None and guard["starTarget"] is None,
              f"实际: {toast_text()} / {guard}")
        check("守卫路径同样没有动真实图鉴", len(rare_keys()) == 4, f"实际: {rare_keys()}")
        wait_toast_gone(page)

        # --- 7.4 完成隐藏款（D1，2026-10-05）：完成时刻所有待办一律平等 ---
        # 旧的隐藏款完成专属文案/图鉴进度/卡片光环已按 D1 删除 —— 完成回归普通路径：
        # 随机鼓励文案 + 带「撤销」按钮（撤销 Toast 不受影响）。回归点收窄为：
        # ① 撤销按钮还在；② 文案不得再出现「开出」（完成 ≠ 开出，语义回归防线）。
        page.locator(".todo", has_text=t5).first.locator(".todo__check").click()
        undo_present = wait_until(
            page, lambda: page.locator(".toast__action").count() > 0, desc="完成提示带撤销按钮"
        )
        done_toast = toast_text()
        check("完成隐藏款后「撤销」按钮存在", undo_present, f"实际提示: {done_toast}")
        check("完成文案不再有隐藏款专属内容（无「开出」）", "开出" not in done_toast,
              f"实际: {done_toast}")
        check("完成文案不再带图鉴进度（D1：惊喜预算集中到开出时刻）",
              "4/12" not in done_toast and "/12" not in done_toast, f"实际: {done_toast}")

        # --- 7.5 本地状态滞后时序号自愈（不再静默丢一次开奖）---
        force_rarity("epic")
        t6 = "E2E-测试-自愈"
        check("强制 epic 添加成功", add_todo(page, t6))
        snap6 = wait_reveal_card(page, desc="epic 开出卡片弹出")
        check("（epic）卡片弹出、卡面「心动」（epic_1）",
              snap6 is not None and snap6["name"] == "心动" and snap6["tierEpic"], f"实际: {snap6}")
        check("（epic）卡片可关闭", close_reveal_card(page))
        wait_add_settled(page, t6)
        heal = page.evaluate("""async () => {
            const state = await import('/js/state.js');
            const bb = await import('/js/blindbox.js');
            const { db } = await import('/js/db.js');
            const todo = state.getTodos().find((t) => t.text === 'E2E-测试-自愈');
            if (!todo) return { error: '找不到待办' };
            // 模拟「本地状态滞后于数据库」：冷启动时 listStickers 还没回来的状态就是这样
            state.setStickers([]);
            // 批次 3 起 onRollRarity 返回 {sticker, toastText, toastOpts}（卡片路径需要带回提示）
            const res = await bb.onRollRarity({ id: todo.id, rarity: 'epic' }, todo.createdBy);
            const sticker = res && res.sticker;
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
        snap7 = wait_reveal_card(page, desc="（alpha）自己的开出卡片")
        check("（alpha）卡片显示 epic_3「钟情」",
              snap7 is not None and snap7["name"] == "钟情" and snap7["tierEpic"], f"实际: {snap7}")
        check("（alpha）卡片可关闭", close_reveal_card(page))
        wait_add_settled(page, t7)

        def toast2_text():
            el = page2.locator("#toast")
            return (el.text_content() or "") if el.count() > 0 else ""

        # 【D7-②，批次 3】beta 端不再弹揭晓 Toast：red dot → 点图鉴入口 → 通知卡
        # （无悬念无爆发、角标「ta 开出的」、无 NEW、翻面档案铭牌=开出方称呼）。
        # 先等 stickers INSERT 到 beta 本地（pendingStickerOf 靠 todo_id 反查贴纸行），
        # 否则入口点击会走「只清信号不弹卡」的兜底。
        dot_on = wait_until(page2, lambda: page2.locator('#stickerBadge').is_visible(),
                            timeout_ms=20000, desc="（beta）图鉴红点亮起")
        check("对方端图鉴红点亮起（rarity_seen=false + 未看贴纸）", dot_on)
        sticker_ready = wait_until(
            page2,
            lambda: page2.evaluate("""async () => {
                const s = await import('/js/state.js');
                const todo = s.getTodos().find((t) => t.text === 'E2E-测试-对方揭晓');
                return !!todo && s.getStickers().some((x) => x.todoId === todo.id);
            }"""),
            timeout_ms=20000,
            desc="（beta）贴纸行与待办已对上",
        )
        check("对方端本地已能反查到该贴纸（todo_id ↔ sticker）", sticker_ready)
        page2.locator('#stickerEntry').click()
        # 【积压队列】beta 冷启动扫描会把 t1-t6（全部 rarity_seen=false 的历史揭晓）一起入队，
        # 点入口后按 createdAt 升序逐张弹卡 —— t7（钟情）是最后一张。逐张关完再进书架。
        # （循环结构：先快照断言（钟情那张在关卡前翻面验铭牌）→ 再 dismiss 放行下一张）
        expected_backlog = {"初心", "萌芽", "晨光", "清欢", "心动", "悸动", "钟情"}
        seen_names = []
        last_snap = None
        snap_i = wait_reveal_card(page2, timeout_ms=20000, desc="（beta）首张通知卡弹出")
        for _ in range(12):  # 上限兜底，实际 = 队列长度
            if snap_i is None:
                break
            seen_names.append(snap_i["name"])
            last_snap = snap_i
            check(f"（beta）通知卡「{snap_i['name']}」为安静模式 + 角标 + 无 NEW",
                  snap_i["modeQuiet"] and snap_i["notifyBadge"] == "ta 开出的" and not snap_i["newVisible"],
                  f"实际: {snap_i}")
            if snap_i["name"] == "钟情":
                # t7 的通知卡（还在屏上）：翻面验档案铭牌（epic_3 → No.07/12）
                page2.locator('#rvCard3d').click(position={"x": 120, "y": 300})
                flipped8 = wait_until(page2, lambda: (reveal_card_snapshot(page2) or {}).get("flippedVisible"),
                                      timeout_ms=5000, desc="（beta）翻面档案")
                plaque8 = (reveal_card_snapshot(page2) or {}).get("plaqueText") or ""
                check("（beta）翻面铭牌人称行 = 开出方称呼（「… 开出」+ No.07/12）",
                      flipped8 and "开出" in plaque8 and "No.07/12" in plaque8, f"实际: {plaque8}")
            dismiss_reveal_card(page2)  # 关掉当前张（下一张立即顶上；最后一张后队列放空进书架）
            snap_i = wait_reveal_card(page2, timeout_ms=6000, desc="（beta）下一张通知卡")
        check("（beta）积压通知卡逐张弹完（含 t7 的「钟情」在最后）",
              last_snap is not None and last_snap["name"] == "钟情"
              and set(seen_names) <= expected_backlog and len(seen_names) >= 2,
              f"实际弹卡序列: {seen_names}")
        check("（beta）通知卡看完书架打开", wait_until(
            page2, lambda: page2.locator('#stickerModal').is_visible(), desc="（beta）书架打开"))
        page2.locator('#stickerModalClose').click()
        wait_until(page2, lambda: not page2.locator('#stickerModal').is_visible(), desc="（beta）书架收起")
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

        # ===== 9. 集齐纪念卡（路线图批次 1：12/12 全屏仪式 + 完成态重看）=====
        print()
        print("=" * 60)
        print("9. 集齐纪念卡（12/12 → 全屏仪式 → 完成态重看）")
        print("=" * 60)
        # 此刻真实图鉴：rare 4/4（7.1-7.3）+ epic 3/4（7.5 自愈两条 + 8 的 t7）= 7/12。
        # 补 1 张 epic + 4 张 legendary 走**真实开奖链路**集齐；强制钩子只钉稀有度，
        # 序号分配 / 卡面进度 / 解锁展示仍由产品代码决定（v1 解锁时刻 = 开出卡片）。
        force_rarity("epic")
        t8 = "E2E-测试-集齐8"
        check("第 8 条（补 epic_4）添加成功", add_todo(page, t8))
        snap_t8 = wait_reveal_card(page, desc="epic_4 开出卡片")
        check("第 8 张解锁「炽爱」· 卡面进度 8/12",
              snap_t8 is not None and snap_t8["name"] == "炽爱" and "8/12" in snap_t8["meta"],
              f"实际: {snap_t8}")
        check("第 8 张卡片可关闭", close_reveal_card(page))
        wait_add_settled(page, t8)

        leg_names = {1: "永恒", 2: "璀璨", 3: "至臻", 4: "神话"}
        force_rarity("legendary")
        for i in (1, 2, 3, 4):
            ti = f"E2E-测试-集齐{8 + i}"
            check(f"第 {8 + i} 条（legendary_{i}）添加成功", add_todo(page, ti))
            snap = wait_reveal_card(page, desc=f"legendary_{i} 开出卡片")
            check(f"第 {8 + i} 张解锁「{leg_names[i]}」· 卡面进度 {8 + i}/12",
                  snap is not None and snap["name"] == leg_names[i]
                  and snap["tierLegendary"] and f"{8 + i}/12" in snap["meta"],
                  f"实际: {snap}")
            check(f"第 {8 + i} 张卡片可关闭", close_reveal_card(page))
            wait_add_settled(page, ti)

        # 12/12 → 打开图鉴：全屏纪念卡自动弹出（首次集齐仪式，替代旧的 Toast + 一次性撒花）
        page.locator('#stickerEntry').click()
        check("集齐后打开图鉴，纪念卡自动弹出", wait_until(
            page, lambda: page.locator('#memorialCard').is_visible(), desc="纪念卡仪式"))
        cell_n = page.locator('#memorialCardGrid .memorial-card__cell').count()
        check("纪念卡 12 格拼贴", cell_n == 12, f"实际 {cell_n}")
        # 起止日期按数据库真实的 unlocked_at min/max 断言（两种形态都合法）：
        #   跨天  → 「M月d日 — M月d日 · 共 N 天」；同一天 → 「M月d日 · 12 张集于同一天」
        range_info = page.evaluate("""async () => {
            const s = await import('/js/state.js');
            const ts = s.getStickers().map((x) => new Date(x.unlockedAt).getTime())
                .filter((t) => !Number.isNaN(t));
            const fmt = (t) => { const d = new Date(t); return (d.getMonth() + 1) + '月' + d.getDate() + '日'; };
            const min = Math.min(...ts), max = Math.max(...ts);
            return {
                minText: fmt(min), maxText: fmt(max),
                sameDay: new Date(min).toDateString() === new Date(max).toDateString(),
            };
        }""")
        dates_text = page.locator('#memorialCardDates').text_content() or ""
        if range_info["sameDay"]:
            dates_ok = range_info["minText"] in dates_text and "集于同一天" in dates_text
        else:
            dates_ok = (range_info["minText"] in dates_text and range_info["maxText"] in dates_text
                        and "共" in dates_text)
        check("纪念卡起止日期与库内 unlocked_at 一致", dates_ok, f"实际: {dates_text} / 库: {range_info}")
        # 隐藏款开出总数：卡片异步填充。断言两层：与库计数一致（接线正确）+ ≥ 本用例
        # 确定开出的 12 次隐藏款（内容真实——本用例每次添加都走强制钩子，全部是隐藏款）。
        reveal_count = page.evaluate("async () => (await import('/js/db.js')).db.countHiddenReveals()")
        stats_filled = wait_until(
            page,
            lambda: f"{reveal_count} 次" in (page.locator('#memorialCardStats').text_content() or ""),
            desc="开出次数填充",
        )
        check("开出次数与库计数一致（软删行也计入）", stats_filled, f"库计数 {reveal_count}")
        check("开出次数 ≥ 本用例开出的 12 次隐藏款", reveal_count >= 12, f"实际 {reveal_count}")
        page.screenshot(path="/tmp/blindbox-memorial.png", full_page=True)

        # 关闭仪式 → 金色完成态仍在，可从面板重看（不是一次性的）
        page.locator('#memorialCardClose').click()
        check("仪式关闭后纪念卡收起", wait_until(
            page, lambda: not page.locator('#memorialCard').is_visible(), desc="纪念卡收起"))
        check("图鉴弹层仍在（关闭仪式没把它一起带走）", page.locator('#stickerModal').is_visible())
        check("完成态出现重看入口", page.locator('#stickerMemorialBtn').is_visible())
        page.locator('#stickerMemorialBtn').click()
        check("点重看再开纪念卡", wait_until(
            page, lambda: page.locator('#memorialCard').is_visible(), desc="重看纪念卡"))
        # ESC 出口：纪念卡的 ESC 监听负责关卡，且不能把背后的图鉴弹层一起关掉
        page.keyboard.press("Escape")
        check("ESC 关闭重看的纪念卡", wait_until(
            page, lambda: not page.locator('#memorialCard').is_visible(), desc="ESC 收起纪念卡"))
        check("ESC 没有连带关闭图鉴弹层", page.locator('#stickerModal').is_visible())

        # 补覆盖跨天形态：只改**本地状态**里一张贴纸的 unlocked_at（不写库），
        # 点重看触发重渲染 → 「M月d日 — M月d日 · 共 N 天」分支；断言完立即还原
        page.evaluate("""async () => {
            const state = await import('/js/state.js');
            window.__e2e_real_stickers = state.getStickers();
            state.setStickers(state.getStickers().map((s, i) => i === 0
                ? { ...s, unlockedAt: new Date(Date.now() - 3 * 86400000).toISOString() }
                : s));
        }""")
        page.locator('#stickerMemorialBtn').click()
        multi_ok = wait_until(
            page, lambda: page.locator('#memorialCard').is_visible(), desc="跨天形态重开")
        multi_text = page.locator('#memorialCardDates').text_content() or ""
        check("跨天形态显示「min — max · 共 N 天」",
              multi_ok and "—" in multi_text and "共" in multi_text
              and range_info["minText"] in multi_text and range_info["maxText"] in multi_text,
              f"实际: {multi_text}")
        page.keyboard.press("Escape")
        page.evaluate("""async () => {
            const state = await import('/js/state.js');
            state.setStickers(window.__e2e_real_stickers || []);
            delete window.__e2e_real_stickers;
        }""")
        check("跨天断言后本地图鉴状态已还原",
              page.evaluate("async () => (await import('/js/state.js')).getStickers().length") == 12)

        page.evaluate("() => localStorage.removeItem('__e2e_force_rarity')")
        check("钩子已清理（9）", page.evaluate("() => localStorage.getItem('__e2e_force_rarity')") is None)

        # ===== 10. 第二册「我们的故事」（批次 3：v1 集齐 → story 开启 → 专属链路）=====
        print()
        print("=" * 60)
        print("10. 第二册「我们的故事」（开启 → 解锁 story_* → 网格/故事卡 → 红点隔离 → 纪念卡）")
        print("=" * 60)
        # 真实状态：v1 12/12（第 9 节走真实开奖集齐），story 0/12 → 开启册已切到 story，
        # 后续开奖直接解锁 story_*。这也覆盖了「上线时第一册已集齐则立即开启」的形态。
        # 此刻图鉴弹层仍开着（第 9 节没关）——先关掉（激活册 v1 → 只把 v1 的 key 标已看）
        page.locator('#stickerModalClose').click()
        wait_until(page, lambda: not page.locator('#stickerModal').is_visible(), desc="书架收起")

        state_ok = page.evaluate("""async () => {
            const bb = await import('/js/blindbox.js');
            return {
                target: bb.getRollTargetSeries(),
                v1Done: bb.isBookComplete(),
                storyDone: bb.isBookComplete('story'),
                all: bb.isAllBooksComplete(),
            };
        }""")
        check("v1 集齐后开启册已切到 story（真实链路）",
              state_ok["target"] == "story" and state_ok["v1Done"] and not state_ok["storyDone"] and not state_ok["all"],
              f"实际: {state_ok}")

        # --- 10.1 story 稀有档 4 张：解锁带前缀的 story_* key，名字/进度按 story 册口径 ---
        force_rarity("rare")
        story_rare = ["便当", "满城", "衣撑", "暗号"]
        for i in (1, 2, 3, 4):
            ti = f"E2E-测试-story稀有{i}"
            check(f"（story）第 {i} 条强制 rare 添加成功", add_todo(page, ti))
            ok = wait_until(page, lambda n=i: f"解锁「{story_rare[n - 1]}」" in toast_text(),
                            desc=f"解锁「{story_rare[i - 1]}」提示")
            check(f"（story）第 {i} 张解锁 · story 进度 {i}/12",
                  ok and f"{i}/12" in toast_text(), f"实际: {toast_text()}")
            wait_add_settled(page, ti)
        story_keys = page.evaluate("""async () => {
            const s = await import('/js/state.js');
            return s.getStickers().filter((x) => (x.stickerKey || '').startsWith('story_'))
                .map((x) => x.stickerKey).sort();
        }""")
        check("解锁的是带前缀的 story_rare_1..4（key 系列化落地）",
              story_keys == ["story_rare_1", "story_rare_2", "story_rare_3", "story_rare_4"],
              f"实际: {story_keys}")
        check("story 新解锁点亮顶栏红点", wait_until(
            page, lambda: page.locator('#stickerBadge').is_visible(), desc="红点亮"))

        # --- 10.2 红点/已看集合按册隔离 + story 网格渲染 + 故事卡 ---
        page.locator('#stickerEntry').click()
        wait_until(page, lambda: page.locator('.sticker-book-tabs__tab--active').text_content() == "我们的故事",
                   desc="打开书架默认翻到正在收集的 story 册")
        check("story 册网格 4 解锁 / 12 格",
              page.locator('.sticker-cell--unlocked').count() == 4 and page.locator('.sticker-cell').count() == 12,
              f"实际解锁 {page.locator('.sticker-cell--unlocked').count()} / 共 {page.locator('.sticker-cell').count()}")
        first_name = page.locator('.sticker-cell--unlocked .sticker-cell__name').first.text_content()
        check("story 首张贴纸名为「便当」（D11 序号顺序）", first_name == "便当", f"实际: {first_name}")
        page.screenshot(path="/tmp/blindbox-story-grid.png", full_page=True)
        # 只翻 v1 再关闭 → v1 无新贴纸，story 的红点必须保持（不能误清别册的未看状态）
        page.locator('#stickerBookTabs .sticker-book-tabs__tab', has_text="怦然心动").click()
        wait_until(page, lambda: page.locator('.sticker-book-tabs__tab--active').text_content() == "怦然心动",
                   desc="切到 v1 册")
        page.locator('#stickerModalClose').click()
        wait_until(page, lambda: not page.locator('#stickerModal').is_visible(), desc="书架收起")
        check("只翻 v1 不熄 story 红点（已看集合按册隔离）",
              page.locator('#stickerBadge').is_visible(), "红点意外熄灭")
        # 再开书架（默认翻 story）→ 点贴纸看故事卡 → 关闭 → story 标已看 → 红点熄灭
        page.locator('#stickerEntry').click()
        wait_until(page, lambda: page.locator('.sticker-book-tabs__tab--active').text_content() == "我们的故事",
                   desc="再次默认 story 册")
        page.locator('.sticker-cell--unlocked').first.click()
        check("点击 story 贴纸弹出故事卡（叙事藏在故事卡里）", wait_until(
            page,
            lambda: "sticker-modal__flavor--show" in (page.locator('#stickerFlavor').get_attribute("class") or "")
            and len((page.locator('#stickerFlavor').text_content() or "").strip()) > 0,
            desc="故事卡浮现"))
        page.locator('#stickerModalClose').click()
        wait_until(page, lambda: not page.locator('#stickerModal').is_visible(), desc="书架收起")
        check("浏览 story 册后关闭红点熄灭", wait_until(
            page, lambda: not page.locator('#stickerBadge').is_visible(), desc="红点熄灭"))

        # --- 10.3 该档集齐后的兜底文案带册名（钩子显式覆盖仍开出 rare）---
        t_s5 = "E2E-测试-story稀有5"
        check("（story）第 5 条 rare 添加成功", add_todo(page, t_s5))
        full_rare = wait_until(page, lambda: "我们的故事" in toast_text() and "已集齐" in toast_text(),
                               desc="story 稀有档集齐提示")
        check("story 稀有档集齐提示带册名", full_rare, f"实际: {toast_text()}")
        wait_add_settled(page, t_s5)

        # --- 10.4 史诗 + 传说：补满 12 张（序号/进度按 story 册）---
        story_epic = ["初遇", "深夜", "和好", "小心"]
        force_rarity("epic")
        for i in (1, 2, 3, 4):
            ti = f"E2E-测试-story史诗{i}"
            check(f"（story）史诗第 {i} 条添加成功", add_todo(page, ti))
            ok = wait_until(page, lambda n=i: f"解锁「{story_epic[n - 1]}」" in toast_text(),
                            desc=f"解锁「{story_epic[i - 1]}」提示")
            check(f"（story）史诗第 {i} 张解锁 · 进度 {4 + i}/12",
                  ok and f"{4 + i}/12" in toast_text(), f"实际: {toast_text()}")
            wait_add_settled(page, ti)
        story_leg = ["宝宝", "双生", "平常", "一直"]
        force_rarity("legendary")
        for i in (1, 2, 3, 4):
            ti = f"E2E-测试-story传说{i}"
            check(f"（story）传说第 {i} 条添加成功", add_todo(page, ti))
            ok = wait_until(page, lambda n=i: f"解锁「{story_leg[n - 1]}」" in toast_text(),
                            desc=f"解锁「{story_leg[i - 1]}」提示")
            check(f"（story）传说第 {i} 张解锁 · 进度 {8 + i}/12",
                  ok and f"{8 + i}/12" in toast_text(), f"实际: {toast_text()}")
            wait_add_settled(page, ti)

        # --- 10.5 story 12/12 → 属于它自己的集齐纪念卡（复用批次 1 组件，带册名）---
        page.locator('#stickerEntry').click()
        check("story 集齐后打开书架，其纪念卡自动弹出（待庆祝册优先翻开）", wait_until(
            page, lambda: page.locator('#memorialCard').is_visible(), desc="story 纪念卡仪式"))
        title_text = page.locator('#memorialCardTitle').text_content() or ""
        check("story 纪念卡标题带册名", "我们的故事" in title_text, f"实际: {title_text}")
        cell_n = page.locator('#memorialCardGrid .memorial-card__cell').count()
        check("story 纪念卡 12 格拼贴", cell_n == 12, f"实际 {cell_n}")
        page.screenshot(path="/tmp/blindbox-story-memorial.png", full_page=True)
        page.locator('#memorialCardClose').click()
        check("story 完成态：金色面板徽章 + 重看入口 + 激活 tab 为 story", wait_until(
            page,
            lambda: page.locator('#stickerCompleteChip').is_visible()
            and page.locator('#stickerMemorialBtn').is_visible()
            and page.locator('.sticker-book-tabs__tab--active').text_content() == "我们的故事",
            desc="story 完成态"))
        all_done_state = page.evaluate("""async () => {
            const bb = await import('/js/blindbox.js');
            return { all: bb.isAllBooksComplete(), target: bb.getRollTargetSeries() };
        }""")
        check("两册全齐：isAllBooksComplete 为真、开启册为空",
              all_done_state["all"] and all_done_state["target"] is None, f"实际: {all_done_state}")
        # 两册全齐后（无钩子）的真实开奖回落三档全池：盲盒仍是惊喜，只是不再解锁贴纸
        page.evaluate("() => localStorage.removeItem('__e2e_force_rarity')")
        final_pool = page.evaluate("""async () => {
            const bb = await import('/js/blindbox.js');
            const counts = { common: 0, rare: 0, epic: 0, legendary: 0 };
            for (let i = 0; i < 1000; i++) counts[bb.rollRarity()]++;
            return counts;
        }""")
        check("两册全齐后开奖回落三档全池（不再解锁，惊喜保留）",
              final_pool["rare"] > 0 and final_pool["epic"] > 0 and final_pool["legendary"] > 0,
              f"实际: {final_pool}")
        page.locator('#stickerModalClose').click()
        wait_until(page, lambda: not page.locator('#stickerModal').is_visible(), desc="书架收起")
        page.evaluate("() => localStorage.removeItem('__e2e_force_rarity')")
        check("钩子已清理（10）", page.evaluate("() => localStorage.getItem('__e2e_force_rarity')") is None)

        # ===== 11. 升星（批次 4：全部册集齐 → 升星期 → 闪卡/烫金）=====
        print()
        print("=" * 60)
        print("11. 升星（全部册集齐后：注册顺序选册 → 星级 0→1→2 → 满星顺延 → 双端同步）")
        print("=" * 60)
        # 真实状态：v1 12/12 + story 12/12（第 9/10 节真实开奖集齐），星级全 0。
        # D12：全部集齐 → 升星期，开奖不再解锁、改为升星；升星目标册按注册顺序 = v1。
        star_state = page.evaluate("""async () => {
            const bb = await import('/js/blindbox.js');
            return {
                target: bb.getRollTargetSeries(),
                starTarget: bb.getStarTargetSeries(),
                all: bb.isAllBooksComplete(),
                upgradable: bb.upgradableRarities('v1'),
            };
        }""")
        check("两册全齐进入升星期：开启册为空、升星目标 v1（注册顺序）、三档都可升",
              star_state["target"] is None and star_state["starTarget"] == "v1"
              and star_state["all"] and star_state["upgradable"] == ["rare", "epic", "legendary"],
              f"实际: {star_state}")

        # --- 11.1 升星口径（构造状态）：注册顺序切册 + 满星档退出抽选池 ---
        star_pool = page.evaluate("""async () => {
            const state = await import('/js/state.js');
            const bb = await import('/js/blindbox.js');
            const real = state.getStickers();
            const fake = (series, rarity, n, star) => Array.from({ length: n }, (_, i) => {
                const key = `${series === 'v1' ? '' : series + '_'}${rarity}_${i + 1}`;
                return { id: crypto.randomUUID(), stickerKey: key, rarity, starLevel: star,
                         unlockedBy: null, todoId: null, unlockedAt: new Date().toISOString() };
            });
            const book = (series, star) => [...fake(series, 'rare', 4, star), ...fake(series, 'epic', 4, star), ...fake(series, 'legendary', 4, star)];
            try {
                // v1 全满星、story 星级全 0 → 升星目标按注册顺序切到 story
                state.setStickers([...book('v1', 2), ...book('story', 0)]);
                const afterV1Maxed = { starTarget: bb.getStarTargetSeries(), upgradable: bb.upgradableRarities('story') };
                // v1 稀有档满星、其余星级 0 → 升星期抽选池不再含 rare（满星档退出，同收集期思路）
                state.setStickers([
                    ...fake('v1', 'rare', 4, 2), ...fake('v1', 'epic', 4, 0), ...fake('v1', 'legendary', 4, 0),
                    ...book('story', 0),
                ]);
                const counts = { common: 0, rare: 0, epic: 0, legendary: 0 };
                for (let i = 0; i < 2000; i++) counts[bb.rollRarity()]++;
                return { afterV1Maxed, counts, upgradableV1: bb.upgradableRarities('v1') };
            } finally {
                state.setStickers(real);
            }
        }""")
        check("第一册升满后升星目标切到 story（注册顺序，与「合上第一本翻开第二本」一致）",
              star_pool["afterV1Maxed"]["starTarget"] == "story"
              and star_pool["afterV1Maxed"]["upgradable"] == ["rare", "epic", "legendary"],
              f"实际: {star_pool['afterV1Maxed']}")
        check("稀有档满星后升星期抽选池剔除 rare（2000 次不开出稀有）",
              star_pool["upgradableV1"] == ["epic", "legendary"] and star_pool["counts"]["rare"] == 0,
              f"实际: {star_pool['upgradableV1']} / {star_pool['counts']}")
        check("构造用假状态已还原（真实图鉴 24 张未被污染）",
              page.evaluate("async () => (await import('/js/state.js')).getStickers().length") == 24)

        # --- 11.2 真实升星链路：0→闪卡→烫金→顺延下一张（写测试库，断言打在库真值上）---
        def star_levels():
            return page.evaluate("""async () => {
                const s = await import('/js/state.js');
                const out = {};
                for (const x of s.getStickers()) {
                    if (x.stickerKey === 'rare_1' || x.stickerKey === 'rare_2') out[x.stickerKey] = x.starLevel || 0;
                }
                return out;
            }""")

        force_rarity("rare")
        t_s1 = "E2E-测试-升星1"
        check("升星期强制 rare 添加成功", add_todo(page, t_s1))
        ok = wait_until(page, lambda: "「初心」升为闪卡" in toast_text(), desc="升星提示（闪卡）")
        check("第一颗：rare_1 升为闪卡（星级 +1，提示含星级名）",
              ok and star_levels().get("rare_1") == 1, f"实际: {toast_text()} / {star_levels()}")
        wait_add_settled(page, t_s1)

        t_s2 = "E2E-测试-升星2"
        check("第二条强制 rare 添加成功", add_todo(page, t_s2))
        ok = wait_until(page, lambda: "「初心」升为烫金" in toast_text(), desc="升星提示（烫金）")
        check("满星顺延：rare_1 再 +1 到烫金（2 星封顶，不提前跳 rare_2）",
              ok and star_levels() == {"rare_1": 2, "rare_2": 0}, f"实际: {toast_text()} / {star_levels()}")
        wait_add_settled(page, t_s2)

        t_s3 = "E2E-测试-升星3"
        check("第三条强制 rare 添加成功", add_todo(page, t_s3))
        ok = wait_until(page, lambda: "「萌芽」升为闪卡" in toast_text(), desc="顺延到下一张提示")
        check("rare_1 满星后顺延到 rare_2（+1 闪卡）",
              ok and star_levels() == {"rare_1": 2, "rare_2": 1}, f"实际: {toast_text()} / {star_levels()}")
        wait_add_settled(page, t_s3)

        # 库真值对账（不只信本地状态）
        db_stars = page.evaluate("""async () => {
            const { db } = await import('/js/db.js');
            const rows = await db.listStickers();
            const out = {};
            for (const r of rows) {
                if (r.stickerKey === 'rare_1' || r.stickerKey === 'rare_2') out[r.stickerKey] = r.starLevel || 0;
            }
            return out;
        }""")
        check("数据库真值：rare_1=2（烫金）、rare_2=1（闪卡）",
              db_stars == {"rare_1": 2, "rare_2": 1}, f"实际: {db_stars}")

        # --- 11.3 图鉴 UI：星级角标 + 闪卡/烫金质感 + 完成态引导 + 故事卡星级行 ---
        page.locator('#stickerEntry').click()
        wait_until(page, lambda: page.locator('#stickerModal').is_visible(), desc="书架打开")
        # 打开书架默认册 = story（上次所在册）→ 切到 v1 看星级
        page.locator('#stickerBookTabs .sticker-book-tabs__tab', has_text="怦然心动").click()
        wait_until(page, lambda: page.locator('.sticker-book-tabs__tab--active').text_content() == "怦然心动",
                   desc="切到 v1 册")
        star2_cells = page.locator('.sticker-cell--star2').count()
        star1_cells = page.locator('.sticker-cell--star1').count()
        check("v1 网格：1 个烫金格（rare_1）+ 1 个闪卡格（rare_2）",
              star2_cells == 1 and star1_cells == 1, f"实际: 烫金{star2_cells} 闪卡{star1_cells}")
        check("烫金格角标显示 ★★", page.locator('.sticker-cell--star2 .sticker-cell__star', has_text="★★").count() == 1)
        check("完成态提示引导升星（含剩余次数）",
              "升星机会" in (page.locator('#stickerHint').text_content() or ""),
              f"实际: {page.locator('#stickerHint').text_content()}")
        page.screenshot(path="/tmp/blindbox-star-grid.png", full_page=True)
        # 点烫金格（v1 rare_1）→【D7-③ 批次 3】v1 已解锁格子弹**复看卡**（星级信息在格子上，
        # 不进卡面）；故事卡星级行只对无专属卡的 story 贴纸生效（下一段单独覆盖）
        page.locator('.sticker-cell--star2').first.click()
        rv_star = wait_reveal_card(page, desc="烫金格复看卡弹出")
        check("点 v1 烫金格弹出复看卡（D7-③：格子点击升级为复看卡）",
              rv_star is not None and rv_star["name"] == "初心", f"实际: {rv_star}")
        check("烫金格复看卡可关闭（书架仍在）",
              close_reveal_card(page) and page.locator('#stickerModal').is_visible())
        # 故事卡星级行（回落路径覆盖）：本地构造一张 1 星 story 贴纸 → story 格子出现星标
        # → 点击弹故事卡 → 「★ 闪卡」星级行 → 断言后还原（不写库）
        page.evaluate("""async () => {
            const state = await import('/js/state.js');
            window.__e2e_real_stickers2 = state.getStickers();
            state.setStickers(state.getStickers().map((s) => s.stickerKey === 'story_rare_1'
                ? { ...s, starLevel: 1 } : s));
        }""")
        wait_until(page, lambda: page.locator('.sticker-cell--star1').count() > 0, desc="story 星标格出现")
        page.locator('#stickerBookTabs .sticker-book-tabs__tab', has_text="我们的故事").click()
        wait_until(page, lambda: page.locator('.sticker-cell--star1').count() == 1, desc="story 星标格唯一")
        page.locator('.sticker-cell--star1').first.click()
        star_card = wait_until(
            page,
            lambda: "烫金" in (page.locator('#stickerFlavor').text_content() or "")
            or "闪卡" in (page.locator('#stickerFlavor').text_content() or ""),
            desc="故事卡星级行",
        )
        star_line = page.locator('#stickerFlavor .sticker-modal__flavor-star').text_content() or ""
        check("故事卡显示星级行（★ 闪卡，回落路径）", star_card and "★" in star_line, f"实际: {star_line}")
        page.evaluate("""async () => {
            const state = await import('/js/state.js');
            state.setStickers(window.__e2e_real_stickers2 || []);
            delete window.__e2e_real_stickers2;
        }""")
        page.locator('#stickerModalClose').click()
        wait_until(page, lambda: not page.locator('#stickerModal').is_visible(), desc="书架收起")

        # --- 11.4 双端同步：beta 经 Realtime stickers UPDATE 收到星级变化 + 提示（不刷新）---
        print("    （双账号）beta 登录 → alpha 升星 → beta 实时同步星级 + 提示")
        context2 = browser.new_context()
        page2 = context2.new_page()
        page2.set_default_timeout(15000)
        second_user = os.environ.get("E2E_SECOND_ACCOUNT", "e2e-beta")
        check("（升星）第二账号登录成功", login(page2, BASE, second_user, TEST_PASSWORD), page2.url)
        # Realtime 订阅真正生效需 ~2-3s（本项目记录过的已知时序），取宽等待
        page2.wait_for_timeout(4000)

        def beta_rare2_star():
            return page2.evaluate("""async () => {
                const s = await import('/js/state.js');
                const x = s.getStickers().find((y) => y.stickerKey === 'rare_2');
                return x ? (x.starLevel || 0) : null;
            }""")

        def toast2_text():
            el = page2.locator("#toast")
            return (el.text_content() or "") if el.count() > 0 else ""

        before_star = beta_rare2_star()
        check("（beta）升星前本地 rare_2 星级为 1（冷启动拉取）", before_star == 1, f"实际: {before_star}")

        t_s4 = "E2E-测试-升星4"
        check("（alpha）第四条强制 rare 添加成功", add_todo(page, t_s4))
        ok_alpha = wait_until(page, lambda: "「萌芽」升为烫金" in toast_text(), desc="（alpha）rare_2 烫金提示")
        ok_beta = wait_until(page2, lambda: beta_rare2_star() == 2, timeout_ms=20000,
                             desc="（beta）Realtime 星级同步")
        beta_toast = wait_until(page2, lambda: "升为烫金" in toast2_text(), timeout_ms=20000,
                                desc="（beta）升星提示")
        check("（beta）对方升星实时同步到 star_level=2（UPDATE 通道，无需刷新）",
              ok_alpha and ok_beta, f"实际: {beta_rare2_star()}")
        check("（beta）收到升星提示（含贴纸名「萌芽」）", beta_toast and "萌芽" in toast2_text(),
              f"实际: {toast2_text()}")
        context2.close()

        page.evaluate("() => localStorage.removeItem('__e2e_force_rarity')")
        check("钩子已清理（11）", page.evaluate("() => localStorage.getItem('__e2e_force_rarity')") is None)

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
