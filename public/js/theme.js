/**
 * 主题模块（精简版）
 *
 * 现状（2026-10-04 残留清理后的事实）：**单主题樱白粉**（主色 #e884a8、底色 #fffbfc），
 * 无主题切换 UI，style.css 的 `:root` 默认值即最终色——旧的 `[data-theme]` 变量壳
 * 已在早前重构中清理（恢复需从 git 历史取回，见 PRODUCT-SPEC §5.13）。
 * 本模块只保留历史接口：initTheme / setTheme（no-op）与 isFxEnabled（完成特效开关，
 * 默认常开，供 app.js / stats.js / blindbox.js 调用）。
 */

// 完成特效默认常开（FX 开关 UI 已移除）
const fxEnabled = true;

/** 初始化（兼容旧接口，现无实际操作） */
export function initTheme() {}

/** 切换主题（兼容旧接口，no-op——单主题产品，无多主题体系可切） */
export function setTheme(_theme) {}

/** 当前主题名（历史接口，无消费方；单主题产品没有"当前主题"概念，返回 null） */
export function getCurrentTheme() {
  return null;
}

/**
 * 特效是否启用（彩带、音效、震动）—— 默认常开。
 * E2E 钩子：localStorage 显式放 `__e2e_fx_off = '1'` 时返回 false —— E2E 跑批默认走
 * 降级通道（开出卡片退化为静态精卡，技术方案 §12），另设 fx 全开的冒烟用例。
 * 与 blindbox.js 的 __e2e_force_rarity 同一模式：生产环境没有任何入口写这个 key。
 */
export function isFxEnabled() {
  try {
    if (localStorage.getItem('__e2e_fx_off') === '1') return false;
  } catch (_e) { /* 隐私模式等场景下 localStorage 不可用，按常开走 */ }
  return fxEnabled;
}
