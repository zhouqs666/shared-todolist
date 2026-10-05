/**
 * 完成庆祝 / 撒花 / 远端反应脉冲
 *
 * 从 app.js 拆出（技术清单第8条：app.js 过长）。本模块负责：
 *   - celebrateCompletion：完成时的撒花 + 文案 + 音效 + 震动
 *   - onStickerUnlockedView：图鉴解锁的克制单束撒花
 *   - pulseTodoOnRemoteReaction：对方贴表情时给对应待办一个脉冲反馈
 *
 * 【2026-10-05 批次 3（D1）】「完成时的隐藏款专属表现」已整体删除 —— 惊喜预算集中到
 * 开出时刻（reveal-card.js）：RARITY_COMPLETE_TEXT 专属文案、celebrateRarity 叠加粒子、
 * burstCardRing 卡片光环全部移除，完成隐藏款与普通款走同一条庆祝路径（完成时刻
 * 所有待办一律平等；卡片稀有度身份靠常驻工艺边延续）。
 *
 * 直接 import 依赖（与 app.js 共享 ES module 单例，无耦合放大）：
 *   - blindbox.js: RARITY_META
 *   - toast.js: showToast
 *   - theme.js: isFxEnabled
 *   - vendor/canvas-confetti
 *   - utils.js: playDing
 */

import { RARITY_META } from './blindbox.js';
import { showToast } from './toast.js';
import { isFxEnabled } from './theme.js';
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

// 情感色常量（与 CSS --rose-* 同源，confetti 用）
// v2.7.61 樱白粉：rose-500/400/300/200（#e884a8 / #ee9cba / #f3b9cd / #f9d6e2）
// 低饱和日系浪漫粉，与冷粉白底协调，不再用暖橙系
const ROSE = ['#e884a8', '#ee9cba', '#f3b9cd', '#f9d6e2'];

// 普通完成：鼓励文案随机池（无进度型，保持温度感）
const COMPLETE_PHRASES = [
  '太棒了！',
  '又搞定一个！',
  '干净利落！',
  '一步一步来，真稳。',
  '这就去掉了心头一件事。',
];

// 完成提示用的勾图标（白色，配 success 变体）
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';

// ===== 完成庆祝主入口 =====

/**
 * 完成时刻的庆祝：撒花 + 文案 toast + 音效 + 震动。
 * 【D1，2026-10-05】不分稀有度：完成时刻所有待办一律平等，隐藏款的惊喜在开出时刻
 * （reveal-card.js）。撤销按钮照常附带（撤销 Toast 不受影响）。
 * @param {Object|string} todo 待办对象（或早期字符串入参，向后兼容；rarity 字段不再读）
 * @param {boolean} [isRemote=false] 是否远端完成（对方完成）
 * @param {Function} [undoAction] 撤销完成回调（本端完成时传入，远端不传）
 */
export function celebrateCompletion(todo, isRemote = false, undoAction = null) {
  // todo / isRemote 仅保留签名兼容（handleRemoteCompleted 仍传 todo 对象）——
  // D1 后不再读 rarity，远端与本端完成走同一条庆祝路径（差异只有 undo 按钮的有无）

  // ===== 普通完成：随机鼓励文案 + 品牌色 toast =====
  const phrase = COMPLETE_PHRASES[Math.floor(Math.random() * COMPLETE_PHRASES.length)];
  const toastOpts = { variant: 'success', icon: CHECK_ICON };
  if (undoAction) {
    toastOpts.action = { label: '撤销', onClick: undoAction };
    toastOpts.duration = 4000;
  }
  showToast(phrase, toastOpts);

  if (!isFxEnabled()) return;
  // 尊重 prefers-reduced-motion：前庭敏感用户跳过粒子/音效/震动，只留 Toast
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // 配色：品牌樱粉主色 + rose 情感色，在完成时刻共舞
  const rootStyle = getComputedStyle(document.documentElement);
  const primary = rootStyle.getPropertyValue('--color-primary').trim() || '#e884a8';
  // v2.7.61 樱白粉：尾档用 rose-400（#ee9cba），与主题色系一致
  const colors = [primary, ...ROSE, '#ee9cba'];

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
 * 对方升星的视图层星芒反馈（批次 4；本端自己的升星由 blindbox.celebrateStarUpgrade 放）。
 * 金色星形粒子与升星主题呼应：闪卡一束、烫金两束错时。
 */
export function celebrateStarUpgradeView(level = 1) {
  if (!isFxEnabled()) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#fbbf24', '#fcd34d', '#fde68a', '#fff7ed'];
  const origin = { y: 0.55 };
  confetti({ particleCount: 18, spread: 60, startVelocity: 28, ticks: 180, colors, origin, scalar: 0.85, shapes: ['star'] });
  if (level >= 2) {
    setTimeout(() => confetti({ particleCount: 22, spread: 80, startVelocity: 33, ticks: 220, colors, origin, scalar: 1, shapes: ['star'] }), 150);
  }
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
