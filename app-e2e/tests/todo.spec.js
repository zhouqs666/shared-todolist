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

  it('点击复选框标记完成；取消完成走撤销 Toast（写库验证）', async () => {
    const seeded = await seedTodo(client, { userId, text: '标记完成-目标待办' });

    await relaunchAndLogin();

    // ① 点复选框 → 完成（轮询测试库确认 completed=true）
    await dashboardPage.toggleTodoByText(seeded.text);
    await waitForTodoCompleted(client, seeded.text, true);
    // UI 侧同验一次：已完成 ⇒ 复选框的无障碍标签变成「标为未完成」
    expect(await dashboardPage.isTodoMarkedDone(seeded.text)).toBe(true);

    // ② 取消完成 → 完成瞬间那条「撤销」Toast（v2.7.69 起，取消完成只剩两处入口：
    //    这条 5 秒撤销 Toast、以及长按卡片菜单里的「撤销完成」）。
    //
    // ⚠️ 这里**曾经**是「再点一下复选框」—— v2.7.69 有意移除了那个入口（已完成卡片的复选框
    //    变成 opacity:0 + pointer-events:none）。用例没跟着改，于是在 #59 之后连红 3 个 commit
    //    （elementClick 命令返回成功、库里 completed 却回不到 false，两次重试都一样）。
    const undo = await browser.$('//*[@text="撤销"]');
    await undo.waitForDisplayed({ timeout: 8000 });
    await undo.click();
    await waitForTodoCompleted(client, seeded.text, false);
    expect(await dashboardPage.isTodoMarkedDone(seeded.text)).toBe(false);
    const visible = await dashboardPage.hasTodo(seeded.text);
    expect(visible).toBe(true);
  });
});
