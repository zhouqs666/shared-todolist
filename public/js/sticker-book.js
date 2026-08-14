/**
 * 收集图鉴（贴纸本）UI
 *
 * 两人共享一本图鉴。顶栏入口图标 + 红点（有未看的解锁时亮）。
 * 点开是弹层：12 格网格，已解锁显示彩色贴纸 + 名称，未解锁灰显 + ❓。
 * 底部进度条「已收集 X/12」，集齐时弹一次性庆祝彩蛋。
 *
 * 全集定义从 blindbox.js 的 RARITY_META 派生（保持单一真相）。
 *
 * 红点逻辑（问题3修复）：按 stickerKey 记录"已看"，持久化到 localStorage。
 *   - 有贴纸的 key 不在已看集合里 → 亮红点
 *   - 打开图鉴 → 当前所有 key 标记已看 → 红点消失
 *   - 对方解锁新贴纸 → 新 key 不在已看集合 → 红点又亮
 */

import { getStickers, setStickersRenderFn } from './state.js';
import { RARITY_META, STICKERS_PER_RARITY, getStickerIcon } from './blindbox.js';
import { showToast } from './toast.js';
import { db } from './db.js';
import { setStickers } from './state.js';

const TOTAL_STICKERS = STICKERS_PER_RARITY * 3; // 12 张
// 图鉴展示顺序：rare → epic → legendary（由低到高）
const RARITY_ORDER = ['rare', 'epic', 'legendary'];

// localStorage key：存已看过的 stickerKey 集合（JSON 数组）
const SEEN_KEY = 'seenStickerKeys';

// 是否已弹过集齐全集彩蛋（防止重复，内存态，本次会话一次）
let collectedCelebrated = false;

/** 读取已看过的 stickerKey 集合 */
function getSeenKeys() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

/** 把指定 stickerKey 列表写入已看集合 */
function markKeysSeen(keys) {
  if (!keys || keys.length === 0) return;
  const seen = getSeenKeys();
  for (const k of keys) seen.add(k);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch { /* ignore */ }
}

/**
 * 生成图鉴全集（12 张的元信息），标记每张是否已解锁。
 * @returns {Array<{key,rarity,name,unlocked,unlockedAt}>}
 */
function buildFullBook() {
  const unlocked = getStickers();
  const byKey = new Map(unlocked.map((s) => [s.stickerKey, s]));
  const all = [];
  for (const rarity of RARITY_ORDER) {
    const meta = RARITY_META[rarity];
    for (let i = 1; i <= STICKERS_PER_RARITY; i++) {
      const key = `${rarity}_${i}`;
      const s = byKey.get(key);
      all.push({
        key,
        rarity,
        name: meta.stickerNames[i - 1] || `${meta.label}${i}`,
        unlocked: !!s,
        unlockedAt: s ? s.unlockedAt : null,
      });
    }
  }
  return all;
}

/**
 * 渲染图鉴弹层内容（网格 + 进度）。
 * 幂等：每次根据当前 stickers 全量重绘。
 */
function renderStickerBook() {
  const grid = document.getElementById('stickerGrid');
  const progressEl = document.getElementById('stickerProgress');
  const barEl = document.getElementById('stickerProgressBar');
  if (!grid) return;

  const all = buildFullBook();
  const unlockedCount = all.filter((s) => s.unlocked).length;

  // 用 DocumentFragment 全量重绘（图鉴格子少，12 个，无需增量）
  const frag = document.createDocumentFragment();
  for (const s of all) {
    const cell = document.createElement('div');
    cell.className = 'sticker-cell' + (s.unlocked ? ` sticker-cell--unlocked sticker-cell--${s.rarity}` : '');
    cell.setAttribute('aria-label', s.unlocked ? `已解锁：${s.name}（${RARITY_META[s.rarity].label}）` : `未解锁：${RARITY_META[s.rarity].label}贴纸`);

    const icon = document.createElement('span');
    icon.className = 'sticker-cell__icon';
    icon.innerHTML = s.unlocked ? getStickerIcon(s.key) : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 9a2.5 2.5 0 1 1 5 0v.5h-5V9z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 9.5a6 6 0 0 1 12 0v7a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    cell.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'sticker-cell__name';
    name.textContent = s.unlocked ? s.name : '???';
    cell.appendChild(name);

    frag.appendChild(cell);
  }
  grid.innerHTML = '';
  grid.appendChild(frag);

  // 进度
  if (progressEl) progressEl.textContent = `${unlockedCount} / ${TOTAL_STICKERS}`;
  if (barEl) barEl.style.width = `${(unlockedCount / TOTAL_STICKERS) * 100}%`;

  // 集齐彩蛋（一次性）
  if (unlockedCount === TOTAL_STICKERS && !collectedCelebrated) {
    collectedCelebrated = true;
    showToast('🎉 恭喜！图鉴已全部集齐！');
  }
}

