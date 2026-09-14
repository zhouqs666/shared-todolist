import { expect } from '@wdio/globals';
import { LoginPage } from '../pages/LoginPage.js';
import { DashboardPage } from '../pages/DashboardPage.js';
import { getTestCredentials } from '../utils/test-data.js';
import { dismissAnrDialogIfPresent } from '../utils/device.js';

let credentials;
let loginPage;
let dashboardPage;

before(async () => {
  credentials = getTestCredentials();
});

describe('APP 登录', () => {
  beforeEach(async () => {
    loginPage = new LoginPage(browser);
    dashboardPage = new DashboardPage(browser);
  });

  it('正确账号密码登录成功，进入主界面', async () => {
    // 快速重置模式：会话启动即清应用数据，App 冷启动后应停在登录页
    await loginPage.waitForLoaded();

    await loginPage.login(credentials.username, credentials.password);

    // 登录成功 → 跳转主界面，待办列表可见
    await dashboardPage.waitForLoaded();
    const todoList = await browser.$(dashboardPage.todoList);
    await expect(todoList).toBeDisplayed();
  });

  it('错误密码提示错误信息，停留在登录页', async () => {
    // reloadSession = 再次清应用数据，回到未登录状态
    await browser.reloadSession();
    // 切后台会诱发启动器 ANR 弹窗，先清掉再操作
    await dismissAnrDialogIfPresent(browser);
    loginPage = new LoginPage(browser);
    await loginPage.waitForLoaded();

    await loginPage.login(credentials.username, 'wrong-password-123456');

    const errorMsg = await loginPage.getErrorMessage();
    expect(errorMsg).toBeTruthy();
    expect(errorMsg).toContain('错误');

    // 仍停留在登录页：登录按钮依旧可见
    const submitBtn = await browser.$(loginPage.submitButton);
    await expect(submitBtn).toBeDisplayed();
  });
});
