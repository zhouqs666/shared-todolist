/**
 * 收集图鉴（贴纸本）UI
 *
 * 两人共享一本图鉴。顶栏入口图标 + 红点（有未看的解锁时亮）。
 * 点开是弹层：12 格网格，按稀有/史诗/传说三档分区。
 *   - 已解锁：白色贴纸底板 + 彩色贴纸 + 名称 + 解锁日期，点击弹专属短句
 *   - 未解锁：本尊图案的灰色剪影（雾显悬念）+ "???"
 * 顶部有分档图例（稀有 x/4 · 史诗 x/4 · 传说 x/4），底部进度条，
 * 集齐时面板进入金色完成态并庆祝一次。
 *
 * 全集定义从 blindbox.js 的 RARITY_META 派生（保持单一真相）。
 *
 * 红点 / "新"标记逻辑：
 *   - 已看集合存 localStorage（按 stickerKey）
 *   - 打开图鉴时快照当前已看集合 → 未在快照中的贴纸显示"新"角标
 *   - 关闭图鉴时才把当前所有 key 标记已看 → 红点消失
 *   - 对方解锁新贴纸 → 新 key 不在已看集合 → 红点又亮
 *
 * 可点击性引导（轻晃演示，克制版）：
 *   已解锁贴纸可点出专属短句，但触屏上没有 hover/pointer 线索，用户发现不了。
 *   只教不纠缠：仅当用户从未点过任何贴纸（localStorage: stickerTapEver）且
 *   演示展示次数未达上限（stickerWiggleOpens < 3）时，打开图鉴约 1.2s 后
 *   第一张已解锁贴纸轻晃一次做"可以戳"的暗示；点过任意一张后永久退场。
 *   全程零文案、零新 UI 元素；prefers-reduced-motion 下由 CSS 禁用动画。
 */

import confetti from './vendor/canvas-confetti.esm.min.js';
import { isFxEnabled } from './theme.js';
import { getStickers, setStickersRenderFn } from './state.js';
import { RARITY_META, STICKERS_PER_RARITY, getStickerIcon, getStickerFlavor } from './blindbox.js';
import { showToast } from './toast.js';
import { db } from './db.js';
import { setStickers } from './state.js';

const TOTAL_STICKERS = STICKERS_PER_RARITY * 3; // 12 张
// 图鉴展示顺序：rare → epic → legendary（由低到高）
const RARITY_ORDER = ['rare', 'epic', 'legendary'];

// localStorage key：存已看过的 stickerKey 集合（JSON 数组）
const SEEN_KEY = 'seenStickerKeys';
// localStorage key：集齐庆祝是否已弹过（持久化，避免每次冷启动重弹；
// 图鉴重新变得不完整时自动清除，下次再集齐会重新庆祝）
const CELEBRATED_KEY = 'stickerBookCelebrated';
// localStorage key：轻晃演示的持久化——
//   TAP_EVER_KEY：用户点过任意贴纸 → 演示永久退场
//   WIGGLE_OPENS_KEY：演示已展示的打开次数（达 WIGGLE_MAX_OPENS 后不再出现）
const TAP_EVER_KEY = 'stickerTapEver';
const WIGGLE_OPENS_KEY = 'stickerWiggleOpens';
const WIGGLE_MAX_OPENS = 3;

// 是否已庆祝过集齐全集（从持久化恢复；清空重集后会重新庆祝）
let collectedCelebrated = (() => {
  try {
    return localStorage.getItem(CELEBRATED_KEY) === '1';
  } catch {
    return false;
  }
})();

// 打开图鉴那一刻的"已看"快照：用于判定哪些贴纸对用户是"新"的
let seenSnapshot = null;

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

/** 解锁时间 → 「M月d日」；无效时间返回空串 */
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
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

/** 渲染分档图例：稀有 x/4 · 史诗 x/4 · 传说 x/4（集满的档打勾） */
function renderLegend(all) {
  const legendEl = document.getElementById('stickerLegend');
  if (!legendEl) return;
  const frag = document.createDocumentFragment();
  for (const rarity of RARITY_ORDER) {
    const total = STICKERS_PER_RARITY;
    const count = all.filter((s) => s.rarity === rarity && s.unlocked).length;
    const done = count === total;
    const chip = document.createElement('span');
    chip.className = 'sticker-legend__chip'
      + ` sticker-legend__chip--${rarity}`
      + (done ? ' sticker-legend__chip--done' : '');
    const dot = document.createElement('i');
    dot.className = 'sticker-legend__dot';
    dot.setAttribute('aria-hidden', 'true');
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(`${RARITY_META[rarity].label} ${count}/${total}${done ? ' ✓' : ''}`));
    frag.appendChild(chip);
  }
  legendEl.innerHTML = '';
  legendEl.appendChild(frag);
}

