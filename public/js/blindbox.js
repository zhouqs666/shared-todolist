/**
 * 隐藏款盲盒核心逻辑
 *
 * 机制：
 *   添加待办时 15% 概率开出"隐藏款"，命中后按 6:3:1 分稀有度 rare/epic/legendary。
 *   抽选只在**还没集齐**的档位里进行（2026-09-17 修）：旧实现不看图鉴进度，某一档 4 张
 *   集齐后仍会开出该档，卡片显示稀有度、撒花照放，却一张贴纸都解锁不了 —— 那次开奖白开。
 *   隐藏款有特殊稀有度背景 + 角标（applyRarity）；高稀有度添加时撒花（celebrateRarity）。
 *   开出隐藏款时解锁对应图鉴贴纸（onRollRarity）。
 *
 * 判定在前端做（非数据库），结果写入 todos.rarity 字段保证双端一致。
 * 应用是双人私享、无公开注册，rarity 只影响视觉/图鉴（无安全/经济后果），可接受。
 */

import confetti from './vendor/canvas-confetti.esm.min.js';
import { isFxEnabled } from './theme.js';
import { db } from './db.js';
import { getStickers, setStickers, addOrUpdateSticker } from './state.js';
import { showToast } from './toast.js';
import { STORY_META, STORY_ACCENT } from './sticker-series-story.js';

// ===== 概率配置 =====
const HIDDEN_RATE = 0.15; // 添加待办时开出隐藏款的总概率（15%）
// 命中隐藏款后的稀有度加权（6:3:1）
const RARITY_WEIGHTS = { rare: 60, epic: 30, legendary: 10 };

// 抽选与展示顺序：rare → epic → legendary（由低到高，与 sticker-book 一致）
const RARITY_ORDER = ['rare', 'epic', 'legendary'];

// 每个稀有度的贴纸数量（每册全集 12 张 = 4+4+4）
export const STICKERS_PER_RARITY = 4;

// ===== 升星（批次 4，docs/sticker-book-roadmap.md §7）=====
// 星级 0/1/2 = 普通/闪卡/烫金（上限 2）。升星期（全部册集齐后，D12）开出隐藏款
// 不再解锁新贴纸，而是给「该册该档最低序号的未满星贴纸」+1 星。
export const MAX_STAR_LEVEL = 2;
const STAR_LABELS = { 1: '闪卡', 2: '烫金' };

/** 星级展示名（0 → ''，1 → '闪卡'，2 → '烫金'）；未知值兜底 '' */
export function starLabel(level) {
  return STAR_LABELS[level] || '';
}

// 最近一次**本端**升星（key + 升到的星级）。升星的 Realtime 回声与 DB 响应到达顺序不定，
// 回调方（app.js）用它区分「自己的回声」与「对方升的星」——回声不重复提示。
// 在发起 UPDATE 前就写入（不是成功后）：广播发生在提交之后，无论回声先到后到都能对上。
let lastSelfStarUpgrade = null;

/** 该次 stickers UPDATE 是否是本端升星的回声（幂等比对 key + 星级） */
export function isSelfStarEcho(sticker) {
  return !!lastSelfStarUpgrade && !!sticker
    && lastSelfStarUpgrade.key === sticker.stickerKey
    && lastSelfStarUpgrade.level === (sticker.starLevel || 0);
}

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
    // 稀有度配色（撒花/视觉用）：樱粉（v2.7.61 与 rose token 樱白粉对齐）
    // colors 前两档跟随 rose-100/200，第三档 #fda4af 为稀有度强调粉
    colors: ['#fdf0f5', '#f9d6e2', '#fda4af'],
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

