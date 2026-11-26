/**
 * 收集图鉴（贴纸本）UI
 *
 * 两人共享一本图鉴。顶栏入口图标 + 红点（有未看的解锁时亮）。
 * 点开是弹层：**多册书架结构**（2026-10-04 批次 2 起）——
 *   - 按册渲染：当前只注册第一册 v1（sticker_key 无前缀），渲染行为与多册前一致；
 *     册 tab 栏仅当已注册册数 > 1 时出现（批次 3 「我们的故事」册上线后自动出现）
 *   - key 解析/构造统一走 blindbox.js 的 parseStickerKey / makeStickerKey
 *     （docs/sticker-book-roadmap.md §5.1 语义前缀方案）
 * 每册 12 格网格，按稀有/史诗/传说三档分区：
 *   - 已解锁：白色贴纸底板 + 彩色贴纸 + 名称 + 解锁日期，点击弹「开出卡片」复看
 *     （D7-③，2026-10-05 批次 3——第一册 12 张有点开即展示的专属内容卡；无专属卡的
 *      key（第二册，批次 4 前）回落原「专属短句」故事卡）
 *   - 未解锁：本尊图案的灰色剪影（雾显悬念）+ "???"
 * 顶部有分档图例（稀有 x/4 · 史诗 x/4 · 传说 x/4），底部进度条，
 * 集齐时该册面板进入金色完成态，并弹出全屏「集齐纪念卡」仪式（可从完成态重复查看，
 * 见 memorial-card.js）。
 *
 * 全集定义从 blindbox.js 的 RARITY_META 派生（保持单一真相）。
 *
 * 红点 / "新"标记逻辑（已看集合按 key 存储，前缀天然区分各册）：
 *   - 已看集合存 localStorage（按 stickerKey）
 *   - 打开图鉴时快照当前已看集合 → 未在快照中的贴纸显示"新"角标
 *   - 关闭图鉴时只把**当前激活册**的 key 标记已看 → 红点消失
 *     （多册时不会误清别册的新贴纸；单册期与全量标记等价）
 *   - 对方解锁新贴纸 → 新 key 不在已看集合 → 红点又亮（任一册有未看即亮）
 *   - 【批次 3，D7-②】红点信号并入「对方开出的隐藏款待查看队列」
 *     （rarity_seen=false 且非本人创建，setPendingReveals/addPendingReveal）：
 *     点图鉴入口先逐张弹通知卡，看完回标 rarity_seen + 标记贴纸已看（一个动作清两个信号）
 *
 * 可点击性提示（常驻微文案，2026-10-07 起替代上线一天的轻晃演示）：
 *   已解锁贴纸可点出「复看卡」，但触屏上没有 hover/pointer 线索。轻晃演示按"学会即
 *   退场"设计，退场后书架重新变回零线索——业主拍板改为常驻兜底：进度条下一行
 *   11px 微文案「戳戳贴纸，重温开出那天 ✨」，该册有已解锁贴纸才显示
 *   （0 张时无可点对象；切换见 renderStickerBook / #stickerTapHint）。
 */

import { getStickers, setStickersRenderFn } from './state.js';
import {
  RARITY_META, STICKERS_PER_RARITY, getStickerIcon, getStickerFlavor,
  parseStickerKey, makeStickerKey, BASE_SERIES, getSeriesIds, getSeriesDef,
  getRollTargetSeries, isBookComplete, upgradableCount, starLabel,
} from './blindbox.js';
import { showMemorialCard, initMemorialCard } from './memorial-card.js';
import { db } from './db.js';
import { setStickers } from './state.js';
// 开出卡片（D7 三入口）：通知卡（②）+ 图鉴复看卡（③）
import * as revealCard from './reveal-card.js';

const TOTAL_STICKERS = STICKERS_PER_RARITY * 3; // 每册 12 张
// 图鉴展示顺序：rare → epic → legendary（由低到高）
const RARITY_ORDER = ['rare', 'epic', 'legendary'];

// 当前激活册（多册书架的选中态；批次 2 只注册 v1，恒为其值）
let activeSeries = BASE_SERIES;

