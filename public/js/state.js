/**
 * 全局状态管理
 * - todos：当前待办列表（唯一真相）
 * - online：socket 连接状态
 * - stickers：图鉴贴纸（两人共享，平行状态）
 *
 * 订阅模型（footgun 收口，技术清单第5条延伸）：
 *   ① 旧 API：setRenderFn / setOnlineFn / setCompleteFn / setStickersRenderFn
 *      保留「单订阅替换」语义，向后 100% 兼容；重复注册会 console.warn 提示迁移。
 *   ② 新 API：subscribe(name, fn) → unsubscribe
 *      支持多订阅、返回 unsubscribe 便于 cleanup（与 app.js beforeunload 治理对齐）。
 *   ③ 内部统一用 Set，dispatch 遍历；try/catch 包裹避免一个订阅者抛错中断其他订阅者。
 *
 * 抽出此模块是为了让 realtime.js 与 app.js 共享同一份状态，避免 import 循环依赖。
 */

let todos = [];
let online = true;
let stickers = [];

// 订阅者集合（Set 支持多订阅；旧 setXxxFn 用 clear+add 模拟「替换」语义）
const renderFns = new Set();
const onlineFns = new Set();
const completeFns = new Set();
const stickersRenderFns = new Set();

/** 遍历订阅者集合；try/catch 防单个抛错中断其他订阅者 */
function dispatch(set, arg) {
  for (const fn of set) {
    try {
      fn(arg);
    } catch (e) {
      console.error('[state] subscriber threw:', e);
    }
  }
}

export function getTodos() {
  return todos;
}

export function setTodos(next) {
  todos = next;
  dispatch(renderFns, todos);
}

export function isOnline() {
  return online;
}

export function setOnline(v) {
  online = v;
  dispatch(onlineFns, online);
}

/**
 * 旧 API：注册渲染回调（单订阅替换语义）
 * 重复调用会替换前一个并 console.warn 提示迁移到 subscribe()。
 * 保留是为了不动 app.js 既有调用；新代码请用 subscribe('render', fn)。
 */
export function setRenderFn(fn) {
  if (renderFns.size > 0) {
    console.warn('[state] renderFn 已存在，setRenderFn 将替换之。多订阅请改用 subscribe("render", fn)。');
  }
  renderFns.clear();
  if (fn) renderFns.add(fn);
}

/** 旧 API：注册在线状态回调（同 setRenderFn 模式） */
export function setOnlineFn(fn) {
  if (onlineFns.size > 0) {
    console.warn('[state] onlineFn 已存在，setOnlineFn 将替换之。多订阅请改用 subscribe("online", fn)。');
  }
  onlineFns.clear();
  if (fn) onlineFns.add(fn);
}

/**
 * 旧 API：注册"远端完成"回调
 * 当 socket 收到 todo:updated 且从"未完成→已完成"时触发，用于播放完成动画
 * @param {(todo: Object)=>void} fn
 */
export function setCompleteFn(fn) {
  if (completeFns.size > 0) {
    console.warn('[state] completeFn 已存在，setCompleteFn 将替换之。多订阅请改用 subscribe("complete", fn)。');
  }
  completeFns.clear();
  if (fn) completeFns.add(fn);
}

/**
 * 新 API：订阅状态切片变化，返回 unsubscribe（用于 cleanup）。
 * 与 app.js beforeunload 的「保存返回值统一 cleanup」治理模型对齐。
 * @param {'render'|'online'|'complete'|'stickers'} name
 * @param {(arg)=>void} fn
 * @returns {()=>void} unsubscribe
 */
export function subscribe(name, fn) {
  const set = SUBSCRIBERS[name];
  if (!set) throw new Error(`[state] 未知订阅名: ${name}`);
  if (typeof fn !== 'function') throw new Error('[state] subscribe: fn 必须是函数');
  set.add(fn);
  return () => set.delete(fn);
}

const SUBSCRIBERS = {
  render: renderFns,
  online: onlineFns,
  complete: completeFns,
  stickers: stickersRenderFns,
};

/** 通知"完成"事件（由 realtime.js 调用） */
export function notifyCompleted(todo) {
  dispatch(completeFns, todo);
}

/** PRD §4.2 Q2 排序：置顶在上 → 未完成在上 → 新的在上 → 完成的下沉 */
export function sortTodos(list) {
  return [...list].sort((a, b) => {
    // 第一优先级：置顶项在前
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    // 第二优先级：未完成在前
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    // 第三优先级：新的在前
    return b.createdAt.localeCompare(a.createdAt);
  });
}

// ===== 本端完成操作的飞行追踪（竞态保护）=====
// 解决"完成→取消完成→再点无法完成"的根因：Realtime 自我回声乱序到达，
// 会把陈旧的 DB 真实状态覆盖回本地乐观状态（例：第一次"完成"的回声延迟
// 到达，把刚"取消"的乐观状态又改回完成态，导致下一次点完成被幂等检查误判）。
//
// 这里追踪每个 id 的飞行中操作：Realtime 回声在"与本端最新意图相反"时被忽略。
// 用计数器而非单值：同一 id 可能有多个并发 toggleComplete（用户连点），
// 只有全部收尾后才解除保护。
const inFlight = new Map(); // id → { intent: boolean, count: number }

/** 发起一次完成切换：记录意图并增加飞行计数（供 Realtime 回声守卫） */
export function beginToggle(id, intent) {
  const cur = inFlight.get(id) || { intent, count: 0 };
  cur.intent = intent;
  cur.count += 1;
  inFlight.set(id, cur);
}

/** 一次完成切换收尾：减少计数，归零后清除保护 */
export function endToggle(id) {
  const cur = inFlight.get(id);
  if (!cur) return;
  cur.count -= 1;
  if (cur.count <= 0) inFlight.delete(id);
}

/** 该 id 当前飞行中的最新意图；无飞行操作返回 undefined（Realtime 不再守卫） */
export function getInFlightIntent(id) {
  const cur = inFlight.get(id);
  return cur ? cur.intent : undefined;
}

// ===== 图鉴状态（stickers，两人共享）=====

export function getStickers() {
  return stickers;
}

export function setStickers(next) {
  stickers = next;
  dispatch(stickersRenderFns, stickers);
}

/** 增量更新：新增或替换一张贴纸（Realtime 解锁回调用） */
export function addOrUpdateSticker(sticker) {
  if (!sticker) return;
  const idx = stickers.findIndex((s) => s.stickerKey === sticker.stickerKey);
  if (idx >= 0) {
    stickers[idx] = sticker;
  } else {
    stickers = [...stickers, sticker];
  }
  dispatch(stickersRenderFns, stickers);
}

/** 旧 API：注册图鉴渲染回调（同 setRenderFn 模式） */
export function setStickersRenderFn(fn) {
  if (stickersRenderFns.size > 0) {
    console.warn('[state] stickersRenderFn 已存在，setStickersRenderFn 将替换之。多订阅请改用 subscribe("stickers", fn)。');
  }
  stickersRenderFns.clear();
  if (fn) stickersRenderFns.add(fn);
}
