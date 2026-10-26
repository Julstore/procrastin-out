// Pruebas de contrato del agente externo (Jarvis): token, comandos atómicos,
// idempotencia, undo, auditoría y eventos SSE. Correr con: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const TOKEN = 'f'.repeat(64);
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
    try { const r = await fetch(url); if (r.ok) return; } catch (_) { /* todavía no escucha */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('el servidor no arrancó: ' + url);
}

async function startServer(port, extraEnv = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      POUT_DATA_DIR: dataDir,
      PUBLIC_URL: '',
      DATABASE_URL: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  await waitFor(`http://127.0.0.1:${port}/login.html`);
  return proc;
}

async function request(method, p, body, headers = {}) {
  const r = await fetch('http://127.0.0.1:' + new URL(base).port + p, {
    method,
    // Sin seguir redirecciones: interesa el 302 de la puerta de sesión, no el login.
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* respuesta sin JSON */ }
  return { status: r.status, json, text };
}

const auth = () => ({ Authorization: 'Bearer ' + TOKEN });
const agent = (method, p, body) => request(method, p, body, auth());
const cmd = (command, args, requestId) => agent('POST', '/api/agent/command', {
  command,
  args: args || {},
  requestId: requestId || crypto.randomUUID(),
  source: 'test',
});

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pout-agent-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = await startServer(port, { POUT_AGENT_TOKEN: TOKEN });
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
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// ===== Autenticación y alcance =====

test('sin token, /api/agent/command responde 401', async () => {
  const r = await request('POST', '/api/agent/command', { command: 'status.today' });
  assert.equal(r.status, 401);
});

test('un token inválido no abre nada', async () => {
  const r = await request('POST', '/api/agent/command', { command: 'status.today' }, { Authorization: 'Bearer nope' });
  assert.equal(r.status, 401);
});

test('con token válido el agente lee, pero no escribe por fuera de los comandos', async () => {
  const read = await agent('GET', '/api/data');
  assert.equal(read.status, 200);
  assert.ok(Array.isArray(read.json.tasks));

  const write = await agent('PUT', '/api/data', { tasks: [] });
  assert.equal(write.status, 401, 'el token no puede hacer PUT /api/data');
});

test('el token de agente no sirve para el PIN ni para las páginas', async () => {
  const page = await request('GET', '/', undefined, auth());
  assert.equal(page.status, 302, 'una página sigue pidiendo sesión');
  const change = await agent('POST', '/api/auth/change', { current: '1234', pin: '9999' });
  assert.equal(change.status, 401);
});

// ===== Descubrimiento =====

test('catalog lista los comandos disponibles', async () => {
  const r = await cmd('catalog');
  assert.equal(r.status, 200);
  assert.ok(r.json.data.commands.length >= 30);
  const names = r.json.data.commands.map(c => c.name);
  for (const n of ['tasks.add', 'tasks.complete', 'habits.check', 'meals.item', 'water.add', 'nav.open', 'undo']) {
    assert.ok(names.includes(n), `falta ${n} en el catálogo`);
  }
  assert.match(r.json.say, /comandos/);
});

test('un comando desconocido responde 400 con la lista de válidos', async () => {
  const r = await cmd('volar.al.espacio');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'comando desconocido');
  assert.ok(r.json.commands.includes('tasks.add'));
});

// ===== Tareas: crear, XP, idempotencia, undo =====

let createdTaskId = null;

test('tasks.add crea la tarea, devuelve say y deja undoToken', async () => {
  const r = await cmd('tasks.add', { title: 'Pagar la luz', priority: 'alta', due: '2026-10-20' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.data.title, 'Pagar la luz');
  assert.equal(r.json.data.done, false);
  assert.match(r.json.say, /Anotado: Pagar la luz/);
  assert.match(r.json.undoToken, /^[a-f0-9]{18}$/);
  createdTaskId = r.json.data.id;

  const data = await agent('GET', '/api/data');
  assert.ok(data.json.tasks.some(t => t.id === createdTaskId));
});

test('el mismo requestId no duplica la tarea', async () => {
  const rid = crypto.randomUUID();
  const first = await cmd('tasks.add', { title: 'Llamar al dentista' }, rid);
  const again = await cmd('tasks.add', { title: 'Llamar al dentista' }, rid);
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(again.json.deduped, true);
  assert.equal(again.json.data.id, first.json.data.id);

  const tasks = (await agent('GET', '/api/tasks')).json;
  assert.equal(tasks.filter(t => t.title === 'Llamar al dentista').length, 1);
});

test('el mismo requestId con otro contenido da 409', async () => {
  const rid = crypto.randomUUID();
  await cmd('tasks.add', { title: 'Comprar pan' }, rid);
  const r = await cmd('tasks.add', { title: 'Comprar leche' }, rid);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /requestId/);
});

