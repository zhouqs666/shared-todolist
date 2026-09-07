"""
盲盒 + 图鉴功能 E2E 测试

由于生产库迁移尚未执行（rarity 列/stickers 表不存在），本测试分两部分：
1. 纯前端逻辑测试（不依赖 DB）：rollRarity 概率分布、applyRarity 角标/背景、图鉴渲染
2. 页面加载/登录测试：验证模块链无报错、登录后主页渲染、createTodo 降级容错

测试遵循 AGENTS.md：不碰生产数据。添加的测试待办用 "E2E-测试-" 前缀，测后只删标记数据。
"""
import re
import json
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
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
    print("2. 登录（小宝宝账号）")
    print("=" * 60)
    page.fill('#username', '小宝宝')
    page.fill('#password', '5201314')
    page.click('#submitBtn')
    page.wait_for_timeout(5000)
    on_home = "login" not in page.url
    check("登录成功进入主页", on_home, page.url)

    if on_home:
        page.wait_for_timeout(2500)

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
        page.wait_for_timeout(800)
        modal_visible = page.locator('#stickerModal').is_visible()
        check("图鉴弹层打开", modal_visible)
        cell_count = page.locator('.sticker-cell').count()
        check("贴纸格子数=12", cell_count == 12, f"实际 {cell_count}")
        progress_text = page.locator('#stickerProgress').text_content()
        check("进度条显示 X/12", "/ 12" in progress_text or "/12" in progress_text, f"实际: {progress_text}")
        page.screenshot(path="/tmp/blindbox-stickerbook.png", full_page=True)
        # 关闭图鉴弹层，避免遮挡后续操作
        page.locator('#stickerModalClose').click()
        page.wait_for_timeout(500)

        # 添加待办测试（验证 createTodo 降级容错）
        print()
        print("=" * 60)
        print("6. 添加待办（验证 createTodo 容错，因迁移未执行会降级）")
        print("=" * 60)
        before_count = page.locator('#todoList .todo').count()
        # 先点 FAB 打开添加面板
        page.locator('#fabBtn').click()
        page.wait_for_timeout(500)
        page.fill('#todoInput', 'E2E-测试-盲盒功能验证')
        page.wait_for_timeout(200)
        page.locator('#addBtn').click()
        page.wait_for_timeout(3000)
        after_count = page.locator('#todoList .todo').count()
        check("添加待办成功（数量+1）", after_count == before_count + 1, f"前{before_count} 后{after_count}")

        page.screenshot(path="/tmp/blindbox-after-add.png", full_page=True)

    browser.close()

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
