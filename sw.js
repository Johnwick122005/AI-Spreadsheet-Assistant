/*======================================================================
  Service Worker — Offline Caching
======================================================================*/

const CACHE_NAME = 'aispreadsheet-v29';
const PRECACHE_TIMEOUT = 8000;
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './fonts.css',
  './fonts/libre-franklin-400.woff2',
  './fonts/source-serif-4-400.woff2',
  './fonts/spline-sans-mono-400.woff2',
  './app.js',
  './engine.js',
  './storage.js',
  './ai.js',
  './research.js',
  './markdown.js',
  './grid.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
];

// Live APIs must never be served from (or written to) the offline cache.
const NETWORK_ONLY_HOSTS = new Set([
  'r.jina.ai',
  'html.duckduckgo.com',
  'en.wikipedia.org',
  'api.groq.com',
  'generativelanguage.googleapis.com',
  'openrouter.ai',
]);

self.addEventListener('install', (e) => {
  // Cache each asset independently. A slow or blocked CDN must not abort the
  // whole install, or the app would lose offline support entirely.
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(ASSETS.map(async (url) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PRECACHE_TIMEOUT);
      try {
        const response = await fetch(url, { cache: 'reload', signal: controller.signal });
        if (response.ok || response.type === 'opaque') await cache.put(url, response);
      } catch (err) {
        console.warn('Precache skipped:', url, err.message);
      } finally {
        clearTimeout(timer);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (NETWORK_ONLY_HOSTS.has(url.hostname)) return; // AI / search: network only
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then((cached) =>
        cached || fetch(e.request).then((resp) => {
          return caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, resp.clone());
            return resp;
          });
        })
      )
    );
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
