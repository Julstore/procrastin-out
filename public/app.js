/* procrastin-out — vence la procrastinación (cliente) */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const AREAS = ['personal', 'casa', 'trabajo', 'salud', 'finanzas', 'social'];
const CATEGORIES = ['Comida', 'Transporte', 'Casa', 'Salud', 'Ocio', 'Suscripciones', 'Otros'];
let D = null;      // datos completos
let tab = 'tasks';
let habitOffset = 0;        // semanas desplazadas en el calendario de hábitos
let mealDate = today();     // día mostrado en alimentación
let commitFilter = 'all';   // filtro de compromisos por persona
let pomo = { itemId: null, mode: 'focus', secs: 25 * 60, running: false, timer: null };
const POMO_LEN = { focus: 25 * 60, brk: 5 * 60 };
function fmtClock(s) { s = Math.max(0, Math.round(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }

// --- RPG helpers ---
// ---------- Progreso global (mutación de color rojo → verde) ----------
// progreso: tareas pendientes vs completadas, hábitos de la semana, compromisos
function globalProgress() {
  const tasksTotal = D.tasks.length;
  const tasksDone = D.tasks.filter(t => t.done).length;
  const taskPart = tasksTotal ? tasksDone / tasksTotal : 0; // vacío = 0%, no 100%: el badge solo es verde con mérito real
  // hábitos: % de checks de esta semana sobre 7 días objetivo por hábito
  const week = currentWeekDays();
  const pastDays = week.filter(dk => dk <= today()).length || 7;
  let habitDone = 0, habitTotal = 0;
  for (const h of D.habits) {
    for (const dk of week) {
      if (dk > today()) continue;
      habitTotal++;
      if (habitCheck(h, dk)) habitDone++;
    }
  }
  const habitPart = habitTotal ? habitDone / habitTotal : 0;
  const commitsTotal = D.commitments.length;
  const commitsDone = D.commitments.filter(c => c.done).length;
  const commitPart = commitsTotal ? commitsDone / commitsTotal : 0;
  if (!tasksTotal && !habitTotal && !commitsTotal) return 0;
  return Math.round(((taskPart + habitPart + commitPart) / 3) * 100);
}
// Semáforo de ambiente: rojo→naranja→amarillo→verde según % completado.
// Tono continuo por matiz HSL (5° rojo → 140° verde) + nombre por tramo.
function moodFor(pct) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const hue = 5 + (p / 100) * 135;
  const col = `hsl(${hue.toFixed(1)}, 78%, 45%)`;
  const col2 = `hsl(${((hue + 22) % 360).toFixed(1)}, 88%, 55%)`;
  const soft = `hsla(${hue.toFixed(1)}, 85%, 45%, 0.14)`;
  let name = 'rojo', emoji = '🔴';
  if (p >= 70) { name = 'verde'; emoji = '🟢'; }
  else if (p >= 45) { name = 'amarillo'; emoji = '🟡'; }
  else if (p >= 20) { name = 'naranja'; emoji = '🟠'; }
  return { p, hue, col, col2, soft, name, emoji };
}
// Compat: antes era un array de 5 colores, ahora delega en el semáforo continuo.
function progressColor(pct) { return moodFor(pct).col; }
function updateProgressBadge() {
  const pct = globalProgress();
  const m = moodFor(pct);
  const pill = $('#progPill');
  if (!pill) return;
  pill.style.background = m.soft;
  pill.style.borderColor = m.col;
  const empty = !D.tasks.length && !D.habits.length && !D.commitments.length;
  pill.title = empty ? 'Añade tareas, hábitos o compromisos para empezar a progresar' : (m.p >= 100 ? '¡Todo realizado! 🟢' : `Progreso general: ${m.p}% · ${m.emoji} ${m.name} — completa todo y la app se vuelve verde`);
  const pctEl = $('#progPct');
  if (pctEl) { pctEl.textContent = m.p + '%'; pctEl.style.color = m.col; }
  const fill = $('#progFill');
  if (fill) { fill.style.width = m.p + '%'; fill.style.background = `linear-gradient(90deg, ${m.col}, ${m.col2})`; }
  const dot = $('#moodLabel');
  if (dot) { dot.textContent = m.emoji; dot.title = `Ambiente: ${m.name} (${m.p}% completado)`; }
  const root = document.documentElement;
  root.style.setProperty('--mood', m.col);
  root.style.setProperty('--mood-2', m.col2);
  root.style.setProperty('--mood-soft', m.soft);
  root.style.setProperty('--mood-hue', String(Math.round(m.hue)));
  root.style.setProperty('--accent-progress', m.col);
  document.body.dataset.mood = m.name;
  const chip = $('#lvlChip');
  if (chip) chip.textContent = `⭐ Nv ${D.hero?.level || 1}${D.hero?.streak ? ' · 🔥' + D.hero.streak : ''}`;
}
// ---------- Modal "usar en el celular" (misma red WiFi) ----------
window.openPhoneModal = async function () {
  const modal = $('#phoneModal');
  if (!modal) return;
  modal.hidden = false;
  const box = $('#phoneUrls');
  if (box) box.innerHTML = '<p class="meta">Buscando la dirección de tu PC…</p>';
  try {
    const lan = await fetchJSON('/api/lan');
    const urls = (lan.urls || []).map(u => `<code>${esc(u)}</code>`).join('');
    if (box) box.innerHTML = !urls ? '<p class="meta">No se encontró dirección. Verifica que la PC tenga WiFi activo.</p>'
      : lan.cloud
        ? `<p class="meta">Tu nube ☁️: abre esta dirección en el celular <strong>desde donde sea</strong> e instálala como app:</p>${urls}<p class="meta">Chrome Android: menú ⋮ → “Agregar a pantalla principal”. iPhone: Compartir → “Agregar a inicio”.</p>`
        : `<p class="meta">Con el celular en la <strong>misma WiFi</strong>, abre una de estas direcciones en Chrome/Safari e instálala como app:</p>${urls}<p class="meta">Chrome Android: menú ⋮ → “Agregar a pantalla principal”. iPhone: Compartir → “Agregar a inicio”. La PC debe estar encendida con la app abierta.</p>`;
  } catch (e) {
    if (box) box.innerHTML = `<p class="meta">No se pudo obtener la dirección: ${esc(e.message || 'error')}</p>`;
  }
};
window.closePhoneModal = function () { const modal = $('#phoneModal'); if (modal) modal.hidden = true; };
function showXp(xp, title, leveledUp, newLv) {
  const wrap = document.createElement('div');
  wrap.className = 'fxp' + (leveledUp ? ' lvlup' : '');
  wrap.innerHTML = (leveledUp ? `🎉 ¡${esc(title || '')}` : `⭐ +${xp} XP · ${esc(title || '')}`);
  $('#flyingXp').appendChild(wrap);
  setTimeout(() => wrap.remove(), 3800);
}
function showBadges(list) {
  for (const b of list || []) {
    const wrap = document.createElement('div');
    wrap.className = 'fxp lvlup';
    wrap.innerHTML = `🏅 ¡Insignia: ${esc(b.name || b.id)}!`;
    $('#flyingXp').appendChild(wrap);
    setTimeout(() => wrap.remove(), 4200);
  }
}
// Muestra toasts de recompensa con el formato que devuelva el servidor (PATCH o PUT)
function toastGame(g) {
  if (!g) return;
  if (g.freezeSaved) {
    const wrap = document.createElement('div');
    wrap.className = 'fxp lvlup';
    wrap.innerHTML = '❄️ ¡Streak Freeze! Tu racha sobrevivió a un día en blanco';
    $('#flyingXp').appendChild(wrap);
    setTimeout(() => wrap.remove(), 4200);
  }
  if (g.newBadges?.length) showBadges(g.newBadges);
  if (g.leveledUp) showXp(0, `¡Nivel ${g.newLevel} alcanzado! 🏆`, true, g.newLevel);
  else if (g.xp > 0) {
    const t = g.titles?.length ? g.titles.join(' · ') : (g.title || '');
    showXp(g.xp, t, false, 0);
  }
}
// ---------- Avisos de vencimientos (Notification API al abrir la app) ----------
function dueItems() {
  const t = today();
  return {
    tasks: D.tasks.filter(x => !x.done && x.due && x.due <= t),
    coms: D.commitments.filter(c => !c.done && c.date && c.date <= t),
    appts: D.appointments.filter(a => !a.done && a.date && a.date <= t),
  };
}
window.enableNotif = async function () {
  if (!('Notification' in window)) { alert('Tu navegador no soporta notificaciones.'); return; }
  const p = await Notification.requestPermission();
  try { localStorage.setItem('pout-notif', p); } catch (_) {}
  render();
  if (p === 'granted') { maybeNotify(true); notifyDigest(); }
};
function notifOn() { try { return localStorage.getItem('pout-notif') === 'granted' && 'Notification' in window && Notification.permission === 'granted'; } catch (_) { return false; } }
function maybeNotify(force) {
  if (!notifOn()) return;
  if (!force && sessionStorage.getItem('pout-notified')) return; // 1 aviso por sesión
  const { tasks, coms, appts } = dueItems();
  const n = tasks.length + coms.length + appts.length;
  if (!n) return;
  sessionStorage.setItem('pout-notified', '1');
  const lines = [...tasks.slice(0, 3).map(t => '✅ ' + t.title), ...coms.slice(0, 2).map(c => '🤝 ' + c.title), ...appts.slice(0, 2).map(a => '🩺 ' + a.title)];
  try { new Notification(`🥊 procrastin-out: ${n} pendiente${n > 1 ? 's' : ''} hoy`, { body: lines.join('\n') }); } catch (_) {}
}
// PATCH con soporte de recompensa
async function patch(coll, id, body) {
  const res = await fetchJSON(`/api/${coll}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  toastGame(res?.game);
  await reload({ silent: true });
}
// PUT /api/data con soporte de recompensa (rutina, comidas, agua, proyectos...)
async function putData(body, opts = {}) {
  const res = await fetchJSON('/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  toastGame(res?.game);
  await reload({ silent: opts.silent });
  return res;
}

function today() { return new Date().toISOString().slice(0, 10); }
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDate(d) {
  if (!d) return '';
  const days = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const dt = new Date(d + 'T00:00:00');
  return `${days[dt.getDay()]} ${dt.getDate()} ${months[dt.getMonth()]}`;
}
function isOverdue(d) { return d && d < today(); }

// ---------- API ----------
async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) { location.href = '/login.html'; throw new Error('No autenticado'); }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function addItem(coll, body) {
  await fetchJSON(`/api/${coll}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await reload();
}
async function del(coll, id) {
  if (!confirm('¿Eliminar?')) return;
  await fetch(`/api/${coll}/${id}`, { method: 'DELETE' });
  await reload();
}
let reloadSeq = 0;
async function reload(opts = {}) {
  const mySeq = ++reloadSeq;
  const fresh = await fetchJSON('/api/data');
  // si hubo un reload más reciente (el de un PATCH en curso), no sobrescribir D con datos viejos
  if (mySeq !== reloadSeq) return;
  D = fresh;
  render();
  updateProgressBadge();
  maybeNotify(false);
  if (!opts.silent) {
    $('#saveState').textContent = '✓ Guardado ' + new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    setTimeout(() => { $('#saveState').textContent = ''; }, 2500);
  }
}


// ---------- Helpers de hábitos ----------
function habitCheck(h, dateKey) { return !!h.log?.[dateKey]; }
function toggleHabit(h, dateKey) {
  const log = { ...(h.log || {}) };
  if (log[dateKey]) delete log[dateKey]; else log[dateKey] = 1;
  return log;
}
function habitStreak(h) {
  let streak = 0;
  let d = new Date();
  // si hoy no está hecho, empezar a contar desde ayer (racha no se rompe por el día en curso)
  if (!habitCheck(h, d.toISOString().slice(0, 10))) d.setDate(d.getDate() - 1);
  while (habitCheck(h, d.toISOString().slice(0, 10))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}
function overweekDone(h) {
  const week = currentWeekDays();
  return week.filter(dk => habitCheck(h, dk)).length;
}
function startOfWeek(day) { // lunes de la semana de "day"
  const d = new Date(day + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7; // 0=lunes
  d.setDate(d.getDate() - dow);
  return d;
}
function currentWeekDays() {
  const start = startOfWeek(today()); // lunes (mal nombre, refactor pendiente)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start); d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });
}
function habitWeekDays(offset) {
  const start = startOfWeek(today());
  start.setDate(start.getDate() + offset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start); d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

// ---------- Render ----------
function render() {
  $$('#saveState').length; // no-op
  $$('.card, section').forEach(() => {}); // no-op
  document.body.dataset.tab = tab;
  const app = $('#app');
  const views = { tasks: viewTasks, habits: viewHabits, health: viewHealth, meals: viewMeals, commitments: viewCommitments, finances: viewFinances, learning: viewLearning, projects: viewProjects, news: viewNews, rewards: viewRewards };
  app.innerHTML = `<section>${(views[tab] || viewTasks)()}</section>`;
  bind();
}


// ---------- Tareas ----------
function viewTasks() {
  const pending = D.tasks.filter(t => !t.done).sort((a, b) => {
    const p = { alta: 0, media: 1, baja: 2 };
    return (p[a.priority] ?? 1) - (p[b.priority] ?? 1) || (a.due || '9999').localeCompare(b.due || '9999');
  });
  const done = D.tasks.filter(t => t.done);
  return `
    <h2>✅ Tareas</h2>
    ${(() => {
      const dd = dueItems();
      const n = dd.tasks.length + dd.coms.length + dd.appts.length;
      const rows = [...dd.tasks.map(t => ['✅', t.title, t.due]), ...dd.coms.map(c => ['🤝', c.title, c.date]), ...dd.appts.map(a => ['🩺', a.title, a.date])];
      return `<div class="card due-panel">
        <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
          <strong>⏰ Para hoy${n ? ` (${n})` : ''}</strong>
          <span class="row" style="gap:6px">
            ${notifOn() ? '<span class="meta">🔔 avisos activos</span>' : '<button class="btn ghost small" onclick="enableNotif()">🔔 Activar avisos</button>'}
            <button class="btn ghost small" onclick="askStrategy()">🧭 Briefing con IA</button>
          </span>
        </div>
        ${n ? `<ul class="hist-list">${rows.map(([e, t, d]) => `<li><span>${e}</span> ${esc(t)} <span class="meta">${d < today() ? '⚠️ vencido ' : ''}${fmtDate(d)}</span></li>`).join('')}</ul>` : '<p class="meta">Nada vencido. Activa los avisos y te avisaré al abrir la app.</p>'}
        <div id="stratOut" class="ai-out" hidden></div>
      </div>`;
    })()}
    <div class="inline-add">
      <input type="text" id="t-title" placeholder="¿Qué necesitas hacer?" onkeydown="if(event.key==='Enter')addTask()">
      <input type="date" id="t-due" style="width:auto">
      <select id="t-prio"><option value="media">Media</option><option value="alta">Alta</option><option value="baja">Baja</option></select>
      <select id="t-area">${AREAS.map(a => `<option>${a}</option>`).join('')}</select>
      <button class="btn" onclick="addTask()">Añadir</button>
    </div>
    ${pending.length ? '' : '<p class="meta">Nada pendiente. 🎉</p>'}
    ${pending.map(t => `
      <div class="card">
        <div class="row">
          <input type="checkbox" onchange="patch('tasks','${t.id}',{done:true})">
          <span class="title">${esc(t.title)}</span>
          <span class="priority ${t.priority}">${t.priority}</span>
          <span class="meta">${esc(t.area)}${t.due ? ' · 📅 ' + fmtDate(t.due) + (isOverdue(t.due) ? ' ⚠️' : '') : ''}</span>
          <button class="icon-btn" onclick="del('tasks','${t.id}')">🗑</button>
        </div>
      </div>`).join('')}
    ${done.length ? `<h3>Completadas (${done.length})</h3>
      ${done.map(t => `
        <div class="card done">
          <div class="row">
            <input type="checkbox" checked onchange="patch('tasks','${t.id}',{done:false})">
            <span class="title">${esc(t.title)}</span>
            <button class="icon-btn" onclick="del('tasks','${t.id}')">🗑</button>
          </div>
        </div>`).join('')}` : ''}
  `;
}
window.addTask = async function () {
  const title = $('#t-title').value.trim();
  if (!title) return;
  await addItem('tasks', { title, due: $('#t-due').value || null, priority: $('#t-prio').value, area: $('#t-area').value, done: false });
};

// ---------- Hábitos ----------
function viewHabits() {
  const days = habitWeekDays(habitOffset);
  const labels = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const rows = D.habits.map(h => {
    const streak = habitStreak(h);
    const wk = overweekDone(h);
    const cells = days.map(dk => {
      const isOn = habitCheck(h, dk);
      const isToday = dk === today();
      const isFuture = dk > today();
      return `<div class="cal-day ${isOn ? 'on' : ''} ${isToday ? 'today' : ''} ${isFuture ? 'future' : ''}"
        data-habit="${h.id}" data-date="${dk}" title="${dk}"></div>`;
    }).join('');
    return `
      <div class="card">
        <div class="habit-row">
          <div class="habit-name">${h.emoji || ''} ${esc(h.name)}
            <span class="streak">🔥${streak} · ${wk}/${h.targetPerWeek}</span>
          </div>
          <div class="cal">${cells}</div>
          <div class="habit-actions">
            <button class="icon-btn" onclick="del('habits','${h.id}')">🗑</button>
          </div>
        </div>
      </div>`;
  }).join('');
  return `
    <h2>🔥 Hábitos</h2>
    <div class="inline-add">
      <input type="text" id="h-name" placeholder="Ej: caminar 30 min" onkeydown="if(event.key==='Enter')addHabit()">
      <input type="text" id="h-emoji" placeholder="Emoji" style="width:70px">
      <select id="h-target">${[3,4,5,6,7].map(n => `<option value="${n}">${n}/sem</option>`).join('')}</select>
      <button class="btn" onclick="addHabit()">Añadir</button>
    </div>
    <div class="row" style="justify-content: space-between; margin-bottom: 12px;">
      <button class="btn ghost small" onclick="habitOffset--;render()">◀ Anterior</button>
      <span class="meta">${fmtDate(days[0])} — ${fmtDate(days[6])}</span>
      <button class="btn ghost small" onclick="habitOffset++;render()" ${habitOffset > 0 ? 'disabled' : ''}>Siguiente ▶</button>
    </div>
    <div class="cal" style="max-width:300px;margin-bottom:8px">
      ${labels.map(l => `<div class="cal-day empty" style="visibility:visible">${l}</div>`).join('')}
    </div>
    ${rows || '<p class="meta">Añade tu primer hábito arriba.</p>'}
  `;
}
window.addHabit = async function () {
  const name = $('#h-name').value.trim();
  if (!name) return;
  await addItem('habits', { name, emoji: $('#h-emoji').value.trim() || '', targetPerWeek: +$('#h-target').value, log: {} });
};

// ---------- Salud ----------
const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const EX_MERGED = ({
  pecho: ['Press banca', 'Flexiones', 'Aperturas con mancuernas'],
  espalda: ['Dominadas', 'Remo con mancuerna', 'Peso muerto'],
  piernas: ['Sentadillas', 'Prensa', 'Zancadas', 'Gemelos'],
  hombros: ['Press militar', 'Elevaciones laterales'],
  brazos: ['Curl bíceps', 'Tricep en polea'],
  cardio: ['Cinta 20min', 'Bici 20min', 'Caminata 30min'],
  core: ['Plancha', 'Abdominales', 'Crunch bicicleta'],
});
var viewHealth = function () {
  const latest = D.measurements.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
  const w = latest?.weight;
  const appts = D.appointments.filter(a => !a.done).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const routine = D.routine || {};
  return `
    <h2>🩺 Salud</h2>
    <div class="stats-grid">
      <div class="stat-card"><div class="num">${w ? w + ' kg' : '—'}</div><div class="lbl">Último peso</div></div>
      <div class="stat-card"><div class="num">${D.measurements.filter(m => m.date === today() && m.weight).length ? latest.weight + ' kg' : '—'}</div><div class="lbl">Peso hoy</div></div>
    </div>

    <h3>🏋️ Rutina de ejercicios</h3>
    <p class="meta">Planifica tu semana: elige muscle groups y ejercicios para cada día. Marca lo que completes.</p>
    <div class="row aiRoutineWrap">
      <button class="btn" onclick="genRoutine()">🤖 Rutina semanal con IA</button>
      <button class="btn ghost" onclick="progressRoutine()">📈 Ajustar progresión con IA</button>
    </div>
    <p class="meta">La primera genera la semana desde cero según tu perfil (reemplaza la actual). La segunda revisa lo que completaste y sube la intensidad donde toca.</p>
    <div id="aiOutRoutine" class="ai-out" hidden></div>
    <div class="routine-grid">
      ${DAYS.map((day, i) => {
        const items = routine[i] || [];
        return `
        <div class="card routine-day">
          <div class="routine-head">
            <strong>${day}</strong>
            <select onchange="setDayFocus(${i},this.value)">
              <option value="">Descanso</option>
              ${Object.keys(EX_MERGED).map(g => `<option value="${g}" ${routine[i + '_focus'] === g ? 'selected' : ''}>${g}</option>`).join('')}
            </select>
          </div>
          ${items.length ? items.map((ex, j) => `
            <div class="routine-ex ${ex.done ? 'done' : ''}" data-day="${i}" data-idx="${j}">
              <input type="checkbox" ${ex.done ? 'checked' : ''} onchange="toggleEx(${i},${j},this.checked)">
              <span class="ex-name">${esc(ex.name)}</span>
              <span class="meta">${esc(ex.sets || '')}</span>
              <button class="icon-btn" onclick="delEx(${i},${j})">×</button>
            </div>`).join('') : '<p class="meta">Sin ejercicios.</p>'}
          <div class="new-step">
            <input type="text" placeholder="+ ejercicio (ej: Sentadillas 4x10)" onkeydown="if(event.key==='Enter')addEx(${i},this)">
          </div>
        </div>`;
      }).join('')}
    </div>

    <h3>Registro del día</h3>
    <div class="inline-add">
      <input type="date" id="m-date" value="${today()}">
      <input type="number" id="m-weight" placeholder="Peso (kg)" style="width:110px">
      <button class="btn" onclick="saveMeasurement()">Guardar</button>
    </div>
    <h3>Citas médicas</h3>
    <div class="inline-add">
      <input type="text" id="a-title" placeholder="Ej: dentista" onkeydown="if(event.key==='Enter')addAppt()">
      <input type="date" id="a-date"><input type="time" id="a-time">
      <button class="btn" onclick="addAppt()">Añadir</button>
    </div>
    ${appts.map(a => `
      <div class="card"><div class="row">
        <input type="checkbox" onchange="patch('appointments','${a.id}',{done:true})">
        <span class="title">${esc(a.title)}</span>
        <span class="meta">${fmtDate(a.date)}${a.time ? ' ' + a.time : ''}</span>
        <button class="icon-btn" onclick="del('appointments','${a.id}')">🗑</button>
      </div></div>`).join('') || '<p class="meta">Sin citas pendientes.</p>'}
    <h3>Historial de peso</h3>
    ${D.measurements.length ? `<table><tr><th>Fecha</th><th>Peso</th></tr>
      ${D.measurements.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10).map(m => `<tr><td>${fmtDate(m.date)}</td><td class="amt">${m.weight ?? '—'} kg</td></tr>`).join('')}
    </table>` : '<p class="meta">Sin registros.</p>'}
    <h3>Medicamentos / suplementos</h3>
    <textarea id="meds" placeholder="Ej: vitamina D cada mañana...">${esc(D.meds || '')}</textarea>
    <button class="btn ghost small" style="margin-top:6px" onclick="saveMeds()">Guardar nota</button>
  `;
};
window.setDayFocus = function (i, focus) {
  D.routine = D.routine || {};
  D.routine[i + '_focus'] = focus;
  saveRoutine();
};
window.addEx = function (i, input) {
  const text = input.value.trim();
  if (!text) return;
  D.routine = D.routine || {};
  (D.routine[i] = D.routine[i] || []).push({ name: text, done: false });
  input.value = '';
  saveRoutine();
};
window.toggleEx = function (i, j, done) {
  D.routine[i][j].done = done;
  D.routine[i][j].doneAt = done ? new Date().toISOString().slice(0, 10) : null;
  saveRoutine();
};
window.delEx = function (i, j) {
  D.routine[i].splice(j, 1);
  saveRoutine();
};
async function saveRoutine() {
  await putData({ routine: D.routine }, { silent: true });
}
async function requestRoutine(kind, loadingMsg) {
  const out = $('#aiOutRoutine');
  out.hidden = false;
  out.className = 'ai-out loading';
  out.textContent = loadingMsg;
  try {
    const res = await fetchJSON('/api/ai/advise', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) });
    if (res.applied) {
      out.className = 'ai-out';
      out.innerHTML = esToHtml(res.reply || '✅ Rutina aplicada');
      await reload({ silent: true });
      render();
    } else {
      out.className = 'ai-out';
      out.innerHTML = `<span style="color:var(--danger)">${esc(res.error || 'No se pudo generar la rutina')}</span><p class="meta" style="margin-top:6px">Consejo: completa tu perfil (altura, peso, edad, objetivo) en la pestaña Alimentación para mejores resultados.</p>`;
    }
  } catch (e) {
    out.className = 'ai-out';
    out.innerHTML = `<span style="color:var(--danger)">${esc(e.message || 'Error de red')}</span>`;
  }
}
window.genRoutine = function () { requestRoutine('workout', '🤖 Diseñando tu rutina semanal según tu perfil...'); };
window.progressRoutine = async function () {
  const r = D.routine || {};
  const hasDone = Object.keys(r).some(k => !k.endsWith('_focus') && (r[k] || []).some(e => e.done));
  if (!Object.keys(r).some(k => !k.endsWith('_focus'))) {
    alert('Primero genera una rutina con "Rutina semanal con IA" o añade ejercicios manualmente.');
    return;
  }
  if (!confirm(hasDone
    ? 'La IA revisará lo que completaste esta semana y ajustará la intensidad. Esto REEMPLAZA la rutina actual (los checks se reinician). ¿Continuar?'
    : 'No marcaste ningún ejercicio como completado esta semana: la IA podría no subir la intensidad. ¿Continuar de todos modos?')) return;
  requestRoutine('progress', '📈 Analizando tu semana y ajustando la progresión...');
};
window.saveMeasurement = async function () {
  const dateVal = $('#m-date').value || today();
  const weight = $('#m-weight').value ? parseFloat($('#m-weight').value) : null;
  if (!weight) return;
  D.measurements.push({ id: uid(), date: dateVal, weight });
  await fetch('/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ measurements: D.measurements }) });
  await reload();
};
window.addAppt = async function () {
  const title = $('#a-title').value.trim();
  if (!title) return;
  await addItem('appointments', { title, date: $('#a-date').value || today(), time: $('#a-time').value || null, done: false });
};
window.saveMeds = async function () {
  await fetch('/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meds: $('#meds').value }) });
  await reload();
};

// ---------- Alimentación ----------
// Perfil nutricional + dietas generadas por IA
function bmiInfo() {
  const p = D.profile || {};
  if (!p.heightCm || !p.weightKg) return null;
  const h = p.heightCm / 100;
  const bmi = p.weightKg / (h * h);
  let cat = 'normal';
  if (bmi < 18.5) cat = 'bajo peso'; else if (bmi >= 25) cat = bmi >= 30 ? 'obesidad' : 'sobrepeso';
  return { bmi: bmi.toFixed(1), cat };
}
function bmr() { // Mifflin-St Jeor
  const p = D.profile || {};
  if (!p.heightCm || !p.weightKg || !p.age || !p.sex) return null;
  const base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age;
  return Math.round(p.sex === 'f' ? base - 161 : base + 5);
}
function showAiMsg(elId, resp) {
  const box = $(elId);
  if (!box) return;
  box.textContent = resp?.reply || resp?.error || '';
  box.hidden = false;
}
function viewMeals() {
  const key = mealDate;
  const m = D.meals[key] || {};
  const water = m.water || 0;
  const p = D.profile || {};
  const bmi = bmiInfo();
  const b = bmr();
  const calTarget = p.goalWeight && p.weightKg ? (p.goalWeight < p.weightKg ? Math.round((b || 2000) - 500) : (b || 2000)) : null;
  return `
    <h2>🍎 Alimentación</h2>

    <div class="card profile-card">
      <h3 style="margin-top:0">👤 Tu perfil</h3>
      <div class="profile-grid">
        <label>Altura (cm)<input type="number" id="pf-height" value="${p.heightCm || ''}" placeholder="175"></label>
        <label>Peso (kg)<input type="number" id="pf-weight" value="${p.weightKg || ''}" placeholder="80"></label>
        <label>Edad<input type="number" id="pf-age" value="${p.age || ''}"></label>
        <label>Sexo<select id="pf-sex"><option value="m" ${p.sex === 'm' ? 'selected' : ''}>Masculino</option><option value="f" ${p.sex === 'f' ? 'selected' : ''}>Femenino</option></select></label>
        <label>Peso objetivo (kg)<input type="number" id="pf-goal" value="${p.goalWeight || ''}" placeholder="70"></label>
        <label>Actividad<select id="pf-act">
          <option value="1.2" ${p.activity === '1.2' ? 'selected' : ''}>Sedentario</option>
          <option value="1.375" ${p.activity === '1.375' ? 'selected' : ''}>Ligero (1-3 días/semana)</option>
          <option value="1.55" ${p.activity === '1.55' ? 'selected' : ''}>Moderado (3-5 días)</option>
          <option value="1.725" ${p.activity === '1.725' ? 'selected' : ''}>Intenso (6-7 días)</option>
        </select></label>
      </div>
      <div class="profile-stats">
        ${bmi ? `<span class="cat-chip">IMC ${bmi.bmi} · ${bmi.cat}</span>` : ''}
        ${b ? `<span class="cat-chip">TMB ${b} kcal</span>` : ''}
        ${calTarget ? `<span class="cat-chip">Objetivo diario ≈ ${calTarget} kcal</span>` : ''}
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn" onclick="saveProfile()">Guardar perfil</button>
        <button class="btn ghost" onclick="askAi('diet')">🍽️ Cambios de dieta recomendados por IA</button>
        <button class="btn ghost" onclick="askAi('plan')">📆 Plan de dieta semanal con IA</button>
      </div>
      <div id="aiOut" class="ai-out" hidden></div>
    </div>

    <div class="meal-nav">
      <button class="btn ghost small" onclick="shiftMeal(-1)">◀</button>
      <strong>${fmtDate(key)}${key === today() ? ' (hoy)' : ''}</strong>
      <button class="btn ghost small" onclick="shiftMeal(1)">▶</button>
      <input type="date" id="m-date2" value="${key}" onchange="mealDate=this.value;render()">
    </div>
    <div class="meal-grid">
      ${['Desayuno', 'Almuerzo', 'Comida', 'Merienda', 'Cena', 'Snacks'].map((label, i) => {
        const fieldMap = ['breakfast', 'lunch', 'dinner', 'snacks', 'supper', 'extra'];
        const f = fieldMap[i];
        return `<div class="card meal-field">
          <label>${label}</label>
          <textarea id="meal-${f}" placeholder="¿Qué comiste?">${esc(m[f] || '')}</textarea>
        </div>`;
      }).join('')}
      <button class="btn" onclick="saveMeals()">Guardar comidas del día</button>
    </div>
    <div class="water-row">
      <span>💧 Agua (${water}/8 vasos):</span>
      ${Array.from({ length: 8 }, (_, i) => `<button class="wg ${i < water ? 'filled' : ''}" onclick="setWater(${i + 1})"></button>`).join('')}
      <button class="btn ghost small" onclick="setWater(0)">Reiniciar</button>
    </div>
    <div class="card nutri-card">
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
        <strong>⚡ Calorías estimadas</strong>
        <button class="btn ghost small" onclick="askCalories()">Estimar con IA</button>
      </div>
      ${m.nutri ? `<div class="meta" style="margin:6px 0">≈<strong>${m.nutri.totalKcal} kcal</strong>${calTarget ? ` · objetivo ≈${calTarget} kcal (${m.nutri.totalKcal <= calTarget ? 'dentro ✓' : 'por encima ⚠️'})` : ''}</div>
      <ul class="hist-list">${(m.nutri.items || []).map(it => `<li><span>🍽 ${esc(it.plato || '')}</span> ${it.gramos ?? '?'} g · ${it.kcal ?? '?'} kcal</li>`).join('')}</ul>
      ${m.nutri.tip ? `<p class="meta">💡 ${esc(m.nutri.tip)}</p>` : ''}` : '<p class="meta">La IA estima kcal y peso de lo que registraste este día.</p>'}
      <div id="nutriOut" class="ai-out" hidden></div>
    </div>
  `;
}
window.askCalories = async function () {
  const out = $('#nutriOut');
  if (!out) return;
  out.hidden = false;
  out.className = 'ai-out loading';
  out.textContent = '⚡ Estimando calorías y porciones... (puede tardar 1-3 min)';
  try {
    const res = await fetchJSON('/api/ai/advise', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'calories', date: mealDate }) });
    out.className = 'ai-out';
    if (res.applied) { out.innerHTML = esc(res.reply || '✓ Guardado'); await reload({ silent: true }); render(); }
    else out.innerHTML = `<span style="color:var(--danger)">${esc(res.error || 'No se pudo estimar')}</span>`;
  } catch (e) {
    out.className = 'ai-out';
    out.innerHTML = `<span style="color:var(--danger)">${esc(e.message || 'Error de red')}</span>`;
  }
};
window.saveProfile = async function () {
  const profile = {
    heightCm: parseFloat($('#pf-height').value) || null,
    weightKg: parseFloat($('#pf-weight').value) || null,
    age: parseInt($('#pf-age').value) || null,
    sex: $('#pf-sex').value,
    goalWeight: parseFloat($('#pf-goal').value) || null,
    activity: $('#pf-act').value,
  };
  await fetch('/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile }) });
  await reload({ silent: true });
  render();
};
window.askAi = async function (kind) {
  const out = $('#aiOut');
  out.hidden = false;
  out.className = 'ai-out loading';
  out.textContent = '🤔 Pidiendo recomendación a la IA...';
  try {
    const res = await fetchJSON('/api/ai/advise', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) });
    out.className = 'ai-out';
    out.innerHTML = res.reply ? esToHtml(res.reply) : `<span style="color:var(--danger)">${esc(res.error || 'No se pudo obtener respuesta')}</span>`;
  } catch (e) {
    out.className = 'ai-out';
    out.innerHTML = `<span style="color:var(--danger)">${esc(e.message || 'Error de red')}</span>`;
  }
};
// texto plano de la IA → HTML ligero (títulos y viñetas)
function esToHtml(txt) {
  return esc(txt).split('\n').filter(Boolean).map(l => {
    const isTitle = /^#{1,3}/.test(l) || l.length < 40 && !/^[*-]/.test(l) && !/^\d/.test(l);
    const bullet = /^[*]/.test(l) || /^\d+[-.)]/.test(l);
    if (isTitle && !bullet) return `<strong>${l.replace(/^#+\s*/, '')}</strong>`;
    return bullet ? `<li>${l.replace(/^[*-]\s*/, '').replace(/^\d+[-.)]\s*/, '')}</li>` : `<p>${l}</p>`;
  }).join('');
}
window.shiftMeal = function (n) { mealDate = shiftDate(mealDate, n); render(); };
window.saveMeals = async function () {
  const m = { ...(D.meals[mealDate] || {}) };
  ['#meal-breakfast', '#meal-lunch', '#meal-dinner', '#meal-snacks', '#meal-supper', '#meal-extra'].forEach((sel, i) => {
    m[['breakfast', 'lunch', 'dinner', 'snacks', 'supper', 'extra'][i]] = $(sel).value;
  });
  D.meals = { ...D.meals, [mealDate]: m };
  await putData({ meals: D.meals });
};
window.setWater = async function (n) {
  const m = { ...(D.meals[mealDate] || {}), water: n };
  D.meals = { ...D.meals, [mealDate]: m };
  await putData({ meals: D.meals }, { silent: true });
  render();
};
function shiftDate(dk, n) {
  const d = new Date(dk + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

window.askStrategy = async function () {
  const out = $('#stratOut');
  if (!out) return;
  out.hidden = false;
  out.className = 'ai-out loading';
  out.textContent = '🧭 Analizando tu semana para decidir prioridades... (puede tardar 1-3 min)';
  try {
    const res = await fetchJSON('/api/ai/advise', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'strategy' }) });
    out.className = 'ai-out';
    out.innerHTML = res.reply ? esToHtml(res.reply) : `<span style="color:var(--danger)">${esc(res.error || 'No se pudo obtener respuesta')}</span>`;
  } catch (e) {
    out.className = 'ai-out';
    out.innerHTML = `<span style="color:var(--danger)">${esc(e.message || 'Error de red')}</span>`;
  }
};

