// Nube (modo Postgres) con el servidor real: cada cuenta guarda en su propia fila de pout_kv,
// y un amigo no pisa los datos del admin, ni siquiera tras reiniciar el servidor.
// Usa un pool en memoria (tests/helpers) en lugar de Postgres: no hace falta una base real.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const POOL_FILE = path.join(__dirname, 'helpers', 'pg-memory-pool.js');
const PG_FILE = path.join(require('os').tmpdir(), 'pout-cloud-pg-' + process.pid + '.json');
const TOKEN = 'e'.repeat(64);

let child, base, dataDir;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function waitFor(url, tries = 150) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch (_) { /* aún no escucha */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('el servidor no arrancó: ' + url);
}

function start(port) {
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      POUT_DATA_DIR: dataDir,
      PUBLIC_URL: '',
      DATABASE_URL: 'postgres://doble-en-memoria',
      POUT_TEST_PG_POOL_FILE: POOL_FILE,
      POUT_TEST_PG_FILE: PG_FILE,
      POUT_AGENT_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  return proc;
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
  const m = (r.headers.get('set-cookie') || '').match(/pout_sess=([a-f0-9]{64})/);
  return { status: r.status, json, text, session: m ? `pout_sess=${m[1]}` : null };
}

before(async () => {
  dataDir = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'pout-cloud-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = start(port);
  await waitFor(base + '/login.html');
});

after(() => {
  if (child)  child.kill();
  require('fs').rmSync(PG_FILE, { force: true });
});

test('la nube crea el admin y guarda sus datos', async () => {
  const setup = await call('POST', '/api/auth/setup', { pin: 'admin-pin' });
  assert.equal(setup.status, 200, setup.text);
  const admin = await call('POST', '/api/auth/login', { username: 'admin', pin: 'admin-pin' });
  assert.equal(admin.status, 200);
  const put = await call('PUT', '/api/data', { tasks: [{ id: 'del-admin', title: 'tarea del admin' }] }, admin.session);
  assert.equal(put.status, 200, put.text);
  await new Promise((r) => setTimeout(r, 400)); // debounce de guardado
  const ad = await call('GET', '/api/data', undefined, admin.session);
  assert.ok(ad.json.tasks.some((t) => t.id === 'del-admin'));
});

test('un amigo nuevo empieza vacío, no hereda ni pisa los datos del admin', async () => {
  const admin = await call('POST', '/api/auth/login', { username: 'admin', pin: 'admin-pin' });
  const mk = await call('POST', '/api/users', { username: 'amigo1', pin: 'amigo-pin' }, admin.session);
  assert.equal(mk.status, 200, mk.text);
  const friend = await call('POST', '/api/auth/login', { username: 'amigo1', pin: 'amigo-pin' });
  assert.equal(friend.status, 200);

  const fd = await call('GET', '/api/data', undefined, friend.session);
  assert.equal(fd.json.tasks.length, 0, 'el amigo empieza sin tareas');

  await call('PUT', '/api/data', { tasks: [{ id: 'del-amigo', title: 'tarea del amigo' }] }, friend.session);
  await new Promise((r) => setTimeout(r, 400));
  const ad = await call('GET', '/api/data', undefined, admin.session);
  assert.ok(ad.json.tasks.some((t) => t.id === 'del-admin'), 'el admin conserva su tarea');
  assert.equal(ad.json.tasks.some((t) => t.id === 'del-amigo'), false, 'el admin no ve la del amigo');
});

test('tras reiniciar el servidor, cada cuenta recupera solo sus datos', async () => {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = start(port);
  await waitFor(base + '/login.html');

  const admin = await call('POST', '/api/auth/login', { username: 'admin', pin: 'admin-pin' });
  const friend = await call('POST', '/api/auth/login', { username: 'amigo1', pin: 'amigo-pin' });
  assert.equal(admin.status, 200);
  assert.equal(friend.status, 200);

  const ad = await call('GET', '/api/data', undefined, admin.session);
  const fd = await call('GET', '/api/data', undefined, friend.session);
  assert.ok(ad.json.tasks.some((t) => t.id === 'del-admin'), 'el admin recupera su tarea');
  assert.ok(fd.json.tasks.some((t) => t.id === 'del-amigo'), 'el amigo recupera su tarea');
  assert.equal(ad.json.tasks.some((t) => t.id === 'del-amigo'), false);
  assert.equal(fd.json.tasks.some((t) => t.id === 'del-admin'), false);
});
