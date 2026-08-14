/**
 * 任务表情回应（自绘 SVG 版）
 *
 * 重新定位：不是"互动装饰"，而是待办之间的轻量回应。
 *   - 表情池精简为 1 个：爱心（唯一的纯情感表达，不被"完成"覆盖）
 *   - OK/点赞因语义与"完成"冗余，已从入口移除；但其历史数据仍保留渲染
 *   - 入口藏在长按菜单（action sheet）里，完成后默认底部什么都不显示
 *   - 只有当至少有人贴了一个，底部才浮现极小的已贴胶囊（无提示文字）
 *
 * 数据：emoji 字段存稳定 key（heart），渲染时映射到 SVG。
 * 兼容旧数据：👌❤️👍 → 分别映射到 cheer/heart/hug（保留语义近似）。
 */

import { db } from './db.js';

/** 表情定义：key → { label, svg }。
 *  heart 是当前唯一可新增的表情（action sheet 入口）。
 *  ok/thumbs 仅保留 svg 供【历史数据】胶囊渲染（normalizeKey 后能查到），不再能新增。
 *  heart 用自绘单色 SVG（currentColor，随主题染色）。
 */
const REACTIONS = {
  heart: {
    label: '爱心',
    svg: '<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M12 21s-7.5-4.7-7.5-10.2C4.5 7.6 7 5.5 9.8 5.5c1.4 0 2.7.7 3.2 1.8.5-1.1 1.8-1.8 3.2-1.8 2.8 0 5.3 2.1 5.3 5.3C21.5 16.3 12 21 12 21z" fill="currentColor"/></svg>',
  },
  ok: {
    label: 'OK',
    // 历史数据渲染用（twemoji 👌，已不再能新增）
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="100%" height="100%"><path fill="#EF9645" d="M23.216 20.937l-1.721-6.86-3.947-8.816c-.502-1.297.143-2.756 1.44-3.257 1.296-.506 2.756.143 3.258 1.44l6.203 15.769-5.233 1.724z"/><path fill="#FFDC5D" d="M31.565 18.449c-.488-2.581-1.988-6.523-1.988-6.523L23.79 1.437C23.164.195 21.648-.303 20.407.322c-1.242.626-1.742 2.141-1.115 3.383l5.33 9.547c.013.022 1.413 5.491 1.413 5.491-1.078-.995-2.607-2.359-4.015-3.618-3.098-2.772-4.936-3.811-4.936-3.811-.71-.443-1.179-.506-2.132-.059L9.08 13.823c-.157.078-.29.188-.395.329l-2.313 3.086c-.893 1.067-.752 2.655.315 3.547 1.066.893 2.653.75 3.548-.314.048-.058 1.78-2.56 1.936-2.64 1.037-.533 2.965-1.447 3.808-1.42.897.029 6.281 5.957 6.281 5.957.206.259.23.618.06.902l-2.915 5.228c-.079.131-.193.236-.33.303l-2.674 1.5c-.154.075-.328.099-.496.067l-5.27-2.272c-.262-.113-.48-.32-.592-.583-.787-1.85-.898-3.619-.899-3.639-.065-1.39-1.244-2.463-2.634-2.398-1.387.056-2.463 1.243-2.398 2.633.013.263.351 5.64 4.727 9.292 2.528 2.108 5.654 2.924 9.649 2.387 4.612-.619 7.469-1.233 11.506-9.558 1.117-2.305 1.903-6.024 1.571-7.781z"/></svg>',
  },
  thumbs: {
    label: '点赞',
    // 历史数据渲染用（已不再能新增）
    svg: '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor"><path d="M7 10v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1zm12.5-1H14V5.5C14 4.1 12.9 3 11.5 3h-.4a.9.9 0 0 0-.9.9L9.6 9c-.1.6-.5 1.1-1 1.5L7 12v7h9.5c1.4 0 2.6-1 2.9-2.4l1-5C20.7 10.3 19.8 9 18.5 9z"/></svg>',
  },
};

