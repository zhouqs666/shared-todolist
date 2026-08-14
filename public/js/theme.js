/**
 * 主题模块（精简版）
 *
 * 主题切换 UI 已移除（低频且占顶栏空间）。固定使用 mint 主题。
 * 保留 isFxEnabled（完成特效开关，默认常开）供 app.js / stats.js 调用。
 *
 * 主题变量系统仍保留在 style.css（:root + data-theme），
 * 默认 mint，未来若需恢复切换只需重新接入。
 */

// 完成特效默认常开（FX 开关 UI 已移除）
const fxEnabled = true;

/** 初始化（兼容旧接口，现无实际操作） */
export function initTheme() {}

/** 切换主题（兼容旧接口，当前为 no-op，固定 mint） */
export function setTheme(_theme) {}

/** 当前主题名 */
export function getCurrentTheme() {
  return 'mint';
}

/** 特效是否启用（彩带、音效、震动）—— 默认常开 */
export function isFxEnabled() {
  return fxEnabled;
}