test('tasks.complete da XP según prioridad y no lo repite', async () => {
  const done = await cmd('tasks.complete', { id: createdTaskId });
  assert.equal(done.status, 200);
  assert.equal(done.json.data.done, true);
  assert.equal(done.json.game.xp, 25, 'prioridad alta = 25 XP');
  assert.match(done.json.say, /Hecho: Pagar la luz/);

  const again = await cmd('tasks.complete', { id: createdTaskId });
  assert.equal(again.json.game, null, 'completar dos veces no da XP otra vez');
});

test('match ambiguo responde 409 con candidatos', async () => {
  await cmd('tasks.add', { title: 'Pagar el gas' });
  await cmd('tasks.add', { title: 'Pagar el agua' });
  const r = await cmd('tasks.complete', { match: 'Pagar el' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /ambiguo/i);
  assert.equal(r.json.candidates.length, 2);
});

test('match exacto resuelve sin ambigüedad', async () => {
  const r = await cmd('tasks.complete', { match: 'PAGAR EL AGUA' });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.done, true);
});

test('tasks.remove exige confirmación y borra con ella', async () => {
  const add = await cmd('tasks.add', { title: 'Tarea para borrar' });
  const id = add.json.data.id;

  const noConfirm = await cmd('tasks.remove', { id });
  assert.equal(noConfirm.status, 422);
  assert.equal(noConfirm.json.field, 'confirm');
  const stillThere = (await agent('GET', '/api/tasks')).json.some(t => t.id === id);
  assert.equal(stillThere, true, 'sin confirm no se borra nada');

  const ok = await cmd('tasks.remove', { id, confirm: true });
  assert.equal(ok.status, 200);
  const gone = (await agent('GET', '/api/tasks')).json.some(t => t.id === id);
  assert.equal(gone, false);
});

test('undo revierte el último comando dentro de la ventana', async () => {
  const add = await cmd('tasks.add', { title: 'Tarea efímera' });
  const id = add.json.data.id;
  assert.ok((await agent('GET', '/api/tasks')).json.some(t => t.id === id));

  const undo = await cmd('undo', { undoToken: add.json.undoToken });
  assert.equal(undo.status, 200);
  assert.equal(undo.json.data.undid, 'tasks.add');
  assert.match(undo.json.say, /Deshecho/);
  assert.equal((await agent('GET', '/api/tasks')).json.some(t => t.id === id), false);
});

test('undo sin token válido responde 410', async () => {
  const r = await cmd('undo', { undoToken: 'noexiste' });
  assert.equal(r.status, 410);
});

// ===== Hábitos, agua, salud =====

test('habits.add y habits.check: XP solo la primera vez del día', async () => {
  const add = await cmd('habits.add', { name: 'Leer 20 minutos', icon: 'book', targetPerWeek: 5 });
  assert.equal(add.status, 200);
  assert.equal(add.json.data.emoji, 'book');

  const first = await cmd('habits.check', { name: 'leer 20 minutos' });
  assert.equal(first.status, 200);
  assert.equal(first.json.game.xp, 10);
  assert.equal(first.json.data.done, true);

  const second = await cmd('habits.check', { name: 'Leer 20 minutos' });
  assert.equal(second.json.game, null, 'el segundo check del día no da XP');
});

test('habits.check rechaza días futuros', async () => {
  const r = await cmd('habits.check', { name: 'Leer 20 minutos', date: '2099-01-01' });
  assert.equal(r.status, 422);
  assert.equal(r.json.field, 'date');
});