// localStorage key：存已看过的 stickerKey 集合（JSON 数组；前缀天然区分各册）
const SEEN_KEY = 'seenStickerKeys';
// localStorage key（按册）：集齐庆祝是否已弹过（持久化，避免每次冷启动重弹；
// 该册重新变得不完整时自动清除，下次再集齐会重新庆祝）。
// ⚠️ v1 必须沿用历史键——线上用户的"已庆祝"状态就存在它里面，改名会重弹纪念卡
const CELEBRATED_KEY = 'stickerBookCelebrated';
/** 集齐庆祝的 localStorage 键（按册）：v1 沿用历史键，后续册加册短名后缀 */
function celebratedKeyFor(series) {
  return series === BASE_SERIES ? CELEBRATED_KEY : `${CELEBRATED_KEY}_${series}`;
}

// 是否已庆祝过集齐全集（当前激活册口径，从持久化恢复；清空重集后会重新庆祝。
// 切册 / 打开书架时经 syncCelebratedFlag() 按激活册重读）
let collectedCelebrated = (() => {
  try {
    return localStorage.getItem(celebratedKeyFor(BASE_SERIES)) === '1';
  } catch {
    return false;
  }
})();

/** 某册的「已庆祝」持久化标记（读取即时值，不依赖激活册缓存） */
function isCelebrated(series) {
  try {
    return localStorage.getItem(celebratedKeyFor(series)) === '1';
  } catch {
    return false;
  }
}

/** 让激活册的庆祝缓存与持久化对齐（切册 / 打开书架时调用） */
function syncCelebratedFlag() {
  collectedCelebrated = isCelebrated(activeSeries);
}

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

// ===== 待查看的对方揭晓（D7-②，2026-10-05 批次 3）=====
// rarity_seen=false 且非本人创建的隐藏款待办。旧实现是收到即弹 Toast（对方端揭晓提示，
// 冷启动只补播最新一条），批次 3 改为「红点信号 + 待查看卡片」：点图鉴入口时逐张弹
// 通知卡（无悬念无爆发，淡入即 idle），看完回标 rarity_seen + 同步标记对应 stickerKey
// 已看 —— 一个动作清两个信号（技术方案 §11）。列表由 app.js 注入（currentUser 过滤在那边做）。
let pendingReveals = [];
// app.js 注入：userId → 称呼（通知卡/复看卡的档案铭牌人称行，D11「开出人写具体称呼」）
let displayNameOf = null;

/** 整表设置待查看队列（冷启动对账用：以服务端列表为准） */
export function setPendingReveals(list) {
  pendingReveals = (Array.isArray(list) ? list : []).slice();
  updateBadge();
}

/** 追加一条待查看揭晓（Realtime INSERT/UPDATE 路径；按 id 幂等） */
export function addPendingReveal(todo) {
  if (!todo || !todo.id) return;
  if (pendingReveals.some((t) => t.id === todo.id)) return;
  pendingReveals.push(todo);
  updateBadge();
}

function removePendingReveal(todoId) {
  pendingReveals = pendingReveals.filter((t) => t.id !== todoId);
}

/** 该待办解锁的贴纸行（stickers.todo_id 反查；Realtime 滞后时可能还没有 → null） */
function pendingStickerOf(todo) {
  return getStickers().find((s) => s.todoId === todo.id) || null;
}

/** 看完一张通知卡：回标 rarity_seen + 同步标记该贴纸已看（失败静默，同旧 handleRarityReveal 口径） */
function consumePendingReveal(todo, sticker) {
  removePendingReveal(todo.id);
  if (sticker) markKeysSeen([sticker.stickerKey]);
  updateBadge();
  db.markRaritySeen(todo.id).catch(() => {});
}

/**
 * 点图鉴入口：有待查看揭晓时先逐张弹通知卡（先开先看），全部看完再进书架；
 * 没有（或组件故障兜底）直接进书架。
 */
