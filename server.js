// procrastin-out — vence la procrastinación. Servidor local sin dependencias externas.
// Uso: node server.js  → http://localhost:4321
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { makeUser, checkPin, findByUsername, migrateLegacyAuth } = require('./lib/users');
const { loadUserData, saveUserData, migrateLegacyData } = require('./lib/user-store');
const { pgKv } = require('./lib/kv');
const path = require('path');
const { assertPublicFeedUrl, fetchPublicFeed, stripTags, parseRssItems, clientIpFrom } = require('./lib/feed-safety');
const { limitsFromEnv, getUsage, quotaError, reserveRequest, tokenCounts, recordCall, TtlCache, cacheKey } = require('./lib/ai-budget');
const agentCommands = require('./lib/agent-commands');

// Carga de .env (clave de IA) sin dependencias externas.
// La app de escritorio (Electron) puede definir POUT_DATA_DIR: la config junto a los datos
// tiene prioridad y si no existe se usa el .env junto a server.js, como siempre.
function loadEnvFile(p) {
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch (_) { /* .env opcional */ }
}

const PORT = Number(process.env.PORT) || 4321;
const DATA_DIR = process.env.POUT_DATA_DIR || path.join(__dirname, 'data');
loadEnvFile(path.join(DATA_DIR, '.env'));
loadEnvFile(path.join(__dirname, '.env'));
const DATA_FILE = path.join(DATA_DIR, 'vida.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json'); // PIN (hash) — fuera del export de datos
const PUBLIC_DIR = path.join(__dirname, 'public');
// Marca e íconos: públicos (sin datos) para que login y la instalación PWA los vean sin sesión.
// /sw.js también es público: si no, el service worker no puede instalarse desde el login
// (302 a login.html) y los dispositivos se quedan con la versión vieja en caché.
const PUBLIC_ASSETS = new Set(['/sw.js', '/cache-guard.js', '/manifest.webmanifest', '/mark-real.png', '/label-real.png', '/icon-192.png', '/icon-512.png', '/icon-180.png', '/icon-maskable-512.png', '/splash-bg.png', '/splash-real.png']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
function lanIps() {
  const out = [];
  for (const nets of Object.values(os.networkInterfaces() || {})) {
    for (const n of nets || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

// ===== Nube opcional (p. ej. Render + Postgres gratis) =====
// Sin DATABASE_URL todo sigue en archivos locales, como siempre.
// Con DATABASE_URL, datos y PIN viven en Postgres (tabla pout_kv).
// Las sesiones siguen en memoria: cada reinicio/despliegue pide el PIN de nuevo.
const DATABASE_URL = process.env.DATABASE_URL || '';
const USE_DB = !!DATABASE_URL;
let dbPool = null;
function db() {
  if (!USE_DB) return null;
  if (!dbPool) {
    // Pruebas: POUT_TEST_PG_POOL_FILE apunta a un módulo que exporta un pool compatible con `pg`.
    if (process.env.POUT_TEST_PG_POOL_FILE) {
      dbPool = require(process.env.POUT_TEST_PG_POOL_FILE)();
    } else {
      const { Pool } = require('pg'); // solo se carga en la nube
      // SSL por defecto (Neon/Render lo exigen); con sslmode=disable se respeta (Postgres local).
      const sinSsl = /sslmode=(disable|allow)/i.test(DATABASE_URL);
      dbPool = new Pool({
        connectionString: DATABASE_URL,
        ...(sinSsl ? {} : { ssl: { rejectUnauthorized: false } }),
        max: 3,
      });
      dbPool.on('error', (e) => console.error('PG pool:', e.message));
    }
  }
  return dbPool;
}
// URL pública cuando corre en la nube (Render la inyecta sola; si no, PUBLIC_URL manual)
function publicBase() {
  return process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL
    || (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : null);
}

const DEFAULT_DATA = {
  version: 1,
  createdAt: new Date().toISOString(),
  hero: { name: 'Aventurero', xp: 0, totalXp: 0, level: 1, streak: 0, badges: {}, lastMealXpAt: 0, freeze: {}, history: [] }, // history: {date, action, xp, title}; badges: {id: 'YYYY-MM-DD'}; freeze: {week, used}
  tasks: [],           // { id, title, area, due, priority, done, createdAt }
  weeks: [],           // planes semanales fijados: { id, title, taskIds: [], status: 'active'|'done', bonusGiven, createdAt }
  habits: [],          // { id, name, emoji, targetPerWeek, log: { 'YYYY-MM-DD': 1 } }
  meals: {},           // { 'YYYY-MM-DD': { breakfast, lunch, dinner, snacks, water } }
  commitments: [],     // { id, title, person, date, notes, done, createdAt }
  finances: { monthlyIncome: 0, monthlyBudget: 0, expenses: [] }, // expenses: { id, date, category, description, amount }
  learning: [],        // { id, title, type, progress, goal, notes, createdAt }
  projects: [],        // { id, title, description, status, steps: [{text, done}], createdAt }
  appointments: [],    // { id, title, date, place, notes, done, createdAt } (salud)
  measurements: [],    // { date, weight, sleep, mood, notes }
  routine: {},         // { '0'..'6': [{name, done}], '0_focus': 'pecho'... } — rutina semanal de ejercicios
  profile: {},         // { heightCm, weightKg, age, sex, goalWeight, activity } — perfil nutricional
  interests: [],       // [string] — temas de interés para el centro de noticias
  newsFeeds: [],       // [{ id, name, url }] — feeds RSS seguidos en el centro de noticias
  smoking: { answered: false, tobacco: false, cannabis: false, log: {} }, // log: { 'YYYY-MM-DD': { cigarettes, joints } } — salud
  wishlist: [],        // [{ id, title, price, priority: 'alta'|'media'|'baja', bought, boughtAt, createdAt }] — deseos de compra (finanzas)
  shopping: [],        // [{ id, name, qty, done, createdAt }] — lista de supermercado
};;

// Backfill de claves nuevas (lo usan el modo archivo y el modo nube)
function withDefaults(loaded) {
  const merged = { ...DEFAULT_DATA, ...(loaded || {}) };
  merged.finances = { ...DEFAULT_DATA.finances, ...((loaded || {}).finances || {}) };
  merged.hero = { ...DEFAULT_DATA.hero, ...((loaded || {}).hero || {}) };
  return merged;
}
function freshDefaults() { return withDefaults({}); }
function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2), 'utf8');
    return { ...DEFAULT_DATA };
  }
  try {
    return withDefaults(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (e) {
    console.error('⚠️ data/vida.json corrupto, se crea respaldo y uno nuevo:', e.message);
    fs.copyFileSync(DATA_FILE, DATA_FILE + '.backup-' + Date.now());
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2), 'utf8');
    return { ...DEFAULT_DATA };
  }
}

let data = USE_DB ? freshDefaults() : ensureData(); // en la nube se carga desde Postgres en boot()
// Cuenta activa de la petición en curso. Los datos de cada cuenta viven en su propio archivo
// (data/users/<id>.json); la variable `data` es la cuenta de la sesión que se está atendiendo.
let activeUserId = 'admin';
const USER_DATA = new Map(); // userId -> data en memoria
function useUser(userId) {
  activeUserId = userId;
  if (!USER_DATA.has(userId)) {
    // En la nube, toda cuenta ya fue cargada desde Postgres al arrancar: una cuenta ausente
    // no se inventa vacía (eso pisaría sus datos reales al guardar).
    if (USE_DB) throw new Error('Cuenta no cargada desde la base: ' + userId);
    const stored = loadUserData(DATA_DIR, userId);
    USER_DATA.set(userId, stored ? withDefaults(stored) : freshDefaults());
  }
  data = USER_DATA.get(userId);
}
// Crea los datos vacíos de una cuenta nueva y los persiste (en la nube, en su propia fila).
function initUserData(userId) {
  USER_DATA.set(userId, freshDefaults());
  if (USE_DB) kvStore.set(dbKeyFor(userId), USER_DATA.get(userId)).catch(e => console.error('Error al crear cuenta en DB:', e.message));
  else saveUserData(DATA_DIR, userId, USER_DATA.get(userId));
}
// En la nube cada cuenta vive en su propia fila de pout_kv: `data:<id>`.
// La fila antigua `data` (un solo bloque) pertenece a la cuenta admin.
function dbKeyFor(userId) { return 'data:' + userId; }
let kvStore = null; // pgKv(pool) en la nube; las pruebas usan el doble en memoria

// Guardado con debounce para no escribir en cada tecla
let saveTimer = null;
function doSave() {
  if (USE_DB) { kvStore.set(dbKeyFor(activeUserId), data).catch(e => console.error('Error al guardar en DB:', e.message)); return; }
  try {
    saveUserData(DATA_DIR, activeUserId, data);
  } catch (e) {
    console.error('Error al guardar:', e.message);
  }
}
// Guardar al cerrar (flush) escribe la cuenta activa con sus datos actuales.
function save() {
  clearTimeout(saveTimer);
  // Fijamos la cuenta y sus datos ahora: el debounce no debe escribir en la cuenta de otra petición.
  const userId = activeUserId;
  const snapshot = data;
  USER_DATA.set(userId, snapshot);
  saveTimer = setTimeout(() => {
    if (USE_DB) { kvStore.set(dbKeyFor(userId), snapshot).catch(e => console.error('Error al guardar en DB:', e.message)); return; }
    try { saveUserData(DATA_DIR, userId, snapshot); }
    catch (e) { console.error('Error al guardar:', e.message); }
  }, 150);
}
// La app de escritorio lo usa al cerrar para no perder el último cambio. Inofensivo con `node server.js`.
module.exports = { flush: () => { clearTimeout(saveTimer); doSave(); } };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// ===== PIN local =====
// El PIN nunca se guarda en claro: hash scrypt + sal en data/auth.json (no se exporta).
let authCache = null; // espejo en memoria (archivo o Postgres por debajo)
function loadAuth() {
  if (authCache) return authCache;
  try { authCache = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); }
  catch (_) { authCache = {}; }
  return authCache;
}
function saveAuth(a) {
  authCache = a;
  if (USE_DB) { kvStore.set('auth', a).catch(e => console.error('Error al guardar auth en DB:', e.message)); return; }
  try { fs.writeFileSync(AUTH_FILE, JSON.stringify(a), 'utf8'); } catch (e) { console.error('Error al guardar auth:', e.message); }
}
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 64).toString('hex');
}
function pinOk(input, a) {
  if (!a.pinHash || input == null) return false;
  const x = Buffer.from(hashPin(input, a.salt), 'hex');
  const y = Buffer.from(a.pinHash, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// Anti fuerza bruta: 5 fallos por IP → bloqueo de 60 s
const LOGIN_FAILS = new Map(); // ip -> {count, until}
function loginBlocked(ip) {
  const e = LOGIN_FAILS.get(ip);
  if (!e || !e.until) return 0; // sin bloqueo activo (until solo se fija al 5º fallo)
  if (Date.now() >= e.until) { LOGIN_FAILS.delete(ip); return 0; }
  return Math.ceil((e.until - Date.now()) / 1000);
}
function loginFail(ip) {
  const e = LOGIN_FAILS.get(ip) || { count: 0, until: 0 };
  e.count++;
  if (e.count >= 5) e.until = Date.now() + 60_000;
  LOGIN_FAILS.set(ip, e);
}
// Sesiones en memoria (reiniciar el servidor pide login de nuevo).
// Expiran por inactividad (SESSION_IDLE_MS) y por antigüedad absoluta (SESSION_MAX_MS).
const SESSION_IDLE_MS = 12 * 3600 * 1000;
const SESSION_MAX_MS = 7 * 24 * 3600 * 1000;
const SESSIONS = new Map(); // token -> {createdAt, lastSeen}
const INVITES = new Map(); // token -> {createdAt, by}
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
function sessionExpired(s, now = Date.now()) {
  return now - s.lastSeen > SESSION_IDLE_MS || now - s.createdAt > SESSION_MAX_MS;
}
function purgeSessions() {
  const now = Date.now();
  for (const [t, s] of SESSIONS) if (sessionExpired(s, now)) SESSIONS.delete(t);
}
function newSession(userId) {
  purgeSessions();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  SESSIONS.set(token, { createdAt: now, lastSeen: now, userId });
  return token;
}
// Lista de cuentas. Un auth.json viejo (un solo PIN) se convierte en la cuenta admin.
function accountsList() {
  const a = loadAuth();
  if (Array.isArray(a.users)) return a.users;
  return migrateLegacyAuth(a);
}
function getSession(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)pout_sess=([a-f0-9]{64})/);
  if (!m) return null;
  const s = SESSIONS.get(m[1]);
  if (!s) return null;
  if (sessionExpired(s)) { SESSIONS.delete(m[1]); return null; }
  s.lastSeen = Date.now();
  return m[1];
}
// Secure solo en la nube (en LAN/local el http lo rechazaría y rompería el login).
// Se evalúa al arrancar: si agregás PUBLIC_URL después, reiniciá el servidor.
const COOKIE_SECURE = publicBase() ? '; Secure' : '';
const SESSION_COOKIE = (token) => `pout_sess=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${COOKIE_SECURE}`;
const CLEAR_COOKIE = `pout_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${COOKIE_SECURE}`;