test('un icono de hábito inválido se rechaza', async () => {
  const r = await cmd('habits.add', { name: 'Con icono raro', icon: 'no-existe' });
  assert.equal(r.status, 422);
  assert.equal(r.json.field, 'icon');
});

test('water.add respeta el tope de 8 vasos por día', async () => {
  const a = await cmd('water.add', { glasses: 5 });
  assert.equal(a.json.data.water, 5);
  assert.equal(a.json.data.added, 5);
  assert.equal(a.json.game.xp, 5);

  const b = await cmd('water.add', { glasses: 5 });
  assert.equal(b.json.data.water, 8, 'no pasa de 8');
  assert.equal(b.json.data.added, 3, 'solo suma los 3 que faltaban');
  assert.match(b.json.say, /8 vasos/);

  const c = await cmd('water.add', { glasses: 2 });
  assert.equal(c.json.data.added, 0);
  assert.equal(c.json.game, null);
});

test('meals.item agrega el alimento con sus gramos a la franja', async () => {
  const a = await cmd('meals.item', { slot: 'dinner', name: 'brownie', grams: 200 });
  assert.equal(a.status, 200);
  assert.deepEqual(a.json.data.items.at(-1), { n: 'brownie', g: 200 });
  assert.match(a.json.say, /200/);

  const b = await cmd('meals.item', { slot: 'dinner', name: 'yogur' });
  assert.equal(b.status, 200);
  const dinner = b.json.data.items.filter(it => it.n === 'yogur');
  assert.equal(dinner.length, 1);
  assert.equal(dinner[0].g, null, 'sin gramos dichos queda null');

  // No pisa lo que ya había: la lista suma.
  assert.ok(b.json.data.items.some(it => it.n === 'brownie'));

  const c = await cmd('meals.item', { slot: 'almuerzo', name: 'x' });
  assert.equal(c.status, 422, 'slot fuera de MEAL_SLOTS se rechaza');
});

test('health.measure guarda y actualiza el mismo día', async () => {
  const first = await cmd('health.measure', { weight: 82.5, sleep: 7 });
  assert.equal(first.status, 200);
  const second = await cmd('health.measure', { weight: 82.1 });
  assert.equal(second.status, 200);

  const data = (await agent('GET', '/api/data')).json;
  const hits = data.measurements.filter(m => m.date === first.json.data.date);
  assert.equal(hits.length, 1, 'no duplica el día');
  assert.equal(hits[0].weight, 82.1);
  assert.equal(hits[0].sleep, 7, 'conserva lo ya registrado');
});

test('health.measure sin datos responde 422', async () => {
  const r = await cmd('health.measure', {});
  assert.equal(r.status, 422);
});

// ===== UI y eventos =====

test('nav.open valida la pestaña y devuelve ui', async () => {
  const ok = await cmd('nav.open', { tab: 'finances' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ui.tab, 'finances');
  assert.match(ok.json.say, /finanzas/);

  const bad = await cmd('nav.open', { tab: 'criptomonedas' });
  assert.equal(bad.status, 422);
});

test('pomodoro.start calcula endsAt y stop lo cierra', async () => {
  const before = Date.now();
  const start = await cmd('pomodoro.start', { minutes: 25, label: 'Informe' });
  assert.equal(start.status, 200);
  assert.equal(start.json.data.minutes, 25);
  assert.ok(start.json.data.endsAt >= before + 24 * 60_000);

  const stop = await cmd('pomodoro.stop');
  assert.equal(stop.status, 200);
  assert.equal(stop.json.data.running, false);
});

test('la revisión del estado sube en cada escritura', async () => {
  const a = await agent('GET', '/api/state/rev');
  assert.equal(a.status, 200);
  await cmd('tasks.add', { title: 'Mover la revisión' });
  const b = await agent('GET', '/api/state/rev');
  assert.ok(b.json.rev > a.json.rev, `${b.json.rev} debería superar ${a.json.rev}`);
});

test('el cliente SSE recibe el cambio hecho por el agente', async () => {
  const controller = new AbortController();
  const sse = await fetch(base + '/api/agent/events', {
    headers: { Accept: 'text/event-stream', ...auth() },
    signal: controller.signal,
  });
  assert.equal(sse.status, 200);
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readUntil = async (needle, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(needle)) return true;
    }
    return false;
  };

  assert.ok(await readUntil('event: hello'), 'debería saludar al conectar');
  await cmd('tasks.add', { title: 'Tarea para el evento' });
  assert.ok(await readUntil('event: state'), 'debería emitir state tras el comando');
  const frame = buffer.slice(buffer.indexOf('event: state'));
  const payload = JSON.parse(frame.slice(frame.indexOf('data: ') + 6, frame.indexOf('\n', frame.indexOf('data: '))));
  assert.equal(payload.origin, 'agent');
  assert.ok(payload.rev > 0);
  controller.abort();
});

