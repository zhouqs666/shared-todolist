/**
 * Page Object：登录页
 * 元素定位集中在 data-testid（Playwright getByTestId），用例只描述业务流。
 */
export class LoginPage {
  constructor(page) {
    this.page = page;
    this.usernameInput = page.getByTestId('login-username');
    this.passwordInput = page.getByTestId('login-password');
    this.submitButton = page.getByTestId('login-submit');
    this.errorMessage = page.getByTestId('login-error');
  }

  async goto() {
    await this.page.goto('/');
  }

  async login(email, password) {
    await this.usernameInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }
}
