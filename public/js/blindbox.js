/**
 * 隐藏款盲盒核心逻辑
 *
 * 机制：
 *   添加待办时 15% 概率开出"隐藏款"，命中后按 6:3:1 分稀有度 rare/epic/legendary。
 *   隐藏款有特殊稀有度背景 + 角标（applyRarity）；高稀有度添加时撒花（celebrateRarity）。
 *   开出隐藏款时解锁对应图鉴贴纸（onRollRarity）。
 *
 * 判定在前端做（非数据库），结果写入 todos.rarity 字段保证双端一致。
 * 应用是双人私享、无公开注册，rarity 只影响视觉/图鉴（无安全/经济后果），可接受。
 */

import confetti from './vendor/canvas-confetti.esm.min.js';
import { isFxEnabled } from './theme.js';
import { db } from './db.js';
import { getStickers, addOrUpdateSticker } from './state.js';
import { showToast } from './toast.js';

// ===== 概率配置 =====
const HIDDEN_RATE = 0.15; // 添加待办时开出隐藏款的总概率（15%）
// 命中隐藏款后的稀有度加权（6:3:1）
const RARITY_WEIGHTS = { rare: 60, epic: 30, legendary: 10 };

// 每个稀有度的贴纸数量（图鉴全集 12 张 = 4+4+4）
export const STICKERS_PER_RARITY = 4;

/**
 * 稀有度元数据：class 后缀、Toast 文案、撒花配色、贴纸名称 + 贴纸图标。
 * 每张贴纸有独立 SVG 图标（stickerIcons[0..3]），同稀有度共用配色。
 * 待办卡片不再用角标，改用彩色左边框体现稀有度（见 style.css）。
 * 所有 SVG 用 currentColor 单色，随稀有度染色（避免安卓 emoji 变黑）。
 */
