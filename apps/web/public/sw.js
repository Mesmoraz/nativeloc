// Bump VERSION on any change to this file's caching behaviour; old caches are deleted on activate.
// Hashed /assets/* files are cached as they are fetched, so a new deploy's files never collide.
const VERSION = 'v2';
const CACHE = `nativeloc-shell-${VERSION}`;
const SHELL = ['/offline.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
const NEVER_CACHE = /^\/(api|b|files)\//;

self.addEventListener('install', (event) => {
  // A missing file makes the SPA fallback answer with index.html; refuse to cache that as an icon or manifest.
  const precache = async () => {
    const cache = await caches.open(CACHE);
    for (const path of SHELL) {
      const res = await fetch(path, { cache: 'reload' });
      const isHtml = (res.headers.get('content-type') ?? '').includes('text/html');
      if (!res.ok || (isHtml && path !== '/offline.html')) throw new Error(`Bad shell file: ${path}`);
      await cache.put(path, res);
    }
  };
  event.waitUntil(precache().then(() => self.skipWaiting()));
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
