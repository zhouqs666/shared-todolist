#!/bin/bash
# APP E2E Allure 报告生成脚本
# 用法：bash scripts/app-e2e-report.sh

set -e

cd "$(dirname "$0")/.."

echo "=== 生成 APP E2E Allure 报告 ==="

# 检查 allure-results 目录是否存在
if [ ! -d "app-e2e/allure-results" ]; then
  echo "错误：app-e2e/allure-results 目录不存在，请先运行测试"
  exit 1
fi

# 生成静态报告并打开
allure generate app-e2e/allure-results --clean -o app-e2e/allure-report
echo "报告已生成：app-e2e/allure-report/index.html"
open app-e2e/allure-report/index.html
