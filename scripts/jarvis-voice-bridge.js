#!/usr/bin/env node
'use strict';
// Puente de voz: captura el micrófono con ffmpeg, mide el nivel y lo reporta a la app.
//
//   node scripts/jarvis-voice-bridge.js
//   node scripts/jarvis-voice-bridge.js --device "Micrófono (Realtek(R) Audio)"
//   node scripts/jarvis-voice-bridge.js --list-devices
//
// Jarvis puede manejarlo por stdin: `thinking`, `speaking`, `listening`, `idle`,
// `text <frase parcial>`, `status`, `quit`. No guarda audio ni escrituras: cada
// ventana se mide en memoria y se descarta.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { VoiceBridge, DEFAULTS, BARGE_DEFAULTS } = require('../lib/voice-bridge');

const HELP = `Puente de voz de Jarvis → procrastin-out

Uso: node scripts/jarvis-voice-bridge.js [opciones]

  --url <url>        Base de la app (default: http://127.0.0.1:4321)
  --token <token>    Token de agente (default: env POUT_AGENT_TOKEN o data/agent-token)
  --device <nombre>  Dispositivo de captura (default: el primero que reporte ffmpeg)
  --list-devices     Lista los micrófonos disponibles y sale
  --file <ruta>      Usa un WAV/PCM como entrada (repite en tiempo real; para pruebas)
  --ffmpeg <ruta>    Binario de ffmpeg (default: ffmpeg del PATH)
  --fps <n>          Reportes por segundo con voz (default: ${DEFAULTS.fps})
  --idle-fps <n>     Reportes por segundo en reposo (default: ${DEFAULTS.idleFps})
  --gain <n>         Ganancia del RMS (default: ${DEFAULTS.gain})
  --threshold <n>    Nivel para considerar que hay voz (default: ${DEFAULTS.threshold})
  --no-barge-in      No avisar cuando alguien habla encima de Jarvis
  --barge-floor <n>  Piso del nivel para la interrupción (default: ${BARGE_DEFAULTS.floor})
  --barge-factor <n> Cuánto más fuerte que el eco del TTS (default: ${BARGE_DEFAULTS.factor})
  --barge-hold <ms>  Cuánto tiene que sostenerse para avisar (default: ${BARGE_DEFAULTS.holdMs})
  --verbose          Muestra estado y nivel una vez por segundo
  --help             Esta ayuda

Estados: idle | listening (automáticos, según el micrófono) y thinking | speaking
(fijados desde stdin mientras Jarvis piensa o habla).

Interrupción: mientras el estado es 'speaking', el micrófono se mide igual (aunque el
nivel no se reporte al HUD). Si alguien habla por encima del eco del TTS, sale por
**stdout** una línea JSON: {"event":"bargeIn","level":0.62,"baseline":0.18,…}.
Los logs van por stderr, así que stdout queda limpio para que Jarvis lo lea.`;

function parseArgs(argv) {
  const out = { _: [] };
  const flags = new Set(['list-devices', 'verbose', 'help', 'no-barge-in']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const name = arg.slice(2);
    if (flags.has(name)) { out[name] = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`Falta el valor de --${name}`);
    out[name] = value;
  }
  return out;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ffmpegBin(args) {
  return args.ffmpeg || process.env.FFMPEG_PATH || 'ffmpeg';
}

// Nombres de los micrófonos que lista ffmpeg (DirectShow en Windows).
// Cubre las dos formas de listar: el bloque "DirectShow audio devices" de ffmpeg 6
// y la lista única con marcas "(audio)" de las versiones nuevas (7+).
function parseDshowAudioDevices(text) {
  const names = [];
  let inAudio = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/DirectShow audio devices/i.test(line)) { inAudio = true; continue; }
    if (/DirectShow (?:video|audio) devices/i.test(line)) { inAudio = false; continue; }
    if (/Alternative name/i.test(line)) continue; // no es un dispositivo
    const m = line.match(/\]\s+"([^"]+)"/);
    if (!m) continue;
    const tag = line.slice(line.indexOf(m[0]) + m[0].length);
    if (inAudio || /\baudio\b/i.test(tag)) names.push(m[1]);
  }
  return names;
}

