/* HUD de procrastin-out — overlay de escritorio (Electron) que refleja la app.
   Datos: GET /api/data + GET /api/rewards (misma sesión que la ventana principal).
   En vivo: SSE /api/agent/events — muestra lo que hace Jarvis y se refresca sola.
   Fuera de Electron también funciona en el navegador (/hud.html): los botones de
   ventana se ocultan, porque el puente `window.poutHud` solo existe en Electron. */

const $ = (sel) => document.querySelector(sel);
const bridge = window.poutHud || null;
if (bridge) document.body.dataset.electron = '1';

const R_XP = 56;
const R_DAY = 42;
const C_XP = 2 * Math.PI * R_XP;
const C_DAY = 2 * Math.PI * R_DAY;

const xpRing = $('#xpRing');
const dayRing = $('#dayRing');
xpRing.style.strokeDasharray = `${C_XP} ${C_XP}`;
xpRing.style.strokeDashoffset = String(C_XP);
dayRing.style.strokeDasharray = `${C_DAY} ${C_DAY}`;
dayRing.style.strokeDashoffset = String(C_DAY);

let pomo = null;      // { endsAt, minutes, label }
let pomoTimer = null;
let lastSay = '';

// ---------- Utilidades ----------
const clamp01 = (n) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
const todayKey = () => new Date().toISOString().slice(0, 10); // misma regla que la app (UTC)

function setRing(el, circumference, pct) {
  el.style.strokeDashoffset = String(circumference * (1 - clamp01(pct)));
}

function setSay(text) {
  lastSay = text;
  $('#hudSay').textContent = text;
}

function setState(state) {
  if (state === 'waiting') document.body.dataset.state = 'waiting';
  else delete document.body.dataset.state;
}

function pulse() {
  document.body.dataset.pulse = '1';
  setTimeout(() => { delete document.body.dataset.pulse; }, 1700);
}

// ---------- Cálculo del día (misma idea que el badge de la app) ----------
function weekDays() {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7; // 0 = lunes
  d.setDate(d.getDate() - dow);
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(d);
    x.setDate(x.getDate() + i);
    return x.toISOString().slice(0, 10);
  });
}

function moodFor(pct) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const hue = 5 + (p / 100) * 135;                       // 5° rojo → 140° verde
  const col = `hsl(${hue.toFixed(1)}, 78%, 45%)`;
  const col2 = `hsl(${((hue + 22) % 360).toFixed(1)}, 88%, 55%)`;
  const name = p >= 70 ? 'verde' : p >= 45 ? 'amarillo' : p >= 20 ? 'naranja' : 'rojo';
  return { p, col, col2, name };
}

function model(data, rewards) {
  const today = todayKey();
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const habits = Array.isArray(data.habits) ? data.habits : [];
  const commits = Array.isArray(data.commitments) ? data.commitments : [];

  const pendingToday = tasks.filter(t => !t.done && t.due && t.due <= today).length;
  const overdue = tasks.filter(t => !t.done && t.due && t.due < today).length;
  const habitsPending = habits.filter(h => !h.log?.[today]).length;

  // Progreso general: tareas, hábitos de la semana y compromisos (igual que la app).
  const week = weekDays();
  let habitDone = 0, habitTotal = 0;
  for (const h of habits) {
    for (const dk of week) {
      if (dk > today) continue;
      habitTotal++;
      if (h.log?.[dk]) habitDone++;
    }
  }
  const parts = [
    tasks.length ? tasks.filter(t => t.done).length / tasks.length : 0,
    habitTotal ? habitDone / habitTotal : 0,
    commits.length ? commits.filter(c => c.done).length / commits.length : 0,
  ];
  const pct = tasks.length || habitTotal || commits.length
    ? Math.round(parts.reduce((a, b) => a + b, 0) / 3 * 100)
    : 0;

  const hero = rewards?.hero || {};
  const need = hero.xpToNext || 100;
  const have = hero.xpInLevel || 0;
  return {
    pct,
    pendingToday,
    overdue,
    habitsPending,
    streak: hero.streak || 0,
    level: hero.level || 1,
    xpText: `${have}/${need} XP`,
    xpRatio: need ? have / need : 0,
    status: `${hero.streak ? `Racha ${hero.streak} · ` : ''}${pct}% del día`,
    mood: moodFor(pct),
  };
}

function render(data, rewards) {
  const m = model(data, rewards);
  $('#hudLevel').textContent = `Nv ${m.level}`;
  $('#hudXp').textContent = m.xpText;
  $('#hudMood').textContent = m.mood.name;
  $('#hudToday').textContent = m.pendingToday;
  $('#hudOverdue').textContent = m.overdue;
  $('#hudHabits').textContent = m.habitsPending;
  $('#hudStreak').textContent = m.streak;

  document.documentElement.style.setProperty('--mood', m.mood.col);
  document.documentElement.style.setProperty('--mood-2', m.mood.col2);
  setRing(xpRing, C_XP, m.xpRatio);
  setRing(dayRing, C_DAY, m.pct / 100);

  // Sin novedades del agente, el HUD igual dice cómo viene el día.
  if (!lastSay) {
    setSay(m.pendingToday ? `${m.pendingToday} pendiente${m.pendingToday === 1 ? '' : 's'} para hoy.` : 'Nada pendiente para hoy. Bien ahí.');
  }
}