// ===== 册（book series）注册表 =====
// key 语义前缀方案（docs/sticker-book-roadmap.md §5.1）：sticker_key 形如
// `[册短名_]档位_序号`——第一册（v1）**无前缀**（历史数据即此形态），后续册带册短名前缀
// （第二册 = `story_rare_1` …）。不用"加 series 列"：免 DB 迁移、key 自解释，
// 两种形态的兼容成本由 parseStickerKey() 单点承担。
//
// ⚠️ 册短名禁用 rare / epic / legendary（与档位名冲突，解析歧义）也不得占用 'v1'；
// 注册新册时同步在 SERIES_DEFS 里加一行（模块加载期校验不合法直接 throw）。

/** 第一册的内部标识：key 无前缀，解析时缺省视为 v1 */
export const BASE_SERIES = 'v1';

const SERIES_DEFS = {
  [BASE_SERIES]: {
    id: BASE_SERIES, prefix: '', title: '收集图鉴',
    // 册专属内容（名称/短句/图标）+ 书脊配色：v1 = 樱粉默认（线上零变化）
    meta: RARITY_META,
    accent: { spine: '#e884a8', tint: 'rgba(232, 132, 168, 0.14)', ink: '#c2527e' },
  },
  // 第二册「我们的故事」（批次 3）：内容在 sticker-series-story.js，第一册集齐后开启
  story: { id: 'story', prefix: 'story', title: '我们的故事', meta: STORY_META, accent: STORY_ACCENT },
};

// 注册表防呆：短名仅限 [a-z0-9]+，且不得与档位名 / BASE_SERIES 冲突（见上方警告）
for (const def of Object.values(SERIES_DEFS)) {
  if (!/^[a-z0-9]+$/.test(def.id)) throw new Error(`册短名非法: ${def.id}`);
  if (RARITY_META[def.id]) throw new Error(`册短名 ${def.id} 与稀有度名冲突，解析会歧义`);
  if (def.id === BASE_SERIES && def.prefix) throw new Error(`${BASE_SERIES} 册必须无前缀`);
}

/** 全部已注册册的 id（展示顺序即注册顺序） */
export function getSeriesIds() {
  return Object.keys(SERIES_DEFS);
}

/** 查册定义（title / prefix 等）；未注册的 series 返回 undefined */
export function getSeriesDef(series) {
  return SERIES_DEFS[series];
}

/**
 * sticker_key 解析——**全仓唯一解析点**（原先 blindbox / sticker-book 各自维护裸正则，
 * 2026-10-04 批次 2 收敛于此）。
 *
 * @param {string} key
 * @returns {{series: string, rarity: string, index: number}|null}
 *   series 为 BASE_SERIES（'v1'）表示第一册（key 无前缀）；
 *   解析失败（畸形 key / 非贴纸 key）返回 null，调用方按"无图标 / 未解锁"兜底
 */
export function parseStickerKey(key) {
  const m = /^(?:([a-z0-9]+)_)?(rare|epic|legendary)_(\d+)$/.exec(key || '');
  if (!m) return null;
  return { series: m[1] || BASE_SERIES, rarity: m[2], index: parseInt(m[3], 10) };
}

/**
 * 构造 sticker_key（parseStickerKey 的逆操作）。v1 无前缀，输出与历史格式逐字相同；
 * 批次 3 起传入册 id 即得带前缀 key（如 makeStickerKey('story', 'rare', 1) → 'story_rare_1'）。
 */
export function makeStickerKey(series, rarity, index) {
  const def = SERIES_DEFS[series];
  if (!def) throw new Error(`未注册的册 series: ${series}`);
  return def.prefix ? `${def.prefix}_${rarity}_${index}` : `${rarity}_${index}`;
}

/**
 * 根据 stickerKey（如 'epic_3' / 'story_epic_3'）返回对应的贴纸图标 SVG。
 * 用于图鉴弹层渲染每张贴纸的独立图案。图标按册分派：v1 用 RARITY_META，
 * story 册用其内容模块的图标表（批次 3 起）。
 */