export const RARITY_META = {
  rare: {
    label: '稀有',
    cls: 'todo--rare',
    toast: '✨ 开出稀有款！',
    confettiColors: null, // rare 不撒花，克制
    stickerNames: ['初心', '萌芽', '晨光', '清欢'],
    // 图鉴点击时的专属短句（与名称一一对应）
    stickerFlavors: [
      '一切，从第一条待办开始',
      '小小的开始，也在认真生长',
      '早起的意义，是先想到你',
      '平凡日常里的小确幸',
    ],
    // 稀有度配色（撒花/视觉用）：淡粉
    colors: ['#fda4af', '#fb7185', '#fecdd3'],
    // 清新·自然意象：嫩芽 / 露珠 / 四叶草 / 小花
    stickerIcons: [
      // 嫩芽
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21V11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M12 11C12 7 9 4 5 4c0 4 3 7 7 7z" fill="currentColor" opacity="0.9"/><path d="M12 13c0-3 3-6 7-6 0 4-3 6-7 6z" fill="currentColor" opacity="0.6"/></svg>',
      // 露珠
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3s-6 7-6 12a6 6 0 0 0 12 0c0-5-6-12-6-12z" fill="currentColor" opacity="0.85"/><ellipse cx="9.5" cy="13" rx="1.5" ry="2" fill="rgba(255,255,255,0.5)"/></svg>',
      // 四叶草
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" fill="currentColor" opacity="0.8"/><circle cx="8" cy="12" r="3.5" fill="currentColor" opacity="0.7"/><circle cx="16" cy="12" r="3.5" fill="currentColor" opacity="0.7"/><circle cx="12" cy="16" r="3.5" fill="currentColor" opacity="0.8"/><path d="M12 8v8M8 12h8" stroke="rgba(255,255,255,0.4)" stroke-width="0.8"/></svg>',
      // 小花
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="2.8" fill="currentColor" opacity="0.7"/><circle cx="7.5" cy="10.5" r="2.8" fill="currentColor" opacity="0.7"/><circle cx="16.5" cy="10.5" r="2.8" fill="currentColor" opacity="0.7"/><circle cx="10" cy="15" r="2.8" fill="currentColor" opacity="0.7"/><circle cx="14" cy="15" r="2.8" fill="currentColor" opacity="0.7"/><circle cx="12" cy="11.5" r="1.8" fill="rgba(255,255,255,0.7)"/></svg>',
    ],
  },
  epic: {
    label: '史诗',
    cls: 'todo--epic',
    toast: '🌟 开出史诗款！',
    confettiColors: ['#a78bfa', '#c4b5fd', '#8b5cf6', '#ddd6fe'],
    stickerNames: ['心动', '悸动', '钟情', '炽爱'],
    stickerFlavors: [
      '第一眼心动，是藏不住的',
      '心跳漏了一拍，就是此刻',
      '认准了，就不再看别处',
      '热烈的爱，也要一起完成',
    ],
    // 稀有度配色：浅紫
    colors: ['#a78bfa', '#c4b5fd', '#8b5cf6'],
    // 心动·浪漫意象：心跳 / 玫瑰 / 蝴蝶结 / 涟漪
    stickerIcons: [
      // 心跳（爱心）
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.5-9-9c-1-2.5.5-5 3.5-5 2 0 3.5 1.5 5.5 3.5C14 7.5 15.5 6 17.5 6c3 0 4.5 2.5 3.5 5-2 4.5-9 9-9 9z" fill="currentColor"/></svg>',
      // 玫瑰（多层花瓣）
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M12 9c0-3 2-5 0-6-2 1 0 3 0 6zM9 12c-3 0-5-2-6 0 1 2 3 0 6 0zM15 12c3 0 5-2 6 0-1 2-3 0-6 0zM12 15c0 3 2 5 0 6-2-1 0-3 0-6z" fill="currentColor" opacity="0.65"/><circle cx="12" cy="12" r="1.2" fill="rgba(255,255,255,0.7)"/></svg>',
      // 蝴蝶结
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12L4 7c-1.5-1-3 0-3 2v6c0 2 1.5 3 3 2l8-5z" fill="currentColor" opacity="0.8"/><path d="M12 12l8-5c1.5-1 3 0 3 2v6c0 2-1.5 3-3 2l-8-5z" fill="currentColor" opacity="0.8"/><rect x="11" y="9" width="2" height="6" rx="1" fill="currentColor"/></svg>',
      // 涟漪（同心圆扩散）
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="currentColor"/><circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.35"/></svg>',
    ],
  },
  legendary: {
    label: '传说',
    cls: 'todo--legendary',
    toast: '👑 开出传说款！惊艳！',
    confettiColors: ['#fbbf24', '#fcd34d', '#f59e0b', '#fff7ed', '#fda4af'],
    stickerNames: ['永恒', '璀璨', '至臻', '神话'],
    stickerFlavors: [
      '想和你把每一天过成纪念',
      '你是所有高光时刻的光源',
      '最好的时光，是和你慢慢来',
      '我们的故事，值得讲一辈子',
    ],
    // 稀有度配色：香槟金
    colors: ['#fbbf24', '#fcd34d', '#f59e0b'],
    // 永恒·珍贵意象：王冠 / 星辰 / 钻石 / 彩虹
    stickerIcons: [
      // 王冠
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9l3.5 3L12 5l5.5 7L21 9v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9z" fill="currentColor"/><circle cx="3" cy="7" r="1.3" fill="currentColor" opacity="0.6"/><circle cx="21" cy="7" r="1.3" fill="currentColor" opacity="0.6"/><circle cx="12" cy="3" r="1.3" fill="currentColor" opacity="0.6"/></svg>',
      // 星辰（大星 + 小星点缀）
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8z" fill="currentColor"/><path d="M18 4l.7 1.8L20.5 6.5l-1.8.7L18 9l-.7-1.8L15.5 6.5l1.8-.7z" fill="currentColor" opacity="0.6"/></svg>',
      // 钻石（菱形多面）
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2L4 9l8 13 8-13z" fill="currentColor"/><path d="M4 9h16M12 2v20M8 9l4-7 4 7" stroke="rgba(255,255,255,0.4)" stroke-width="0.8" fill="none"/></svg>',
      // 彩虹（三道弧）
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18a9 9 0 0 1 18 0" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 18a6 6 0 0 1 12 0" fill="none" stroke="currentColor" stroke-width="2" opacity="0.6"/><path d="M9 18a3 3 0 0 1 6 0" fill="none" stroke="currentColor" stroke-width="2" opacity="0.35"/></svg>',
    ],
  },
};

/**
 * 根据 stickerKey（如 'epic_3'）返回对应的贴纸图标 SVG。
 * 用于图鉴弹层渲染每张贴纸的独立图案。
 */
export function getStickerIcon(stickerKey) {
  const match = /^(rare|epic|legendary)_(\d+)$/.exec(stickerKey || '');
  if (!match) return '';
  const rarity = match[1];
  const idx = parseInt(match[2], 10) - 1;
  const meta = RARITY_META[rarity];
  if (!meta || !meta.stickerIcons) return '';
  return meta.stickerIcons[idx] || meta.stickerIcons[0];
}

/**
 * 根据 stickerKey 返回贴纸专属短句（图鉴点击时展示）。
 * 无配置时返回空串（调用方兜底）。
 */
export function getStickerFlavor(stickerKey) {
  const match = /^(rare|epic|legendary)_(\d+)$/.exec(stickerKey || '');
  if (!match) return '';
  const meta = RARITY_META[match[1]];
  const idx = parseInt(match[2], 10) - 1;
  if (!meta || !meta.stickerFlavors) return '';
  return meta.stickerFlavors[idx] || '';
}

/** 判断是否为隐藏款（rare/epic/legendary，排除 common） */
export function isHidden(rarity) {
  return !!rarity && rarity !== 'common' && RARITY_META[rarity];
}

/**
 * 开奖：返回本次添加的稀有度。
 * @returns {'rare'|'epic'|'legendary'|'common'} 85% 返回 'common'
 */
