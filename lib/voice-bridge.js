'use strict';
// Puente de voz para Jarvis: mide el micrófono y reporta el nivel al HUD.
//
// Es lógica pura (sin audio ni HTTP propios) para poder probarla: el CLI le pasa
// bytes PCM s16le mono por `feed()` y una función `post()` que habla con
// POST /api/agent/voice. Nada de esto guarda audio: cada ventana se mide y se tira.

const STATES = new Set(['idle', 'listening', 'thinking', 'speaking']);
// Solo estos dos estados se "fijan": mientras Jarvis piensa o habla el nivel del
// micrófono no se reporta (si no, el anillo copiaría el TTS), pero se sigue midiendo
// para detectar que alguien habla encima.
const PINNED = new Set(['thinking', 'speaking']);

const DEFAULTS = {
  fps: 12,            // 12 reportes/s alcanza para que el anillo no se note a saltos
  idleFps: 4,         // en reposo alcanza para que el HUD no vuelva solo a los 1,3 s
  gain: 3.2,          // misma escala práctica que el micrófono local del HUD
  threshold: 0.07,    // nivel suavizado a partir del cual hay voz
  holdMs: 350,        // margen para no cortar entre sílabas
  attackMs: 30,       // sube rápido…
  releaseMs: 150,     // …y baja suave, así el anillo no tiembla
  steps: 64,          // misma cuantización que el HUD: menos payload, mismo dibujo
  maxWindowMs: 120,   // si el proceso se atrasa no se acumula audio sin límite
  sampleRate: 16000,
};

// Detección de interrupción (barge-in): mientras Jarvis habla, el micrófono sigue
// midiendo aunque su nivel no se reporte. Si el nivel se despega del eco del TTS,
// es que hay alguien hablando encima. El eco se aprende al principio de cada frase:
// lo que se compara es el nivel contra sí mismo, no un volumen absoluto.
const BARGE_DEFAULTS = {
  enabled: true,
  settleMs: 150,      // se ignora el arranque de la frase: queda el eco de la anterior
  warmupMs: 400,      // …y después este tiempo para aprender el eco del TTS
  holdMs: 220,        // cuánto tiene que sostenerse por encima del umbral
  factor: 1.8,        // cuánto más fuerte que el eco del TTS
  floor: 0.18,        // piso absoluto: debajo de esto no es voz, es ruido de fondo
  refractoryMs: 1200, // no vuelve a avisar de inmediato tras un aviso
  releaseMs: 250,     // tiene que bajar del umbral para volver a armarse
  warmTauMs: 120,     // constante de tiempo para aprender el eco
  baselineTauMs: 1500,// …y para seguirlo si cambia durante la frase
};

function clamp01(v) {
  return v > 1 ? 1 : v > 0 ? v : 0;
}

