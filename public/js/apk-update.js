/**
 * App 内 APK 更新（原生壳更新）客户端
 *
 * UI 形态（UICraft delight + animate 
 *   - 入口：顶栏图鉴左侧的呼吸下载箭头（14px，4s 循环微晃）
 *   - 展开：点图标 → 图标缩放一下 → 从图标位置弹出 200px 小面板 → 图标跳进面板顶部
 *   - 面板：跳进的下载箭头（28px） + 诗意短句 + [更新] 按钮 + No.X 淡化印记
 *   - 下载中：图标变心跳（幅度随进度变）+ 按钮 disabled + 进度条心跳
 *   - 强制更新：急促呼吸（2s 循环 ±4°）+ 面板不能关闭
 *   - 关闭：点面板外缩回顶栏图标位置（scale + translateY 反转动画）
 */

import { compareVersions } from './update.js';

// ===== 依赖注入 =====
let supabaseClient = null;
export function setApkUpdateSupabase(client) {
  supabaseClient = client;
}

// ===== 工具 =====
function getPlugin(name) {
  if (!window.Capacitor || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) {
    return null;
  }
  const plugins = window.Capacitor.Plugins || {};
  return plugins[name] || null;
}

function log(stage, detail = '') {
  console.info(`[apk-update] ${stage}${detail ? ': ' + detail : ''}`);
}