/** 旧 emoji/key → 新 key 兼容映射（保留语义近似） */
const LEGACY_MAP = { '❤️': 'heart', '👍': 'thumbs', '👌': 'ok', hug: 'thumbs', cheer: 'ok' };
/** 反向：key → [key, ...同义旧值]（用于删除时兼容清理旧数据） */
const KEY_SYNONYMS = {
  heart: ['heart', '❤️'],
  ok: ['ok', '👌', 'cheer'],
  thumbs: ['thumbs', '👍', 'hug'],
};

/** 当前可贴的表情池（action sheet 入口遍历用）。精简到只留爱心。 */
export const REACTION_EMOJIS = ['heart'];

/** 把任意 emoji/key 规整为新 key（兼容旧数据） */
function normalizeKey(emoji) {
  if (REACTIONS[emoji]) return emoji;
  return LEGACY_MAP[emoji] || emoji;
}

/** 取某 key 的 SVG（供渲染） */
export function getReactionSvg(key) {
  return (REACTIONS[normalizeKey(key)] || {}).svg || '';
}

/** 取某 key 的 label */
export function getReactionLabel(key) {
  return (REACTIONS[normalizeKey(key)] || {}).label || key;
}

/** @type {Object<string, Array>} todoId → reactions[] */
let reactionsByTodo = {};
/** @type {Object|null} 当前用户 */
let currentUser = null;
/** @type {Function|null} 对方贴表情时的回调（app.js 用于该 todo 上的小动画） */
let onRemoteReactionFn = null;

/**
 * 初始化表情反应
 * @param {Object} opts
 * @param {Object} opts.currentUser { id }
 * @param {(todoId:string)=>void} [opts.onRemoteReaction] 对方贴表情时触发（该 todo 上小动画）
 */
export async function initReactions({ currentUser: user, onRemoteReaction }) {
  currentUser = user;
  onRemoteReactionFn = onRemoteReaction || null;
  try {
    const all = await db.listReactions();
    reactionsByTodo = {};
    all.forEach((r) => {
      (reactionsByTodo[r.todoId] ||= []).push(r);
    });
  } catch (err) {
    console.error('[reactions] 加载表情失败:', err);
  }
}

/** 当前用户是否已对该 todo 贴过某表情（按 normalizeKey 匹配，兼容旧数据） */
export function isMyReaction(todoId, key) {
  const list = reactionsByTodo[todoId] || [];
  const normKey = normalizeKey(key);
  return list.some(
    (r) => normalizeKey(r.emoji) === normKey && r.userId === (currentUser && currentUser.id)
  );
}

/**
 * 切换表情：贴 / 取消（供 action sheet 调用）
 * @param {string} todoId
 * @param {string} emoji
 * @param {boolean} currentlyMine 当前是否已贴
 */
export async function toggleReaction(todoId, emoji, currentlyMine) {
  if (currentlyMine) {
    removeLocal(todoId, emoji, currentUser && currentUser.id);
    rerenderTodo(todoId);
    try {
      // 删除时传同义数组，兼容清理旧 emoji 数据
      const synonyms = KEY_SYNONYMS[emoji] || [emoji];
      await db.removeReaction(todoId, synonyms, currentUser.id);
    } catch (err) {
      console.error('[reactions] 取消表情失败:', err);
    }
  } else {
    const temp = {
      id: 'tmp-' + Date.now(),
      todoId,
      userId: currentUser && currentUser.id,
      emoji,
      createdAt: new Date().toISOString(),
    };
    addLocal(temp);
    rerenderTodo(todoId);
    try {
      await db.addReaction(todoId, emoji, currentUser.id);
    } catch (err) {
      removeLocal(todoId, emoji, currentUser && currentUser.id);
      rerenderTodo(todoId);
      console.error('[reactions] 贴表情失败:', err);
    }
  }
}