const COLLECTIONS = {
  tasks: data => data.tasks ?? [],
  weeks: data => data.weeks ?? [],
  habits: data => data.habits ?? [],
  commitments: data => data.commitments ?? [],
  learning: data => data.learning ?? [],
  projects: data => data.projects ?? [],
  appointments: data => data.appointments ?? [],
  wishlist: data => data.wishlist ?? [],
  shopping: data => data.shopping ?? [],
};
const MUTABLE_TOP = new Set(['meals', 'finances', 'measurements']);
// PUT /api/data solo acepta claves conocidas. El héroe (XP/nivel/insignias) y los metadatos
// los maneja el servidor: aceptarlos del cliente permitiría regalarse niveles.
const PUTABLE_TOP = new Set([...Object.keys(DEFAULT_DATA), 'meds', 'routine', 'profile', 'interests', 'newsFeeds'].filter(k => !['hero', 'version', 'createdAt'].includes(k)));

const SAFE_ID = /^[0-9a-zA-Z_-]{1,64}$/;
function sanitizeItem(key, item) {
  // id obligatorio y seguro (los ids se interpolan en onclick): si viene raro, se genera uno
  const out = (item && typeof item === 'object' && !Array.isArray(item)) ? { ...item } : {};
  if (typeof out.id !== 'string' || !SAFE_ID.test(out.id)) out.id = uid();
  return out;
}

// ===== Sistema RPG =====
// XP por acción. Recompensa más lo que cuesta decidirse: lo procrastinado vale más.
const GAME = {
  tasks:            { alta: 25, media: 15, baja: 10 },
  habits:           10,      // por check diario del hábito
  commitments:      20,      // cumplir promesa a otra persona
  appointments:     20,      // asistir a cita médica
  projects:         15,      // cada paso de proyecto
  learning:         30,      // tope por avance de aprendizaje (proporcional al %)
  routine:          15,      // por ejercicio de la rutina completado
  meals:            5,       // guardar comidas del día (máx 1/hora)
  water:            1,       // por vaso de agua (máx 8/día)
};
// Niveles: cada nivel necesita (100 + (level-1)*50) XP extra → progresión suave
function xpForLevel(level) { return 100 + (level - 1) * 50; }
function levelFromXp(xp) {
  let level = 1, remaining = xp;
  while (remaining >= xpForLevel(level)) { remaining -= xpForLevel(level); level++; }
  return { level, current: remaining, need: xpForLevel(level) };
}

// Acciones que suben de nivel al héroe cuando un ítem pasa a done/check
const HERO_ACTIONS = new Set(['tasks', 'habits', 'commitments', 'appointments', 'projects', 'learning']);
const EARNED_WATER = new Map(); // key 'YYYY-MM-DD' → vasos ya recompensados

