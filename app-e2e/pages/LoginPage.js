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
 */
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
   */
  async waitForLoaded(timeout = 20000) {
    const usernameField = await this.driver.$(this.usernameInput);
    await usernameField.waitForDisplayed({ timeout });
  }

  /**
   * 输入用户名和密码并点击登录
   */
  async login(username, password) {
    // CI 模拟器比本地慢，元素可能分批渲染——逐个等待，不要提前缓存句柄
    const usernameField = await this.driver.$(this.usernameInput);
    await usernameField.waitForDisplayed({ timeout: 15000 });

    const passwordField = await this.driver.$(this.passwordInput);
    await passwordField.waitForDisplayed({ timeout: 5000 });

    await usernameField.addValue(username);
    await passwordField.addValue(password);

    // submit 按钮在输入后才渲染（CI 时序差异），必须单独等待
    const submitBtn = await this.driver.$(this.submitButton);
    await submitBtn.waitForDisplayed({ timeout: 10000 });
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
