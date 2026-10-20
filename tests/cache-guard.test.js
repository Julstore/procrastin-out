// Higiene de caché de marca: al abrir la app se borran las cachés de versiones
// anteriores del service worker para que el teléfono no quede con la marca vieja.
const test = require('node:test');
const assert = require('node:assert');
const { plan, esCacheDeMarca } = require('../public/cache-guard.js');

const ORIGIN = 'https://procrastin-out.onrender.com';

test('borra las cachés de la marca que no son la versión vigente', () => {
  const r = plan({
    current: 'pout-v6',
    cacheKeys: ['pout-v2', 'pout-v5', 'pout-v6'],
    registrations: [],
    origin: ORIGIN,
    swPath: '/sw.js',
  });
  assert.deepStrictEqual(r.deleteCaches.sort(), ['pout-v2', 'pout-v5']);
  assert.deepStrictEqual(r.unregisterScripts, []);
});

test('no toca cachés ajenas ni la de la versión vigente', () => {
  const r = plan({
    current: 'pout-v6',
    cacheKeys: ['pout-v6', 'workbox-precache-v2', 'otros-recursos'],
    registrations: [],
    origin: ORIGIN,
    swPath: '/sw.js',
  });
  assert.deepStrictEqual(r.deleteCaches, []);
});

test('desregistra service workers que no son el nuestro y conserva el de la app', () => {
  const r = plan({
    current: 'pout-v6',
    cacheKeys: [],
    registrations: [
      { scriptURL: ORIGIN + '/sw.js' },
      { scriptURL: ORIGIN + '/service-worker.js' },
      { scriptURL: 'https://otro-sitio.com/sw.js' },
    ],
    origin: ORIGIN,
    swPath: '/sw.js',
  });
  assert.deepStrictEqual(r.unregisterScripts, [ORIGIN + '/service-worker.js']);
});

test('sin versión confiable no borra nada (mejor viejo que roto)', () => {
  const r = plan({ current: '', cacheKeys: ['pout-v2', 'pout-v6'], registrations: [{ scriptURL: ORIGIN + '/viejo.js' }], origin: ORIGIN, swPath: '/sw.js' });
  assert.deepStrictEqual(r, { deleteCaches: [], unregisterScripts: [] });
});

test('reconoce el prefijo de las cachés de la marca', () => {
  assert.ok(esCacheDeMarca('pout-v6'));
  assert.ok(esCacheDeMarca('POUT-v2'));
  assert.ok(!esCacheDeMarca('workbox-precache-v2'));
  assert.ok(!esCacheDeMarca(undefined));
});