function formatMB(bytes) {
  if (!bytes || bytes <= 0) return '';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// ===== 查总更新次数（壳更新 + 热更新）=====
export async function getTotalUpdateCount() {
  try {
    const { count: shellCount } = await supabaseClient
      .from('app_native_versions')
      .select('id', { count: 'exact', head: true })
      .eq('enabled', true);
    const { count: bundleCount } = await supabaseClient
      .from('app_versions')
      .select('id', { count: 'exact', head: true })
      .eq('enabled', true);
    return (shellCount || 0) + (bundleCount || 0) || 1;
  } catch (_) {
    return 1;
  }
}

// ===== 诗意短句池（壳更新专属，8 条）=====

// ===== 读本地壳版本 =====
// 必须用原生 App.getInfo()：读 APK 真实 versionName，不受热更新 bundle 影响。
// 血泪教训：读 meta 时，热更新 bundle 里的 index.html 是发布时的快照，壳版本永远过期
// → 图标永久残留 + 无限重装同一版本（2026-09-04）。
// meta 仅作浏览器/调试兜底。
async function getLocalShellVersion() {
  const App = getPlugin('App');
  if (App && App.getInfo) {
    try {
      const info = await App.getInfo();
      if (info && /^\d+(\.\d+)+$/.test(info.version)) {
        log('壳版本（App.getInfo）', info.version);
        return info.version;
      }
    } catch (e) {
      log('App.getInfo 失败，回退 meta', e && e.message);
    }
  }
  const meta = document.querySelector('meta[name="shell-version"]')?.content
    || document.querySelector('meta[name="app-version"]')?.content
    || '0.0.0';
  log('壳版本（meta 兜底）', meta);
  return meta;
}

// ===== 检查更新 =====
export async function checkNativeUpdate() {
  const Installer = getPlugin('ApkInstaller');
  const entry = document.getElementById('apkUpdateEntry');
  // 先隐藏，确认有更新再显示（避免图标残留）
  if (entry) entry.hidden = true;
  if (!Installer) return null;
  if (!supabaseClient) {
    log('supabase 未注入，跳过');
    return null;
  }

  const localVersion = await getLocalShellVersion();

  try {

    const { data, error } = await supabaseClient
      .from('app_native_versions')
      .select('version_name, version_code, storage_path, apk_size_bytes, apk_sha256, notes, is_force_update, min_supported_version')
      .eq('enabled', true)
      .order('released_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) { log('查询失败（已忽略）', error.message); return null; }
    if (!data) return null;
    if (compareVersions(data.version_name, localVersion) <= 0) return null;

    const isForce = data.is_force_update === true
      || (data.min_supported_version && compareVersions(localVersion, data.min_supported_version) < 0);

    log('发现壳更新', `${localVersion} → ${data.version_name}${isForce ? '（强制）' : ''}`);

    // 显示顶栏入口图标 + 绑定点击（只绑一次）
    const entry = document.getElementById('apkUpdateEntry');
    if (entry) {
      entry.hidden = false;
      entry.classList.toggle('apk-entry--urgent', isForce);
      if (!entry.dataset.bound) {
        entry.dataset.bound = '1';
        entry.addEventListener('click', (e) => {
          e.stopPropagation();
          if (entry.classList.contains('apk-entry--hide')) return;
          showNativeUpdatePanel({
            localVersion, versionName: data.version_name, versionCode: data.version_code,
            storagePath: data.storage_path, sizeBytes: data.apk_size_bytes || null,
            sha256: data.apk_sha256 || null, notes: data.notes || '', isForce,
          });
        });
      }
    }

    return {
      localVersion,
      versionName: data.version_name,
      versionCode: data.version_code,
      storagePath: data.storage_path,
      sizeBytes: data.apk_size_bytes || null,
      sha256: data.apk_sha256 || null,
      notes: data.notes || '',
      isForce,
    };
  } catch (err) {
    log('检查异常（已忽略）', err && err.message);
    return null;
  }
}

// ===== 渲染面板（顶栏图标 → 跳进面板）=====
export function showNativeUpdatePanel(update, handlers = {}) {
  if (!update || document.querySelector('.apk-panel')) return;
  const Installer = getPlugin('ApkInstaller');
  if (!Installer) return;

  const isForce = !!update.isForce;
  let state = 'idle';
  let apkPath = null;
  let appStateHandle = null;
  let progressHandle = null;

  const entry = document.getElementById('apkUpdateEntry');
  if (!entry) return;

  // ---------- 面板 DOM ----------
  const panel = document.createElement('div');
  panel.className = 'apk-panel' + (isForce ? ' apk-panel--force' : '');

  // 定位：从 entry 位置弹出
  const entryRect = entry.getBoundingClientRect();
  const panelLeft = entryRect.left + entryRect.width / 2 - 100; // 200px 宽，左对齐图标中心
  const panelTop = entryRect.bottom + 8; // 图标下方 8px

  panel.style.left = panelLeft + 'px';
  panel.style.top = panelTop + 'px';

  // 面板头部：从顶栏跳进的下载箭头
  const headIcon = document.createElement('div');
  headIcon.className = 'apk-panel__icon';
  headIcon.innerHTML = entry.querySelector('svg').outerHTML;
  panel.appendChild(headIcon);

  // 短句标题
  const phrase = document.createElement('div');
  phrase.className = 'apk-panel__phrase';
  phrase.textContent = "有新版本可用";
  panel.appendChild(phrase);

  // 进度条（默认隐藏，下载中显示）
  const progressWrap = document.createElement('div');
  progressWrap.className = 'apk-panel__progress';
  progressWrap.hidden = true;
  const progressBar = document.createElement('div');
  progressBar.className = 'apk-panel__progress-bar';
  const progressFill = document.createElement('i');
  progressBar.appendChild(progressFill);
  progressWrap.appendChild(progressBar);
  panel.appendChild(progressWrap);

  // 提示文字
  const hint = document.createElement('div');
  hint.className = 'apk-panel__hint';
  hint.hidden = true;
  panel.appendChild(hint);

  // 更新按钮
  const primaryBtn = document.createElement('button');
  primaryBtn.type = 'button';
  primaryBtn.className = 'apk-panel__btn';
  primaryBtn.textContent = '更新';
  panel.appendChild(primaryBtn);

  // No.X 淡化印记
  const countEl = document.createElement('div');
  countEl.className = 'apk-panel__count';
  countEl.textContent = '…';
  panel.appendChild(countEl);

  // 强制更新遮罩（点击不关闭）
  if (isForce) {
    const backdrop = document.createElement('div');
    backdrop.className = 'apk-panel__backdrop';
    backdrop.addEventListener('click', (e) => { e.stopPropagation(); });
    document.body.appendChild(backdrop);
  }

  document.body.appendChild(panel);

  requestAnimationFrame(() => {
    panel.classList.add('apk-panel--show');
    entry.classList.add('apk-entry--hide'); // 顶栏图标淡出，面板图标显现
  });

  // 非强制更新：3s 后自动关闭（不是推迟）
  let autoCloseTimer = null;
  if (!isForce) {
    autoCloseTimer = setTimeout(() => {
      if (state === 'idle') closePanel();
    }, 3000);
  }

  // 点面板外关闭（非强制）
  function onOutside(e) {
    if (!isForce && state === 'idle' && !panel.contains(e.target) && !entry.contains(e.target)) {
      closePanel();
    }
  }
  document.addEventListener('click', onOutside);

  // 点顶栏图标也可以关闭面板（toggle）
  function onEntryClick(e) {
    if (state !== 'downloading') {
      e.stopPropagation();
      closePanel();
    }
  }
  entry.addEventListener('click', onEntryClick);

  getTotalUpdateCount().then((n) => {
    countEl.textContent = `No.${n}`;
  });

  // ---------- 函数 ----------
  function clearAutoClose() {
    if (autoCloseTimer) { clearTimeout(autoCloseTimer); autoCloseTimer = null; }
  }

  function closePanel(keepEntryHidden = false) {
    clearAutoClose();
    document.removeEventListener('click', onOutside);
    entry.removeEventListener('click', onEntryClick);
    if (appStateHandle && appStateHandle.remove) {
      try { appStateHandle.remove(); } catch (_) {}
      appStateHandle = null;
    }
    if (progressHandle && progressHandle.remove) {
      try { progressHandle.remove(); } catch (_) {}
      progressHandle = null;
    }
    panel.classList.remove('apk-panel--show');
    if (keepEntryHidden) {
      // 更新已启动（唤起系统安装器），永久隐藏入口图标
      // 用户若取消安装，前台切回时 checkNativeUpdate() 会重新判定是否显示
      entry.hidden = true;
    } else {
      entry.classList.remove('apk-entry--hide');
    }
    // 强制更新遮罩也移除
    const bd = document.querySelector('.apk-panel__backdrop');
    if (bd) bd.remove();
    setTimeout(() => { panel.remove(); }, 300);
  }

  function setHint(text) {
    hint.hidden = !text;
    hint.textContent = text || '';
  }

  async function ensureInstallPermission() {
    try {
      const res = await Installer.canInstallApks();
      if (res && res.allowed) return true;
    } catch (_) { /* 老系统无此接口，当作允许 */ }
    setHint('首次安装需要开启「允许来自此来源的应用」');
    primaryBtn.textContent = '去开启';
    try { await Installer.openInstallPermissionSettings(); } catch (_) {}
    const App = getPlugin('App');
    if (App && App.addListener && !appStateHandle) {
      appStateHandle = await App.addListener('appStateChange', ({ isActive }) => {
        if (!isActive || state !== 'idle') return;
        Installer.canInstallApks().then((res) => {
          if (res && res.allowed && state === 'idle') {
            if (appStateHandle && appStateHandle.remove) {
              try { appStateHandle.remove(); } catch (_) {}
            }
            appStateHandle = null;
            setHint('');
            primaryBtn.textContent = '更新';
            startDownload();
          }
        }).catch(() => {});
      });
    }
    return false;
  }

  async function startDownload() {
    if (state === 'downloading') return;
    const allowed = await ensureInstallPermission();
    if (!allowed) return;

    state = 'downloading';
    clearAutoClose();
    primaryBtn.disabled = true;
    primaryBtn.textContent = '下载中…';
    progressWrap.hidden = false;
    setHint('');
    panel.classList.add('apk-panel--downloading');

    try {
      const { data: signed, error: signErr } = await supabaseClient.storage
        .from('app_updates')
        .createSignedUrl(update.storagePath, 3600);
      if (signErr || !signed || !signed.signedUrl) throw new Error('签名 URL 生成失败');

      progressHandle = await Installer.addListener('apkDownloadProgress', ({ progress, loaded, total }) => {
        const p = progress >= 0 ? progress : 0;
        progressFill.style.width = p + '%';
        // 心跳幅度随进度变化：0-25% →1.06, 25-50%→1.09, 50-75%→1.12, 75-100%→1.15
        let beat = 1.06;
        if (p >= 75) beat = 1.15;
        else if (p >= 50) beat = 1.12;
        else if (p >= 25) beat = 1.09;
        headIcon.style.setProperty('--beat-scale', beat);
        progressFill.style.setProperty('--beat-scale', beat);
      });

      log('下载中', update.versionName);
      const res = await Installer.download({ url: signed.signedUrl, sha256: update.sha256 || null });
      apkPath = res && res.path;

      progressFill.style.width = '100%';
      progressFill.style.setProperty('--beat-scale', 1.2); // 下载完最后一次心跳最大
      progressWrap.hidden = true;
      setHint('已准备好安装');
      primaryBtn.disabled = false;
      primaryBtn.textContent = '安装';

      await Installer.install({ path: apkPath });
      state = 'launched';
      closePanel(true); // 唤起安装器后面板自动关闭，并隐藏入口图标（更新已完成）
      log('已唤起系统安装器');
    } catch (err) {
      state = 'idle';
      panel.classList.remove('apk-panel--downloading');
      primaryBtn.disabled = false;
      primaryBtn.textContent = '重试';
      progressWrap.hidden = true;
      const isSha = /sha256/i.test(String(err && err.message));
      setHint(isSha
        ? '校验未通过，请重试'
        : '下载失败，请检查网络');
      log('下载失败', err && err.message);
    } finally {
      if (progressHandle && progressHandle.remove) {
        try { progressHandle.remove(); } catch (_) {}
      }
      progressHandle = null;
      headIcon.style.removeProperty('--beat-scale');
    }
  }

  primaryBtn.addEventListener('click', () => {
    if (state === 'downloading') return;
    if (state === 'launched') {
      if (apkPath) Installer.install({ path: apkPath }).catch(() => {});
      return;
    }
    startDownload();
  });
}

// ===== 前台切回检查（60s 节流） =====
let lastForegroundCheck = 0;
export function bindForegroundCheck() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - lastForegroundCheck < 60_000) return;
    lastForegroundCheck = now;
    checkNativeUpdate().then((update) => {
      // checkNativeUpdate 内部已显示图标
      // 只有强制更新才自动弹面板；非强制等用户点图标
      if (update && update.isForce && !document.querySelector('.apk-panel')) {
        showNativeUpdatePanel(update);
      }
    }).catch(() => {});
  });
}
