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

    // ② 撤销完成 → 用「撤销」入口把 completed 改回 false
    //
    // ⚠️ 这里**不能**用 Appium 的原生点击去点那条撤销 Toast（v2.7.75 定论，两次 CI 实测）：
    //    · 本机 Appium 的 elementClick **每次约 10 秒**（UiAutomator2 点完要等应用 idle，
    //      而本应用有常驻无限动画 —— 心跳、骨架 shimmer、隐藏款光晕 —— 永远等不到 idle，
    //      于是每次都耗到超时上限）。其它用例的 elementClick 也都是 10s 左右，可佐证。
    //    · 而撤销 Toast 只在屏上停留 2.5 秒（完成款）/ 4 秒（隐藏款）——
    //      **10s ≫ 窗口**，等点击真正落下时 Toast 早就收起了。
    //    · 那它以前为什么能过？因为 `.toast__action` 原先无条件 `pointer-events:auto`，
    //      **收起后按钮仍是可点的透明热区** —— 用例点的是那个残留热区，蒙对了。
    //      v2.7.75 修掉了这个缺陷（误触会真的把已完成的待办改回去），于是点击如实落空：
    //      elementClick 报成功、库里 completed 纹丝不动 —— 正是上面记录过的 #59 同款症状。
    //
    //    所以这里改成用 JS 触发该按钮的 click：它验证的是**真实设备上「撤销」入口的
    //    处理器与写库链路**（web 端 E2E 的 H1 已用真实命中测试的点按覆盖同一条 toast 路径，
    //    H3 则钉住"收起后不可点"这个契约）。这样既不依赖 10s 的点击延迟，也不再靠缺陷蒙对。
    const undoClicked = await browser.execute(() => {
      const btn = document.querySelector('.toast__action');
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    });
    expect(undoClicked).toBe('clicked');

    await waitForTodoCompleted(client, seeded.text, false);
    expect(await dashboardPage.isTodoMarkedDone(seeded.text)).toBe(false);
    expect(await dashboardPage.hasTodo(seeded.text)).toBe(true);
  });
});
