#!/usr/bin/env bash
# 模拟器 E2E 的「失败重试一次」包装（被 e2e-app.yml 调用）
#
# 为什么要重试：**模拟器/Appium 这条链本身不稳，与业务代码无关**。实证（2026-09-15）：
#   · 同一 commit（f12da3c）首跑失败、重跑通过
#   · 失败形态还在跳：一次是「登录页 60s 不出现 + 动画超时」，一次是「adb 报错 + 元素定位失败」
#   · 当天 main 自己（13:41）也失败过一次
# 这套抖动在 web 通道早就用「重试一次」消化（scripts/run-web-e2e.mjs），这里对齐同一策略。
#
# ⚠️ 真回归不会被掩盖：第二次仍失败则本脚本以非 0 退出，job 照样红。
# ⚠️ 为什么要单独放一个文件：android-emulator-runner 把 `script:` **逐行**交给 `/usr/bin/sh -c`
#    执行 —— 跨行的 `for ... do ... done` 会被拆成一条条命令，直接语法报错
#    （2026-09-15 踩过：`Syntax error: end of file unexpected (expecting "done")`）。
#    所以工作流里只调用这一行；任何多行 shell 逻辑都写在脚本文件里。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

for attempt in 1 2; do
  echo "=== Appium 第 ${attempt} 次尝试 ==="
  if bash "${HERE}/ci-run.sh"; then
    echo "✅ 第 ${attempt} 次通过"
    exit 0
  fi
  if [ "${attempt}" = "1" ]; then
    echo "⚠️ 第 1 次失败 → 重试一次（既往观测多为环境抖动；若第 2 次同样失败，则是真回归）"
  else
    echo "✗ 两次都失败：按真回归处理"
    exit 1
  fi
done
