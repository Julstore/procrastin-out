// La IA escribe datos por su propio camino (no PUT ni comando): la estimación de
// calorías guarda meals[day].nutri y la rutina aplica routine. Si no emiten el
// evento state por SSE, la pestaña no muestra el resultado hasta recargar.
// Este test usa un upstream OpenLLM falso que responde la estimación válida.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
let upstream, upstreamUrl, child, base, cookie, dataDir;

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
    try { const r = await fetch(url); if (r.ok) return; } catch (_) { /* todavía no escucha */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('el servidor no arrancó: ' + url);
}

before(async () => {
  upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: { content: JSON.stringify({ items: [{ plato: 'angu', gramos: 200, kcal: 400 }], totalKcal: 400, tip: 'salió bien' }) },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pout-ai-bcast-'));
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
      PUBLIC_URL: '',
      DATABASE_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  await waitFor(base + '/login.html');

  const setup = await fetch(base + '/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

test('la estimación de calorías guarda nutri y avisa por SSE (pestaña alimentación en vivo)', async () => {
  // El día debe tener comida registrada: sin texto, la IA no tiene qué estimar.
  const today = new Date().toISOString().slice(0, 10);
  const put = await fetch(base + '/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ meals: { [today]: { breakfast: 'angu con carne' } } }),
  });
  assert.equal(put.status, 200);

  // Cliente escuchando (lo mismo que hace index.html abierto).
  const controller = new AbortController();
  const sse = await fetch(base + '/api/agent/events', {
    headers: { Cookie: cookie },
    signal: controller.signal,
  });
  assert.equal(sse.status, 200);
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readUntil = async (needle, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(needle)) return true;
    }
    return false;
  };
  assert.ok(await readUntil('event: hello'));

  const r = await fetch(base + '/api/ai/advise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ kind: 'calories', date: today }),
  });
  const j = await r.json();
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.equal(j.applied, true);

  // El evento llega sin recargar: la pestaña alimenta se actualiza sola.
  assert.ok(await readUntil('event: state'), 'debería emitir state tras guardar nutri');
  const at = buffer.indexOf('event: state');
  const frame = buffer.slice(at);
  const dataLine = frame.slice(frame.indexOf('data: ') + 6, frame.indexOf('\n', frame.indexOf('data: ')));
  const payload = JSON.parse(dataLine);
  assert.equal(payload.tab, 'meals', 'el evento señala la pestaña a refrescar');

  // Y el dato quedó guardado de verdad: un GET lo devuelve.
  const data = await (await fetch(base + '/api/data', { headers: { Cookie: cookie } })).json();
  assert.equal(data.meals[today].nutri.totalKcal, 400);
  controller.abort();
});
