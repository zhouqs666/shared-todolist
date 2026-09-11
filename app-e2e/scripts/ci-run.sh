#!/usr/bin/env bash
# CI 专用测试运行脚本：启动 Appium → 跑 WebdriverIO → 停 Appium
# 被 e2e-app.yml 的 android-emulator-runner 调用
set -euo pipefail

APPIUM_PORT=4723
APPIUM_LOG="/tmp/appium.log"
TEST_EXIT=0

cleanup() {
  echo "[ci-run] Stopping Appium server..."
  if [ -n "${APPIUM_PID:-}" ] && kill -0 "$APPIUM_PID" 2>/dev/null; then
    kill "$APPIUM_PID" 2>/dev/null || true
    wait "$APPIUM_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

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

echo "[ci-run] Tests finished with exit code: $TEST_EXIT"
exit $TEST_EXIT