function todayKey(d = new Date()) { return d.toISOString().slice(0, 10); }
function shiftDays(dk, n) {
  const d = new Date(dk + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function currentWeekKeys() { // lunes..domingo de la semana actual
  const d = new Date();
  const start = new Date(d); start.setDate(start.getDate() - ((d.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(start); x.setDate(x.getDate() + i);
    return x.toISOString().slice(0, 10);
  });
}

// Clave semanal ISO (para el Streak Freeze: 1 día en blanco perdonado por semana)
function weekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const fday = (first.getUTCDay() + 6) % 7;
  first.setUTCDate(first.getUTCDate() - fday + 3);
  return t.getUTCFullYear() + '-W' + String(1 + Math.round((t - first) / (7 * 864e5))).padStart(2, '0');
}
function freezeState() {
  const h = data.hero || {};
  h.freeze = h.freeze || {};
  const wk = weekKey();
  if (h.freeze.week !== wk) h.freeze = { week: wk, used: false };
  return h.freeze;
}
// XP por día (la racha solo cuenta días significativos: >= STREAK_MIN XP; un vaso de agua no sostiene rachas)
const STREAK_MIN = 20;
function dayXpMap() {
  const m = {};
  for (const h of data.hero?.history || []) m[h.date] = (m[h.date] || 0) + (h.xp || 0);
  return m;
}
// Racha global: días consecutivos significativos. Un hueco de 1 día lo cubre el Streak Freeze (1/semana).
function computeStreak() {
  const dx = dayXpMap();
  const has = (k) => (dx[k] || 0) >= STREAK_MIN;
  const fr = freezeState();
  let streak = 0, saved = false;
  const d = new Date();
  const key = (x) => x.toISOString().slice(0, 10);
  if (!has(key(d))) d.setDate(d.getDate() - 1);
  while (true) {
    const k = key(d);
    if (has(k)) { streak++; d.setDate(d.getDate() - 1); continue; }
    if (streak >= 1 && !fr.used) {
      const prev = new Date(d); prev.setDate(prev.getDate() - 1);
      if (has(key(prev))) { fr.used = true; saved = true; streak++; d.setDate(d.getDate() - 2); continue; }
    }
    break;
  }
  return { streak, saved };
}
function serverHabitStreak(h) {
  let streak = 0;
  const d = new Date();
  const key = (x) => x.toISOString().slice(0, 10);
  if (!h.log?.[key(d)]) d.setDate(d.getDate() - 1);
  while (h.log?.[key(d)]) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}

// Insignias desbloqueables de procrastin-out
const BADGES = [
  { id: 'first-win', emoji: '🥇', name: 'Primera victoria', desc: 'Gana tus primeros XP', check: () => (data.hero?.totalXp || 0) > 0 },
  { id: 'task-10', emoji: '💪', name: 'Modo hacer', desc: 'Completa 10 tareas', check: () => data.tasks.filter(t => t.done).length >= 10 },
  { id: 'commit-5', emoji: '🤝', name: 'Palabra cumplida', desc: 'Cumple 5 compromisos', check: () => data.commitments.filter(c => c.done).length >= 5 },
  { id: 'habit-7', emoji: '🔥', name: 'Semana de fuego', desc: 'Racha de 7 días en un hábito', check: () => data.habits.some(h => serverHabitStreak(h) >= 7) },
  { id: 'routine-day', emoji: '🏋️', name: 'Día de acero', desc: 'Completa todos los ejercicios de un día', check: () => Object.keys(data.routine || {}).some(k => !k.endsWith('_focus') && (data.routine[k] || []).length > 0 && (data.routine[k] || []).every(e => e.done)) },
  { id: 'water-8', emoji: '💧', name: 'Bien hidratado', desc: '8 vasos de agua en un día', check: () => Object.values(data.meals || {}).some(m => (m.water || 0) >= 8) },
  { id: 'level-3', emoji: '⭐', name: 'Nivel 3', desc: 'Alcanza el nivel 3', check: () => (data.hero?.level || 1) >= 3 },
  { id: 'level-5', emoji: '🏆', name: 'Nivel 5', desc: 'Alcanza el nivel 5', check: () => (data.hero?.level || 1) >= 5 },
  { id: 'streak-3', emoji: '⚡', name: 'Racha x3', desc: '3 días seguidos sumando XP', check: () => (data.hero?.streak || 0) >= 3 },
  { id: 'learner', emoji: '📚', name: 'Mente en forma', desc: 'Completa un aprendizaje al 100%', check: () => data.learning.some(l => (l.progress || 0) >= 100) },
];
function checkBadges() {
  if (!data.hero) return [];
  data.hero.badges = data.hero.badges || {};
  const fresh = [];
  for (const b of BADGES) {
    if (!data.hero.badges[b.id]) {
      let ok = false;
      try { ok = !!b.check(); } catch (_) { /* dato viejo, ignorar */ }
      if (ok) { data.hero.badges[b.id] = todayKey(); fresh.push(b); }
    }
  }
  return fresh;
}

function grantXp(action, meta = {}) {
  if (!data.hero) data.hero = { ...DEFAULT_DATA.hero };
  const h = data.hero;
  const beforeLevel = h.level;
  const xp = meta.xp;
  let newBadges = [];
  let freezeSaved = false;
  if (xp > 0) {
    h.xp += xp;
    h.totalXp += xp;
    const prog = levelFromXp(h.totalXp);
    h.level = prog.level;
    h.xpInLevel = prog.current;
    h.xpToNext = prog.need;
    h.history.unshift({ date: todayKey(), action, xp, title: meta.title || '' });
    if (h.history.length > 30) h.history = h.history.slice(0, 30);
    const cs = computeStreak();
    h.streak = cs.streak;
    newBadges = checkBadges();
    if (cs.saved) { freezeSaved = true; console.log('❄️ Streak Freeze: la racha sobrevivió a un día en blanco'); }
    console.log(`⚔️ +${xp} XP (${action}) → nivel ${h.level}${newBadges.length ? ' 🏅 ' + newBadges.map(b => b.name).join(', ') : ''}`);
  }
  return { leveledUp: h.level > beforeLevel, newLevel: h.level, xp, title: meta.title || '', newBadges, freezeSaved };
}

function handleHeroPatch(coll, oldItem, newItem) {
  // Cierre de semana: bonus único solo si TODAS las tareas del plan están hechas
  // (cerrar sin completar no da XP; el flag igual se marca para no premiar después).
  if (coll === 'weeks') {
    if (newItem.status === 'done' && !oldItem.bonusGiven) {
      newItem.bonusGiven = true;
      const ts = (newItem.taskIds || []).map(id => (data.tasks || []).find(t => t.id === id)).filter(Boolean);
      if (ts.length && ts.every(t => t.done)) {
        return grantXp('weeks', { xp: Math.max(30, ts.length * 10), title: 'Semana completada: ' + (newItem.title || '') });
      }
    }
    return null;
  }
  if (!HERO_ACTIONS.has(coll)) return null;
  if (coll === 'learning') {
    // XP proporcional al avance registrado (tope 30 por ajuste)
    const diff = (newItem.progress || 0) - (oldItem.progress || 0);
    if (diff > 0) return grantXp(coll, { xp: Math.max(5, Math.min(30, Math.round(diff / 2))), title: newItem.title || '' });
    return null;
  }
  const wasDone = !!oldItem.done;
  const isDone = !!newItem.done;
  if (!wasDone && isDone) {
    let amount = GAME[coll];
    if (coll === 'tasks') amount = GAME.tasks[oldItem.priority] ?? GAME.tasks.media;
    if (coll === 'habits') {
      // solo XP por días nuevos marcados (recompensa el check, no el desmarcar)
      const oldLog = oldItem.log || {};
      const newLog = newItem.log || {};
      amount = GAME.habits * Object.keys(newLog).filter(k => !oldLog[k]).length;
    }
    const result = grantXp(coll, { xp: amount, title: oldItem.title || oldItem.name || '' });
    return result;
  }
  return null;
}

// Detecta logros en PUT /api/data (rutina, pasos de proyecto, comidas, agua) y otorga XP.
// Devuelve info para el toast del cliente o null si no hubo recompensa.
function handleDataPut(before, body) {
  let total = 0;
  const titles = [];
  let leveledUp = false, newLevel = null, freezeSaved = false;
  const badges = [];
  const feed = (r) => {
    if (!r || !(r.xp > 0)) return;
    total += r.xp;
    if (r.title) titles.push(r.title);
    if (r.leveledUp) { leveledUp = true; newLevel = r.newLevel; }
    if (r.freezeSaved) freezeSaved = true;
    if (r.newBadges?.length) badges.push(...r.newBadges);
  };
  // 1) ejercicios recién completados en la rutina (+15 c/u)
  if (body.routine && typeof body.routine === 'object') {
    const br = before.routine || {};
    for (const k of Object.keys(body.routine)) {
      if (k.endsWith('_focus')) continue;
      const prevDone = new Set((br[k] || []).filter(e => e.done).map(e => e.name));
      for (const ex of body.routine[k] || []) {
        if (ex.done && !prevDone.has(ex.name)) {
          prevDone.add(ex.name);
          feed(grantXp('routine', { xp: GAME.routine, title: ex.name }));
        }
      }
    }
  }
  // 2) pasos de proyecto recién completados (+15 c/u)
  if (body.projects && Array.isArray(body.projects)) {
    const prevDone = new Set();
    for (const p of before.projects || []) (p.steps || []).forEach((s, i) => { if (s.done) prevDone.add(p.id + ':' + (s.text || i)); });
    for (const p of body.projects) {
      (p.steps || []).forEach((s, i) => {
        const key = p.id + ':' + (s.text || i);
        if (s.done && !prevDone.has(key)) {
          prevDone.add(key);
          feed(grantXp('projects', { xp: GAME.projects, title: s.text || p.title }));
        }
      });
    }
  }
  // 3) comidas (+5 por guardar el día, máx 1/hora) y agua (+1 por vaso, máx 8/día)
  if (body.meals && typeof body.meals === 'object') {
    const bm = before.meals || {};
    for (const [day, m] of Object.entries(body.meals)) {
      if (!m || typeof m !== 'object') continue;
      const prev = bm[day] || {};
      const wNow = Math.min(8, +m.water || 0), wPrev = Math.min(8, +prev.water || 0);
      const earnedKey = 'w:' + day;
      const already = EARNED_WATER.get(earnedKey) || 0;
      const gain = Math.max(0, Math.min(wNow - wPrev, 8 - already));
      if (gain > 0) {
        EARNED_WATER.set(earnedKey, already + gain);
        feed(grantXp('water', { xp: gain * GAME.water, title: `${gain} vaso${gain > 1 ? 's' : ''} de agua` }));
      }
      const hasFood = ['breakfast', 'lunch', 'dinner', 'snacks', 'supper', 'extra'].some(f => String(m[f] || '').trim());
      const now = Date.now();
      if (hasFood && now - (data.hero?.lastMealXpAt || 0) > 3600_000) {
        data.hero.lastMealXpAt = now;
        feed(grantXp('meals', { xp: GAME.meals, title: 'Comidas del día' }));
      }
    }
  }
  // 4) sesiones pomodoro recién registradas en aprendizaje (+10 c/u)
  if (body.learning && Array.isArray(body.learning)) {
    const prev = new Map((before.learning || []).map(l => [l.id, (l.sessions || []).length]));
    for (const l of body.learning) {
      const gain = (l.sessions || []).length - (prev.get(l.id) || 0);
      if (gain > 0) feed(grantXp('learning', { xp: gain * 10, title: `${gain} sesión pomodoro · ${l.title || ''}` }));
    }
  }
  if (!total) return null;
  return { xp: total, titles, leveledUp, newLevel, newBadges: badges, freezeSaved };
}

// ===== Agente externo (Jarvis) =====
// Token propio del agente: no reemplaza al PIN ni se sirve por API.
// Alcance: /api/agent/* completo + lecturas GET puntuales. Las escrituras pasan
// solo por comandos, así quedan auditadas y con idempotencia.
const AGENT_TOKEN_FILE = path.join(DATA_DIR, 'agent-token');
const AGENT_LOG_FILE = path.join(DATA_DIR, 'agent.log');
function ensureAgentToken() {
  const env = String(process.env.POUT_AGENT_TOKEN || '').trim();
  if (env) return env;
  try {
    const saved = fs.readFileSync(AGENT_TOKEN_FILE, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(saved)) return saved;
  } catch (_) { /* todavía no existe */ }
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(AGENT_TOKEN_FILE, token + '\n', { mode: 0o600 });
  } catch (e) {
    console.error('No se pudo guardar el token de agente:', e.message);
  }
  return token;
}
const AGENT_TOKEN = ensureAgentToken();

// Revisión global del estado + clientes SSE (la usan el HUD y el cliente web).
let STATE_REV = 0;
const SSE_CLIENTS = new Set();
function broadcast(event, payload = {}, opts = {}) {
  // quiet: telemetría (voz) que no representa un cambio de datos, así no mueve la
  // revisión ni provoca recargas en los clientes.
  if (!opts.quiet) STATE_REV++;
  if (!SSE_CLIENTS.size) return;
  const chunk = `event: ${event}\ndata: ${JSON.stringify({ ...payload, rev: STATE_REV })}\n\n`;
  for (const client of SSE_CLIENTS) {
    try { client.write(chunk); } catch (_) { SSE_CLIENTS.delete(client); }
  }
}

function agentTokenFrom(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+([A-Za-z0-9_-]{8,128})$/);
  return m ? m[1] : null;
}
function tokenMatches(token) {
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(AGENT_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Lecturas permitidas con token de agente (nunca escrituras fuera de /api/agent).
const AGENT_READ_PATHS = new Set(['/api/data', '/api/rewards', '/api/lan', '/api/ai/usage', '/api/state/rev']);
function agentScopeOk(req, pathname) {
  if (pathname.startsWith('/api/agent/')) return true;
  if (req.method !== 'GET') return false;
  if (AGENT_READ_PATHS.has(pathname) || pathname.startsWith('/api/news')) return true;
  const m = pathname.match(/^\/api\/([a-z]+)$/);
  return !!m && (m[1] in COLLECTIONS || MUTABLE_TOP.has(m[1]));
}
// Anti fuerza bruta del token: 5 fallos/min. Rate limit de comandos: 60/min.
const AGENT_FAILS = [];
function agentTokenBlocked() {
  const now = Date.now();
  while (AGENT_FAILS.length && now - AGENT_FAILS[0] > 60_000) AGENT_FAILS.shift();
  return AGENT_FAILS.length >= 5;
}
function agentTokenFailed() {
  AGENT_FAILS.push(Date.now());
  if (AGENT_FAILS.length > 50) AGENT_FAILS.shift();
}
const AGENT_CMD_TIMES = [];
function agentRateBlocked() {
  const now = Date.now();
  while (AGENT_CMD_TIMES.length && now - AGENT_CMD_TIMES[0] > 60_000) AGENT_CMD_TIMES.shift();
  return AGENT_CMD_TIMES.length >= 60;
}
function agentAudit(entry) {
  try { fs.appendFileSync(AGENT_LOG_FILE, JSON.stringify(entry) + '\n'); } catch (_) { /* auditoría best-effort */ }
}

// Idempotencia (10 min) y undo (30 s): en memoria, se pierden al reiniciar.
const AGENT_IDEMP = new Map();
const AGENT_UNDO = new Map();
const AGENT_IDEMP_TTL = 10 * 60_000;
const AGENT_UNDO_TTL = 30_000;
const AGENT_NO_UNDO = new Set(['status.today', 'catalog', 'tasks.list', 'habits.list', 'rewards.status', 'coach.advise', 'news.digest', 'nav.open', 'pomodoro.start', 'pomodoro.stop', 'undo']);
function pruneAgentCaches() {
  const now = Date.now();
  for (const [k, v] of AGENT_IDEMP) if (now - v.at > AGENT_IDEMP_TTL) AGENT_IDEMP.delete(k);
  for (const [k, v] of AGENT_UNDO) if (now - v.at > AGENT_UNDO_TTL) AGENT_UNDO.delete(k);
  while (AGENT_IDEMP.size > 500) AGENT_IDEMP.delete(AGENT_IDEMP.keys().next().value);
  while (AGENT_UNDO.size > 20) AGENT_UNDO.delete(AGENT_UNDO.keys().next().value);
}

function rewardsSnapshot() {
  const h = data.hero || { ...DEFAULT_DATA.hero };
  const prog = levelFromXp(h.totalXp || 0);
  let freeze = { available: true };
  try { const f = freezeState(); freeze = { available: !f.used, week: f.week }; } catch (_) { /* datos viejos */ }
  return {
    hero: { name: h.name || 'Aventurero', level: prog.level, xpInLevel: prog.current, xpToNext: prog.need, totalXp: h.totalXp || 0, streak: h.streak || 0, freeze },
    badges: BADGES.map(b => ({ id: b.id, emoji: b.emoji, name: b.name, desc: b.desc, at: h.badges?.[b.id] || null })),
    history: (h.history || []).slice(0, 10),
  };
}

// Contexto compacto para que el agente pida consejo sin duplicar el prompt de la UI.
async function agentAdvise(kind = 'strategy') {
  const t = todayKey();
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const overdue = tasks.filter(x => !x.done && x.due && x.due < t);
  const dueToday = tasks.filter(x => !x.done && x.due === t);
  const openT = tasks.filter(x => !x.done && (!x.due || x.due > t));
  const pendingHabits = (data.habits || []).filter(h => !h.log?.[t]).map(h => h.name);
  const todayItems = [...(data.commitments || []).filter(c => !c.done && c.date && c.date <= t).map(c => c.title),
    ...(data.appointments || []).filter(a => !a.done && a.date && a.date <= t).map(a => a.title)];
  const prompt = [
    `Hoy es ${t}. Nivel ${data.hero?.level || 1}, racha ${data.hero?.streak || 0} días.`,
    `VENCIDAS: ${overdue.slice(0, 8).map(x => x.title).join('; ') || 'ninguna'}.`,
    `VENCEN HOY: ${dueToday.slice(0, 8).map(x => x.title).join('; ') || 'ninguna'}.`,
    `ABIERTAS: ${openT.slice(0, 8).map(x => x.title).join('; ') || 'ninguna'}.`,
    `HÁBITOS PENDIENTES: ${pendingHabits.slice(0, 8).join('; ') || 'ninguno'}.`,
    `COMPROMISOS Y CITAS DE HOY O VENCIDOS: ${todayItems.slice(0, 6).join('; ') || 'ninguno'}.`,
    'Respondé en español, en bullets con *, máximo 8 líneas, directo y accionable, sin saludo ni cierre.',
  ].join('\n');
  const system = kind === 'diet' || kind === 'plan'
    ? 'Sos un asesor de nutrición prudente: orientación general de estilo de vida, sin diagnóstico médico. Respondés en español.'
    : 'Sos un coach anti-procrastinación, claro y directo. Respondés en español.';
  return llmCall([
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ], { kind: `agent-${kind}`, scope: 'agent' });
}

function runAgentCommand(name, args) {
  return agentCommands.run(name, args, {
    data,
    save,
    todayKey,
    uid,
    grantXp,
    rewards: rewardsSnapshot,
    aiAdvise: agentAdvise,
    digest: () => buildDigest(false),
  });
}

// ---- Estado vivo de Jarvis ----
// Heartbeat independiente del uso de voz; el estado vive en memoria y expira.
// No se guarda contenido de mensajes ni credenciales en el registro de acciones.
const AGENT_HEARTBEAT_TTL = Math.max(500, Number(process.env.POUT_AGENT_HEARTBEAT_TTL_MS) || 15_000);
const AGENT_INSTANCES = new Map();
let AGENT_LAST_HEARTBEAT_AT = 0;
let AGENT_LAST_ACTION = { at: 0, action: '', source: '' };
let agentStatusBroadcastAt = 0;
function currentAgentStatus() {
  const now = Date.now();
  for (const [id, instance] of AGENT_INSTANCES) {
    if (now - instance.heartbeatAt > AGENT_HEARTBEAT_TTL) AGENT_INSTANCES.delete(id);
  }
  const active = [...AGENT_INSTANCES.values()];
  const heartbeatAt = active.reduce((latest, item) => Math.max(latest, item.heartbeatAt), 0);
  return {
    running: active.length > 0,
    heartbeatAt,
    lastActionAt: AGENT_LAST_ACTION.at,
    lastAction: AGENT_LAST_ACTION.action,
    lastSource: AGENT_LAST_ACTION.source || active[0]?.source || '',
    instances: active.length,
    heartbeatTtlMs: AGENT_HEARTBEAT_TTL,
  };
}
function updateAgentHeartbeat(body = {}) {
  const now = Date.now();
  const id = typeof body.instanceId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(body.instanceId)
    ? body.instanceId
    : 'legacy-agent';
  const action = typeof body.action === 'string'
    ? body.action.trim().slice(0, 100)
    : '';
  const source = typeof body.source === 'string' ? body.source.trim().slice(0, 40) : '';
  if (action) AGENT_LAST_ACTION = { at: now, action, source };
  if (body.running === false) AGENT_INSTANCES.delete(id);
  else {
    AGENT_LAST_HEARTBEAT_AT = now;
    AGENT_INSTANCES.set(id, { heartbeatAt: now, source });
  }
  if (action || now - agentStatusBroadcastAt >= 5_000 || body.running === false) {
    agentStatusBroadcastAt = now;
    broadcast('agent-status', { origin: 'agent', agent: currentAgentStatus() }, { quiet: true });
  }
  return currentAgentStatus();
}

// ---- Voz: niveles que manda Jarvis mientras escucha o habla ----
// Es telemetría para el HUD, no un comando: no pasa por el rate limit de comandos
// ni mueve la revisión del estado. Se conserva el último estado para que un HUD
// que se abre en medio de la conversación se sincronice al conectar.
const VOICE_STATES = new Set(['idle', 'listening', 'thinking', 'speaking']);
let VOICE = { level: 0, state: 'idle', text: '', at: 0 };
let voiceLastAt = 0;
function currentVoice() {
  if (Date.now() - VOICE.at > 5000) return { level: 0, state: 'idle', text: '', at: VOICE.at };
  return VOICE;
}
async function handleAgentVoice(req, res) {
  if (!tokenMatches(agentTokenFrom(req))) return respond(res, 401, { error: 'Token de agente inválido' });
  let body;
  try { body = await getBody(req); }
  catch (e) { return respond(res, 400, { error: e.message }); }
  const now = Date.now();
  const level = Math.max(0, Math.min(1, Number(body?.level) || 0));
  const state = VOICE_STATES.has(body?.state) ? body.state : 'listening';
  const text = typeof body?.text === 'string' ? body.text.slice(0, 200) : VOICE.text;
  VOICE = { level, state, text, at: now };
  updateAgentHeartbeat({ instanceId: 'legacy-agent', source: 'voice' });
  // Techo de ~40 fps: el HUD no necesita más y el SSE no se satura.
  if (now - voiceLastAt < 25) return respond(res, 200, { ok: true, throttled: true });
  voiceLastAt = now;
  broadcast('voice', { origin: 'agent', level, state, text }, { quiet: true });
  return respond(res, 200, { ok: true });
}

// POST /api/agent/command — punto único de escritura para Jarvis.
async function handleAgentCommand(req, res) {
  if (!tokenMatches(agentTokenFrom(req))) return respond(res, 401, { error: 'Token de agente inválido' });
  if (agentRateBlocked()) return respond(res, 429, { error: 'Demasiados comandos por minuto' });
  let body;
  try { body = await getBody(req); }
  catch (e) { return respond(res, 400, { error: e.message }); }
  const command = String(body?.command || '').trim();
  const args = body && body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
  if (!command) return respond(res, 400, { error: 'Falta command', commands: agentCommands.COMMANDS.map(c => c.name) });
  const requestId = typeof body?.requestId === 'string' ? body.requestId.slice(0, 128) : '';
  const source = typeof body?.source === 'string' ? body.source.slice(0, 20) : 'api';
  updateAgentHeartbeat({ action: `Comando: ${command}`, instanceId: 'legacy-agent', source });
  const started = Date.now();
  AGENT_CMD_TIMES.push(started);
  pruneAgentCaches();

  const hash = crypto.createHash('sha1').update(JSON.stringify({ command, args })).digest('hex');
  if (requestId) {
    const prev = AGENT_IDEMP.get(requestId);
    if (prev) {
      if (prev.hash !== hash) return respond(res, 409, { error: 'requestId reutilizado con otro contenido' });
      return respond(res, 200, { ...prev.response, deduped: true });
    }
  }

  if (command === 'undo') {
    const token = String(args.undoToken || '');
    const entry = AGENT_UNDO.get(token);
    if (!entry) return respond(res, 410, { error: 'No hay nada que deshacer (o expiró)' });
    if (Date.now() - entry.at > AGENT_UNDO_TTL) {
      AGENT_UNDO.delete(token);
      return respond(res, 410, { error: 'La ventana para deshacer expiró' });
    }
    data = JSON.parse(entry.snapshot);
    AGENT_UNDO.delete(token);
    save();
    broadcast('state', { origin: 'agent' });
    const response = { ok: true, command: 'undo', data: { undid: entry.command }, game: null, say: 'Deshecho.', ui: null };
    if (requestId) AGENT_IDEMP.set(requestId, { hash, response, at: Date.now() });
    agentAudit({ ts: new Date().toISOString(), command, ok: true, ms: Date.now() - started, source });
    return respond(res, 200, { ...response, rev: STATE_REV });
  }

  const snapshot = AGENT_NO_UNDO.has(command) ? null : JSON.stringify(data);
  let result;
  try {
    result = await runAgentCommand(command, args);
  } catch (e) {
    const status = e.status || 400;
    agentAudit({ ts: new Date().toISOString(), command, ok: false, ms: Date.now() - started, source, status, error: e.message });
    return respond(res, status, { error: e.message || 'Error del comando', ...(e.extra || {}) });
  }

  let undoToken = null;
  if (snapshot) {
    undoToken = crypto.randomBytes(9).toString('hex');
    AGENT_UNDO.set(undoToken, { snapshot, at: Date.now(), command });
  }
  const response = {
    ok: true,
    command,
    data: result.data === undefined ? null : result.data,
    game: result.game || null,
    say: result.say || '',
    ui: result.ui || null,
  };
  if (undoToken) response.undoToken = undoToken;
  if (requestId) AGENT_IDEMP.set(requestId, { hash, response, at: Date.now() });

  if (snapshot) {
    // `say` viaja en el evento: el HUD muestra exactamente lo que el agente respondió.
    broadcast('state', { origin: 'agent', tab: result.ui?.tab || null, highlight: result.ui?.highlight || null, command, say: result.say || '' });
  }
  if (result.game && (result.game.xp > 0 || result.game.leveledUp || result.game.newBadges?.length)) {
    broadcast('reward', { origin: 'agent', game: result.game });
  }
  if (result.event) broadcast(result.event.name, { origin: 'agent', ...result.event.data });
  agentAudit({ ts: new Date().toISOString(), command, ok: true, ms: Date.now() - started, source, rev: STATE_REV });
  return respond(res, 200, { ...response, rev: STATE_REV });
}

// ===== IA =====
// Llama a OpenLLM (pasarela OpenAI-compatible con clave sk-llm-). Sin clave configurada, sugiere pasos al usuario.
const LLM_MODEL = process.env.LLM_MODEL || 'plus';

// Parsea y aplica un plan semanal {weeklyPlan} a data.routine. Devuelve {applied:true} o null
function applyWeeklyPlan(parsed) {
  if (!parsed?.weeklyPlan?.length) return null;
  const routine = {};
  for (const d of parsed.weeklyPlan) {
    const i = Math.max(0, Math.min(6, (+d.day || 1) - 1));
    if (d.rest) { routine[i] = []; continue; }
    routine[i] = (d.exercises || []).slice(0, 8).map(x => ({ name: String(x).slice(0, 80), done: false, doneAt: null }));
    if (d.focus) routine[i + '_focus'] = String(d.focus).slice(0, 20);
  }
  data.routine = routine;
  save();
  // La rutina se aplica desde el endpoint de IA (no pasar por PUT ni comando):
  // si no emitimos, la pestaña Salud no muestra la semana hasta recargar.
  broadcast('state', { origin: 'ui', tab: 'health' });
  return { applied: true };
}
// Resumen de la semana actual de entrenamiento: completados vs pendientes por día
function weekSummary() {
  const r = data.routine || {};
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const items = r[i] || [];
    if (!items.length) { parts.push(`Día ${i + 1}: descanso/vacío`); continue; }
    const done = items.filter(e => e.done);
    const pend = items.filter(e => !e.done);
    parts.push(`Día ${i + 1} (${r[i + '_focus'] || 'general'}): ${done.length}/${items.length} completados${done.length ? ` [${done.map(e => e.name).join('; ')}]` : ''}${pend.length ? ` PENDIENTES: [${pend.map(e => e.name).join('; ')}]` : ''}`);
  }
  return parts.join('\n') || 'sin rutina todavía';
}
// Endpoint configurable: permite probar contra un upstream falso sin salir a internet.
const OPENLLM_BASE = (process.env.OPENLLM_BASE_URL || 'https://www.openllm.sh').replace(/\/+$/, '');
const AI_LIMITS = limitsFromEnv();
const AI_CACHE = new TtlCache({ ttlMs: AI_LIMITS.cacheTtlMs, max: AI_LIMITS.cacheMax });
// kind: qué pidió el usuario (para el registro). scope: id de sesión, así la caché nunca cruza sesiones.
async function llmCall(messages, { kind = 'otro', scope = '' } = {}) {
  const key = process.env.OPENLLM_API_KEY;
  if (!key) throw new Error('OPENLLM_API_KEY no configurada: crea la clave en openllm.sh y ponla en el archivo .env junto a server.js como OPENLLM_API_KEY=sk-llm-...');
  const day = todayKey();
  const ck = cacheKey(scope, LLM_MODEL, messages);
  const cached = AI_CACHE.get(ck);
  if (cached !== undefined) {
    data.aiUsage = recordCall(data.aiUsage, day, { kind, model: LLM_MODEL, cached: true });
    save();
    return cached;
  }
  const blocked = quotaError(getUsage(data.aiUsage, day), AI_LIMITS);
  if (blocked) throw new Error(blocked);
  data.aiUsage = reserveRequest(data.aiUsage, day); // se reserva antes del await
  save();
  const callLog = { kind, model: LLM_MODEL, ok: false };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 150000);
  try {
    const r = await fetch(`${OPENLLM_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LLM_MODEL, messages, max_tokens: 8000, temperature: 0.6 }),
      signal: controller.signal,
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`OpenLLM (${r.status}): ${txt.slice(0, 300)}`);
    }
    const j = await r.json();
    const msg = j?.choices?.[0]?.message;
    let content = msg?.content && msg.content.trim() ? msg.content : (msg?.reasoning_content || '');
    if (!content) throw new Error('Respuesta vacía de la IA');
    // Recupera JSON truncado (finish:length): cierra brackets/braces abiertos
    const first = content.indexOf('{');
    if (first > 0) content = content.slice(first);
    if (j?.choices?.[0]?.finish_reason === 'length' && first !== -1) {
      let depth = 0, inStr = false, esc = false, lastGood = -1;
      for (let i = 0; i < content.length; i++) {
        const c = content[i];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') inStr = !inStr;
        if (inStr) continue;
        if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') { depth--; if (depth === 0) lastGood = i; }
      }
      if (lastGood !== -1) content = content.slice(0, lastGood + 1);
    }
    Object.assign(callLog, { ok: true, ...tokenCounts(j.usage, messages, content) });
    AI_CACHE.set(ck, content);
    return content;
  } finally {
    clearTimeout(t);
    data.aiUsage = recordCall(data.aiUsage, day, callLog);
    save();
  }
}
async function aiChat(res, messages, opts) {
  try {
    const reply = await llmCall(messages, opts);
    respond(res, 200, { reply });
  } catch (e) {
    console.error('IA:', e.message);
    respond(res, 200, { error: e.message });
  }
}

// ===== Centro de noticias (fuentes gratuitas, sin API key) =====
// Solo fuentes en español: Google Noticias + Bing Noticias (RSS por tema) + Wikipedia ES.
// Además, RSS personalizados vía /api/news/feed (en el idioma que publique el medio elegido).
const NEWS_CACHE = new Map(); // key -> { at, data }
function newsCacheGet(key, ttlMs) {
  const e = NEWS_CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.at > ttlMs) { NEWS_CACHE.delete(key); return null; }
  return e.data;
}
async function fetchTimeout(url, ms = 9000, opts = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: c.signal, headers: { 'User-Agent': 'procrastin-out/1.0 (local)', ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  } finally { clearTimeout(t); }
}
// Filtro de idioma: Bing a veces cuela titulares en inglés aunque la consulta sea en español.
// Si el título tiene acentos/eñe/ signos de apertura se considera español; si no, se descarta
// cuando trae palabras funcionales inglesas (the, and, what, is...).
const EN_STOP = /\b(the|and|of|with|for|how|what|why|your|is|are|was|were|from|this|that|best|guide|tips|new|about|when|where|which|you|should|into)\b/i;
function looksEnglish(title) {
  const t = String(title || '');
  if (!t) return true;
  if (/[áéíóúüñÁÉÍÓÚÑ¿¡]/.test(t)) return false;
  return EN_STOP.test(t);
}
// Clave de deduplicación: título normalizado (sin acentos ni signos) para cruzar Google/Bing
function newsKey(title) {
  return String(title).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').slice(0, 60).trim();
}
// opts.newsOnly: solo prensa (sin Wikipedia) — para el resumen diario, que busca titulares
async function newsForQuery(q, opts = {}) {
  const key = 'q:' + (opts.newsOnly ? 'news:' : '') + q.toLowerCase();
  const hit = newsCacheGet(key, 15 * 60_000); // 15 min: las novedades cambian rápido
  if (hit) return { ...hit, cached: true };
  const enc = encodeURIComponent(q);
  // En el resumen diario se piden solo notas recientes (operador when: de Google Noticias);
  // la búsqueda manual sigue amplia pero se ordena por fecha.
  const fresh = opts.newsOnly ? '%20when%3A14d' : '';
  const out = await Promise.allSettled([
    (async () => parseRssItems( // Google Noticias (edición hispanohablante)
      await (await fetchTimeout(`https://news.google.com/rss/search?q=${enc}${fresh}&hl=es-419&gl=AR&ceid=AR:es`, 10000)).text(),
      { src: 'Google Noticias', max: 12 }))(),
    (async () => parseRssItems( // Bing Noticias en español
      await (await fetchTimeout(`https://www.bing.com/news/search?q=${enc}&format=RSS&setlang=es&setmkt=es-AR`, 10000)).text(),
      { src: 'Bing Noticias', max: 10 }))(),
    ...(opts.newsOnly ? [] : [(async () => { // Wikipedia ES (contexto de fondo en español, para cualquier tema)
      const j = await (await fetchTimeout(`https://es.wikipedia.org/w/api.php?action=query&format=json&list=search&srsearch=${enc}&srlimit=5&srprop=`)).json();
      return ((j.query && j.query.search) || []).map(s => ({
        title: stripTags(s.title), url: `https://es.wikipedia.org/?curid=${s.pageid}`,
        src: 'Wikipedia', outlet: 'Wikipedia ES', date: '',
        snippet: stripTags(s.snippet).slice(0, 220),
      }));
    })()]),
  ]);
  const items = out.flatMap(r => r.status === 'fulfilled' ? r.value : []).filter(x => !looksEnglish(x.title));
  const seen = new Set();
  // Lo más nuevo primero (las fuentes ordenan por relevancia, no por fecha); sin fecha al final
  const dedup = items.filter(x => {
    const k = newsKey(x.title);
    if (!k || seen.has(k)) return false;
    seen.add(k); return true;
  }).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const data = { query: q, updatedAt: new Date().toISOString(), items: dedup };
  // No cachear el fracaso total: si todo falló, se reintenta la próxima vez en vez de servir vacío 30 min
  const anyOk = out.some(r => r.status === 'fulfilled');
  if (dedup.length || anyOk) NEWS_CACHE.set(key, { at: Date.now(), data });
  return { ...data, cached: false };
}

