import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage.js';
import { DashboardPage } from '../pages/DashboardPage.js';
import {
  createTestClient,
  getTestUserId,
  seedTodo,
  cleanupE2EData,
} from '../utils/test-data.js';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

let client;
let userId;

test.beforeAll(async () => {
  if (!EMAIL || !PASSWORD) {
    throw new Error('缺少 E2E_TEST_EMAIL / E2E_TEST_PASSWORD，请配置 admin/.env.test');
  }
  client = createTestClient();
  userId = await getTestUserId(client, EMAIL);
});

// 测试独立性（方案 §3.3）：每个用例自备数据、自清理，不依赖执行顺序。
test.beforeEach(async ({ page }) => {
  await cleanupE2EData(client);
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.login(EMAIL, PASSWORD);
  await expect(page.getByTestId('dashboard')).toBeVisible();
});

test.afterEach(async () => {
  await cleanupE2EData(client);
});

test.describe('待办管理', () => {
  test('列表显示已存在的待办', async ({ page }) => {
    await seedTodo(client, { userId, text: '查看列表-目标待办' });
    await page.reload();
    await expect(page.getByTestId('dashboard')).toBeVisible();

    const dashboard = new DashboardPage(page);
    await expect(dashboard.todoList).toBeVisible();
    await expect(
      dashboard.todoList
        .getByTestId('todo-text')
        .filter({ hasText: '查看列表-目标待办' })
    ).toBeVisible();
  });

  test('搜索过滤待办内容', async ({ page }) => {
    await seedTodo(client, { userId, text: '搜索-苹果' });
    await seedTodo(client, { userId, text: '搜索-香蕉' });
    await page.reload();
    await expect(page.getByTestId('dashboard')).toBeVisible();

    const dashboard = new DashboardPage(page);
    await dashboard.search('苹果');

    await expect(
      dashboard.todoList.getByTestId('todo-text').filter({ hasText: '苹果' })
    ).toBeVisible();
    await expect(
      dashboard.todoList.getByTestId('todo-text').filter({ hasText: '香蕉' })
    ).toHaveCount(0);
  });

  test('删除待办走软删除，从列表消失', async ({ page }) => {
    await seedTodo(client, { userId, text: '删除-目标待办' });
    await page.reload();
    await expect(page.getByTestId('dashboard')).toBeVisible();

    const dashboard = new DashboardPage(page);
    const target = dashboard.todoItemByText('删除-目标待办');
    await target.getByTestId('todo-delete-button').click();

    // 确认弹窗
    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('confirm-delete-button').click();

    // 从列表消失
    await expect(target).toHaveCount(0);
  });

  test('统计数字正确（全部 / 进行中 / 已完成）', async ({ page }) => {
    // 前提：独立测试库纯净（仅本次 seed 的数据）
    await seedTodo(client, { userId, text: '统计-进行中', completed: false });
    await seedTodo(client, { userId, text: '统计-已完成', completed: true });
    await page.reload();
    await expect(page.getByTestId('dashboard')).toBeVisible();

    const dashboard = new DashboardPage(page);
    await expect(dashboard.statTotal.locator('.stat-value')).toHaveText('2');
    await expect(dashboard.statActive.locator('.stat-value')).toHaveText('1');
    await expect(dashboard.statCompleted.locator('.stat-value')).toHaveText('1');
  });
});
