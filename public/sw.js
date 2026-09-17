/**
 * Service Worker — App Shell 缓存（仅 PWA 浏览器模式生效）
 *
 * ⚠️ 重要：Capacitor 原生 App 不依赖此 SW（WebView 加载的是 APK 内 assets），
 *    且热更新（@capgo/capacitor-updater）替换资源后，若 SW 仍缓存旧版本
 *    会导致前端拿到陈旧代码。因此 SW 内部对原生环境直接放行（不拦截）。
 *
 * 策略（仅浏览器 PWA）：
 *   - install：预缓存核心静态资源
 *   - fetch：导航请求网络优先；静态资源缓存优先回退网络
 *   - activate：清理旧缓存
 *   - 跨域请求（Supabase API/Realtime/Storage）一律走网络，绝不缓存
 */

const VERSION = 'v17'; // 热更新上线后递增，强制清理旧缓存
const CACHE = 'todo-shell-' + VERSION;

// 预缓存的核心资源（与实际 public/ 目录对齐）
const PRECACHE_URLS = [
  '/',
  '/login.html',
  '/css/style.css',
  '/css/login.css',
  '/js/app.js',
  '/js/login.js',
  '/js/db.js',
  '/js/realtime.js',
  '/js/state.js',
  '/js/timeline.js',
  '/js/theme.js',
  '/js/utils.js',
  '/js/update.js',
  '/js/vendor/supabase-js.esm.js',
  '/js/vendor/canvas-confetti.esm.min.js',
  '/favicon.svg',
  '/manifest.webmanifest',
];

// 检测是否运行在 Capacitor 原生 WebView 内
// 原生环境下 origin 是 https://localhost，且不走 SW 缓存
function isCapacitorNative() {
  return self.location && self.location.hostname === 'localhost' && self.location.protocol === 'https:';
}

self.addEventListener('install', (event) => {
  // 原生环境：跳过预缓存，直接 skipWaiting
  if (isCapacitorNative()) {
    self.skipWaiting();
    return;
  }
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => console.warn('[sw] 预缓存失败:', url, err.message))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 原生环境：完全不拦截，让请求直达（assets 本来就是本地文件，无需缓存）
  if (isCapacitorNative()) return;

  // 跨域请求（Supabase API/Realtime/Storage）一律走网络
  if (url.origin !== self.location.origin) return;

  // 只处理 GET
  if (req.method !== 'GET') return;

  // 导航请求（HTML 页面）：网络优先，失败时回退到缓存的 index
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // 静态资源：缓存优先，回退网络
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      });
    })
  );
});
