/**
 * Supabase Realtime 订阅（替代 Socket.IO）
 *
 * 监听 todos 表的 INSERT / UPDATE / DELETE，转发给 state 层。
 * 同时维护"在线状态"（订阅成功 = 在线）。
 *
 * 重要时序：
 *   订阅状态变 SUBSCRIBED 后，仍需 ~2-3 秒才真正开始推送。
 *   所以 app.js 启动时先拉一次 listTodos() 兜底，弥补订阅期间的事件。
 *
 * 自我回声处理：
 *   Supabase Realtime 会把本端的 INSERT/UPDATE/DELETE 也推回来，
 *   这里用 id 幂等去重 + state 比较避免重复/抖动。
 */

import { supabase } from './supabase.js';
import { sortTodos } from './state.js';
import { notify } from './notify.js';
import { toExternal, toNote, toReaction, toSticker } from './transforms.js';

// 字段转换（toExternal/toNote/toReaction/toSticker）已抽到 ./transforms.js
// （消除与 db.js 的双份维护，技术优化清单第6条）

/**
 * 初始化 Realtime 订阅
 * @param {Object} handlers
 * @param {()=>Array} handlers.getTodos
 * @param {(todos)=>void} handlers.setTodos
 * @param {(todo)=>void} handlers.notifyCompleted 远端完成时触发（用于动画）
 * @param {(online:boolean)=>void} handlers.setOnline
 * @param {()=>string} [handlers.getCurrentUserId] 当前用户 id（用于排除自己的回声、只在"对方"操作时通知）
 * @param {(userId:string)=>string} [handlers.displayNameOf] userId → 昵称（用于通知文案）
 * @param {(note)=>void} [handlers.onNoteAdded] 留言新增（daily_notes INSERT）
 * @param {(id:string)=>void} [handlers.onNoteRemoved] 留言删除（daily_notes DELETE）
 * @param {(note)=>void} [handlers.onNoteUpdated] 留言更新（daily_notes UPDATE，标记已读）
 * @param {(reaction)=>void} [handlers.onReactionAdded] 表情新增（reactions INSERT）
 * @param {(reactionId:string,todoId:string)=>void} [handlers.onReactionRemoved] 表情删除（reactions DELETE）
 * @param {(todo)=>void} [handlers.onRarityReveal] 对方开出的隐藏款首次推来（todos UPDATE，raritySeen=false 且非自己创建）
 * @param {(sticker)=>void} [handlers.onStickerUnlocked] 图鉴贴纸解锁（stickers INSERT）
 * @returns {Object} channel（用于 unsubscribe）
 */
