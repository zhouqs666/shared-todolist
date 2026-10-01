/**
 * 待办提醒 —— 纯逻辑层（无 DOM / 无插件依赖，Node 单测直接 import）
 *
 * 拆出纯函数的原因：提醒的对账逻辑写错不会报错，只会「该响的不响」，
 * 且只在真机到点才暴露。可判定的部分（范围命中 / 通知 id 派生 / 对账 diff /
 * 快捷档）全部收在这里，由 scripts/test_reminder_logic.mjs 钉住。
 * reminder.js 负责 DOM/插件副作用，本文件绝不 import 任何浏览器 API。
 *
 * 数据形状：入参 todo 是 transforms.toExternal 的 camelCase 形状
 * （reminderAt / reminderScope / reminderBy），不是 DB 行。
 */

/** 提醒范围（相对 remind_by 设置者）：both=双方都响 / self=仅设置者 / partner=仅对方 */
export const REMIND_SCOPES = ['both', 'self', 'partner'];

/** 快捷档（分钟）—— 写死的入口，改这里要同步 scripts/test_reminder_logic.mjs 的钉住断言 */
export const QUICK_OPTIONS = [5, 10, 15, 30];

/**
 * 对账时判定「已调度时刻」与「期望时刻」是否等同的容差。
 * 原生层把 at 序列化到 AlarmManager 再读回，可能有亚秒级漂移；
 * 容差太小 → 每次对账都误判「变了」而反复重排（无意义的通知抖动）。
 */
export const REMINDER_SYNC_TOLERANCE_MS = 1500;

/**
 * 快捷档的提醒时刻：now + N 分钟。
 * @param {number} minutes QUICK_OPTIONS 中的档位
 * @param {Date} [now] 可注入当前时间（测试用），默认取系统时间
 */
export function quickOptionAt(minutes, now = new Date()) {
  return new Date(now.getTime() + minutes * 60 * 1000);
}

/**
 * 由 todo id 派生确定性的本地通知 id。
 *
 * 为什么是确定性派生而不是自增序号：取消/重排时必须能从待办反推出通知 id
 * （插件按 id 取消），自增序号需要额外维护 id 映射（热更新/进程重启后丢失）。
 * 取 UUID 前 7 位 hex → 值域 < 2^28：不会撞 int32 符号位，也不会撞上
 * notify.js 即时通知用的自增小序号（从 1 起，量级差 6 个数量级以上）。
 * 碰撞概率：2^28 值域下 50 条待办的生日碰撞 ≈ 5e-6，可忽略；
 * 万一碰撞的后果只是两条待办共享一个通知 id（互相覆盖），不构成数据问题。
 *
 * @param {string} todoId 待办 id（UUID；离线占位 id 非 hex → 返回 0）
 * @returns {number} 通知 id；无效应输入返回 0（0 由调用方当「无 id」处理）
 */
