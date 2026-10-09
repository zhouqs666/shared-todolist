/**
 * 待办留言板（F-04 升级：单条完成备注 → 双人平铺留言 + 回复）
 *
 * 产品定稿（2026-10-09，与业主逐条敲定）：
 *   · 形态：平铺 + 回复引用（朋友圈评论区）——所有留言按时间一条线平铺，
 *     回复也平铺，以「回复 @昵称：」开头（不缩进）
 *   · 卡片零侵入：只在有留言时出现气泡图标 + 总条数（0 条 = 卡片与从前完全一样）；
 *     有未读 → 主色 + 右上角圆点。卡片上不出现任何留言文案
 *   · 留言板正序；打开时有未读**定位到第一条未读**（未读段前有淡分隔线），无未读停在最新
 *   · 能力：回复某条 / 编辑与删除自己的（软删除，回收站不展示留言）/ 贴爱心 / 未读提示
 *   · 不推系统通知（产品原则：情感性事件不打断）——卡片上的未读圆点是唯一的发现机制
 *   · 未读水位存本机 localStorage（`youai_comment_seen`）：首次运行以各待办现有最大
 *     created_at 播种（历史不算未读），此后只认「水位之后的对方留言」；水位用服务端时间戳，
 *     两端时钟偏差不会造成"永远未读"；自己的留言永不算未读
 *
 * 数据流：commentsByTodo（**含软删行**——回复前缀要解析被删父留言的昵称）+ likesByComment；
 *        Realtime 事件按 id / 内容幂等合并；整份补拉有 eventSeq 闸（同 reactions.js 的踩坑修法：
 *        拉取期间落地的事件不能被旧快照抹掉）。
 *        纯逻辑（未读判定/水位/前缀文案）在 ./comment-logic.js，有单测。
 */

import { db } from './db.js';
import { showToast } from './toast.js';
import { formatRelativeTime } from './utils.js';
import { ICONS } from './action-sheet.js';
import { getReactionSvg } from './reactions.js';
import {
  visibleComments,
  summarize,
  unreadCount,
  firstUnreadIndex,
  watermark,
  replyPrefix,
  parseSeenStore,
  withWatermark,
  sortByCreatedAt,
} from './comment-logic.js';

/** 已读水位存储键（本机；换设备/清缓存后历史留言不算未读 —— 宁可漏红点也不误报） */
const SEEN_KEY = 'youai_comment_seen';
/** 单条留言字数上限（与 schema 的 CHECK 一致；回复前缀是渲染时拼的，不占字数） */
const MAX_LEN = 100;
/** 输入框占位文案池（沿用原「完成备注」的语气：短、留白，像两人之间给某件事留的便条） */
const PLACEHOLDERS = [
  '事毕，灯也熄了',
  '花浇过了，安心睡',
  '窗已关严，风进不来',
  '先搁着，等你回来再说',
  '信已寄出，风替我送',
  '这事我记下了',
  '路远，慢慢来不急',
  '雨大，今日不出门',
  '做完了，你先歇',
  '留半盏灯，等你回',
];
const CLOSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';

/** @type {Object<string, Array>} todoId → comments[]（含软删行） */
let commentsByTodo = {};
/** @type {Object<string, Array>} commentId → likes[] */
let likesByComment = {};
/** 「已由 Realtime 落地」的留言/爱心变更计数（供 refreshComments 判断补拉快照是否已过时） */
let commentEventSeq = 0;
let currentUser = null;
let deps = { getTodos: () => [], displayOf: () => ({ name: '?', avatar: null }) };
/** localStorage 水位的会话内副本（null = 尚未读盘） */
let seenStore = null;
let seededOnce = false;
/** 两张留言表是否可读（决定要不要建立留言的 Realtime 频道，见 refreshComments） */
let tablesReady = false;
/** 当前打开的留言板弹层状态（null = 未打开） */
let sheetState = null;

function myId() {
  return currentUser && currentUser.id;
}
function pickPlaceholder() {
  return PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)];
}

// ===== 已读水位（本机）=====

