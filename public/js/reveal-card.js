/**
 * 开出卡片（抽卡式揭晓）—— 一个组件、三个入口（技术方案 D7，reveal-card-tech-design.md）
 *
 *   ① playSelf    本端开出（添加待办命中隐藏款，全套悬念仪式，撒花级粒子爆发）
 *   ② playNotify  对方端通知（图鉴红点 → 点入弹卡，无悬念无爆发，淡入即 idle，角标「ta 开出的」）
 *   ③ playReview  图鉴复看（点已解锁贴纸格，日期=unlocked_at，无 NEW 无爆发，可翻面看档案）
 *
 * 设计真值：docs/design-todo-v2/reveal-card-lab.html（业主逐张确认）；档位参数与 12 张
 * 专属内容卡在 ./reveal-card-data.js；贴纸名称/短句取 blindbox.js 单一来源。
 *
 * 降级链（§9）：WebGL 不可用 → CSS sheen 兜底流光；特效关 / prefers-reduced-motion →
 * 静态精卡（no-anim，信息全保留）；组件级异常 → spec.fallback（调用方回落 Toast 路径，D8）。
 *
 * 铁律八边界：本组件是纯 DOM/canvas，不触碰任何 Capacitor 插件代理（无 thenable 风险）。
 */

import { isFxEnabled } from './theme.js';
import {
  parseStickerKey, getStickerName, getStickerFlavor, getSeriesDef, BASE_SERIES,
} from './blindbox.js';
import { REVEAL_SETS, REVEAL_TIERS, cardPct } from './reveal-card-data.js';
import { avatarForUsername } from './avatars.js';

// ===== 数据访问 =====

/** 该贴纸是否有专属内容卡（第一册 12 张有；第二册 story_* 尚无 → 调用方回落故事卡/Toast） */
export function canRevealCard(stickerKey) {
  return !!getCardArt(stickerKey);
}

/** stickerKey → 卡面内容（scene/hero/no）；无专属卡的 key 返回 null */
function getCardArt(stickerKey) {
  const parsed = parseStickerKey(stickerKey);
  if (!parsed || parsed.series !== BASE_SERIES) return null;
  const arr = REVEAL_SETS[BASE_SERIES] && REVEAL_SETS[BASE_SERIES][parsed.rarity];
  return (arr && arr[parsed.index - 1]) || null;
}

/** 开出档案日期（D11）：开出瞬间=当天；通知/复看=unlocked_at。格式「2026年10月5日」 */
function fullDateStr(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

// 头像加载失败的兜底（樱粉爱心 data-URI，方案 A 定稿的兜底色；与 avatars.js 的兜底同形）
const AVATAR_FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#e884a8"/>'
  + '<path d="M32 47s-13-7.8-13-16.6c0-4.3 3.4-7.5 7.4-7.5 2.7 0 4.9 1.4 5.6 3.3.7-1.9 2.9-3.3 5.6-3.3 4 0 7.4 3.2 7.4 7.5C45 39.2 32 47 32 47z" fill="#fff"/></svg>'
);

// ===== DOM（惰性构建一次；id 全部 rv 前缀避免与页面冲突） =====

let ui = null;

function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

/** 卡背中央金色爱心纹章（案 C「缎纹卡背」组成部分，lab 原样搬运） */
const EMBLEM_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true">'
  + '<defs><linearGradient id="rv-hg" x1="0" y1="0" x2="1" y2="1">'
  + '<stop offset="0" stop-color="#fde68a"/><stop offset=".55" stop-color="#fbbf24"/><stop offset="1" stop-color="#b98a1f"/>'
  + '</linearGradient></defs>'
  + '<path d="M32 54C16 42 8 32 8 22.5 8 15 13 10 19.5 10c5 0 9.5 2.8 12.5 7 3-4.2 7.5-7 12.5-7C51 10 56 15 56 22.5 56 32 48 42 32 54z" fill="none" stroke="url(#rv-hg)" stroke-width="3"/>'
  + '<path d="M32 47.5C21 38.5 15 31 15 23.5 15 18.5 18.2 15.5 22.3 15.5c3.6 0 7 2 9.7 5.4 2.7-3.4 6.1-5.4 9.7-5.4 4.1 0 7.3 3 7.3 8 0 7.5-6 15-17 24z" fill="url(#rv-hg)" opacity=".85"/>'
  + '</svg>';

