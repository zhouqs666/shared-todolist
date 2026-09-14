/**
 * Page Object：APP 主界面（待办列表）
 *
 * 元素定位：Capacitor WebView 的 HTML id 映射为 resource-id；ARIA 属性映射为
 * content-desc（role=checkbox + aria-label="标为已完成"）。统一用 class 无关的
 * //*[@resource-id=...] / //*[@content-desc=...]，不押注具体 Android 类名
 * （WebView 里 div/button 映射出的 Android 类不稳定）。
 *
 * 输入方式同 LoginPage：只能 addValue 逐字键入，setValue 不回写 WebView DOM。
 *
 * 点击右下角 FAB 前必须收软键盘（键盘正好盖住 FAB 与底部操作区，
 * 详见 utils/device.js 顶部说明）。
 */
import { dismissKeyboard } from '../utils/device.js';

export class DashboardPage {
  constructor(driver) {
    this.driver = driver;
    this.todoList = '//*[@resource-id="todoList"]';
    this.fabBtn = '//*[@resource-id="fabBtn"]';
    this.todoInput = '//*[@resource-id="todoInput"]';
    this.addBtn = '//*[@resource-id="addBtn"]';
  }

  /**
   * 等待主界面加载完成（登录跳转 + 待办拉取后列表容器可见）
   */
  async waitForLoaded(timeout = 30000) {
    const todoListEl = await this.driver.$(this.todoList);
    await todoListEl.waitForDisplayed({ timeout });
  }

  /**
   * 点击 FAB 打开底部添加面板
   * 健壮性：
   *   1. 先收软键盘——FAB 在主界面右下角，键盘展开时正好被盖住，
   *      元素在 DOM 中却判定不可见（详见 utils/device.js 顶部说明）。
   *   2. 登录跳转后立即点击，WebView a11y 树可能尚未刷新（元素被剪枝、
   *      existing=false）。用「探测输入框是否存在」判断面板状态，最多重试 3 轮
   *      （每轮：已存在则收工；不存在则点一次 FAB 再等）——即使某次点击因树
   *      未刷新误判，后续轮次也能收敛到面板打开。
   */
  async openAddPanel(timeout = 8000) {
    await dismissKeyboard(this.driver);

    const input = await this.driver.$(this.todoInput);
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (await input.isExisting()) {
        await input.waitForDisplayed({ timeout });
        return;
      }
      const fab = await this.driver.$(this.fabBtn);
      await fab.waitForDisplayed({ timeout });
      await fab.click();
      await input.waitForExist({ timeout }).catch(() => {});
    }
    throw new Error('添加面板未能打开：todoInput 3 轮重试后仍不可见');
  }

  /**
   * 在添加面板输入待办内容并点击添加
   * 注意：不调用 hideKeyboard()——它在 WebView 上会抛错并让 a11y 树卡在
   * 过渡态，后续元素查询全部超时（实测）。软键盘不遮挡 ✓ 按钮，无需收起；
   * 万一键盘真挡住，BACK 键收起并触发窗口事件刷新树。
   */
  async addTodo(text) {
    const input = await this.driver.$(this.todoInput);
    await input.addValue(text);
    await this.driver.pause(500);

    const addBtn = await this.driver.$(this.addBtn);
    try {
      await addBtn.waitForDisplayed({ timeout: 8000 });
    } catch {
      // 树未刷新：BACK 收起键盘（若有）触发 a11y 事件，再等一轮
      if (await this.driver.isKeyboardShown().catch(() => false)) {
        await this.driver.pressKeyCode(4).catch(() => {});
      }
      await addBtn.waitForDisplayed({ timeout: 10000 });
    }
    await addBtn.click();
  }

  /**
   * 列表中是否存在包含指定文本的待办
   * 用单条 XPath 存在性探测，不用 $$ 迭代句柄——列表重渲染（新待办插入）
   * 会让句柄瞬间陈旧，getText 逐个读时就会 Index out of bounds。
   *
   * 超时 30s：waitForLoaded() 只等列表「容器」出现（空态也满足），容器之后
   * 待办数据是异步拉的。CI 上首次冷启动（WebView 冷、网络冷）实测可能 >10s
   * 才拉回来，给足余量；命中即返回，正常情况不会变慢。
   */
  async hasTodo(text, timeout = 30000) {
    const el = await this.driver.$(
      `//*[@resource-id="todoList"]//*[contains(@text,"${text}")]`
    );
    return await el.waitForExist({ timeout }).catch(() => false);
  }

  /**
   * 点击指定待办的圆形复选框（切换完成/未完成）
   * 实测（getPageSource 校准）：自绘 checkbox（button role=checkbox）映射为
   * android.widget.CheckBox，aria-label 落在 @text 而非 @content-desc，
   * 值随状态在「标为已完成/未完成」间切换；DOM 里复选框位于同一条待办文本之前，
   * 用 nearest preceding 定位到它。
   */
  async toggleTodoByText(text) {
    const checkbox = await this.driver.$(
      `//*[@resource-id="todoList"]//*[@text="${text}"]` +
        `/preceding::*[@text="标为已完成" or @text="标为未完成"][1]`
    );
    await checkbox.waitForDisplayed({ timeout: 10000 });
    await checkbox.click();
  }
}