function seenStoreOf() {
  if (seenStore === null) {
    let raw = null;
    try { raw = localStorage.getItem(SEEN_KEY); } catch (_) { /* 隐私模式：退化为会话内水位 */ }
    seenStore = parseSeenStore(raw);
  }
  return seenStore;
}
function persistSeen() {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seenStore || {})); } catch (_) {}
}
function seenAtOf(todoId) {
  return seenStoreOf()[todoId] || null;
}
/** 推进某待办的已读水位（只增不减） */
function markSeen(todoId, at) {
  if (!todoId || !at) return;
  const prev = seenStoreOf()[todoId];
  if (prev && prev >= at) return;
  seenStore = withWatermark(seenStoreOf(), todoId, at);
  persistSeen();
}
/**
 * 首次运行播种：把每条待办现有留言的最大 created_at 记为已读水位。
 * 为什么需要：不播种的话，升级那一刻的历史留言（含搬迁来的旧备注）会全部亮红点 —— 误报。
 * 只在「localStorage 里没有这个键」时做一次，之后正常判定。
 */
function seedWatermarksOnce() {
  if (seededOnce) return;
  seededOnce = true;
  let raw = null;
  try { raw = localStorage.getItem(SEEN_KEY); } catch (_) {}
  if (raw !== null) return;
  let next = seenStoreOf();
  Object.keys(commentsByTodo).forEach((tid) => {
    const w = watermark(commentsByTodo[tid]);
    if (w) next = withWatermark(next, tid, w);
  });
  seenStore = next;
  persistSeen();
}

// ===== 加载 / 初始化 =====

/**
 * 初始化留言板：设依赖 + 首次整份拉取。
 * @param {Object} opts
 * @param {Object} opts.currentUser { id }
 * @param {()=>Array} opts.getTodos 拿最新待办列表（弹层标题要显示待办文案）
 * @param {(userId:string)=>{name:string,avatar:string|null}} opts.displayOf 用户显示信息
 */
export async function initComments({ currentUser: user, getTodos, displayOf }) {
  currentUser = user;
  if (getTodos) deps.getTodos = getTodos;
  if (displayOf) deps.displayOf = displayOf;
  await refreshComments();
}

/**
 * 两张留言表当前是否可读。
 * 用途：**决定是否建立留言的 Realtime 频道** —— 向服务端订阅一张不存在的表，
 * 会让该频道"报 SUBSCRIBED 却一条事件都不投递"（2026-10-09 实测，详见 realtime.js
 * 的 initCommentRealtime 注释）。所以订阅这件事必须等数据层确认表在。
 */
export function commentsTablesReady() {
  return tablesReady;
}

/**
 * 整份补拉（冷启动 / 断线重连共用）。
 * 为什么需要：留言与表情一样「只在冷启动拉一次」，而 Realtime 的复制槽不重放历史 ——
 * 断线期间对方写的留言本端永远收不到，所以重连时必须补拉。
 * ⚠️ 拉取期间有新事件落地时放弃本次替换（commentEventSeq），否则会抹掉刚推来的留言。
 * ⚠️ 表可能尚未建（迁移未执行的窗口期）：失败只打日志、不抛 —— 留言功能整体不可见，
 *    App 其余功能（含主频道的 Realtime）照常；表就绪后由调用方补建留言频道。
 */
export async function refreshComments() {
  const seqAtIssue = commentEventSeq;
  try {
    const [comments, likes] = await Promise.all([db.listComments(), db.listCommentLikes()]);
    tablesReady = true;
    if (commentEventSeq !== seqAtIssue) {
      console.warn('[comments] 补拉期间有新留言落地，放弃本次整份替换以免抹掉它');
      return null;
    }
    commentsByTodo = {};
    comments.forEach((c) => {
      (commentsByTodo[c.todoId] ||= []).push(c);
    });
    Object.keys(commentsByTodo).forEach((tid) => {
      commentsByTodo[tid] = sortByCreatedAt(commentsByTodo[tid]);
    });
    likesByComment = {};
    likes.forEach((l) => {
      (likesByComment[l.commentId] ||= []).push(l);
    });
    seedWatermarksOnce();
    return comments;
  } catch (err) {
    // console.warn 而非 error：与「图鉴加载失败（已忽略）」「consumePartnerLoginCount 失败（已忽略）」同款 ——
    // 这是**已忽略的降级**（表还没建/网络抖动），不该按错误级记账（E2E 的「无模块级报错」断言会看等级）
    console.warn('[comments] 加载留言失败（已忽略）:', err && err.message);
    return null;
  }
}

