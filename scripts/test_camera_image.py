"""
待办图片 · 相机拍摄（图源二级选择）E2E 测试（2026-10-02）

本次改动的核心契约：点图片入口 → 先弹「拍照 / 从相册选」二级选择 →
「拍照」创建的动态 input 必须带 capture=environment **content attribute**
（Capacitor WebView 的 onShowFileChooser 靠它拉起系统相机；注意必须用 setAttribute
写 —— IDL 属性赋值在 Chromium 不反映到 content attribute，真机会静默退化成普通选图，
这条就是本用例首跑抓到的 bug），文件回传后走与相册完全相同的压缩/上传/挂图链路。

覆盖范围：
  1. 添加面板图片按钮 → 拍照：capture 属性断言 + 预览 + 提交 → 待办带图
  2. 添加面板图片按钮 → 从相册选：旧路径回归（input 不带 capture）
  3. 长按菜单「配图」→ 拍照：大图（短边>1280）走 canvas 压缩 → 已配图 → 卡片带图徽标
  4. 长按菜单「配图」→ 从相册选：多选 2 张 → 「已配 2 张图」→ 多图回归

⚠️ Storage 上传（2026-10-02 起为**真实上传**，mock 已拆）：
  用例初期曾对 storage 上传响应做 mock——当时测试项目缺 todo-attachments bucket/策略
  （历史环境缺口）。缺口已用 scripts/apply-sql.mjs 应用迁移补齐（幂等自证 + read_only
  探针回读 + 真实上传验收三重确认），本用例现在走**真实压缩 → 真实上传 → 真实落库**。
  若测试库 Storage 再漂移，本用例会以「徽标不出现」真实红 —— 这是期望行为：环境缺口
  应该被看见，而不是被 mock 洗绿。

⚠️ 硬限制（Playwright 无法覆盖，发布后真机冒烟验证）：
  真机拉起系统相机、拍照内容回传、前后置切换等系统行为。

跑法（铁律一：必须连测试库）：
    node scripts/serve-test.mjs          # :3100 独立测试库
    python3 scripts/test_camera_image.py # 本文件自动连 3100 + 自证隔离
"""
import os
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from e2e_common import (
    resolve_base,
    load_test_creds,
    make_checker,
    cleanup_test_data,
    add_todo,
    login,
    open_add_panel,
    wait_add_settled,
    wait_until,
)

BASE = resolve_base()
TEST_USER, TEST_PASSWORD = load_test_creds()
errors = []
check, results = make_checker()


