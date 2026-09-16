/**
 * 全局 Toast 反馈（轻量提示，自动消失）
 * 抽成独立模块，供 app.js / blindbox.js / sticker-book.js 等复用，避免循环依赖。
 *
 * 支持变体（opts 可选）：
 *   - 无 opts           → 原样深灰胶囊（图鉴/配图/开奖等通用提示，向后兼容）
 *   - {variant:'success'} → 品牌色完成卡（带勾图标 + 弹簧进入）
 *   - {variant:'rarity', accent, icon} → 隐藏款专属卡（accent 染色光晕 + 图标）
 *   - {action:{label, onClick}} → 右侧附加一个可点按钮（如删除后的「撤销」）
 *   - {urgent:true}     → 错误提示专用：立刻抢占当前提示，并丢弃排队项
 *
 * 【2026-09-16】改为**串行展示**：全部提示共用一个 #toast 节点，上一条还在显示时
 * 新提示排队等它消失，而不是当场把它顶掉。
 * 为什么必须改：一次开奖会连发两条提示（开奖庆祝 + 解锁贴纸），后发的那条会把先发的
 * 整条覆盖（连 className/dataset/文字/撤销按钮一起重置），于是这些信息用户永远看不到：
 *   · 「X图鉴已集齐，继续探索其它稀有度吧」（被 60ms 后的开奖提示顶掉）
 *   · 「图片上传失败，可长按待办补图」（被开奖提示顶掉 → 用户以为图片传成功了）
 *   · 完成隐藏款待办的「撤销」按钮（被开奖提示顶掉 → 误完成后没有撤回入口）
 * 排队只保留最新一条（旧排队项丢弃）：宁可少弹一条，也不要让过期信息延迟出现。
 */

let toastTimer = null;
let showing = false;
const queue = [];

export function showToast(msg, opts = {}) {
  const toast = ensureToast();
  if (!opts.urgent && showing) {
    // 丢弃旧排队项：延迟弹出的过期提示比不弹更让人困惑
    queue.length = 0;
    queue.push({ msg, opts });
    return;
  }
  if (opts.urgent) queue.length = 0;
  display(toast, msg, opts);
}

function ensureToast() {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  return toast;
}

/** 收起当前提示；若队列里有等待的提示，立刻接着显示（视觉上表现为「换一条文案」） */
function hide() {
  clearTimeout(toastTimer);
  showing = false;
  const toast = document.getElementById('toast');
  if (toast) toast.classList.remove('toast--show');
  const next = queue.shift();
  if (next) display(ensureToast(), next.msg, next.opts);
}

function display(toast, msg, opts) {
  showing = true;
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
      hide(); // 走统一的收起路径，队列里的提示才能接着显示
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
  toastTimer = setTimeout(hide, duration);
}