function buildDom() {
  const overlay = el('div', 'hidden');
  overlay.id = 'rvOverlay';
  overlay.setAttribute('data-testid', 'reveal-card');

  const beam = el('div', '', overlay); beam.id = 'rvBeam';
  const shakeWrap = el('div', '', overlay); shakeWrap.id = 'rvShakeWrap';
  const tiltWrap = el('div', '', shakeWrap); tiltWrap.id = 'rvTiltWrap';
  const card3d = el('div', '', tiltWrap); card3d.id = 'rvCard3d';

  // —— 卡背（案 C，三档通用；档案元素显隐必须挂 #rvCard3d.flipped——悬念段卡背中性）——
  const back = el('div', 'face back', card3d); back.id = 'rvCardBack';
  el('div', 'bf1', back); el('div', 'bf2', back);
  for (const c of ['tl', 'tr', 'bl', 'br']) el('span', `crn ${c}`, back);
  const emblem = el('div', 'back-emblem', back); emblem.id = 'rvBackEmblem';
  emblem.innerHTML = EMBLEM_SVG;
  const avatarImg = el('img', '', emblem); avatarImg.id = 'rvBackAvatar'; avatarImg.alt = '';
  const spine = el('div', 'back-spine', back); spine.id = 'rvBackSpine';
  const archive = el('div', 'back-archive', back); archive.id = 'rvBackArchive';
  archive.setAttribute('data-testid', 'reveal-card-plaque');
  const baDate = el('div', 'ba-date', archive); baDate.id = 'rvBaDate';
  el('div', 'ba-line', archive);
  const baBy = el('div', 'ba-by', archive); baBy.id = 'rvBaBy';
  const baBook = el('div', 'ba-book', archive); baBook.id = 'rvBaBook';
  el('div', 'back-sheen', back);

  // —— 卡面（档位框 + 专属内容卡）——
  const front = el('div', 'face front', card3d); front.id = 'rvCardFront';
  const body = el('div', 'f-body', front);
  for (const c of ['tl', 'tr', 'bl', 'br']) el('span', `crn ${c}`, body);
  const fScene = el('div', 'f-scene', body); fScene.id = 'rvFScene';
  const fTier = el('div', 'f-tier', body); fTier.id = 'rvFTier';
  const fNew = el('div', 'f-new', body); fNew.textContent = 'NEW';
  const fNotify = el('div', 'f-notify', body);
  fNotify.id = 'rvFNotify';
  fNotify.setAttribute('data-testid', 'reveal-card-notify-badge');
  fNotify.textContent = REVEAL_TIERS.notify.badge;
  const fSticker = el('div', 'f-sticker', body); fSticker.id = 'rvFSticker';
  const info = el('div', 'f-info', body);
  const si1 = el('div', 'si1 f-name', info); si1.id = 'rvFName';
  si1.setAttribute('data-testid', 'reveal-card-name');
  const si2 = el('div', 'si2 f-flavor', info); si2.id = 'rvFFlavor';
  const si3 = el('div', 'si3 f-meta', info);
  const fMeta = el('span', '', si3); fMeta.id = 'rvFMeta';
  fMeta.setAttribute('data-testid', 'reveal-card-meta');
  const bar = el('span', 'bar', si3);
  const barFill = el('i', 'bar-fill', bar); barFill.id = 'rvBarFill';
  const holo = el('canvas', '', front); holo.id = 'rvHolo';

  const fx = el('canvas', '', overlay); fx.id = 'rvFx';
  const flash = el('div', '', overlay); flash.id = 'rvFlash';
  const btnClose = el('button', 'hidden', overlay);
  btnClose.id = 'rvBtnClose';
  btnClose.setAttribute('aria-label', '关闭');
  btnClose.setAttribute('data-testid', 'reveal-card-close');
  btnClose.textContent = '✕';
  const hint = el('div', '', overlay); hint.id = 'rvHint';
  hint.innerHTML = '<span class="h1">点按任意处可跳过</span>'
    + '<span class="h2">点卡片翻面看开出档案 · 晃动看流光</span>'
    + '<span class="h3">特效已关闭 · 点 ✕ 关闭</span>';

  return {
    overlay, beam, shakeWrap, tiltWrap, card3d, back, emblem, avatarImg, spine,
    archive, baDate, baBy, baBook, front, body, fScene, fTier, fNew, fNotify,
    fSticker, si1, si2, si3, fName: si1, fFlavor: si2, fMeta, barFill, holo,
    fx, flash, btnClose, hint,
  };
}

