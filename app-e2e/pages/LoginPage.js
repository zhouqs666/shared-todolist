/**
 * Page Object：APP 登录页
 *
 * 元素定位：Capacitor WebView 的 HTML id 会被 Chromium 无障碍树映射为
 * resource-id（如 id="username" → [@resource-id="username"]）。
 * 统一用 class 无关的 //*[@resource-id=...]，不押注具体 Android 类名。
 *
 * 输入方式：必须用 addValue（逐字键盘输入）。setValue/clearValue 走
 * accessibility 的 ACTION_SET_TEXT，在 Chromium WebView 上不回写 DOM——
 * 字段看着被赋值，提交时 JS 读到的仍是空串（血泪教训：密码框假输入导致登录必败）。
 *
 * 点击「登录」前必须收软键盘：手机键盘会盖住页面下半部分，按钮虽在 DOM 中却
 * 被判定为不可见（详见 utils/device.js 顶部说明）。
 */
import { dismissKeyboard } from '../utils/device.js';

export class LoginPage {
  constructor(driver) {
    this.driver = driver;
    this.usernameInput = '//*[@resource-id="username"]';
    this.passwordInput = '//*[@resource-id="password"]';
    this.submitButton = '//*[@resource-id="submitBtn"]';
    this.errorMsg = '//*[@resource-id="errorMsg"]';
  }

  /**
   * 等待登录页加载完成（开屏动画 + index→login 重定向结束后表单才出现）
   *
   * 超时给到 60s：CI 上清除应用数据后的冷启动要重新初始化 WebView，
   * 2 核 + 软件渲染下明显慢于本地（实测 >20s 才出表单）。命中即返回，
   * 正常情况不会因为超时值大而变慢。
   */
  async waitForLoaded(timeout = 60000) {
    const usernameField = await this.driver.$(this.usernameInput);
    await usernameField.waitForDisplayed({ timeout });
  }

  /**
   * 输入用户名和密码并点击登录
   */
  async login(username, password) {
    // CI 模拟器比本地慢，元素可能分批渲染——逐个等待，不要提前缓存句柄
    const usernameField = await this.driver.$(this.usernameInput);
    await usernameField.waitForDisplayed({ timeout: 30000 });

    const passwordField = await this.driver.$(this.passwordInput);
    await passwordField.waitForDisplayed({ timeout: 10000 });

    await usernameField.addValue(username);
    await passwordField.addValue(password);

    // 先收键盘再点登录：否则键盘盖住按钮，waitForDisplayed 必然超时
    await dismissKeyboard(this.driver);

    // 收键盘后布局回弹，重新取句柄再点（旧句柄位置可能已过期）
    const submitBtn = await this.driver.$(this.submitButton);
    try {
      await submitBtn.waitForDisplayed({ timeout: 15000 });
    } catch (e) {
      // 仍失败时 dump 页面源码 + 截图，便于区分「元素不存在」与「被遮挡」
      const source = await this.driver.getPageSource();
      console.error('[LoginPage] submitBtn 不可见。页面源码前 1500 字符：');
      console.error(source.substring(0, 1500));
      await this.driver.takeScreenshot();
      throw e;
    }
    await submitBtn.click();
  }

  /**
   * 获取错误消息文本（未显示时返回 null）
   */
  async getErrorMessage(timeout = 5000) {
    const errorEl = await this.driver.$(this.errorMsg);
    await errorEl.waitForDisplayed({ timeout }).catch(() => null);
    if (await errorEl.isDisplayed()) {
      return await errorEl.getText();
    }
    return null;
  }

  /**
   * 断言错误消息可见
   */
  async isErrorMessageVisible() {
    const errorEl = await this.driver.$(this.errorMsg);
    return await errorEl.isDisplayed();
  }
}
