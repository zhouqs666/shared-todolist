#!/usr/bin/env bash
# CI 专用测试运行脚本：设备准备 → 启动 Appium → 跑 WebdriverIO → 停 Appium
# 被 e2e-app.yml 的 android-emulator-runner 调用
set -euo pipefail

APPIUM_PORT=4723
APPIUM_LOG="/tmp/appium.log"
TEST_EXIT=0
APP_ID="com.love.todo"

# ---------------------------------------------------------------
# adb 调用一律套超时：**adb 自己没有任何超时机制**
#
# 血泪教训（2026-09-16）：设备上 UiAutomator2 的 instrumentation 进程崩溃后
# （日志里是 `socket hang up` / `cannot be proxied ... instrumentation process is not running`），
# 失败路径里的 `adb logcat -d` **再也没返回** —— 测试其实 04:17:15 就跑完了，
# 这行诊断输出却把 step 挂到 08:26（4 小时 09 分，直到人工取消）。
# 因为 workflow 当时没设 `timeout-minutes`，走 GitHub 默认的 360 分钟 ⇒
# 期间独占仓库级并发组 `e2e-test-db`，全仓 E2E 全部排队（有一个 run 被挡了 3h37m）。
#
# 关键认知：**诊断输出绝不允许把流水线卡住**。它只是给人看的，超时了要能看见、能跳过。
# macOS 没有 GNU `timeout`（本地是 `gtimeout`）；两者都没有时**显式告警**再退化为不包裹 ——
# 不能让它静默失效：下面所有 adb 调用都带 `|| true`，"命令不存在"会被一起吞掉。
# ---------------------------------------------------------------
ADB_TIMEOUT="${ADB_TIMEOUT:-30}"
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
else
  TIMEOUT_BIN=""
  echo "[ci-run] ⚠️ 未找到 timeout/gtimeout —— adb 调用不受超时保护（本脚本设计为在 Linux CI 上跑）"
fi

# 带超时执行（无 timeout 可用时直接执行）
timeout_t() {
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" "$ADB_TIMEOUT" "$@"
  else
    "$@"
  fi
}

# 设备准备用的 adb 包装：加超时 + 吞掉失败（单个 setting 失败不允许中断流程）
adb_t() { timeout_t adb "$@" || true; }

cleanup() {
  echo "[ci-run] Stopping Appium server..."
  if [ -n "${APPIUM_PID:-}" ] && kill -0 "$APPIUM_PID" 2>/dev/null; then
    kill "$APPIUM_PID" 2>/dev/null || true
    wait "$APPIUM_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------
# 设备准备：消除系统弹窗对 a11y 树的干扰
#
# 血泪教训（阶段 3.6）：reloadSession() 会让 App 短暂切到后台，2 核 CI 模拟器上
# 桌面启动器扛不住直接 ANR，系统弹出「Pixel Launcher isn't responding」对话框。
# 该弹窗会盖住 App 并劫持 UiAutomator2 的无障碍树 → 后续所有元素查找全部失败。
# 表现为「第一个用例通过、其余全挂」这种极容易误判成元素定位问题的假象。
#
# hide_error_dialogs=1 让系统不再弹 ANR/崩溃对话框，弹窗消失即不再劫持 a11y 树。
# ---------------------------------------------------------------
echo "[ci-run] Preparing device: suppressing system error dialogs..."
# 每个 setting 单独容错：某个 key 在特定 API 级别不存在时不能中断整个脚本
adb_t shell settings put global hide_error_dialogs 1
adb_t shell settings put secure anr_show_background 0
adb_t shell settings put global window_animation_scale 0
adb_t shell settings put global transition_animation_scale 0
adb_t shell settings put global animator_duration_scale 0
echo "[ci-run] hide_error_dialogs = $(adb_t shell settings get global hide_error_dialogs)"

# 清掉可能已存在的残留弹窗（BACK 键关闭当前焦点窗口）
adb_t shell input keyevent 4

echo "[ci-run] Starting Appium server on port $APPIUM_PORT..."
appium --relaxed-security --port "$APPIUM_PORT" > "$APPIUM_LOG" 2>&1 &
APPIUM_PID=$!

# 等 Appium 就绪（最多 30 秒）
echo "[ci-run] Waiting for Appium to be ready..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$APPIUM_PORT/status" > /dev/null 2>&1; then
    echo "[ci-run] Appium ready (pid=$APPIUM_PID)"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[ci-run] ERROR: Appium failed to start within 30s"
    echo "--- Appium log (last 50 lines) ---"
    tail -50 "$APPIUM_LOG" || true
    exit 1
  fi
  sleep 1
done

echo "[ci-run] Running WebdriverIO tests..."
cd "$(dirname "$0")/.."
npx wdio run ./wdio.conf.js || TEST_EXIT=$?

if [ "$TEST_EXIT" -ne 0 ]; then
  # 失败时输出设备侧日志，便于定位是 App 崩溃、ANR 还是元素问题。
  # 这一段**必须是 fail-safe 的**：设备已经出问题时 adb 会阻塞，而它只是诊断信息，
  # 绝不允许它决定 job 的命运（2026-09-16 卡了 4h09m 就是这一行）。
  # 也不再用 `2>/dev/null` 把错误吞掉 —— 超时/失联要看得见。
  echo "[ci-run] ---- adb logcat (app + ANR) last 120 lines ----"
  LOGCAT_FILE="/tmp/ci-logcat.txt"
  if timeout_t adb logcat -d -t 120 > "$LOGCAT_FILE" 2>&1; then
    grep -iE "love.todo|ANR|FATAL|chromium|WebView" "$LOGCAT_FILE" | tail -120 || true
  else
    echo "[ci-run] ⚠️ adb logcat 超时/失败（${ADB_TIMEOUT}s，设备可能已失联）—— 跳过诊断，不影响退出码"
    echo "--- adb 原始输出（尾部 20 行）---"
    tail -20 "$LOGCAT_FILE" || true
  fi
fi

echo "[ci-run] Tests finished with exit code: $TEST_EXIT"
exit $TEST_EXIT
