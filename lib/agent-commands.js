'use strict';
// Comandos atómicos para el agente externo (Jarvis).
// Cada comando muta el documento de datos recibido y devuelve { data, game, say, ui, event }.
// No conoce HTTP: el servidor se encarga de autenticación, idempotencia, undo y eventos.

const AREAS = ['personal', 'casa', 'trabajo', 'salud', 'finanzas', 'social'];
const PRIORITIES = ['alta', 'media', 'baja'];
const CATEGORIES = ['Comida', 'Transporte', 'Casa', 'Salud', 'Ocio', 'Suscripciones', 'Otros'];
const HABIT_ICONS = ['habits', 'health', 'tasks', 'water', 'book', 'target', 'body', 'sparkle', 'leaf', 'paw', 'mountain', 'music', 'flower'];
const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snacks', 'supper', 'extra'];
const TABS = ['tasks', 'habits', 'health', 'meals', 'shopping', 'commitments', 'finances', 'learning', 'projects', 'news', 'rewards'];
const TAB_LABEL = {
  tasks: 'tareas', habits: 'hábitos', health: 'salud', meals: 'alimentación',
  shopping: 'supermercado', commitments: 'compromisos', finances: 'finanzas',
  learning: 'aprendizaje', projects: 'proyectos', news: 'noticias', rewards: 'logros',
};
// Mismos valores que GAME en server.js: la recompensa se calcula acá porque el comando
// muta el documento directamente (no pasa por handleHeroPatch/handleDataPut).
const XP = {
  tasks: { alta: 25, media: 15, baja: 10 },
  habits: 10,
  commitments: 20,
  projects: 15,
  routine: 15,
  meals: 5,
  water: 1,
};

const COMMANDS = [
  { name: 'status.today', args: {}, desc: 'Resumen del día: vencidas, hoy, hábitos pendientes, citas, racha y nivel' },
  { name: 'catalog', args: {}, desc: 'Lista de comandos disponibles' },
  { name: 'tasks.list', args: { filter: 'today|overdue|open|done', limit: 'number' }, desc: 'Lista tareas' },
  { name: 'tasks.add', args: { title: 'string', area: AREAS.join('|'), due: 'YYYY-MM-DD', priority: PRIORITIES.join('|') }, desc: 'Crea una tarea' },
  { name: 'tasks.update', args: { id: 'string', match: 'string', patch: 'object' }, desc: 'Edita título, área, fecha o prioridad' },
  { name: 'tasks.complete', args: { id: 'string', match: 'string' }, desc: 'Marca una tarea como hecha (da XP)' },
  { name: 'tasks.uncomplete', args: { id: 'string', match: 'string' }, desc: 'Desmarca una tarea' },
  { name: 'tasks.remove', args: { id: 'string', match: 'string', confirm: 'true' }, desc: 'Borra una tarea (requiere confirm)' },
  { name: 'habits.list', args: {}, desc: 'Lista hábitos con su racha' },
  { name: 'habits.check', args: { id: 'string', match: 'string', date: 'YYYY-MM-DD', value: 'boolean' }, desc: 'Marca/desmarca un hábito (da XP)' },
  { name: 'habits.add', args: { name: 'string', icon: HABIT_ICONS.join('|'), targetPerWeek: '1-7' }, desc: 'Crea un hábito' },
  { name: 'meals.log', args: { date: 'YYYY-MM-DD', slot: MEAL_SLOTS.join('|'), text: 'string' }, desc: 'Anota una comida' },
  { name: 'water.add', args: { glasses: '1-8', date: 'YYYY-MM-DD' }, desc: 'Suma vasos de agua (tope 8/día)' },
  { name: 'shopping.add', args: { name: 'string', qty: 'number' }, desc: 'Agrega a la lista del súper' },
  { name: 'shopping.check', args: { id: 'string', match: 'string' }, desc: 'Marca comprado' },
  { name: 'expenses.add', args: { amount: 'number', category: CATEGORIES.join('|'), description: 'string', date: 'YYYY-MM-DD' }, desc: 'Registra un gasto' },
  { name: 'expenses.remove', args: { id: 'string', confirm: 'true' }, desc: 'Borra un gasto (requiere confirm)' },
  { name: 'commitments.add', args: { title: 'string', person: 'string', date: 'YYYY-MM-DD', notes: 'string' }, desc: 'Crea un compromiso' },
  { name: 'commitments.complete', args: { id: 'string', match: 'string' }, desc: 'Cumple un compromiso (da XP)' },
  { name: 'appointments.add', args: { title: 'string', date: 'YYYY-MM-DD', place: 'string', notes: 'string' }, desc: 'Agrega una cita de salud' },
  { name: 'projects.add', args: { title: 'string', description: 'string' }, desc: 'Crea un proyecto' },
  { name: 'projects.step.add', args: { project: 'string', text: 'string' }, desc: 'Agrega un paso a un proyecto' },
  { name: 'projects.step.check', args: { project: 'string', text: 'string' }, desc: 'Completa un paso (da XP)' },
  { name: 'learning.add', args: { title: 'string', type: 'string', goal: 'string' }, desc: 'Agrega un aprendizaje' },
  { name: 'learning.progress', args: { id: 'string', match: 'string', progress: '0-100' }, desc: 'Actualiza el avance (da XP por delta)' },
  { name: 'health.measure', args: { weight: 'number', sleep: 'number', mood: 'number', notes: 'string', date: 'YYYY-MM-DD' }, desc: 'Registra peso/sueño/ánimo' },
  { name: 'routine.complete', args: { day: '0-6', exercise: 'string' }, desc: 'Marca un ejercicio de la rutina (da XP)' },
  { name: 'rewards.status', args: {}, desc: 'Nivel, XP, racha e insignias' },
  { name: 'coach.advise', args: { kind: 'strategy|coach|diet|plan' }, desc: 'Consejo de la IA con el contexto real' },
  { name: 'news.digest', args: {}, desc: 'Resumen de titulares del día' },
  { name: 'nav.open', args: { tab: TABS.join('|') }, desc: 'Cambia la sección visible de la app' },
  { name: 'pomodoro.start', args: { minutes: '1-180', label: 'string' }, desc: 'Inicia un pomodoro en la UI' },
  { name: 'pomodoro.stop', args: {}, desc: 'Detiene el pomodoro' },
  { name: 'undo', args: { undoToken: 'string' }, desc: 'Revierte el último comando (30 s)' },
];