export function notificationIdFor(todoId) {
  if (!todoId) return 0;
  const hex = String(todoId).replace(/-/g, '').slice(0, 7);
  const n = parseInt(hex, 16);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 判断本机用户是否应该为这条待办调度提醒。
 * 一票否决项在前（完成/软删/离线占位/缺字段），再判时间，最后判范围命中。
 *
 * @param {Object} todo camelCase 待办对象
 * @param {string|null} myUserId 本机用户 id
 * @param {Date} [now] 可注入当前时间（测试用）
 * @returns {boolean}
 */
export function shouldScheduleReminder(todo, myUserId, now = new Date()) {
  if (!todo || !myUserId) return false;
  if (todo.completed || todo.deletedAt) return false;
  // 离线占位待办：无真实服务端 id，提醒不进离线队列（见 offline-queue 刻意只覆盖 addTodo），
  // 这里再挡一道，防止任何路径给它挂上提醒。
  if (typeof todo.id !== 'string' || todo.id.startsWith('offline-')) return false;
  if (!todo.reminderAt || !todo.reminderScope || !todo.reminderBy) return false;
  const at = new Date(todo.reminderAt).getTime();
  if (!Number.isFinite(at) || at <= now.getTime()) return false; // 过去/无效 → 不调度（过期不补弹）
  switch (todo.reminderScope) {
    case 'both':
      return true;
    case 'self':
      return todo.reminderBy === myUserId;
    case 'partner':
      // 双人应用：「对方」= 与设置者不同的那一个用户
      return todo.reminderBy !== myUserId;
    default:
      return false; // 未知 scope → fail-closed
  }
}

/**
 * 徽标置灰判断：提醒时刻已过（本端打开时来不及响的那类）。
 * 无提醒返回 false（没有提醒就没有「过期」态）。
 */
export function isReminderExpired(todo, now = new Date()) {
  if (!todo || !todo.reminderAt) return false;
  const at = new Date(todo.reminderAt).getTime();
  return Number.isFinite(at) && at <= now.getTime();
}

/**
 * 徽标显示文案：今天 → 「HH:mm」；跨天 → 「M/D HH:mm」。
 * @param {string|Date|null} reminderAt 提醒时间
 * @param {Date} [now] 可注入当前时间（测试用）
 * @returns {string}
 */
export function formatReminderTime(reminderAt, now = new Date()) {
  if (!reminderAt) return '';
  const d = new Date(reminderAt);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/**
 * 读取一个 pending 通知记录的「已调度触发时刻」（毫秒时间戳），读不到返回 null。
 * 兼容三种形状：Date / ISO 字符串 / 毫秒数（原生 JSON 读回的形态不定）。
 */
function pendingAtMs(pending) {
  const raw = pending && pending.schedule && pending.schedule.at;
  if (raw === undefined || raw === null) return null;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 对账计划：把「本机当前已调度的通知」与「当前数据下应该存在的通知」对齐，
 * 算出多退少补。幂等调用是硬要求 —— 每次数据变化/回前台都会跑一遍，
 * 没有差异时必须产出空计划（否则渲染一次重排一次，通知抖动）。
 *
 * 关键分支：**同 id 改时间必须重排** —— 通知 id 由 todo id 派生、不随时间变，
 * 只按 id 比较会把「改了提醒时间」误判成「无需动」，到点仍按旧时刻响。
 * 所以除 id 集合外还要比触发时刻（容差内视为未变）。
 *
 * @param {Array<{id:number, schedule?:{at?:any}}>|null} pendingNotifications
 *        插件 getPending() 返回的已调度通知列表
 * @param {Array<Object>} todos 全量待办（camelCase）
 * @param {string|null} myUserId 本机用户 id
 * @param {Date} [now] 可注入当前时间（测试用）
 * @returns {{toCancel:number[], toSchedule:Array<{id:number, at:Date}>}}
 */
export function planReminderSync(pendingNotifications, todos, myUserId, now = new Date()) {
  // 期望集合：id → 期望触发时刻(ms)
  const expected = new Map();
  for (const t of todos || []) {
    if (shouldScheduleReminder(t, myUserId, now)) {
      const id = notificationIdFor(t.id);
      if (id > 0) expected.set(id, new Date(t.reminderAt).getTime());
    }
  }
  // 已调度集合：id → 已调度时刻(ms 或 null=读不到)
  const pendingMap = new Map();
  for (const p of pendingNotifications || []) {
    if (!p || typeof p.id !== 'number') continue; // 非法记录跳过，不误取消
    pendingMap.set(p.id, pendingAtMs(p));
  }

  const toCancel = [];
  const toSchedule = [];
  for (const [id, haveAt] of pendingMap) {
    const wantAt = expected.get(id);
    const drifts = haveAt === null || wantAt === undefined
      || Math.abs(wantAt - haveAt) > REMINDER_SYNC_TOLERANCE_MS;
    if (drifts) toCancel.push(id);
  }
  for (const [id, wantAt] of expected) {
    const haveAt = pendingMap.get(id);
    if (haveAt === undefined || haveAt === null
        || Math.abs(haveAt - wantAt) > REMINDER_SYNC_TOLERANCE_MS) {
      toSchedule.push({ id, at: new Date(wantAt) });
    }
  }
  return { toCancel, toSchedule };
}
