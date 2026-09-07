/**
 * 热更新（OTA）客户端
 *
 * 配合 @capgo/capacitor-updater 自建模式工作：
 *   1. App 启动时查 Supabase 的 app_versions 表，拿最新启用版本
 *   2. 和本地当前版本比较，若有新版 → 生成签名 URL → downloadAndInstall
 *   3. 标记待生效，下次冷启动自动加载新资源（静默更新，不打断用户）
 *
 * 实现说明：
 *   - 项目无构建，浏览器原生 ESM 不能 import 裸模块名 '@capgo/capacitor-updater'
 *   - 但热更新只在原生 Capacitor 环境有意义，而原生框架会自动把所有插件
 *     注册到 window.Capacitor.Plugins.CapacitorUpdater，无需前端额外加载 JS
 *   - 所以这里直接通过 window.Capacitor.Plugins.CapacitorUpdater 访问
 *
 * 容错：
 *   - 浏览器环境 / 插件未注册 → no-op
 *   - 任何失败静默降级，绝不影响 App 正常使用
 *   - 插件内置回滚：连续崩溃 3 次自动回上个版本（resetWhenUpdate:true）
 */

// 当前前端版本（发布脚本会写入 index.html 的 meta）
// 注意：不要改成 async！之前试过读 Updater.getBuiltinVersion()，但该接口在某些状态下抛异常
// 导致 fallback 到 meta 默认值 → 永远小于服务器版本 → 无限下载 reload 死循环（2026-09-05 血泪教训）。
// 正确做法：release.mjs 打包 zip 时注入 meta + 同步更新 public/index.html 的 meta，
// 确保下次 APK 构建时壳内置的 meta 和最新 bundle 版本一致。
function getLocalVersion() {
  const meta = document.querySelector('meta[name="app-version"]');
  return (meta && meta.content) || '0.0.0';
}

// 语义化版本比较：返回 -1 / 0 / 1（apk-update.js 也复用，壳/bundle 两套更新同一套比较语义）
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

// 取得 CapacitorUpdater 插件实例（仅原生环境存在）
function getUpdater() {
  if (!window.Capacitor || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) {
    return null;
  }
  const plugins = window.Capacitor.Plugins || {};
  return plugins.CapacitorUpdater || null;
}

// Supabase 客户端（由 app.js 注入，避免循环依赖）
let supabaseClient = null;
export function setUpdateSupabase(client) {
  supabaseClient = client;
}

let isChecking = false;

// 轻量日志（保留 console 排查能力，便于以后诊断）
function logStage(stage, detail = '') {
  console.info(`[update] ${stage}${detail ? ': ' + detail : ''}`);
}

/**
 * 检查并下载热更新（若存在新版）。
 * 仅原生环境运行；浏览器、插件未就绪、无新版 → 返回 null。
 * 成功下载后，下次冷启动自动加载新资源。
 * @returns {Promise<{version:string, uuid?:string} | null>}
 */
export async function checkForUpdate() {
  const Updater = getUpdater();
  if (!Updater) return null;
  if (!supabaseClient) {
    console.warn('[update] supabase 客户端未注入，跳过热更新检查');
    return null;
  }
  if (isChecking) return null;
  isChecking = true;

  try {
    const localVersion = getLocalVersion();
    logStage('查询中', localVersion);

    // 查最新启用版本（按 released_at 降序取第一条）
    const { data, error } = await supabaseClient
      .from('app_versions')
      .select('version, storage_path, min_app_version, notes')
      .eq('enabled', true)
      .order('released_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    // 服务端版本必须大于本地才更新
    if (compareVersions(data.version, localVersion) <= 0) return null;

    // min_app_version 兼容性检查
    if (data.min_app_version && compareVersions(localVersion, data.min_app_version) < 0) {
      logStage('跳过', `当前 ${localVersion} 低于最低要求 ${data.min_app_version}`);
      return null;
    }

    // 生成签名下载 URL
    const { data: signed, error: signErr } = await supabaseClient.storage
      .from('app_updates')
      .createSignedUrl(data.storage_path, 60);

    if (signErr) throw signErr;
    if (!signed || !signed.signedUrl) throw new Error('签名 URL 生成失败');

    // 下载（@capgo/capacitor-updater 自建模式：download → set → reload）
    logStage('下载中', data.version);
    const bundle = await Updater.download({ url: signed.signedUrl, version: data.version });

    // 标记使用此 bundle
    await Updater.set({ id: bundle.id });
    logStage('已就绪', `${data.version} 准备重载`);

    // reload 前显示原生 SplashScreen（粉色爱心启动图），覆盖 WebView 销毁期间的空白。
    // SplashScreen 是原生的，不会被 reload 杀掉，会一直显示到新版本启动后 hide。
    // 这样用户看到的是"粉色爱心 → 平滑过渡"，而不是"黑屏闪一下"。
    const SplashScreen = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SplashScreen;
    if (SplashScreen) {
      try {
        await SplashScreen.show({ autoHide: false, fadeInDuration: 300, showDuration: 0 });
      } catch (e) { /* 静默 */ }
    }

    // 给 SplashScreen 一点时间渲染
    await new Promise((r) => setTimeout(r, 400));

    await Updater.reload();
    return { version: data.version, id: bundle.id, reloaded: true };
  } catch (err) {
    console.warn('[update] 热更新检查失败（已忽略）:', err && err.message);
    return null;
  } finally {
    isChecking = false;
  }
}

/**
 * 判断当前运行的 bundle 是否是热更新来的（而非 APK 壳内置的）。
 * 通过对比 current().bundle.version 和 getBuiltinVersion().version。
 * 用于决定是否播放"更新完成"欢迎动画——不依赖 localStorage（bundle 切换时 localStorage 不共享）。
 * 仅原生环境有效，浏览器返回 false。
 * @returns {Promise<{hot:boolean, version:string} | null>}
 */
export async function getCurrentBundleInfo() {
  const Updater = getUpdater();
  if (!Updater) return null;
  try {
    const [cur, builtin] = await Promise.all([
      Updater.current(),
      Updater.getBuiltinVersion().catch(() => null),
    ]);
    const currentVersion = cur && cur.bundle && cur.bundle.version;
    const builtinVersion = builtin && builtin.version;
    // 当前版本存在且与内置版本不同 → 是热更新来的
    const hot = !!(currentVersion && builtinVersion && currentVersion !== builtinVersion);
    return { hot, version: currentVersion || builtinVersion || null };
  } catch (err) {
    console.warn('[update] getCurrentBundleInfo 失败:', err && err.message);
    return null;
  }
}

/**
 * 通知插件当前版本已成功加载（解除"待生效"标记，防止下次启动被回滚）。
 * 应在 App 启动后、确认 UI 正常运行时调用。
 * CapacitorUpdater.notifyAppReady() 的封装。
 */
export async function notifyAppReady() {
  const Updater = getUpdater();
  if (!Updater) return;
  try {
    await Updater.notifyAppReady();
  } catch (err) {
    console.warn('[update] notifyAppReady 失败:', err && err.message);
  }
}
