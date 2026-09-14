import { expect } from '@wdio/globals';
import { LoginPage } from '../pages/LoginPage.js';
import { DashboardPage } from '../pages/DashboardPage.js';
import {
  createTestClient,
  getTestUserId,
  seedTodo,
  cleanupE2EData,
  getTestCredentials,
  findTodosByText,
  waitForTodoCompleted,
  E2E_PREFIX,
} from '../utils/test-data.js';
import { dismissAnrDialogIfPresent } from '../utils/device.js';

let client;
let userId;
let credentials;
let loginPage;
let dashboardPage;

/**
 * 从未登录状态重新拉起 App 并登录进主界面
 * （noReset:false 快速重置模式下 reloadSession = 清数据重启，必然回到登录页）
 */
async function relaunchAndLogin() {
  await browser.reloadSession();
  // 切后台会诱发启动器 ANR 弹窗，先清掉再操作
  await dismissAnrDialogIfPresent(browser);
  loginPage = new LoginPage(browser);
  dashboardPage = new DashboardPage(browser);
  await loginPage.waitForLoaded();
  await loginPage.login(credentials.username, credentials.password);
  await dashboardPage.waitForLoaded();
  // 登录跳转后 WebView a11y 树需要片刻刷新，立即操作易 flaky
  await browser.pause(1500);
}

before(async () => {
  client = createTestClient();
  credentials = getTestCredentials();
  userId = await getTestUserId(client, credentials.username);
});

after(async () => {
  await cleanupE2EData(client);
});

describe('APP 待办管理', () => {
  beforeEach(async () => {
    loginPage = new LoginPage(browser);
    dashboardPage = new DashboardPage(browser);
  });

  afterEach(async () => {
    await cleanupE2EData(client);
  });

  it('列表显示已存在的待办（service_role 造数 → UI 可见）', async () => {
    const seeded = await seedTodo(client, { userId, text: '查看列表-目标待办' });

    await relaunchAndLogin();

    const visible = await dashboardPage.hasTodo(seeded.text);
    expect(visible).toBe(true);
  });

  it('创建新待办：出现在列表中，且已写入测试库', async () => {
    await relaunchAndLogin();

    const text = `${E2E_PREFIX}新建待办-${Date.now()}`;
    await dashboardPage.openAddPanel();
    await dashboardPage.addTodo(text);

    const visible = await dashboardPage.hasTodo(text);
    expect(visible).toBe(true);

    // 落库验证：不只看 UI，测试库里必须真的有这条且未完成
    const rows = await findTodosByText(client, text);
    expect(rows).toHaveLength(1);
    expect(rows[0].completed).toBe(false);
  });

  it('点击复选框标记完成，再点取消完成（写库验证）', async () => {
    const seeded = await seedTodo(client, { userId, text: '标记完成-目标待办' });

    await relaunchAndLogin();

    // 标记完成 → 轮询测试库确认 completed=true
    await dashboardPage.toggleTodoByText(seeded.text);
    await waitForTodoCompleted(client, seeded.text, true);

    // 再点取消 → completed 回到 false，且条目仍在列表
    await dashboardPage.toggleTodoByText(seeded.text);
    await waitForTodoCompleted(client, seeded.text, false);
    const visible = await dashboardPage.hasTodo(seeded.text);
    expect(visible).toBe(true);
  });
});
