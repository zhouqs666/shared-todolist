/**
 * 全局 Toast 反馈（轻量提示，自动消失）
 * 抽成独立模块，供 app.js / blindbox.js / sticker-book.js 等复用，避免循环依赖。
 *
 * 支持变体（opts 可选）：
 *   - 无 opts           → 原样深灰胶囊（图鉴/配图/开奖等通用提示，向后兼容）
 *   - {variant:'success'} → 品牌色完成卡（带勾图标 + 弹簧进入）
 *   - {variant:'rarity', accent, icon} → 隐藏款专属卡（accent 染色光晕 + 图标）
 *   - {action:{label, onClick}} → 右侧附加一个可点按钮（如删除后的「撤销」）
 */

let toastTimer = null;

export function showToast(msg, opts = {}) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }

  const variant = opts.variant || '';
  // 重置 class 到基线再按变体叠加（防止上次变体残留）
  toast.className = 'toast' + (variant ? ' toast--' + variant : '');
  toast.dataset.variant = variant || '';

  // 图标 + 文案：用 innerHTML 一次性写入（icon 是受控 SVG，msg 用 textContent 语义转义）
  toast.textContent = '';
  if (opts.icon) {
    const iconWrap = document.createElement('span');
    iconWrap.className = 'toast__icon';
    iconWrap.innerHTML = opts.icon; // 受控 SVG
    const textNode = document.createTextNode(msg);
    toast.appendChild(iconWrap);
    toast.appendChild(textNode);
  } else {
    const textNode = document.createTextNode(msg);
    toast.appendChild(textNode);
  }

  // action 按钮（如「撤销」）：附加到末尾，点击触发回调并立即收起
  if (opts.action && opts.action.label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast__action';
    btn.textContent = opts.action.label;
    btn.addEventListener('click', () => {
      toast.classList.remove('toast--show');
      clearTimeout(toastTimer);
      if (typeof opts.action.onClick === 'function') opts.action.onClick();
    });
    toast.appendChild(btn);
  }

  // accent 染色（隐藏款专属配色，通过 CSS 变量驱动）
  if (opts.accent) {
    toast.style.setProperty('--toast-accent', opts.accent);
  } else {
    toast.style.removeProperty('--toast-accent');
  }

  toast.classList.add('toast--show');
  clearTimeout(toastTimer);
  const duration = opts.duration || 2500;
  toastTimer = setTimeout(() => toast.classList.remove('toast--show'), duration);
}
