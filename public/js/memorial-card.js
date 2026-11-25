/**
 * 集齐纪念卡（图鉴路线批次 1 · docs/sticker-book-roadmap.md §4）
 *
 * 某册 12/12 集齐时刻的全屏卡片仪式（替代 / 扩展原有的一次性撒花），
 * 之后可从图鉴金色完成态面板**重复查看**（不是一次性的）。
 *
 * 数据全部现成、零数据库变更：
 *   - 12 张贴纸 + 各自解锁日期 → 上层传入（sticker-book 的 buildFullBook，源 stickers.unlocked_at）
 *   - 起止日期                → 由传入贴纸的 unlocked_at 取 min / max
 *   - 隐藏款开出总数          → db.countHiddenReveals()（todos.rarity 计数，软删行也计入，语义是"开出过"）
 *
 * 按册复用：showMemorialCard(book) 只吃数据，不关心册的 key 形态——
 * 批次 3「我们的故事」册集齐时传入自己的册数据，就能得到自己的那张卡。
 *
 * 动效约束（D6 / 铁律无关但路线图硬约束）：入场为手写 CSS 动画；
 * prefers-reduced-motion 下由 CSS 禁用；撒花遵循特效开关 + reduced-motion 双闸。
 */

import confetti from './vendor/canvas-confetti.esm.min.js';
import { isFxEnabled } from './theme.js';
import { db } from './db.js';
import { RARITY_META, getStickerIcon } from './blindbox.js';

/** 解锁时间 → 「M月d日」；无效时间返回空串 */
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 起止日期行：`6月3日 — 8月21日 · 共 80 天`（含首尾两天）。
 * 全部同一天时显示 `6月3日 · 12 张集于同一天`。拿不到日期返回空串（行整体隐藏）。
 */
function formatRange(stickers) {
  const times = stickers
    .map((s) => (s.unlockedAt ? new Date(s.unlockedAt).getTime() : NaN))
    .filter((t) => !Number.isNaN(t));
  if (!times.length) return '';
  const min = new Date(Math.min(...times));
  const max = new Date(Math.max(...times));
  const fmt = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;
  if (min.toDateString() === max.toDateString()) {
    return `${fmt(min)} · ${stickers.length} 张集于同一天`;
  }
  const days = Math.round((max - min) / 86400000) + 1;
  return `${fmt(min)} — ${fmt(max)} · 共 ${days} 天`;
}

/** 12 张拼贴：贴纸底板 + 图案 + 名称 + 解锁日期，依次浮现 */
function renderGrid(container, stickers) {
  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  stickers.forEach((s, idx) => {
    const cell = document.createElement('div');
    cell.className = `memorial-card__cell memorial-card__cell--${s.rarity}`;
    cell.style.animationDelay = `${idx * 35}ms`;
    cell.setAttribute('aria-label', `${s.name}（${RARITY_META[s.rarity].label}），${formatDate(s.unlockedAt)}解锁`);

    const plate = document.createElement('span');
    plate.className = 'memorial-card__plate';
    const icon = document.createElement('span');
    icon.className = 'memorial-card__icon';
    icon.innerHTML = getStickerIcon(s.key);
    plate.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'memorial-card__name';
    name.textContent = s.name;

    const date = document.createElement('span');
    date.className = 'memorial-card__date';
    date.textContent = formatDate(s.unlockedAt);

    cell.append(plate, name, date);
    frag.appendChild(cell);
  });
  container.appendChild(frag);
}

/** 金色彩带（仅首次集齐仪式）：沿用集齐庆祝的金色系配色，左右两发 + 顶中一束 */
function fireCeremonyConfetti() {
  if (!isFxEnabled()) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const gold = RARITY_META.legendary.confettiColors;
  const base = { spread: 60, ticks: 90, gravity: 0.9, scalar: 0.9, colors: gold, zIndex: 1200 };
  confetti({ ...base, particleCount: 40, origin: { x: 0.15, y: 0.7 }, angle: 60 });
  confetti({ ...base, particleCount: 40, origin: { x: 0.85, y: 0.7 }, angle: 120 });
  confetti({ ...base, particleCount: 50, spread: 100, ticks: 120, origin: { x: 0.5, y: 0.35 }, scalar: 1.1 });
}