function fail(status, error, extra) {
  const e = new Error(error);
  e.status = status;
  e.extra = extra || null;
  throw e;
}

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function asText(v, field, { max = 200, required = true } = {}) {
  const s = String(v == null ? '' : v).trim();
  if (!s) {
    if (required) fail(422, `Falta ${field}`, { field });
    return '';
  }
  return s.slice(0, max);
}

function asDate(v, field = 'date') {
  if (v == null || v === '') return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) {
    fail(422, `${field} inválido (YYYY-MM-DD)`, { field });
  }
  return s;
}

function asNumber(v, field, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) fail(422, `${field} debe ser numérico`, { field });
  return Math.max(min, Math.min(max, n));
}

function pick(list, args, field = 'title') {
  const items = Array.isArray(list) ? list : [];
  if (args.id) {
    const it = items.find(x => x.id === args.id);
    if (!it) fail(404, 'No lo encontré', { id: args.id });
    return it;
  }
  const q = norm(args.match);
  if (!q) fail(422, 'Falta id o match', { field: 'match' });
  let hits = items.filter(x => norm(x[field] != null ? x[field] : x.name).includes(q));
  if (!hits.length) {
    const words = q.split(/\s+/).filter(w => w.length > 2);
    if (words.length > 1) hits = items.filter(x => {
      const t = norm(x[field] != null ? x[field] : x.name);
      return words.every(w => t.includes(w));
    });
  }
  if (!hits.length) fail(404, 'No lo encontré', { match: args.match });
  if (hits.length > 1) {
    fail(409, 'Es ambiguo: decime cuál', {
      candidates: hits.slice(0, 5).map(x => ({ id: x.id, title: x.title || x.name || '' })),
    });
  }
  return hits[0];
}

// Acepta `match` o el nombre natural del ítem (name/title/exercise) para que la voz
// no tenga que hablar en jerga de API: "marcá leer" funciona.
function target(args, ...fallbacks) {
  const direct = args.match != null && args.match !== '' ? args.match : null;
  const alias = fallbacks.map(k => args[k]).find(v => v != null && v !== '');
  return { id: args.id, match: direct || alias || '' };
}

