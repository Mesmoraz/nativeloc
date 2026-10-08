// Bump VERSION on any change to this file's caching behaviour; old caches are deleted on activate.
// Hashed /assets/* files are cached as they are fetched, so a new deploy's files never collide.
const VERSION = 'v1';
const CACHE = `nativeloc-shell-${VERSION}`;
const SHELL = ['/offline.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
const NEVER_CACHE = /^\/(api|b|files)\//;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER_CACHE.test(url.pathname)) return;

  // Navigations: always network, so deploys show up at once; offline page when the network is gone.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }

  // Static assets: cache first, fill on miss.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