// ===== 特效开关（fx 关 / reduced-motion / E2E 钩子 → 静态精卡） =====

const reducedMQ = (typeof matchMedia === 'function')
  ? matchMedia('(prefers-reduced-motion: reduce)')
  : { matches: false };

function fxActive() {
  return isFxEnabled() && !reducedMQ.matches;
}

// ===== 粒子池（渗出 / 爆发 / 环境星芒，lab 原样搬运） =====

let fxCtx = null;
let fdpr = 1;
let parts = [];

function sizeCanvas(c) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = c.getBoundingClientRect();
  c.width = Math.max(1, r.width * dpr);
  c.height = Math.max(1, r.height * dpr);
  return dpr;
}

function spawnLeak(rect, palette) {
  const edge = Math.random();
  let x, y;
  if (edge < 0.55) { x = rect.left + Math.random() * rect.width; y = rect.bottom - 2; }
  else if (edge < 0.8) { x = rect.left + 2; y = rect.top + rect.height * 0.3 + Math.random() * rect.height * 0.7; }
  else { x = rect.right - 2; y = rect.top + rect.height * 0.3 + Math.random() * rect.height * 0.7; }
  parts.push({
    t: 'leak', x: x * fdpr, y: y * fdpr,
    vx: (Math.random() - 0.5) * 22 * fdpr, vy: -(18 + Math.random() * 40) * fdpr,
    size: (1 + Math.random() * 2.2) * fdpr, ttl: 0.9 + Math.random() * 1.1, age: 0,
    c: palette[(Math.random() * palette.length) | 0], tw: Math.random() * 6.28,
  });
}

function spawnBurst(cx, cy, n, palette) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = (90 + Math.random() * 330) * fdpr;
    parts.push({
      t: 'burst', x: cx * fdpr, y: cy * fdpr,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60 * fdpr,
      size: (1.4 + Math.random() * 2.8) * fdpr, ttl: 0.8 + Math.random() * 0.9, age: 0,
      c: palette[(Math.random() * palette.length) | 0],
    });
  }
}

function spawnTwinkle(rect, palette) {
  const ang = Math.random() * Math.PI * 2;
  const r = rect.width * 0.62 + Math.random() * rect.width * 0.4;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  parts.push({
    t: 'tw', x: (cx + Math.cos(ang) * r) * fdpr, y: (cy + Math.sin(ang) * r * 0.9) * fdpr,
    vx: 0, vy: -6 * fdpr, size: (1 + Math.random() * 1.6) * fdpr, ttl: 0.8 + Math.random() * 0.7, age: 0,
    c: palette[(Math.random() * palette.length) | 0], tw: Math.random() * 6.28,
  });
}

function stepParts(dt) {
  const ctx = fxCtx;
  ctx.clearRect(0, 0, ui.fx.width, ui.fx.height);
  if (!parts.length) return;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.age += dt;
    if (p.age >= p.ttl) { parts.splice(i, 1); continue; }
    const k = 1 - p.age / p.ttl;
    if (p.t === 'burst') { p.vy += 620 * fdpr * dt; p.vx *= (1 - 1.6 * dt); p.vy *= (1 - 0.4 * dt); }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    let a = k;
    if (p.t === 'leak' || p.t === 'tw') a = k * (0.55 + 0.45 * Math.sin(p.tw + p.age * 9));
    ctx.globalAlpha = Math.max(0, a);
    ctx.fillStyle = p.c;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (p.t === 'burst' ? 0.5 + 0.5 * k : 1), 0, 6.2832);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// ===== WebGL holo 层（epic/legendary；同一份 shader 换调色盘，§6） =====

let GL = null;

