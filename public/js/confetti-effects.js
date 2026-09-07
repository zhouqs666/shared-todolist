/**
 * 完成庆祝 / 撒花 / 卡片光环 / 远端反应脉冲
 *
 * 从 app.js 拆出（技术清单第8条：app.js 过长）。本模块负责：
 *   - celebrateCompletion：完成时的撒花 + 文案 + 音效 + 震动（普通款 / 隐藏款分支）
 *   - burstCardRing：隐藏款完成瞬间的卡片光环扩散
 *   - onStickerUnlockedView：图鉴解锁的克制单束撒花
 *   - pulseTodoOnRemoteReaction：对方贴表情时给对应待办一个脉冲反馈
 *
 * 直接 import 依赖（与 app.js 共享 ES module 单例，无耦合放大）：
 *   - blindbox.js: isHidden, RARITY_META, celebrateRarity
 *   - toast.js: showToast
 *   - theme.js: isFxEnabled
 *   - vendor/canvas-confetti
 *   - utils.js: playDing
 *
 * 行为零变化承诺：与原 app.js 内联实现完全等价（仅迁移），唯一改动是
 * pulseTodoOnRemoteReaction 把闭包变量 todoListEl 改为 document.querySelector('#todoList')，
 * 查询结果相同但解除了对 app.js 闭包的依赖。
 */

import { isHidden, RARITY_META, celebrateRarity, STICKERS_PER_RARITY } from './blindbox.js';
import { showToast } from './toast.js';
import { isFxEnabled } from './theme.js';
import { getStickers } from './state.js';
import confetti from './vendor/canvas-confetti.esm.min.js';
import { playDing } from './utils.js';

// ===== 视觉常量 =====

// 爱心 SVG path（标准心形，用于 confetti shapeFromPath，颜色由 colors 平涂，可控）
const HEART_PATH = 'M167 72c-30 0-55 24-55 55 0-31-25-55-55-55C16 72-31 119-31 188c0 90 143 168 143 168s143-78 143-168c0-69-47-116-88-116z';

// 缓存爱心形状（shapeFromPath 需要计算，只算一次）
let heartShape = null;
function getHeartShape() {
  if (heartShape) return heartShape;
  try {
    // canvas-confetti shapeFromPath：传入 SVG path，返回爱心形状对象。
    // 不依赖 emoji 渲染（避免安卓 WebView 把 ❤ 渲染成黑色），颜色由 colors 控制。
    heartShape = confetti.shapeFromPath ? confetti.shapeFromPath({ path: HEART_PATH }) : null;
  } catch (e) {
    console.warn('[fx] shapeFromPath 失败，回退默认形状:', e.message);
    heartShape = null;
  }
  return heartShape;
}

// 情感色常量（与 CSS --rose-* 同源，confetti 用）：mint 主色 + rose 情感色和谐共舞
const ROSE = ['#f43f5e', '#fb7185', '#fda4af'];

// 普通完成：鼓励文案随机池（无进度型，保持温度感）
const COMPLETE_PHRASES = [
  '太棒了！',
  '又搞定一个！',
  '干净利落！',
  '一步一步来，真稳。',
  '这就去掉了心头一件事。',
];

// 隐藏款完成：按稀有度的专属文案（替代普通鼓励池）
const RARITY_COMPLETE_TEXT = {
  rare: '✨ 稀有款，完成。',
  epic: '🌟 史诗款达成了，不简单。',
  legendary: '👑 传说款完成，这一刻值得记住。',
};

// 完成提示用的勾图标（白色，配 success 变体）
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';

// ===== 完成庆祝主入口 =====

/**
 * 完成时刻的庆祝：撒花 + 文案 toast + 音效 + 震动。
 * 普通款 / 隐藏款分支：隐藏款用专属文案 + rarity 粒子 + 卡片光环。
 * @param {Object|string} todo 待办对象（或早期字符串入参，向后兼容）
 * @param {boolean} [isRemote=false] 是否远端完成（对方完成）；远端不发光环
 */