function listDevices(bin) {
  return new Promise((resolve) => {
    const args = process.platform === 'win32'
      ? ['-hide_banner', '-loglevel', 'info', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']
      : ['-hide_banner', '-loglevel', 'info', '-list_devices', 'true', '-f', process.platform === 'darwin' ? 'avfoundation' : 'pulse', '-i', ''];
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      resolve(process.platform === 'win32' ? parseDshowAudioDevices(out) : out.split(/\r?\n/).filter(Boolean));
    });
  });
}

function captureInputArgs(args, device, sampleRate) {
  if (args.file) return ['-re', '-i', path.resolve(args.file)];
  if (process.platform === 'win32') return ['-f', 'dshow', '-i', `audio=${device || 'default'}`];
  if (process.platform === 'darwin') return ['-f', 'avfoundation', '-i', device || ':0'];
  const fmt = device && device.startsWith('hw:') ? 'alsa' : 'pulse';
  return ['-f', fmt, '-i', device || 'default'];
}

function resolveToken(args) {
  if (args.token) return args.token.trim();
  const env = String(process.env.POUT_AGENT_TOKEN || process.env.JARVIS_AGENT_TOKEN || '').trim();
  if (env) return env;
  const dir = process.env.POUT_DATA_DIR || path.join(__dirname, '..', 'data');
  try {
    const saved = fs.readFileSync(path.join(dir, 'agent-token'), 'utf8').trim();
    if (saved) return saved;
  } catch (_) { /* la app todavía no generó el token */ }
  return '';
}