// ---------- Compromisos ----------
function viewCommitments() {
  const t = today();
  const open = D.commitments.filter(c => !c.done).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  const persons = [...new Set(D.commitments.map(c => c.person || '—'))].sort();
  window._persons = persons;
  const shown = commitFilter === 'all' ? open : open.filter(c => (c.person || '—') === commitFilter);
  const score = {};
  for (const c of D.commitments) {
    const k = c.person || '—';
    score[k] = score[k] || { done: 0, total: 0 };
    if (c.done) score[k].done++; else score[k].total++;
  }
  const card = (c) => {
    const overdue = c.date && c.date < t;
    return `<div class="card${overdue ? ' overdue' : ''}"><div class="row">
      <input type="checkbox" onchange="patch('commitments','${c.id}',{done:true})">
      <span class="title">${esc(c.title)}</span>
      <span class="meta">${c.person ? '👤 ' + esc(c.person) : ''}${c.date ? ' · 📅 ' + fmtDate(c.date) + (overdue ? ' ⚠️ vencido' : c.date === t ? ' ⏰ hoy' : '') : ''}</span>
      <button class="btn ghost small" title="Posponer 1 día" onclick="postponeCommit('${c.id}',1)">+1d</button>
      <button class="btn ghost small" title="Posponer 7 días" onclick="postponeCommit('${c.id}',7)">+7d</button>
      <button class="icon-btn" onclick="del('commitments','${c.id}')">🗑</button>
    </div></div>`;
  };
  return `
    <h2>🤝 Compromisos</h2>
    <p class="meta">Promesas a otras personas. Lo vencido avisa, lo cumplido suma por persona (+20 XP).</p>
    <div class="inline-add" style="margin-top:12px">
      <input type="text" id="c-title" placeholder="¿A qué te comprometiste?" onkeydown="if(event.key==='Enter')addCommit()">
      <input type="text" id="c-person" placeholder="¿Con quién?" style="width:130px">
      <input type="date" id="c-date">
      <button class="btn" onclick="addCommit()">Añadir</button>
    </div>
    ${persons.length ? `<div class="row chips-row">
      <button class="chip ${commitFilter === 'all' ? 'on' : ''}" onclick="setCommitFilter(-1)">Todos</button>
      ${persons.map((p, i) => `<button class="chip ${commitFilter === p ? 'on' : ''}" onclick="setCommitFilter(${i})">${esc(p)}</button>`).join('')}
    </div>` : ''}
    ${shown.map(card).join('') || '<p class="meta">Sin compromisos pendientes.</p>'}
    ${Object.keys(score).length ? `<h3>Cumplimiento por persona</h3>
      <ul class="hist-list">${Object.entries(score).sort().map(([p, s]) => `<li><span>👤 ${esc(p)}</span> ${s.done} cumplidos${s.total ? ` · ${s.total} pendientes` : ' · al día ✓'}</li>`).join('')}</ul>` : ''}
    ${D.commitments.filter(c => c.done).length ? `<h3>Cumplidos</h3>
      ${D.commitments.filter(c => c.done).map(c => `
        <div class="card done"><div class="row">
          <input type="checkbox" checked onchange="patch('commitments','${c.id}',{done:false})">
          <span class="title">${esc(c.title)}</span>
          <button class="icon-btn" onclick="del('commitments','${c.id}')">🗑</button>
        </div></div>`).join('')}` : ''}
  `;
}
window.setCommitFilter = function (i) { commitFilter = i < 0 ? 'all' : (window._persons || [])[i] || 'all'; render(); };
window.postponeCommit = async function (id, n) {
  const c = D.commitments.find(x => x.id === id);
  if (!c) return;
  const base = c.date && c.date >= today() ? c.date : today();
  await patch('commitments', id, { date: shiftDate(base, n) });
};
window.addCommit = async function () {
  const title = $('#c-title').value.trim();
  if (!title) return;
  await addItem('commitments', { title, person: $('#c-person').value.trim() || null, date: $('#c-date').value || null, done: false });
};