export function getStickerIcon(stickerKey) {
  const parsed = parseStickerKey(stickerKey);
  if (!parsed) return '';
  const meta = seriesRarityMeta(parsed.series, parsed.rarity);
  const idx = parsed.index - 1;
  if (!meta || !meta.stickerIcons) return '';
  return meta.stickerIcons[idx] || meta.stickerIcons[0];
}

/**
 * 根据 stickerKey 返回贴纸专属短句（图鉴点击时展示的故事卡文案）。
 * 短句按册分派（v1 / story 各自的文案表）。无配置时返回空串（调用方兜底）。
 */
export function getStickerFlavor(stickerKey) {
  const parsed = parseStickerKey(stickerKey);
  if (!parsed) return '';
  const meta = seriesRarityMeta(parsed.series, parsed.rarity);
  if (!meta || !meta.stickerFlavors) return '';
  return meta.stickerFlavors[parsed.index - 1] || '';
}

/**
 * 根据 stickerKey 返回贴纸名（图鉴格子 / 提示文案用）。
 * 名称按册分派（v1 / story 各自的名称表）；解析失败返回空串（调用方兜底）。
 */
export function getStickerName(stickerKey) {
  const parsed = parseStickerKey(stickerKey);
  if (!parsed) return '';
  const meta = seriesRarityMeta(parsed.series, parsed.rarity);
  if (!meta || !meta.stickerNames) return '';
  return meta.stickerNames[parsed.index - 1] || '';
}

/** 指定册 + 档位的内容元数据（名称/短句/图标）；未注册册回退 v1（解析层已挡畸形 key） */
function seriesRarityMeta(series, rarity) {
  const def = SERIES_DEFS[series];
  return (def && def.meta && def.meta[rarity]) || RARITY_META[rarity];
}

/** 判断是否为隐藏款（rare/epic/legendary，排除 common） */
export function isHidden(rarity) {
  return !!rarity && rarity !== 'common' && RARITY_META[rarity];
}

/**
 * 指定册的图鉴进度：该册各档已解锁张数（批次 3 起按册隔离——多册并存时
 * 全局计数会污染抽选池）。口径是 key 解析出的 series，不信任 rarity 字段单方。
 *
 * ⚠️ 口径是**本地状态**（getStickers），可能滞后于数据库（冷启动时 listStickers 还没回来、
 * 双端同刻开出同一档）。它只用于「优先开还给得出贴纸的档位」，滞后时最坏结果是白开一次
 * （由 onRollRarity 的已集齐兜底 + 状态对齐收尾），不会产生重复贴纸或数据不一致。
 * @param {string} [series] 册 id，默认第一册（BASE_SERIES）
 */
export function rarityProgress(series = BASE_SERIES) {
  const counts = { rare: 0, epic: 0, legendary: 0 };
  for (const s of getStickers()) {
    if (s && (parseStickerKey(s.stickerKey) || {}).series === series && counts[s.rarity] !== undefined) {
      counts[s.rarity]++;
    }
  }
  return counts;
}

/**
 * 指定册里还有未解锁贴纸的档位（本地状态口径）；该册 12 张全齐时返回空数组。
 * @param {string} [series] 册 id，默认第一册（BASE_SERIES）
 */
export function availableRarities(series = BASE_SERIES) {
  const counts = rarityProgress(series);
  return RARITY_ORDER.filter((r) => counts[r] < STICKERS_PER_RARITY);
}

/** 指定册是否已全部集齐（本地状态口径）。@param {string} [series] 册 id，默认第一册 */
export function isBookComplete(series = BASE_SERIES) {
  return availableRarities(series).length === 0;
}

/**
 * 当前开启册（批次 3 开启机制的核心）：**注册顺序上第一个未集齐的册**。
 * 开奖的档位抽选与贴纸解锁都指向它——第一册集齐后第二册自然进入抽选池
 * （路线图 §6.2）；上线时第一册已集齐的用户下一次开奖即立即开启第二册。
 * 全部册集齐时返回 null（开奖回落全池，只保留惊喜视觉，不再解锁）。
 * @returns {string|null}
 */
