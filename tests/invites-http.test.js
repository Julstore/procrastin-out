// Invitaciones de un solo uso por HTTP real.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
let child, base;

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
  const m = (r.headers.get('set-cookie') || '').match(/pout_sess=([a-f0-9]{64})/);
  return { status: r.status, json, text, session: m ? `pout_sess=${m[1]}` : null };
}

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pout-invite-'));
  const { makeUser } = require('../lib/users');
  const admin = makeUser({ username: 'admin', pin: 'admin-pin', role: 'admin', id: 'admin' });
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ users: [admin] }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', POUT_DATA_DIR: dataDir, PUBLIC_URL: '', DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  await waitFor(base + '/login.html');
});

after(() => { if (child) child.kill(); });

test('la página de invitación es pública; el resto sigue protegido', async () => {
  const page = await call('GET', '/invite.html?t=x');
  assert.equal(page.status, 200);
  const data = await call('GET', '/api/data');
  assert.equal(data.status, 401);
});

test('solo el admin puede generar una invitación', async () => {
  const anon = await call('POST', '/api/invites', {});
  assert.equal(anon.status, 401);
});

test('el amigo canjea la invitación una sola vez y entra con su usuario', async () => {
  const admin = await call('POST', '/api/auth/login', { username: 'admin', pin: 'admin-pin' });
  const inv = await call('POST', '/api/invites', {}, admin.session);
  assert.equal(inv.status, 200);
  const token = inv.json.token;

  const redeem = await call('POST', '/api/invites/redeem', { token, username: 'amigo2', pin: 'amigo-pin' });
  assert.equal(redeem.status, 200, redeem.text);
  assert.ok(redeem.session, 'el canje abre sesión');

  const again = await call('POST', '/api/invites/redeem', { token, username: 'otro', pin: 'otro-pin' });
  assert.equal(again.status, 410, 'el mismo link no sirve dos veces');

  const login = await call('POST', '/api/auth/login', { username: 'amigo2', pin: 'amigo-pin' });
  assert.equal(login.status, 200, 'el amigo entra con su usuario y PIN');
});

test('un token inventado no crea cuentas', async () => {
  const r = await call('POST', '/api/invites/redeem', { token: 'f'.repeat(48), username: 'intruso', pin: 'intruso-pin' });
  assert.equal(r.status, 410);
  const login = await call('POST', '/api/auth/login', { username: 'intruso', pin: 'intruso-pin' });
  assert.equal(login.status, 401);
});
