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
      '一直没变的心意，才叫初心',
      '小小的日子，也在认真生长',
      '早起的意义，是先想到你',
      '平凡日常里的小确幸',
    ],
    // 稀有度配色（撒花/视觉用）：暖蜜桃（v2.7.51 P3.2 与 rose token 升级对齐）
    // 原色 #fda4af / #fb7185 / #fecdd3（冷粉）→ #f9e3d4 / #f1c4a8 / #fda4af（warm peach）
    colors: ['#fce7da', '#f4cbb4', '#fda4af'],
    // 清新·自然意象：嫩芽 / 露珠 / 四叶草 / 小花（多层彩色插画，渐变 id 全局唯一）
    stickerIcons: [
      // 初心·嫩芽：双色新叶 + 茎 + 露珠高光 + 星芒点缀
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="sk1a" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#4ade80"/><stop offset="1" stop-color="#16a34a"/></linearGradient><linearGradient id="sk1b" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#fbcfe8"/><stop offset="1" stop-color="#f472b6"/></linearGradient></defs><path d="M24 43V17" stroke="#22c55e" stroke-width="4" stroke-linecap="round" fill="none"/><path d="M24 28C24 17.5 16.5 9.5 6.5 9.5c0 10 6.5 18.5 17.5 18.5z" fill="url(#sk1b)"/><path d="M24 21c0-8.5 6.5-14.5 15.5-14.5 0 8.5-6 14.5-15.5 14.5z" fill="url(#sk1a)"/><ellipse cx="13.5" cy="16" rx="2.2" ry="3.6" fill="#fff" opacity=".55" transform="rotate(-32 13.5 16)"/><ellipse cx="31" cy="13.5" rx="1.8" ry="3" fill="#fff" opacity=".45" transform="rotate(28 31 13.5)"/><path d="M0-3.4Q.9-.9 3.4 0 .9.9 0 3.4-.9.9-3.4 0-.9-.9 0-3.4Z" fill="#fda4af" transform="translate(42 5)"/><path d="M0-3.4Q.9-.9 3.4 0 .9.9 0 3.4-.9.9-3.4 0-.9-.9 0-3.4Z" fill="#fda4af" opacity=".75" transform="translate(6 5) scale(.72)"/></svg>',
      // 萌芽·露珠：蓝粉渐变水滴 + 高光 + 底部涟漪 + 星芒点缀
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="sk2a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#bae6fd"/><stop offset=".55" stop-color="#7dd3fc"/><stop offset="1" stop-color="#f9a8d4"/></linearGradient></defs><path d="M24 5s-11 12.5-11 21a11 11 0 0 0 22 0c0-8.5-11-21-11-21z" fill="url(#sk2a)"/><ellipse cx="18.5" cy="22" rx="2.6" ry="4.6" fill="#fff" opacity=".65" transform="rotate(18 18.5 22)"/><ellipse cx="29" cy="30" rx="1.6" ry="2.6" fill="#fff" opacity=".35" transform="rotate(-15 29 30)"/><ellipse cx="24" cy="42.5" rx="10" ry="2.5" fill="#38bdf8" opacity=".55"/><path d="M0-3.4Q.9-.9 3.4 0 .9.9 0 3.4-.9.9-3.4 0-.9-.9 0-3.4Z" fill="#fda4af" opacity=".9" transform="translate(37.5 8.5)"/></svg>',
      // 晨光·四叶草：四叶团簇 + 白色叶脉 + 弯茎
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="sk3a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4ade80"/><stop offset="1" stop-color="#15803d"/></linearGradient></defs><path d="M24 37c-.5 3 .5 5.5 2.5 7.5" stroke="#22c55e" stroke-width="2.6" stroke-linecap="round" fill="none"/><circle cx="17" cy="17" r="8" fill="url(#sk3a)"/><circle cx="31" cy="17" r="8" fill="url(#sk3a)"/><circle cx="17" cy="31" r="8" fill="url(#sk3a)"/><circle cx="31" cy="31" r="8" fill="url(#sk3a)"/><circle cx="24" cy="24" r="3.6" fill="#15803d"/><path d="M12 13.5l4.5 4.5M33.5 13.5L29 18" stroke="#fff" opacity=".5" stroke-width="1.6" stroke-linecap="round"/><ellipse cx="14.5" cy="14.5" rx="1.8" ry="2.8" fill="#fff" opacity=".5" transform="rotate(-40 14.5 14.5)"/></svg>',
      // 清欢·小花：五瓣旋花 + 双色花心 + 嫩叶
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="sk4a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbcfe8"/><stop offset="1" stop-color="#fb7185"/></linearGradient></defs><path d="M18 40c-4-1-6.5-4-6-8 3 1 5 3.5 5.5 7z" fill="#4ade80" opacity=".85"/><path d="M30 40c4-1 6.5-4 6-8-3 1-5 3.5-5.5 7z" fill="#4ade80" opacity=".85"/><g fill="url(#sk4a)"><ellipse cx="24" cy="11.5" rx="5.6" ry="7"/><ellipse cx="24" cy="11.5" rx="5.6" ry="7" transform="rotate(72 24 24)"/><ellipse cx="24" cy="11.5" rx="5.6" ry="7" transform="rotate(144 24 24)"/><ellipse cx="24" cy="11.5" rx="5.6" ry="7" transform="rotate(216 24 24)"/><ellipse cx="24" cy="11.5" rx="5.6" ry="7" transform="rotate(288 24 24)"/></g><circle cx="24" cy="24" r="5.8" fill="#fcd34d"/><circle cx="24" cy="24" r="3" fill="#f59e0b"/><ellipse cx="21.5" cy="9.5" rx="1.5" ry="2.6" fill="#fff" opacity=".6"/></svg>',
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
    // 心动·浪漫意象：心跳 / 玫瑰 / 蝴蝶结 / 涟漪（多层彩色插画）
    stickerIcons: [
      // 心动·心跳：紫粉渐变爱心 + 白色心跳线 + 星芒点缀
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="sk5a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c4b5fd"/><stop offset=".55" stop-color="#a78bfa"/><stop offset="1" stop-color="#f472b6"/></linearGradient></defs><path d="M24 41C12 33 4 25 4 16.5 4 10 8.5 6 14 6c4 0 7.5 2.2 10 5.8C26.5 8.2 30 6 34 6c5.5 0 10 4 10 10.5C44 25 36 33 24 41z" fill="url(#sk5a)"/><path d="M9 22.5h6l3-6.5 4.5 12 3-5.5H34" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity=".85"/><ellipse cx="14.5" cy="14" rx="2.8" ry="4.4" fill="#fff" opacity=".38" transform="rotate(24 14.5 14)"/><path d="M0-3.4Q.9-.9 3.4 0 .9.9 0 3.4-.9.9-3.4 0-.9-.9 0-3.4Z" fill="#f9a8d4" transform="translate(42.5 6.5)"/><path d="M0-3.4Q.9-.9 3.4 0 .9.9 0 3.4-.9.9-3.4 0-.9-.9 0-3.4Z" fill="#c4b5fd" opacity=".85" transform="translate(5 5.5) scale(.78)"/></svg>',
      // 悸动·玫瑰：三层花瓣旋心 + 花萼 + 叶 + 星芒点缀
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="sk6a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f9a8d4"/><stop offset="1" stop-color="#db2777"/></linearGradient></defs><path d="M25 30c0 4.5-.8 8.5-3 12" stroke="#34d399" stroke-width="2.6" stroke-linecap="round" fill="none"/><path d="M22 34c-4.5-.5-7-3-7-6.5 3.5-.5 6.5 1.5 7.5 5z" fill="#4ade80"/><path d="M28 36.5c4.5-.5 7-3 7-6.5-3.5-.5-6.5 1.5-7.5 5z" fill="#4ade80"/><circle cx="24" cy="19" r="12" fill="url(#sk6a)"/><circle cx="24" cy="19" r="8" fill="#f9a8d4" opacity=".9"/><circle cx="24" cy="19" r="4.6" fill="#fbcfe8"/><path d="M24 19c1.6-.4 2.6-1.8 2.6-3.6" stroke="#db2777" stroke-width="1.8" stroke-linecap="round" fill="none" opacity=".7"/><ellipse cx="18" cy="12.5" rx="1.7" ry="3" fill="#fff" opacity=".55" transform="rotate(30 18 12.5)"/><path d="M0-3.4Q.9-.9 3.4 0 .9.9 0 3.4-.9.9-3.4 0-.9-.9 0-3.4Z" fill="#f9a8d4" transform="translate(38.5 8)"/></svg>',
      // 钟情·蝴蝶结：双层缎带翼 + 中心结 + 飘带
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="sk7a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ddd6fe"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient><linearGradient id="sk7b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbcfe8"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><path d="M21 24C14.5 17 8 15.5 5.5 18.5 3 21.5 4 28 8 31c4 3 10 0 13-4z" fill="url(#sk7a)"/><path d="M27 24c6.5-7 13-8.5 15.5-5.5C45 21.5 44 28 40 31c-4 3-10 0-13-4z" fill="url(#sk7a)"/><path d="M21 24c-5.5-3.8-10-4.8-12.5-3.3M27 24c5.5-3.8 10-4.8 12.5-3.3" stroke="#fff" opacity=".45" fill="none" stroke-width="1.6" stroke-linecap="round"/><path d="M20.5 29.5 16 41l6-3.8L24 41l2.5-11z" fill="url(#sk7b)"/><path d="M27.5 29.5 32 41l-6-3.8L24 41l-2.5-11z" fill="url(#sk7b)"/><rect x="19.5" y="19" width="9" height="10.5" rx="3.4" fill="url(#sk7b)"/><ellipse cx="22" cy="22" rx="1.5" ry="2.3" fill="#fff" opacity=".55"/></svg>',
      // 炽爱·涟漪：渐变爱心落入同心涟漪 + 星芒点缀
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="sk8a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c4b5fd"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><path d="M24 8c4.5 0 8 3.4 8 7.6 0 6.2-8 13.4-8 13.4S16 21.8 16 15.6C16 11.4 19.5 8 24 8z" fill="url(#sk8a)"/><ellipse cx="20.5" cy="13.5" rx="2" ry="3.2" fill="#fff" opacity=".5" transform="rotate(20 20.5 13.5)"/><ellipse cx="24" cy="37.5" rx="16.5" ry="4.2" fill="none" stroke="#a78bfa" stroke-width="2" opacity=".4"/><ellipse cx="24" cy="37.5" rx="10" ry="2.7" fill="none" stroke="#a78bfa" stroke-width="2" opacity=".65"/><ellipse cx="24" cy="37.5" rx="4.4" ry="1.4" fill="#c4b5fd"/><path d="M0-3.4Q.9-.9 3.4 0 .9.9 0 3.4-.9.9-3.4 0-.9-.9 0-3.4Z" fill="#c4b5fd" transform="translate(9 29) scale(.85)"/><path d="M0-3.4Q.9-.9 3.4 0 .9.9 0 3.4-.9.9-3.4 0-.9-.9 0-3.4Z" fill="#f9a8d4" transform="translate(39 30.5)"/></svg>',
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
    // 永恒·珍贵意象：王冠 / 星辰 / 钻石 / 星河（香槟金多层插画）
    stickerIcons: [
      // 永恒·王冠：金冠 + 三珠尖 + 宝石带
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="sk9a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs><path d="M7 32 4.5 14l9 6.5L24 8l10.5 12.5 9-6.5L41 32z" fill="url(#sk9a)"/><rect x="6.5" y="32" width="35" height="6.5" rx="2.6" fill="#f59e0b"/><rect x="6.5" y="32" width="35" height="2.4" rx="1.2" fill="#fde68a" opacity=".7"/><circle cx="4" cy="12" r="2.3" fill="#fbbf24"/><circle cx="24" cy="6" r="2.5" fill="#fbbf24"/><circle cx="44" cy="12" r="2.3" fill="#fbbf24"/><circle cx="15" cy="35.2" r="1.7" fill="#fb7185"/><circle cx="24" cy="35.2" r="1.9" fill="#f43f5e"/><circle cx="33" cy="35.2" r="1.7" fill="#fb7185"/><path d="M11.5 27l2.5-7" stroke="#fff" opacity=".55" stroke-width="2" stroke-linecap="round"/></svg>',
      // 璀璨·星辰：四芒主星 + 光芒 + 小星
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="sk10a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fef3c7"/><stop offset=".5" stop-color="#fcd34d"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs><g stroke="#fcd34d" stroke-width="2" stroke-linecap="round" opacity=".5"><path d="M24 2.5v4.5"/><path d="M24 41v4.5"/><path d="M2.5 24H7"/><path d="M41 24h4.5"/><path d="M8.5 8.5l3 3"/><path d="M36.5 36.5l3 3"/><path d="M39.5 8.5l-3 3"/><path d="M11.5 36.5l-3 3"/></g><path d="M24 6c1.6 7.5 4.5 12.5 12 14-7.5 1.5-10.4 6.5-12 14-1.6-7.5-4.5-12.5-12-14 7.5-1.5 10.4-6.5 12-14z" fill="url(#sk10a)"/><circle cx="20.5" cy="16.5" r="1.8" fill="#fff" opacity=".85"/><path d="M37.5 6l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" fill="#fde68a"/></svg>',
      // 至臻·钻石：切面宝石 + 刻面线 + 高光
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="sk11a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fef9c3"/><stop offset="1" stop-color="#fcd34d"/></linearGradient><linearGradient id="sk11b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs><path d="M14 10h20l8 9-18 21L6 19z" fill="url(#sk11a)"/><path d="M18 19h12l-6 21z" fill="url(#sk11b)" opacity=".55"/><path d="M14 10l4 9h12l4-9M18 19l6 21 6-21M6 19h12M30 19h12" stroke="#fff" stroke-width="1.4" opacity=".55" fill="none"/><path d="M16.5 12.5h9" stroke="#fff" stroke-width="2" opacity=".8" stroke-linecap="round"/><path d="M40 4.5l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z" fill="#fde68a"/></svg>',
      // 神话·星河：金色旋臂星系 + 流星
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="sk12a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs><path d="M24 24c-8.5-6-9.5-16-2.5-21.5" fill="none" stroke="url(#sk12a)" stroke-width="2.6" stroke-linecap="round" opacity=".8"/><path d="M24 24c8.5 6 9.5 16 2.5 21.5" fill="none" stroke="url(#sk12a)" stroke-width="2.6" stroke-linecap="round" opacity=".8"/><circle cx="24" cy="24" r="5.2" fill="url(#sk12a)"/><circle cx="24" cy="24" r="2.2" fill="#fffbeb"/><circle cx="18.5" cy="9" r="1.8" fill="#fcd34d"/><circle cx="30" cy="39" r="1.8" fill="#fcd34d"/><circle cx="13" cy="17" r="1.3" fill="#fde68a"/><circle cx="35" cy="31" r="1.3" fill="#fde68a"/><path d="M44.5 5.5 34.5 15.5" stroke="#fde68a" stroke-width="2" stroke-linecap="round" opacity=".7"/><path d="M37 3.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" fill="#fbbf24"/></svg>',
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
