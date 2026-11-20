'use strict';

// Bei größeren Änderungen die Version erhöhen – alte Caches werden dann gelöscht.
const CACHE = 'spanisch-app-v1';

const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'data/vocab-seed.json',
  'data/grammar.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate: sofort aus dem Cache antworten (offline-fähig) und im
// Hintergrund aktualisieren. Geänderte Dateien sind beim übernächsten Öffnen da.
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Query-Parameter spielen für die statischen Dateien keine Rolle
  url.search = '';
  url.hash = '';

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(url.href);

    const refresh = fetch(url.href, { cache: 'no-cache' })
      .then(response => {
        if (response.ok) cache.put(url.href, response.clone());
        return response;
      })
      .catch(() => null);

    if (cached) {
      event.waitUntil(refresh);
      return cached;
    }
    const response = await refresh;
    if (response) return response;
    if (request.mode === 'navigate') {
      const shell = await cache.match('index.html');
      if (shell) return shell;
    }
    return Response.error();
  })());
});