/**
 * 打开集齐纪念卡（幂等：每次按传入数据全量重绘）。
 * @param {Object} book 册数据
 * @param {string} [book.title] 卡片标题（缺省用「N 张贴纸全部集齐」）
 * @param {Array<{key,rarity,name,unlocked,unlockedAt}>} book.stickers 全册贴纸（只取已解锁）
 * @param {Object} [opts]
 * @param {boolean} [opts.celebrate] 是否为集齐仪式（金色彩带）；重看入口不传 = 安静翻看
 */
export function showMemorialCard(book, opts = {}) {
  const modal = document.getElementById('memorialCard');
  if (!modal || !book || !Array.isArray(book.stickers)) return;
  const unlocked = book.stickers.filter((s) => s.unlocked);
  if (!unlocked.length) return;

  const titleEl = document.getElementById('memorialCardTitle');
  if (titleEl) titleEl.textContent = book.title || `${unlocked.length} 张贴纸全部集齐`;
  const datesEl = document.getElementById('memorialCardDates');
  if (datesEl) {
    datesEl.textContent = formatRange(unlocked);
    datesEl.classList.toggle('hidden', !datesEl.textContent);
  }
  const gridEl = document.getElementById('memorialCardGrid');
  if (gridEl) renderGrid(gridEl, unlocked);

  // 隐藏款开出总数：异步填充（查询失败就空着——宁缺毋错，不阻塞卡片展示）
  const statsEl = document.getElementById('memorialCardStats');
  if (statsEl) {
    statsEl.textContent = '';
    db.countHiddenReveals()
      .then((n) => {
        if (modal.classList.contains('hidden')) return;
        statsEl.textContent = n > 0 ? `这些日子，一起开出了 ${n} 次隐藏款` : '';
      })
      .catch((err) => console.warn('[memorial-card] 隐藏款计数失败（已留空）:', err.message));
  }

  modal.classList.remove('hidden');
  if (opts.celebrate) fireCeremonyConfetti();
}

/**
 * 关闭纪念卡（遮罩点击 / 关闭按钮 / ESC 共用）
 *
 * ⚠️ 2026-11-25 真机闪屏事故的关键清理点：canvas-confetti 用的是**模块级全局画布**，
 * 第一次调用时 append 到 document.body，之后**永远不会自己移除**（只有显式调
 * confetti.reset() 才会 removeChild）。于是纪念卡播完后，body 里永久留下一块
 * 全屏 `position:fixed; width:100%; height:100%` 的画布层 —— 它压在 App 内容之上、
 * 位于图鉴弹层(1000)与复看卡遮罩(1200)之下，给真机的合成器多加一层全屏合成面。
 *
 * 而「集齐庆祝」的标记存在 localStorage，**bundle 切换（热更）时 localStorage 不共享**
 * （见 update.js 的说明）⇒ 每次热更后第一次开图鉴都会重播纪念卡 ⇒ 每次都重新埋雷。
 * 这解释了「只有生产环境闪」：切测试环境会 location.reload()，整页重载把残留全清掉。
 *
 * ⇒ 关闭时必须 reset 掉全局画布，不能只把弹层藏起来。
 */
function hideMemorialCard() {
  const modal = document.getElementById('memorialCard');
  if (modal) modal.classList.add('hidden');
  // 清掉 canvas-confetti 的全局画布（否则永久留在 body 里）
  try { confetti.reset(); } catch (_e) { /* ignore */ }
}

/**
 * 初始化纪念卡弹层（绑定关闭交互；由 initStickerBook 调用，一次即可）。
 * 注意 ESC 顺序：图鉴弹层的 ESC 监听注册在先、已做「纪念卡开着时不关图鉴」守卫，
 * 这里注册在后，负责关掉纪念卡自己。
 */
export function initMemorialCard() {
  const modal = document.getElementById('memorialCard');
  if (!modal) return;
  const closeBtn = document.getElementById('memorialCardClose');
  if (closeBtn) closeBtn.addEventListener('click', hideMemorialCard);
  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.classList.contains('memorial-card__scrim')) hideMemorialCard();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!modal.classList.contains('hidden')) hideMemorialCard();
  });
}