// ---------- Datos ----------
async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (r.status === 401 || r.redirected) return null;   // sesión caída o redirección al login
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) return null;
  return r.json();
}

let retry = null;
async function refresh() {
  try {
    const [data, rewards] = await Promise.all([getJSON('/api/data'), getJSON('/api/rewards')]);
    if (!data || !rewards) throw new Error('sin sesión');
    clearTimeout(retry);
    render(data, rewards);
    setState('ok');
    if (bridge) bridge.visible(true);
  } catch (_) {
    // Sin sesión (o servidor dormido): el HUD avisa y reintenta; no se muestra vacío.
    setState('waiting');
    setSay('Esperando la sesión de la app…');
    if (bridge) bridge.visible(false);
    clearTimeout(retry);
    retry = setTimeout(refresh, 5000);
  }
}

// ---------- Pomodoro ----------
function renderPomo() {
  const box = $('#hudPomo');
  if (!pomo) { box.hidden = true; return; }
  const left = Math.max(0, pomo.endsAt - Date.now());
  const total = Math.max(1, pomo.minutes * 60_000);
  const mm = String(Math.floor(left / 60_000)).padStart(2, '0');
  const ss = String(Math.floor((left % 60_000) / 1000)).padStart(2, '0');
  box.hidden = false;
  $('#hudPomoTime').textContent = `${mm}:${ss}`;
  $('#hudPomoLabel').textContent = pomo.label || 'Enfoque';
  $('#pomoBar').style.width = `${(left / total) * 100}%`;
}

function applyPomodoro(d) {
  clearInterval(pomoTimer);
  pomoTimer = null;
  if (d && d.running) {
    pomo = { endsAt: d.endsAt || Date.now() + 25 * 60_000, minutes: d.minutes || 25, label: d.label || '' };
    renderPomo();
    pomoTimer = setInterval(() => {
      renderPomo();
      if (pomo && pomo.endsAt <= Date.now()) { pomo = null; clearInterval(pomoTimer); pomoTimer = null; renderPomo(); }
    }, 1000);
  } else {
    pomo = null;
    renderPomo();
  }
}

// ---------- Voz ----------
// El anillo y la onda siguen el nivel que manda Jarvis (o el micrófono local).
const VOICE_LABEL = { idle: 'en espera', listening: 'escuchando', thinking: 'pensando', speaking: 'hablando' };
// Cadencia del micrófono local: 24 mediciones por segundo alcanzan para que el ojo
// no note el escalón, y cuando hay silencio sostenido baja a 8 para no gastar CPU al vicio.
const MIC_FPS = 24;
const MIC_IDLE_FPS = 8;
const MIC_MIN_DT = 1000 / MIC_FPS;
const MIC_IDLE_DT = 1000 / MIC_IDLE_FPS;
const MIC_IDLE_AFTER = 1500;
// El nivel se cuantifica en 64 pasos: menos escrituras de estilo, misma sensación.
const VOICE_STEPS = 64;
const hudEl = $('#hud');
const voiceStateEl = $('#hudVoiceState');
const hearEl = $('#hudHear');

let voiceDecay = null;
let mic = null;
let lastVoiceStep = -1;
let lastVoiceState = '';

function applyVoice(d, local) {
  const level = clamp01(d.level);
  const step = Math.round(level * VOICE_STEPS);
  // Solo se toca el estilo si el nivel cambió de paso (y la variable vive en el panel,
  // no en el documento: la invalidación de estilos queda acotada al HUD).
  if (step !== lastVoiceStep) {
    lastVoiceStep = step;
    hudEl.style.setProperty('--voice', (step / VOICE_STEPS).toFixed(3));
  }
  const state = VOICE_LABEL[d.state] ? d.state : (level > 0.05 ? 'listening' : 'idle');
  if (state !== lastVoiceState) {
    lastVoiceState = state;
    document.body.dataset.voice = state;
    voiceStateEl.textContent = VOICE_LABEL[state];
  }
  if (typeof d.text === 'string' && d.text) {
    const shown = `“${d.text}”`;
    if (hearEl.textContent !== shown) {
      hearEl.textContent = shown;
      hearEl.hidden = false;
    }
  }
  // Si Jarvis deja de mandar niveles, el anillo vuelve solo a reposo.
  if (!local) {
    clearTimeout(voiceDecay);
    voiceDecay = setTimeout(resetVoice, 1300);
  }
}

function resetVoice() {
  // `local` evita reprogramar el temporizador de reposo desde el propio reposo.
  applyVoice({ level: 0, state: 'idle' }, true);
}