/**
 * 打开图鉴弹层。
 * 问题2修复：每次打开都主动从数据库拉取最新 stickers（不依赖 Realtime 是否生效），
 * 拉完再渲染——保证打开图鉴总能看到最新解锁的贴纸。
 * 同时把当前所有贴纸标记为已看 → 清红点。
 */
async function openStickerBook() {
  const modal = document.getElementById('stickerModal');
  if (!modal) return;
  // 先显示弹层（渲染期间用户能看到加载态）
  modal.classList.remove('hidden');
  // 主动拉取最新数据（容错：失败则用本地缓存）
  try {
    const stickers = await db.listStickers();
    setStickers(stickers);
  } catch (err) {
    console.warn('[sticker-book] 拉取图鉴失败（用本地缓存）:', err.message);
  }
  // 渲染（用最新数据）
  renderStickerBook();
  // 打开即视为已看：把当前所有 stickerKey 标记已看 → 清红点
  markKeysSeen(getStickers().map((s) => s.stickerKey));
  updateBadge();
}

/** 关闭图鉴弹层 */
function closeStickerBook() {
  const modal = document.getElementById('stickerModal');
  if (!modal) return;
  modal.classList.add('hidden');
}

/**
 * 更新顶栏红点。
 * 红点逻辑（问题3修复）：有贴纸的 key 不在已看集合里 → 亮红点。
 *   - 打开过图鉴 → 所有当前 key 已标记已看 → 无红点
 *   - 之后对方解锁新贴纸 → 新 key 不在已看集合 → 红点又亮
 */
function updateBadge() {
  const badge = document.getElementById('stickerBadge');
  if (!badge) return;
  const seen = getSeenKeys();
  const hasUnseen = getStickers().some((s) => !seen.has(s.stickerKey));
  if (hasUnseen) {
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

/**
 * 初始化图鉴模块：
 *   - 绑定顶栏入口按钮点击
 *   - 绑定弹层关闭（遮罩点击 + 关闭按钮）
 *   - 注册 state 渲染回调（stickers 变化时刷新红点；弹层打开时刷新网格）
 * @param {Object} opts
 * @param {(sticker)=>void} [opts.onStickerUnlockedView] 每次解锁时的额外 UI 反馈（由 app.js 注入，如撒花）
 */
export function initStickerBook(opts = {}) {
  opts_onUnlock = opts.onStickerUnlockedView || null;

  const entryBtn = document.getElementById('stickerEntry');
  if (entryBtn) {
    entryBtn.addEventListener('click', openStickerBook);
  }
  const closeBtn = document.getElementById('stickerModalClose');
  if (closeBtn) closeBtn.addEventListener('click', closeStickerBook);
  // 点击遮罩（弹层背景）关闭
  const modal = document.getElementById('stickerModal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeStickerBook();
    });
  }

  // 注册渲染回调：stickers 变化时更新红点 + 若弹层开着则刷新网格
  setStickersRenderFn(() => {
    updateBadge();
    const modal = document.getElementById('stickerModal');
    if (modal && !modal.classList.contains('hidden')) {
      renderStickerBook();
    }
  });

  // 初始红点
  updateBadge();
}

/** 供 app.js 在 Realtime onStickerUnlocked 时调用，触发红点 + 可选撒花 */
export function handleStickerUnlocked(sticker) {
  updateBadge();
  if (opts_onUnlock) opts_onUnlock(sticker);
}
// 存 initStickerBook 传入的解锁回调
let opts_onUnlock = null;