// ===== 卡片徽标（气泡 + 条数 + 未读圆点）=====

/** 某待办的留言条数（供长按菜单显示状态，与徽标同口径） */
export function getCommentCount(todoId) {
  return summarize(commentsByTodo[todoId] || []).count;
}

/**
 * 渲染/更新卡片上的留言徽标（原地增删，绝不重建 li）。
 * 由 renderItem（新建）与 updateItem（更新）统一调用，与 renderImage / renderReminderBadge 同模式。
 * 克制规则：无留言 → 什么都不显示（卡片与从前完全一样）。
 */
export function renderCommentBadge(li, todo) {
  if (!li || !todo) return;
  const headline = li.querySelector('.todo__headline');
  if (!headline) return;
  const existing = li.querySelector('.todo__comment-badge');

  const rows = commentsByTodo[todo.id] || [];
  const { count } = summarize(rows);
  if (count === 0) {
    if (existing) existing.remove();
    return;
  }

  const unread = unreadCount(rows, myId(), seenAtOf(todo.id)) > 0;
  let badge = existing;
  if (!badge) {
    badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'todo__comment-badge';
    badge.addEventListener('click', (e) => {
      e.stopPropagation(); // 不要触到卡片的长按/完成
      openCommentSheet(todo.id);
    });
    headline.appendChild(badge);
  }
  badge.classList.toggle('todo__comment-badge--unread', unread);
  badge.setAttribute('aria-label', `留言 ${count} 条${unread ? '，有未读' : ''}`);
  badge.title = `留言 ${count} 条`;
  const numEl = badge.querySelector('.todo__comment-badge-count');
  const label = String(count);
  if (!numEl || numEl.textContent !== label) {
    badge.innerHTML = ICONS.note + `<span class="todo__comment-badge-count">${label}</span>`;
  }
}

/** 局部刷新某待办的徽标（数据变化后；节点不在页面上时静默跳过） */
function rerenderBadge(todoId) {
  const li = document.querySelector(`.todo[data-id="${todoId}"]`);
  if (!li) return;
  renderCommentBadge(li, { id: todoId });
}

/** 数据变化后的视图刷新：徽标 + （若是当前打开的弹层）留言列表 */
function refreshViews(todoId, scroll) {
  rerenderBadge(todoId);
  if (sheetState && sheetState.todoId === todoId) {
    renderThread(sheetState, { scroll: scroll || 'keep' });
  }
}

// ===== 留言板弹层 =====

/**
 * 打开某待办的留言板（底部滑出，可滚动列表 + 固定输入条）。
 * @param {string} todoId
 * @param {Object} [opts]
 * @param {boolean} [opts.focus] 是否自动聚焦输入框（从长按菜单「留言」进来 = true，
 *        点卡片图标进来 = false：先读，想写再点输入框）
 */
