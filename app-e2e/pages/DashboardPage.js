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

/**
 * 待办卡片上的圆形复选框 XPath
 *
 * 实测（getPageSource 校准）：自绘 checkbox（button role=checkbox）映射为
 * android.widget.CheckBox，aria-label 落在 @text 而非 @content-desc，
 * 值随状态在「标为已完成/未完成」间切换；DOM 里复选框位于同一条待办文本**之前**，
 * 用 nearest preceding 定位到它。
 */
const checkboxXPath = (text) =>
  `//*[@resource-id="todoList"]//*[@text="${text}"]` +
  `/preceding::*[@text="标为已完成" or @text="标为未完成"][1]`;

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
   * 三个真实陷阱（CI 实测，均有失败截图佐证）：
   *   1. 软键盘盖住右下角 FAB → 元素在 DOM 中却判定不可见，先收键盘。
   *   2. **面板已打开却被键盘盖住**：add 面板贴在屏幕底部，打开后输入框
   *      自动聚焦、键盘弹出，整个面板被压住 → todoInput 落不进无障碍树。
   *      截图特征：背景已模糊（=面板已开）却怎么也探测不到输入框。
   *      所以点完 FAB 必须立刻再收一次键盘。
   *   3. a11y 树刷新滞后：FAB 不可见不是错误信号（面板可能已经开了），
   *      唯一判据是 todoInput 是否真的「可见」，3 轮都不行才失败。
   */
  async openAddPanel(timeout = 15000) {
    await dismissKeyboard(this.driver);

    // FAB 只等一小会儿：正常秒出；被已打开的面板遮住时不值得久等
    const FAB_WAIT = 5000;
    const input = await this.driver.$(this.todoInput);
    const isVisible = (el, t) =>
      el.waitForDisplayed({ timeout: t }).then(() => true).catch(() => false);

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (await isVisible(input, 1000)) return;

      const fab = await this.driver.$(this.fabBtn);
      if (await isVisible(fab, FAB_WAIT)) {
        await fab.click().catch(() => {});
        await this.driver.pause(500); // 等底部面板弹出动画
      }

      await dismissKeyboard(this.driver); // 面板内输入框聚焦会弹键盘，收掉它
      if (await isVisible(input, timeout)) return;
    }

    // 失败时输出设备侧实况：键盘状态 + 页面上真实存在的 resource-id 清单。
    // 若面板输入框的实际 id 与 todoInput 不符，这里会直接暴露出来。
    const diag = {
      keyboardShown: await this.driver.isKeyboardShown().catch(() => 'unknown'),
      pageSourceIds: 'unavailable',
    };
    try {
      const src = await this.driver.getPageSource();
      diag.pageSourceIds = [...new Set([...src.matchAll(/resource-id="([^"]+)"/g)].map((m) => m[1]))].join(', ');
    } catch (e) {
      diag.pageSourceIds = 'getPageSource 失败: ' + (e && e.message);
    }
    console.error('[DashboardPage] openAddPanel 失败诊断:', JSON.stringify(diag, null, 2));

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
   *
   * ⚠️ v2.7.69 起：**已完成的卡片**复选框变为 opacity:0 + pointer-events:none，
   * 「再点一下取消完成」这条入口被有意移除。所以本方法的语义是"点一下复选框"，
   * **能不能生效取决于卡片当前状态** —— 调用方必须自己断言结果，不要假定它一定会翻转。
   */
  async toggleTodoByText(text) {
    const checkbox = await this.driver.$(checkboxXPath(text));
    await checkbox.waitForDisplayed({ timeout: 10000 });
    await checkbox.click();
  }

  /**
   * 该待办当前是否被标记为已完成（读复选框的无障碍标签）
   *
   * 判据：已完成时复选框的 aria-label 变成「标为未完成」—— 标签描述的是"点它会怎样"，
   * 所以**已完成 = 标签是「标为未完成」**（容易读反，这里写死判据）。
   * 用存在性探测而不是先拿句柄再读属性：列表重渲染会让句柄瞬间陈旧（见 hasTodo 注释）。
   */
  async isTodoMarkedDone(text, timeout = 5000) {
    const el = await this.driver.$(
      `//*[@resource-id="todoList"]//*[@text="${text}"]/preceding::*[@text="标为未完成"][1]`
    );
    return await el.waitForExist({ timeout }).catch(() => false);
  }
}
