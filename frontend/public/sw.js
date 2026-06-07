// Service worker — minimal offline app shell (PWA group J1).
// Strategy:
//  - /api/** and non-GET  → network only (never cache auth/presigned/API data)
//  - navigations          → network-first, fall back to cached shell when offline
//  - hashed static assets → cache-first (Vite filenames are content-hashed)
const CACHE = 'uploader-v3';
const SHARE_CACHE = 'share-target';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png'];

// PWA Web Share Target (J/Task 8): the OS posts shared files here. The SW can't
// hand File objects straight to the SPA, so it stashes each file as a Response
// in a dedicated cache, then redirects to /files where the page reads them back
// (see frontend/src/lib/shareTarget.js) and feeds them to the uploader.
async function handleShareTarget(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => f && f.size);
    const cache = await caches.open(SHARE_CACHE);
    for (const k of await cache.keys()) await cache.delete(k); // clear stale
    let i = 0;
    for (const file of files) {
      await cache.put(
        new Request(`/__shared__/${i}`),
        new Response(file, {
          headers: {
            'content-type': file.type || 'application/octet-stream',
            'x-filename': encodeURIComponent(file.name || `shared-${i}`),
          },
        }),
      );
      i += 1;
    }
    return Response.redirect(`/files?share-target=${i}`, 303);
  } catch {
    return Response.redirect('/files', 303);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Web Share Target: intercept the share POST before the GET-only guard below.
  if (request.method === 'POST' && url.origin === self.location.origin && url.pathname === '/share-target') {
    event.respondWith(handleShareTarget(request));
    return;
  }

  // Only handle same-origin GETs; let everything else (API, presigned MinIO,
  // POST/PUT, cross-origin) go straight to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // App navigations → network-first with offline shell fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))),
    );
    return;
  }

  // Static assets → cache-first, revalidate in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((resp) => {
          if (resp && resp.status === 200 && resp.type === 'basic') {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