// ===== Resumen diario de noticias =====
// Temas propios (intereses + aprendizajes + proyectos activos), máximo 4 para no abusar de las fuentes.
function digestTopics() {
  const seen = new Set();
  const out = [];
  const push = (t) => {
    const v = String(t || '').trim().replace(/\s+/g, ' ');
    const k = v.toLowerCase();
    if (v.length < 3 || seen.has(k) || out.length >= 4) return;
    seen.add(k); out.push(v.slice(0, 60));
  };
  for (const i of (data.interests || [])) push(i);
  for (const l of (data.learning || [])) push(l.title);
  for (const p of (data.projects || [])) if (p.status !== 'hecho') push(p.title);
  const propias = out.length > 0;
  if (!propias) ['productividad', 'bienestar'].forEach(push); // temas genéricos hasta que definas los tuyos
  return { topics: out, fallback: !propias };
}
// Alterna fuentes al armar el resumen, para que no salga todo de un solo medio/plataforma
function mixSources(items, max) {
  const groups = [];
  const bySrc = new Map();
  for (const it of items) {
    if (!bySrc.has(it.src)) { bySrc.set(it.src, []); groups.push(bySrc.get(it.src)); }
    bySrc.get(it.src).push(it);
  }
  const out = [];
  for (let i = 0; out.length < max && i < 20; i++) {
    for (const g of groups) {
      if (g[i]) out.push(g[i]);
      if (out.length >= max) break;
    }
  }
  return out;
}
async function buildDigest(refresh) {
  const { topics, fallback } = digestTopics();
  const key = 'digest:' + todayKey() + ':' + topics.join('|');
  const hit = newsCacheGet(key, 1 * 3600_000); // se regenera cada hora: "hoy" tiene que ser hoy
  if (hit && !refresh) return { ...hit, cached: true };
  const settled = await Promise.allSettled(topics.map(t => newsForQuery(t, { newsOnly: true })));
  const MAX_AGE_DIAS = 14; // "Titulares de hoy": solo últimas novedades, nada de hace meses
  const frescos = (list) => list.filter(x => {
    if (!x.date) return true;
    const d = new Date(x.date + 'T00:00:00').getTime();
    return !isNaN(d) && (Date.now() - d) / 86400000 <= MAX_AGE_DIAS;
  }).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const groups = topics.map((t, i) => {
    const items = mixSources(frescos(settled[i].status === 'fulfilled' ? settled[i].value.items : []), 4)
      .map(x => ({ title: x.title, url: x.url, src: x.src, outlet: x.outlet, date: x.date }));
    return { topic: t, items };
  }).filter(g => g.items.length);
  const payload = { date: todayKey(), updatedAt: new Date().toISOString(), fallback, topics: groups };
  // No cachear un resumen vacío por un fallo de fuentes (evita 6 h sin titulares)
  if (groups.length) NEWS_CACHE.set(key, { at: Date.now(), data: payload });
  return { ...payload, cached: false };
}

