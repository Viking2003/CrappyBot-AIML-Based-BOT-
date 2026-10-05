// CrappyBot service worker.
//
// Strategy: network-first, falling back to cache only when offline.
// This deliberately does NOT hardcode a list of AIML/map/sets/substitutions
// files to pre-cache — you add new .aiml/.map files often, and a hardcoded
// list here would just be one more place to forget to update. Instead,
// every same-origin GET request that succeeds gets cached as a side effect,
// so after the first successful visit, everything needed to run offline is
// already saved — automatically, no maintenance required.
//
// Network-first (rather than cache-first) also means that whenever you're
// online, you always get your latest deployed files, never a stale cached
// version — the same caching-vs-staleness issue you hit before with GitHub
// Pages' CDN, deliberately avoided here rather than reintroduced.

const CACHE_VERSION = 'crappybot-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting(); // activate this new SW immediately, don't wait for old tabs to close
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Minimal, fixed app-shell precache — safe to hardcode since these
      // three files essentially never change in number, only in content.
      cache.addAll(['./', './index.html', './aiml-engine.js', './manifest.json'])
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n))
      )
    ).then(() => self.clients.claim()) // take control of open tabs immediately
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET requests for our own origin — let everything else
  // (cross-origin images, fonts, external map/button URLs) pass through
  // untouched.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((networkResponse) => {
        // Got a fresh copy: use it, and update the cache for offline use later.
        const copy = networkResponse.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        return networkResponse;
      })
      .catch(() =>
        // Offline (or request failed): fall back to whatever we have cached.
        caches.match(req).then((cached) => cached || Promise.reject('offline, not cached'))
      )
  );
});