def make_png(width, height, color=(226, 87, 133)):
    """生成纯色 PNG（不依赖 PIL）：测试用图，content 无关紧要，尺寸才是变量。

    小图（短边 ≤1280）走 image-utils 的原文件直传分支；大图（>1280）走 canvas
    压缩分支 —— 两分支都用真实上传链路覆盖。
    """
    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data
                + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))

    row = b"\x00" + bytes(color) * width
    raw = row * height
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def open_chooser_and_pick(page, item_text, files, expect_capture=True):
    """点图片入口 → 二级选择里点 item_text → 接住动态 file input → 断言 capture → 塞文件。

    返回 (capture属性值, 是否全部成功)。断言失败时由调用方 check 记账。
    """
    with page.expect_file_chooser() as fc_info:
        page.locator('.img-src-menu__item', has_text=item_text).click()
    fc = fc_info.value
    capture = fc.element.get_attribute('capture')
    accept = fc.element.get_attribute('accept')
    ok = (capture == ('environment' if expect_capture else None)) and accept == 'image/*'
    fc.set_files(files)
    return capture, accept, ok


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_default_timeout(15000)
    page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

    # Storage 上传走真实链路（见文件头 docstring）：测试项目的 todo-attachments
    # bucket/策略已配齐；本计数器只作旁证统计，不做 mock。
    upload_hits = []

    def _count_storage(route):
        upload_hits.append(route.request.method)
        route.continue_()

    page.route("**/storage/v1/object/todo-attachments/**", _count_storage)

    # 测试图：/tmp 落盘（filechooser.set_files 只收路径）
    img_small = "/tmp/e2e-cam-small.png"
    img_album = "/tmp/e2e-album-1.png"
    img_album2 = "/tmp/e2e-album-2.png"
    img_large = "/tmp/e2e-cam-large.png"  # 1600×1600 → 短边>1280，走 canvas 压缩分支
    for path, (w, h) in [(img_small, (8, 8)), (img_album, (64, 64)), (img_album2, (64, 64)),
                         (img_large, (1600, 1600))]:
        with open(path, "wb") as f:
            f.write(make_png(w, h))

    print("== 1. 登录 ==", flush=True)
    check("登录成功进入主页", login(page, BASE, TEST_USER, TEST_PASSWORD), page.url)

    text_cam = 'E2E-测试-拍照预挂图'
    text_album = 'E2E-测试-相册预挂图'
    text_menu = 'E2E-测试-菜单拍照配图'

    # ---------- 用例 1：添加面板 → 拍照 ----------
    print("== 2. 添加面板：拍照（capture 属性 + 预挂图 + 提交）==", flush=True)
    check("打开添加面板", open_add_panel(page))
    page.locator("#attachBtn").click()
    page.wait_for_selector('.img-src-menu__item', timeout=5000)
    check("二级选择出现两个来源",
          page.locator('.img-src-menu__item', has_text='拍照').count() == 1
          and page.locator('.img-src-menu__item', has_text='从相册选').count() == 1)
    capture, accept, ok = open_chooser_and_pick(page, '拍照', img_small, expect_capture=True)
    check("拍照 input 带 capture=environment", ok, f"capture={capture!r} accept={accept!r}")
    check("选图后浮现预览缩略图", wait_until(
        page,
        lambda: page.locator('#attachPreview img').is_visible(),
        desc="预挂图预览出现",
    ))
    page.fill("#todoInput", text_cam)
    page.locator("#addBtn").click()
    check("待办创建且带图徽标", wait_until(
        page,
        lambda: page.locator('.todo', has_text=text_cam).first.locator('.todo__image-badge').count() == 1,
        timeout_ms=25000,  # 含图片真实上传（测试库免费层冷启动可能慢，同 test_trash 口径）
        desc="提交后待办卡片出现图片徽标",
    ))

    # ---------- 用例 2：添加面板 → 从相册选（旧路径回归） ----------
    print("== 3. 添加面板：从相册选（旧路径回归）==", flush=True)
    check("再次打开添加面板", open_add_panel(page))
    page.locator("#attachBtn").click()
    page.wait_for_selector('.img-src-menu__item', timeout=5000)
    capture, accept, ok = open_chooser_and_pick(page, '从相册选', img_album, expect_capture=False)
    check("相册 input 不带 capture", ok, f"capture={capture!r} accept={accept!r}")
    check("选图后浮现预览缩略图", wait_until(
        page,
        lambda: page.locator('#attachPreview img').is_visible(),
        desc="相册路径预挂图预览出现",
    ))
    page.fill("#todoInput", text_album)
    page.locator("#addBtn").click()
    check("待办创建且带图徽标", wait_until(
        page,
        lambda: page.locator('.todo', has_text=text_album).first.locator('.todo__image-badge').count() == 1,
        timeout_ms=25000,
        desc="相册路径提交后待办卡片出现图片徽标",
    ))

    # ---------- 用例 3：长按菜单 → 配图 → 拍照（大图走 canvas 压缩） ----------
    print("== 4. 长按菜单：拍照配图（大图压缩分支）==", flush=True)
    check("菜单用待办已添加", add_todo(page, text_menu))
    wait_add_settled(page, text_menu)
    page.locator('.todo', has_text=text_menu).first.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="配图"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="配图"]').click()
    page.wait_for_selector('.img-src-menu__item', timeout=5000)
    capture, accept, ok = open_chooser_and_pick(page, '拍照', img_large, expect_capture=True)
    check("菜单拍照 input 带 capture=environment", ok, f"capture={capture!r} accept={accept!r}")
    check("大图压缩上传后卡片带图徽标", wait_until(
        page,
        lambda: page.locator('.todo', has_text=text_menu).first.locator('.todo__image-badge').count() == 1,
        timeout_ms=25000,
        desc="1600×1600 图经 canvas 压缩上传后出现徽标",
    ))

    # ---------- 用例 4：长按菜单 → 配图 → 从相册选（多图回归） ----------
    print("== 5. 长按菜单：从相册选配图（多图回归）==", flush=True)
    page.locator('.todo', has_text=text_menu).first.click(button='right')
    page.wait_for_selector('.action-sheet__icon-btn[aria-label="加图"]', timeout=5000)
    page.locator('.action-sheet__icon-btn[aria-label="加图"]').click()
    page.wait_for_selector('.img-src-menu__item', timeout=5000)
    with page.expect_file_chooser() as fc_info:
        page.locator('.img-src-menu__item', has_text='从相册选').click()
    fc_info.value.set_files([img_album, img_album2])
    check("多图上传提示「已配 2 张图」", wait_until(
        page,
        lambda: (page.locator('.toast--show').text_content() or '').find('已配 2 张图') >= 0,
        timeout_ms=25000,
        desc="多图上传完成 toast",
    ))

    print("== 6. 上传请求统计 + 页面报错检查 ==", flush=True)
    # 预挂图 2 次 + 菜单拍照 1 次 + 菜单单选 2 次 = 5 个真实上传请求（旁证计数）
    check("storage 上传请求已发出 5 次", len(upload_hits) == 5, f"实际 {upload_hits}")
    real = [e for e in errors if "Failed to fetch" not in e and "net::" not in e and "favicon" not in e]
    check("无模块级报错", len(real) == 0, f"错误数 {len(real)}")
    for e in real[:5]:
        print(f"    {e}", flush=True)

    # 测试图走真实上传（测试库 Storage），行数据统一硬删；孤儿文件留在测试项目可接受
    cleanup_test_data()
    browser.close()

print("=" * 40, flush=True)
print(f"通过: {results['pass']}  失败: {results['fail']}", flush=True)
sys.exit(0 if results["fail"] == 0 else 1)