export function initRealtime({ getTodos, setTodos, notifyCompleted, setOnline, getCurrentUserId, displayNameOf, onNoteAdded, onNoteRemoved, onNoteUpdated, onReactionAdded, onReactionRemoved, onRarityReveal, onStickerUnlocked, getInFlightIntent }) {
  let ready = false;

  /**
   * 触发"对方"操作的通知（只对非本人操作提醒）
   * @param {'added'|'completed'} type
   * @param {Object} todo
   * @param {string} actorUserId 操作者 id（createdBy 或 completedBy）
   */
  function maybeNotify(type, todo, actorUserId) {
    if (!getCurrentUserId || !displayNameOf) return;
    // 排除自己的操作（自我回声不提醒）
    if (!actorUserId || actorUserId === getCurrentUserId()) return;
    const name = displayNameOf(actorUserId) || '对方';
    const text = (todo.text || '').slice(0, 40);
    if (type === 'added') {
      notify('清单有新待办', `${name} 添加了：${text}`);
    } else {
      notify('待办已完成', `${name} 完成了：${text}`);
    }
  }

  const channel = supabase
    .channel('todos-changes')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'todos' },
      (payload) => {
        const todo = toExternal(payload.new);
        const todos = getTodos();
        // 幂等去重（本端插入会回声）
        if (todos.some((t) => t.id === todo.id)) return;
        setTodos(sortTodos([...todos, todo]));
        // 通知：对方新增了待办
        maybeNotify('added', todo, todo.createdBy);
        // 隐藏款揭晓：对方开出的隐藏款首次推来（raritySeen=false 且非自己创建）
        if (
          onRarityReveal &&
          todo.rarity && todo.rarity !== 'common' &&
          todo.raritySeen === false &&
          getCurrentUserId && todo.createdBy !== getCurrentUserId()
        ) {
          onRarityReveal(todo);
        }
      }
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'todos' },
      (payload) => {
        const todo = toExternal(payload.new);
        const todos = getTodos();
        // 软删除识别：deleted_at 从 null 变非 null，说明被移到回收站，从列表移除
        if (payload.new.deleted_at) {
          setTodos(todos.filter((t) => t.id !== todo.id));
          return;
        }
        const prev = todos.find((t) => t.id === todo.id);
        if (!prev) {
          // 没找到 prev（可能在订阅前已存在），当作 insert
          if (!todos.some((t) => t.id === todo.id)) {
            setTodos(sortTodos([...todos, todo]));
          }
          return;
        }
        // 竞态守卫：本端有飞行中的完成操作时，丢弃与最新意图相反的陈旧自我回声。
        // 否则乱序到达的回声（如第一次"完成"延迟回声）会把本地乐观状态覆盖回去，
        // 表现为"完成→取消→再点完成无反应"。
        if (getInFlightIntent) {
          const intent = getInFlightIntent(todo.id);
          if (intent !== undefined && intent !== todo.completed) {
            return; // 陈旧回声，忽略（本端乐观更新已是正确状态，await 会回来收尾）
          }
        }
        const becameCompleted = todo.completed && !prev.completed;
        setTodos(sortTodos(todos.map((t) => (t.id === todo.id ? todo : t))));
        if (becameCompleted && notifyCompleted) notifyCompleted(todo);
        // 通知：对方完成了待办
        if (becameCompleted) maybeNotify('completed', todo, todo.completedBy);
        // 隐藏款揭晓：对方开出的隐藏款首次推来（raritySeen=false 且非自己创建）→ 播惊喜提示
        if (
          onRarityReveal &&
          todo.rarity && todo.rarity !== 'common' &&
          todo.raritySeen === false &&
          getCurrentUserId && todo.createdBy !== getCurrentUserId()
        ) {
          onRarityReveal(todo);
        }
      }
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'todos' },
      (payload) => {
        const id = payload.old?.id;
        if (!id) return;
        setTodos(getTodos().filter((t) => t.id !== id));
      }
    )
    // ===== 每日留言板（daily_notes）=====
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'daily_notes' },
      (payload) => {
        const note = toNote(payload.new);
        if (!note || !onNoteAdded) return;
        onNoteAdded(note);
        // 悄悄留言：不发系统通知（破坏私密感与惊喜），只让顶栏图标安静亮起。
        // 对方下次打开 APP 自然会发现。
      }
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'daily_notes' },
      (payload) => {
        // 软删除识别：阅后即焚标记 deleted_at，按删除处理
        if (payload.new.deleted_at) {
          if (onNoteRemoved) onNoteRemoved(payload.new.id);
          return;
        }
        const note = toNote(payload.new);
        if (!note || !onNoteUpdated) return;
        onNoteUpdated(note);
      }
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'daily_notes' },
      (payload) => {
        const id = payload.old?.id;
        if (!id || !onNoteRemoved) return;
        onNoteRemoved(id);
      }
    )
    // ===== 任务表情反应（reactions）=====
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'reactions' },
      (payload) => {
        const reaction = toReaction(payload.new);
        if (!reaction || !onReactionAdded) return;
        onReactionAdded(reaction);
        // 表情不弹系统通知（太频繁），只 UI 动画反馈（由 onReactionAdded 内部处理）
      }
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'reactions' },
      (payload) => {
        // 默认 replica identity 下 DELETE 只带主键 id（无 todo_id），
        // todo_id 交给 reactions.onReactionRemoved 从本地缓存反查
        const id = payload.old?.id;
        if (!id || !onReactionRemoved) return;
        onReactionRemoved(id, payload.old?.todo_id);
      }
    )
    // ===== 收集图鉴（stickers）=====
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'stickers' },
      (payload) => {
        const sticker = toSticker(payload.new);
        if (!sticker || !onStickerUnlocked) return;
        onStickerUnlocked(sticker);
        // 图鉴解锁：双端都更新（共享图鉴），不弹系统通知（用 UI 红点 + Toast）
      }
    )
    .subscribe((status, err) => {
      // SUBSCRIBED / CLOSED / CHANNEL_ERROR / TIMED_OUT
      const online = status === 'SUBSCRIBED';
      if (online && !ready) ready = true;
      if (setOnline) setOnline(online);
      if (err) console.warn('[realtime] 订阅错误:', err.message);
    });

  return {
    channel,
    /** 取消订阅 */
    unsubscribe() {
      supabase.removeChannel(channel);
    },
  };
}

