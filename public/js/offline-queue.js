/**
 * 离线写入队列（MVP：仅 addTodo）
 *
 * 目标：断网时添加待办不丢失，联网后自动补发。
 * 范围刻意收窄到 addTodo（最高频、最简单），其它操作（完成/编辑/删除）离线时仍提示"当前离线"。
 *
 * 机制：
 *   1. addTodo 失败（判为离线）→ 本地乐观显示一条 pending 待办（半透明 + 待同步标）+ 入队 localStorage
 *   2. 网络恢复（online 事件）或下次冷启动 → 串行重放队列，逐条 db.createTodo
 *   3. 每条成功 → 用真实 todo 替换本地 pending，出队；失败 → 保留待下次重试
 *
 * pending 待办的 id 用 "offline-<ts>-<rand>" 前缀，与真实 UUID 天然区分，
 * 重放成功后由 app.js 用真实 todo 替换（Realtime 回推也按真实 id 幂等去重，互不冲突）。
 */

const KEY = 'youai_offline_queue';

/** 读取队列（localStorage 损坏时兜底返回空数组） */
export function getOfflineQueue() {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('[offline] 读取队列失败（已重置）:', e.message);
    return [];
  }
}

/** 写入队列 */
export function setOfflineQueue(queue) {
  try {
    localStorage.setItem(KEY, JSON.stringify(queue));
  } catch (e) {
    console.warn('[offline] 写入队列失败:', e.message);
  }
}

/** 入队一条 addTodo 操作 */
export function enqueueOffline(op) {
  const q = getOfflineQueue();
  q.push(op);
  setOfflineQueue(q);
}

/** 移除一条（按 localId） */
export function removeOfflineOp(localId) {
  setOfflineQueue(getOfflineQueue().filter((op) => op.localId !== localId));
}

/**
 * 判断一个错误是否由「离线 / 网络不可达」引起。
 * 优先看 navigator.onLine，再用错误消息兜底（Supabase 离线时 fetch 抛 "Failed to fetch"）。
 */
export function isOfflineError(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const msg = String((err && (err.message || err)) || '').toLowerCase();
  return /failed to fetch|networkerror|network error|load failed|internet disconnected|err_internet_disconnected/.test(msg);
}
