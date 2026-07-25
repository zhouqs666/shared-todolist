/**
 * Service Worker — App Shell 缓存
 *
 * 策略：
 *   - install：预缓存核心静态资源（HTML/CSS/JS/vendor）
 *   - fetch：缓存优先，回退网络（让 PWA 离线可打开外壳）
 *   - activate：清理旧缓存
 *
 * 注意：API 请求（Supabase 域名）和网络请求绝不缓存——
 * 走 network-only，保证数据实时性。
 */

const VERSION = 'v1';
const CACHE = 'todo-shell-' + VERSION;

// 预缓存的核心资源（相对于 scope 即 /）
const PRECACHE_URLS = [
  '/',
  '/login.html',
  '/css/style.css',
  '/css/login.css',
  '/js/app.js',
  '/js/login.js',
  '/js/supabase.js',
  '/js/db.js',
  '/js/auth.js',
  '/js/realtime.js',
  '/js/state.js',
  '/js/theme.js',
  '/js/utils.js',
  '/js/vendor/supabase-js.esm.js',
  '/js/vendor/canvas-confetti.esm.min.js',
  '/favicon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // 用 cache.addAll 失败一个就全失败，这里改成宽松模式：单个失败不影响其他
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

  // 跨域请求（Supabase API/Realtime）一律走网络
  if (url.origin !== self.location.origin) return;

  // 只处理 GET（POST/PATCH/DELETE 不缓存）
  if (req.method !== 'GET') return;

  // 导航请求（HTML 页面）：网络优先，失败时回退到缓存的 index
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html').then(r => r || caches.match('/')))
    );
    return;
  }

  // 静态资源：缓存优先，回退网络
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        // 同源 GET 成功响应才入缓存
        if (resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      });
    })
  );
});
