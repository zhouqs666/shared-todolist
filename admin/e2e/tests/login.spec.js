import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage.js';
import { DashboardPage } from '../pages/DashboardPage.js';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

test.beforeAll(() => {
  if (!EMAIL || !PASSWORD) {
    throw new Error('缺少 E2E_TEST_EMAIL / E2E_TEST_PASSWORD，请配置 admin/.env.test');
  }
});

test.describe('登录', () => {
  test('正确账号密码登录成功，进入后台', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(EMAIL, PASSWORD);

    const dashboard = new DashboardPage(page);
    await expect(dashboard.dashboard).toBeVisible();
    await expect(dashboard.currentUser).toBeVisible();
  });

  test('错误密码提示错误信息，停留在登录页', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(EMAIL, 'wrong-password-123456');

    await expect(loginPage.errorMessage).toBeVisible();
    await expect(loginPage.errorMessage).toHaveText('用户名或密码错误');
    await expect(loginPage.submitButton).toBeVisible();
  });
});