export function openCommentSheet(todoId, opts = {}) {
  if (!todoId) return;
  if (sheetState) {
    if (sheetState.todoId === todoId) return;
    closeCommentSheet();
  }
  const todo = deps.getTodos().find((t) => t.id === todoId);
  const rows = commentsByTodo[todoId] || [];
  const list = visibleComments(rows);
  const idxUnread = firstUnreadIndex(rows, myId(), seenAtOf(todoId));
  const anchor = idxUnread >= 0 ? list[idxUnread] : null;

  const overlay = document.createElement('div');
  overlay.className = 'comment-sheet__overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCommentSheet(); });

  const panel = document.createElement('div');
  panel.className = 'comment-sheet';

  const handle = document.createElement('div');
  handle.className = 'comment-sheet__handle';
  panel.appendChild(handle);

  // 头部：标题 + 待办文案（一行截断，明确"在给哪条留言"）+ 关闭
  const header = document.createElement('div');
  header.className = 'comment-sheet__header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'comment-sheet__titles';
  const title = document.createElement('div');
  title.className = 'comment-sheet__title';
  title.textContent = '留言';
  const subtitle = document.createElement('div');
  subtitle.className = 'comment-sheet__subtitle';
  subtitle.textContent = (todo && todo.text) || '';
  subtitle.title = (todo && todo.text) || '';
  titleWrap.appendChild(title);
  if (todo && todo.text) titleWrap.appendChild(subtitle);
  header.appendChild(titleWrap);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'comment-sheet__close';
  closeBtn.setAttribute('aria-label', '关闭留言板');
  closeBtn.innerHTML = CLOSE_SVG;
  closeBtn.addEventListener('click', closeCommentSheet);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // 列表区（可滚动）
  const bodyEl = document.createElement('div');
  bodyEl.className = 'comment-sheet__body';
  const threadEl = document.createElement('div');
  threadEl.className = 'comment-sheet__thread';
  bodyEl.appendChild(threadEl);
  panel.appendChild(bodyEl);

  // 底部：回复/编辑提示条 + 输入条
  const footer = document.createElement('div');
  footer.className = 'comment-sheet__footer';
  const hintEl = document.createElement('div');
  hintEl.className = 'comment-sheet__hint';
  hintEl.hidden = true;
  const hintText = document.createElement('span');
  hintText.className = 'comment-sheet__hint-text';
  hintEl.appendChild(hintText);
  const hintCancel = document.createElement('button');
  hintCancel.type = 'button';
  hintCancel.className = 'comment-sheet__hint-cancel';
  hintCancel.setAttribute('aria-label', '取消');
  hintCancel.innerHTML = CLOSE_SVG;
  hintEl.appendChild(hintCancel);
  footer.appendChild(hintEl);

  const composer = document.createElement('div');
  composer.className = 'comment-sheet__composer';
  const inputWrap = document.createElement('div');
  inputWrap.className = 'comment-sheet__input-wrap';
  const inputEl = document.createElement('textarea');
  inputEl.className = 'comment-sheet__input';
  inputEl.maxLength = MAX_LEN;
  inputEl.rows = 1;
  inputEl.placeholder = pickPlaceholder();
  const counterEl = document.createElement('span');
  counterEl.className = 'comment-sheet__counter';
  inputWrap.appendChild(inputEl);
  inputWrap.appendChild(counterEl);
  composer.appendChild(inputWrap);
  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'comment-sheet__send';
  sendBtn.textContent = '发送';
  sendBtn.disabled = true;
  composer.appendChild(sendBtn);
  footer.appendChild(composer);
  panel.appendChild(footer);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden'; // 锁页面滚动

  sheetState = {
    todoId,
    overlay,
    bodyEl,
    threadEl,
    inputEl,
    counterEl,
    sendBtnEl: sendBtn,
    hintEl,
    hintTextEl: hintText,
    mode: null, // null=新留言 | {type:'reply',row} | {type:'edit',row}
    unreadAnchorId: anchor ? anchor.id : null,
  };

  renderThread(sheetState, { scroll: anchor ? 'anchor' : 'bottom' });
  bindSheetEvents(sheetState);
  requestAnimationFrame(() => overlay.classList.add('comment-sheet__overlay--show'));

  // 打开即全部标记已读（水位推到当前最大 created_at），卡片圆点随之消失
  markSeen(todoId, watermark(rows));
  rerenderBadge(todoId);

  document.addEventListener('keydown', onSheetEsc);
  if (opts.focus) setTimeout(() => { inputEl.focus(); }, 300);
}

function onSheetEsc(e) {
  if (e.key === 'Escape' && sheetState) {
    e.preventDefault();
    closeCommentSheet();
  }
}

/** 关闭留言板（保留 DOM 到退场动画结束） */
export function closeCommentSheet() {
  const s = sheetState;
  if (!s) return;
  sheetState = null;
  s.overlay.classList.remove('comment-sheet__overlay--show');
  document.body.style.overflow = '';
  document.removeEventListener('keydown', onSheetEsc);
  setTimeout(() => {
    if (s.overlay.parentNode) s.overlay.parentNode.removeChild(s.overlay);
  }, 280);
}

