/**
 * 主题切换模块
 *
 * 5 套主题：mint / pink / blue / sunset / dark
 * 偏好本地存储（localStorage），不同步给对方
 * 还包含完成特效（FX）开关，默认开启
 */

const STORAGE_KEY_THEME = 'todo-theme';
const STORAGE_KEY_FX = 'todo-fx';

const THEMES = ['mint', 'pink', 'blue', 'sunset', 'dark'];

let currentTheme = 'mint';
let fxEnabled = true;

/**
 * 初始化主题模块
 * 在 app.js 启动时调用一次
 */
export function initTheme() {
  // 读 localStorage（首次加载时 index.html 已经设置了 data-theme，这里同步读取）
  try {
    currentTheme = localStorage.getItem(STORAGE_KEY_THEME) || 'mint';
  } catch (_) {}
  try {
    fxEnabled = localStorage.getItem(STORAGE_KEY_FX) !== 'off';
  } catch (_) {}

  applyTheme(currentTheme);
  applyFxToggle(fxEnabled);

  const pickerBtn = document.getElementById('themePickerBtn');
  const menu = document.getElementById('themeMenu');
  const opts = document.querySelectorAll('.theme-picker__opt');
  const fxToggle = document.getElementById('fxToggle');
  const fxSwitch = document.getElementById('fxSwitch');

  if (!pickerBtn || !menu) return;

  // 切换菜单显示
  pickerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });

  // 点击菜单外关闭
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== pickerBtn) {
      menu.hidden = true;
    }
  });

  // 选择主题
  opts.forEach((opt) => {
    opt.addEventListener('click', () => {
      const theme = opt.dataset.theme;
      setTheme(theme);
      menu.hidden = true;
    });
  });

  // 切换特效
  if (fxToggle) {
    fxToggle.addEventListener('click', () => {
      fxEnabled = !fxEnabled;
      applyFxToggle(fxEnabled);
      try {
        localStorage.setItem(STORAGE_KEY_FX, fxEnabled ? 'on' : 'off');
      } catch (_) {}
    });
  }
}

/** 应用主题：设置 data-theme 属性 + 高亮当前选项 + 更新按钮色 */
function applyTheme(theme) {
  if (!THEMES.includes(theme)) theme = 'mint';
  currentTheme = theme;
  document.documentElement.dataset.theme = theme;

  // 更新菜单中选项的高亮
  document.querySelectorAll('.theme-picker__opt').forEach((opt) => {
    opt.classList.toggle('theme-picker__opt--active', opt.dataset.theme === theme);
  });
}

/** 应用特效开关 UI */
function applyFxToggle(enabled) {
  const sw = document.getElementById('fxSwitch');
  const toggle = document.getElementById('fxToggle');
  if (sw) sw.classList.toggle('theme-picker__switch--on', enabled);
  if (toggle) toggle.setAttribute('aria-checked', String(enabled));
}

/** 切换主题（外部调用） */
export function setTheme(theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY_THEME, theme);
  } catch (_) {}
}

/** 当前主题名 */
export function getCurrentTheme() {
  return currentTheme;
}

/** 特效是否启用（彩带、音效、震动） */
export function isFxEnabled() {
  return fxEnabled;
}
