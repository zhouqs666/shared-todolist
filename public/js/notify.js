/**
 * 通知层（本地通知，无推送服务）
 *
 * 设计思路：
 *   现有 PWA 已用 Supabase Realtime 实现实时同步。本模块负责"数据同步过来后提醒用户"，
 *   不依赖任何推送服务（JPush/FCM 都不需要，也就不需要厂商审核）。
 *
 *   - 在 Capacitor APP 内：用 @capacitor/local-notifications 弹系统通知（响铃+震动+状态栏）
 *   - 在网页/PWA 内：降级为静默（Toast 由 app.js 的 celebrateCompletion 负责，这里不重复）
 *
 * 防骚扰：
 *   - 只在 APP 切到后台/锁屏时弹系统通知（前台时用户正看着屏幕，不打扰）
 *   - 前后台状态由 app.js 通过 setForeground() 维护
 *
 * 实现说明（关键）：
 *   项目是无构建的纯静态站，不能直接 import '@capacitor/core'（裸模块名 WebView 无法解析）。
 *   因此用 vendor/capacitor.js（UMD 全局版）+ 两个插件 UMD 文件，它们会注册到 window.Capacitor。
 *   只在检测到 APP 环境时动态加载这些脚本，网页版零影响。
 */

// ===== 全局 Capacitor 对象（加载后存在）=====
let LocalNotifications = null;
let AppApi = null;
let isNative = false;

// 脚本加载状态（保证只加载一次）
let loadPromise = null;

/**
 * 动态加载 Capacitor vendor 脚本（按顺序：core → 插件）
 * 仅在 APP 环境调用，网页版不会触发。
 */
function loadCapacitorScripts() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const load = (src) =>
      new Promise((resolve, reject) => {
        // 已加载过则跳过
        const existing = document.querySelector(`script[src="${src}"]`);
        if (existing) {
          resolve();
          return;
        }
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`加载失败: ${src}`));
        document.head.appendChild(s);
      });

    // 顺序加载：core 必须先加载，创建 window.Capacitor
    await load('/js/vendor/capacitor.js');
    await load('/js/vendor/capacitor-local-notifications.js');
    await load('/js/vendor/capacitor-app.js');

    // 插件 UMD 会注册到 window.Capacitor.Plugins
    const cap = window.Capacitor;
    if (!cap || !cap.Plugins) {
      throw new Error('Capacitor 未正确初始化');
    }
    LocalNotifications = cap.Plugins.LocalNotifications;
    AppApi = cap.Plugins.App;
    // Capacitor.isNativePlatform() 判断是否在原生 APP 内
    isNative = !!(cap.isNativePlatform && cap.isNativePlatform());
  })().catch((err) => {
    console.warn('[notify] Capacitor 加载失败，通知降级为关闭:', err.message);
    isNative = false;
    loadPromise = null; // 允许重试
  });
  return loadPromise;
}

// APP 是否在前台（默认 true；后台/锁屏时弹通知）
let appInForeground = true;

/** 通知渠道（安卓 O+ 必需，首次调度时自动创建） */
const CHANNEL_ID = 'todo-reminders';
let channelReady = false;

async function ensureChannel() {
  if (!isNative || !LocalNotifications || channelReady) return;
  try {
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: '清单提醒',
      description: '对方添加或完成待办时提醒',
      importance: 4,           // High：响铃 + 弹出
      visibility: 1,           // Public：锁屏可见
      vibration: true,
    });
    channelReady = true;
  } catch (err) {
    console.warn('[notify] 创建通知渠道失败:', err);
  }
}

/**
 * 请求通知权限（安卓 13+ 需运行时申请 POST_NOTIFICATIONS）
 * 建议在用户登录成功后调用一次。
 */
export async function requestPermission() {
  if (!isNative || !LocalNotifications) return true;
  try {
    const { display } = await LocalNotifications.requestPermissions();
    return display === 'granted';
  } catch (err) {
    console.warn('[notify] 申请通知权限失败:', err);
    return false;
  }
}

/** 本地通知 id 自增（安卓要求每次通知 id 唯一，0 被系统保留） */
let notifSeq = 1;

/**
 * 弹一条本地通知（仅在 APP 内 + 非前台时真正弹出）
 * @param {string} title 通知标题
 * @param {string} body 通知正文
 */
export async function notify(title, body) {
  if (!isNative || !LocalNotifications) return;  // 网页或加载失败：no-op
  if (appInForeground) return;                    // 前台：不打扰（用户正看着屏幕）

  await ensureChannel();
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: notifSeq++,
          title,
          body,
          channelId: CHANNEL_ID,
          smallIcon: 'ic_stat_icon',
          // 品牌樱粉（--rose-500）；原 #ec4899 是 Tailwind pink-500，与色板不同源。
          // 与 capacitor.config.json 的 LocalNotifications.iconColor 保持一致。
          iconColor: '#e884a8',
          schedule: { at: new Date(Date.now() + 50) }, // 延迟 50ms，确保通知能弹出
        },
      ],
    });
  } catch (err) {
    console.warn('[notify] 调度通知失败:', err);
  }
}

/**
 * 设置 APP 前后台状态（由 appStateChange 监听 / visibilitychange 兜底调用）
 * @param {boolean} foreground
 */
export function setForeground(foreground) {
  appInForeground = foreground;
}

/**
 * 用 document.visibilityState 作为前后台判断的兜底（WebView 也生效）。
 * 原生 AppApi 监听失败、或非原生环境时使用。
 */
function bindVisibilityFallback() {
  const update = () => setForeground(document.visibilityState === 'visible');
  document.addEventListener('visibilitychange', update);
  update(); // 立即校准一次
}

/**
 * 初始化：加载 Capacitor 脚本，监听 APP 前后台切换。
 * 网页环境自动降级（isNative=false，所有通知方法变 no-op）。
 *
 * H5 修复：原来 appInForeground 仅靠 AppApi.addListener 更新，一旦监听失败/脚本加载失败
 * 就永远停在默认 true，导致通知静默失效。现在统一走 setForeground，并加 visibilitychange 兜底。
 */
export async function initNotify() {
  await loadCapacitorScripts();
  if (!isNative || !AppApi) {
    // 非原生 / 脚本加载失败：用 visibilitychange 兜底（虽 isNative=false 时通知本就不弹，但保持状态正确）
    bindVisibilityFallback();
    return;
  }
  try {
    AppApi.addListener('appStateChange', ({ isActive }) => {
      setForeground(isActive);
    });
  } catch (err) {
    console.warn('[notify] 监听前后台失败，降级为 visibilitychange:', err.message);
    bindVisibilityFallback();
  }
}

export { isNative };