/** 按收集进度切换提示文案（空状态引导 / 接近集齐 / 已集齐 / 默认） */
function updateHint(unlockedCount) {
  const hintEl = document.getElementById('stickerHint');
  if (!hintEl) return;
  let text;
  if (unlockedCount === 0) {
    text = '每添加一条待办，都有小概率开出隐藏款——和 ta 集满这 12 张吧';
  } else if (unlockedCount === TOTAL_STICKERS) {
    text = '12 张全部集齐，这是属于你们的专属纪念 ✨';
  } else if (unlockedCount >= TOTAL_STICKERS - 2) {
    text = `就差 ${TOTAL_STICKERS - unlockedCount} 张就集齐啦，加油～`;
  } else {
    text = '小概率出现隐藏款待办，解锁专属贴纸～';
  }
  hintEl.textContent = text;
}

/** 集齐庆祝：金色彩带（左右两发）+ 提示。特效开关关闭时只弹提示。 */
function celebrateComplete() {
  showToast('🎉 恭喜！图鉴已全部集齐！');
  if (!isFxEnabled()) return;
  const gold = RARITY_META.legendary.confettiColors;
  const base = { spread: 60, ticks: 90, gravity: 0.9, scalar: 0.9, colors: gold };
  confetti({ ...base, particleCount: 40, origin: { x: 0.15, y: 0.7 }, angle: 60 });
  confetti({ ...base, particleCount: 40, origin: { x: 0.85, y: 0.7 }, angle: 120 });
}

/**
 * 渲染图鉴弹层内容（图例 + 网格 + 提示 + 进度 + 集齐状态）。
 * 幂等：每次根据当前 stickers 全量重绘。
 * @param {Object} [opts]
 * @param {boolean} [opts.animate] 是否带格子入场节奏（打开弹层时用；实时刷新时不重放）
 */
export function renderStickerBook(opts = {}) {
  const { animate = false } = opts;
  const grid = document.getElementById('stickerGrid');
  const progressEl = document.getElementById('stickerProgress');
  const barEl = document.getElementById('stickerProgressBar');
  const panelEl = document.querySelector('#stickerModal .sticker-modal__panel');
  const chipEl = document.getElementById('stickerCompleteChip');
  if (!grid) return;

  const all = buildFullBook();
  const unlockedCount = all.filter((s) => s.unlocked).length;
  const isNewOf = seenSnapshot ? (key) => !seenSnapshot.has(key) : () => false;

  // 格子：已解锁 = 白底板 + 彩色贴纸 + 名称 + 日期（+ 新角标）；
  //       未解锁 = 本尊图案的灰色剪影（雾显悬念）+ ???
  const frag = document.createDocumentFragment();
  all.forEach((s, idx) => {
    const meta = RARITY_META[s.rarity];
    const cell = document.createElement('div');
    cell.className = 'sticker-cell'
      + (s.unlocked ? ` sticker-cell--unlocked sticker-cell--${s.rarity}` : '')
      + (animate ? ' sticker-cell--in' : '');
    if (animate) cell.style.animationDelay = `${idx * 35}ms`;
    cell.setAttribute('aria-label', s.unlocked
      ? `已解锁：${s.name}（${meta.label}${formatDate(s.unlockedAt) ? '，' + formatDate(s.unlockedAt) : ''}）`
      : `未解锁：${meta.label}贴纸`);

    if (s.unlocked) {
      // 可点击查看专属短句
      cell.setAttribute('role', 'button');
      cell.setAttribute('tabindex', '0');
      cell.dataset.key = s.key;

      const plate = document.createElement('span');
      plate.className = 'sticker-cell__plate';
      const icon = document.createElement('span');
      icon.className = 'sticker-cell__icon';
      icon.innerHTML = getStickerIcon(s.key);
      plate.appendChild(icon);
      cell.appendChild(plate);

      if (isNewOf(s.key)) {
        const fresh = document.createElement('span');
        fresh.className = 'sticker-cell__new';
        fresh.textContent = '新';
        cell.appendChild(fresh);
      }
    } else {
      const icon = document.createElement('span');
      icon.className = 'sticker-cell__icon sticker-cell__icon--silhouette';
      icon.innerHTML = getStickerIcon(s.key);
      cell.appendChild(icon);
    }

    const name = document.createElement('span');
    name.className = 'sticker-cell__name';
    name.textContent = s.unlocked ? s.name : '???';
    cell.appendChild(name);

    frag.appendChild(cell);
  });
  grid.innerHTML = '';
  grid.appendChild(frag);

  // 图例 / 提示 / 进度
  renderLegend(all);
  updateHint(unlockedCount);
  if (progressEl) progressEl.textContent = `${unlockedCount} / ${TOTAL_STICKERS}`;
  if (barEl) {
    barEl.style.width = `${(unlockedCount / TOTAL_STICKERS) * 100}%`;
    barEl.classList.toggle('sticker-modal__progress-fill--complete', unlockedCount === TOTAL_STICKERS);
  }

  // 集齐状态：面板金色完成态 + 徽章
  const complete = unlockedCount === TOTAL_STICKERS;
  if (panelEl) panelEl.classList.toggle('sticker-modal__panel--complete', complete);
  if (chipEl) chipEl.classList.toggle('hidden', !complete);

  // 集齐庆祝：持久化标记，只在真正"集齐那一刻"庆祝一次；
  // 图鉴重新变得不完整（如清理测试数据）时清除标记，下次集齐重新庆祝
  if (complete && !collectedCelebrated) {
    collectedCelebrated = true;
    try { localStorage.setItem(CELEBRATED_KEY, '1'); } catch { /* ignore */ }
    celebrateComplete();
  } else if (!complete && collectedCelebrated) {
    collectedCelebrated = false;
    try { localStorage.removeItem(CELEBRATED_KEY); } catch { /* ignore */ }
  }
}

