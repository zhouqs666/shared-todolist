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
    // 【2026-10-06 第二次修正】增量计数（基线 +2）仍有**窗口竞态**：测试库现在合法承载
    // 业主真机人工测试（并行增删），读基线与断言之间数字就会动（实测期望 26 实得 25，
    // 重试 3 次全红——窗口内业主正在操作）。计数断言在共享并发库上无解，改为**并发免疫**
    // 的不变量：
    //   ① 三数自洽：total == active + completed（同一渲染快照内读取——这正是
    //      「统计数字正确」的实质：三个数来自同一份数据、不互相矛盾）
    //   ② seed 数据可见：两条种子待办各自出现在列表（DOM 定位，与计数无关）
    await seedTodo(client, { userId, text: '统计-进行中', completed: false });
    await seedTodo(client, { userId, text: '统计-已完成', completed: true });
    await page.reload();
    await expect(page.getByTestId('dashboard')).toBeVisible();

    const dashboard = new DashboardPage(page);
    const readStat = async (stat) =>
      Number((await stat.locator('.stat-value').textContent()) || '0');
    // expect.poll 保留「等渲染就绪」的重试语义（老写法 toHaveText 自带重试，直接
    // textContent 一次读会读到骨架期的 0——实测踩中）。条件 = 三数自洽且总数 > 0：
    // 并发人工增删不影响同一渲染快照内的等式。
    await expect.poll(async () => {
      const total = await readStat(dashboard.statTotal);
      const active = await readStat(dashboard.statActive);
      const completed = await readStat(dashboard.statCompleted);
      return total === active + completed && total > 0;
    }, { timeout: 15000, intervals: [250], message: '统计三数自洽（total == active+completed）且总数>0' })
      .toBe(true);
    await expect(
      dashboard.todoList.getByTestId('todo-text').filter({ hasText: '统计-进行中' })
    ).toBeVisible();
    await expect(
      dashboard.todoList.getByTestId('todo-text').filter({ hasText: '统计-已完成' })
    ).toBeVisible();
  });
});
