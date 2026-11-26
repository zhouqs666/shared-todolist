/**
 * 临时闪烁诊断（2026-11-26，确认根因后删除）
 *
 * 真机现象：完成任意待办 → 打开史诗/传说复看卡会闪；退出 App 重进不闪；再完成一个又闪。
 * 怀疑对象：完成待办会创建 #toast；Toast 隐藏时只是 opacity:0，元素仍留在 DOM 里，
 * 且带 backdrop-filter: blur(8px) + position:fixed + z-index:11000（高于复看卡 1200）。
 * 本面板只做「移除 / 重建」这个隐藏层，不改产品行为，让业主在真机上直接 A/B/A。
 *
 * 入口：图鉴标题「收集图鉴」长按 1.5 秒。正常使用不可见。
 */

import confetti from './vendor/canvas-confetti.esm.min.js';

const PANEL_ID = 'toastDiag';
const CHIP_ID = 'toastDiagChip';
const STYLE_ID = 'toastDiagStyle';

let panel = null;
let chip = null;
let tick = 0;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${PANEL_ID} {
      position: fixed; top: 8px; left: 8px; z-index: 30002;
      width: 286px; max-width: calc(100vw - 16px);
      padding: 10px 12px; border-radius: 12px;
      background: rgba(24, 12, 28, .94); color: #fdf2f8;
      font: 12px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .45);
      -webkit-user-select: none; user-select: none;
    }
    #${PANEL_ID} .td-title { font-weight: 700; font-size: 13px; letter-spacing: .06em; color: #fde68a; }
    #${PANEL_ID} .td-hint { margin: 4px 0 8px; color: rgba(253, 242, 248, .72); font-size: 11px; }
    #${PANEL_ID} .td-status { margin: 6px 0; padding: 6px 8px; border-radius: 8px; background: rgba(255,255,255,.06); font-size: 11px; color: #fbcfe8; }
    #${PANEL_ID} .td-row { display: flex; gap: 6px; margin: 6px 0; }
    #${PANEL_ID} button {
      flex: 1; border: 1px solid rgba(253, 230, 138, .45); border-radius: 8px;
      background: rgba(253, 230, 138, .12); color: #fde68a;
      font: inherit; padding: 5px 6px; cursor: pointer;
    }
    #${PANEL_ID} button.td-danger { border-color: rgba(244, 114, 182, .7); background: rgba(232, 132, 168, .22); color: #fff; }
    #${PANEL_ID} .td-hide { width: 100%; margin-top: 2px; }
    #${CHIP_ID} {
      position: fixed; top: 8px; left: 8px; z-index: 30001;
      width: 30px; height: 30px; border-radius: 9px;
      border: 1px solid rgba(253, 230, 138, .5);
      background: rgba(24, 12, 28, .9); color: #fde68a;
      font: 700 12px/1 -apple-system, BlinkMacSystemFont, sans-serif;
      display: none;
    }
  `;
  document.head.appendChild(style);
}

function toastState() {
  const t = document.getElementById('toast');
  if (!t) return { exists: false };
  const cs = getComputedStyle(t);
  return {
    exists: true,
    show: t.classList.contains('toast--show'),
    opacity: cs.opacity,
    visibility: cs.visibility,
    display: cs.display,
    backdrop: cs.backdropFilter || cs.webkitBackdropFilter,
    z: cs.zIndex,
    text: (t.textContent || '').slice(0, 16),
  };
}

function refresh() {
  if (!panel) return;
  const s = toastState();
  const canvases = document.querySelectorAll('body > canvas').length;
  const status = panel.querySelector('.td-status');
  if (status) {
    status.textContent = s.exists
      ? `#toast：存在（${s.show ? '显示中' : '已隐藏'}）· opacity ${s.opacity} · ${s.display} · backdrop ${s.backdrop} · z ${s.z}\nbody > canvas：${canvases} 个`
      : `#toast：不存在\nbody > canvas：${canvases} 个`;
  }
}

function removeToast() {
  const t = document.getElementById('toast');
  if (t) t.remove();
  refresh();
}

/** 重建一块与完成 Toast 隐藏态完全同形的层：no .toast--show ⇒ opacity 0 + blur(8px) + z11000 */
function rebuildHiddenToast() {
  const old = document.getElementById('toast');
  if (old) old.remove();
  const t = document.createElement('div');
  t.id = 'toast';
  t.className = 'toast';
  t.textContent = '诊断：隐藏 Toast 层';
  document.body.appendChild(t);
  refresh();
}

function clearCanvas() {
  try { confetti.reset(); } catch (_e) { /* ignore */ }
  for (const c of document.querySelectorAll('body > canvas')) {
    if (!c.id) c.remove();
  }
  refresh();
}

function openPanel() {
  injectStyle();
  if (!panel) {
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="td-title">Toast 隐藏层诊断（临时）</div>
      <div class="td-hint">完成一个待办 → 长按图鉴标题开面板 → 打开史诗/传说复看卡 → 点「移除 Toast 层」→ 收起 → 观察 20–30 秒；再「重建隐藏 Toast 层」→ 收起 → 应闪回来。面板自身也是合成层，观察时务必收起（左上角小 T 芯片可重新打开）。</div>
      <div class="td-status"></div>
      <div class="td-row">
        <button type="button" class="td-danger" data-td="remove">移除 Toast 层</button>
        <button type="button" data-td="rebuild">重建隐藏 Toast 层</button>
      </div>
      <div class="td-row">
        <button type="button" data-td="canvas">清除全屏画布</button>
      </div>
      <button type="button" class="td-hide" data-td="hide">收起</button>
    `;
    document.body.appendChild(panel);
    panel.querySelector('[data-td="remove"]').addEventListener('click', removeToast);
    panel.querySelector('[data-td="rebuild"]').addEventListener('click', rebuildHiddenToast);
    panel.querySelector('[data-td="canvas"]').addEventListener('click', clearCanvas);
    panel.querySelector('[data-td="hide"]').addEventListener('click', hidePanel);
  }
  panel.style.display = 'block';
  if (chip) chip.style.display = 'none';
  refresh();
  if (!tick) tick = setInterval(refresh, 500);
}

function hidePanel() {
  if (panel) panel.style.display = 'none';
  if (!chip) {
    chip = document.createElement('button');
    chip.id = CHIP_ID;
    chip.type = 'button';
    chip.textContent = 'T';
    chip.setAttribute('aria-label', '打开 Toast 诊断');
    chip.addEventListener('click', openPanel);
    document.body.appendChild(chip);
  }
  chip.style.display = 'block';
  if (tick) { clearInterval(tick); tick = 0; }
}

function bindLongPress(el) {
  let timer = 0;
  let startX = 0;
  let startY = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = 0; } };
  el.addEventListener('pointerdown', (e) => {
    cancel();
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => { timer = 0; openPanel(); }, 1500);
  });
  el.addEventListener('pointermove', (e) => {
    if (!timer) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 16) cancel();
  });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

export function initToastDiag() {
  const title = document.querySelector('#stickerModal .sticker-modal__title');
  if (!title) return;
  injectStyle();
  bindLongPress(title);
}