function respond(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}

// ===== Fotos de las comidas (Alimentación) =====
// Una foto por franja (desayuno/almuerzo/...) por día. Viven fuera del documento
// grande del usuario para no inflar cada guardado: en la nube tienen su propia
// fila pout_kv por cuenta+día+franja; en archivo, data/photos/<cuenta>/<día>-<franja>.json
const MEAL_PHOTO_FIELDS = new Set(['breakfast', 'lunch', 'dinner', 'snacks', 'supper', 'extra']);
const MEAL_PHOTO_MAX_CHARS = 400_000; // dataURL: el navegador comprime antes de subir
const MEAL_PHOTO_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
function mealPhotoFile(userId, date, field) {
  return path.join(PHOTO_DIR, SAFE_ID.test(userId || '') ? userId : 'x', `${date}-${SAFE_ID.test(field || '') ? field : 'x'}.json`);
}
async function readMealPhoto(userId, date, field) {
  if (USE_DB) return kvStore ? await kvStore.get(`photo:${userId}:${date}:${field}`) : null;
  try { return JSON.parse(fs.readFileSync(mealPhotoFile(userId, date, field), 'utf8')); } catch { return null; }
}
async function saveMealPhotoFile(userId, date, field, value) {
  if (USE_DB) { if (kvStore) await kvStore.set(`photo:${userId}:${date}:${field}`, value); return; }
  const f = mealPhotoFile(userId, date, field);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(value));
}
async function deleteMealPhoto(userId, date, field) {
  if (USE_DB) { if (kvStore) await kvStore.del(`photo:${userId}:${date}:${field}`); return; }
  try { fs.unlinkSync(mealPhotoFile(userId, date, field)); } catch { /* ya no existía */ }
}
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function getBody(req) {
  let chunks = [];
  let size = 0;
  await new Promise((resolve, reject) => {
    req.on('data', c => {
      size += c.length;
      if (size > 5_000_000) { reject(new Error('Payload demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('JSON inválido'); }
}

// Headers de seguridad en todas las respuestas.
// script-src/style-src llevan 'unsafe-inline' porque la app usa onclick="" y style="" inline y login.html tiene un <script> inline;
// quitarlo exige migrar esos handlers a addEventListener (pendiente).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (publicBase()) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // ---- Auth (PIN local) ----
    const clientIp = clientIpFrom(req, process.env.TRUST_PROXY === '1');
    if (pathname === '/api/auth/status' && req.method === 'GET') {
      return respond(res, 200, { setup: accountsList().length > 0, unlocked: !!getSession(req) });
    }
    if (pathname === '/api/auth/setup' && req.method === 'POST') {
      if (accountsList().length) return respond(res, 400, { error: 'El PIN ya está configurado' });
      const body = await getBody(req);
      let admin;
      try { admin = makeUser({ username: 'admin', pin: body?.pin, role: 'admin', id: 'admin' }); }
      catch (e) { return respond(res, 400, { error: e.message }); }
      saveAuth({ users: [admin] });
      const token = newSession(admin.id);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': SESSION_COOKIE(token) });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const wait = loginBlocked(clientIp);
      if (wait > 0) return respond(res, 429, { error: `Demasiados intentos. Espera ${wait} s` });
      const body = await getBody(req);
      const users = accountsList();
      const user = findByUsername(users, body?.username || 'admin');
      const ok = !!user && checkPin(user, body?.pin);
      if (!ok) await new Promise(r => setTimeout(r, 600)); // demora ante fallos
      if (!ok) { loginFail(clientIp); return respond(res, 401, { error: 'Usuario o PIN incorrectos' }); }
      LOGIN_FAILS.delete(clientIp);
      const token = newSession(user.id);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': SESSION_COOKIE(token) });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const t = getSession(req);
      if (t) SESSIONS.delete(t);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': CLEAR_COOKIE });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (pathname === '/api/auth/change' && req.method === 'POST') {
      if (!getSession(req)) return respond(res, 401, { error: 'No autenticado' });
      const sid = getSession(req);
      const me = accountsList().find(u => u.id === SESSIONS.get(sid)?.userId);
      const body = await getBody(req);
      if (!me || !checkPin(me, body?.current)) return respond(res, 401, { error: 'El PIN actual no coincide' });
      let fresh;
      try { fresh = makeUser({ username: me.username, pin: body?.pin, role: me.role, id: me.id }); }
      catch (e) { return respond(res, 400, { error: e.message }); }
      saveAuth({ users: accountsList().map(u => (u.id === me.id ? fresh : u)) });
      // Cambiar el PIN cierra las sesiones de esa cuenta; la actual se renueva.
      for (const [t, s] of SESSIONS) if (s.userId === me.id) SESSIONS.delete(t);
      const token = newSession(me.id);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': SESSION_COOKIE(token) });
      return res.end(JSON.stringify({ ok: true }));
    }
    // Alta de cuentas: solo el admin. Crea un usuario con su PIN.
    // Invitaciones de un solo uso. El admin genera el token; el amigo lo canjea eligiendo usuario y PIN.
    if (pathname === '/api/invites' && req.method === 'POST') {
      const sid = getSession(req);
      if (!sid) return respond(res, 401, { error: 'No autenticado', login: '/login.html' });
      const me = accountsList().find(u => u.id === SESSIONS.get(sid)?.userId);
      if (!me || me.role !== 'admin') return respond(res, 403, { error: 'Solo el admin puede invitar' });
      const token = crypto.randomBytes(24).toString('hex');
      INVITES.set(token, { createdAt: Date.now(), by: me.id });
      return respond(res, 200, { ok: true, token, path: '/invite.html?t=' + token });
    }
    if (pathname === '/api/invites/redeem' && req.method === 'POST') {
      const body = await getBody(req);
      const inv = INVITES.get(String(body?.token || ''));
      if (!inv || Date.now() - inv.createdAt > INVITE_TTL_MS) return respond(res, 410, { error: 'La invitación no es válida o ya se usó' });
      let user;
      try { user = makeUser({ username: body?.username, pin: body?.pin }); }
      catch (e) { return respond(res, 400, { error: e.message }); }
      const users = accountsList();
      if (findByUsername(users, user.username)) return respond(res, 409, { error: 'Ese usuario ya existe' });
      INVITES.delete(String(body.token)); // un solo uso: se invalida al canjearla
      saveAuth({ users: [...users, user] });
      initUserData(user.id);
      const token = newSession(user.id);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': SESSION_COOKIE(token) });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (pathname === '/api/users' && req.method === 'POST') {
      const sid = getSession(req);
      const me = accountsList().find(u => u.id === SESSIONS.get(sid)?.userId);
      if (!me || me.role !== 'admin') return respond(res, 403, { error: 'Solo el admin puede crear cuentas' });
      const body = await getBody(req);
      const users = accountsList();
      let user;
      try { user = makeUser({ username: body?.username, pin: body?.pin }); }
      catch (e) { return respond(res, 400, { error: e.message }); }
      if (findByUsername(users, user.username)) return respond(res, 409, { error: 'Ese usuario ya existe' });
      saveAuth({ users: [...users, user] });
      initUserData(user.id);
      return respond(res, 200, { ok: true, username: user.username });
    }
    // Puerta: páginas y API exigen sesión válida (login.html siempre público).
    // El token de agente solo abre /api/agent/* y las lecturas declaradas.
    const sid = getSession(req);
    const sessionOk = !!sid;
    if (sessionOk) useUser(SESSIONS.get(sid).userId);
    const bearer = agentTokenFrom(req);
    const tokenOk = tokenMatches(bearer);
    // Jarvis (token de agente) opera solo sobre la cuenta admin, nunca sobre la de otra sesión.
    if (!sessionOk && tokenOk) useUser('admin');
    if (bearer && !tokenOk) agentTokenFailed();
    if (!sessionOk && !(tokenOk && agentScopeOk(req, pathname)) && !PUBLIC_ASSETS.has(pathname)) {
      if (pathname.startsWith('/api/')) {
        if (agentTokenBlocked()) return respond(res, 429, { error: 'Demasiados intentos con token de agente' });
        return respond(res, 401, { error: bearer ? 'Token de agente inválido' : 'No autenticado', login: '/login.html' });
      }
      if (pathname !== '/login.html' && pathname !== '/invite.html') {
        res.writeHead(302, { Location: '/login.html' });
        return res.end();
      }
    }

    // ---- Agente externo (Jarvis) ----
    if (pathname === '/api/state/rev' && req.method === 'GET') {
      return respond(res, 200, { rev: STATE_REV });
    }
    if (pathname === '/api/agent/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ rev: STATE_REV, voice: currentVoice(), agent: currentAgentStatus() })}\n\n`);
      SSE_CLIENTS.add(res);
      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) { /* cliente cerrado */ }
      }, 15_000);
      if (ping.unref) ping.unref();
      req.on('close', () => { clearInterval(ping); SSE_CLIENTS.delete(res); });
      return;
    }
    if (pathname === '/api/agent/command' && req.method === 'POST') {
      return handleAgentCommand(req, res);
    }
    if (pathname === '/api/agent/heartbeat' && req.method === 'GET') {
      return respond(res, 200, currentAgentStatus());
    }
    if (pathname === '/api/agent/heartbeat' && req.method === 'POST') {
      if (!tokenMatches(agentTokenFrom(req))) return respond(res, 401, { error: 'Token de agente inválido' });
      let body;
      try { body = await getBody(req); }
      catch (e) { return respond(res, 400, { error: e.message }); }
      updateAgentHeartbeat(body || {});
      return respond(res, 200, { ok: true, agent: currentAgentStatus() });
    }
    if (pathname === '/api/agent/voice' && req.method === 'GET') {
      return respond(res, 200, currentVoice());
    }
    if (pathname === '/api/agent/voice' && req.method === 'POST') {
      return handleAgentVoice(req, res);
    }

    // ---- API ----
    if (pathname === '/api/lan' && req.method === 'GET') {
      const pub = publicBase();
      if (pub) return respond(res, 200, { port: PORT, ips: [], urls: [pub], cloud: true });
      const ips = lanIps();
      return respond(res, 200, { port: PORT, ips, urls: ips.map(ip => `http://${ip}:${PORT}`) });
    }
    if (pathname === '/api/data' && req.method === 'GET') {
      return respond(res, 200, data);
    }
    if (pathname === '/api/data' && req.method === 'PUT') {
      const body = await getBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(res, 400, { error: 'Datos inválidos' });
      for (const k of Object.keys(body)) if (!PUTABLE_TOP.has(k)) delete body[k];
      const before = { routine: data.routine, meals: data.meals, projects: data.projects, learning: data.learning };
      data = { ...data, ...body };
      USER_DATA.set(activeUserId, data);
      let game = null;
      try { game = handleDataPut(before, body); } catch (e) { console.error('rewards:', e.message); }
      save();
      // El navegador nunca manda el Bearer de agente: si llega, quien escribió
      // fue Jarvis por el canal humano (lo que el catálogo aún no cubre). Avisa
      // con `origin: 'agent'` para que la página abierta haga reload en vivo —
      // con `origin: 'ui'` la página se lo salta por no pisarse a sí misma.
      broadcast('state', { origin: tokenOk ? 'agent' : 'ui' });
      return respond(res, 200, { ok: true, game });
    }
    // Fotos de comidas: sube/ve/borra la foto de una franja del día (solo datos propios).
    if (pathname === '/api/meals/photo') {
      if (req.method === 'POST') {
        const body = await getBody(req);
        const date = body?.date, field = body?.field, image = typeof body?.image === 'string' ? body.image : '';
        if (!VALID_DATE.test(date || '') || !MEAL_PHOTO_FIELDS.has(field)) return respond(res, 400, { error: 'Día o comida inválidos' });
        if (!MEAL_PHOTO_URL.test(image) || image.length > MEAL_PHOTO_MAX_CHARS) return respond(res, 400, { error: 'La foto no es válida o pesa demasiado (máximo ~300 KB)' });
        await saveMealPhotoFile(activeUserId, date, field, { dataUrl: image, at: new Date().toISOString() });
        broadcast('state', { origin: 'ui', tab: 'meals' });
        return respond(res, 200, { ok: true });
      }
      if (req.method === 'GET') {
        const date = url.searchParams.get('date'), field = url.searchParams.get('field');
        if (!VALID_DATE.test(date || '') || !MEAL_PHOTO_FIELDS.has(field || '')) return respond(res, 400, { error: 'Día o comida inválidos' });
        const p = await readMealPhoto(activeUserId, date, field);
        return respond(res, 200, p || { dataUrl: null });
      }
      if (req.method === 'DELETE') {
        const date = url.searchParams.get('date'), field = url.searchParams.get('field');
        if (!VALID_DATE.test(date || '') || !MEAL_PHOTO_FIELDS.has(field || '')) return respond(res, 400, { error: 'Día o comida inválidos' });
        await deleteMealPhoto(activeUserId, date, field);
        return respond(res, 200, { ok: true });
      }
    }
    if (pathname === '/api/rewards' && req.method === 'GET') {
      return respond(res, 200, rewardsSnapshot());
    }
    if (pathname === '/api/news' && req.method === 'GET') {
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);
      if (!q) return respond(res, 400, { error: 'Falta el parámetro q' });
      try {
        return respond(res, 200, await newsForQuery(q));
      } catch (e) {
        console.error('news:', e.message);
        return respond(res, 502, { error: 'No se pudieron obtener noticias: ' + e.message });
      }
    }
    if (pathname === '/api/news/digest' && req.method === 'GET') {
      try {
        return respond(res, 200, await buildDigest(url.searchParams.get('refresh') === '1'));
      } catch (e) {
        console.error('digest:', e.message);
        return respond(res, 502, { error: 'No se pudo armar el resumen diario: ' + e.message });
      }
    }
    if (pathname === '/api/news/feed' && req.method === 'GET') {
      const feedUrl = String(url.searchParams.get('url') || '').trim();
      try { await assertPublicFeedUrl(feedUrl); }
      catch (e) { return respond(res, 400, { error: e.message }); }
      const hit = newsCacheGet('feed:' + feedUrl, 30 * 60_000);
      if (hit) return respond(res, 200, { ...hit, cached: true });
      try {
        const xml = await fetchPublicFeed(feedUrl, { timeoutMs: 10000 });
        let host = 'RSS';
        try { host = new URL(feedUrl).hostname.replace(/^www\./, ''); } catch (_) {}
        const feedItems = parseRssItems(xml.slice(0, 500_000), { src: 'Tus feeds', feedName: host, max: 15 })
          .sort((a, b) => (b.ts || 0) - (a.ts || 0));
        const data = { url: feedUrl, updatedAt: new Date().toISOString(), items: feedItems };
        NEWS_CACHE.set('feed:' + feedUrl, { at: Date.now(), data });
        return respond(res, 200, { ...data, cached: false });
      } catch (e) {
        console.error('feed:', e.message);
        return respond(res, 502, { error: 'No se pudo leer el feed: ' + e.message });
      }
    }
    if (pathname === '/api/export' && req.method === 'GET') {
      return respond(res, 200, data, { 'Content-Disposition': 'attachment; filename="procrastin-out-export.json"' });
    }

    const m = pathname.match(/^\/api\/([a-z]+)\/?([0-9a-zA-Z_-]+)?$/);
    if (m) {
      const [, coll, id] = m;
      if (coll in COLLECTIONS || MUTABLE_TOP.has(coll)) {
        if (req.method === 'GET') {
          if (id) return respond(res, 404, { error: 'No encontrado' });
          if (coll in COLLECTIONS) return respond(res, 200, COLLECTIONS[coll](data));
          return respond(res, 200, data[coll]);
        }
        if (req.method === 'POST') {
          const body = await getBody(req);
          if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(res, 400, { error: 'Datos inválidos' });
          if (MUTABLE_TOP.has(coll)) {
            if (coll === 'finances' && Array.isArray(body.expenses)) {
              body.expenses = body.expenses.map(e => ({ ...e, id: e.id || uid() }));
            }
            data[coll] = { ...data[coll], ...body };
            save();
            broadcast('state', { origin: 'ui' });
            return respond(res, 200, data[coll]);
          }
          const item = sanitizeItem(coll, body);
          (coll in COLLECTIONS ? COLLECTIONS[coll](data) : []).push(item);
          save();
          broadcast('state', { origin: 'ui' });
          return respond(res, 200, item);
        }
        if (req.method === 'PATCH' && id) {
          const list = COLLECTIONS[coll](data) || [];
          const idx = list.findIndex(x => x.id === id);
          if (idx === -1) return respond(res, 404, { error: 'No encontrado' });
          const body = await getBody(req);
          if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(res, 400, { error: 'Datos inválidos' });
          const before = { ...list[idx] };
          list[idx] = { ...list[idx], ...body, id };
          let gameMsg = null;
          try { gameMsg = handleHeroPatch(coll, before, list[idx]); } catch (e) { console.error('hero patch:', e.message); }
          save();
          broadcast('state', { origin: 'ui' });
          return respond(res, 200, { ...list[idx], game: gameMsg });
        }
        if (req.method === 'DELETE' && id) {
          if (MUTABLE_TOP.has(coll)) {
            // ej. DELETE /api/expenses/<id>
            if (coll === 'finances' && data.finances?.expenses) {
              data.finances.expenses = data.finances.expenses.filter(e => e.id !== id);
              save();
              broadcast('state', { origin: 'ui' });
              return respond(res, 200, { ok: true });
            }
          } else {
            const list = COLLECTIONS[coll](data);
            const before = list.length;
            const after = list.filter(x => x.id !== id);
            if (after.length === before) return respond(res, 404, { error: 'No encontrado' });
            data[coll] = after;
            save();
            broadcast('state', { origin: 'ui' });
            return respond(res, 200, { ok: true });
          }
        }
      }
    }

    // ---- IA: recomendaciones (Novita AI, endpoint OpenAI-compatible) ----
    if (pathname === '/api/ai/usage' && req.method === 'GET') {
      const u = getUsage(data.aiUsage, todayKey());
      return respond(res, 200, {
        day: u.day, requests: u.requests, tokens: u.tokens,
        limits: { dailyRequests: AI_LIMITS.dailyRequests, dailyTokens: AI_LIMITS.dailyTokens },
        cacheTtlMin: AI_LIMITS.cacheTtlMs / 60000,
        recent: u.log.slice(-30).reverse(),
      });
    }
    if (pathname === '/api/ai/advise' && req.method === 'POST') {
      const body = await getBody(req);
      const kind = body?.kind || 'coach';
      const aiOpts = { kind, scope: getSession(req) || '' };
      const ai = (messages) => llmCall(messages, aiOpts);
      const p = data.profile || {};
      const latest = (data.measurements || []).slice().sort((a, b) => b.date.localeCompare(a.date))[0];
      const routineSummary = Object.entries(data.routine || {})
        .filter(([k]) => !k.endsWith('_focus'))
        .map(([k, v]) => `Día ${k}: ${(v || []).map(e => e.name).join(', ') || 'descanso'}`).join(' | ') || 'sin rutina todavía';
      const mealsRecent = Object.entries(data.meals || {}).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 3)
        .map(([d, m]) => `${d}: D:${m.breakfast || '-'} A:${m.lunch || '-'} C:${m.dinner || '-'} Mer:${m.snacks || '-'}`) || ['sin registros'];
      const contextLabel = kind === 'diet'
        ? 'Un asesor de nutrición. Da 5-8 recomendaciones concretas y accionables (bullets cortos, líneas que empiecen con *).'
        : kind === 'plan'
          ? 'Un nutricionista. Crea un plan de dieta semanal (7 días, desayuno/almuerzo/cena/merienda por día, líneas con *) integrado con la rutina de ejercicio.'
          : 'Un coach de vida y bienestar. Da recomendaciones para organizar mejor tu semana.';
      if (kind === 'workout') {
        // Rutina semanal de ejercicios adaptada al perfil; salida JSON estructurada
        const profileBmi = p.heightCm && p.weightKg ? Math.round(p.weightKg / Math.pow(p.heightCm / 100, 2) * 10) / 10 : null;
        const pr = [
          'Eres un entrenador personal certificado. Diseñas rutinas semanales prudentes y efectivas.',
          `Perfil: altura ${p.heightCm || '?'} cm, peso ${p.weightKg || '?'} kg${profileBmi ? ` (IMC ${profileBmi})` : ''}, edad ${p.age || '?'}, sexo ${p.sex === 'f' ? 'femenino' : 'masculino'}, peso objetivo ${p.goalWeight || '?'} kg, nivel de actividad ${p.activity || '?'}${p.goalWeight && p.weightKg ? (p.goalWeight < p.weightKg ? ' (quiere bajar de peso)' : ' (quiere subir de peso)') : ''}.`,
          `Último peso registrado: ${latest?.weight || '?'} kg.`,
          `Rutina actual: ${routineSummary}.`,
          'Devuelve EXCLUSIVAMENTE un objeto JSON válido (sin texto antes ni después, sin markdown) con esta forma exacta:',
          '{"weeklyPlan":[{"day":1,"focus":"piernas","exercises":["Sentadillas 4x10","Prensa 3x12"],"rest":false},...]}',
          'day: 1=Lunes ... 7=Domingo. focus: uno de pecho|espalda|piernas|hombros|brazos|cardio|core. exercises: 3-5 strings, cada uno "Ejercicio NxM" (series x repeticiones). Incluye al menos 1 día de cardio/core y 1-2 días de descanso. Adapta la intensidad al perfil: novato si activity 1.2, volumen moderado si 1.375-1.55, alto si 1.725. Los 7 días deben aparecer (rest:true para los de descanso, exercises vacío).'
        ].join('\n');
        const raw = await ai([
          { role: 'system', content: 'Eres un entrenador personal prudente. Respondes SOLO con JSON válido, sin formato markdown ni texto extra.' },
          { role: 'user', content: pr },
        ]);
        let parsed = null, parseErr = null;
        try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()); }
        catch (e) { parseErr = e; }
        const applied = applyWeeklyPlan(parsed);
        if (applied) return respond(res, 200, { ok: true, applied: true, reply: '✅ Rutina aplicada: revisa tu semana en los días de abajo.' });
        return respond(res, 200, { error: 'La IA no devolvió un plan válido' + (parseErr ? ' (JSON ilegible). Intenta de nuevo.' : '. Intenta de nuevo.') });
      }
      if (kind === 'progress') {
        // Ajuste progresivo: revisa la semana completada y sube la intensidad donde se pudo
        const profileBmi = p.heightCm && p.weightKg ? Math.round(p.weightKg / Math.pow(p.heightCm / 100, 2) * 10) / 10 : null;
        const pr = [
          'Eres un entrenador personal certificado. Ajustas la semana siguiente según lo realmente completado (sobreprogresión prudente).',
          `Perfil: altura ${p.heightCm || '?'} cm, peso ${p.weightKg || '?'} kg${profileBmi ? ` (IMC ${profileBmi})` : ''}, edad ${p.age || '?'}, sexo ${p.sex === 'f' ? 'femenino' : 'masculino'}, peso objetivo ${p.goalWeight || '?'} kg, nivel de actividad ${p.activity || '?'}.`,
          `Último peso registrado: ${latest?.weight || '?'} kg.`,
          `Semana actual (con estado completado):\n${weekSummary()}`, '',
          'Reglas de progresión:',
          '- Si un día se completó todo: sube intensidad (más series, más reps o +peso implícito; nunca saltos >10-15%).',
          '- Si un día quedó a medias: mantén la misma carga y reduce un poco el volumen de los ejercicios pendientes.',
          '- Si varios días quedaron pendientes: consideren día extra de descanso o repartir los pendientes; no subas intensidad.',
          '- Mantén los ejercicios que ya conoce el usuario; solo cambia series/reps señalando el cambio en el propio string (ej: "Sentadillas 4x10 → 4x12").',
          'Devuelve EXCLUSIVAMENTE un objeto JSON válido con esta forma exacta:',
          '{"weeklyPlan":[{"day":1,"focus":"piernas","exercises":["Sentadillas 4x12"],"rest":false}],"changeSummary":"breve texto de qué subiste/mantuviste y por qué"}',
          'day: 1=Lunes ... 7=Domingo. focus: pecho|espalda|piernas|hombros|brazos|cardio|core. Los 7 días deben aparecer (rest:true para descanso, exercises vacío). changeSummary: máximo 3 líneas marcadas con *.'
        ].join('\n');
        const raw = await ai([
          { role: 'system', content: 'Eres un entrenador personal prudente. Respondes SOLO con JSON válido, sin markdown ni texto extra.' },
          { role: 'user', content: pr },
        ]);
        let parsed = null, parseErr = null;
        try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()); }
        catch (e) { parseErr = e; }
        const applied = applyWeeklyPlan(parsed);
        if (applied) {
          const changes = String(parsed.changeSummary || '').slice(0, 500).replace(/\n/g, '\n');
          return respond(res, 200, { ok: true, applied: true, reply: '📈 Progresión aplicada:\n' + (changes || 'Semana ajustada según lo completado.') });
        }
        return respond(res, 200, { error: 'La IA no devolvió un plan válido' + (parseErr ? ' (JSON ilegible). Intenta de nuevo.' : '. Intenta de nuevo.') });
      }
      if (kind === 'calories') {
        // Estima calorías y peso de las comidas de un día; guarda el resultado en meals[date].nutri.
        // Usa los pesos registrados por alimento y las fotos de cada franja (visión de la IA).
        const day = typeof body?.date === 'string' && VALID_DATE.test(body.date) ? body.date : todayKey();
        const m = (data.meals || {})[day] || {};
        const slots = [['Desayuno', 'breakfast', m.breakfast], ['Almuerzo', 'lunch', m.lunch], ['Comida', 'dinner', m.dinner], ['Merienda', 'snacks', m.snacks], ['Cena', 'supper', m.supper], ['Snacks', 'extra', m.extra]];
        // Fotos ya cargadas por franja: se usan para el texto del prompt y para la visión.
        const photoStore = {};
        for (const [, field] of slots) {
          const ph = await readMealPhoto(activeUserId, day, field);
          if (ph && ph.dataUrl) photoStore[field] = ph.dataUrl;
        }
        const photoFields = new Set(Object.keys(photoStore));
        const textLines = [];
        for (const [label, field, txt] of slots) {
          const items = Array.isArray(m.items?.[field]) ? m.items[field] : [];
          if (items.length) {
            const wantPhoto = items.some(i => !(Number(i.g) > 0));
            textLines.push(`${label}: ` + items.map(i => {
              const nombre = String(i.n || '').trim() || 'alimento';
              const g = Number(i.g) > 0
                ? `${Math.round(Number(i.g))} g`
                : 'peso sin registrar';
              const falta = wantPhoto && !(i.g > 0) && photoFields.has(field)
                ? ' (deducir peso de la foto)'
                : '';
              return `${nombre} ${g}${falta}`;
            }).join(' + '));
          } else if (String(txt || '').trim()) {
            textLines.push(`${label}: ${String(txt).trim()}`);
          } else if (photoFields.has(field)) {
            textLines.push(`${label}: (solo foto)`);
          }
        }
        const content = [{ type: 'text', text: [
          'Estima las calorías de estas comidas de un día (perfil: ' + (p.weightKg || '?') + ' kg, objetivo ' + (p.goalWeight || '?') + ' kg).',
          textLines.length ? textLines.join('\n') : 'Sin registros de texto.',
          'Reglas: si un alimento trae peso en gramos, usalo tal cual. Pesos sin registrar y franjas (solo foto): estimá la porción mirando la foto correspondiente.',
          'Devuelve EXCLUSIVAMENTE JSON con esta forma: {"items":[{"plato":"nombre","gramos":250,"kcal":400}],"totalKcal":1200,"tip":"consejo de 1 línea"}.',
          'gramos: peso de la porción (registrado o estimado). kcal: número entero. Sé realista con porciones caseras.',
        ].join('\n') }];
        let photos = 0;
        for (const [label, field] of slots) {
          if (!photoStore[field]) continue;
          photos++;
          content.push({ type: 'text', text: `Foto de ${label.toLowerCase()}:` }, { type: 'image_url', image_url: { url: photoStore[field] } });
        }
        const raw = await ai([
          { role: 'system', content: 'Eres un calculador de comidas. Respondes SOLO con JSON válido, sin markdown ni texto extra.' },
          { role: 'user', content },
        ]);
        let parsed = null;
        try { parsed = JSON.parse(String(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()); } catch (_) {}
        if (!parsed || !Array.isArray(parsed.items) || !(parsed.totalKcal >= 0)) {
          return respond(res, 200, { error: 'La IA no devolvió una estimación válida. Intenta de nuevo.' });
        }
        data.meals = data.meals || {};
        data.meals[day] = { ...(data.meals[day] || {}), nutri: { items: parsed.items.slice(0, 12), totalKcal: Math.round(parsed.totalKcal), tip: String(parsed.tip || '').slice(0, 200), at: new Date().toISOString() } };
        save();
        // El nutri llega por otro camino (no PUT ni comando): si no emitimos,
        // la tarjeta de calorías no aparece hasta recargar la app.
        broadcast('state', { origin: 'ui', tab: 'meals' });
        return respond(res, 200, { ok: true, applied: true, reply: `⚡ Estimación guardada: ≈${Math.round(parsed.totalKcal)} kcal.` + (photos ? ` (${photos} foto${photos > 1 ? 's' : ''} analizad${photos > 1 ? 'as' : ''})` : '') });
      }
      if (kind === 'newsbrief') {
        // Resumen en español de titulares del centro de noticias, conectado con lo que el usuario estudia/construye
        const items = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
        if (!items.length) return respond(res, 200, { error: 'Sin titulares para resumir' });
        const focus = [
          ...((data.learning || []).map(l => l.title)),
          ...((data.projects || []).filter(p => p.status !== 'hecho').map(p => p.title)),
          ...((data.interests || [])),
        ].filter(Boolean).slice(0, 10).join('; ') || 'sin temas todavía';
        const brief = [
          'Eres un curador de noticias, claro y directo. Respondes en español.',
          `El usuario está metido en: ${focus}.`,
          'Titulares encontrados:',
          ...items.slice(0, 20).map((x, i) => `${i + 1}. [${x.source || '?'}] ${String(x.title || '').slice(0, 200)}`),
          'Responde con este formato exacto, bullets con *, corto:',
          '**LO IMPORTANTE** (máx 4 bullets: qué pasó y por qué le sirve a alguien metido en sus temas)',
          '**PARA PROFUNDIZAR** (máx 2 bullets: qué titular vale abrir primero y por qué, 1 línea cada uno)'
        ].join('\n');
        await aiChat(res, [
          { role: 'system', content: 'Eres un curador de noticias tech y cultura, claro y directo. Sin saludo ni cierre largo.' },
          { role: 'user', content: brief },
        ], aiOpts);
        return;
      }
      if (kind === 'strategy') {
        // Briefing estratégico: qué hacer hoy y qué postergar, con todo el contexto
        const t = todayKey();
        const overdueT = (data.tasks || []).filter(x => !x.done && x.due && x.due < t);
        const dueTodayT = (data.tasks || []).filter(x => !x.done && x.due === t);
        const openT = (data.tasks || []).filter(x => !x.done && (!x.due || x.due > t));
        const wk = currentWeekKeys();
        const weakHabits = (data.habits || []).map(h => ({ h, n: wk.filter(dk => dk <= t && h.log?.[dk]).length }))
          .filter(({ h, n }) => n < (h.targetPerWeek || 3)).map(({ h, n }) => `${h.emoji || ''}${h.name} (${n}/${h.targetPerWeek})`);
        const overdueC = (data.commitments || []).filter(c => !c.done && c.date && c.date < t);
        const soonC = (data.commitments || []).filter(c => !c.done && c.date && c.date >= t && c.date <= shiftDays(t, 7));
        const month = t.slice(0, 7);
        const mExp = (data.finances?.expenses || []).filter(e => e.date.startsWith(month));
        const byCat = {};
        for (const e of mExp) byCat[e.category] = (byCat[e.category] || 0) + e.amount;
        const topCat = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
        const strat = [
          'Eres un coach estratégico anti-procrastinación: directo, priorizas por impacto y das permiso para postergar lo trivial.',
          `Hoy es ${t}. Nivel ${data.hero?.level || 1}, racha ${data.hero?.streak || 0} días, peso objetivo ${p.goalWeight || '?'} kg.`,
          `VENCIDAS (${overdueT.length}): ${overdueT.slice(0, 8).map(x => x.title).join('; ') || 'ninguna'}.`,
          `VENCEN HOY (${dueTodayT.length}): ${dueTodayT.slice(0, 8).map(x => x.title).join('; ') || 'ninguna'}.`,
          `ABIERTAS SIN FECHA/PRÓXIMAS (${openT.length}): ${openT.slice(0, 8).map(x => x.title).join('; ') || 'ninguna'}.`,
          `HÁBITOS FLOJOS ESTA SEMANA: ${weakHabits.slice(0, 6).join('; ') || 'ninguno, todo en racha'}.`,
          `COMPROMISOS VENCIDOS: ${overdueC.slice(0, 5).map(c => c.title).join('; ') || 'ninguno'} | PRÓXIMOS 7 DÍAS: ${soonC.slice(0, 5).map(c => c.title).join('; ') || 'ninguno'}.`,
          `GASTO DEL MES: ${topCat ? `categoría top ${topCat[0]} $${topCat[1]}` : 'sin gastos'} (presupuesto $${data.finances?.monthlyBudget || 0}).`,
          'Responde en español con este formato exacto, bullets con *, corto y accionable:',
          '**HOY** (máx 3 prioridades numeradas con *)',
          '**POSTERGA SIN CULPA** (máx 2 con *)',
          '**FOCO DE LA SEMANA** (1 línea con *)'
        ].join('\n');
        await aiChat(res, [
          { role: 'system', content: 'Eres un coach estratégico anti-procrastinación, claro y directo. Sin saludo ni cierre largo.' },
          { role: 'user', content: strat },
        ], aiOpts);
        return;
      }
      const prompt = [
        contextLabel,
        `Perfil: altura ${p.heightCm || '?'} cm, peso ${p.weightKg || '?'} kg, edad ${p.age || '?'}, sexo ${p.sex === 'f' ? 'femenino' : 'masculino'}, peso objetivo ${p.goalWeight || '?'} kg, actividad nivel ${p.activity || '?'}.`,
        `Último peso registrado: ${latest?.weight || '?'} kg.`,
        `Rutina de ejercicio: ${routineSummary}.`,
        `Comidas recientes: ${mealsRecent.join(' || ')}.`,
        `Responde SIEMPRE en español, sin saludo inicial ni cierre largo. Usa bullets marcados con *. Concéntrate en qué cambiar para llegar al peso objetivo sin perder músculo, integrando el ejercicio.`
      ].join('\n');
      await aiChat(res, [
        { role: 'system', content: 'Eres un asesor de salud y nutrición prudente, claro y directo. Nunca das diagnóstico médico, solo orientación general de estilo de vida.' },
        { role: 'user', content: prompt },
      ], aiOpts);
      return;
    }

    // ---- Estáticos ----
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const abs = path.join(PUBLIC_DIR, filePath);
    if (!abs.startsWith(PUBLIC_DIR)) return respond(res, 404, { error: 'Ruta no permitida' });

    // HTML se sirve con los scripts INCORPORADOS: nada de caché puede servir JS viejo
    if (filePath.endsWith('index.html')) {
      fs.readFile(abs, 'utf8', (err, html) => {
        if (err) return respond(res, 404, { error: 'No encontrado' });
        const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
        html = html.replace('<!--APP_JS-->', () => `<script>\n${appJs}\n</script>`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      });
      return;
    }

    fs.readFile(abs, (err, content) => {
      if (err) return respond(res, 404, { error: 'No encontrado' });
      const ext = path.extname(abs).toLowerCase();
      const noCache = ['.html', '.js', '.css'].includes(ext);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        ...(noCache ? { 'Cache-Control': 'no-store' } : {}),
      });
      res.end(content);
    });
  } catch (e) {
    console.error(e);
    respond(res, 400, { error: e.message || 'Error del servidor' });
  }
});

