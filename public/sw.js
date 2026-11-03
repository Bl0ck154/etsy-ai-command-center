// sw.js — Service Worker for EM - Shop Manager Pro
// Strategy: network-first for HTML, stale-while-revalidate for assets, network-only for API
const CACHE_VERSION = 'etsy-mgr-v29';

// Install — skip waiting so new SW activates immediately
self.addEventListener('install', event => {
  self.skipWaiting();
});

// Activate — delete all old caches and claim clients
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then(clients => {
        for (const client of clients) {
          client.postMessage({ type: 'APP_UPDATED', version: CACHE_VERSION });
        }
      })
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Cross-origin media (notably Etsy listing images) must remain browser-owned.
  // Routing opaque no-cors image responses through the app cache handler turns
  // otherwise valid CDN responses into net::ERR_FAILED in Chromium.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Long-lived agent SSE streams must not be mediated by the service worker.
  // Let the browser own the native connection so partial stream failures do not
  // get converted into opaque fetch failures here.
  if (url.pathname === '/api/agent') {
    return;
  }

  // API calls — always network, never cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 503,
        })
      )
    );
    return;
  }

  // HTML navigation — network first, fall back to cache
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then(c => c || caches.match('/')))
    );
    return;
  }

  // JS/CSS/fonts — network first so API migration fixes are not hidden by stale bundles.
  event.respondWith(
    caches.open(CACHE_VERSION).then(cache =>
      fetch(request, { cache: 'no-cache' }).then(response => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      }).catch(() => cache.match(request).then(cached => cached ||
        fetch(request, { cache: 'no-cache' }).then(response => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
      ))
    )
  );
});