async function handleEntryTap() {
  if (pendingReveals.length > 0) {
    const queue = pendingReveals.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    for (const todo of queue) {
      const sticker = pendingStickerOf(todo);
      // 贴纸行还没到本地（Realtime 滞后）或该册没有专属卡（未来新册上线初期）→
      // 不弹卡，只清信号：书架里的「新」角标承接展示
      if (sticker && revealCard.canRevealCard(sticker.stickerKey)) {
        const res = await revealCard.playNotify(todo, sticker, {
          byName: displayNameOf ? displayNameOf(todo.createdBy) : '对方',
        }).catch(() => ({ played: false }));
        if (!res.played) break; // 组件级故障：剩余排队保留（下次入口再试），先进书架
      }
      consumePendingReveal(todo, sticker);
    }
  }
  openStickerBook();
}

/** 解锁时间 → 「M月d日」；无效时间返回空串 */
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 生成指定册的全集（12 张的元信息），标记每张是否已解锁。
 * @param {string} [series] 册 id，默认第一册（BASE_SERIES）
 * @returns {Array<{key,rarity,name,unlocked,unlockedAt,starLevel}>}
 */
function buildFullBook(series = BASE_SERIES) {
  const unlocked = getStickers();
  const byKey = new Map(unlocked.map((s) => [s.stickerKey, s]));
  const all = [];
  for (const rarity of RARITY_ORDER) {
    const meta = RARITY_META[rarity];
    // 贴纸名按册取（批次 3 起 v1 / story 各有名称表；缺省回退档位名）
    const seriesMeta = (getSeriesDef(series) || {}).meta;
    const rarityMeta = (seriesMeta && seriesMeta[rarity]) || meta;
    for (let i = 1; i <= STICKERS_PER_RARITY; i++) {
      const key = makeStickerKey(series, rarity, i);
      const s = byKey.get(key);
      all.push({
        key,
        rarity,
        name: rarityMeta.stickerNames[i - 1] || `${meta.label}${i}`,
        unlocked: !!s,
        unlockedAt: s ? s.unlockedAt : null,
        starLevel: s ? (s.starLevel || 0) : 0, // 升星（批次 4）：0=普通/1=闪卡/2=烫金
      });
    }
  }
  return all;
}

/**
 * 渲染册 tab 栏（多册书架的切换入口）。
 * **只有一册时不渲染任何内容**——v1 单册期间用户视觉零变化，批次 3 注册第二册后
 * tab 自动出现（路线图 §5.2 实施定稿）。tab 容器按需创建/移除，不留空 DOM 节点。
 * 样式（.sticker-book-tabs）随批次 3 tab 实际上线一起补。
 */