function initHolo() {
  let gl = null;
  try {
    gl = ui.holo.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: false });
  } catch (_e) { return null; }
  if (!gl) return null;
  function sh(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null; }
    return s;
  }
  const vs = sh(gl.VERTEX_SHADER, 'attribute vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }');
  const fs = sh(gl.FRAGMENT_SHADER,
    'precision mediump float;\n'
    + 'uniform vec2 u_res; uniform float u_time; uniform vec2 u_tilt;\n'
    + 'uniform vec3 u_colA; uniform vec3 u_colB; uniform vec3 u_glint;\n'
    + 'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453123); }\n'
    + 'float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);\n'
    + '  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x), mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x), f.y); }\n'
    + 'void main(){\n'
    + '  vec2 uv = gl_FragCoord.xy / u_res;\n'
    + '  float n = noise(uv*7.0 + u_time*0.03);\n'
    + '  float band = sin((uv.x*1.15 + uv.y)*9.0 + n*4.5 + u_tilt.x*3.2 + u_time*0.55);\n'
    + '  vec3 irid = 0.5 + 0.5*cos(6.28318*(band*0.30 + u_tilt.x*0.22 + u_tilt.y*0.12) + vec3(0.0,0.33,0.67) + u_time*0.18);\n'
    + '  vec3 col = mix(u_colA, u_colB, 0.5+0.5*band);\n'
    + '  col = mix(col, col*(0.65+0.6*irid), 0.42);\n'
    + '  vec2 gp = uv*vec2(64.0,90.0);\n'
    + '  float sp = hash(floor(gp) + floor(u_time*7.0)*0.371);\n'
    + '  col += u_glint * step(0.9915, sp) * 0.9;\n'
    + '  vec2 g = vec2(0.5,0.42) + u_tilt*vec2(0.30,0.24);\n'
    + '  col += u_glint * smoothstep(0.55,0.0,distance(uv,g)) * 0.40;\n'
    + '  float edge = smoothstep(0.0,0.06,uv.x)*smoothstep(1.0,0.94,uv.x)*smoothstep(0.0,0.05,uv.y)*smoothstep(1.0,0.95,uv.y);\n'
    + '  gl_FragColor = vec4(col, 0.52*edge + 0.05);\n'
    + '}\n');
  if (!vs || !fs) return null;
  const pr = gl.createProgram();
  gl.attachShader(pr, vs);
  gl.attachShader(pr, fs);
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(pr)); return null; }
  gl.useProgram(pr);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  return {
    gl, pr,
    uRes: gl.getUniformLocation(pr, 'u_res'),
    uTime: gl.getUniformLocation(pr, 'u_time'),
    uTilt: gl.getUniformLocation(pr, 'u_tilt'),
    uColA: gl.getUniformLocation(pr, 'u_colA'),
    uColB: gl.getUniformLocation(pr, 'u_colB'),
    uGlint: gl.getUniformLocation(pr, 'u_glint'),
  };
}

function sizeHolo() { if (GL) sizeCanvas(ui.holo); }

