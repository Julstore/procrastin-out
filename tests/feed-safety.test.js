// Pruebas de seguridad de feeds y de IP de cliente. Correr con: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  isPublicIp,
  assertPublicFeedUrl,
  fetchPublicFeed,
  safeHttpUrl,
  clientIpFrom,
  parseRssItems,
} = require('../lib/feed-safety');

// DNS falso: cada host devuelve la IP indicada.
// Como dns.lookup real: una IP literal se resuelve a sí misma.
const fakeLookup = (table) => async (host) => {
  if (require('net').isIP(host)) return [{ address: host, family: 4 }];
  if (!(host in table)) throw new Error('ENOTFOUND ' + host);
  return [{ address: table[host], family: 4 }];
};

// fetch falso: responde según la URL y registra a qué URLs se llamó.
function fakeFetch(routes, calls = []) {
  return async (url, init) => {
    calls.push(url);
    const r = routes[url];
    if (!r) throw new Error('ruta no esperada: ' + url);
    const headers = new Headers(r.headers || {});
    return new Response(r.body ?? '', { status: r.status ?? 200, headers });
  };
}

test('isPublicIp rechaza loopback, LAN, link-local y metadata cloud', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.5', '192.168.1.9', '169.254.169.254', '0.0.0.0', '::1', '::']) {
    assert.equal(isPublicIp(ip), false, ip);
  }
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
});

test('assertPublicFeedUrl rechaza esquemas, credenciales y hosts privados', async () => {
  const lookup = fakeLookup({ 'example.com': '93.184.216.34', 'local.test': '127.0.0.1' });
  await assert.rejects(assertPublicFeedUrl('file:///etc/passwd', lookup), /inválida/);
  await assert.rejects(assertPublicFeedUrl('https://user:pw@example.com/rss', lookup), /inválida/);
  await assert.rejects(assertPublicFeedUrl('http://local.test/rss', lookup), /solo hosts públicos/);
  await assert.rejects(assertPublicFeedUrl('http://nope.test/rss', lookup), /No se pudo resolver/);
  const ok = await assertPublicFeedUrl('https://example.com/rss', lookup);
  assert.equal(ok.hostname, 'example.com');
});

test('fetchPublicFeed no sigue una redirección hacia localhost (SSRF por redirect)', async () => {
  const lookup = fakeLookup({ 'example.com': '93.184.216.34', 'localhost': '127.0.0.1' });
  const calls = [];
  const f = fakeFetch({
    'https://example.com/rss': { status: 302, headers: { location: 'http://localhost/secreto' } },
    'http://localhost/secreto': { body: 'interno' },
  }, calls);
  await assert.rejects(fetchPublicFeed('https://example.com/rss', { lookup, fetchImpl: f }), /solo hosts públicos/);
  assert.ok(!calls.includes('http://localhost/secreto'), 'nunca debe pedir el destino privado');
});

test('fetchPublicFeed no sigue una redirección hacia la LAN (IP literal)', async () => {
  const lookup = fakeLookup({ 'example.com': '93.184.216.34' });
  const calls = [];
  const f = fakeFetch({
    'https://example.com/rss': { status: 301, headers: { location: 'http://192.168.0.10/admin' } },
  }, calls);
  await assert.rejects(fetchPublicFeed('https://example.com/rss', { lookup, fetchImpl: f }), /solo hosts públicos/);
  assert.deepEqual(calls, ['https://example.com/rss']);
});

test('fetchPublicFeed sigue redirecciones públicas y devuelve el cuerpo', async () => {
  const lookup = fakeLookup({ 'a.example.com': '93.184.216.34', 'b.example.com': '93.184.216.35' });
  const f = fakeFetch({
    'https://a.example.com/rss': { status: 302, headers: { location: 'https://b.example.com/feed.xml' } },
    'https://b.example.com/feed.xml': { body: '<rss>ok</rss>' },
  });
  assert.equal(await fetchPublicFeed('https://a.example.com/rss', { lookup, fetchImpl: f }), '<rss>ok</rss>');
});

test('fetchPublicFeed corta bucles de redirección', async () => {
  const lookup = fakeLookup({ 'loop.example.com': '93.184.216.34' });
  const f = fakeFetch({
    'https://loop.example.com/a': { status: 302, headers: { location: 'https://loop.example.com/a' } },
  });
  await assert.rejects(fetchPublicFeed('https://loop.example.com/a', { lookup, fetchImpl: f }), /Demasiadas redirecciones/);
});

test('safeHttpUrl solo deja pasar http(s)', () => {
  assert.equal(safeHttpUrl('https://example.com/nota'), 'https://example.com/nota');
  assert.equal(safeHttpUrl('http://example.com/x'), 'http://example.com/x');
  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(safeHttpUrl('JavaScript:alert(1)'), '');
  assert.equal(safeHttpUrl('data:text/html,<script>x</script>'), '');
  assert.equal(safeHttpUrl('vbscript:msgbox'), '');
  assert.equal(safeHttpUrl(''), '');
  assert.equal(safeHttpUrl(undefined), '');
});

test('parseRssItems no deja links javascript: en los items', () => {
  const xml = `<rss><channel>
    <item><title>Nota mala</title><link>javascript:alert(document.cookie)</link><pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate></item>
    <item><title>Nota buena</title><link>https://example.com/buena</link></item>
  </channel></rss>`;
  const items = parseRssItems(xml, { src: 'Test', feedName: 'x' });
  assert.equal(items.length, 2);
  assert.equal(items[0].url, '');
  assert.equal(items[1].url, 'https://example.com/buena');
});

test('parseRssItems no deja links javascript: en el atributo href de Atom', () => {
  const xml = `<feed><entry><title>Atom</title><link href="javascript:void(0)"/></entry></feed>`;
  const items = parseRssItems(xml, {});
  assert.equal(items[0].url, '');
});

test('clientIpFrom ignora X-Forwarded-For sin proxy de confianza', () => {
  const req = { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '10.0.0.5' } };
  assert.equal(clientIpFrom(req, false), '10.0.0.5');
  assert.equal(clientIpFrom(req), '10.0.0.5');
});

test('clientIpFrom usa X-Forwarded-For solo con TRUST_PROXY activo', () => {
  const req = { headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.5' } };
  assert.equal(clientIpFrom(req, true), '1.2.3.4');
  const sinHeader = { headers: {}, socket: { remoteAddress: '10.0.0.5' } };
  assert.equal(clientIpFrom(sinHeader, true), '10.0.0.5');
});

test('Electron fuerza el bind a loopback (verificación estática)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(src, /process\.env\.HOST = '127\.0\.0\.1'/);
});
