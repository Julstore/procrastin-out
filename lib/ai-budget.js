// Presupuesto de IA: límites diarios, registro de tokens y caché de respuestas.
// Funciones puras (sin I/O): server.js guarda el estado en el documento de datos (data.aiUsage).
const crypto = require('crypto');

const MAX_LOG = 200;

function num(v, fallback) {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Variables de entorno:
//   AI_DAILY_REQUEST_LIMIT  consultas a la IA por día (0 = sin IA)
//   AI_DAILY_TOKEN_LIMIT    tokens por día
//   AI_CACHE_TTL_MIN        minutos que una respuesta idéntica se reutiliza (0 = sin caché)
function limitsFromEnv(env = process.env) {
  return {
    dailyRequests: num(env.AI_DAILY_REQUEST_LIMIT, 40),
    dailyTokens: num(env.AI_DAILY_TOKEN_LIMIT, 200000),
    cacheTtlMs: num(env.AI_CACHE_TTL_MIN, 360) * 60 * 1000,
    cacheMax: 200,
  };
}

// Uso del día. Si el día cambió, los contadores empiezan de cero; el registro se conserva (acotado).
function getUsage(store, day) {
  const s = store && typeof store === 'object' ? store : {};
  const log = Array.isArray(s.log) ? s.log : [];
  if (s.day === day) return { day, requests: Number(s.requests) || 0, tokens: Number(s.tokens) || 0, log };
  return { day, requests: 0, tokens: 0, log };
}

// Devuelve el motivo del bloqueo o null si todavía hay cupo.
function quotaError(usage, limits) {
  if (usage.requests >= limits.dailyRequests) {
    return `Límite diario de IA alcanzado (${limits.dailyRequests} consultas). Vuelve mañana.`;
  }
  if (usage.tokens >= limits.dailyTokens) {
    return `Límite diario de tokens de IA alcanzado (${limits.dailyTokens}). Vuelve mañana.`;
  }
  return null;
}

// Reserva una consulta antes de llamar a la IA. Es síncrona, así que dos peticiones
// simultáneas no pueden pasar ambas el mismo límite.
function reserveRequest(store, day) {
  const u = getUsage(store, day);
  return { day, requests: u.requests + 1, tokens: u.tokens, log: u.log };
}

// Tokens reales si el proveedor los informa; si no, estimación por caracteres (~4 por token).
function tokenCounts(apiUsage, messages, reply) {
  const total = Number(apiUsage?.total_tokens);
  const p = Number(apiUsage?.prompt_tokens);
  const c = Number(apiUsage?.completion_tokens);
  if (Number.isFinite(total)) {
    return { promptTokens: Number.isFinite(p) ? p : 0, completionTokens: Number.isFinite(c) ? c : 0, totalTokens: total, estimated: false };
  }
  if (Number.isFinite(p) && Number.isFinite(c)) {
    return { promptTokens: p, completionTokens: c, totalTokens: p + c, estimated: false };
  }
  const promptTokens = Math.ceil(JSON.stringify(messages).length / 4);
  const completionTokens = Math.ceil(String(reply || '').length / 4);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: true };
}

// Suma tokens y agrega una línea al registro. Una respuesta desde caché no gasta tokens.
function recordCall(store, day, entry) {
  const u = getUsage(store, day);
  const cached = !!entry.cached;
  const totalTokens = cached ? 0 : (Number(entry.totalTokens) || 0);
  const line = {
    at: new Date().toISOString(),
    kind: entry.kind || 'otro',
    model: entry.model || '',
    cached,
    ok: entry.ok !== false,
    estimated: !!entry.estimated,
    promptTokens: cached ? 0 : (Number(entry.promptTokens) || 0),
    completionTokens: cached ? 0 : (Number(entry.completionTokens) || 0),
    totalTokens,
  };
  return { day, requests: u.requests, tokens: u.tokens + totalTokens, log: [...u.log, line].slice(-MAX_LOG) };
}

// Caché en memoria con caducidad y tope de entradas (se descarta la más antigua).
class TtlCache {
  constructor({ ttlMs, max, now = () => Date.now() }) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.now() - e.at > this.ttlMs) { this.map.delete(key); return undefined; }
    return e.value;
  }
  set(key, value) {
    if (!(this.ttlMs > 0) || !(this.max > 0)) return;
    this.map.delete(key);
    this.map.set(key, { at: this.now(), value });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

// La clave incluye la sesión: una respuesta nunca se reutiliza entre sesiones distintas.
function cacheKey(scope, model, messages) {
  return crypto.createHash('sha256').update(JSON.stringify([String(scope || ''), model, messages])).digest('hex');
}

module.exports = { MAX_LOG, limitsFromEnv, getUsage, quotaError, reserveRequest, tokenCounts, recordCall, TtlCache, cacheKey };
