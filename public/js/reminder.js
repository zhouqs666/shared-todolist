/**
 * 到点提醒（本地通知调度层）
 *
 * 与 notify.js 的分工：
 *   · notify.js —— 「数据同步类」即时提醒（对方添加/完成待办）：前台静默，仅后台弹。
 *   · reminder.js —— 「用户主动设置」的到点提醒：OS 级 AlarmManager 调度
 *     （LocalNotifications.schedule({ schedule: { at } })），App 被杀、从未打开都由系统弹，
 *     前台也弹（用户主动要的提醒没有"打扰"一说）。
 *
 * 数据流（为什么对账而不是只在设置时调度一次）：
 *   提醒存在 todos 表（remind_at/remind_scope/remind_by），两台设备各自同步到同一行数据、
 *   各自调度本机通知。本机的调度必须与数据持续对齐 —— 完成/删除/改时间/改范围/换账号登录、
 *   设备重启后插件自恢复的旧调度 —— 任何一边变了都要多退少补。对账计划由
 *   reminder-logic.planReminderSync 纯函数算出（有单测），这里只执行副作用。
 *
 * 环境降级：
 *   · 原生 APP：完整功能（调度/取消/对账）。
 *   · 网页：所有调度 no-op；UI 入口隐藏（浏览器一关没有常驻进程，做不了到点提醒）。
 *   · E2E 钩子（?e2e_reminder=1，localStorage 持久以跨过登录跳转）：网页也启用 UI 入口，
 *     调度/取消走内存 stub（window.__reminderTestLog），Playwright 可断言完整 UI 流程
 *     与对账行为；真实弹出只能真机验证（浏览器环境不存在系统通知）。
 */

import { isNative, getLocalNotifications } from './notify.js';
import {
  notificationIdFor,
  planReminderSync,
} from './reminder-logic.js';
import { showToast } from './toast.js';

// ===== 通知渠道（与 notify.js 的同步提醒渠道分开，用户可在系统设置里分别管理）=====
const CHANNEL_ID = 'todo-due';
let channelReady = false;

/** 对账防抖：realtime 事件可能连发（整列表重放），每次都 getPending 是无谓的原生调用 */
const SYNC_DEBOUNCE_MS = 300;

// ===== E2E stub（内存 pending 集合，形状与原生 getPending 一致）=====
const E2E_KEY = 'youai_e2e_reminder';
const stubPending = new Map(); // 通知 id → 触发时刻(ms)
const testLog = { scheduled: [], canceled: [], syncCount: 0 };

// 钩子识别（模块加载时就做，早于登录检查）：URL 参数置位 + localStorage 持久。
// 为什么不能放进 initReminder：未登录访问 index 会被 auth 踢去 login 页（init 中途 return），
// 那样 E2E 永远没机会写标记 —— 登录成功整页跳转又会丢查询参数，两边都堵死。
try {
  if (new URLSearchParams(window.location.search).get('e2e_reminder') === '1') {
    window.localStorage.setItem(E2E_KEY, '1');
  }
} catch (_) { /* localStorage 不可用（隐私模式等）→ 钩子关闭，不影响生产路径 */ }

let pluginInstance = null; // LocalNotifications 插件（native 下经 notify.js 的加载链取得）
let syncTimer = null;

/** 提醒 UI 入口是否可用（长按菜单项 / 徽标 / 面板） */
export function reminderUiEnabled() {
  return e2eMode || isNative;
}

/**
 * 初始化：读 E2E 钩子标记（URL 参数已在模块加载时落 localStorage，见上）；
 * 原生环境预热插件与通知渠道。
 * 由 app.js 在 initNotify() 之后调用（vendor 脚本加载链幂等，先后无强约束）。
 */
export async function initReminder() {
  try {
    e2eMode = window.localStorage.getItem(E2E_KEY) === '1';
  } catch (_) {
    e2eMode = false;
  }
  if (e2eMode) {
    // 供 Playwright 断言：调度/取消记录 + 当前 stub 中"已调度"的通知 id
    window.__reminderTestLog = {
      scheduled: testLog.scheduled,
      canceled: testLog.canceled,
      get pendingIds() { return [...stubPending.keys()]; },
    };
    return;
  }
  pluginInstance = await getLocalNotifications();
  if (!pluginInstance) return; // 网页：全 no-op
  await ensureChannel();
}

/** 建通知渠道（安卓 O+ 必需；importance HIGH = 响铃 + 弹出） */
async function ensureChannel() {
  if (!pluginInstance || channelReady) return;
  try {
    await pluginInstance.createChannel({
      id: CHANNEL_ID,
      name: '到点提醒',
      description: '待办设置的提醒时间到了',
      importance: 4, // High：响铃 + 弹出（前台也弹由系统 heads-up 决定）
      visibility: 1, // Public：锁屏可见
      vibration: true,
    });
    channelReady = true;
  } catch (err) {
    console.warn('[reminder] 创建通知渠道失败（首次调度时会重试）:', err && err.message);
  }
}