// ---------- Finanzas ----------
function viewFinances() {
  const f = D.finances;
  const spent = f.expenses.reduce((s, e) => s + e.amount, 0);
  const pct = f.monthlyBudget > 0 ? Math.min(100, Math.round(monthSpent / f.monthlyBudget * 100)) : 0;
  const month = today().slice(0, 7);
  const monthExpenses = f.expenses.filter(e => e.date.startsWith(month));
  const monthSpent = monthExpenses.reduce((s, e) => s + e.amount, 0);
  const byCat = {};
  for (const e of monthExpenses) byCat[e.category] = (byCat[e.category] || 0) + e.amount;
  const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const catMax = catEntries[0]?.[1] || 1;
  const limits = f.limits || {};
  return `
    <h2>💸 Finanzas</h2>
    <div class="finance-summary">
      <div class="stat-card"><div class="num">${f.monthlyBudget ? Math.max(0, f.monthlyBudget - monthSpent).toLocaleString() : '—'}</div><div class="lbl">Restante este mes</div></div>
      <div class="stat-card"><div class="num">${monthSpent.toLocaleString()}</div><div class="lbl">Gastado este mes</div></div>
    </div>
    <div class="inline-add">
      <input type="number" id="f-budget" placeholder="Presupuesto mensual" style="width:160px" value="${f.monthlyBudget || ''}">
      <button class="btn ghost" onclick="setBudget()">Fijar</button>
    </div>
    <div class="progress-bar"><div style="width:${pct}%"></div></div>
    <div class="meta">${pct}% del presupuesto del mes usado</div>
    ${catEntries.length ? `<h3>En qué gastas más</h3>
    <p class="meta">Top: <strong>${esc(catEntries[0][0])}</strong> $${catEntries[0][1].toLocaleString()} (${Math.round(catEntries[0][1] / monthSpent * 100)}% del mes)</p>
    <div class="catbars">${catEntries.map(([c, v]) => {
      const lim = limits[c];
      const over = lim != null && lim > 0 && v >= lim;
      const near = !over && lim != null && lim > 0 && v >= lim * 0.8;
      return `<div class="catbar-row"><span class="catbar-name">${esc(c)}</span>
        <div class="catbar-track"><div class="catbar-fill${over ? ' over' : ''}" style="width:${Math.max(3, Math.round(v / catMax * 100))}%"></div></div>
        <span class="catbar-amt">$${v.toLocaleString()}${over ? ' ⚠️' : near ? ' 👀' : ''}</span></div>`;
    }).join('')}</div>
    <h3>Límites por categoría</h3>
    <div class="limits-grid">${CATEGORIES.map(c => `<label>${esc(c)}<input type="number" min="0" placeholder="Sin límite" value="${limits[c] ?? ''}" onchange="setCatLimit('${c}',this.value)"></label>`).join('')}</div>
    <p class="meta">⚠️ = límite superado · 👀 = cerca del límite (80%).</p>` : '<p class="meta">Sin gastos este mes: el gráfico aparece solo.</p>'}
    <h3>Añadir gasto</h3>
    <div class="inline-add">
      <input type="number" id="e-amount" placeholder="Importe" style="width:110px">
      <select id="e-cat">${CATEGORIES.map(c => `<option>${c}</option>`).join('')}</select>
      <input type="text" id="e-desc" placeholder="Descripción" style="flex:1">
      <input type="date" id="e-date" value="${today()}">
      <button class="btn" onclick="addExpense()">Añadir</button>
    </div>
    ${monthExpenses.length ? `<h3>Gastos de ${new Date().toLocaleDateString('es', { month: 'long' })}</h3>
    <table><tr><th>Fecha</th><th>Categoría</th><th>Descripción</th><th class="amt">Importe</th><th></th></tr>
    ${monthExpenses.sort((a, b) => b.date.localeCompare(a.date)).map(e => `
      <tr><td>${fmtDate(e.date)}</td><td><span class="cat-chip">${esc(e.category)}</span></td><td>${esc(e.description)}</td><td class="amt">${e.amount.toLocaleString()}</td>
      <td><button class="icon-btn" onclick="delExpense('${e.id}')">🗑</button></td></tr>`).join('')}
    </table>` : '<p class="meta">Sin gastos registrados este mes.</p>'}
  `;
}
window.setBudget = async function () {
  const v = parseFloat($('#f-budget').value) || 0;
  D.finances.monthlyBudget = v;
  await fetch('/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ finances: D.finances }) });
  await reload();
};
window.addExpense = async function () {
  const amount = parseFloat($('#e-amount').value);
  if (!amount) return;
  D.finances.expenses.push({ id: uid(), date: $('#e-date').value || today(), category: $('#e-cat').value, description: $('#e-desc').value.trim(), amount });
  await fetch('/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ finances: D.finances }) });
  await reload();
};
window.setCatLimit = async function (cat, val) {
  const v = parseFloat(val);
  D.finances.limits = { ...(D.finances.limits || {}) };
  if (!v || v <= 0) delete D.finances.limits[cat]; else D.finances.limits[cat] = v;
  await putData({ finances: D.finances }, { silent: true });
  render();
};
window.delExpense = async function (id) {
  if (!confirm('¿Eliminar gasto?')) return;
  D.finances.expenses = D.finances.expenses.filter(e => e.id !== id);
  await fetch('/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ finances: D.finances }) });
  await reload();
};

// ---------- Aprendizaje ----------
function viewLearning() {
  const items = D.learning;
  const pomoSel = pomo.itemId || (items[0] && items[0].id);
  return `
    <h2>📚 Aprendizaje</h2>
    <p class="meta">Cursos, libros, idiomas, hobbies — con progreso medido en sesiones reales.</p>
    <div class="card pomo-card">
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
        <strong>⏱ Pomodoro (25/5)</strong>
        ${items.length ? `<select id="pomo-item" ${pomo.running ? 'disabled' : ''}>${items.map(l => `<option value="${l.id}" ${l.id === pomoSel ? 'selected' : ''}>${esc(l.title)}</option>`).join('')}</select>` : '<span class="meta">Añade un tema abajo para usar el temporizador.</span>'}
      </div>
      <div class="pomo-mid">
        <div class="pomo-time" id="pomoTime">${fmtClock(pomo.secs)}</div>
        <div class="row" style="gap:6px">
          <button class="chip ${pomo.mode === 'focus' ? 'on' : ''}" onclick="pomoMode('focus')">Enfoque</button>
          <button class="chip ${pomo.mode === 'brk' ? 'on' : ''}" onclick="pomoMode('brk')">Descanso</button>
        </div>
      </div>
      <div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
        <button class="btn" onclick="pomoToggle()" ${items.length ? '' : 'disabled'}>${pomo.running ? '⏸ Pausar' : '▶ Empezar'}</button>
        <button class="btn ghost" onclick="pomoReset()">Reiniciar</button>
        ${pomo.running ? '<span class="meta">Corre aunque cambies de pestaña.</span>' : '<span class="meta">Completar 25 min registra la sesión (+10 XP).</span>'}
      </div>
    </div>
    <div class="inline-add" style="margin-top:12px">
      <input type="text" id="l-title" placeholder="¿Qué quieres aprender?" onkeydown="if(event.key==='Enter')addLearn()">
      <select id="l-type"><option>curso</option><option>libro</option><option>idioma</option><option>hobby</option><option>otro</option></select>
      <select id="l-goal"><option value="ninguna">sin meta</option><option value="semanal">X por semana</option><option value="fecha">fecha límite</option></select>
      <button class="btn" onclick="addLearn()">Añadir</button>
    </div>
    ${items.map(l => `
      <div class="card">
        <div class="row">
          <span class="title">${esc(l.title)}</span>
          <span class="meta">${esc(l.type)}${l.goal !== 'ninguna' ? ' · 🎯 ' + l.goal : ''}</span>
          <button class="icon-btn" onclick="del('learning','${l.id}')">🗑</button>
        </div>
        <div class="progress-bar"><div style="width:${l.progress || 0}%"></div></div>
        <div class="row" style="margin-top:6px">
          <input type="range" min="0" max="100" step="5" value="${l.progress || 0}"
            oninput="this.nextElementSibling.textContent=this.value+'%'"
            onchange="patch('learning','${l.id}',{progress:+this.value})">
          <span class="meta" style="min-width:40px">${l.progress || 0}%</span>
          ${l.notes ? `<span class="meta">${esc(l.notes)}</span>` : ''}
        </div>
        <div class="meta" style="margin-top:6px">⏱ ${(l.sessions || []).length}/${l.targetSessions || 8} sesiones · ${(l.sessions || []).reduce((s, x) => s + (x.minutes || 0), 0)} min</div>
        <div class="row" style="margin-top:6px;gap:8px;flex-wrap:wrap">
          <label class="meta">Meta <input type="number" min="1" style="width:60px" value="${l.targetSessions || 8}" onchange="setLearnTarget('${l.id}',this.value)"> sesiones</label>
          <button class="btn ghost small" onclick="autoProgress('${l.id}')">≈ fijar avance por sesiones</button>
        </div>
        ${(l.sessions || []).length ? `<ul class="hist-list">${l.sessions.slice(-5).reverse().map(s => `<li><span>⏱ ${s.minutes} min</span> ${fmtDate(s.date)}</li>`).join('')}</ul>` : ''}
      </div>`).join('') || '<p class="meta">Añade tu primer curso o libro arriba.</p>'}
  `;
}
window.setLearnTarget = async function (id, v) {
  const l = D.learning.find(x => x.id === id);
  if (!l) return;
  l.targetSessions = Math.max(1, parseInt(v) || 8);
  await putData({ learning: D.learning }, { silent: true });
  render();
};
window.autoProgress = async function (id) {
  const l = D.learning.find(x => x.id === id);
  if (!l) return;
  const p = Math.min(100, Math.round((l.sessions || []).length / (l.targetSessions || 8) * 100));
  await patch('learning', id, { progress: p });
};
function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; o.type = 'sine';
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    o.start(); o.stop(ctx.currentTime + 0.65);
  } catch (_) {}
}
window.pomoToggle = function () {
  if (!D.learning.length) return;
  if (pomo.running) { pomo.running = false; clearInterval(pomo.timer); render(); return; }
  const sel = $('#pomo-item'); if (sel) pomo.itemId = sel.value;
  if (pomo.secs <= 0) pomo.secs = POMO_LEN[pomo.mode];
  pomo.running = true;
  clearInterval(pomo.timer);
  pomo.timer = setInterval(pomoTick, 1000);
  render();
};
function pomoTick() {
  pomo.secs--;
  const el = $('#pomoTime');
  if (el) el.textContent = fmtClock(pomo.secs);
  if (pomo.secs <= 0) pomoFinish();
}
async function pomoFinish() {
  clearInterval(pomo.timer);
  pomo.running = false;
  beep();
  if (pomo.mode === 'focus') {
    const selVal = $('#pomo-item') ? $('#pomo-item').value : null;
    const l = D.learning.find(x => x.id === (selVal || pomo.itemId));
    if (l) {
      l.sessions = [...(l.sessions || []), { date: today(), minutes: 25 }];
      await putData({ learning: D.learning }, { silent: true });
    }
    pomo.mode = 'brk'; pomo.secs = POMO_LEN.brk;
  } else { pomo.mode = 'focus'; pomo.secs = POMO_LEN.focus; }
  render();
}
window.pomoReset = function () { clearInterval(pomo.timer); pomo.running = false; pomo.secs = POMO_LEN[pomo.mode]; render(); };
window.pomoMode = function (m) { clearInterval(pomo.timer); pomo.running = false; pomo.mode = m; pomo.secs = POMO_LEN[m]; render(); };
window.addLearn = async function () {
  const title = $('#l-title').value.trim();
  if (!title) return;
  await addItem('learning', { title, type: $('#l-type').value, goal: $('#l-goal').value, progress: 0 });
};

// ---------- Proyectos ----------
function viewProjects() {
  const items = D.projects;
  return `
    <h2>🚀 Proyectos</h2>
    <p class="meta">Cosas importantes con varios pasos — incluye esas actividades procrastinadas.</p>
    <div class="inline-add" style="margin-top:12px">
      <input type="text" id="p-title" placeholder="Nombre del proyecto" onkeydown="if(event.key==='Enter')addProject()">
      <select id="p-status"><option>activo</option><option>en pausa</option><option>idea</option><option>hecho</option></select>
      <button class="btn" onclick="addProject()">Añadir</button>
    </div>
    ${items.map(p => {
      const steps = p.steps || [];
      const doneN = steps.filter(s => s.done).length;
      return `
      <div class="card">
        <div class="row">
          <span class="title">${esc(p.title)}</span>
          <span class="cat-chip">${esc(p.status)}</span>
          <span class="meta">${doneN}/${steps.length} pasos</span>
          <button class="icon-btn" onclick="del('projects','${p.id}')">🗑</button>
        </div>
        ${p.description ? `<div class="meta" style="margin:6px 0">${esc(p.description)}</div>` : ''}
        <ul class="checklist">
          ${steps.map((s, i) => `
            <li class="${s.done ? 'done' : ''}" data-pid="${p.id}" data-sidx="${i}">
              <input type="checkbox" ${s.done ? 'checked' : ''} onchange="toggleStep(this)">
              <span>${esc(s.text)}</span>
            </li>`).join('')}
        </ul>
        <div class="new-step">
          <input type="text" placeholder="Nuevo paso" onkeydown="if(event.key==='Enter')addStep(this,'${p.id}')">
        </div>
      </div>`;
    }).join('') || '<p class="meta">Añade tu primer proyecto arriba.</p>'}
  `;
}
window.addProject = async function () {
  const title = $('#p-title').value.trim();
  if (!title) return;
  await addItem('projects', { title, description: '', status: $('#p-status').value, steps: [] });
};
window.toggleStep = async function (cb) {
  const li = cb.closest('li');
  const pid = li.dataset.pid, idx = +li.dataset.sidx;
  const p = D.projects.find(x => x.id === pid);
  p.steps[idx].done = cb.checked;
  await fetch('/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projects: D.projects }) });
  await reload();
};
window.addStep = async function (input, pid) {
  const text = input.value.trim();
  if (!text) return;
  const p = D.projects.find(x => x.id === pid);
  p.steps.push({ text, done: false });
  await fetch('/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projects: D.projects }) });
  await reload();
};

// ---------- Noticias ----------
let newsQ = '', newsRes = null, newsLoading = false, feedRes = null, feedLoading = false, feedOpen = null;
let digest = null, digestLoading = false, digestErr = '';
const NEWS_BTN_LABEL = '📰 Noticias';
function digestCount() { return (digest?.topics || []).reduce((n, g) => n + g.items.length, 0); }
// Aviso de titulares: la app lo pide al abrirse y también lo notifica (1 vez por día)
function updateNewsBadge() {
  const nb = $('nav button[data-tab="news"]');
  if (nb) nb.textContent = NEWS_BTN_LABEL + (digestCount() ? ` · ${digestCount()}` : '');
}
function notifyDigest() {
  if (!notifOn() || !digest?.topics?.length) return;
  try { if (localStorage.getItem('pout-digest-day') === digest.date) return; } catch (_) { return; }
  const lines = digest.topics.slice(0, 4).map(g => `• ${g.topic}: ${g.items[0].title}`);
  try {
    new Notification(`📰 Titulares de hoy · ${digestCount()} sobre tus temas`, { body: lines.join('\n') });
    localStorage.setItem('pout-digest-day', digest.date);
  } catch (_) {}
}
window.loadDigest = async function (force) {
  digestLoading = true;
  try { digest = await fetchJSON('/api/news/digest' + (force ? '?refresh=1' : '')); digestErr = ''; }
  catch (e) { digestErr = errMsg(e); }
  digestLoading = false;
  if (tab === 'news') render(); else updateNewsBadge();
  notifyDigest();
};
window.refreshDigest = async function () { await window.loadDigest(true); };
window.digestBrief = async function () {
  const out = $('#digestBriefOut');
  const items = (digest?.topics || []).flatMap(g => g.items.map(x => ({ title: x.title, source: x.outlet || x.src }))).slice(0, 20);
  if (!out || !items.length) return;
  out.hidden = false; out.className = 'ai-out loading'; out.textContent = '🧠 Resumiendo tus titulares... (1-3 min)';
  try {
    const r = await fetchJSON('/api/ai/advise', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'newsbrief', items }) });
    out.className = 'ai-out'; out.textContent = r.reply || r.error || 'Sin respuesta.';
  } catch (e) { out.className = 'ai-out'; out.textContent = 'Error: ' + errMsg(e); }
};
function digestHtml() {
  if (digestLoading && !digest) return '<strong>☀️ Titulares de hoy</strong><p class="meta">Buscando novedades de tus temas...</p>';
  if (digestErr) return `<strong>☀️ Titulares de hoy</strong><p class="meta">⚠️ ${esc(digestErr)}</p>`;
  if (!digest) return '<strong>☀️ Titulares de hoy</strong><p class="meta">Se preparan al abrir la app.</p>';
  if (!digest.topics?.length) return '<strong>☀️ Titulares de hoy</strong><p class="meta">Hoy no encontré titulares para tus temas. Probá buscar manualmente abajo.</p>';
  return `
    <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
      <strong>☀️ Titulares de hoy (${digestCount()})</strong>
      <span class="row" style="gap:6px">
        ${digest.cached ? '<span class="meta">ya generado hoy</span>' : '<span class="meta">recién generado</span>'}
        <button class="btn ghost small" onclick="refreshDigest()" ${digestLoading ? 'disabled' : ''}>🔄 Actualizar</button>
        <button class="btn ghost small" onclick="digestBrief()">🧠 Resumen con IA</button>
      </span>
    </div>
    ${digest.fallback ? '<p class="meta">Aún sin temas propios: sumá intereses abajo (o un aprendizaje / proyecto) y el resumen se personaliza.</p>' : ''}
    ${digest.topics.map(g => `
      <div style="margin-top:8px">
        <div class="meta" style="font-weight:700">${esc(g.topic)}</div>
        ${g.items.map(n => `<a class="digest-item" href="${esc(n.url)}" target="_blank" rel="noopener">
          <span class="news-title">${esc(n.title)}</span>
          <span class="meta">${esc(n.outlet || n.src)}${n.date ? ' · 📅 ' + esc(n.date) : ''}</span>
        </a>`).join('')}
      </div>`).join('')}
    <div id="digestBriefOut" class="ai-out" hidden></div>
  `;
}
function newsTopics() {
  const auto = [...(D.learning || []).map(l => l.title), ...(D.projects || []).filter(p => p.status !== 'hecho').map(p => p.title)];
  return { auto: [...new Set(auto.filter(Boolean))].slice(0, 12), interests: D.interests || [], feeds: D.newsFeeds || [] };
}
function viewNews() {
  const { auto, interests, feeds } = newsTopics();
  const chips = [...interests, ...auto.filter(a => !interests.includes(a))];
  return `
    <h2>📰 Centro de noticias</h2>
    <p class="meta">🇪🇸 Solo noticias en español, sobre lo que estás aprendiendo y construyendo. Fuentes gratuitas sin cuenta: Google Noticias, Bing Noticias y Wikipedia.</p>
    <div class="card due-panel">${digestHtml()}</div>
    <div class="card">
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
        <strong>🔎 Buscar</strong>
        ${newsRes ? `<span class="meta">actualizado ${esc(newsRes.updatedAt?.slice(0, 16).replace('T', ' ') || '')}${newsRes.cached ? ' · caché' : ''}</span>` : ''}
      </div>
      <div class="inline-add" style="margin-top:8px">
        <input type="text" id="n-q" placeholder="Ej: python, guitarra, running..." value="${esc(newsQ)}" onkeydown="if(event.key==='Enter')searchNews()">
        <button class="btn" onclick="searchNews()" ${newsLoading ? 'disabled' : ''}>${newsLoading ? 'Buscando...' : 'Buscar'}</button>
        ${newsRes?.items?.length ? '<button class="btn ghost" onclick="newsBrief()">🧠 Resumen con IA</button>' : ''}
      </div>
      ${chips.length ? `<div class="chips-row">${chips.map(c => `<button class="chip ${c === newsQ ? 'on' : ''}" onclick="searchNewsTopic('${esc(c).replace(/'/g, "&#39;")}')">${esc(c)}</button>`).join('')}</div>`
        : '<p class="meta">Añade aprendizajes, proyectos o intereses abajo y aparecerán aquí como temas.</p>'}
      <div id="briefOut" class="ai-out" hidden></div>
      <div id="newsOut" style="margin-top:8px">
        ${newsLoading ? '<p class="meta">🔎 Buscando en español en Google Noticias, Bing Noticias y Wikipedia...</p>' : ''}
        ${newsRes?.error ? `<p class="meta">⚠️ ${esc(newsRes.error)}</p>` : ''}
        ${newsRes && !newsRes.error ? newsCards(newsRes.items) : (newsLoading || newsQ ? '' : '<p class="meta">Toca un tema o busca algo para ver novedades.</p>')}
      </div>
    </div>
    <div class="card">
      <strong>⭐ Mis intereses</strong>
      <div class="inline-add" style="margin-top:8px">
        <input type="text" id="n-interest" placeholder="Ej: ciclismo, IA, cocina..." onkeydown="if(event.key==='Enter')addInterest()">
        <button class="btn" onclick="addInterest()">Añadir</button>
      </div>
      ${(interests.length ? `<div class="chips-row">${interests.map(i => `<span class="chip on">${esc(i)} <button class="icon-btn" onclick="delInterest('${esc(i).replace(/'/g, "&#39;")}')" title="Quitar">×</button></span>`).join('')}</div>` : '<p class="meta">Sin intereses todavía.</p>')}
    </div>
    <div class="card">
      <strong>📡 Feeds RSS que sigo</strong>
      <p class="meta">Añade el RSS de cualquier blog o medio en español sobre tus hobbies y léelo sin salir de la app. Estos feeds se muestran tal cual los publique el medio, en su idioma original.</p>
      <div class="inline-add" style="margin-top:8px">
        <input type="text" id="n-feed-name" placeholder="Nombre" style="max-width:160px">
        <input type="text" id="n-feed-url" placeholder="https://.../feed.xml" onkeydown="if(event.key==='Enter')addFeed()">
        <button class="btn" onclick="addFeed()">Seguir</button>
      </div>
      ${feeds.length ? feeds.map(f => `
        <div class="row" style="justify-content:space-between;margin-top:6px">
          <span>📡 <strong>${esc(f.name)}</strong> <span class="meta">${esc(f.url.slice(0, 50))}${f.url.length > 50 ? '…' : ''}</span></span>
          <span class="row" style="gap:6px">
            <button class="btn ghost small" onclick="readFeed('${f.id}')">Leer</button>
            <button class="icon-btn" onclick="delFeed('${f.id}')">🗑</button>
          </span>
        </div>
        ${feedOpen === f.id ? `<div style="margin-top:6px">${feedLoading ? '<p class="meta">Leyendo feed...</p>' : (feedRes?.error ? `<p class="meta">⚠️ ${esc(feedRes.error)}</p>` : (feedRes ? newsCards(feedRes.items) : ''))}</div>` : ''}
      `).join('') : '<p class="meta">No sigues ningún feed todavía.</p>'}
    </div>
  `;
}
// Los errores del servidor llegan como JSON en texto: extrae el mensaje legible
function errMsg(e) {
  const raw = String(e?.message || e);
  try { const j = JSON.parse(raw); if (j.error) return j.error; } catch (_) {}
  return raw;
}
function newsIcon(src) {
  return src === 'Google Noticias' ? '🔎' : src === 'Bing Noticias' ? '🔵' : src === 'Wikipedia' ? '📖' : '📡';
}
function newsCards(items) {
  if (!items?.length) return '<p class="meta">Sin resultados en español para esa búsqueda. Prueba con una palabra más general (ej: guitarra, running, cocina, python).</p>';
  const bySrc = {};
  for (const it of items) (bySrc[it.src || 'RSS'] = bySrc[it.src || 'RSS'] || []).push(it);
  return Object.entries(bySrc).map(([src, list]) => `
    <h3 style="margin:10px 0 6px">${newsIcon(src)} ${esc(src)} (${list.length})</h3>
    <div class="news-grid">${list.slice(0, 12).map(n => `
      <a class="news-card" href="${esc(n.url)}" target="_blank" rel="noopener">
        <div class="news-title">${esc(n.title)}</div>
        ${n.snippet ? `<div class="meta">${esc(n.snippet)}</div>` : ''}
        ${(n.outlet || n.date) ? `<div class="meta">${esc(n.outlet || '')}${n.outlet && n.date ? ' · ' : ''}${n.date ? '📅 ' + esc(n.date) : ''}</div>` : ''}
      </a>`).join('')}</div>
  `).join('');
}
window.searchNewsTopic = async function (t) { $('#n-q').value = t; await searchNews(); };
window.searchNews = async function () {
  const q = ($('#n-q').value || '').trim();
  if (!q) return;
  newsQ = q; newsLoading = true; newsRes = null; render();
  try { newsRes = await fetchJSON('/api/news?q=' + encodeURIComponent(q)); }
  catch (e) { newsRes = { items: [], error: errMsg(e) }; }
  newsLoading = false; render();
};
window.newsBrief = async function () {
  const out = $('#briefOut');
  if (!out || !newsRes?.items?.length) return;
  out.hidden = false; out.className = 'ai-out loading'; out.textContent = '🧠 Resumiendo titulares... (1-3 min)';
  try {
    const res = await fetchJSON('/api/ai/advise', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'newsbrief', items: newsRes.items.slice(0, 20).map(x => ({ title: x.title, source: x.outlet || x.src })) }) });
    out.className = 'ai-out';
    out.textContent = res.reply || res.error || 'Sin respuesta.';
  } catch (e) { out.className = 'ai-out'; out.textContent = 'Error: ' + e.message; }
};
window.addInterest = async function () {
  const v = ($('#n-interest').value || '').trim().slice(0, 60);
  if (!v) return;
  const cur = D.interests || [];
  if (cur.includes(v)) return;
  D.interests = [...cur, v];
  await putData({ interests: D.interests }, { silent: true });
};
window.delInterest = async function (v) {
  D.interests = (D.interests || []).filter(x => x !== v);
  await putData({ interests: D.interests }, { silent: true });
};
window.addFeed = async function () {
  const name = ($('#n-feed-name').value || '').trim().slice(0, 60);
  const url = ($('#n-feed-url').value || '').trim();
  if (!name || !/^https?:\/\//i.test(url)) { alert('Pon un nombre y una URL válida (https://...)'); return; }
  D.newsFeeds = [...(D.newsFeeds || []), { id: uid(), name, url }];
  await putData({ newsFeeds: D.newsFeeds }, { silent: true });
};
window.delFeed = async function (id) {
  if (!confirm('¿Dejar de seguir este feed?')) return;
  D.newsFeeds = (D.newsFeeds || []).filter(f => f.id !== id);
  await putData({ newsFeeds: D.newsFeeds }, { silent: true });
};
window.readFeed = async function (id) {
  const f = (D.newsFeeds || []).find(x => x.id === id);
  if (!f) return;
  feedOpen = id; feedLoading = true; feedRes = null; render();
  try { feedRes = await fetchJSON('/api/news/feed?url=' + encodeURIComponent(f.url)); }
  catch (e) { feedRes = { items: [], error: errMsg(e) }; }
  feedLoading = false; render();
};

// ---------- Logros ----------
function viewRewards() {
  setTimeout(loadRewards, 0);
  return `<h2>🏆 Logros</h2><div id="rewardsBox"><p class="meta">Cargando tus logros...</p></div>`;
}
window.loadRewards = async function () {
  const box = $('#rewardsBox');
  if (!box) return;
  try {
    const r = await fetchJSON('/api/rewards');
    const pct = Math.round(r.hero.xpInLevel / r.hero.xpToNext * 100);
    const unlocked = r.badges.filter(b => b.at);
    box.innerHTML = `
      <div class="card hero-card">
        <div class="lvl-circle">Nv ${r.hero.level}</div>
        <div class="hero-info">
          <strong>${esc(r.hero.name)}</strong>
          <div class="meta">${r.hero.totalXp} XP totales · 🔥 racha ${r.hero.streak} día${r.hero.streak === 1 ? '' : 's'}</div>
          <div class="meta">${r.hero.freeze?.available ? '❄️ Streak Freeze disponible: te perdona 1 día en blanco esta semana' : '❄️ Streak Freeze usado esta semana'}</div>
          <div class="progress-bar"><div style="width:${pct}%"></div></div>
          <div class="meta">${r.hero.xpInLevel}/${r.hero.xpToNext} XP para el nivel ${r.hero.level + 1}</div>
        </div>
      </div>
      <h3>Insignias (${unlocked.length}/${r.badges.length})</h3>
      <div class="badges-grid">
        ${r.badges.map(b => `<div class="badge ${b.at ? '' : 'locked'}" title="${esc(b.desc)}${b.at ? ' · ' + fmtDate(b.at) : ''}">
          <div class="bem">${b.at ? b.emoji : '🔒'}</div>
          <div class="bname">${esc(b.name)}</div>
          <div class="meta">${esc(b.desc)}</div>
        </div>`).join('')}
      </div>
      <h3>Actividad reciente</h3>
      ${r.history.length ? `<ul class="hist-list">${r.history.map(h => `<li><span>⭐ +${h.xp}</span> ${esc(h.title || h.action)} <span class="meta">${fmtDate(h.date)}</span></li>`).join('')}</ul>` : '<p class="meta">Completa tareas, ejercicios o hábitos para ganar XP.</p>'}
    `;
  } catch (e) { box.innerHTML = '<p class="meta">No se pudieron cargar los logros.</p>'; }
};

// ---------- Eventos globales ----------
function bind() {
  // clicks en días del calendario de hábitos
  $$('.cal-day[data-habit]').forEach(el => {
    el.onclick = async () => {
      const h = D.habits.find(x => x.id === el.dataset.habit);
      if (!h || el.dataset.date > today()) return;
      const log = toggleHabit(h, el.dataset.date);
      await patch('habits', h.id, { log });
    };
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  $$('.themeToggle, nav button, #themeToggle').forEach(() => {}); // noop
  // Tema
  const syncThemeIcon = () => {
    const btn = $('#themeToggle');
    if (btn) btn.textContent = document.body.classList.contains('dark') ? '☀️' : '🌙';
  };
  $('#themeToggle').onclick = () => {
    document.body.classList.toggle('dark');
    localStorage.setItem('vida-theme', document.body.classList.contains('dark') ? 'dark' : 'light');
    syncThemeIcon();
  };
  if (localStorage.getItem('vida-theme') === 'dark') document.body.classList.add('dark');
  syncThemeIcon();
  // Tabs
  $$('nav button').forEach(b => b.onclick = () => {
    $$('.t-tab').forEach(() => {});
    $$('nav button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    tab = b.dataset.tab;
    render();
  });
  // Exportar
  $('#exportBtn').onclick = () => { location.href = '/api/export'; };
  // Bloqueo con PIN
  $('#lockBtn').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/login.html'; };
  $('#pinBtn').onclick = () => { location.href = '/login.html'; };
  // Guardado en vivo de mediciones del día
  document.body.addEventListener('change', e => { /* delegado por handlers inline */ });
  await reload();
  // Titulares del día: se piden al abrir la app (y se notifican una vez por día)
  updateNewsBadge();
  window.loadDigest();
});

// PWA: registra el service worker para que el navegador ofrezca "Instalar app"
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