export function getRollTargetSeries() {
  for (const id of getSeriesIds()) {
    if (!isBookComplete(id)) return id;
  }
  return null;
}

/** 全部已注册册是否都已集齐（本地状态口径） */
export function isAllBooksComplete() {
  return getRollTargetSeries() === null;
}

/**
 * 指定册里还有未满星贴纸的档位（本地状态口径；升星期的抽选池来源）。
 * 与 availableRarities 同构——"已集齐的档退出抽选池"在升星期的对应物是
 * "已满星的档退出抽选池"，避免开出的档位无处可升（白开）。
 * @param {string} [series] 册 id，默认第一册（BASE_SERIES）
 */
export function upgradableRarities(series = BASE_SERIES) {
  return RARITY_ORDER.filter((r) => getStickers().some((s) => {
    const p = parseStickerKey(s && s.stickerKey);
    return p && p.series === series && s.rarity === r && (s.starLevel || 0) < MAX_STAR_LEVEL;
  }));
}

/** 指定册还有几张贴纸未满星（0 = 该册升满；供完成态文案用） */
export function upgradableCount(series = BASE_SERIES) {
  return getStickers().filter((s) => {
    const p = parseStickerKey(s && s.stickerKey);
    return p && p.series === series && (s.starLevel || 0) < MAX_STAR_LEVEL;
  }).length;
}

/**
 * 当前升星目标册：**注册顺序上第一个「已集齐且还有未满星贴纸」的册**
 * （与 getRollTargetSeries 同构——"合上第一本再翻开第二本"，第一册升满后才轮到下一册）。
 * 只在升星期（全部册集齐）有意义：D12 规定新册收集中永不升星，
 * 收集期调用恒返回 null，抽选与解锁逻辑不会走到这里。
 * @returns {string|null} 全部满星（终局）时返回 null
 */
export function getStarTargetSeries() {
  if (!isAllBooksComplete()) return null; // D12：新册收集中永不升星
  for (const id of getSeriesIds()) {
    if (isBookComplete(id) && upgradableRarities(id).length > 0) return id;
  }
  return null;
}

/**
 * 指定册的进度短语（Toast 用）：v1 沿用「图鉴 x/12」，后续册带册名防混淆
 * （多册并存后裸「图鉴 x/12」指代不明）。
 */
export function seriesProgressLabel(series = BASE_SERIES) {
  const def = SERIES_DEFS[series] || SERIES_DEFS[BASE_SERIES];
  const total = STICKERS_PER_RARITY * 3;
  const count = getStickers().filter((s) => s && (parseStickerKey(s.stickerKey) || {}).series === series).length;
  return series === BASE_SERIES ? `图鉴 ${count}/${total}` : `${def.title} ${count}/${total}`;
}

/**
 * 按权重从 pool 里抽一档；权重在 pool 内部**重新归一**（相对比例不变：
 * rare 已集齐时 epic:legendary 仍是 3:1，而不是各 50%）。
 * @param {string[]} pool 参与抽选的档位
 * @param {Object} [weights] 权重表
 * @returns {string|null} pool 为空（或权重全为 0）时返回 null
 */
export function pickRarityByWeight(pool, weights = RARITY_WEIGHTS) {
  const usable = pool.filter((r) => weights[r] > 0);
  if (!usable.length) return null;
  const total = usable.reduce((sum, r) => sum + weights[r], 0);
  let r = Math.random() * total;
  for (const rarity of usable) {
    r -= weights[rarity];
    if (r < 0) return rarity;
  }
  return usable[usable.length - 1]; // 浮点误差兜底（Math.random() < 1 ⇒ 正常到不了这里）
}

