// 网络优先、缓存兜底：在线时永远拿最新版，断网时还能打开页面看回放。
// 只管本站的 GET；发给各家模型接口的请求一律不碰。
const CACHE = 'aiwolf-shell-v1';
const SHELL = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'icons/icon-192.png',
  'src/app.js', 'src/engine.js', 'src/agent.js', 'src/prompts.js', 'src/roles.js', 'src/personas.js', 'src/providers.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('index.html')))
  );
});
