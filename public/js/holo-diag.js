/**
 * 临时全息层诊断（2026-11-26，真机确认后删除）
 *
 * 目的：在真机上对比「全息层开/关」是否影响闪烁，同时确认 #rvHolo 的 backing store
 * 不再是 1×1（此前流光从未生效的根因）。
 *
 * 入口：图鉴标题「收集图鉴」长按 1.5 秒。正常使用不可见。
 */

import { setDiagHoloOff, getDiagHoloState } from './reveal-card.js';

const PANEL_ID = 'holoDiag';
const CHIP_ID = 'holoDiagChip';
const STYLE_ID = 'holoDiagStyle';

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
      width: 290px; max-width: calc(100vw - 16px);
      padding: 10px 12px; border-radius: 12px;
      background: rgba(24, 12, 28, .94); color: #fdf2f8;
      font: 12px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .45);
      -webkit-user-select: none; user-select: none;
    }
    #${PANEL_ID} .hd-title { font-weight: 700; font-size: 13px; letter-spacing: .06em; color: #fde68a; }
    #${PANEL_ID} .hd-hint { margin: 4px 0 8px; color: rgba(253, 242, 248, .72); font-size: 11px; }
    #${PANEL_ID} .hd-status { margin: 6px 0; padding: 6px 8px; border-radius: 8px; background: rgba(255,255,255,.06); font-size: 11px; color: #fbcfe8; white-space: pre-line; }
    #${PANEL_ID} button {
      width: 100%; border: 1px solid rgba(253, 230, 138, .45); border-radius: 8px;
      background: rgba(253, 230, 138, .12); color: #fde68a;
      font: inherit; padding: 6px; cursor: pointer; margin: 4px 0;
    }
    #${PANEL_ID} button.hd-off { border-color: rgba(244, 114, 182, .7); background: rgba(232, 132, 168, .22); color: #fff; }
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

function refresh() {
  if (!panel) return;
  const s = getDiagHoloState();
  const status = panel.querySelector('.hd-status');
  if (status) {
    const b = s.backing ? `${s.backing[0]}×${s.backing[1]}` : '—';
    const c = s.css ? `${s.css[0]}×${s.css[1]}` : '—';
    status.textContent = `全息层：${s.off ? '关' : '开'} · ${s.tier || '无卡'} / ${s.mode || '—'} · display ${s.display || '—'}\nbacking ${b} · 布局 ${c}（旧 bug 时 backing 为 1×1）`;
  }
  const btn = panel.querySelector('.hd-toggle');
  if (btn) {
    btn.textContent = s.off ? '全息层：关（点击开启）' : '全息层：开（点击关闭）';
    btn.classList.toggle('hd-off', s.off);
  }
}

function toggle() {
  const s = getDiagHoloState();
  setDiagHoloOff(!s.off);
  refresh();
}

function openPanel() {
  injectStyle();
  if (!panel) {
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="hd-title">全息层诊断（临时）</div>
      <div class="hd-hint">打开一张史诗/传说卡，倾斜手机看虹彩与高光是否跟手；用开关对比闪烁。面板自身也是合成层，观察时点「收起」，左上角小 H 芯片可重开。</div>
      <div class="hd-status"></div>
      <button type="button" class="hd-toggle"></button>
      <button type="button" data-hd="hide">收起</button>
    `;
    document.body.appendChild(panel);
    panel.querySelector('.hd-toggle').addEventListener('click', toggle);
    panel.querySelector('[data-hd="hide"]').addEventListener('click', hidePanel);
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
    chip.textContent = 'H';
    chip.setAttribute('aria-label', '打开全息层诊断');
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

export function initHoloDiag() {
  const title = document.querySelector('#stickerModal .sticker-modal__title');
  if (!title) return;
  injectStyle();
  bindLongPress(title);
}