/**
 * 开奖：返回本次添加的稀有度。
 *
 * E2E 测试钩子：localStorage 里显式放着 `__e2e_force_rarity`（'rare'/'epic'/'legendary'/'common'）
 * 时直接返回该值。为什么需要它：隐藏款是 15% 概率，E2E 无法稳定复现「开出隐藏款 → 解锁贴纸」
 * 这条链，于是这条链此前完全没有测试覆盖（2026-09-16 补）。生产环境没有任何入口写这个 key，
 * 行为与不加钩子时完全一致。
 * ⚠️ 钩子是**显式覆盖**（含集齐的档位，也照返回）：E2E 靠它验「本地状态滞后 ⇒ 白开一次
 * → 已集齐提示」这条兜底路径（2026-09-17）。
 *
 * 档位选择性（2026-09-17 修，批次 3 起按册）：命中隐藏款后只在**当前开启册**
 * （getRollTargetSeries，注册顺序第一个未集齐的册）**还有未解锁贴纸**的档位里按权重抽。
 * 否则某一档集齐后仍会被开出 —— 卡片显示该稀有度、撒花照放，却没有任何贴纸可解锁，
 * 用户看到的是「开出稀有款 → 稀有图鉴已集齐」的空开（业主 2026-09-17 报的 bug）。
 * 第一册集齐后第二册自动成为开启册（其档位池重新计算）；全部册集齐后进入升星期
 * （池 = 升星目标册的未满星档），全部满星后回落三档全池。
 * @returns {'rare'|'epic'|'legendary'|'common'} 85% 返回 'common'
 */
