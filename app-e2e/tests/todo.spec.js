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

    // ① 点复选框 → 完成。UI 侧**立即**确认（本地乐观反馈，一次 WebDriver 往返），
    //    然后马上点「撤销」——
    //
    // ⚠️ 顺序很关键，别把写库轮询塞在中间（v2.7.75 修正）：
    //    撤销 Toast 只在屏幕上停留 5 秒，而 v2.7.75 起**收起后的撤销按钮不再可点**
    //    （pointer-events 门控在 .toast--show 上；修的是"提示早就消失、屏幕底部却还留着
    //    一个透明可点热区"那个缺陷 —— 误触会真的把已完成的待办改回去）。
    //    于是不能再像以前那样"靠元素还在 DOM 里"去点它：`opacity:0` 对 WebDriver 来说
    //    仍算 displayed，`waitForDisplayed` 会立刻返回，但点击会**落空**
    //    （elementClick 报成功、库里 completed 却纹丝不动 —— 与本文件上方记录过的
    //     #59 那次是同一类症状，只是成因不同）。
    //    所以：UI 断言放在点击之前，DB 断言放在撤销之后。
    await dashboardPage.toggleTodoByText(seeded.text);
    expect(await dashboardPage.isTodoMarkedDone(seeded.text)).toBe(true);

    // ② 撤销 → 完成瞬间那条「撤销」Toast（v2.7.69 起，取消完成只剩两处入口：
    //    这条 5 秒撤销 Toast、以及长按卡片菜单里的「撤销完成」）。
    const undo = await browser.$('//*[@text="撤销"]');
    await undo.waitForDisplayed({ timeout: 8000 });
    await undo.click();
    await waitForTodoCompleted(client, seeded.text, false);
    expect(await dashboardPage.isTodoMarkedDone(seeded.text)).toBe(false);
    const visible = await dashboardPage.hasTodo(seeded.text);
    expect(visible).toBe(true);

    // ③ 用 DB 复核「完成」这一步本身确实生效过（① 只看了 UI，这里补写库那一半）
    await dashboardPage.toggleTodoByText(seeded.text);
    await waitForTodoCompleted(client, seeded.text, true);
    expect(await dashboardPage.isTodoMarkedDone(seeded.text)).toBe(true);
  });
});
