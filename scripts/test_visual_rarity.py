"""视觉验证：模拟隐藏款待办的稀有度背景 + 角标效果"""
from playwright.sync_api import sync_playwright
import sys

BASE = "http://localhost:3000"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    page.goto(f"{BASE}/login.html", wait_until="networkidle")
    page.wait_for_timeout(1000)
    page.fill('#username', '小宝宝')
    page.fill('#password', '5201314')
    page.click('#submitBtn')
    page.wait_for_timeout(5000)
    page.wait_for_timeout(2000)

    # 找到第一个未完成的待办 li，手动给它加 3 种稀有度分别截图
    # 通过 applyRarity 给真实渲染的卡片应用稀有度
    for rarity, fname in [('rare', '/tmp/rarity-rare.png'), ('epic', '/tmp/rarity-epic.png'), ('legendary', '/tmp/rarity-legendary.png')]:
        page.evaluate(f"""async () => {{
            const mod = await import('/js/blindbox.js');
            const li = document.querySelector('#todoList .todo:not(.todo--done)');
            if (li) {{
                // 先清除之前的稀有度
                li.classList.remove('todo--rare','todo--epic','todo--legendary');
                const old = li.querySelector('.todo__rarity-badge');
                if (old) old.remove();
                mod.applyRarity(li, {{ rarity: '{rarity}' }});
            }}
        }}""")
        page.wait_for_timeout(600)
        page.screenshot(path=fname, full_page=True)
        print(f"截图: {fname} ({rarity})")

    browser.close()
    print("完成")
