// Higiene de caché de marca: al abrir la app, borra cachés de versiones anteriores y
// desregistra manejadores de servicio que no son el nuestro. Así un teléfono que ya
// tenía la marca vieja en caché no se queda pegado nunca más.
//
// La versión vigente NO se duplica acá: se lee del /sw.js que sirve el servidor
// (const V = 'pout-vN'), así al subir la versión del SW esta limpieza ya sabe cuál es.
(function (root) {
  'use strict';

  // Prefijo de las cachés de esta app (pout-v2, pout-v6, poutv1...).
  function esCacheDeMarca(nombre) {
    return /^pout/i.test(String(nombre || ''));
  }

  // Decide qué borrar y qué desregistrar. Pura (sin red ni APIs del navegador) para poder probarla.
  function plan({ current, cacheKeys, registrations, origin, swPath }) {
    const out = { deleteCaches: [], unregisterScripts: [] };
    if (!current) return out; // sin versión confiable no se toca nada (mejor viejo que roto)

    for (const k of cacheKeys || []) {
      if (esCacheDeMarca(k) && k !== current) out.deleteCaches.push(k);
    }
    for (const r of registrations || []) {
      const src = r && r.scriptURL;
      if (!src) continue;
      let u;
      try { u = new URL(src, origin); } catch (_) { continue; }
      if (u.origin !== origin) continue;             // otro sitio: no es asunto nuestro
      if (u.pathname === swPath) continue;           // el nuestro: se queda
      out.unregisterScripts.push(src);               // service worker ajeno o de una versión vieja
    }
    return out;
  }

  async function run() {
    try {
      if (!('serviceWorker' in navigator) || !('caches' in root)) return;
      const swPath = '/sw.js';
      const res = await fetch(swPath, { cache: 'no-store' });
      const src = await res.text();
      const m = src.match(/const\s+V\s*=\s*'([^']+)'/);
      const current = m && m[1];
      if (!current) return;

      const [cacheKeys, regs] = await Promise.all([caches.keys(), navigator.serviceWorker.getRegistrations()]);
      const todo = plan({
        current,
        cacheKeys,
        registrations: regs.map((r) => ({ scriptURL: (r.active || r.waiting || r.installing || {}).scriptURL })),
        origin: location.origin,
        swPath,
      });

      for (const k of todo.deleteCaches) { try { await caches.delete(k); } catch (_) {} }
      for (const src of todo.unregisterScripts) {
        const reg = regs.find((r) => (r.active || r.waiting || r.installing || {}).scriptURL === src);
        if (reg) { try { await reg.unregister(); } catch (_) {} }
      }
      // Y se pide la versión más nueva del SW en el momento, sin esperar a la próxima visita.
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) { try { await reg.update(); } catch (_) {} }
    } catch (_) {
      // limpieza best-effort: si algo falla, la app sigue igual
    }
  }

  const api = { plan, esCacheDeMarca, run };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root && typeof document !== 'undefined') run();
})(typeof window !== 'undefined' ? window : null);