function renderHolo(tSec, tierKey) {
  const t = REVEAL_TIERS[tierKey];
  if (!GL || !t || !t.webgl) return;
  const gl = GL.gl;
  const h = t.holo;
  gl.viewport(0, 0, ui.holo.width, ui.holo.height);
  gl.uniform2f(GL.uRes, ui.holo.width, ui.holo.height);
  gl.uniform1f(GL.uTime, tSec);
  gl.uniform2f(GL.uTilt, curTilt.x, curTilt.y);
  gl.uniform3f(GL.uColA, h.a[0], h.a[1], h.a[2]);
  gl.uniform3f(GL.uColB, h.b[0], h.b[1], h.b[2]);
  gl.uniform3f(GL.uGlint, h.g[0], h.g[1], h.g[2]);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

/** 特效关/降级时的静态一帧（信息保留、无循环动效） */
function renderHoloStatic(tierKey) {
  if (!GL || !REVEAL_TIERS[tierKey] || !REVEAL_TIERS[tierKey].webgl) return;
  renderHolo(1.2, tierKey);
}

// ===== 跟手倾斜：pointer + 陀螺仪（D5，lab 原样搬运） =====

const tgt = { x: 0, y: 0 };
const curTilt = { x: 0, y: 0 };
let gyroBase = null;
let gyroOn = false;

function clamp1(v) { return Math.max(-1, Math.min(1, v)); }

function onOrient(e) {
  if (e.gamma == null || e.beta == null) return;
  if (!gyroBase) gyroBase = { g: e.gamma, b: e.beta };
  tgt.x = clamp1((e.gamma - gyroBase.g) / 22);
  tgt.y = clamp1(-(e.beta - gyroBase.b) / 22);
}

function enableGyro() {
  if (gyroOn) return;
  gyroOn = true;
  gyroBase = null;
  window.addEventListener('deviceorientation', onOrient);
}

function setupTiltSources() {
  ui.overlay.addEventListener('pointermove', (e) => {
    if (gyroOn) return;
    const r = ui.overlay.getBoundingClientRect();
    tgt.x = clamp1((e.clientX - r.left - r.width / 2) / (r.width / 2));
    tgt.y = clamp1(-(e.clientY - r.top - r.height / 2) / (r.height / 2));
  });
  ui.overlay.addEventListener('pointerleave', () => { if (!gyroOn) { tgt.x = 0; tgt.y = 0; } });
  // iOS 13+ 需手势授权：无授权入口的环境（Android WebView / 桌面）直接挂监听，静默无效
  if (typeof DeviceOrientationEvent !== 'undefined'
    && typeof DeviceOrientationEvent.requestPermission === 'function') {
    // 产品内无工作台按钮可挂授权（原型用 lab 按钮）；保持静默回落 pointer tilt
    return;
  }
  if (typeof DeviceOrientationEvent !== 'undefined') enableGyro();
}

function applyTilt() {
  ui.tiltWrap.style.transform = `rotateX(${-curTilt.y * 10}deg) rotateY(${curTilt.x * 12}deg)`;
  ui.card3d.style.setProperty('--gx', `${50 + curTilt.x * 30}%`);
}

// ===== 播放控制（分镜时间轴 + 队列） =====

// 当前播放的卡片 spec：{ mode:'self'|'notify'|'review', tierKey, item, name, byName, dateStr, metaText, onClose, fallback }
let cur = null;
let phase = 'closed'; // closed | suspense | reveal | idle | closing
let runId = 0;
let skipFlag = false;
let burstDone = false;
let leakOn = false;
let lastTw = 0;
let raf = 0;
let lastT = 0;

// 串播队列：上一张卡还在屏上时又来一次 play（连打两条隐藏款）→ 排队，关一张开一张
const playQueue = [];
let draining = false;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cardRect() {
  const cr = ui.card3d.getBoundingClientRect();
  const or = ui.overlay.getBoundingClientRect();
  return {
    left: cr.left - or.left, top: cr.top - or.top,
    width: cr.width, height: cr.height,
    right: cr.right - or.left, bottom: cr.bottom - or.top,
  };
}

function vibrate(pattern) {
  if (!pattern || !fxActive()) return;
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_e) { /* 无震动设备忽略 */ }
}

/** 填卡面/档案面内容 + 挂档位/模式 class（每次播放前全量重置） */
function fillCard(spec) {
  const { overlay } = ui;
  const t = REVEAL_TIERS[spec.tierKey];
  overlay.className = 'hidden';
  overlay.classList.remove('shaking', 'flashing');
  ui.card3d.classList.remove('fly', 'flipped');
  void overlay.offsetWidth; // 重启动画的回流
  overlay.classList.add(t.cls);
  if (spec.mode === 'notify') overlay.classList.add('mode-quiet', 'mode-notify');
  if (spec.mode === 'review') overlay.classList.add('mode-quiet');

  ui.fTier.textContent = t.label;
  ui.fScene.innerHTML = spec.item.scene;
  ui.fSticker.innerHTML = spec.item.hero;
  ui.fName.textContent = spec.name;
  ui.fFlavor.textContent = spec.flavor;
  ui.fMeta.textContent = spec.metaText;
  ui.card3d.style.setProperty('--prog', `${cardPct(spec.item.no)}%`);
  // 档案铭牌（D11 式样一「日期独立」：日期行无动词，动词只留人称行；书脊题册名、铭牌只记档案）
  ui.baDate.textContent = spec.dateStr;
  ui.baBy.textContent = `${spec.byName} 开出`;
  ui.baBook.textContent = `No.${spec.item.no}/12`;
  ui.spine.textContent = `有爱 · ${spec.bookTitle}`;
  // 档案头像（方案 A）：翻面时纹章位替换为开出人金环圆头像；显隐挂 #rvCard3d.flipped
  ui.emblem.classList.add('avatar-on');
  ui.avatarImg.onerror = function () { this.onerror = null; this.src = AVATAR_FALLBACK; };
  ui.avatarImg.src = avatarForUsername(spec.byName);
  ui.fNotify.textContent = REVEAL_TIERS.notify.badge;
}

