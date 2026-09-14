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
import sys
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