function bindSheetEvents(s) {
  s.inputEl.addEventListener('input', () => {
    autoGrowInput(s);
    updateCounter(s);
  });
  s.inputEl.addEventListener('keydown', (e) => {
    // 回车发送（移动端键盘的"发送/完成"键也走这里）；Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitComposer(s);
    }
  });
  s.sendBtnEl.addEventListener('click', () => submitComposer(s));
  s.hintEl.querySelector('.comment-sheet__hint-cancel').addEventListener('click', () => setComposeMode(s, null));
}

function autoGrowInput(s) {
  s.inputEl.style.height = 'auto';
  s.inputEl.style.height = `${Math.min(s.inputEl.scrollHeight, 96)}px`;
}

function updateCounter(s) {
  const n = (s.inputEl.value || '').length;
  s.counterEl.textContent = n ? `${n}/${MAX_LEN}` : '';
  s.counterEl.classList.toggle('comment-sheet__counter--near', n >= MAX_LEN - 10);
  s.sendBtnEl.disabled = !s.inputEl.value.trim();
}

/**
 * 切换输入条模式：null=新留言 / reply=回复某条 / edit=改自己那条。
 * 三种模式共用同一个输入条（移动端少一层弹窗），底部提示条说明当前处于哪种。
 */
function setComposeMode(s, mode) {
  s.mode = mode || null;
  if (!s.mode) {
    s.hintEl.hidden = true;
    s.inputEl.placeholder = pickPlaceholder();
    s.sendBtnEl.textContent = '发送';
  } else if (s.mode.type === 'reply') {
    const name = deps.displayOf(s.mode.row.authorId).name;
    s.hintEl.hidden = false;
    s.hintTextEl.textContent = `回复 ${name}`;
    s.inputEl.placeholder = `回复 ${name}…`;
    s.sendBtnEl.textContent = '发送';
    s.inputEl.focus();
  } else if (s.mode.type === 'edit') {
    s.hintEl.hidden = false;
    s.hintTextEl.textContent = '编辑留言';
    s.inputEl.placeholder = '修改这句话…';
    s.sendBtnEl.textContent = '保存';
    s.inputEl.value = s.mode.row.content || '';
    updateCounter(s);
    autoGrowInput(s);
    s.inputEl.focus();
    s.inputEl.setSelectionRange(s.inputEl.value.length, s.inputEl.value.length);
  }
}

/** 重建留言列表（整段重绘：线程体量极小，增量收益不值复杂度） */
function renderThread(s, opts = {}) {
  const body = s.bodyEl;
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  const prevScroll = body.scrollTop;

  const rows = commentsByTodo[s.todoId] || [];
  const list = visibleComments(rows);
  const byId = {};
  rows.forEach((r) => { byId[r.id] = r; }); // 含软删行：回复前缀要解析被删父留言的昵称

  s.threadEl.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'comment-sheet__empty';
    empty.textContent = '还没有留言，说点什么吧';
    s.threadEl.appendChild(empty);
    return;
  }

  let anchorEl = null;
  list.forEach((row) => {
    if (s.unreadAnchorId && row.id === s.unreadAnchorId) {
      const divider = document.createElement('div');
      divider.className = 'comment-sheet__divider';
      divider.textContent = '以下为新留言';
      s.threadEl.appendChild(divider);
      anchorEl = divider;
    }
    s.threadEl.appendChild(buildRow(s, row, byId[row.parentId] || null));
  });

  // 定位：首次打开按 anchor/bottom；其后按"原来是否贴着底部"
  const mode = opts.scroll || 'keep';
  requestAnimationFrame(() => {
    if (mode === 'anchor' && anchorEl) {
      body.scrollTop = Math.max(0, anchorEl.offsetTop - 12);
    } else if (mode === 'bottom' || (mode === 'keep' && nearBottom)) {
      body.scrollTop = body.scrollHeight;
    } else {
      body.scrollTop = prevScroll;
    }
    if (mode === 'anchor') s.unreadAnchorId = null; // 只定位一次
  });
}