/**
 * 在给定 todo 的 li 节点上渲染表情区。
 * 由 app.js renderItem/updateItem 调用。
 *
 * 克制规则：
 *   - 未完成 → 不显示（移除）
 *   - 已完成但无人贴过 → 不显示（保持干净，入口在长按菜单里）
 *   - 已完成且有人贴过 → 底部显示极小的已贴胶囊（无任何提示文字）
 */
export function renderReactions(li, todo) {
  if (!li) return;
  const existing = li.querySelector('.todo__reactions');

  // 未完成：移除表情区
  if (!todo.completed) {
    if (existing) existing.remove();
    return;
  }

  const list = reactionsByTodo[todo.id] || [];
  // 按 normalizeKey 聚合统计（兼容旧 emoji 数据）
  const counts = {};
  const mine = new Set();
  list.forEach((r) => {
    const key = normalizeKey(r.emoji);
    counts[key] = (counts[key] || 0) + 1;
    if (r.userId === (currentUser && currentUser.id)) mine.add(key);
  });
  const hasAny = Object.keys(counts).length > 0;

  // 无人贴过 → 不显示（彻底克制，完成后保持干净）
  if (!hasAny) {
    if (existing) existing.remove();
    return;
  }

  // 有人贴过 → 显示极小胶囊（自绘 SVG，跨设备一致）
  // 挂到 meta 行末尾（靠右），与创建者·时间共用一行，不再额外占垂直空间
  let wrap = existing;
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'todo__reactions';
    const meta = li.querySelector('.todo__meta');
    if (!meta) return;
    meta.appendChild(wrap);
  }
  wrap.innerHTML = '';
  Object.keys(counts).forEach((key) => {
    const count = counts[key];
    const isMine = mine.has(key);
    const chip = document.createElement('span');
    chip.className = 'todo__reaction' + (isMine ? ' todo__reaction--mine' : '');
    chip.innerHTML = getReactionSvg(key);
    if (count > 1) {
      const countSpan = document.createElement('span');
      countSpan.className = 'todo__reaction-count';
      countSpan.textContent = count;
      chip.appendChild(countSpan);
    }
    wrap.appendChild(chip);
  });
}

/** 局部缓存增删 */
function addLocal(reaction) {
  (reactionsByTodo[reaction.todoId] ||= []).push(reaction);
}
/** 按 normalizeKey 移除（兼容旧 emoji 数据：删 heart 会同时清掉旧 ❤️） */
function removeLocal(todoId, key, userId) {
  const list = reactionsByTodo[todoId];
  if (!list) return;
  const normKey = normalizeKey(key);
  reactionsByTodo[todoId] = list.filter(
    (r) => !(r.todoId === todoId && normalizeKey(r.emoji) === normKey && r.userId === userId)
  );
}

/** 重新渲染某个 todo 的表情区（找到 DOM 节点调用 renderReactions） */
function rerenderTodo(todoId) {
  const li = document.querySelector(`.todo[data-id="${todoId}"]`);
  if (!li) return;
  const completed = li.classList.contains('todo--done');
  renderReactions(li, { id: todoId, completed });
}

// ===== Realtime 回调（由 realtime.js 调用）=====

/** 对方/自己贴了表情（Realtime 推送） */
export function onReactionAdded(reaction) {
  const wasMineBefore = (reactionsByTodo[reaction.todoId] || []).some(
    (r) => r.emoji === reaction.emoji && r.userId === reaction.userId
  );
  addLocal(reaction);
  rerenderTodo(reaction.todoId);
  // 对方贴的（非自己）→ 触发该 todo 上的小动画
  if (
    !wasMineBefore &&
    reaction.userId !== (currentUser && currentUser.id) &&
    onRemoteReactionFn
  ) {
    onRemoteReactionFn(reaction.todoId);
  }
}

/** 表情被取消（Realtime 推送） */
export function onReactionRemoved(reactionId, todoId) {
  const list = reactionsByTodo[todoId];
  if (!list) return;
  reactionsByTodo[todoId] = list.filter((r) => r.id !== reactionId);
  rerenderTodo(todoId);
}