/**
 * 调度一条到点提醒（原生：AlarmManager；E2E：内存 stub）。
 * @param {Object} todo camelCase 待办（须带 reminderAt）
 * @returns {Promise<boolean>} 是否成功受理（失败时调用方决定要不要提示用户）
 */
export async function scheduleTodoReminder(todo) {
  if (!todo || !todo.reminderAt) return false;
  const at = new Date(todo.reminderAt);
  if (at.getTime() <= Date.now()) return false; // 过去时刻不调度（过期不补弹）
  const id = notificationIdFor(todo.id);
  if (!id) return false;

  if (e2eMode) {
    testLog.scheduled.push({ id, todoId: todo.id, at: todo.reminderAt });
    stubPending.set(id, at.getTime());
    return true;
  }
  if (!pluginInstance) return false;
  try {
    await ensureChannel();
    await pluginInstance.schedule({
      notifications: [
        {
          id,
          title: '待办提醒',
          body: (todo.text || '').slice(0, 80),
          channelId: CHANNEL_ID,
          smallIcon: 'ic_stat_icon',
          // 品牌樱粉，与 capacitor.config.json 的 LocalNotifications.iconColor 一致
          iconColor: '#e884a8',
          // allowWhileIdle：Doze 深度休眠下也按点触发（原生插件映射 setExactAndAllowWhileIdle）
          schedule: { at, allowWhileIdle: true },
        },
      ],
    });
    return true;
  } catch (err) {
    // 最常见根因：精确闹钟权限被系统/用户关掉（Android 14+ 默认拒绝 SCHEDULE_EXACT_ALARM）。
    // manifest 已声明 USE_EXACT_ALARM（13+ 安装即授），这里兜住被手动关闭的残余场景。
    // 会话内只提示一次：对账路径反复重试调度，逐次弹 toast 会骚扰。
    console.warn('[reminder] 调度失败:', err && err.message);
    if (!scheduleFailWarned) {
      scheduleFailWarned = true;
      showToast('提醒可能不准时：请在系统设置允许本 App 的「闹钟和提醒」权限', { urgent: true });
    }
    return false;
  }
}

/**
 * 取消一条待办已调度的提醒（完成/删除/清除提醒时调用；对账路径经 planReminderSync 批量取消）。
 */
export async function cancelTodoReminder(todoId) {
  const id = notificationIdFor(todoId);
  if (!id) return;
  if (e2eMode) {
    if (stubPending.has(id)) {
      testLog.canceled.push({ id, todoId });
      stubPending.delete(id);
    }
    return;
  }
  if (!pluginInstance) return;
  try {
    await pluginInstance.cancel({ notifications: [{ id }] });
  } catch (err) {
    console.warn('[reminder] 取消调度失败:', err && err.message);
  }
}

/**
 * 全量对账（多退少补）：把本机已调度通知与当前数据对齐。
 * 挂点（覆盖所有数据变化路径，见 reminder-logic.planReminderSync 的幂等保证）：
 *   · app.js applyServerTodoList（整份拉取落地的唯一出口：首次/对账/回前台）
 *   · realtime.js todos INSERT/UPDATE/DELETE（对方操作 + 本端回声）
 *   · 保存/清除提醒成功后（立即生效，不等防抖也安全）
 *   · 完成待办的乐观更新后（取消提醒不等回声 —— 断线时完成，到点不该响）
 *
 * @param {Array<Object>} todos 当前全量待办（camelCase）
 * @param {string|null} myUserId 本机用户 id（范围命中判断）
 */
export function syncReminders(todos, myUserId) {
  if (e2eMode) testLog.syncCount++;
  if (!e2eMode && !pluginInstance) return; // 网页（非钩子）：no-op
  const snapshot = Array.isArray(todos) ? todos.slice() : [];
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    doSync(snapshot, myUserId || null).catch((err) => {
      console.warn('[reminder] 对账异常:', err && err.message);
    });
  }, SYNC_DEBOUNCE_MS);
}

/** 调度失败的用户提示只发一次（会话级去重，见 scheduleTodoReminder 的 catch） */
let scheduleFailWarned = false;

async function doSync(todos, myUserId) {
  let pendingNotifications;
  if (e2eMode) {
    pendingNotifications = [...stubPending].map(([id, at]) => ({ id, schedule: { at: new Date(at) } }));
  } else {
    const { notifications } = await pluginInstance.getPending();
    pendingNotifications = notifications || [];
  }
  const plan = planReminderSync(pendingNotifications, todos, myUserId);
  if (plan.toCancel.length) {
    if (e2eMode) {
      for (const id of plan.toCancel) {
        stubPending.delete(id);
        testLog.canceled.push({ id, todoId: null, viaSync: true });
      }
    } else {
      await pluginInstance.cancel({ notifications: plan.toCancel.map((id) => ({ id })) });
    }
  }
  for (const item of plan.toSchedule) {
    const todo = todos.find((t) => notificationIdFor(t.id) === item.id);
    if (!todo) continue;
    if (e2eMode) {
      testLog.scheduled.push({ id: item.id, todoId: todo.id, at: todo.reminderAt, viaSync: true });
      stubPending.set(item.id, item.at.getTime());
    } else {
      await scheduleTodoReminder(todo);
    }
  }
}
