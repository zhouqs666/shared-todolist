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
   *
   * 两个真实陷阱（CI 实测，均有失败截图佐证）：
   *   1. 软键盘盖住右下角 FAB → 元素在 DOM 中却判定不可见，先收键盘。
   *   2. **面板其实已经打开、但 a11y 树刷新滞后**：第 1 轮点开面板后
   *      todoInput 一时探测不到，进入第 2 轮时 FAB 已被面板遮住，
   *      若此处直接 waitForDisplayed 抛错就会整例失败——而面板明明是开的。
   *      所以 FAB 不可见不是错误信号：继续等 todoInput（它才是唯一判据）。
   */
  async openAddPanel(timeout = 15000) {
    await dismissKeyboard(this.driver);

    // FAB 只等一小会儿：正常秒出；被已打开的面板遮住时不值得久等
    const FAB_WAIT = 5000;
    const input = await this.driver.$(this.todoInput);

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (await input.isExisting()) {
        await input.waitForDisplayed({ timeout }).catch(() => {});
        return;
      }

      const fab = await this.driver.$(this.fabBtn);
      const fabReady = await fab
        .waitForDisplayed({ timeout: FAB_WAIT })
        .then(() => true)
        .catch(() => false);
      if (fabReady) {
        await fab.click().catch(() => {});
      }

      // 无论是否点到 FAB，都等一轮 todoInput：面板可能已打开但树未刷新
      if (await input.waitForExist({ timeout }).catch(() => false)) {
        await input.waitForDisplayed({ timeout }).catch(() => {});
        return;
      }
    }
    throw new Error('添加面板未能打开：todoInput 3 轮重试后仍不可见');
  }

  /**
   * 在添加面板输入待办内容并点击添加
   *
   * 注意：不调用 hideKeyboard()——它在 WebView 上会抛错并让 a11y 树卡在
   * 过渡态，后续元素查询全部超时（实测）。统一用 dismissKeyboard()（BACK，
   * 键盘展开时由输入法消费），并把「收键盘」放在等 ✓ 按钮**之前**——
   * 否则要先白等 8s 超时才发现是被键盘挡住。
   */
  async addTodo(text) {
    const input = await this.driver.$(this.todoInput);
    await input.addValue(text);
    await this.driver.pause(500);

    // ✓ 按钮在面板底部，键盘展开时会盖住它
    await dismissKeyboard(this.driver);

    const addBtn = await this.driver.$(this.addBtn);
    await addBtn.waitForDisplayed({ timeout: 15000 }).catch(async () => {
      // 兜底：再收一次键盘（树可能刚刷新）后重等
      await dismissKeyboard(this.driver);
      await addBtn.waitForDisplayed({ timeout: 15000 });
    });
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