// RMS normalizado (0–1) de una ventana PCM s16le mono.
function rmsOfPcm16(buf) {
  if (!buf || buf.length < 2) return 0;
  const n = buf.length >> 1;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

function levelOfRms(rms, gain = DEFAULTS.gain) {
  return clamp01((Number(rms) || 0) * (Number(gain) || 0));
}

class VoiceBridge {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    if (typeof this.cfg.post !== 'function') throw new Error('VoiceBridge necesita post()');
    this.post = this.cfg.post;
    this.now = this.cfg.now || Date.now;
    this.onError = this.cfg.onError || (() => {});
    this.onBargeIn = this.cfg.onBargeIn || null;
    this.bargeCfg = this.cfg.bargeIn === false
      ? { ...BARGE_DEFAULTS, enabled: false }
      : { ...BARGE_DEFAULTS, ...(this.cfg.bargeIn || {}) };
    this.text = '';

    this.pending = Buffer.alloc(0);
    this.smooth = 0;
    // Mismo suavizado pero en RMS lineal, sin recortar: la detección de
    // interrupción necesita distinguir "más fuerte que el eco" incluso cuando el
    // nivel ya llegó al techo de la escala.
    this.smoothRms = 0;
    this.pinned = null;
    this.level = 0;
    this.state = 'idle';
    // -Infinity y no 0: si no, la primera medición (o cualquier `now` chico en
    // una prueba) contaría como "recién hubo voz" y arrancaría en listening.
    this.lastLoud = Number.NEGATIVE_INFINITY;
    this.lastTick = this.now();
    this.lastPost = 0;
    this.lastPayload = '';
    this.inflight = false;
    this.queued = false;
    this.posts = 0;

    // Interrupción: `micLevel` es el nivel que se mide aunque no se reporte.
    // Nivel real del micrófono (escala del HUD, sin recortar): se mide siempre,
    // aunque mientras Jarvis habla no se reporte.
    this.micLevel = 0;
    this.baseline = 0;
    this.bargeIns = 0;
    this.det = null;
  }

  // Bytes PCM s16le mono tal como salen de ffmpeg (o de un WAV sin cabecera).
  feed(chunk) {
    if (!chunk || !chunk.length) return;
    const max = Math.round((this.cfg.sampleRate * this.cfg.maxWindowMs) / 1000) * 2;
    let next = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    if (next.length > max) next = next.subarray(next.length - max);
    this.pending = next;
  }

  // `thinking`/`speaking` se fijan hasta que Jarvis vuelva a `listening` o `idle`
  // (o hasta llamar `resume()`). Los otros dos devuelven el control al micrófono.
  setState(state) {
    if (!STATES.has(state)) return false;
    const next = PINNED.has(state) ? state : null;
    // Cada frase arranca con el eco en blanco: si no, el umbral de la frase
    // anterior seguiría mandando.
    if (next !== this.pinned) this.det = null;
    this.pinned = next;
    return true;
  }

  resume() {
    this.pinned = null;
    this.det = null;
  }

  setText(text) {
    this.text = typeof text === 'string' ? text.slice(0, 200) : '';
  }

  // Un "frame" del puente: mide lo acumulado, suaviza y decide si hay que reportar.
  tick(nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : this.now();
    const dt = Math.min(250, Math.max(1, now - this.lastTick));
    this.lastTick = now;

    const rms = rmsOfPcm16(this.pending);
    const raw = levelOfRms(rms, this.cfg.gain);
    this.pending = Buffer.alloc(0);

    const tau = raw > this.smooth ? this.cfg.attackMs : this.cfg.releaseMs;
    const alpha = 1 - Math.exp(-dt / tau);
    this.smooth += (raw - this.smooth) * alpha;
    this.smoothRms += (rms - this.smoothRms) * alpha;
    this.micLevel = this.smoothRms * this.cfg.gain;

    let state;
    let level;
    if (this.pinned) {
      state = this.pinned;
      level = 0;
      this.lastLoud = Number.NEGATIVE_INFINITY;
      // Solo mientras Jarvis habla: si está pensando, el micrófono no importa.
      if (this.pinned === 'speaking') this.detectBargeIn(now, dt);
    } else {
      if (this.smooth >= this.cfg.threshold) this.lastLoud = now;
      state = now - this.lastLoud <= this.cfg.holdMs ? 'listening' : 'idle';
      level = state === 'listening' ? this.smooth : 0;
    }

    const changed = state !== this.state;
    this.state = state;
    this.level = Math.round(clamp01(level) * this.cfg.steps) / this.cfg.steps;

    const interval = 1000 / (state === 'listening' ? this.cfg.fps : this.cfg.idleFps);
    const due = now - this.lastPost >= interval;
    // El cambio de estado se manda ya: si Jarvis pasa a `thinking`, el HUD no
    // tiene que esperar hasta el próximo hueco de la cadencia lenta.
    if (!due && !(changed && now - this.lastPost >= 40)) return null;
    return this.send(now);
  }

  // Compara el nivel del micrófono contra el eco que dejó el TTS. Devuelve el
  // evento (y llama a `onBargeIn`) la primera vez de cada interrupción.
  detectBargeIn(now, dt) {
    const cfg = this.bargeCfg;
    if (!cfg.enabled) return null;
    if (!this.det) {
      this.det = { startedAt: now, warm: false, baseline: 0, peak: 0, above: 0, armed: true, firedAt: -Infinity, belowAt: 0 };
    }
    const d = this.det;
    // En unidades de la escala del HUD, pero sin recortar a 1: si el eco es
    // fuerte, el usuario tiene que sonar más fuerte todavía y eso hay que verlo.
    const level = this.micLevel;

    if (!d.warm) {
      // Los primeros milisegundos de la frase todavía traen el sonido anterior:
      // si se aprendieran, el umbral arrancaría altísimo y nada podría interrumpir.
      if (now - d.startedAt < cfg.settleMs) return null;
      // Fase de aprendizaje: se queda con lo que suena el TTS por el parlante.
      const a = 1 - Math.exp(-dt / cfg.warmTauMs);
      d.baseline += (level - d.baseline) * a;
      d.peak = Math.max(d.peak, level);
      if (now - d.startedAt >= cfg.settleMs + cfg.warmupMs) {
        d.warm = true;
        d.baseline = Math.max(d.baseline, d.peak * 0.9);
        this.baseline = d.baseline;
      }
      return null;
    }

    const threshold = Math.max(cfg.floor, d.baseline * cfg.factor);
    this.baseline = d.baseline;

    if (level >= threshold) {
      // Acá el eco NO se sigue: si el umbral trepara a la voz del usuario, no
      // habría interrupción que detectar.
      d.belowAt = 0;
      if (!d.above) d.above = now;
      const held = now - d.above;
      if (d.armed && held >= cfg.holdMs && now - d.firedAt >= cfg.refractoryMs) {
        const round = (v) => Math.round(v * 100) / 100;
        const event = {
          level: round(level),
          baseline: round(d.baseline),
          threshold: round(threshold),
          heldMs: Math.round(held),
          at: now,
        };
        d.armed = false;
        d.firedAt = now;
        d.above = 0;
        this.bargeIns++;
        if (this.onBargeIn) this.onBargeIn(event);
        return event;
      }
      return null;
    }

    d.above = 0;
    // El eco se sigue despacio mientras el TTS habla por sí solo (sube y baja).
    d.baseline += (level - d.baseline) * (1 - Math.exp(-dt / cfg.baselineTauMs));
    this.baseline = d.baseline;
    if (level < threshold * 0.7) {
      if (!d.belowAt) d.belowAt = now;
      if (now - d.belowAt >= cfg.releaseMs) { d.armed = true; d.belowAt = 0; }
    } else {
      d.belowAt = 0;
    }
    return null;
  }

  payload() {
    const body = { level: this.level, state: this.state };
    if (this.text) body.text = this.text;
    return body;
  }

  send(now = this.now()) {
    const body = this.payload();
    // Si el reporte anterior todavía está en vuelo no se apilan peticiones: se
    // guarda que hay algo nuevo y se manda al volver (así un cambio de estado no
    // se pierde aunque el servidor esté lento).
    if (this.inflight) { this.queued = true; return null; }
    const key = `${body.level}|${body.state}|${body.text || ''}`;
    this.lastPost = now;
    this.lastPayload = key;
    this.inflight = true;
    this.posts++;
    Promise.resolve()
      .then(() => this.post(body))
      .catch((e) => this.onError(e))
      .finally(() => {
        this.inflight = false;
        if (this.queued) { this.queued = false; this.send(this.now()); }
      });
    return body;
  }
}

module.exports = {
  STATES,
  PINNED,
  DEFAULTS,
  BARGE_DEFAULTS,
  clamp01,
  rmsOfPcm16,
  levelOfRms,
  VoiceBridge,
};