/**
 * 初始化 Realtime Presence（双方"此刻是否同时在线"检测）
 *
 * 独立 channel `online-presence`，与 todos-changes 互不干扰。
 * 每个用户 track 自己的 userId；sync 事件触发时检查对方是否在线。
 *
 * presence 是内存态：断线/关 APP 即 leave，无法跨会话。
 * 持久化的"今天来过"由 profiles.last_seen_at 负责（app.js 心跳写入）。
 *
 * @param {Object} opts
 * @param {string} opts.userId 自己的 id
 * @param {string} opts.partnerId 对方的 id
 * @param {(partnerOnline:boolean)=>void} opts.onPartnerOnline 对方上下线回调
 * @returns {Object} { unsubscribe }
 */
export function initPresence({ userId, partnerId, onPartnerOnline }) {
  let lastPartnerOnline = false;
  // 心跳间隔：每 15s 重新 track 一次（保持 presence 不被服务端清理）
  const HEARTBEAT_MS = 15000;

  const channel = supabase.channel('online-presence', {
    config: { presence: { key: userId } },
  });

  channel
    .on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      // presenceState 返回 { [key]: [{ userId, at }, ...] }
      // 检查 partnerId 是否出现在任意 key 的记录里
      const partnerOnline = Object.values(state).some((records) =>
        Array.isArray(records) && records.some((r) => r && r.userId === partnerId)
      );
      if (partnerOnline !== lastPartnerOnline) {
        lastPartnerOnline = partnerOnline;
        if (onPartnerOnline) onPartnerOnline(partnerOnline);
      }
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ userId, at: Date.now() });
      }
    });

  // 定时心跳：重新 track 刷新 presence（防止长时间不活动被清理）
  let heartbeatTimer = setInterval(async () => {
    try {
      await channel.track({ userId, at: Date.now() });
    } catch (e) {
      console.warn('[presence] 心跳 track 失败:', e.message);
    }
  }, HEARTBEAT_MS);

  // 页面可见性变化：切前台重新 track，切后台不处理（presence 自动超时清理）
  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      channel.track({ userId, at: Date.now() }).catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    channel,
    unsubscribe() {
      clearInterval(heartbeatTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      supabase.removeChannel(channel);
    },
    // H4: 暂停心跳（退后台节电，presence 由服务端超时自动清理）
    suspend() {
      clearInterval(heartbeatTimer);
    },
    // H4: 恢复心跳（回前台重新 track + 重挂定时器）
    resume() {
      clearInterval(heartbeatTimer);
      channel.track({ userId, at: Date.now() }).catch(() => {});
      heartbeatTimer = setInterval(async () => {
        try {
          await channel.track({ userId, at: Date.now() });
        } catch (e) {
          console.warn('[presence] 心跳 track 失败:', e.message);
        }
      }, HEARTBEAT_MS);
    },
  };
}