function requireConfirm(args, what) {
  if (args.confirm !== true) fail(422, `Confirmá antes de ${what}`, { field: 'confirm' });
}

function nowIso() { return new Date().toISOString(); }

function habitStreak(h, todayKey) {
  let streak = 0;
  const d = new Date(todayKey + 'T12:00:00Z');
  const key = (x) => x.toISOString().slice(0, 10);
  if (!h.log?.[key(d)]) d.setUTCDate(d.getUTCDate() - 1);
  while (h.log?.[key(d)]) { streak++; d.setUTCDate(d.getUTCDate() - 1); }
  return streak;
}

function slimTask(t) {
  return { id: t.id, title: t.title, due: t.due || null, priority: t.priority || 'media', area: t.area || 'personal', done: !!t.done };
}

// kind: 'status.today'
function todaySummary(D, today) {
  const tasks = Array.isArray(D.tasks) ? D.tasks : [];
  const overdue = tasks.filter(t => !t.done && t.due && t.due < today);
  const dueToday = tasks.filter(t => !t.done && t.due === today);
  const habitsPending = (Array.isArray(D.habits) ? D.habits : []).filter(h => !h.log?.[today]);
  const commits = (Array.isArray(D.commitments) ? D.commitments : []).filter(c => !c.done && c.date && c.date <= today);
  const appts = (Array.isArray(D.appointments) ? D.appointments : []).filter(a => !a.done && a.date && a.date <= today);
  const hero = D.hero || {};
  const n = overdue.length + dueToday.length;
  const bits = [`${n} tarea${n === 1 ? '' : 's'} para hoy`];
  if (habitsPending.length) bits.push(`${habitsPending.length} hábito${habitsPending.length === 1 ? '' : 's'} pendiente${habitsPending.length === 1 ? '' : 's'}`);
  if (appts.length) bits.push(`${appts.length} cita${appts.length === 1 ? '' : 's'}`);
  if (commits.length) bits.push(`${commits.length} compromiso${commits.length === 1 ? '' : 's'}`);
  return {
    data: {
      date: today,
      tasks: { overdue: overdue.map(slimTask), today: dueToday.map(slimTask) },
      habitsPending: habitsPending.map(h => ({ id: h.id, name: h.name })),
      appointments: appts.map(a => ({ id: a.id, title: a.title, date: a.date })),
      commitments: commits.map(c => ({ id: c.id, title: c.title, date: c.date, person: c.person || '' })),
      hero: { level: hero.level || 1, streak: hero.streak || 0, xpInLevel: hero.xpInLevel || 0, xpToNext: hero.xpToNext || 100 },
    },
    say: bits.join(', ') + '.',
  };
}

