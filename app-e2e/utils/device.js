/**
 * 设备层辅助：处理 Android 系统弹窗
 *
 * CI 背景（阶段 3.6 血泪教训）：2 核 runner + swiftshader 软件渲染下，
 * `browser.reloadSession()` 会让 App 短暂切到后台，桌面启动器扛不住直接 ANR，
 * 系统弹出「Pixel Launcher isn't responding」对话框。该弹窗会盖住 App 并劫持
 * UiAutomator2 的无障碍树，使后续所有元素查找失败——表现为「第一个用例通过、
 * 其余全挂」，极易被误判成元素定位或时序问题。
 *
 * 主防线在 ci-run.sh：`settings put global hide_error_dialogs 1` 让系统不再弹窗。
 * 本文件是兜底：万一弹窗仍出现，自动点掉它，避免整轮用例连锁失败。
 */

// 「Wait / 等待」按钮在 ANR 弹窗上始终存在，且点击后不影响被测 App 状态；
// 「Close app / 关闭应用」会杀掉后台进程，故优先尝试 Wait。
const DISMISS_BUTTON_TEXTS = ['Wait', '等待'];

/**
 * 若存在系统 ANR/无响应弹窗，点掉它。
 * @returns {Promise<boolean>} 是否处理了弹窗
 */
export async function dismissAnrDialogIfPresent(driver) {
  for (const text of DISMISS_BUTTON_TEXTS) {
    let btn;
    try {
      btn = await driver.$(`android=new UiSelector().text("${text}")`);
      if (!(await btn.isExisting())) continue;
    } catch {
      continue;
    }
    console.log(`[device] 检测到系统无响应弹窗，点击「${text}」关闭`);
    await btn.click().catch(() => {});
    await driver.pause(500);
    return true;
  }
  return false;
}