export function celebrateCompletion(todo, isRemote = false) {
  // 兼容旧的字符串入参（handleRemoteCompleted 早期传字符串）
  const obj = typeof todo === 'string' ? { text: todo } : (todo || {});
  const text = obj.text || '完成';
  const rarity = obj.rarity;

  if (isHidden(rarity)) {
    // ===== 隐藏款完成：专属文案 + 配色 toast + rarity 粒子 + 卡片光环 =====
    const meta = RARITY_META[rarity];
    const basePhrase = RARITY_COMPLETE_TEXT[rarity] || meta.toast;
    // 完成稀有款是「完成庆祝」，贴纸已在添加时解锁；本端附上图鉴进度，把「完成」与「解锁」区分开
    const phrase = isRemote
      ? `${basePhrase}（${text}）`
      : `${basePhrase} 图鉴 ${getStickers().length}/${STICKERS_PER_RARITY * 3}`;
    // 贴纸图标作为 toast 图标（取该稀有度第一张贴纸）
    const icon = meta.stickerIcons ? meta.stickerIcons[0] : '';
    showToast(phrase, { variant: 'rarity', accent: meta.colors[0], icon, duration: 3000 });
    // 叠加 rarity 专属粒子（复用开奖配色：rare 克制不撒花 / epic 玫红 / legendary 金）
    celebrateRarity(rarity, text);
    // 卡片光环（仅本端完成时，卡片在视野内才发）
    if (!isRemote && obj.id) burstCardRing(obj.id, rarity);
    return;
  }

  // ===== 普通完成：随机鼓励文案 + 品牌色 toast =====
  const phrase = COMPLETE_PHRASES[Math.floor(Math.random() * COMPLETE_PHRASES.length)];
  showToast(phrase, { variant: 'success', icon: CHECK_ICON });

  if (!isFxEnabled()) return;
  // 尊重 prefers-reduced-motion：前庭敏感用户跳过粒子/音效/震动，只留 Toast
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // 配色：mint 主色 + rose 情感色，两套色在完成时刻和谐共舞
  const rootStyle = getComputedStyle(document.documentElement);
  const primary = rootStyle.getPropertyValue('--color-primary').trim() || '#f43f5e';
  const colors = [primary, ...ROSE, '#fbbf24'];

  const shape = getHeartShape();
  const baseOpts = {
    spread: 75,
    startVelocity: 42,
    ticks: 220,
    gravity: 1,
    decay: 0.92,
    scalar: 1.3,          // 爱心稍大一点更醒目
    flat: false,
    colors,
    shapes: shape ? [shape] : undefined,
  };

  // 中间一束（主）
  confetti({ ...baseOpts, particleCount: 45, origin: { y: 0.6 } });
  // 左右各补一束，更有层次
  setTimeout(() => confetti({ ...baseOpts, particleCount: 20, angle: 60, spread: 55, origin: { x: 0, y: 0.65 } }), 150);
  setTimeout(() => confetti({ ...baseOpts, particleCount: 20, angle: 120, spread: 55, origin: { x: 1, y: 0.65 } }), 150);

  // 音效
  playDing();

  // 手机震动
  if (navigator.vibrate) {
    try {
      navigator.vibrate([30, 20, 30]);
    } catch (_) {}
  }
}

/**
 * 隐藏款完成瞬间：卡片光环扩散（完成专属动作，开奖没有）。
 * 定位到完成的卡片，叠加 rarity 配色光环：rare 单圈 / epic 双圈错时 / legendary 三圈+卡片金光爆发。
 * 卡片不在 DOM（远端完成/已滚动离开）则静默跳过。
 */
export function burstCardRing(todoId, rarity) {
  if (!todoId || !isHidden(rarity)) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const li = document.querySelector(`.todo[data-id="${CSS.escape(todoId)}"]`);
  if (!li) return; // 卡片不在视野，静默跳过

  const color = (RARITY_META[rarity].colors || ['#fda4af'])[0];
  const ringCount = rarity === 'legendary' ? 3 : (rarity === 'epic' ? 2 : 1);

  for (let i = 0; i < ringCount; i++) {
    setTimeout(() => {
      const ring = document.createElement('span');
      ring.className = 'todo__burst-ring';
      ring.style.setProperty('--burst-color', color);
      li.appendChild(ring);
      // 下一帧启动动画（让浏览器先把元素画上）
      requestAnimationFrame(() => ring.classList.add('todo__burst-ring--go'));
      // 动画结束后清理
      setTimeout(() => { if (ring.parentNode) ring.remove(); }, 800);
    }, i * 150); // 错时扩散，层次感
  }

  // 传说款额外：卡片整体金光爆发
  if (rarity === 'legendary') {
    li.classList.add('todo--burst-legendary');
    setTimeout(() => li.classList.remove('todo--burst-legendary'), 750);
  }
}

/**
 * 图鉴解锁的视图层撒花反馈（由 sticker-book 模块在解锁时回调）。
 */
export function onStickerUnlockedView(sticker) {
  if (!sticker) return;
  if (!isFxEnabled()) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = RARITY_META[sticker.rarity] ? RARITY_META[sticker.rarity].confettiColors : null;
  if (!colors) return;
  // 克制的单束撒花（图鉴解锁的仪式感，但不喧宾夺主）
  confetti({ particleCount: 25, spread: 60, startVelocity: 35, ticks: 180, colors, origin: { y: 0.5 }, scalar: 1.1 });
}

/**
 * 对方贴表情时，给对应待办一个轻量脉冲反馈（克制，不弹通知）
 */
export function pulseTodoOnRemoteReaction(todoId) {
  // 原 app.js 用闭包变量 todoListEl,这里改为 document.querySelector 解除耦合
  // （查询结果等价：app.js 的 todoListEl = document.getElementById('todoList')）
  const list = document.getElementById('todoList');
  if (!list) return;
  const li = list.querySelector(`.todo[data-id="${todoId}"]`);
  if (!li) return;
  const wrap = li.querySelector('.todo__reactions');
  if (!wrap) return;
  wrap.classList.remove('todo__reactions--pulse');
  // 强制 reflow 以重启动画
  void wrap.offsetWidth;
  wrap.classList.add('todo__reactions--pulse');
  setTimeout(() => wrap.classList.remove('todo__reactions--pulse'), 700);
}