test('el PUT humano hecho por el agente avisa a la UI con origin agent', async () => {
  const controller = new AbortController();
  const sse = await fetch(base + '/api/agent/events', {
    headers: { Accept: 'text/event-stream', ...auth() },
    signal: controller.signal,
  });
  assert.equal(sse.status, 200);
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readUntil = async (needle, ms = 5000) => {
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

  // El canal humano que necesita el PIN (p. ej. citas con hora): el agente
  // entra con su sesión de PIN y manda el PUT con el Bearer de agente encima.
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '1234' }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie') || '';
  const session = (setCookie.match(/pout_sess=([a-f0-9]{64})/) || [])[1];
  assert.ok(session, 'la app debería devolver la cookie de sesión');
  const put = await fetch(base + '/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN, Cookie: 'pout_sess=' + session },
    body: JSON.stringify({ appointments: [{ id: 'cita-put-test', title: 'Dentista', date: '2026-01-10' }] }),
  });
  assert.equal(put.status, 200);

  assert.ok(await readUntil('event: state'), 'debería emitir state tras el PUT');
  const at = buffer.lastIndexOf('event: state');
  const frame = buffer.slice(at);
  const payload = JSON.parse(frame.slice(frame.indexOf('data: ') + 6, frame.indexOf('\n', frame.indexOf('data: '))));
  assert.equal(payload.origin, 'agent', 'la UI abierta se tiene que refrescar: quien escribió fue Jarvis, no la página');
  controller.abort();
});

test('la sesión humana también puede escuchar los eventos (para la UI)', async () => {
  const r = await fetch(base + '/api/agent/events', {
    headers: { Accept: 'text/event-stream', Cookie: cookie },
  });
  assert.equal(r.status, 200);
  const reader = r.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /event: hello/);
  reader.cancel();
});

test('el agente deja auditoría en agent.log', () => {
  const log = fs.readFileSync(path.join(dataDir, 'agent.log'), 'utf8').trim().split('\n');
  assert.ok(log.length > 5);
  const entry = JSON.parse(log[log.length - 1]);
  assert.equal(typeof entry.command, 'string');
  assert.equal(typeof entry.ms, 'number');
  assert.equal(entry.ok, true);
});

// ===== Voz (niveles para el HUD) =====

async function openSSE(headers = auth()) {
  const controller = new AbortController();
  const res = await fetch(base + '/api/agent/events', {
    headers: { Accept: 'text/event-stream', ...headers },
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    status: res.status,
    buffer: () => buffer,
    readUntil: async (needle, ms = 5000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (buffer.includes(needle)) return true;
        const { value, done } = await reader.read();
        if (done) return buffer.includes(needle);
        buffer += decoder.decode(value, { stream: true });
      }
      return buffer.includes(needle);
    },
    close: () => controller.abort(),
  };
}

function firstData(frame) {
  return JSON.parse(frame.slice(frame.indexOf('data: ') + 6, frame.indexOf('\n', frame.indexOf('data: '))));
}

function frameOf(buffer, event) {
  const at = buffer.indexOf(`event: ${event}`);
  assert.ok(at >= 0, `no llegó el evento ${event}`);
  return buffer.slice(at);
}

