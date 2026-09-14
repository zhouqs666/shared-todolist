#!/usr/bin/env bash
# CI 专用测试运行脚本：设备准备 → 启动 Appium → 跑 WebdriverIO → 停 Appium
# 被 e2e-app.yml 的 android-emulator-runner 调用
set -euo pipefail

APPIUM_PORT=4723
APPIUM_LOG="/tmp/appium.log"
TEST_EXIT=0
APP_ID="com.love.todo"

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
adb shell settings put global hide_error_dialogs 1 || true
adb shell settings put secure anr_show_background 0 || true
adb shell settings put global window_animation_scale 0 || true
adb shell settings put global transition_animation_scale 0 || true
adb shell settings put global animator_duration_scale 0 || true
echo "[ci-run] hide_error_dialogs = $(adb shell settings get global hide_error_dialogs)"

# 清掉可能已存在的残留弹窗（BACK 键关闭当前焦点窗口）
adb shell input keyevent 4 || true

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
  # 失败时输出设备侧日志，便于定位是 App 崩溃、ANR 还是元素问题
  echo "[ci-run] ---- adb logcat (app + ANR) last 120 lines ----"
  adb logcat -d -t 120 2>/dev/null | grep -iE "love.todo|ANR|FATAL|chromium|WebView" | tail -120 || true
fi

echo "[ci-run] Tests finished with exit code: $TEST_EXIT"
exit $TEST_EXIT