/** 构建一条留言（头像 + 昵称 + 时间 + 内容 + 操作行） */
function buildRow(s, row, parent) {
  const mine = row.authorId === myId();
  const u = deps.displayOf(row.authorId);

  const el = document.createElement('div');
  el.className = 'comment-row' + (mine ? ' comment-row--mine' : '');
  el.dataset.id = row.id;

  if (u.avatar) {
    const img = document.createElement('img');
    img.className = 'comment-row__avatar';
    img.src = u.avatar;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => img.remove();
    el.appendChild(img);
  } else {
    const dot = document.createElement('span');
    dot.className = 'comment-row__avatar-dot';
    el.appendChild(dot);
  }

  const main = document.createElement('div');
  main.className = 'comment-row__main';

  const head = document.createElement('div');
  head.className = 'comment-row__head';
  const nameEl = document.createElement('span');
  nameEl.className = 'comment-row__name';
  nameEl.textContent = u.name;
  head.appendChild(nameEl);
  const timeEl = document.createElement('span');
  timeEl.className = 'comment-row__time';
  timeEl.textContent = formatRelativeTime(row.createdAt);
  head.appendChild(timeEl);
  if (row.editedAt) {
    const editedEl = document.createElement('span');
    editedEl.className = 'comment-row__edited';
    editedEl.textContent = '已编辑';
    head.appendChild(editedEl);
  }
  main.appendChild(head);

  const contentEl = document.createElement('div');
  contentEl.className = 'comment-row__content';
  if (parent) {
    const prefix = document.createElement('span');
    prefix.className = 'comment-row__reply';
    prefix.textContent = replyPrefix(parent, (uid) => deps.displayOf(uid).name);
    contentEl.appendChild(prefix);
  }
  contentEl.appendChild(document.createTextNode(row.content)); // 文本节点：天然防注入
  main.appendChild(contentEl);

  const actions = document.createElement('div');
  actions.className = 'comment-row__actions';

  const replyBtn = document.createElement('button');
  replyBtn.type = 'button';
  replyBtn.className = 'comment-row__action';
  replyBtn.textContent = '回复';
  replyBtn.addEventListener('click', () => {
    if (s.mode && s.mode.type === 'edit') return; // 编辑中不切模式（避免误丢编辑内容）
    setComposeMode(s, { type: 'reply', row });
  });
  actions.appendChild(replyBtn);

  // 爱心（只一种表情；svg 复用 reactions 模块的爱心，保证同一套视觉）
  const likes = likesByComment[row.id] || [];
  const likedByMe = likes.some((l) => l.userId === myId());
  const likeBtn = document.createElement('button');
  likeBtn.type = 'button';
  likeBtn.className = 'comment-row__action comment-row__like' + (likedByMe ? ' comment-row__like--mine' : '');
  likeBtn.innerHTML = getReactionSvg('heart');
  if (likes.length) {
    const countEl = document.createElement('span');
    countEl.className = 'comment-row__like-count';
    countEl.textContent = String(likes.length);
    likeBtn.appendChild(countEl);
  }
  likeBtn.setAttribute('aria-label', likedByMe ? '取消爱心' : '贴个爱心');
  likeBtn.addEventListener('click', () => toggleLike(row.id));
  actions.appendChild(likeBtn);

  if (mine) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'comment-row__action';
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', () => setComposeMode(s, { type: 'edit', row }));
    actions.appendChild(editBtn);

    // 删除：两段式确认（本仓删除动作的统一规格，防误触）
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'comment-row__action comment-row__action--danger';
    delBtn.textContent = '删除';
    let armed = false;
    let armTimer = null;
    delBtn.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        delBtn.textContent = '再点一次确认';
        delBtn.classList.add('armed');
        clearTimeout(armTimer);
        armTimer = setTimeout(() => {
          armed = false;
          delBtn.textContent = '删除';
          delBtn.classList.remove('armed');
        }, 3000);
        return;
      }
      clearTimeout(armTimer);
      deleteComment(row);
    });
    actions.appendChild(delBtn);
  }

  main.appendChild(actions);
  el.appendChild(main);
  return el;
}

// ===== 写操作（乐观更新 + 失败回滚，全仓统一写法）=====

function submitComposer(s) {
  const text = (s.inputEl.value || '').trim();
  if (!text) return;
  if (s.mode && s.mode.type === 'edit') {
    submitEdit(s, s.mode.row, text);
    return;
  }
  const parent = s.mode && s.mode.type === 'reply' ? s.mode.row : null;
  submitNew(s, text, parent);
}

