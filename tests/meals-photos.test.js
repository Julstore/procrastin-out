// Fotos de comidas: validación, aislamiento por cuenta y la IA usa foto+pesos.
// Correr con: node --test tests/meals-photos.test.js  (o npm test)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
let child, upstream, upstreamUrl, upstreamHits = 0, lastAiBody = null;
let base, dataDir;

// PNG 1x1 válido en dataURL: la validación del endpoint solo revisa forma y tamaño.
const TINY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TODAY = '2026-10-26';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = require('net').createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function waitFor(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* aún no */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no arrancó: ' + url);
}
async function call(method, p, body, cookie, headers = {}) {
  const r = await fetch(base + p, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* sin JSON */ }
  const sc = r.headers.get('set-cookie') || '';
  const m = sc.match(/pout_sess=([a-f0-9]{64})/);
  return { status: r.status, json, session: m ? `pout_sess=${m[1]}` : null };
}

before(async () => {
  // Upstream falso de OpenLLM: guarda el body y responde JSON de calorías válido.
  upstream = http.createServer((req, res) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      upstreamHits++;
      try { lastAiBody = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { lastAiBody = null; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ items: [{ plato: 'café', gramos: 200, kcal: 90 }], totalKcal: 90, tip: 'ok' }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pout-meals-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', POUT_DATA_DIR: dataDir,
      PUBLIC_URL: '', DATABASE_URL: '', OPENLLM_BASE_URL: upstreamUrl, OPENLLM_API_KEY: 'sk-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  await waitFor(base + '/login.html');
});

after(() => { if (child) child.kill(); if (upstream) upstream.close(); });

let admin; // sesión del admin
test('admin y amigo existentes', async () => {
  const setup = await call('POST', '/api/auth/setup', { pin: 'pin-1234' });
  assert.equal(setup.status, 200, setup.json && setup.json.error);
  admin = setup.session;
  const create = await call('POST', '/api/users', { username: 'amigo1', pin: 'pin-amigo' }, admin);
  assert.equal(create.status, 200, create.json && create.json.error);
});

test('sin sesión, la foto pide login', async () => {
  const r = await call('GET', `/api/meals/photo?date=${TODAY}&field=breakfast`);
  assert.equal(r.status, 401);
});

test('sube, ve y borra la foto de una franja', async () => {
  const up = await call('POST', '/api/meals/photo', { date: TODAY, field: 'breakfast', image: TINY }, admin);
  assert.equal(up.status, 200, up.json && up.json.error);
  const got = await call('GET', `/api/meals/photo?date=${TODAY}&field=breakfast`, undefined, admin);
  assert.equal(got.status, 200);
  assert.equal(got.json.dataUrl, TINY);
  const del = await call('DELETE', `/api/meals/photo?date=${TODAY}&field=breakfast`, undefined, admin);
  assert.equal(del.status, 200);
  const gone = await call('GET', `/api/meals/photo?date=${TODAY}&field=breakfast`, undefined, admin);
  assert.equal(gone.json.dataUrl, null);
});

test('valida día, franja, forma y tamaño de la foto', async () => {
  const badField = await call('POST', '/api/meals/photo', { date: TODAY, field: 'nope', image: TINY }, admin);
  assert.equal(badField.status, 400);
  const badDate = await call('POST', '/api/meals/photo', { date: 'ayer', field: 'lunch', image: TINY }, admin);
  assert.equal(badDate.status, 400);
  const badImage = await call('POST', '/api/meals/photo', { date: TODAY, field: 'lunch', image: 'https://example.com/x.jpg' }, admin);
  assert.equal(badImage.status, 400);
  const tooBig = await call('POST', '/api/meals/photo', { date: TODAY, field: 'lunch', image: 'data:image/png;base64,' + 'A'.repeat(500_000) }, admin);
  assert.equal(tooBig.status, 400);
});

test('cada cuenta ve solo sus fotos (aislamiento)', async () => {
  const friend = await call('POST', '/api/auth/login', { username: 'amigo1', pin: 'pin-amigo' });
  assert.ok(friend.session);
  // Foto del admin en cena; el amigo NO la ve.
  await call('POST', '/api/meals/photo', { date: TODAY, field: 'dinner', image: TINY }, admin);
  const asFriend = await call('GET', `/api/meals/photo?date=${TODAY}&field=dinner`, undefined, friend.session);
  assert.equal(asFriend.json.dataUrl, null, 'el amigo no debe ver la foto del admin');
  // La foto del amigo tampoco pisa la del admin.
  await call('POST', '/api/meals/photo', { date: TODAY, field: 'dinner', image: TINY }, friend.session);
  const asAdmin = await call('GET', `/api/meals/photo?date=${TODAY}&field=dinner`, undefined, admin);
  assert.equal(asAdmin.json.dataUrl, TINY);
});

test('los alimentos con peso se guardan con las comidas', async () => {
  const put = await call('PUT', '/api/data', { meals: { [TODAY]: { breakfast: 'café', items: { breakfast: [{ n: 'café', g: 200 }, { n: 'tostada', g: null }] } } } }, admin);
  assert.equal(put.status, 200, put.json && put.json.error);
  const d = (await call('GET', '/api/data', undefined, admin)).json;
  const items = d.meals[TODAY].items.breakfast;
  assert.equal(items.length, 2);
  assert.equal(items[0].g, 200);
  assert.equal(items[1].g, null);
});

test('la IA de calorías recibe los pesos y la foto (visión)', async () => {
  // Foto de cena del admin existe (test anterior); items de desayuno con uno sin peso.
  const r = await call('POST', '/api/ai/advise', { kind: 'calories', date: TODAY }, admin);
  assert.equal(r.status, 200, r.json && r.json.error);
  assert.ok(r.json.applied, 'guarda la estimación: ' + JSON.stringify(r.json).slice(0, 300));
  const d = (await call('GET', '/api/data', undefined, admin)).json;
  assert.equal(d.meals[TODAY].nutri.totalKcal, 90);

  const msg = lastAiBody?.messages?.find((m) => m.role === 'user');
  assert.ok(Array.isArray(msg.content), 'el mensaje usa partes (texto + imagen)');
  const textPart = msg.content.find((p) => p.type === 'text');
  assert.match(textPart.text, /café.*200 g/s, 'menciona el peso exacto del alimento');
  assert.match(textPart.text, /peso sin registrar|deducir peso/i, 'avisa qué falta de peso');
  const imgParts = msg.content.filter((p) => p.type === 'image_url');
  assert.equal(imgParts.length, 1, 'una imagen (la foto de la cena)');
  assert.match(imgParts[0].image_url.url, /^data:image\//);

  assert.equal(upstreamHits, 1, 'una sola llamada al upstream');
});
