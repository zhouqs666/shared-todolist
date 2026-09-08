/**
 * Page Object：后台主页（Dashboard）
 */
export class DashboardPage {
  constructor(page) {
    this.page = page;
    this.dashboard = page.getByTestId('dashboard');
    this.currentUser = page.getByTestId('current-user');
    this.logoutButton = page.getByTestId('logout-button');
    this.statTotal = page.getByTestId('stat-total');
    this.statActive = page.getByTestId('stat-active');
    this.statCompleted = page.getByTestId('stat-completed');
    this.searchInput = page.getByTestId('search-input');
    this.searchClear = page.getByTestId('search-clear');
    this.todoList = page.getByTestId('todo-list');
    this.todoItem = page.getByTestId('todo-item');
  }

  async expectLoaded() {
    await this.dashboard.waitFor({ state: 'visible' });
  }

  async search(keyword) {
    await this.searchInput.fill(keyword);
  }

  /** 定位「文本包含指定内容」的那一条待办 */
  todoItemByText(text) {
    return this.todoList.getByTestId('todo-item').filter({ hasText: text });
  }

  async deleteTodoByText(text) {
    await this.todoItemByText(text).getByTestId('todo-delete-button').click();
  }
}