export function rollRarity() {
  if (Math.random() >= HIDDEN_RATE) return 'common';
  // 命中隐藏款，按权重分稀有度
  const total = RARITY_WEIGHTS.rare + RARITY_WEIGHTS.epic + RARITY_WEIGHTS.legendary;
  let r = Math.random() * total;
  if (r < RARITY_WEIGHTS.rare) return 'rare';
  r -= RARITY_WEIGHTS.rare;
  if (r < RARITY_WEIGHTS.epic) return 'epic';
  return 'legendary';
}

/**
 * 给 todo 的 <li> 应用稀有度样式（背景 + 边框 class）。
 * 不再使用角标节点——改用 CSS 的彩色左边框体现稀有度，不占文字空间。
 * 幂等：多次调用安全。
 *
 * @param {HTMLElement} li todo 的 li 元素
 * @param {Object} todo todo 对象（含 rarity 字段）
 */
export function applyRarity(li, todo) {
  if (!li) return;
  const rarity = todo.rarity || 'common';

  // 清除所有稀有度 class，再按需添加
  li.classList.remove('todo--rare', 'todo--epic', 'todo--legendary');

  if (!isHidden(rarity)) return; // 普通款无需额外样式

  li.classList.add(RARITY_META[rarity].cls);
}

/**
 * 隐藏款开奖庆祝：rare 仅 Toast，epic/legendary 撒花 + 音效 + 震动。
 * 复用 confetti + isFxEnabled + prefers-reduced-motion 守卫。
 * @param {string} rarity 'rare'|'epic'|'legendary'
 * @param {string} text 待办文本（Toast 用）
 */
export function celebrateRarity(rarity, text) {
  if (!isHidden(rarity)) return;
  const meta = RARITY_META[rarity];
  showToast(meta.toast);

  if (!meta.confettiColors) return; // rare 不撒花
  if (!isFxEnabled()) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const colors = meta.confettiColors;
  const origin = { y: 0.6 };

  if (rarity === 'epic') {
    // 史诗：玫红系粒子，双束
    confetti({ particleCount: 35, spread: 70, startVelocity: 38, ticks: 200, colors, origin, scalar: 1.2 });
    setTimeout(() => confetti({ particleCount: 18, angle: 60, spread: 50, colors, origin: { x: 0, y: 0.6 }, scalar: 1.1 }), 120);
  } else {
    // 传说：金色满屏，三束 + 更多粒子，仪式感
    confetti({ particleCount: 60, spread: 100, startVelocity: 45, ticks: 260, colors, origin, scalar: 1.4, flat: false });
    setTimeout(() => confetti({ particleCount: 30, angle: 60, spread: 60, colors, origin: { x: 0, y: 0.6 }, scalar: 1.3 }), 120);
    setTimeout(() => confetti({ particleCount: 30, angle: 120, spread: 60, colors, origin: { x: 1, y: 0.6 }, scalar: 1.3 }), 120);
  }

  // 震动（传说款更强）
  if (navigator.vibrate) {
    try {
      navigator.vibrate(rarity === 'legendary' ? [40, 30, 40, 30, 60] : [30, 20, 30]);
    } catch (_) {}
  }
}

/**
 * 开出隐藏款时解锁图鉴贴纸（添加待办时即解锁，无需完成）。
 * 根据该稀有度已解锁数量，算出下一个 stickerKey（如 'epic_2'），调 db.unlockSticker。
 * 幂等：重复开出不会重复解锁（db 层 UNIQUE 约束）。
 *
 * @param {Object} todo 刚开出的隐藏款 todo 对象（含 id）
 * @param {string} userId 当前用户 id（解锁人）
 * @returns {Promise<Object|null>} 新解锁的贴纸；已存在则 null
 */
export async function onRollRarity(todo, userId) {
  if (!isHidden(todo.rarity)) return null;
  const rarity = todo.rarity;

  // 数该稀有度已解锁几张 → 下一个序号
  const count = getStickers().filter((s) => s.rarity === rarity).length;
  const next = count + 1;
  // 超过该稀有度上限（集满了）：不重复解锁，给个温和提示
  if (next > STICKERS_PER_RARITY) {
    showToast(`${RARITY_META[rarity].label}图鉴已集齐，继续探索其它稀有度吧`);
    return null;
  }

  const stickerKey = `${rarity}_${next}`;
  const meta = RARITY_META[rarity];
  const name = meta.stickerNames[next - 1] || `${meta.label}${next}`;

  try {
    const sticker = await db.unlockSticker(stickerKey, rarity, userId, todo.id);
    if (sticker) {
      // 本端立即更新图鉴状态（Realtime 也会推回来，addOrUpdateSticker 幂等）
      addOrUpdateSticker(sticker);
      showToast(`🎨 解锁贴纸「${name}」！图鉴 ${getStickers().length}/${STICKERS_PER_RARITY * 3}`);
    }
    // sticker === null 表示已存在（重复解锁），静默
    return sticker;
  } catch (err) {
    console.warn('[blindbox] 解锁贴纸失败（已忽略）:', err.message);
    return null;
  }
}