/** 格子点击/回车：弹跳 + 专属短句（事件委托，绑定一次） */
function bindGridInteraction() {
  const grid = document.getElementById('stickerGrid');
  if (!grid) return;
  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.sticker-cell--unlocked');
    if (!cell || !grid.contains(cell)) return;
    revealFlavor(cell);
  });
  grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const cell = e.target.closest('.sticker-cell--unlocked');
    if (!cell || !grid.contains(cell)) return;
    e.preventDefault();
    revealFlavor(cell);
  });
}

/**
 * "贴纸可以戳"的轻晃演示：触屏上没有 hover 线索，靠"会动"暗示可点。
 * 触发条件（同时满足）：本次打开有已解锁贴纸 + 用户从未点过任何贴纸 + 展示次数未达上限。
 * 时机：入场动画（首格 ≈0.38s）播完后约 1.2s，轻晃一次即摘掉类。
 * 每次打开最多演示一次；点过任意贴纸后永久退场。
 */
function maybePlayWiggleAffordance() {
  let everTapped = false;
  try { everTapped = localStorage.getItem(TAP_EVER_KEY) === '1'; } catch { /* ignore */ }
  if (everTapped) return;

  const grid = document.getElementById('stickerGrid');
  const modal = document.getElementById('stickerModal');
  const firstUnlocked = grid ? grid.querySelector('.sticker-cell--unlocked') : null;
  if (!firstUnlocked || !modal || modal.classList.contains('hidden')) return;

  let opensShown = 0;
  try { opensShown = parseInt(localStorage.getItem(WIGGLE_OPENS_KEY) || '0', 10) || 0; } catch { /* ignore */ }
  if (opensShown >= WIGGLE_MAX_OPENS) return;
  try { localStorage.setItem(WIGGLE_OPENS_KEY, String(opensShown + 1)); } catch { /* ignore */ }

  setTimeout(() => {
    // 等待期间弹层被关掉 / 网格被实时刷新重绘 → 跳过这次演示
    if (!modal || modal.classList.contains('hidden')) return;
    if (!grid.contains(firstUnlocked)) return;
    firstUnlocked.classList.add('sticker-cell--wiggle');
    setTimeout(() => firstUnlocked.classList.remove('sticker-cell--wiggle'), 800);
  }, 1200);
}