function toIdle(instant) {
  phase = 'idle';
  ui.overlay.classList.remove('phase-suspense', 'phase-reveal', 'phase-hold');
  if (instant) ui.overlay.classList.add('no-anim');
  ui.overlay.classList.add('phase-idle');
  ui.btnClose.classList.remove('hidden');
  if (!fxActive() || (cur && !REVEAL_TIERS[cur.tierKey].webgl)) renderHoloStatic(cur && cur.tierKey);
}

async function playCeremony(spec) {
  const { overlay } = ui;
  const t = REVEAL_TIERS[spec.tierKey];
  overlay.classList.add('phase-suspense');
  phase = 'suspense';
  const id = runId;

  if (t.suspense) {
    leakOn = true;
    await sleep(t.suspenseMs || 1650);
    if (id !== runId || skipFlag) return;
    overlay.classList.add('phase-hold'); // 顿帧
    await sleep(t.holdMs);
    if (id !== runId || skipFlag) return;
    overlay.classList.remove('phase-hold');
  } else {
    await sleep(480);
    if (id !== runId || skipFlag) return; // rare：卡背飞入后即刻揭晓
  }

  // 揭晓：白闪 + 翻面 + 粒子爆发 + 屏震 + 分档震动（原 celebrateRarity 的时刻由控制器在此触发）
  phase = 'reveal';
  overlay.classList.remove('phase-suspense');
  overlay.classList.add('phase-reveal');
  leakOn = false;
  if (t.flash) overlay.classList.add('flashing');
  if (t.shake) overlay.classList.add('shaking');
  const r = cardRect();
  spawnBurst(r.left + r.width / 2, r.top + r.height / 2, t.burstN, t.palette);
  burstDone = true;
  vibrate(t.vibrate);
  await sleep(240);
  if (id !== runId || skipFlag) return;
  overlay.classList.remove('flashing', 'shaking');
  await sleep(t.suspense ? (t.revealHold || 420) : 260);
  if (id !== runId || skipFlag) return;
  toIdle(false);
}

/** 滚动锁释放：body.overflow 是单一状态，图鉴弹层（sticker-book）也在用它——
 *  复看卡叠在书架上时，卡关了锁不能放（否则背景可滚）。按「还有没有别的弹层开着」判定 */
function releaseScrollLock() {
  const book = document.getElementById('stickerModal');
  const bookOpen = !!(book && !book.classList.contains('hidden'));
  const memorial = document.getElementById('memorialCard');
  const memorialOpen = !!(memorial && !memorial.classList.contains('hidden'));
  if (!bookOpen && !memorialOpen) document.body.style.overflow = '';
}

function finishPlay() {
  phase = 'closing';
  ui.btnClose.classList.add('hidden');
  const done = () => {
    ui.overlay.className = 'hidden';
    releaseScrollLock();
    phase = 'closed';
    const resolve = cur && cur.resolve;
    cur = null;
    stopLoop();
    if (resolve) resolve({ played: true });
    draining = false;
    drainQueue(); // 下一张（若有）
  };
  if (fxActive()) {
    ui.card3d.classList.add('fly');
    setTimeout(done, 500);
  } else {
    done();
  }
}

function toggleFlip() {
  if (phase !== 'idle') return;
  ui.card3d.classList.toggle('flipped');
}

function setupInteraction() {
  ui.overlay.addEventListener('pointerdown', (e) => {
    if (e.target === ui.btnClose || ui.btnClose.contains(e.target)) return;
    if ((phase === 'suspense' || phase === 'reveal') && fxActive() && !skipFlag) {
      // 任意时刻点按 = 快进到展示段（尊重高频用户）
      skipFlag = true;
      leakOn = false;
      if (!burstDone && cur) {
        const t = REVEAL_TIERS[cur.tierKey];
        const r = cardRect();
        spawnBurst(r.left + r.width / 2, r.top + r.height / 2, Math.round(t.burstN * 0.5), t.palette);
        burstDone = true;
        vibrate([15, 15, 40]);
      }
      toIdle(true);
      return;
    }
    if (phase === 'idle') toggleFlip(); // 点卡片：正面 ↔ 档案面
  });
  ui.btnClose.addEventListener('click', (e) => {
    e.stopPropagation();
    if (phase === 'idle') finishPlay();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (phase === 'idle') finishPlay();
  });
}