function addRowLocal(row) {
  const list = commentsByTodo[row.todoId] || (commentsByTodo[row.todoId] = []);
  list.push(row);
  commentsByTodo[row.todoId] = sortByCreatedAt(list);
}
/**
 * 用真实行替换乐观临时行（按旧 id 找位）。
 * ⚠️ 必须同时防"真实行已在列表里"：Realtime 回声可能**先于** REST 响应到达，
 * 此时 onCommentAdded 已按「作者+内容」把临时行换成了真实行 —— 若这里只看旧 id 找不到就 push，
 * 同一条留言会在缓存里出现两次（界面重复，直到下次补拉）。
 */
function replaceRowLocal(oldId, row) {
  const list = commentsByTodo[row.todoId];
  if (!list) return;
  const i = list.findIndex((c) => c.id === oldId);
  const j = list.findIndex((c) => c.id === row.id);
  if (j >= 0 && j !== i) {
    if (i >= 0) list.splice(i, 1); // 回声已换好了：丢掉残留的临时行，不 push
  } else if (i >= 0) {
    list[i] = row;
  } else {
    list.push(row);
  }
  commentsByTodo[row.todoId] = sortByCreatedAt(list);
}
function removeRowLocal(todoId, id) {
  const list = commentsByTodo[todoId];
  if (!list) return;
  commentsByTodo[todoId] = list.filter((c) => c.id !== id);
}

/** 发一条新留言（或回复） */
async function submitNew(s, text, parent) {
  const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const temp = {
    id: tempId,
    __temp: true,
    todoId: s.todoId,
    authorId: myId(),
    parentId: parent ? parent.id : null,
    content: text,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
  };
  addRowLocal(temp);
  s.inputEl.value = '';
  updateCounter(s);
  autoGrowInput(s);
  setComposeMode(s, null);
  refreshViews(s.todoId, 'bottom');
  try {
    const real = await db.createComment(s.todoId, text, myId(), parent ? parent.id : null);
    replaceRowLocal(tempId, real);
  } catch (err) {
    removeRowLocal(s.todoId, tempId);
    showToast('留言没发出去，再试试');
    console.error('[comments] 发送失败:', err && err.message);
  } finally {
    refreshViews(s.todoId);
  }
}

/** 改自己的一条留言 */
async function submitEdit(s, row, text) {
  const prevContent = row.content;
  const prevEdited = row.editedAt;
  row.content = text;
  row.editedAt = new Date().toISOString();
  s.inputEl.value = '';
  updateCounter(s);
  autoGrowInput(s);
  setComposeMode(s, null);
  refreshViews(s.todoId);
  try {
    const real = await db.updateComment(row.id, text);
    replaceRowLocal(row.id, real);
  } catch (err) {
    row.content = prevContent;
    row.editedAt = prevEdited;
    showToast('修改没保存上，再试试');
    console.error('[comments] 修改失败:', err && err.message);
  } finally {
    refreshViews(s.todoId);
  }
}

/** 软删除自己的一条留言（两段式确认在按钮上） */
async function deleteComment(row) {
  const prev = row.deletedAt;
  row.deletedAt = new Date().toISOString();
  refreshViews(row.todoId);
  showToast('留言已删除');
  try {
    await db.deleteComment(row.id);
  } catch (err) {
    row.deletedAt = prev;
    refreshViews(row.todoId);
    showToast('删除失败，再试试');
    console.error('[comments] 删除失败:', err && err.message);
  }
}

/** 贴 / 取消爱心 */
async function toggleLike(commentId) {
  const list = likesByComment[commentId] || (likesByComment[commentId] = []);
  const mineIdx = list.findIndex((l) => l.userId === myId());
  if (mineIdx >= 0) {
    const [removed] = list.splice(mineIdx, 1);
    refreshLikes(commentId);
    try {
      await db.removeCommentLike(commentId, myId());
    } catch (err) {
      list.push(removed);
      refreshLikes(commentId);
      console.error('[comments] 取消爱心失败:', err && err.message);
    }
    return;
  }
  const temp = {
    id: `tmp-${Date.now()}`,
    __temp: true,
    commentId,
    userId: myId(),
    createdAt: new Date().toISOString(),
  };
  list.push(temp);
  refreshLikes(commentId);
  try {
    const real = await db.addCommentLike(commentId, myId());
    if (real) {
      const i = list.findIndex((l) => l.id === temp.id);
      if (i >= 0) list[i] = real;
    }
    refreshLikes(commentId);
  } catch (err) {
    likesByComment[commentId] = list.filter((l) => l.id !== temp.id);
    refreshLikes(commentId);
    console.error('[comments] 贴爱心失败:', err && err.message);
  }
}