async function run(name, rawArgs, ctx) {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  const D = ctx.data;
  const today = ctx.todayKey();

  switch (name) {
    // ===== Estado / descubrimiento =====
    case 'status.today':
      return todaySummary(D, today);

    case 'catalog':
      return { data: { commands: COMMANDS }, say: `Tengo ${COMMANDS.length} comandos disponibles.` };

    // ===== Tareas =====
    case 'tasks.list': {
      const all = Array.isArray(D.tasks) ? D.tasks : [];
      const filter = String(args.filter || 'today');
      let list;
      if (filter === 'overdue') list = all.filter(t => !t.done && t.due && t.due < today);
      else if (filter === 'open') list = all.filter(t => !t.done);
      else if (filter === 'done') list = all.filter(t => t.done);
      else if (filter === 'today') list = all.filter(t => !t.done && t.due && t.due <= today);
      else fail(422, 'filter inválido', { field: 'filter' });
      const limit = Math.max(1, Math.min(100, parseInt(args.limit, 10) || 20));
      const items = list.slice(0, limit).map(slimTask);
      return { data: { filter, total: list.length, items }, say: `${list.length} tarea${list.length === 1 ? '' : 's'}.` };
    }

    case 'tasks.add': {
      const title = asText(args.title, 'title');
      const area = args.area == null ? 'personal' : String(args.area);
      if (!AREAS.includes(area)) fail(422, 'area inválida', { field: 'area' });
      const priority = args.priority == null ? 'media' : String(args.priority);
      if (!PRIORITIES.includes(priority)) fail(422, 'priority inválida', { field: 'priority' });
      const due = asDate(args.due, 'due');
      if (!Array.isArray(D.tasks)) D.tasks = [];
      const item = { id: ctx.uid(), title, area, due, priority, done: false, createdAt: nowIso() };
      D.tasks.push(item);
      ctx.save();
      const when = due === today ? ' para hoy' : due ? ` para el ${due}` : '';
      return { data: item, say: `Anotado: ${title}${when}.`, ui: { tab: 'tasks', highlight: item.id } };
    }

    case 'tasks.update': {
      const item = pick(D.tasks, args);
      const patch = args.patch && typeof args.patch === 'object' ? args.patch : {};
      const allowed = ['title', 'area', 'due', 'priority'];
      for (const k of Object.keys(patch)) {
        if (!allowed.includes(k)) continue;
        if (k === 'title') item.title = asText(patch.title, 'title');
        else if (k === 'area') {
          if (!AREAS.includes(String(patch.area))) fail(422, 'area inválida', { field: 'area' });
          item.area = String(patch.area);
        } else if (k === 'priority') {
          if (!PRIORITIES.includes(String(patch.priority))) fail(422, 'priority inválida', { field: 'priority' });
          item.priority = String(patch.priority);
        } else item.due = asDate(patch.due, 'due');
      }
      ctx.save();
      return { data: item, say: 'Actualizado.', ui: { tab: 'tasks', highlight: item.id } };
    }

    case 'tasks.complete': {
      const item = pick(D.tasks, args);
      if (item.done) return { data: item, game: null, say: 'Ya estaba hecha.', ui: { tab: 'tasks', highlight: item.id } };
      item.done = true;
      const xp = XP.tasks[item.priority] != null ? XP.tasks[item.priority] : XP.tasks.media;
      const game = ctx.grantXp('tasks', { xp, title: item.title });
      ctx.save();
      return { data: item, game, say: `Hecho: ${item.title}.`, ui: { tab: 'tasks', highlight: item.id } };
    }

    case 'tasks.uncomplete': {
      const item = pick(D.tasks, args);
      item.done = false;
      ctx.save();
      return { data: item, say: `Desmarqué: ${item.title}.`, ui: { tab: 'tasks', highlight: item.id } };
    }

    case 'tasks.remove': {
      requireConfirm(args, 'borrar la tarea');
      const item = pick(D.tasks, args);
      D.tasks = D.tasks.filter(t => t.id !== item.id);
      ctx.save();
      return { data: { id: item.id }, say: `Borré: ${item.title}.`, ui: { tab: 'tasks' } };
    }

    // ===== Hábitos =====
    case 'habits.list': {
      const items = (Array.isArray(D.habits) ? D.habits : []).map(h => ({
        id: h.id, name: h.name, icon: h.emoji || 'habits',
        targetPerWeek: h.targetPerWeek || 7, doneToday: !!h.log?.[today], streak: habitStreak(h, today),
      }));
      return { data: items, say: `${items.length} hábito${items.length === 1 ? '' : 's'}.` };
    }

    case 'habits.check': {
      const h = pick(D.habits, target(args, 'name'), 'name');
      const date = asDate(args.date) || today;
      if (date > today) fail(422, 'No se pueden marcar días futuros', { field: 'date' });
      const value = args.value !== false;
      h.log = h.log && typeof h.log === 'object' ? h.log : {};
      const before = !!h.log[date];
      if (value) h.log[date] = 1;
      else delete h.log[date];
      const game = value && !before ? ctx.grantXp('habits', { xp: XP.habits, title: h.name }) : null;
      ctx.save();
      return {
        data: { id: h.id, name: h.name, date, done: value },
        game,
        say: value ? `Hecho: ${h.name}.` : `Desmarqué ${h.name}.`,
        ui: { tab: 'habits', highlight: h.id },
      };
    }

    case 'habits.add': {
      const name = asText(args.name, 'name', { max: 80 });
      const icon = args.icon == null ? 'habits' : String(args.icon);
      if (!HABIT_ICONS.includes(icon)) fail(422, 'icon inválido', { field: 'icon' });
      const targetPerWeek = Math.max(1, Math.min(7, parseInt(args.targetPerWeek, 10) || 7));
      if (!Array.isArray(D.habits)) D.habits = [];
      const item = { id: ctx.uid(), name, emoji: icon, targetPerWeek, log: {} };
      D.habits.push(item);
      ctx.save();
      return { data: item, say: `Hábito creado: ${name}.`, ui: { tab: 'habits', highlight: item.id } };
    }

    // ===== Comidas / agua =====
    case 'meals.log': {
      const date = asDate(args.date) || today;
      const slot = String(args.slot || '');
      if (!MEAL_SLOTS.includes(slot)) fail(422, 'slot inválido', { field: 'slot' });
      const text = asText(args.text, 'text', { max: 300 });
      if (!D.meals || typeof D.meals !== 'object') D.meals = {};
      D.meals[date] = { ...(D.meals[date] || {}), [slot]: text };
      const hasFood = MEAL_SLOTS.some(f => String(D.meals[date][f] || '').trim());
      let game = null;
      // ctx.grantXp se encarga de crear el héroe si falta; acá solo se ajusta el reloj del XP de comidas.
      if (hasFood && Date.now() - (D.hero?.lastMealXpAt || 0) > 3600_000) {
        game = ctx.grantXp('meals', { xp: XP.meals, title: 'Comidas del día' });
        if (D.hero) D.hero.lastMealXpAt = Date.now();
      }
      ctx.save();
      return { data: { date, slot, text }, game, say: 'Anotado en la alimentación.', ui: { tab: 'meals' } };
    }

    case 'water.add': {
      const date = asDate(args.date) || today;
      const glasses = Math.max(1, Math.min(8, parseInt(args.glasses, 10) || 1));
      if (!D.meals || typeof D.meals !== 'object') D.meals = {};
      const day = D.meals[date] = { ...(D.meals[date] || {}) };
      const before = Math.min(8, +day.water || 0);
      const gain = Math.max(0, Math.min(glasses, 8 - before));
      day.water = before + gain;
      const game = gain > 0 ? ctx.grantXp('water', { xp: gain * XP.water, title: `${gain} vaso${gain > 1 ? 's' : ''} de agua` }) : null;
      ctx.save();
      return {
        data: { date, water: day.water, added: gain },
        game,
        say: gain ? `${day.water} vasos hoy.` : 'Ya llegaste a 8 vasos hoy.',
        ui: { tab: 'meals' },
      };
    }

    // ===== Súper =====
    case 'shopping.add': {
      const name = asText(args.name, 'name', { max: 120 });
      const qty = args.qty == null ? 1 : Math.max(1, Math.min(99, parseInt(args.qty, 10) || 1));
      if (!Array.isArray(D.shopping)) D.shopping = [];
      const item = { id: ctx.uid(), name, qty, done: false, createdAt: nowIso() };
      D.shopping.push(item);
      ctx.save();
      return { data: item, say: `Agregado al súper: ${name}.`, ui: { tab: 'shopping', highlight: item.id } };
    }

    case 'shopping.check': {
      const item = pick(D.shopping, target(args, 'name'), 'name');
      item.done = true;
      ctx.save();
      return { data: item, say: `Comprado: ${item.name}.`, ui: { tab: 'shopping', highlight: item.id } };
    }

    // ===== Finanzas =====
    case 'expenses.add': {
      const amount = asNumber(args.amount, 'amount', { min: 0.01 });
      const category = args.category == null ? 'Otros' : String(args.category);
      if (!CATEGORIES.includes(category)) fail(422, 'category inválida', { field: 'category' });
      const description = asText(args.description, 'description', { max: 120, required: false });
      const date = asDate(args.date) || today;
      const f = D.finances = D.finances && typeof D.finances === 'object' ? D.finances : { monthlyIncome: 0, monthlyBudget: 0, expenses: [] };
      if (!Array.isArray(f.expenses)) f.expenses = [];
      const item = { id: ctx.uid(), date, category, description, amount };
      f.expenses.push(item);
      ctx.save();
      return { data: item, say: `Gasto de ${Math.round(amount)} en ${category}.`, ui: { tab: 'finances', highlight: item.id } };
    }

    case 'expenses.remove': {
      requireConfirm(args, 'borrar el gasto');
      const f = D.finances || {};
      const list = Array.isArray(f.expenses) ? f.expenses : [];
      const item = list.find(e => e.id === args.id);
      if (!item) fail(404, 'No lo encontré', { id: args.id || null });
      f.expenses = list.filter(e => e.id !== item.id);
      ctx.save();
      return { data: { id: item.id }, say: 'Gasto borrado.', ui: { tab: 'finances' } };
    }

    // ===== Compromisos =====
    case 'commitments.add': {
      const title = asText(args.title, 'title');
      const person = asText(args.person, 'person', { max: 80, required: false });
      const date = asDate(args.date);
      const notes = asText(args.notes, 'notes', { max: 300, required: false });
      if (!Array.isArray(D.commitments)) D.commitments = [];
      const item = { id: ctx.uid(), title, person, date, notes, done: false, createdAt: nowIso() };
      D.commitments.push(item);
      ctx.save();
      return { data: item, say: `Compromiso anotado: ${title}.`, ui: { tab: 'commitments', highlight: item.id } };
    }

    case 'commitments.complete': {
      const item = pick(D.commitments, args);
      if (item.done) return { data: item, game: null, say: 'Ya estaba cumplido.', ui: { tab: 'commitments', highlight: item.id } };
      item.done = true;
      const game = ctx.grantXp('commitments', { xp: XP.commitments, title: item.title });
      ctx.save();
      return { data: item, game, say: `Cumplido: ${item.title}.`, ui: { tab: 'commitments', highlight: item.id } };
    }

    // ===== Salud =====
    case 'appointments.add': {
      const title = asText(args.title, 'title');
      const date = asDate(args.date);
      const place = asText(args.place, 'place', { max: 120, required: false });
      const notes = asText(args.notes, 'notes', { max: 300, required: false });
      if (!Array.isArray(D.appointments)) D.appointments = [];
      const item = { id: ctx.uid(), title, date, place, notes, done: false, createdAt: nowIso() };
      D.appointments.push(item);
      ctx.save();
      return { data: item, say: `Cita agregada: ${title}${date ? ` el ${date}` : ''}.`, ui: { tab: 'health', highlight: item.id } };
    }

    case 'health.measure': {
      const date = asDate(args.date) || today;
      const entry = { date };
      if (args.weight != null) entry.weight = asNumber(args.weight, 'weight', { min: 20, max: 400 });
      if (args.sleep != null) entry.sleep = asNumber(args.sleep, 'sleep', { min: 0, max: 24 });
      if (args.mood != null) entry.mood = asNumber(args.mood, 'mood', { min: 1, max: 5 });
      if (args.notes != null) entry.notes = asText(args.notes, 'notes', { max: 300, required: false });
      if (Object.keys(entry).length === 1) fail(422, 'Falta al menos una medición', { field: 'weight' });
      if (!Array.isArray(D.measurements)) D.measurements = [];
      const ix = D.measurements.findIndex(m => m.date === date);
      if (ix >= 0) D.measurements[ix] = { ...D.measurements[ix], ...entry };
      else D.measurements.push(entry);
      ctx.save();
      return { data: entry, say: 'Medición guardada.', ui: { tab: 'health' } };
    }

    // ===== Proyectos =====
    case 'projects.add': {
      const title = asText(args.title, 'title');
      const description = asText(args.description, 'description', { max: 400, required: false });
      if (!Array.isArray(D.projects)) D.projects = [];
      const item = { id: ctx.uid(), title, description, status: 'active', steps: [], createdAt: nowIso() };
      D.projects.push(item);
      ctx.save();
      return { data: item, say: `Proyecto creado: ${title}.`, ui: { tab: 'projects', highlight: item.id } };
    }

    case 'projects.step.add': {
      const p = pick(D.projects, { id: args.project, match: args.project });
      const text = asText(args.text, 'text', { max: 160 });
      if (!Array.isArray(p.steps)) p.steps = [];
      p.steps.push({ text, done: false });
      ctx.save();
      return { data: { id: p.id, steps: p.steps }, say: `Paso agregado a ${p.title}.`, ui: { tab: 'projects', highlight: p.id } };
    }

    case 'projects.step.check': {
      const p = pick(D.projects, { id: args.project, match: args.project });
      const step = pick(p.steps || [], { match: args.text }, 'text');
      if (step.done) return { data: { id: p.id, step }, game: null, say: 'Ese paso ya estaba hecho.', ui: { tab: 'projects', highlight: p.id } };
      step.done = true;
      const game = ctx.grantXp('projects', { xp: XP.projects, title: step.text || p.title });
      ctx.save();
      return { data: { id: p.id, step }, game, say: `Paso completado: ${step.text}.`, ui: { tab: 'projects', highlight: p.id } };
    }

    // ===== Aprendizaje =====
    case 'learning.add': {
      const title = asText(args.title, 'title');
      const type = asText(args.type, 'type', { max: 60, required: false });
      const goal = asText(args.goal, 'goal', { max: 200, required: false });
      if (!Array.isArray(D.learning)) D.learning = [];
      const item = { id: ctx.uid(), title, type, goal, progress: 0, notes: '', sessions: [], createdAt: nowIso() };
      D.learning.push(item);
      ctx.save();
      return { data: item, say: `Aprendizaje agregado: ${title}.`, ui: { tab: 'learning', highlight: item.id } };
    }

    case 'learning.progress': {
      const item = pick(D.learning, target(args, 'title'));
      const progress = Math.round(asNumber(args.progress, 'progress', { min: 0, max: 100 }));
      const delta = progress - (item.progress || 0);
      item.progress = progress;
      const game = delta > 0
        ? ctx.grantXp('learning', { xp: Math.max(5, Math.min(30, Math.round(delta / 2))), title: item.title })
        : null;
      ctx.save();
      return { data: { id: item.id, progress }, game, say: `${item.title} al ${progress}%.`, ui: { tab: 'learning', highlight: item.id } };
    }

    // ===== Rutina =====
    case 'routine.complete': {
      const day = String(parseInt(args.day, 10));
      if (!/^[0-6]$/.test(day)) fail(422, 'day inválido (0=lunes … 6=domingo)', { field: 'day' });
      const list = Array.isArray(D.routine?.[day]) ? D.routine[day] : [];
      const ex = pick(list, { match: args.exercise }, 'name');
      if (ex.done) return { data: ex, game: null, say: 'Ese ejercicio ya estaba hecho.' };
      ex.done = true;
      ex.doneAt = today;
      const game = ctx.grantXp('routine', { xp: XP.routine, title: ex.name });
      ctx.save();
      return { data: ex, game, say: `Hecho: ${ex.name}.`, ui: { tab: 'health' } };
    }

    // ===== Logros =====
    case 'rewards.status':
      return { data: ctx.rewards(), say: `Nivel ${ctx.rewards().hero.level}, racha de ${ctx.rewards().hero.streak} días.` };

    // ===== IA / noticias =====
    case 'coach.advise': {
      const kind = String(args.kind || 'strategy');
      const reply = await ctx.aiAdvise(kind);
      return { data: { kind, reply }, say: 'Listo, te dejé la recomendación en pantalla.' };
    }

    case 'news.digest': {
      const digest = await ctx.digest();
      const count = (digest.topics || []).reduce((n, g) => n + (g.items || []).length, 0);
      return { data: digest, say: count ? `${count} titulares hoy.` : 'No encontré titulares nuevos.' };
    }

    // ===== UI =====
    case 'nav.open': {
      const tab = String(args.tab || '');
      if (!TABS.includes(tab)) fail(422, 'tab inválido', { field: 'tab' });
      return { data: { tab }, say: `Abriendo ${TAB_LABEL[tab]}.`, ui: { tab }, event: { name: 'nav', data: { tab } } };
    }

    case 'pomodoro.start': {
      const minutes = Math.max(1, Math.min(180, parseInt(args.minutes, 10) || 25));
      const label = asText(args.label, 'label', { max: 80, required: false });
      const endsAt = Date.now() + minutes * 60_000;
      return {
        data: { running: true, minutes, endsAt, label },
        say: `${minutes} minutos. A darle.`,
        event: { name: 'pomodoro', data: { running: true, endsAt, minutes, label } },
      };
    }

    case 'pomodoro.stop':
      return { data: { running: false }, say: 'Pomodoro detenido.', event: { name: 'pomodoro', data: { running: false } } };

    default:
      fail(400, 'comando desconocido', { commands: COMMANDS.map(c => c.name) });
  }
}

module.exports = { run, COMMANDS, TABS, HABIT_ICONS };