/** 弹跳动画 + 弹出「贴纸故事卡」（弹层内展示，不再走全局 Toast——会被弹层遮挡） */
let flavorTimer = null;
function revealFlavor(cell) {
  // 用户戳了贴纸 → 轻晃演示永久退场（学会即不再出现）
  try { localStorage.setItem(TAP_EVER_KEY, '1'); } catch { /* ignore */ }

  cell.classList.remove('sticker-cell--pop', 'sticker-cell--wiggle');
  // 强制 reflow，保证连续点击也能重放动画
  void cell.offsetWidth;
  cell.classList.add('sticker-cell--pop');

  const key = cell.dataset.key || '';
  const flavor = getStickerFlavor(key);
  const card = document.getElementById('stickerFlavor');
  if (!flavor || !card) return;

  const match = /^(rare|epic|legendary)_(\d+)$/.exec(key);
  if (!match) return;
  const meta = RARITY_META[match[1]];
  const name = meta.stickerNames[parseInt(match[2], 10) - 1] || meta.label;
  const sticker = getStickers().find((s) => s.stickerKey === key);
  const date = sticker ? formatDate(sticker.unlockedAt) : '';

  card.className = 'sticker-modal__flavor sticker-modal__flavor--' + match[1];
  card.innerHTML = '';

  const icon = document.createElement('span');
  icon.className = 'sticker-modal__flavor-icon';
  icon.innerHTML = getStickerIcon(key);
  card.appendChild(icon);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'sticker-modal__flavor-body';
  const title = document.createElement('div');
  title.className = 'sticker-modal__flavor-title';
  title.textContent = `${name} · ${meta.label}${date ? ` · ${date}解锁` : ''}`;
  const text = document.createElement('div');
  text.className = 'sticker-modal__flavor-text';
  text.textContent = flavor;
  bodyEl.appendChild(title);
  bodyEl.appendChild(text);
  card.appendChild(bodyEl);

  // 下一帧加 show 类，保证过渡动画每次都能重放
  requestAnimationFrame(() => card.classList.add('sticker-modal__flavor--show'));
  clearTimeout(flavorTimer);
  flavorTimer = setTimeout(hideFlavorCard, 3200);
}

/** 隐藏贴纸故事卡 */
function hideFlavorCard() {
  clearTimeout(flavorTimer);
  const card = document.getElementById('stickerFlavor');
  if (card) card.classList.remove('sticker-modal__flavor--show');
}

/**
 * 打开图鉴弹层。
 * 每次打开都主动从数据库拉取最新 stickers（不依赖 Realtime 是否生效），
 * 拉完再渲染——保证打开图鉴总能看到最新解锁的贴纸。
 * 同时快照当前已看集合（用于"新"角标）；红点在关闭时清除。
 */
async function openStickerBook() {
  const modal = document.getElementById('stickerModal');
  if (!modal) return;
  // 快照打开前的已看集合：快照里没有的 = 这次要看的新贴纸
  seenSnapshot = getSeenKeys();
  // 先显示弹层（渲染期间用户能看到加载态）
  modal.classList.remove('hidden');
  // 锁背景滚动（与其他弹层一致）
  document.body.style.overflow = 'hidden';
  // 主动拉取最新数据（容错：失败则用本地缓存）
  try {
    const stickers = await db.listStickers();
    setStickers(stickers);
  } catch (err) {
    console.warn('[sticker-book] 拉取图鉴失败（用本地缓存）:', err.message);
  }
  // 渲染（用最新数据 + 入场节奏）
  renderStickerBook({ animate: true });
  // "贴纸可以戳"的轻晃演示（从未点过贴纸的用户才触发，详见函数注释）
  maybePlayWiggleAffordance();
}

/** 关闭图鉴弹层。此刻才把当前所有贴纸标记为已看 → 清红点。 */
export function closeStickerBook() {
  const modal = document.getElementById('stickerModal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  hideFlavorCard();
  document.body.style.overflow = '';
  markKeysSeen(getStickers().map((s) => s.stickerKey));
  updateBadge();
}

/**
 * 更新顶栏红点。
 * 红点逻辑：有贴纸的 key 不在已看集合里 → 亮红点。
 *   - 关闭过图鉴 → 所有当前 key 已标记已看 → 无红点
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
  // ESC 关闭（与其他弹层一致的键盘出口）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const m = document.getElementById('stickerModal');
    if (m && !m.classList.contains('hidden')) closeStickerBook();
  });

  bindGridInteraction();

  // 注册渲染回调：stickers 变化时更新红点 + 若弹层开着则刷新网格（不重放入场动画）
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