// ===== 主循环（仅 overlay 打开时工作；关闭即停 rAF） =====

function loop(t) {
  raf = requestAnimationFrame(loop);
  const dt = Math.min((t - lastT) / 1000, 0.05);
  lastT = t;
  curTilt.x += (tgt.x - curTilt.x) * Math.min(1, dt * 9);
  curTilt.y += (tgt.y - curTilt.y) * Math.min(1, dt * 9);
  applyTilt();
  if (!cur || phase === 'closed' || document.hidden) return;
  const now = t / 1000;
  if (fxActive() && cur) {
    const tier = REVEAL_TIERS[cur.tierKey];
    if (leakOn) {
      const r = cardRect();
      const rate = 90 + Math.min(140, (now * 60) % 1000); // 渐强
      if (Math.random() < rate * dt * 1.8) spawnLeak(r, tier.palette);
    }
    if (phase === 'idle') {
      const r2 = cardRect();
      if (now - lastTw > (tier.twinkleEvery || 0.6)) { lastTw = now; spawnTwinkle(r2, tier.palette); }
    }
    stepParts(dt);
    if (phase === 'idle') renderHolo(now, cur.tierKey);
  } else {
    stepParts(0); // 清屏一次
  }
}

function startLoop() {
  if (raf) return;
  lastT = 0;
  raf = requestAnimationFrame(loop);
}

function stopLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

// ===== 队列与公开入口 =====

function drainQueue() {
  if (draining) return;
  const next = playQueue.shift();
  if (!next) return;
  draining = true;
  let failed = null;
  try {
    runPlay(next);
  } catch (e) {
    failed = e; // runPlay 是同步函数：构建 DOM/填内容阶段的异常在这里接住（.catch 接不到）
  }
  if (failed) { failPlay(next, failed); return; } // failPlay 内部会继续 drain
}

/** 播放失败：强制复位遮罩 + resolve + 调用方兜底（D8 极端降级）+ 继续队列 */
function failPlay({ spec, resolve }, err) {
  console.warn('[reveal-card] 播放失败:', err && err.message);
  try {
    ui.overlay.className = 'hidden';
    releaseScrollLock();
    phase = 'closed';
    cur = null;
    stopLoop();
  } catch (_e) { /* DOM 已不可用则忽略 */ }
  if (resolve) resolve({ played: false });
  if (spec.fallback) { try { spec.fallback(); } catch (_e2) { /* 兜底再失败不阻塞 */ } }
  draining = false;
  drainQueue();
}

/**
 * 播放一张卡（内部）。resolve 于卡片关闭时；组件级异常走 spec.fallback（D8 极端降级）。
 * 组件是纯展示层：解锁状态、rarity_seen 回标、红点清理都由调用方在 await 之后处理。
 */
function runPlay({ spec, resolve }) {
  ensureReady();
  cur = spec;
  runId++;
  skipFlag = false;
  burstDone = false;
  leakOn = false;
  parts.length = 0;
  phase = 'closed';
  spec.resolve = resolve;
  fillCard(spec);
  fdpr = sizeCanvas(ui.fx);
  sizeHolo();
  document.body.style.overflow = 'hidden';
  ui.overlay.classList.remove('hidden');
  startLoop(); // rAF 主循环（tilt 缓动/粒子/holo）只在 overlay 打开期间工作
  if (!fxActive()) {
    toIdle(true); // 降级：静态精卡直达（信息全保留，D9）
  } else if (spec.mode === 'self') {
    // fire-and-forget：异常必须接住走 failPlay，否则遮罩会卡死在屏上
    playCeremony(spec).catch((e) => failPlay({ spec, resolve: spec.resolve }, e));
  } else {
    // 通知/复看（D7-②③）：无悬念段、无爆发，卡片淡入即 idle；idle 流光/星芒/翻面照常
    phase = 'idle';
    ui.overlay.classList.add('phase-idle');
    ui.btnClose.classList.remove('hidden');
    if (REVEAL_TIERS[spec.tierKey].webgl) renderHoloStatic(spec.tierKey);
  }
  if (spec.onClose) {
    const prevResolve = spec.resolve;
    spec.resolve = (v) => { try { spec.onClose(); } catch (e) { console.warn('[reveal-card] onClose 失败:', e && e.message); } prevResolve(v); };
  }
  return Promise.resolve();
}

