/**
 * 临时闪烁诊断（2026-11-25，定位完即删除）
 *
 * 背景：复看卡在真机上的 GPU 合成伪影，桌面/模拟器都复现不了，只有真机能当传感器。
 * 这里把可疑的合成路径做成开关，让业主在同一台手机、同一个会话里逐项 A/B：
 *   ① 全屏 canvas（纪念卡彩带的残留层）
 *   ② #rvBeam 全屏光柱
 *   ③ 图鉴弹层毛玻璃 backdrop-filter
 *   ④ 陀螺仪/倾斜的逐帧 transform 重栅格
 *   ⑤ 背后的图鉴完成态书架（集齐后才变重的持久层）
 *   ⑥ 隐藏的纪念卡层
 *
 * 入口：图鉴标题（「收集图鉴」）长按 1.5 秒。正常使用不会看到面板。
 * 移除：删掉本文件 + sticker-book.js 的两行接线 + reveal-card.js 的 setDiagTiltOff。
 */

import confetti from './vendor/canvas-confetti.esm.min.js';
import { setDiagTiltOff } from './reveal-card.js';

const STYLE_ID = 'flickerDiagStyle';
const PANEL_ID = 'flickerDiag';
const CANVAS_ID = 'flickerDiagCanvas';

let panel = null;
let canvas = null;
let canvasOn = false;
let beamOn = true;
let blurOn = true;
let tiltOn = true;
let shelfOn = true;
let memorialOn = true;
let shelfTimer = 0;
let countTimer = 0;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${PANEL_ID} {
      position: fixed; top: 8px; left: 8px; z-index: 30000;
      width: 268px; max-width: calc(100vw - 16px);
      padding: 10px 12px; border-radius: 12px;
      background: rgba(24, 12, 28, .93); color: #fdf2f8;
      font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .45);
      -webkit-user-select: none; user-select: none;
    }
    #${PANEL_ID} .fd-title { font-weight: 700; font-size: 13px; letter-spacing: .06em; color: #fde68a; }
    #${PANEL_ID} .fd-hint { margin: 4px 0 8px; color: rgba(253, 242, 248, .7); font-size: 11px; }
    #${PANEL_ID} .fd-row { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
    #${PANEL_ID} .fd-label { flex: 1; }
    #${PANEL_ID} button {
      border: 1px solid rgba(253, 230, 138, .45); border-radius: 7px;
      background: rgba(253, 230, 138, .12); color: #fde68a;
      font: inherit; padding: 3px 8px; cursor: pointer;
    }
    #${PANEL_ID} button.fd-on { background: rgba(232, 132, 168, .34); border-color: rgba(232, 132, 168, .8); color: #fff; }
    #${PANEL_ID} .fd-count { margin-top: 8px; color: rgba(253, 242, 248, .75); font-size: 11px; }
    #${PANEL_ID} .fd-actions { display: flex; gap: 6px; margin-top: 8px; }
    #${PANEL_ID} .fd-actions button { flex: 1; }
    body.diag-no-beam #rvBeam { display: none !important; }
    body.diag-no-blur .sticker-modal,
    body.diag-no-blur .memorial-card__scrim {
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }
    .sticker-modal__title { -webkit-user-select: none; user-select: none; }
  `;
  document.head.appendChild(style);
}

function label(btn, text) {
  btn.textContent = text;
}

function refresh() {
  if (!panel) return;
  const beamBtn = panel.querySelector('[data-fd="beam"]');
  const blurBtn = panel.querySelector('[data-fd="blur"]');
  const tiltBtn = panel.querySelector('[data-fd="tilt"]');
  const canvasBtn = panel.querySelector('[data-fd="canvas"]');
  const shelfBtn = panel.querySelector('[data-fd="shelf"]');
  const memorialBtn = panel.querySelector('[data-fd="memorial"]');
  label(canvasBtn, canvasOn ? '空白：开' : '空白：关');
  canvasBtn.classList.toggle('fd-on', canvasOn);
  label(beamBtn, beamOn ? '开' : '关');
  beamBtn.classList.toggle('fd-on', !beamOn);
  label(blurBtn, blurOn ? '开' : '关');
  blurBtn.classList.toggle('fd-on', !blurOn);
  label(tiltBtn, tiltOn ? '开' : '关');
  tiltBtn.classList.toggle('fd-on', !tiltOn);
  label(shelfBtn, shelfOn ? '显示' : '隐藏');
  shelfBtn.classList.toggle('fd-on', !shelfOn);
  label(memorialBtn, memorialOn ? '显示' : '隐藏');
  memorialBtn.classList.toggle('fd-on', !memorialOn);
  const count = panel.querySelector('.fd-count');
  if (count) {
    const canvases = [...document.querySelectorAll('body > canvas')];
    const ov = document.getElementById('rvOverlay');
    const c = canvas || canvases[canvases.length - 1];
    let pos = '无';
    if (c && ov) {
      const order = [...document.body.children];
      pos = order.indexOf(c) > order.indexOf(ov) ? '卡上' : '卡下';
    }
    count.textContent = `body > canvas：${canvases.length} 个 · 画布位置：${pos}`;
  }
}

function createBlankCanvas() {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.id = CANVAS_ID;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1200;';
  document.body.appendChild(canvas);
}

function removeBlankCanvas() {
  if (!canvas) return;
  canvas.remove();
  canvas = null;
}

function setCanvas(on) {
  canvasOn = !!on;
  if (canvasOn) createBlankCanvas();
  else removeBlankCanvas();
  refresh();
}

function setBeam(on) {
  beamOn = !!on;
  document.body.classList.toggle('diag-no-beam', !beamOn);
  refresh();
}

function setBlur(on) {
  blurOn = !!on;
  document.body.classList.toggle('diag-no-blur', !blurOn);
  refresh();
}

function setTilt(on) {
  tiltOn = !!on;
  setDiagTiltOff(!tiltOn);
  refresh();
}

/** 背后的图鉴弹层（完成态书架）。隐藏后标题不可点，60 秒自动恢复，避免把自己锁死 */
function setShelf(on) {
  shelfOn = !!on;
  const modal = document.getElementById('stickerModal');
  if (modal) modal.style.display = shelfOn ? '' : 'none';
  if (shelfTimer) { clearTimeout(shelfTimer); shelfTimer = 0; }
  if (!shelfOn) {
    shelfTimer = setTimeout(() => { shelfTimer = 0; setShelf(true); }, 60000);
  }
  refresh();
}

/** 隐藏/恢复纪念卡层（含 scrim 与 12 格内容） */
function setMemorial(on) {
  memorialOn = !!on;
  const m = document.getElementById('memorialCard');
  if (m) m.style.display = memorialOn ? '' : 'none';
  refresh();
}

/** 清掉 canvas-confetti 的全局画布（真实彩带），保留诊断用的空白画布 */
function clearRealConfetti() {
  try { confetti.reset(); } catch (_e) { /* ignore */ }
  for (const c of [...document.querySelectorAll('body > canvas')]) {
    if (c.id !== CANVAS_ID) c.remove();
  }
  refresh();
}

function fireRealConfetti() {
  const base = { spread: 60, ticks: 900, gravity: 0.9, scalar: 0.9, colors: ['#fbbf24', '#fcd34d', '#f59e0b'], zIndex: 1200 };
  confetti({ ...base, particleCount: 40, origin: { x: 0.15, y: 0.7 }, angle: 60 });
  confetti({ ...base, particleCount: 40, origin: { x: 0.85, y: 0.7 }, angle: 120 });
  confetti({ ...base, particleCount: 50, spread: 100, origin: { x: 0.5, y: 0.35 }, scalar: 1.1 });
  refresh();
}

function buildPanel() {
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="fd-title">闪烁诊断（临时）</div>
    <div class="fd-hint">先开史诗/传说复看卡；切完点「收起」，每项观察 20–30 秒。隐藏图鉴层 60 秒后自动恢复。</div>
    <div class="fd-row">
      <span class="fd-label">彩带画布</span>
      <button type="button" data-fd="canvas">空白：关</button>
      <button type="button" data-fd="real">真实</button>
      <button type="button" data-fd="clear">清除</button>
    </div>
    <div class="fd-row"><span class="fd-label">图鉴层（背后书架）</span><button type="button" data-fd="shelf">显示</button></div>
    <div class="fd-row"><span class="fd-label">纪念卡层</span><button type="button" data-fd="memorial">显示</button></div>
    <div class="fd-row"><span class="fd-label">光柱 #rvBeam</span><button type="button" data-fd="beam">开</button></div>
    <div class="fd-row"><span class="fd-label">图鉴毛玻璃</span><button type="button" data-fd="blur">开</button></div>
    <div class="fd-row"><span class="fd-label">陀螺仪/倾斜</span><button type="button" data-fd="tilt">开</button></div>
    <div class="fd-count">body &gt; canvas：0 个</div>
    <div class="fd-actions">
      <button type="button" data-fd="reset">全部恢复</button>
      <button type="button" data-fd="hide">收起</button>
    </div>
  `;
  document.body.appendChild(panel);
  panel.querySelector('[data-fd="canvas"]').addEventListener('click', () => setCanvas(!canvasOn));
  panel.querySelector('[data-fd="real"]').addEventListener('click', fireRealConfetti);
  panel.querySelector('[data-fd="clear"]').addEventListener('click', clearRealConfetti);
  panel.querySelector('[data-fd="shelf"]').addEventListener('click', () => setShelf(!shelfOn));
  panel.querySelector('[data-fd="memorial"]').addEventListener('click', () => setMemorial(!memorialOn));
  panel.querySelector('[data-fd="beam"]').addEventListener('click', () => setBeam(!beamOn));
  panel.querySelector('[data-fd="blur"]').addEventListener('click', () => setBlur(!blurOn));
  panel.querySelector('[data-fd="tilt"]').addEventListener('click', () => setTilt(!tiltOn));
  panel.querySelector('[data-fd="reset"]').addEventListener('click', () => {
    setCanvas(false); setBeam(true); setBlur(true); setTilt(true);
    setShelf(true); setMemorial(true); clearRealConfetti();
  });
  panel.querySelector('[data-fd="hide"]').addEventListener('click', hidePanel);
  refresh();
  return panel;
}

function openPanel() {
  injectStyle();
  buildPanel();
  panel.style.display = 'block';
  refresh();
  if (!countTimer) countTimer = setInterval(refresh, 500);
}

function hidePanel() {
  if (panel) panel.style.display = 'none';
  if (countTimer) { clearInterval(countTimer); countTimer = 0; }
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
  // 不用 pointerleave 取消：图鉴弹层异步渲染会让标题位置跳动，leave 会误杀长按。
  // 只按真实位移判定（>16px 视为滑动）。
  el.addEventListener('pointermove', (e) => {
    if (!timer) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 16) cancel();
  });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

export function initFlickerDiagnostic() {
  const title = document.querySelector('#stickerModal .sticker-modal__title');
  if (!title) return;
  injectStyle(); // 长按前就禁用文字选择，避免 pointercancel 把计时器清掉
  bindLongPress(title);
}