// Login con usuario + PIN y aislamiento de datos entre cuentas, por HTTP real.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
let child, base, dataDir;
const AGENT_TOKEN = 'f'.repeat(64);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function waitFor(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch (_) { /* aún no escucha */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('el servidor no arrancó: ' + url);
}

async function call(method, p, body, cookie) {
  const r = await fetch(base + p, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* sin JSON */ }
  const setCookie = r.headers.get('set-cookie') || '';
  const m = setCookie.match(/pout_sess=([a-f0-9]{64})/);
  return { status: r.status, json, text, session: m ? `pout_sess=${m[1]}` : null };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pout-accounts-'));
  // Cuenta admin previa: un auth.json de un solo PIN, como el de hoy.
  const { makeUser } = require('../lib/users');
  const legacy = makeUser({ username: 'tmp', pin: 'admin-pin' });
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ pinHash: legacy.pinHash, salt: legacy.salt }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', POUT_DATA_DIR: dataDir, PUBLIC_URL: '', DATABASE_URL: '', POUT_AGENT_TOKEN: AGENT_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  await waitFor(base + '/login.html');
});

after(() => { if (child) child.kill(); });

test('la cuenta admin migrada entra con usuario admin y su PIN', async () => {
  const ok = await call('POST', '/api/auth/login', { username: 'admin', pin: 'admin-pin' });
  assert.equal(ok.status, 200);
  assert.ok(ok.session, 'devuelve cookie de sesión');
  const bad = await call('POST', '/api/auth/login', { username: 'admin', pin: 'otro-pin' });
  assert.equal(bad.status, 401);
});

test('sin sesión, los datos piden login', async () => {
  const r = await call('GET', '/api/data');
  assert.equal(r.status, 401);
});

test('admin crea una cuenta de amigo y ese amigo entra con su PIN', async () => {
  const admin = await call('POST', '/api/auth/login', { username: 'admin', pin: 'admin-pin' });
  const create = await call('POST', '/api/users', { username: 'amigo1', pin: 'amigo-pin' }, admin.session);
  assert.equal(create.status, 200, create.text);
  const friend = await call('POST', '/api/auth/login', { username: 'amigo1', pin: 'amigo-pin' });
  assert.equal(friend.status, 200);
});

test('cada cuenta ve solo sus propios datos', async () => {
  const admin = await call('POST', '/api/auth/login', { username: 'admin', pin: 'admin-pin' });
  const friend = await call('POST', '/api/auth/login', { username: 'amigo1', pin: 'amigo-pin' });

  const put = await call('PUT', '/api/data', { tasks: [{ id: 'soloadmin', title: 'secreta del admin' }] }, admin.session);
  assert.equal(put.status, 200, put.text);

  const adminData = await call('GET', '/api/data', undefined, admin.session);
  const friendData = await call('GET', '/api/data', undefined, friend.session);
  assert.ok(adminData.json.tasks.some(t => t.id === 'soloadmin'), 'el admin ve su tarea');
  assert.equal(friendData.json.tasks.some(t => t.id === 'soloadmin'), false, 'el amigo NO ve la tarea del admin');
});

test('Jarvis (token de agente) ve solo la cuenta admin, aunque la última sesión sea de un amigo', async () => {
  const friend = await call('POST', '/api/auth/login', { username: 'amigo1', pin: 'amigo-pin' });
  // Una petición de amigo deja la cuenta activa en amigo1; luego Jarvis lee sin sesión.
  await call('GET', '/api/data', undefined, friend.session);
  const jarvis = await fetch(base + '/api/data', { headers: { Authorization: 'Bearer ' + AGENT_TOKEN } });
  const body = await jarvis.json();
  assert.equal(jarvis.status, 200);
  assert.ok(body.tasks.some(t => t.id === 'soloadmin'), 'Jarvis ve los datos del admin');
  assert.equal(body.tasks.some(t => t.title === 'secreta del admin' && t.id !== 'soloadmin'), false);
});