function makePoster(baseUrl, token) {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/agent/voice`;
  return async function post(body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }
  const bin = ffmpegBin(args);

  if (args['list-devices']) {
    const names = await listDevices(bin);
    if (!names.length) {
      console.error('ffmpeg no reportó dispositivos de audio. Probá con --device <nombre>.');
      return 1;
    }
    console.log(names.join('\n'));
    return 0;
  }

  const token = resolveToken(args);
  if (!token) {
    console.error('Falta el token de agente. Abrí la app una vez (crea data/agent-token)\n' +
      'o pasá --token <token> / POUT_AGENT_TOKEN.');
    return 1;
  }

  const baseUrl = args.url || `http://127.0.0.1:${process.env.PORT || 4321}`;
  let stopping = false;
  let lastErrLog = 0;
  const post = makePoster(baseUrl, token);
  const bridge = new VoiceBridge({
    post,
    fps: num(args.fps, DEFAULTS.fps),
    idleFps: num(args['idle-fps'], DEFAULTS.idleFps),
    gain: num(args.gain, DEFAULTS.gain),
    threshold: num(args.threshold, DEFAULTS.threshold),
    bargeIn: args['no-barge-in'] ? false : {
      floor: num(args['barge-floor'], BARGE_DEFAULTS.floor),
      factor: num(args['barge-factor'], BARGE_DEFAULTS.factor),
      holdMs: num(args['barge-hold'], BARGE_DEFAULTS.holdMs),
    },
    // Un evento por interrupción, en stdout y en JSON: Jarvis lo lee y decide
    // si corta el TTS. El puente no cambia de estado por su cuenta.
    onBargeIn: (ev) => {
      process.stdout.write(`${JSON.stringify({ event: 'bargeIn', ...ev })}\n`);
      console.error(`interrupción: nivel ${ev.level.toFixed(2)} sobre eco ${ev.baseline.toFixed(2)} (umbral ${ev.threshold.toFixed(2)}, ${ev.heldMs} ms)`);
    },
    onError: (e) => {
      const now = Date.now();
      if (e && e.status === 401) {
        console.error('Token rechazado por la app. Revisá data/agent-token.');
        shutdown(1);
        return;
      }
      if (now - lastErrLog > 3000) {
        lastErrLog = now;
        console.error(`No se pudo reportar el nivel (${e.message}); sigo capturando.`);
      }
    },
  });

  let lastState = '';
  let child = null;
  let restarts = 0;
  let ticker = null;
  let verboseTimer = null;
  let resolvedDevice = args.device || '';

  function describeErr(buf) {
    return String(buf).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
  }

  function startCapture() {
    // En Windows ffmpeg necesita el nombre exacto del dispositivo; se resuelve
    // una sola vez antes de arrancar y se reusa en cada reinicio.
    const device = resolvedDevice;
    const input = captureInputArgs(args, device, bridge.cfg.sampleRate);
    const out = ['-vn', '-ac', '1', '-ar', String(bridge.cfg.sampleRate), '-f', 's16le', '-acodec', 'pcm_s16le', '-'];
    const argv = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...input, ...out];
    child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => bridge.feed(chunk));
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    child.on('error', (e) => {
      console.error(`No se pudo ejecutar ffmpeg (${e.message}). Instalalo o pasá --ffmpeg <ruta>.`);
      shutdown(1);
    });
    child.on('close', (code) => {
      if (stopping) return;
      bridge.setState('idle');
      if (args.file) {
        console.error('La entrada terminó.');
        shutdown(0);
        return;
      }
      const wait = Math.min(8000, 500 * 2 ** Math.min(restarts++, 4));
      console.error(`La captura se cortó (${code || 'sin código'}). ${describeErr(err) || 'Reintentando…'} (en ${wait} ms)`);
      setTimeout(() => { if (!stopping) startCapture(); }, wait);
    });
    console.error(`Escuchando ${args.file ? args.file : (device || 'dispositivo por defecto')} → ${baseUrl}`);
  }

  if (!args.file && process.platform === 'win32' && !args.device) {
    const names = await listDevices(bin);
    if (!names.length) {
      console.error('No encontré micrófonos. Corré con --list-devices o elegí uno con --device.');
      return 1;
    }
    resolvedDevice = names[0];
  }

  ticker = setInterval(() => {
    bridge.tick();
    if (bridge.state !== lastState) {
      lastState = bridge.state;
      if (args.verbose) console.error(`estado: ${bridge.state}`);
    }
  }, 25);

  if (args.verbose) {
    verboseTimer = setInterval(() => {
      // Mientras Jarvis habla el nivel reportado es 0; el del micrófono se muestra
      // igual porque es el que decide la interrupción.
      const mic = bridge.state === 'speaking'
        ? `  · mic ${Math.min(1, bridge.micLevel).toFixed(2)} (eco ${bridge.baseline.toFixed(2)})`
        : '';
      console.error(`${bridge.state.padEnd(9)} nivel ${bridge.level.toFixed(2)}${mic}  (${bridge.posts} reportes)`);
    }, 1000);
  }

  function shutdown(code) {
    if (stopping) return;
    stopping = true;
    clearInterval(ticker);
    if (verboseTimer) clearInterval(verboseTimer);
    if (child) { try { child.kill(); } catch (_) { /* ya cerró */ } }
    // Último frame en reposo para que el HUD no quede iluminado si Jarvis se cierra.
    const final = makePoster(baseUrl, token);
    Promise.resolve(final({ level: 0, state: 'idle' }))
      .catch(() => {})
      .finally(() => process.exit(code));
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  // Siempre se lee stdin: Jarvis lo maneja como hijo con tubería, y en una
  // terminal los mismos comandos sirven para probar a mano.
  {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      const [cmd, ...rest] = text.split(/\s+/);
      if (cmd === 'quit' || cmd === 'exit') return shutdown(0);
      if (cmd === 'thinking' || cmd === 'speaking' || cmd === 'listening' || cmd === 'idle') {
        bridge.setState(cmd);
        bridge.tick();
        console.error(`estado fijado: ${cmd}`);
        return;
      }
      if (cmd === 'text') { bridge.setText(rest.join(' ')); return; }
      if (cmd === 'status') { console.error(JSON.stringify(bridge.payload())); return; }
      console.error('Comandos: thinking, speaking, listening, idle, text <frase>, status, quit');
    });
  }

  startCapture();
  return null; // sigue vivo hasta shutdown()
}

if (require.main === module) {
  main().then((code) => {
    if (typeof code === 'number') process.exit(code);
  }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { parseDshowAudioDevices, captureInputArgs, resolveToken, HELP };
