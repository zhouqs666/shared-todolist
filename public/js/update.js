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

// 当前前端版本（**构建期注入** —— 仓库里的 index.html 恒为占位值 0.0.0，见其注释）
// 注意：不要改成 async！之前试过读 Updater.getBuiltinVersion()，但该接口在某些状态下抛异常
// 导致 fallback 到 meta 默认值 → 永远小于服务器版本 → 无限下载 reload 死循环（2026-09-05 血泪教训）。
// 【2026-09-14】版本真相的唯一来源是发布命令传入的版本号（+ app_versions 表），仓库不再持有它：
//   · release.mjs 打包 zip 时在**暂存副本**上注入 app-version（发布对仓库零改动）
//   · release-apk.mjs 在 cap sync 后给 APK 的 assets 注入 app-version = 线上最新 web 版本
// 占位值 0.0.0 是 fail-safe：漏注入只会「多重启一次」，不会变成「本地偏高 → 永远收不到更新」。
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

// ===== No.X 印记：这个 App 累计迭代了多少次 =====

/** 数据来源：两条发布通道各一张版本表（缺一不可 —— 只数热更新会漏掉壳更新） */
const COUNT_TABLES = ['app_versions', 'app_native_versions'];

/**
 * 查「这个 App 累计迭代了多少次」—— 热更新 + 壳更新**统一累计**，两人看到同一个数。
 *
 * ── 口径（2026-09-16 修正，此前数错了 29 次）──────────────────────
 *   取两张版本表的**全部行数**相加，**不带 `enabled` 过滤**，只增不减。
 *
 * ── 为什么不能按 `enabled` 过滤 ──────────────────────────────────
 * `enabled` 是「客户端还能不能拿到这一版」的**可见性开关**（下线止损 / 回滚撤回误发布都靠它），
 * 不是「这一版发过没有」的历史事实。按 enabled 数时，每下线一版这个数字就 −1 ——
 * 而它要表达的是「走到今天一共迭代了多少次」，是给两个人看的纪念数字，只能增不能减。
 * 实测：按 enabled = 129，全量 = 158，差的 29 正是被下线的行（26 个壳版本 + 3 个热更新）。
 *
 * ── 为什么不能用「这台设备更新过几次」 ────────────────────────────
 * 那是每台手机各算各的：谁少更新一次就少 1，换机 / 重装 / 清数据归零。
 * 而这个印记的初衷是「双方看到同一个数」⇒ 只能以服务端的发布历史为准。
 *
 * ── 返回 null 的含义 ────────────────────────────────────────────
 * 查不到（客户端未注入 / 网络失败 / 计数没回来 / 两表都空）⇒ 调用方**不显示**印记。
 * 刻意**不兜底**成 1：未登录时 anon 角色对这两张表一行都读不到，兜底就会把「查不到」
 * 显示成一个具体的错误数字（`No.1` 就是这么来的 —— 错数字比没有数字更糟）。
 *
 * @param {object} client 已注入的 supabase 客户端（显式传入 ⇒ 与模块级 supabaseClient 解耦，回归可用假客户端钉住口径）
 * @returns {Promise<number|null>} 累计次数；null = 拿不到（调用方不要显示）
 */
export async function getTotalUpdateCount(client) {
  if (!client) return null;
  try {
    const results = await Promise.all(COUNT_TABLES.map(
      (table) => client.from(table).select('id', { count: 'exact', head: true }),
    ));
    // count 不是数字 ⇒ 这次没数起来（报错，或被策略挡成空），宁可不显示也不要一个错数字
    if (results.some((r) => !r || r.error || typeof r.count !== 'number')) return null;
    const total = results.reduce((sum, r) => sum + r.count, 0);
    return total > 0 ? total : null;
  } catch (err) {
    console.warn('[update] 累计迭代次数查询失败（No.X 印记不显示）:', err && err.message);
    return null;
  }
}
