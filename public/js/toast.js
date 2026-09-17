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
 *
 * 【2026-09-17 修正】上面的「只保留最新一条」对**普通信息**成立，但对**带操作入口的提示
 * （opts.action，如删除后的「撤销」）不成立** —— 那是恢复数据的入口，丢了就是功能缺失：
 * 删除待办弹的「已移到回收站 + 撤销」只要落进排队，期间来任何一条别的提示就会被静默丢掉，
 * 用户以为"这次删了没得撤"。
 * 现在的不变量（比早先写的"永不被丢弃"更准确）：
 *   · 带入口的提示不会被**普通信息**挤掉，且优先插队首；
 *   · 连删多条时队列有界，超出上界会丢**最旧**的入口（不是最新的那条 —— 用户最可能想撤的是刚做的）；
 *   · `urgent`（错误提示）仍然抢占，但**保留**排队中的入口一起等下一条。
 */

let toastTimer = null;
let showing = false;
const queue = [];

/** 提示是否带操作入口（如「撤销」）—— 入口是功能，不是信息，不该被普通提示挤掉 */
const hasAction = (opts) => !!(opts && opts.action && opts.action.label);

/** 队列上限 */
const MAX_QUEUE = 4;

export function showToast(msg, opts = {}) {
  const toast = ensureToast();
  if (!opts.urgent && showing) {
    if (hasAction(opts)) {
      // 入口优先：插队首，保证下一个显示的就是它
      queue.unshift({ msg, opts });
    } else if (queue.some((q) => hasAction(q.opts))) {
      // 队列里已有入口 —— 不能清空，排到它后面
      queue.push({ msg, opts });
    } else {
      // 普通提示之间维持原设计：过期文案比不弹更让人困惑，只留最新一条
      queue.length = 0;
      queue.push({ msg, opts });
    }
    // 压回上界：优先丢普通信息；整队都是入口时丢**最旧**的那条
    // （入口用 unshift 入队 ⇒ 数组尾是最旧的；用户最可能想撤的是刚做的那次）
    while (queue.length > MAX_QUEUE) {
      const idx = queue.findIndex((q) => !hasAction(q.opts));
      if (idx !== -1) queue.splice(idx, 1);
      else queue.pop();
    }
    return;
  }
  if (opts.urgent) {
    // 错误提示抢占当前提示，但**保留**排队中的操作入口 ——
    // 撤销是恢复数据的唯一入口，不该被一条错误文案吞掉
    const keepActions = queue.filter((q) => hasAction(q.opts));
    queue.length = 0;
    queue.push(...keepActions);
  }
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