/** 爱心变化后只重绘列表（爱心不参与卡片徽标） */
function refreshLikes(commentId) {
  if (!sheetState) return;
  if (!document.querySelector(`.comment-row[data-id="${commentId}"]`)) return;
  renderThread(sheetState, { scroll: 'keep' });
}

// ===== Realtime 回调（由 realtime.js 调用）=====

/** 新留言（对方或自己的回声；自己的乐观临时行按内容认领替换） */
export function onCommentAdded(comment) {
  commentEventSeq++; // 本地已比任何在途补拉快照更新，见 refreshComments
  const list = commentsByTodo[comment.todoId] || (commentsByTodo[comment.todoId] = []);
  if (list.some((c) => c.id === comment.id)) return; // 同一行重复推送，幂等
  const tempIdx = list.findIndex(
    (c) => c.__temp && c.authorId === comment.authorId && c.content === comment.content
  );
  if (tempIdx >= 0) list[tempIdx] = comment; // 自己的乐观临时行 → 真实行
  else list.push(comment);
  commentsByTodo[comment.todoId] = sortByCreatedAt(list);

  // 弹层开着且是对方写的 → 即时已读（你正看着它出现），并滚到最新
  if (sheetState && sheetState.todoId === comment.todoId) {
    if (comment.authorId !== myId()) markSeen(comment.todoId, comment.createdAt);
    renderThread(sheetState, { scroll: 'keep' });
  }
  rerenderBadge(comment.todoId);
}

/** 留言被更新（改内容带 edited_at / 软删除带 deleted_at）——统一按行替换缓存 */
export function onCommentUpdated(comment) {
  commentEventSeq++;
  const list = commentsByTodo[comment.todoId];
  if (!list) {
    commentsByTodo[comment.todoId] = [comment];
  } else {
    const i = list.findIndex((c) => c.id === comment.id);
    if (i >= 0) list[i] = comment; else list.push(comment);
    commentsByTodo[comment.todoId] = sortByCreatedAt(list);
  }
  refreshViews(comment.todoId);
}

/** 留言被物理删除（罕见：仅"回收站彻底删除待办"的级联） */
export function onCommentRemoved(id) {
  commentEventSeq++;
  for (const [todoId, list] of Object.entries(commentsByTodo)) {
    if (list.some((c) => c.id === id)) {
      removeRowLocal(todoId, id);
      delete likesByComment[id]; // 级联删除的爱心
      refreshViews(todoId);
      return;
    }
  }
}

/** 爱心新增（按 commentId+userId 去重：自己贴的乐观临时行被真实行替换） */
export function onCommentLikeAdded(like) {
  commentEventSeq++;
  const list = likesByComment[like.commentId] || (likesByComment[like.commentId] = []);
  if (list.some((l) => l.id === like.id)) return;
  const tempIdx = list.findIndex((l) => l.__temp && l.userId === like.userId);
  if (tempIdx >= 0) list[tempIdx] = like; else list.push(like);
  refreshLikes(like.commentId);
}

/** 爱心取消（REPLICA IDENTITY FULL 下 DELETE 事件带完整旧行，comment_id 直接可用） */
export function onCommentLikeRemoved(likeId, commentId) {
  commentEventSeq++;
  let cid = commentId || null;
  if (!cid) {
    // 兜底：payload 缺 comment_id 时按 id 反查
    for (const [key, list] of Object.entries(likesByComment)) {
      if (list.some((l) => l.id === likeId)) { cid = key; break; }
    }
  }
  if (!cid) return;
  const list = likesByComment[cid];
  if (!list) return;
  likesByComment[cid] = list.filter((l) => l.id !== likeId);
  refreshLikes(cid);
}