export function rollRarity() {
  let forced = null;
  try {
    forced = localStorage.getItem('__e2e_force_rarity');
  } catch (_) { /* 隐私模式等场景下 localStorage 不可用，按正常随机走 */ }
  if (forced === 'common' || (forced && RARITY_META[forced])) return forced;

  if (Math.random() >= HIDDEN_RATE) return 'common';
  // 档位池按「当前开启册」（getRollTargetSeries）取——该册已集齐的档退出抽选，
  // 权重在剩余档位内重新归一；全部册集齐后没有可补的册：进入升星期（D12），
  // 池改为「升星目标册里还有未满星贴纸的档位」（upgradableRarities，同一归一思路）；
  // 全部满星（终局）回落三档全池 —— 隐藏款本身（配色/撒花/对方端揭晓）仍是惊喜，
  // 不能因为"收集满了"就把盲盒从这个 App 里摘掉；提示文案在 onRollRarity 里另作区分。
  const target = getRollTargetSeries();
  let pool;
  if (target) {
    pool = availableRarities(target);
  } else {
    const starTarget = getStarTargetSeries();
    pool = starTarget ? upgradableRarities(starTarget) : [];
  }
  return pickRarityByWeight(pool.length ? pool : RARITY_ORDER);
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
 * 隐藏款特效：epic/legendary 撒花 + 震动（rare 保持克制，不放特效）。
 *
 * 【2026-09-16 改】本函数**不再自己弹提示**：提示统一由调用方给出，因为一次开奖
 * 「开奖文案 + 解锁贴纸结果」必须合成一条（两条会互相顶掉，且旧实现里完成待办时
 * 这条提示会覆盖掉带「撤销」按钮的完成提示）。
 *   - 添加待办开奖 → onRollRarity 给出合并提示
 *   - 对方开出揭晓 → handleRarityReveal 给出带归属的提示
 *   - 完成隐藏款 → celebrateCompletion 给出带图鉴进度/撤销的提示
 * @param {string} rarity 'rare'|'epic'|'legendary'
 */
export function celebrateRarity(rarity) {
  if (!isHidden(rarity)) return;
  const meta = RARITY_META[rarity];

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
 * 开出隐藏款时的图鉴动作（添加待办时即触发，无需完成）。
 *
 * 升星期分派（批次 4，D12）：**全部册集齐后，一次开奖只做一件事——升星**，
 * 不再解锁新贴纸（新册收集中时开奖只解锁新册，永不并发）；走 onStarUpgrade。
 * 收集期走下方解锁路径。
 *
 * 序号分配：从「本地已知该档解锁数 + 1」起逐个试到该档上限（4 张）——
 * 撞上已存在的序号就试下一个，全试完即该档已集齐。
 * 为什么不是「数出 next 就直接插」：本地状态可能滞后于数据库（冷启动时 listStickers 还没
 * 回来、或双端同刻开出同一档隐藏款），旧实现此时会撞 UNIQUE 约束、静默返回 null，
 * 那次开奖就白开了 —— 生产库 2026-08-08 有 5 次开奖、之后 8 天一张贴纸都没解锁，无人察觉。
 * 逐个试顺带修好两件事：历史遗留的序号空洞会被补上；「是否集齐」以插入结果为准，
 * 不再依赖可能过期的本地计数。
 *
 * 提示由本函数给出（把「开奖文案 + 解锁结果」合成一条）：两条独立提示会互相顶掉，
 * 旧实现里用户几乎只看得到后发的那条。
 *
 * @param {Object} todo 刚开出的隐藏款 todo 对象（含 id）
 * @param {string} userId 当前用户 id（解锁人）
 * @returns {Promise<Object|null>} 新解锁/升星的贴纸；已集齐或失败则 null
 */
export async function onRollRarity(todo, userId) {
  if (!isHidden(todo.rarity)) return null;
  const rarity = todo.rarity;
  const meta = RARITY_META[rarity];

  // 升星期（批次 4，D12）：全部册集齐后开奖 = 升星，永不与解锁并发。
  // 口径说明：isAllBooksComplete 看本地状态，而本地 ⊆ 数据库（贴纸只增不删，
  // 状态只来自 listStickers / Realtime / 解锁结果）——本地全齐 ⇒ 库里全齐，
  // 不会把该解锁的错升成星。星级本身可能滞后，由 onStarUpgrade 的乐观守卫自愈。
  if (isAllBooksComplete()) {
    return onStarUpgrade(todo, rarity, meta);
  }

  // 解锁目标册 = 当前开启册（与 rollRarity 的抽选池同一来源，两处口径天然一致）。
  // 全部册集齐时回退第一册：循环会逐个试到全满 → 走「全部集齐」兜底提示 + 状态对齐
  // （本地滞后漏了序号时还能借这次机会自愈补上）。
  const series = getRollTargetSeries() || BASE_SERIES;
  const seriesMeta = seriesRarityMeta(series, rarity);

  // 本地已知该册该档解锁数：只当起点，不当结论（可能滞后于数据库）
  const known = getStickers().filter((s) => {
    const p = parseStickerKey(s && s.stickerKey);
    return p && p.series === series && s.rarity === rarity;
  }).length;
  let staleLocal = false;

  for (let n = known + 1; n <= STICKERS_PER_RARITY; n++) {
    const stickerKey = makeStickerKey(series, rarity, n);
    let sticker;
    try {
      sticker = await db.unlockSticker(stickerKey, rarity, userId, todo.id);
    } catch (err) {
      // 解锁失败必须让用户看见：旧实现只 console.warn，界面上毫无痕迹
      console.warn('[blindbox] 解锁贴纸失败:', err.message);
      showToast(`${meta.toast} 图鉴解锁没成功，下次开出同档会自动补上`, rollToastOpts(rarity, null, series));
      return null;
    }
    if (!sticker) { staleLocal = true; continue; } // 该序号已被占用 → 试下一个

    // 本端立即更新图鉴状态（Realtime 也会推回来，addOrUpdateSticker 幂等）
    addOrUpdateSticker(sticker);
    // 撞过已占用的序号 = 本地状态本来就落后于数据库（冷启动/并发开奖）。
    // 只补这一张会让图鉴进度显示出偏小的数字（如 1/12 实际是 2/12），所以拉一次全量对齐。
    if (staleLocal) await syncStickersFromDb();
    const name = seriesMeta.stickerNames[n - 1] || `${meta.label}${n}`;
    showToast(
      `${meta.toast} 解锁「${name}」· ${seriesProgressLabel(series)}`,
      rollToastOpts(rarity, stickerKey)
    );
    return sticker;
  }

  // 该册该档 4 张都已解锁：本次不再产生新贴纸（图鉴不会出现重复条目）。
  // 正常路径走不到这里 —— rollRarity 已把集齐的档位排除在抽选之外；能走到说明本地状态
  // 滞后于数据库，所以顺手对齐一次：否则接下来的开奖还会继续选中这一档、继续白开。
  if (staleLocal) await syncStickersFromDb();
  const bookTag = series === BASE_SERIES ? '' : `「${getSeriesDef(series).title}」`;
  showToast(
    isAllBooksComplete()
      ? `${meta.toast} 全部图鉴已集齐，这张留作纪念 ✨`
      : `${meta.toast} ${bookTag}${meta.label}图鉴已集齐，继续探索其它稀有度吧`,
    rollToastOpts(rarity, null, series)
  );
  return null;
}

/**
 * 升星期的一次开奖（批次 4）：给「升星目标册 + 本次档位」里**最低序号的未满星贴纸** +1 星。
 *
 * 顺延规则（验收「满星顺延」）：候选 = 该册该档未满星贴纸按序号升序——最低序号那张已到
 * 1 星就再 +1（闪卡 → 烫金），到 2 星才轮到下一张。候选列表是本地口径、只当起点：
 * UPDATE 带乐观守卫 `WHERE star_level = <本地期望值>`，0 行更新（对方同刻已升过这颗 /
 * 本地星级滞后）就顺延下一张——与解锁路径的"撞序号自愈"同一思路，以数据库结果为准。
 *
 * @param {Object} todo 刚开出的隐藏款 todo 对象（含 id）
 * @param {string} rarity 本次开出的档位
 * @param {Object} meta 档位元数据（RARITY_META[rarity]，文案用）
 * @returns {Promise<Object|null>} 升星后的贴纸；无可升目标或失败则 null
 */
async function onStarUpgrade(todo, rarity, meta) {
  const series = getStarTargetSeries();
  if (!series) {
    // 终局：全部册集齐且全部满星。升星期的抽选池此时已回落全池，开奖仍是惊喜，
    // 只是没有任何可升目标 —— 与集齐兜底同形态的纪念提示。
    showToast(`${meta.toast} 全部图鉴已满星，这张留作纪念 ✨`, rollToastOpts(rarity, null, BASE_SERIES));
    return null;
  }

  const def = getSeriesDef(series) || {};
  const seriesMeta = seriesRarityMeta(series, rarity);
  // 候选按序号升序；序号从 key 解析（不信任数组顺序），已满星的直接排除
  const candidates = getStickers()
    .filter((s) => {
      const p = parseStickerKey(s && s.stickerKey);
      return p && p.series === series && s.rarity === rarity && (s.starLevel || 0) < MAX_STAR_LEVEL;
    })
    .sort((a, b) => (parseStickerKey(a.stickerKey).index - parseStickerKey(b.stickerKey).index));
  let staleLocal = false;

  for (const candidate of candidates) {
    const expected = candidate.starLevel || 0;
    // 回声去重标记先于 UPDATE 写入（见 lastSelfStarUpgrade 注释）；守卫未过则撤销标记，
    // 不然对方真的升了同一颗时，回声会被误当成自己的
    lastSelfStarUpgrade = { key: candidate.stickerKey, level: expected + 1 };
    let updated;
    try {
      updated = await db.upgradeStickerStar(candidate.id, expected);
    } catch (err) {
      lastSelfStarUpgrade = null;
      // 升星失败必须让用户看见（与解锁失败同口径）
      console.warn('[blindbox] 升星失败:', err.message);
      showToast(`${meta.toast} 升星没成功，下次开出同档会自动补上`, rollToastOpts(rarity, null, series));
      return null;
    }
    if (!updated) {
      lastSelfStarUpgrade = null;
      staleLocal = true;
      continue; // 乐观守卫没过 → 顺延下一张
    }

    // 本端立即更新图鉴状态（Realtime 回声也会推回来，addOrUpdateSticker 幂等）
    addOrUpdateSticker(updated);
    // 守卫失败过 = 本地星级落后于数据库（对方升过），对齐一次再提示，
    // 否则图鉴角标会显示出偏低的星级
    if (staleLocal) await syncStickersFromDb();
    const parsed = parseStickerKey(updated.stickerKey);
    const name = (seriesMeta.stickerNames[(parsed ? parsed.index : 1) - 1]) || `${meta.label}${parsed ? parsed.index : ''}`;
    showToast(
      `${meta.toast} 「${name}」升为${starLabel(updated.starLevel)}！`,
      rollToastOpts(rarity, updated.stickerKey, series)
    );
    celebrateStarUpgrade(updated.starLevel);
    return updated;
  }

  // 该档全部试完都没升成：要么本地滞后（对方已把这些升满），要么该档已满星。
  // 对齐一次（下次开奖不再选中这个满星档），提示按"已满星"兜底 —— 与解锁路径的
  // 「已集齐」兜底同一形态，不应打断这次开奖的惊喜感。
  if (staleLocal) await syncStickersFromDb();
  const bookTag = def.title && series !== BASE_SERIES ? `「${def.title}」` : '';
  showToast(
    `${meta.toast} ${bookTag}${meta.label}款都已满星，这张留作纪念 ✨`,
    rollToastOpts(rarity, null, series)
  );
  return null;
}

/**
 * 升星瞬间动效（D6：先手写）——金色星芒粒子，闪卡一束、烫金两束错时 + 轻震动。
 * 与 celebrateRarity 的档位彩带叠加：彩带来自"开出隐藏款"本身，星芒是升星专属反馈。
 */
function celebrateStarUpgrade(level) {
  if (!isFxEnabled()) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#fbbf24', '#fcd34d', '#fde68a', '#fff7ed'];
  const origin = { y: 0.55 };
  confetti({ particleCount: 20, spread: 65, startVelocity: 30, ticks: 200, colors, origin, scalar: 0.9, shapes: ['star'] });
  if (level >= MAX_STAR_LEVEL) {
    setTimeout(() => confetti({ particleCount: 26, spread: 85, startVelocity: 36, ticks: 240, colors, origin, scalar: 1.05, shapes: ['star'] }), 150);
  }
  if (navigator.vibrate) {
    try { navigator.vibrate([25, 20, 25]); } catch (_) {}
  }
}

/**
 * 拉全量图鉴对齐本地状态。
 * 失败只告警不抛：本地状态滞后是"下次开奖再补"的问题，不该打断这次开奖的提示。
 */
async function syncStickersFromDb() {
  try {
    setStickers(await db.listStickers());
  } catch (err) {
    console.warn('[blindbox] 对齐图鉴失败（已忽略）:', err.message);
  }
}

/**
 * 开奖提示的样式：稀有度配色 + 图标（解锁时用该张贴纸的图标；未解锁时用
 * 目标册该档首张的图标——多册后兜底图标也必须取对册，不能永远拿第一册的）。
 */
function rollToastOpts(rarity, stickerKey, series = BASE_SERIES) {
  const meta = RARITY_META[rarity];
  const fallbackKey = makeStickerKey(series, rarity, 1);
  return {
    variant: 'rarity',
    accent: meta.colors[0],
    icon: stickerKey ? getStickerIcon(stickerKey) : getStickerIcon(fallbackKey),
  };
}
