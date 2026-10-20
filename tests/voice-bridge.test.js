// Pruebas del puente de voz (lib/voice-bridge.js): RMS, suavizado, estados y cadencia.
// No necesitan micrófono ni servidor: se alimenta PCM sintético y se cuenta lo reportado.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { VoiceBridge, rmsOfPcm16, levelOfRms } = require('../lib/voice-bridge');
const { parseDshowAudioDevices, captureInputArgs } = require('../scripts/jarvis-voice-bridge');

const RATE = 16000;
// 20 ms de audio a 16 kHz: la ventana que arma el puente entre mediciones.
const FRAME_MS = 20;

function pcm(amplitude, ms = FRAME_MS) {
  const n = Math.round((RATE * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(amplitude * 32767), i * 2);
  return buf;
}

// Simula el paso del tiempo frame a frame y devuelve lo que se reportó.
function run(bridge, steps, { from = 0, stepMs = 40, chunk } = {}) {
  const posts = [];
  for (let i = 0; i < steps; i++) {
    bridge.feed(typeof chunk === 'function' ? chunk(i) : chunk);
    const now = from + i * stepMs;
    bridge.tick(now);
    const body = bridge.payload();
    posts.push({ now, ...body });
  }
  return posts;
}

test('rmsOfPcm16: silencio, media escala y onda cuadrada', () => {
  assert.equal(rmsOfPcm16(Buffer.alloc(0)), 0);
  assert.equal(rmsOfPcm16(pcm(0)), 0);
  assert.ok(Math.abs(rmsOfPcm16(pcm(0.5)) - 0.5) < 0.001, 'media escala ≈ 0,5');
  assert.ok(Math.abs(rmsOfPcm16(pcm(1)) - 1) < 0.001, 'escala completa ≈ 1');
});

test('levelOfRms aplica ganancia y recorta a 1', () => {
  assert.equal(levelOfRms(0), 0);
  assert.ok(Math.abs(levelOfRms(0.1) - 0.32) < 1e-9);
  assert.equal(levelOfRms(0.9), 1);
});

test('el suavizado ataca rápido y cae suave', () => {
  const up = new VoiceBridge({ post: () => {} });
  up.tick(0);
  const climb = [];
  for (let i = 1; i <= 10; i++) { up.feed(pcm(0.3)); up.tick(i * 40); climb.push(up.smooth); }

  const down = new VoiceBridge({ post: () => {} });
  for (let i = 0; i <= 20; i++) { down.feed(pcm(0.3)); down.tick(i * 40); }

  const afterUp = climb[5];
  const drop = [];
  for (let i = 1; i <= 10; i++) { down.tick(800 + i * 40); drop.push(down.smooth); }
  const earned = afterUp - climb[0];
  const lost = down.smooth - drop[5];
  assert.ok(earned > 0, 'el nivel sube');
  assert.ok(lost < earned, 'en el mismo tiempo baja menos de lo que subió');
  // Y a la larga sí vuelve a cero.
  for (let i = 0; i < 40; i++) down.tick(2000 + i * 40);
  assert.ok(down.smooth < 0.01, `debería volver a cero, quedó en ${down.smooth}`);
});

test('silencio → idle, voz → listening, y vuelve a idle tras el margen', () => {
  const posts = [];
  const bridge = new VoiceBridge({ post: (body) => posts.push(body) });
  run(bridge, 5, { chunk: pcm(0) });
  assert.ok(posts.every((p) => p.state === 'idle'), 'en silencio no hay estado listening');
  assert.equal(bridge.level, 0);

  const loud = run(bridge, 8, { from: 400, chunk: pcm(0.3) });
  assert.equal(loud.at(-1).state, 'listening');
  assert.ok(loud.at(-1).level > 0.5, `el nivel con voz debería ser alto, fue ${loud.at(-1).level}`);

  // Al volver al silencio sigue listening el margen de 350 ms y después queda en reposo.
  const tail = run(bridge, 30, { from: 900, chunk: pcm(0) });
  assert.equal(tail[3].state, 'listening', 'aguanta el hueco entre palabras');
  assert.equal(tail.at(-1).state, 'idle', 'vuelve a reposo');
  assert.equal(tail.at(-1).level, 0, 'en reposo el nivel es 0');
});

test('thinking y speaking se fijan y no dejan pasar el micrófono', () => {
  const bridge = new VoiceBridge({ post: () => {} });
  run(bridge, 5, { chunk: pcm(0.4) });
  assert.equal(bridge.state, 'listening');

  assert.equal(bridge.setState('thinking'), true);
  const thinking = run(bridge, 5, { from: 400, chunk: pcm(0.4) }); // el TTS suena fuerte
  assert.ok(thinking.every((p) => p.state === 'thinking'), 'thinking se mantiene fijo');
  assert.ok(thinking.every((p) => p.level === 0), 'mientras piensa no se reporta el micrófono');

  bridge.setState('speaking');
  const speaking = run(bridge, 5, { from: 700, chunk: pcm(0.4) });
  assert.ok(speaking.every((p) => p.state === 'speaking'));

  // Al volver a listening el micrófono manda otra vez (y ya está sonando).
  bridge.setState('listening');
  const back = run(bridge, 6, { from: 1000, chunk: pcm(0.4) });
  assert.equal(back.at(-1).state, 'listening');
  assert.ok(back.at(-1).level > 0.5);

  assert.equal(bridge.setState('raro'), false, 'un estado inválido no cambia nada');
});

// Los reportes son asíncronos (y no se apilan): entre frame y frame hay que dejar
// que se resuelva la petición anterior, igual que los 25 ms del temporizador real.
const flush = () => new Promise((r) => setImmediate(r));

test('reportes: 12/s con voz, 4/s en reposo, y cambio de estado inmediato', async () => {
  const posts = [];
  const bridge = new VoiceBridge({ post: (body) => posts.push({ ...body }) });
  // 1 s de voz: 25 frames de 40 ms.
  for (let i = 0; i < 25; i++) { bridge.feed(pcm(0.4)); bridge.tick(i * 40); await flush(); }
  // 2 s de silencio.
  for (let i = 25; i < 75; i++) { bridge.feed(pcm(0)); bridge.tick(i * 40); await flush(); }
  const loud = posts.filter((p) => p.state === 'listening').length;
  const idle = posts.filter((p) => p.state === 'idle').length;
  assert.ok(loud >= 6 && loud <= 16, `~12/s con voz, hubo ${loud}`);
  // En reposo la cadencia baja a 4/s, y solo cuenta el tramo final de la corrida
  // (antes de eso el anillo sigue en `listening` por el margen entre palabras).
  assert.ok(idle >= 4 && idle <= 10, `~4/s en reposo, hubo ${idle}`);
  assert.ok(loud < 16, 'no reporta en cada frame: respeta la cadencia');
  assert.ok(posts.length < 75, 'menos reportes que frames: no va uno por frame');

  // Al aparecer la voz, el cambio a `listening` no espera el hueco de 250 ms.
  const fresh = new VoiceBridge({ post: () => {} });
  fresh.tick(0);
  await flush();
  let sentAt = 0;
  for (let i = 1; i <= 12 && !sentAt; i++) {
    fresh.feed(pcm(0.4));
    fresh.tick(i * 40);
    await flush();
    if (fresh.lastPost) sentAt = i * 40;
  }
  assert.ok(sentAt > 0 && sentAt <= 80, `el cambio a listening salió en ${sentAt} ms`);
});

test('un error de red no rompe el puente y sigue reportando', async () => {
  let calls = 0;
  const errors = [];
  const bridge = new VoiceBridge({
    post: () => { calls++; if (calls === 1) return Promise.reject(new Error('conexión rechazada')); },
    onError: (e) => errors.push(e),
  });
  for (let i = 0; i < 20; i++) { bridge.feed(pcm(0.4)); bridge.tick(i * 40); await flush(); }
  assert.equal(errors.length, 1);
  assert.ok(calls >= 2, 'siguió reportando después del error');
});

test('si el reporte anterior sigue en vuelo, el cambio de estado no se pierde', async () => {
  const posts = [];
  let release;
  const bridge = new VoiceBridge({
    post: (body) => { posts.push(body.state); return new Promise((r) => { release = r; }); },
  });
  bridge.feed(pcm(0));
  bridge.tick(300);                  // primer reporte (idle) y queda en vuelo
  await flush();
  assert.deepEqual(posts, ['idle']);
  bridge.feed(pcm(0));
  bridge.tick(600);                  // en vuelo: no se apila una segunda petición
  await flush();
  assert.deepEqual(posts, ['idle'], 'no se apilan peticiones en paralelo');
  bridge.setState('speaking');
  bridge.tick(700);                  // el cambio de estado se encola
  await flush();
  assert.deepEqual(posts, ['idle']);
  release();                         // al liberarse, sale lo encolado
  await flush();
  await flush();
  assert.deepEqual(posts, ['idle', 'speaking'], `el estado fijado llegó igual: ${posts.join(' → ')}`);
});

test('la ventana de audio no crece sin límite si nadie mide', () => {
  const bridge = new VoiceBridge({ post: () => {} });
  for (let i = 0; i < 100; i++) bridge.feed(pcm(0.5, 100)); // 10 s sin tick()
  assert.ok(bridge.pending.length <= Math.round(RATE * 2 * 0.12) + 2, 'la ventana queda acotada');
});

test('los nombres de micrófono salen del bloque de audio de ffmpeg', () => {
  const out = [
    '[dshow @ 000] "HD WebCam"',
    '[dshow @ 000]   Alternative name "@device_pnp_\\\\?\\usb#vid_1234"',
    '[dshow @ 000] DirectShow audio devices',
    '[dshow @ 000]  "Micrófono (Realtek(R) Audio)"',
    '[dshow @ 000]  "Auriculares manos libres"',
    '[dshow @ 000]     Alternative name "@device_cm_{33D9A762}"',
  ].join('\r\n');
  assert.deepEqual(parseDshowAudioDevices(out), ['Micrófono (Realtek(R) Audio)', 'Auriculares manos libres']);

  // Formato de ffmpeg 7+: una sola lista con marcas (video)/(audio).
  const moderno = [
    '[in#0 @ 000002669f69dc40] "DroidCam Video" (video)',
    '[in#0 @ 000002669f69dc40]   Alternative name "@device_pnp_\\\\?\\root#media#0000"',
    '[in#0 @ 000002669f69dc40] "Micrófono (DroidCam Audio)" (audio)',
    '[in#0 @ 000002669f69dc40]   Alternative name "@device_cm_{33D9A762}"',
  ].join('\r\n');
  assert.deepEqual(parseDshowAudioDevices(moderno), ['Micrófono (DroidCam Audio)']);
});

test('captureInputArgs elige la entrada del sistema y respeta --file', () => {
  const win = captureInputArgs({ device: 'Mic' }, 'Mic', RATE);
  assert.deepEqual(win.slice(win.length - 2), ['-i', 'audio=Mic']);
  const file = captureInputArgs({ file: 'prueba.wav' }, '', RATE);
  assert.deepEqual(file.slice(0, 2), ['-re', '-i']);
  assert.ok(file[2].endsWith('prueba.wav'));
});

// ===== Interrupción (barge-in) =====
// Mientras el estado es `speaking`, el micrófono se sigue midiendo: la prueba
// alimenta el "eco del TTS" y después la voz del usuario por encima.

// Corre `steps` frames de 40 ms con el estado fijado en speaking y devuelve los
// eventos de interrupción, con el nivel de micrófono en cada frame.
function speak(bridge, amp, steps, { from = 0, stepMs = 40 } = {}) {
  const niveles = [];
  for (let i = 0; i < steps; i++) {
    bridge.feed(pcm(amp));
    bridge.tick(from + i * stepMs);
    niveles.push(bridge.micLevel);
  }
  return niveles;
}

function bargeBridge(extra = {}) {
  const eventos = [];
  const bridge = new VoiceBridge({
    post: () => {},
    gain: 3.2,
    ...extra,
    onBargeIn: (e) => eventos.push(e),
  });
  bridge.setState('speaking');
  return { bridge, eventos };
}

test('el eco constante del TTS no dispara ninguna interrupción', () => {
  const { bridge, eventos } = bargeBridge();
  const niveles = speak(bridge, 0.05, 60); // 2,4 s de eco
  // El eco se aprende: el umbral queda por encima de su propio nivel.
  assert.ok(bridge.baseline > 0.13 && bridge.baseline < 0.18, `eco aprendido ${bridge.baseline.toFixed(3)}`);
  assert.equal(eventos.length, 0, 'nadie habló: no debería avisar');
  assert.ok(niveles.every((n) => n < 0.2), 'el nivel medido es el del eco, no 0');
});

test('hablar por encima del eco dispara una sola vez', () => {
  const { bridge, eventos } = bargeBridge();
  speak(bridge, 0.05, 25);                 // 1 s de eco (calibración)
  speak(bridge, 0.15, 1, { from: 1000 });  // el usuario entra hablando
  speak(bridge, 0.15, 20, { from: 1040 });
  assert.equal(eventos.length, 1, `un aviso por interrupción, hubo ${eventos.length}`);
  const ev = eventos[0];
  assert.ok(ev.level > 0.4 && ev.level < 0.55, `nivel del usuario ${ev.level}`);
  assert.ok(ev.baseline < 0.2, `línea de base del eco ${ev.baseline}`);
  assert.ok(ev.heldMs >= 220, `se exigió sostener ${ev.heldMs} ms`);
  assert.ok(ev.at >= 1000, 'avisó cuando el usuario habló, no antes');

  // Sigue hablando 1 s más: no vuelve a avisar.
  speak(bridge, 0.15, 25, { from: 2000 });
  assert.equal(eventos.length, 1, 'no repite mientras el mismo habla sigue');
});

test('un golpe corto (tos, ruido) no alcanza', () => {
  const { bridge, eventos } = bargeBridge();
  speak(bridge, 0.05, 25);
  speak(bridge, 0.15, 2, { from: 1000 }); // 80 ms: menos que el hold de 220 ms
  speak(bridge, 0.05, 25, { from: 1120 });
  assert.equal(eventos.length, 0, 'no debería avisar por un pico corto');
});

test('se vuelve a armar cuando el nivel baja y hay una segunda interrupción', () => {
  const { bridge, eventos } = bargeBridge();
  speak(bridge, 0.05, 25);
  speak(bridge, 0.15, 20, { from: 1000 });
  assert.equal(eventos.length, 1);
  speak(bridge, 0.05, 30, { from: 2500 }); // el usuario se calla y el eco vuelve
  speak(bridge, 0.15, 20, { from: 4000 });
  assert.equal(eventos.length, 2, `segunda interrupción detectada, hubo ${eventos.length}`);
});

test('con eco fuerte el usuario tiene que sonar más fuerte (umbral relativo)', () => {
  const { bridge, eventos } = bargeBridge();
  speak(bridge, 0.2, 25);                   // TTS fuerte: eco nivel ~0,64
  speak(bridge, 0.3, 20, { from: 1000 });   // el usuario habla parecido al eco
  assert.equal(eventos.length, 0, 'a la par del TTS no alcanza');
  speak(bridge, 0.5, 20, { from: 2000 });   // ahora sí, por encima
  assert.equal(eventos.length, 1, 'el umbral compara contra el eco, no contra un volumen fijo');
});

test('mientras Jarvis piensa el micrófono no interrumpe nada', () => {
  const { bridge, eventos } = bargeBridge();
  bridge.setState('thinking');
  speak(bridge, 0.5, 40); // alguien habla fuerte mientras Jarvis piensa
  assert.equal(eventos.length, 0, 'en `thinking` no se detecta interrupción');
  assert.ok(bridge.micLevel > 0.5, `el micrófono sí se mide (${bridge.micLevel.toFixed(2)})`);
  assert.equal(bridge.level, 0, 'aunque no se reporte al HUD');
});

test('cada frase recalibra: no hereda el eco de la anterior', () => {
  const { bridge, eventos } = bargeBridge();
  speak(bridge, 0.2, 25);                 // primera frase con TTS fuerte
  assert.equal(eventos.length, 0);
  bridge.setState('listening');            // Jarvis termina de hablar
  bridge.setState('speaking');             // nueva frase, con eco suave
  speak(bridge, 0.05, 25, { from: 2000 });
  assert.ok(bridge.baseline < 0.2, `la base volvió a aprender el eco suave: ${bridge.baseline.toFixed(3)}`);
  assert.equal(eventos.length, 0);
});

test('la interrupción se puede apagar', () => {
  const { bridge, eventos } = bargeBridge({ bargeIn: false });
  speak(bridge, 0.05, 25);
  speak(bridge, 0.5, 40, { from: 1000 });
  assert.equal(eventos.length, 0, 'con bargeIn desactivado no avisa nunca');
});
