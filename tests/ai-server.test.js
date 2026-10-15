// Prueba de integración: servidor real (server.js) contra un upstream falso de OpenLLM.
// Verifica caché, conteo de tokens, límite diario y GET /api/ai/usage. Correr con: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
let upstream, upstreamUrl, upstreamHits = 0;
let child, base, cookie, dataDir;

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

async function api(method, p, body) {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

before(async () => {
  upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      upstreamHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: `respuesta ${upstreamHits}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pout-ai-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      POUT_DATA_DIR: dataDir,
      OPENLLM_BASE_URL: upstreamUrl,
      OPENLLM_API_KEY: 'sk-test',
      AI_DAILY_REQUEST_LIMIT: '2',
      AI_DAILY_TOKEN_LIMIT: '100000',
      AI_CACHE_TTL_MIN: '360',
      PUBLIC_URL: '',
      DATABASE_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  await waitFor(base + '/login.html');

  const setup = await fetch(base + '/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ pin: '1234' }),
  });
  assert.equal(setup.status, 200);
  cookie = setup.headers.get('set-cookie').split(';')[0];
});

after(() => {
  if (child && !child.killed) child.kill();
  if (upstream) upstream.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('sin sesión, /api/ai/usage responde 401', async () => {
  const r = await fetch(base + '/api/ai/usage');
  assert.equal(r.status, 401);
});

test('una consulta llama a la IA y registra tokens reales', async () => {
  const r = await api('POST', '/api/ai/advise', { kind: 'coach' });
  assert.equal(r.status, 200);
  assert.equal(r.json.reply, 'respuesta 1');
  assert.equal(upstreamHits, 1);

  const u = (await api('GET', '/api/ai/usage')).json;
  assert.equal(u.requests, 1);
  assert.equal(u.tokens, 15);
  assert.equal(u.limits.dailyRequests, 2);
  assert.equal(u.recent[0].cached, false);
  assert.equal(u.recent[0].totalTokens, 15);
});

test('la misma consulta sale de caché: no llama al upstream ni gasta tokens', async () => {
  const r = await api('POST', '/api/ai/advise', { kind: 'coach' });
  assert.equal(r.json.reply, 'respuesta 1');
  assert.equal(upstreamHits, 1);

  const u = (await api('GET', '/api/ai/usage')).json;
  assert.equal(u.requests, 1);
  assert.equal(u.tokens, 15);
  assert.equal(u.recent[0].cached, true);
  assert.equal(u.recent[0].totalTokens, 0);
});

test('una consulta distinta sí llama a la IA y suma a la cuota', async () => {
  const r = await api('POST', '/api/ai/advise', { kind: 'diet' });
  assert.equal(r.json.reply, 'respuesta 2');
  assert.equal(upstreamHits, 2);
  const u = (await api('GET', '/api/ai/usage')).json;
  assert.equal(u.requests, 2);
  assert.equal(u.tokens, 30);
});

test('al llegar al límite diario se bloquea sin llamar al upstream', async () => {
  const r = await api('POST', '/api/ai/advise', { kind: 'plan' });
  assert.equal(r.status, 200);
  assert.match(r.json.error, /Límite diario de IA alcanzado/);
  assert.equal(upstreamHits, 2);
  const u = (await api('GET', '/api/ai/usage')).json;
  assert.equal(u.requests, 2);
});

test('el uso persiste en el documento de datos', async () => {
  // El guardado es con debounce (150 ms): esperamos a que el archivo refleje el último cambio.
  const file = path.join(dataDir, 'vida.json');
  let doc = null;
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(file)) {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc.aiUsage && doc.aiUsage.requests === 2) break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(doc && doc.aiUsage, 'vida.json debe contener aiUsage');
  assert.equal(doc.aiUsage.requests, 2);
  assert.equal(doc.aiUsage.tokens, 30);
});