const HOST = process.env.HOST || '0.0.0.0';
async function boot() {
  if (!USE_DB) {
    // Modo archivo: la cuenta admin toma los datos actuales (vida.json) si aún no tiene los suyos.
    migrateLegacyData(DATA_DIR, 'admin');
    useUser('admin');
  }
  if (USE_DB) {
    // En la nube NO se arranca sin la base: si Postgres falla, un guardado vacío pisaría datos reales.
    kvStore = kvStore || pgKv(db()); // misma tabla pout_kv, acceso en lib/kv.js
    await kvStore.init();
    const [d, a] = await Promise.all([kvStore.get(dbKeyFor('admin')), kvStore.get('auth')]);
    if (a && typeof a === 'object') authCache = a; // antes de leer cuentas
    // Cuenta admin: su fila nueva; si no existe, la fila antigua `data` (un solo bloque).
    const adminData = d || await kvStore.get('data');
    USER_DATA.set('admin', adminData && typeof adminData === 'object' ? withDefaults(adminData) : freshDefaults());
    // Todas las cuentas se cargan desde Postgres antes de atender peticiones.
    for (const u of accountsList()) {
      if (u.id === 'admin') continue;
      const ud = await kvStore.get(dbKeyFor(u.id));
      USER_DATA.set(u.id, ud && typeof ud === 'object' ? withDefaults(ud) : freshDefaults());
    }
    useUser('admin');
    console.log('☁️ Datos en Postgres (modo nube)');
  }
  server.listen(PORT, HOST, () => {
    const pub = publicBase();
    console.log(`🥊 procrastin-out: http://localhost:${PORT}`);
    if (pub) console.log(`   🌐 URL pública: ${pub}`);
    else for (const ip of lanIps()) console.log(`   📱 Celular (misma WiFi): http://${ip}:${PORT}`);
    console.log(USE_DB ? '   Datos: Postgres (pout_kv)' : `   Datos: ${DATA_FILE}`);
  });
}
boot();