function renderBookTabs() {
  const panel = document.querySelector('#stickerModal .sticker-modal__panel');
  const header = panel ? panel.querySelector('.sticker-modal__header') : null;
  if (!panel || !header) return;
  let tabsEl = document.getElementById('stickerBookTabs');
  const seriesIds = getSeriesIds();
  if (seriesIds.length <= 1) {
    if (tabsEl) tabsEl.remove();
    return;
  }
  if (!tabsEl) {
    tabsEl = document.createElement('div');
    tabsEl.id = 'stickerBookTabs';
    tabsEl.className = 'sticker-book-tabs';
    tabsEl.setAttribute('role', 'tablist');
    header.after(tabsEl);
  }
  tabsEl.innerHTML = '';
  for (const id of seriesIds) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sticker-book-tabs__tab'
      + (id === activeSeries ? ' sticker-book-tabs__tab--active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(id === activeSeries));
    btn.textContent = (getSeriesDef(id) || {}).title || id;
    // 书脊 / 封面专属配色（D5 便宜版）：每册一条书脊色 + 激活态的底色与文字色，
    // 颜色来自册注册表（v1 樱粉默认，story 夜蓝）
    const accent = (getSeriesDef(id) || {}).accent;
    if (accent) {
      btn.style.setProperty('--tab-spine', accent.spine);
      btn.style.setProperty('--tab-tint', accent.tint);
      btn.style.setProperty('--tab-ink', accent.ink);
    }
    btn.addEventListener('click', () => {
      if (id === activeSeries) return;
      activeSeries = id;
      // 切册：重读该册的庆祝标记，按该册口径重绘（不重放入场动画）
      syncCelebratedFlag();
      renderStickerBook();
    });
    tabsEl.appendChild(btn);
  }
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

/** 按收集进度切换提示文案（空状态引导 / 接近集齐 / 已集齐 / 默认），按册区分口径 */
function updateHint(unlockedCount, series) {
  const hintEl = document.getElementById('stickerHint');
  if (!hintEl) return;
  const def = getSeriesDef(series) || {};
  const isFirst = series === BASE_SERIES;
  let text;
  if (unlockedCount === 0) {
    if (isFirst) {
      text = '每添加一条待办，都有小概率开出隐藏款——和 ta 集满这 12 张吧';
    } else if (getRollTargetSeries() !== series) {
      // 未开启的册（第一册还没集齐）：先见到剪影，收集从第一册集齐后开始
      text = `集满第一册，就能翻开${def.title}`;
    } else {
      text = `${def.title}开启！每条待办都可能开出新的一页`;
    }
  } else if (unlockedCount === TOTAL_STICKERS) {
    // 升星期（批次 4）：集齐不是终点——还差多少张没满星就继续引导；全部烫金后才是终局
    const upgradable = upgradableCount(series);
    text = upgradable > 0
      ? `12 张全部集齐！继续添加待办，还有 ${upgradable} 次升星机会（闪卡 → 烫金）✨`
      : '12 张全部集齐并升满烫金，这是属于你们的专属纪念 ✨';
  } else if (unlockedCount >= TOTAL_STICKERS - 2) {
    text = `就差 ${TOTAL_STICKERS - unlockedCount} 张就集齐啦，加油～`;
  } else {
    text = '小概率出现隐藏款待办，解锁专属贴纸～';
  }
  hintEl.textContent = text;
}

/** 当前激活册的纪念卡数据（memorial-card 只吃数据；按册传各自的册数据）。
 *  v1 沿用历史卡片标题（零变化），后续册带册名区分 */
function buildBookData() {
  const def = getSeriesDef(activeSeries) || {};
  return {
    title: activeSeries === BASE_SERIES
      ? `${TOTAL_STICKERS} 张贴纸全部集齐`
      : `${def.title || activeSeries} · ${TOTAL_STICKERS} 张贴纸全部集齐`,
    stickers: buildFullBook(activeSeries),
  };
}

/**
 * 集齐庆祝：全屏纪念卡仪式（首次，带金色彩带）。
 * 批次 1 前是「Toast + 一次性撒花」；纪念卡承载同样的宣告且可从完成态重复查看，
 * 不再单独弹 Toast（卡片本身就是宣告，两条同屏互相干扰）。
 */
function celebrateComplete() {
  showMemorialCard(buildBookData(), { celebrate: true });
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

  const all = buildFullBook(activeSeries);
  const unlockedCount = all.filter((s) => s.unlocked).length;
  const isNewOf = seenSnapshot ? (key) => !seenSnapshot.has(key) : () => false;

  // 格子：已解锁 = 白底板 + 彩色贴纸 + 名称 + 日期（+ 新角标）；
  //       未解锁 = 本尊图案的灰色剪影（雾显悬念）+ ???
  const frag = document.createDocumentFragment();  all.forEach((s, idx) => {
    const meta = RARITY_META[s.rarity];
    // 升星视觉（批次 4）：--star1 闪卡 / --star2 烫金改格子底板质感，角标显示星数
    const starCls = s.starLevel >= 2 ? ' sticker-cell--star2'
      : s.starLevel === 1 ? ' sticker-cell--star1' : '';
    const cell = document.createElement('div');
    cell.className = 'sticker-cell'
      + (s.unlocked ? ` sticker-cell--unlocked sticker-cell--${s.rarity}` : '')
      + (s.unlocked ? starCls : '')
      + (animate ? ' sticker-cell--in' : '');
    if (animate) cell.style.animationDelay = `${idx * 35}ms`;
    cell.setAttribute('aria-label', s.unlocked
      ? `已解锁：${s.name}（${meta.label}${s.starLevel ? `，${'★'.repeat(s.starLevel)}${starLabel(s.starLevel)}` : ''}${formatDate(s.unlockedAt) ? '，' + formatDate(s.unlockedAt) : ''}）`
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

      if (s.starLevel) {
        const star = document.createElement('span');
        star.className = 'sticker-cell__star';
        star.textContent = '★'.repeat(s.starLevel);
        cell.appendChild(star);
      }

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

  // 图例 / 册 tab / 提示 / 进度
  renderLegend(all);
  renderBookTabs();
  updateHint(unlockedCount, activeSeries);
  if (progressEl) progressEl.textContent = `${unlockedCount} / ${TOTAL_STICKERS}`;
  if (barEl) {
    barEl.style.width = `${(unlockedCount / TOTAL_STICKERS) * 100}%`;
    barEl.classList.toggle('sticker-modal__progress-fill--complete', unlockedCount === TOTAL_STICKERS);
  }
  // 常驻可点提示：该册有已解锁贴纸才显示（0 张时无可点对象）
  const tapHintEl = document.getElementById('stickerTapHint');
  if (tapHintEl) tapHintEl.classList.toggle('hidden', unlockedCount === 0);

  // 集齐状态：面板金色完成态 + 徽章 + 纪念卡重看入口
  const complete = unlockedCount === TOTAL_STICKERS;
  if (panelEl) panelEl.classList.toggle('sticker-modal__panel--complete', complete);
  if (chipEl) chipEl.classList.toggle('hidden', !complete);
  const memorialBtn = document.getElementById('stickerMemorialBtn');
  if (memorialBtn) memorialBtn.classList.toggle('hidden', !complete);

  // 集齐庆祝（按册持久化）：只在真正"集齐那一刻"庆祝一次；
  // 该册重新变得不完整（如清理测试数据）时清除标记，下次集齐重新庆祝
  if (complete && !collectedCelebrated) {
    collectedCelebrated = true;
    try { localStorage.setItem(celebratedKeyFor(activeSeries), '1'); } catch { /* ignore */ }
    celebrateComplete();
  } else if (!complete && collectedCelebrated) {
    collectedCelebrated = false;
    try { localStorage.removeItem(celebratedKeyFor(activeSeries)); } catch { /* ignore */ }
  }
}

/** 格子点击/回车：第一册已解锁格子弹「复看卡」（D7-③）；无专属卡的 key 回落故事卡（事件委托，绑定一次） */
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
 * "贴纸可以戳"的常驻微文案（#stickerTapHint）：2026-10-07 起替代轻晃演示。
 * 逻辑收在 renderStickerBook（unlockedCount === 0 → hidden），
 * 轻晃演示的持久化/退场机制已随该交互一并移除。
 */

/** 弹出贴纸详情：复看卡（D7-③）或故事卡回落。 */
let flavorTimer = null;
function revealFlavor(cell) {
  // 点击瞬间摘掉点击弹跳类（配合下方 reflow，保证连续点击也能重放动画）
  cell.classList.remove('sticker-cell--pop');

  const key = cell.dataset.key || '';
  const sticker = getStickers().find((s) => s.stickerKey === key);
  // 图鉴复看（D7-③，批次 3）：第一册 12 张点开即展示该贴纸的专属内容卡——
  // 日期=unlocked_at、无 NEW、无爆发、可翻面看档案（技术方案 §11「格子点击升级为复看卡」）
  if (sticker && revealCard.canRevealCard(key)) {
    revealCard.playReview(sticker, {
      byName: displayNameOf ? displayNameOf(sticker.unlockedBy) : '对方',
    });
    return;
  }

  // —— 故事卡回落（批次 4 起两册均有专属卡，此分支对已注册册不再可达；保留给未来无卡的新册）——
  // 强制 reflow，保证连续点击也能重放动画
  void cell.offsetWidth;
  cell.classList.add('sticker-cell--pop');

  const flavor = getStickerFlavor(key);
  const card = document.getElementById('stickerFlavor');
  if (!flavor || !card) return;

  const parsed = parseStickerKey(key);
  if (!parsed) return;
  const meta = RARITY_META[parsed.rarity];
  const name = meta.stickerNames[parsed.index - 1] || meta.label;
  const date = sticker ? formatDate(sticker.unlockedAt) : '';
  const starLevel = sticker ? (sticker.starLevel || 0) : 0;

  card.className = 'sticker-modal__flavor sticker-modal__flavor--' + parsed.rarity;
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
  bodyEl.appendChild(title);
  // 升星（批次 4）：故事卡标题下加一行金色星级（★ 闪卡 / ★★ 烫金），普通态不占位
  if (starLevel) {
    const starLine = document.createElement('div');
    starLine.className = 'sticker-modal__flavor-star';
    starLine.textContent = `${'★'.repeat(starLevel)} ${starLabel(starLevel)}`;
    bodyEl.appendChild(starLine);
  }
  const text = document.createElement('div');
  text.className = 'sticker-modal__flavor-text';
  text.textContent = flavor;
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
 * 打开书架时默认翻开哪一本（批次 3 多册）：
 *   1. 优先「已集齐但还没庆祝过」的册——集齐仪式必须可达（v1 集齐后打开即弹纪念卡，
 *      与批次 1 行为一致；story 集齐后同理，不依赖用户手动切到那本）；
 *   2. 否则「正在收集的册」（getRollTargetSeries）——单册期恒为第一册（行为与批次 2 前一致）；
 *   3. 全部集齐时维持上次所在册（重看纪念卡不被打断）。
 */
function pickDefaultSeries() {
  for (const id of getSeriesIds()) {
    if (isBookComplete(id) && !isCelebrated(id)) return id;
  }
  return getRollTargetSeries() || activeSeries;
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
  // 默认翻开待庆祝 / 正在收集的那本（多册书架，见 pickDefaultSeries）
  activeSeries = pickDefaultSeries();
  syncCelebratedFlag();
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
}

/** 关闭图鉴弹层。此刻才把**当前激活册**的贴纸标记为已看 → 清红点。 */
export function closeStickerBook() {
  const modal = document.getElementById('stickerModal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  hideFlavorCard();
  document.body.style.overflow = '';
  // 按册隔离：只标记当前激活册的 key（多册时不误清别册的新贴纸；
  // 现有贴纸 key 均无前缀、都属于 v1，单册期与全量标记等价）
  markKeysSeen(
    getStickers()
      .filter((s) => (parseStickerKey(s.stickerKey) || {}).series === activeSeries)
      .map((s) => s.stickerKey)
  );
  updateBadge();
}

/**
 * 更新顶栏红点。
 * 红点逻辑（两个信号取并集，任一存在即亮）：
 *   ① 有贴纸的 key 不在已看集合里（对方解锁新贴纸 / 自己解锁后还没打开过图鉴）
 *   ② 待查看的对方揭晓队列非空（rarity_seen=false 且非本人创建，D7-②）
 *   - 关闭过图鉴 → 当前册所有 key 已标记已看 → 信号①消失
 *   - 通知卡看完一张清一张 → 信号②消失（并回标 rarity_seen）
 */
function updateBadge() {
  const badge = document.getElementById('stickerBadge');
  if (!badge) return;
  const seen = getSeenKeys();
  const hasUnseen = pendingReveals.length > 0
    || getStickers().some((s) => !seen.has(s.stickerKey));
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
  displayNameOf = opts.displayNameOf || null;

  const entryBtn = document.getElementById('stickerEntry');
  if (entryBtn) {
    // D7-②：有待查看揭晓时先弹通知卡再进书架（handleEntryTap 分派）
    entryBtn.addEventListener('click', handleEntryTap);
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
  // ESC 关闭（与其他弹层一致的键盘出口）。
  // 纪念卡 / 开出卡片（复看卡、通知卡）叠在图鉴弹层之上：任一开着时 ESC 只关最上面那层
  // （memorial-card / reveal-card 各自的监听负责），不把背后的图鉴弹层一起关掉
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const mc = document.getElementById('memorialCard');
    if (mc && !mc.classList.contains('hidden')) return;
    if (revealCard.isRevealCardOpen()) return;
    const m = document.getElementById('stickerModal');
    if (m && !m.classList.contains('hidden')) closeStickerBook();
  });

  bindGridInteraction();

  // 纪念卡：完成态面板的"重看"入口 + 弹层自身的关闭交互（一次绑定）
  const memorialBtn = document.getElementById('stickerMemorialBtn');
  if (memorialBtn) {
    memorialBtn.addEventListener('click', () => showMemorialCard(buildBookData()));
  }
  initMemorialCard();

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