test('heartbeat exige token, renueva presencia y reporta la última acción', async () => {
  const port = await freePort();
  const other = await startServer(port, { POUT_AGENT_TOKEN: TOKEN });
  const basePrevio = base;
  base = `http://127.0.0.1:${port}`;
  const sse = await openSSE();
  try {
    const unauthorized = await request('POST', '/api/agent/heartbeat', { instanceId: 'instance-no-token' });
    assert.equal(unauthorized.status, 401);
    assert.equal(sse.status, 200);
    assert.ok(await sse.readUntil('event: hello'));
    assert.equal(firstData(frameOf(sse.buffer(), 'hello')).agent.running, false);

    const pulse = await agent('POST', '/api/agent/heartbeat', { instanceId: 'jarvis-instance-01', source: 'jarvis-chat' });
    assert.equal(pulse.status, 200);
    assert.equal(pulse.json.agent.running, true);

    const action = await agent('POST', '/api/agent/heartbeat', {
      instanceId: 'jarvis-instance-01', source: 'jarvis-chat', action: 'Respondió una consulta',
    });
    assert.equal(action.json.agent.lastAction, 'Respondió una consulta');
    assert.ok(action.json.agent.lastActionAt > 0);
    assert.ok(await sse.readUntil('Respondió una consulta'), 'la acción se emite por SSE');
    const eventBuffer = sse.buffer();
    const actionAt = eventBuffer.lastIndexOf('Respondió una consulta');
    const statusAt = eventBuffer.lastIndexOf('event: agent-status', actionAt);
    const statusFrame = eventBuffer.slice(statusAt);
    assert.ok(statusFrame.startsWith('event: agent-status'));
    const status = firstData(statusFrame).agent;
    assert.equal(status.running, true);
    assert.equal(status.lastAction, 'Respondió una consulta');

    const stopped = await agent('POST', '/api/agent/heartbeat', { instanceId: 'jarvis-instance-01', running: false });
    assert.equal(stopped.json.agent.running, false);
    assert.equal(stopped.json.agent.heartbeatAt, 0, 'al apagarse, no se presenta como actual el último pulso antiguo');
    assert.equal(stopped.json.agent.lastAction, 'Respondió una consulta', 'el cierre conserva la última acción');
  } finally {
    sse.close();
    other.kill();
    base = basePrevio;
  }
});

test('el heartbeat expira y el estado consultable dice que Jarvis ya no corre', async () => {
  const port = await freePort();
  const other = await startServer(port, { POUT_AGENT_TOKEN: TOKEN, POUT_AGENT_HEARTBEAT_TTL_MS: '500' });
  try {
    const basePrevio = base;
    base = `http://127.0.0.1:${port}`;
    const pulse = await agent('POST', '/api/agent/heartbeat', { instanceId: 'jarvis-stale-test', action: 'Inició' });
    assert.equal(pulse.json.agent.running, true);
    await new Promise((resolve) => setTimeout(resolve, 650));
    const status = await agent('GET', '/api/agent/heartbeat');
    assert.equal(status.json.running, false);
    assert.equal(status.json.instances, 0);
    assert.equal(status.json.heartbeatAt, 0, 'un pulso vencido no se presenta como vigente');
    assert.equal(status.json.lastAction, 'Inició');
    base = basePrevio;
  } finally {
    other.kill();
  }
});

test('los eventos de presencia no filtran mensajes ni se mezclan con otras instancias', async () => {
  const port = await freePort();
  const other = await startServer(port, { POUT_AGENT_TOKEN: TOKEN });
  const basePrevio = base;
  base = `http://127.0.0.1:${port}`;
  const sse = await openSSE();
  try {
    await sse.readUntil('event: hello');
    await agent('POST', '/api/agent/heartbeat', { instanceId: 'jarvis-session-1', action: 'Respondió una consulta' });
    await sse.readUntil('Respondió una consulta');
    const frame = sse.buffer().slice(sse.buffer().lastIndexOf('event: agent-status'));
    assert.equal(firstData(frame).agent.lastAction, 'Respondió una consulta');

    await agent('POST', '/api/agent/heartbeat', { instanceId: 'jarvis-session-2', action: 'Usó read_file' });
    const otherPulse = await agent('GET', '/api/agent/heartbeat');
    assert.equal(otherPulse.json.instances, 2);
    assert.equal(otherPulse.json.running, true);

    await agent('POST', '/api/agent/heartbeat', { instanceId: 'jarvis-session-1', running: false });
    const oneLeft = await agent('GET', '/api/agent/heartbeat');
    assert.equal(oneLeft.json.instances, 1, 'cerrar una instancia no apaga la otra');
    assert.equal(oneLeft.json.running, true);
  } finally {
    sse.close();
    other.kill();
    base = basePrevio;
  }
});