// Respaldo sin Jarvis: analizar el micrófono de esta PC (requiere permiso).
async function toggleMic() {
  if (mic) { stopMic(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setSay('Este entorno no da acceso al micrófono.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512; // ventana corta: alcanza para el nivel y cuesta la mitad de muestras
    ctx.createMediaStreamSource(stream).connect(analyser);
    mic = {
      ctx, stream, analyser,
      buf: new Uint8Array(analyser.fftSize),
      raf: 0, smooth: 0,
      lastFrame: 0, lastLoud: performance.now(),
    };
    document.body.dataset.mic = '1';
    $('#hudMic').setAttribute('aria-pressed', 'true');
    // rAF sigue el refresco del monitor (y se detiene si la ventana no se ve);
    // el cálculo real se limita a la cadencia de arriba.
    const loop = (now) => {
      if (!mic) return;
      const idle = now - mic.lastLoud > MIC_IDLE_AFTER;
      if (now - mic.lastFrame < (idle ? MIC_IDLE_DT : MIC_MIN_DT)) {
        mic.raf = requestAnimationFrame(loop);
        return;
      }
      mic.lastFrame = now;
      mic.analyser.getByteTimeDomainData(mic.buf);
      let sum = 0;
      for (let i = 0; i < mic.buf.length; i++) {
        const v = (mic.buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / mic.buf.length);
      const level = Math.min(1, rms * 3.2);           // escala práctica para voz
      if (level > 0.06) mic.lastLoud = now;
      // VU meter: sube rápido y baja suave, así el anillo no tiembla.
      mic.smooth += (level - mic.smooth) * (level > mic.smooth ? 0.5 : 0.12);
      applyVoice({ level: mic.smooth, state: mic.smooth > 0.08 ? 'listening' : 'idle' }, true);
      mic.raf = requestAnimationFrame(loop);
    };
    mic.raf = requestAnimationFrame(loop);
    setSay('Escuchando el micrófono de esta PC.');
  } catch (e) {
    setSay('Sin permiso de micrófono.');
  }
}

function stopMic() {
  if (!mic) return;
  cancelAnimationFrame(mic.raf);
  try { mic.stream.getTracks().forEach(t => t.stop()); } catch (_) { /* ya cerrado */ }
  try { mic.ctx.close(); } catch (_) { /* ya cerrado */ }
  mic = null;
  delete document.body.dataset.mic;
  $('#hudMic').setAttribute('aria-pressed', 'false');
  resetVoice();
}

// ---------- Eventos del agente ----------
function parse(e) {
  try { return JSON.parse(e.data || '{}'); } catch (_) { return {}; }
}

function connectEvents() {
  if (!('EventSource' in window)) return;
  const es = new EventSource('/api/agent/events');
  es.addEventListener('state', (e) => {
    const d = parse(e);
    if (d.origin === 'agent') {
      pulse();
      if (d.say) setSay(`Jarvis · ${d.say}`);
      refresh();
    }
  });
  es.addEventListener('reward', (e) => {
    const d = parse(e);
    const g = d.game;
    if (d.origin !== 'agent' || !g) return;
    pulse();
    if (g.leveledUp) setSay(`¡Nivel ${g.newLevel}!`);
    else if (g.xp > 0) setSay(`+${g.xp} XP`);
    refresh();
  });
  es.addEventListener('pomodoro', (e) => {
    const d = parse(e);
    if (d.origin === 'agent') { pulse(); applyPomodoro(d); }
  });
  es.addEventListener('voice', (e) => {
    const d = parse(e);
    if (d.origin !== 'agent') return;
    if (!mic) applyVoice(d);   // el micrófono local tiene prioridad si está encendido
  });
  es.addEventListener('hello', (e) => {
    const d = parse(e);
    if (d.voice) applyVoice(d.voice);
  });
  // El evento de navegación no cambia el HUD, pero sí avisa que la app se movió.
  es.addEventListener('nav', (e) => { if (parse(e).origin === 'agent') pulse(); });
  // EventSource reintenta solo si se corta la conexión.
}

// El botón de micrófono existe también en el navegador (no necesita Electron).
$('#hudMic').addEventListener('click', toggleMic);

// ---------- Puente con Electron ----------
if (bridge) {
  // Interactividad solo mientras el puntero está sobre un botón: el resto del
  // overlay deja pasar los clics al escritorio.
  document.addEventListener('mousemove', (e) => {
    bridge.interactive(!!(e.target instanceof Element && e.target.closest('.mini')));
  });
  document.addEventListener('mouseleave', () => bridge.interactive(false));
  $('#hudPin').addEventListener('click', () => bridge.pin());
  $('#hudHide').addEventListener('click', () => bridge.hide());
  if (bridge.onPin) bridge.onPin((on) => { document.body.dataset.pinned = on ? '1' : '0'; });
}

// ---------- Arranque ----------
refresh();
connectEvents();
// Respaldo por si el SSE se cae o el HUD queda abierto mucho tiempo.
setInterval(refresh, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
// `?mic=1` enciende el micrófono local al abrir: sirve para probar el HUD sin Jarvis.
if (new URLSearchParams(window.location.search).get('mic') === '1') toggleMic();
