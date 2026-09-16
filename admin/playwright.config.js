import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

// 加载测试环境变量（.env.test 不入库，见 .env.test.example）。
// dotenv 默认不覆盖已存在的 env，所以 shell / CI 注入的变量优先级更高。
dotenv.config({ path: '.env.test' });

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4173';

/**
 * Playwright 配置（阶段 2：web 自动化测试）
 *
 * 设计要点：
 * - POM 模式：用例只描述业务流，元素定位集中在 e2e/pages/
 * - webServer：自动 build + preview 起服务、跑完自动关（本地复用已有服务，CI 强制新起）
 * - 失败即留证：screenshot / trace / video 仅失败时保留（retain-on-failure）
 * - retries：CI 上 2 次重试兜底 flaky，本地 0 次（快速反馈）
 * - workers=1：E2E 共享同一测试库，串行避免数据互相污染
 */
export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ['list'],
    ['allure-playwright', { detail: true, suiteTitle: false }],
  ],
  use: {
    baseURL: BASE_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // 用测试库凭据构建前端，再 preview 起服务（测的是真实构建产物，非 dev 态）
    command:
      'VITE_SUPABASE_URL="$E2E_SUPABASE_URL" VITE_SUPABASE_ANON_KEY="$E2E_SUPABASE_ANON_KEY" ' +
      'npm run build && npm run preview -- --port 4173 --strictPort',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
