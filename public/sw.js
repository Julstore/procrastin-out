// procrastin-out SW: hace la app instalable y cachea SOLO imágenes/manifest.
// HTML, API, JS y CSS nunca se sirven desde caché para evitar versiones viejas
// después de un deploy: van a la red primero y la caché es solo respaldo offline.
const V = 'pout-v6';
// Solo marca e íconos: son públicos y pequeños. El splash grande (iOS) queda fuera a propósito.
const STATIC = ['/icon-192.png?v=2', '/icon-512.png?v=2', '/icon-180.png?v=2', '/icon-maskable-512.png?v=2', '/manifest.webmanifest', '/mark-real.png?v=2', '/label-real.png?v=2', '/splash-bg.png?v=2'];
const NETWORK_FIRST = /\.(js|css)$/i;
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api/') || u.pathname === '/' || u.pathname.endsWith('.html')) return; // siempre a red
  if (NETWORK_FIRST.test(u.pathname) || u.pathname === '/sw.js') {
    // Red primero: si hay versión nueva en el servidor, se usa; caché solo si no hay red.
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(V).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(V).then((c) => c.put(e.request, copy));
          }
          return res;
        })
    )
  );
});
