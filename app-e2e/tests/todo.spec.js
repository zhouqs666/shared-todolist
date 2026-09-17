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

  it('点击复选框标记完成；取消完成走撤销入口（写库验证）', async () => {
    const seeded = await seedTodo(client, { userId, text: '标记完成-目标待办' });

    await relaunchAndLogin();

    // ① 点复选框 → 完成（UI 侧确认）
    await dashboardPage.toggleTodoByText(seeded.text);
    expect(await dashboardPage.isTodoMarkedDone(seeded.text)).toBe(true);

    // ② 撤销完成 → 走长按菜单里的「撤销完成」
    //
    // ⚠️ 这里曾经连红多次，根因值得记住（v2.7.75 定位）：
    //    · 完成款撤销 Toast 只在屏上停留约 2.5 秒；
    //    · 而本机 Appium 的 elementClick **每次约 10.4 秒**（UiAutomator2 动作后等应用 idle，
    //      本应用有常驻无限动画 —— 心跳 / shimmer / 隐藏款镀膜旋转 —— 永远等不到 idle，
    //      于是每次耗满上限）。10s ≫ 2.5s ⇒ 点击落下时 Toast 早已收起。
    //      （试过 `appium:waitForIdleTimeout` 与 Appium 2 的 `appium:settings` 两种写法，
    //        实测**都没能改变这 10.4 秒**，故不在配置上继续纠缠。）
    //    · 那它以前为什么能过？因为 `.toast__action` 当时无条件 `pointer-events:auto` ——
    //      收起后按钮仍是**可点的透明热区**，用例点的是那个残留热区，靠缺陷蒙对了。
    //      v2.7.75 修掉该缺陷（误触会真的把已完成的待办改回去）后，点击如实落空：
    //      elementClick 报成功、库里 completed 纹丝不动（与本文件上方 #59 同款症状）。
    //    ⇒ 改用**没有时间窗口**的等价入口（长按菜单）。Toast 那条入口由 web E2E 覆盖：
    //      test_undo_complete.py 的 H1 用真实命中测试点它、H3 钉住"收起后不可点"的契约。
    await dashboardPage.uncompleteByMenu(seeded.text);
    await waitForTodoCompleted(client, seeded.text, false);
    expect(await dashboardPage.isTodoMarkedDone(seeded.text)).toBe(false);
    expect(await dashboardPage.hasTodo(seeded.text)).toBe(true);
  });
});