let ready = false;
function ensureReady() {
  if (ready) return;
  ui = buildDom();
  document.body.appendChild(ui.overlay);
  fxCtx = ui.fx.getContext('2d');
  GL = initHolo();
  if (!GL) ui.holo.style.display = 'none'; // CSS sheen 兜底流光（§9 第一级降级）
  setupTiltSources();
  setupInteraction();
  window.addEventListener('resize', () => { if (cur) { sizeCanvas(ui.fx); sizeHolo(); } });
  ready = true;
}

function enqueue(spec) {
  return new Promise((resolve) => {
    playQueue.push({ spec, resolve });
    drainQueue();
  });
}

/** 由 stickerKey 组装 spec（三入口共用的内容装配） */
function buildSpec(stickerKey, mode, { byName, unlockedAt, fallback, onClose }) {
  const parsed = parseStickerKey(stickerKey);
  const item = getCardArt(stickerKey);
  if (!parsed || !item) return null;
  const def = getSeriesDef(parsed.series) || {};
  const tierKey = REVEAL_TIERS[parsed.rarity] ? parsed.rarity : 'rare';
  const name = getStickerName(stickerKey) || `${parsed.rarity}${parsed.index}`;
  return {
    mode,
    tierKey,
    item,
    name,
    flavor: getStickerFlavor(stickerKey),
    metaText: `${def.title || ''} · 图鉴 ${item.no}/12`,
    bookTitle: def.title || '',
    byName: byName || '对方',
    dateStr: fullDateStr(unlockedAt),
    fallback,
    onClose,
  };
}

/**
 * 入口①：本端开出（添加待办命中隐藏款，解锁完成后调用——卡面要显示贴纸本体）。
 * 完整悬念仪式；NEW 角标仅此处显示。
 * @param {Object} todo 刚开出的隐藏款待办
 * @param {Object} sticker onRollRarity 返回的贴纸（含 stickerKey）
 * @param {Object} opts
 * @param {string} [opts.byName] 开出人称呼（铭牌人称行）
 * @param {Function} [opts.fallback] 组件级异常的极端降级（回落 Toast/庆祝，D8）
 * @returns {Promise<{played:boolean}>} 卡片关闭时 resolve
 */
export function playSelf(todo, sticker, opts = {}) {
  const spec = sticker && buildSpec(sticker.stickerKey, 'self', {
    byName: opts.byName,
    unlockedAt: null, // 开出瞬间=当天（D11）
    fallback: opts.fallback,
  });
  if (!spec) return Promise.resolve({ played: false });
  return enqueue(spec);
}

/**
 * 入口②：对方端通知（图鉴红点 → 点入弹卡）。无悬念无爆发，淡入即 idle，
 * 正面「ta 开出的」角标，翻面档案铭牌人称行 = 开出方称呼。
 * @param {Object} todo 触发通知的待办（取 createdAt 兜底日期）
 * @param {Object} sticker 该待办解锁的贴纸
 * @param {Object} opts 同 playSelf
 */
export function playNotify(todo, sticker, opts = {}) {
  const spec = sticker && buildSpec(sticker.stickerKey, 'notify', {
    byName: opts.byName,
    unlockedAt: (sticker && sticker.unlockedAt) || (todo && todo.createdAt) || null,
    fallback: opts.fallback,
  });
  if (!spec) return Promise.resolve({ played: false });
  return enqueue(spec);
}

/**
 * 入口③：图鉴复看（点已解锁贴纸格）。日期=unlocked_at，无 NEW 角标、无爆发、可翻面看档案。
 * @param {Object} sticker 本地图鉴状态里的贴纸行
 * @param {Object} opts 同 playSelf
 */
export function playReview(sticker, opts = {}) {
  const spec = sticker && buildSpec(sticker.stickerKey, 'review', {
    byName: opts.byName,
    unlockedAt: sticker.unlockedAt || null,
    fallback: opts.fallback,
  });
  if (!spec) return Promise.resolve({ played: false });
  return enqueue(spec);
}

/** 组件是否正在屏上（E2E / 弹层层叠判断用） */
export function isRevealCardOpen() {
  return phase !== 'closed';
}