test('la voz sin token no entra', async () => {
  const r = await request('POST', '/api/agent/voice', { level: 0.5, state: 'listening' });
  assert.equal(r.status, 401);
});

test('el nivel de voz se normaliza y se puede consultar', async () => {
  const post = await agent('POST', '/api/agent/voice', { level: 5, state: 'raro' });
  assert.equal(post.status, 200);

  const cur = await agent('GET', '/api/agent/voice');
  assert.equal(cur.status, 200);
  assert.equal(cur.json.level, 1, 'el nivel se recorta a 1');
  assert.equal(cur.json.state, 'listening', 'un estado desconocido cae en listening');
});

test('la voz llega por SSE y no mueve la revisión del estado', async () => {
  const sse = await openSSE();
  try {
    assert.equal(sse.status, 200);
    assert.ok(await sse.readUntil('event: hello'));
    const before = (await agent('GET', '/api/state/rev')).json.rev;

    await new Promise((r) => setTimeout(r, 60)); // el servidor limita a ~40 fps
    const post = await agent('POST', '/api/agent/voice', { level: 0.42, state: 'speaking', text: 'hola' });
    assert.equal(post.status, 200);
    assert.ok(await sse.readUntil('event: voice'), 'debería emitir el evento voice');

    const payload = firstData(frameOf(sse.buffer(), 'voice'));
    assert.equal(payload.origin, 'agent');
    assert.equal(payload.state, 'speaking');
    assert.ok(payload.level > 0.4 && payload.level <= 1);
    assert.equal(payload.text, 'hola');

    const after = (await agent('GET', '/api/state/rev')).json.rev;
    assert.equal(after, before, 'la telemetría de voz no cambia la revisión');
  } finally {
    sse.close();
  }
});

test('un HUD que se abre en medio de la conversación recibe el estado de voz', async () => {
  await agent('POST', '/api/agent/voice', { level: 0.3, state: 'thinking' });
  const sse = await openSSE();
  try {
    assert.ok(await sse.readUntil('event: hello'));
    const hello = firstData(frameOf(sse.buffer(), 'hello'));
    assert.equal(hello.voice.state, 'thinking');
    assert.ok(hello.voice.level > 0.2);
  } finally {
    sse.close();
  }
});

test('la telemetría de voz no agota el límite de comandos', async () => {
  for (let i = 0; i < 70; i++) {
    await agent('POST', '/api/agent/voice', { level: i / 70, state: 'listening' });
  }
  const r = await cmd('status.today');
  assert.equal(r.status, 200, 'después de 70 frames la app sigue aceptando comandos');
  assert.ok(r.json.data.date);
});

// ===== Token persistido =====

test('sin POUT_AGENT_TOKEN, el servidor genera data/agent-token y ese token sirve', async () => {
  const port = await freePort();
  const other = await startServer(port, { POUT_AGENT_TOKEN: '' });
  try {
    const file = path.join(dataDir, 'agent-token');
    assert.ok(fs.existsSync(file), 'debería crear agent-token');
    const saved = fs.readFileSync(file, 'utf8').trim();
    assert.match(saved, /^[a-f0-9]{64}$/);

    const r = await fetch(`http://127.0.0.1:${port}/api/agent/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + saved },
      body: JSON.stringify({ command: 'status.today' }),
    });
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.ok, true);
    assert.equal(json.data.date, new Date().toISOString().slice(0, 10));
  } finally {
    other.kill();
  }
});

test('el token no se sirve por HTTP', async () => {
  const r = await agent('GET', '/data/agent-token');
  assert.notEqual(r.status, 200);
  const r2 = await request('GET', '/agent-token', undefined, auth());
  assert.notEqual(r2.status, 200);
});
