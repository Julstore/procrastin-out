# Integración Jarvis ↔ procrastin-out

Documento de contrato técnico para el agente que está construyendo Jarvis.
Objetivo: que Jarvis pueda **leer y dirigir** la app por voz, y que ambos puedan
convivir escribiendo los mismos datos sin pisarse.

> Regla de oro: **Jarvis no manipula la UI ni el DOM.** Habla por HTTP con el
> servidor local de la app. La UI es solo un cliente más.

---

## 0. TL;DR para el agente

| Dato | Valor |
|---|---|
| Base URL (escritorio) | `http://127.0.0.1:4321` |
| Servidor | Node `http` puro, sin framework (`server.js`) |
| Estado | Un único objeto JSON, single-user (sin multiusuario, sin tenants) |
| Auth humana | PIN → cookie `pout_sess` (HttpOnly, SameSite=Lax) |
| Auth de agente | Token Bearer en `data/agent-token` (ver §5.1) |
| CORS | **No hay cabeceras CORS**: llamar desde Node/Python, no desde JS de otro origen |
| Fechas | `YYYY-MM-DD`, calculadas en **UTC** (`toISOString`) |
| Push de eventos | SSE en `GET /api/agent/events` (ver §5.4) |
| Puertos | 4321 fijo en escritorio; `PORT` configurable en servidor suelto |

Punto de entrada para escribir: **`POST /api/agent/command`** con token Bearer.
Todo lo demás (voz, HUD) se apoya en eso.

---

## 1. Qué es la app (contexto real)

`procrastin-out` es una app personal anti-procrastinación. Se ejecuta de tres formas:

1. **Escritorio (Electron)** — `main: electron/main.js`. Levanta `server.js` en
   `127.0.0.1:4321` y abre una `BrowserWindow` apuntando ahí. Datos en
   `%APPDATA%/procrastin-out/data/vida.json` (instalada) o `./data` (desarrollo).
2. **Servidor suelto** — `node server.js`, escucha en `HOST` (`0.0.0.0` por defecto)
   para usarse desde el celular en la misma WiFi.
3. **Nube opcional (Render)** — si existe `DATABASE_URL`, datos y PIN viven en
   Postgres (`pout_kv`), y las sesiones siguen en memoria.

**Consecuencia para Jarvis:** el caso soportado es el 1 (loopback). La variante
nube **no** debe recibir comandos de voz sin una capa de auth propia y explícita;
el PIN no es suficiente para un agente autónomo.

### 1.1 Secciones de la app (nombres canónicos de navegación)

`tasks`, `habits`, `health`, `meals`, `shopping`, `commitments`, `finances`,
`learning`, `projects`, `news`, `rewards`.

El cliente usa `document.body.dataset.tab` y `button[data-tab="..."]`. Para que la
UI cambie de sección por voz hace falta un comando (`nav.open`), **no** inyección
de JavaScript.

### 1.2 Identidad visual (para el HUD)

```css
--bg: #0D251C;      --bg-deep: #163A2B;   --card-solid: #122e23;
--ink: #FFFFFF;     --ink-soft: #E4F0E9;
--accent: #2E9D68;  --accent-hot: #4CC587;
```
Acentos por sección: tareas `#2E9D68`, hábitos `#E67E22`, salud `#3DA977`,
alimentación `#E67E22`, súper `#00A88A`, compromisos `#4AA8C9`, finanzas `#6FA056`,
aprendizaje `#4C9B8F`, proyectos `#B8814B`, noticias `#1CA08F`, logros `#E89A3C`.
La app también expone su "ambiente" (rojo→verde) en la variable `--mood`.

---

## 2. Arranque y autenticación (lo que ya existe)

### 2.1 Comprobar estado

```http
GET /api/auth/status
→ { "setup": true, "unlocked": false }
```

### 2.2 Login con PIN

```http
POST /api/auth/login
Content-Type: application/json

{ "pin": "1234" }

→ 200 { "ok": true }         con Set-Cookie: pout_sess=<64 hex>; HttpOnly; SameSite=Lax
→ 429 { "error": "Demasiados intentos. Espera N s" }
→ 401 { "error": "PIN incorrecto" }
```

Notas duras:
- **5 fallos por IP → bloqueo de 60 s.** El agente nunca debe reintentar a ciegas
  ni probar PINs: si falla, cortar y avisar.
- Hay un `delay` de 600 ms en cada fallo.
- Sesiones **en memoria**: `12 h` de inactividad y `7 días` de antigüedad máxima.
  **Reiniciar el servidor o la app invalida la sesión.** Jarvis debe detectar
  `401` y volver a autenticarse (o usar el token de agente, que no depende de eso).
- La cookie es `HttpOnly` y `SameSite=Lax`; guardarla en el cliente HTTP y
  reenviarla tal cual.
- En la nube (`PUBLIC_URL`/`RENDER_EXTERNAL_URL`) la cookie lleva `Secure`.

### 2.3 Sin sesión

Toda ruta que no sea `login.html` o asset público responde:
- API → `401 { "error": "No autenticado", "login": "/login.html" }`
- Página → `302` a `/login.html`

---

## 3. API existente (Parte A — no requiere cambios)

Todas las respuestas son JSON. Formato de error uniforme: `{ "error": "texto" }`
(HTTP 4xx/5xx). El `PUT /api/data` responde `200 { "ok": true, "game": ... }`.

### 3.1 Estado completo

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/data` | Devuelve el objeto completo (ver §4) |
| `PUT` | `/api/data` | **Merge superficial**: reemplaza las claves enviadas. Solo acepta claves de la whitelist |
| `GET` | `/api/export` | Igual que `/api/data` + `Content-Disposition` (respaldo descargable) |

Whitelist de `PUT /api/data`: todas las claves de §4 **excepto** `hero`, `version`,
`createdAt`, más `meds`, `routine`, `profile`, `interests`, `newsFeeds`.

⚠️ **`hero` (XP, nivel, insignias, racha) lo calcula solo el servidor.** Enviarlo
se ignora. Cualquier intento de "regalar" XP por API falla por diseño.

⚠️ **Semántica de reemplazo, no de parche:** `PUT { "tasks": [...] }` sustituye el
array entero. Si Jarvis leyó las tareas hace 5 minutos y hace PUT, **borra** lo
que el usuario agregó en la UI mientras tanto. Por eso la Parte B.

### 3.2 Colecciones (CRUD por ítem, sin pisar el resto)

Colecciones válidas: `tasks`, `weeks`, `habits`, `commitments`, `learning`,
`projects`, `appointments`, `wishlist`, `shopping`.
Además `meals`, `finances`, `measurements` se tratan como objetos mutables.

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `GET` | `/api/<coll>` | Array de ítems |
| `POST` | `/api/<coll>` | Ítem sin `id` → `200` con el ítem creado (`id` generado) |
| `PATCH` | `/api/<coll>/<id>` | Campos parciales → `200 { ...ítem, "game": {...} }` |
| `DELETE` | `/api/<coll>/<id>` | `200 { "ok": true }` |

`POST /api/finances` hace *merge* del objeto; si mandás `expenses`, completa los
`id` faltantes. Para borrar o editar un gasto no hay endpoint por ítem: se manda el
array completo en `PUT /api/data { "finances": { "expenses": [...] } }` (es lo que
hace la UI), o se usa el comando `expenses.remove` de la Parte B.

`game` es la recompensa devuelta por el servidor:
`{ xp, titles[], leveledUp, newLevel, newBadges[], freezeSaved }` o `null`.

### 3.3 Logros / XP

```http
GET /api/rewards
→ {
    "hero": { "name", "level", "xpInLevel", "xpToNext", "totalXp", "streak",
              "freeze": { "available": true, "week": "2026-W42" } },
    "badges": [ { "id", "emoji", "name", "desc", "at": "YYYY-MM-DD"|null } ],
    "history": [ { "date", "action", "xp", "title" } ]   // últimos 10
  }
```

XP por acción (referencia para el tono de Jarvis, no para calcularlo):

| Acción | XP |
|---|---|
| Tarea `alta` / `media` / `baja` | 25 / 15 / 10 |
| Check de hábito | 10 |
| Compromiso cumplido | 20 |
| Cita médica | 20 |
| Paso de proyecto | 15 |
| Aprendizaje | hasta 30 (proporcional) |
| Ejercicio de rutina | 15 |
| Comidas del día | 5 (máx 1/hora) |
| Vaso de agua | 1 (máx 8/día) |

Sube de nivel con `100 + (nivel-1)*50` XP. Racha: días con ≥ 20 XP; un hueco
semanal lo cubre el *Streak Freeze*.

### 3.4 IA (ya resuelta en el servidor)

```http
POST /api/ai/advise
{ "kind": "coach" | "diet" | "plan" | "workout" | "progress" | "calories"
        | "newsbrief" | "strategy",
  "date": "YYYY-MM-DD" }        // solo para "calories"
→ 200 { "reply": "texto" }  ó  200 { "error": "..." }
```

- Usa `OPENLLM_API_KEY` del `.env` del servidor (gateway OpenAI-compatible).
- Cuota diaria configurable por env; cachea por sesión. `GET /api/ai/usage` da
  consumo del día.
- `workout` y `progress` **escriben** `data.routine` directamente.
- `strategy` devuelve un plan del día en markdown con bullets `*`.

**Recomendación:** Jarvis no necesita otra API key de LLM para "qué hago hoy":
`kind: "strategy"` ya conoce tareas vencidas, hábitos flojos, compromisos y gastos.

### 3.5 Noticias

| Ruta | Uso |
|---|---|
| `GET /api/news?q=<tema>` | Búsqueda (Google/Bing RSS + Wikipedia ES), cache 15 min |
| `GET /api/news/digest[?refresh=1]` | Resumen diario |
| `GET /api/news/feed?url=<rss>` | RSS propio (valida que sea público, anti-SSRF) |

### 3.6 Red

```http
GET /api/lan
→ { "port": 4321, "ips": ["192.168.0.12"], "urls": ["http://192.168.0.12:4321"], "cloud": false }
```

---

## 4. Modelo de datos (contrato)

Un único objeto. Fechas `YYYY-MM-DD`. IDs `^[0-9a-zA-Z_-]{1,64}$`.

```jsonc
{
  "version": 1,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "hero": {                       // SOLO servidor
    "name": "Aventurero", "xp": 0, "totalXp": 0, "level": 1, "streak": 0,
    "badges": { "first-win": "2026-10-01" },
    "lastMealXpAt": 0,
    "freeze": { "week": "2026-W42", "used": false },
    "history": [ { "date": "2026-10-01", "action": "tasks", "xp": 25, "title": "..." } ]
  },

  "tasks": [ { "id", "title", "area", "due", "priority", "done", "createdAt" } ],
  // area: personal|casa|trabajo|salud|finanzas|social
  // priority: alta|media|baja

  "weeks": [ { "id", "title", "taskIds": [], "status": "active|done",
               "bonusGiven": false, "createdAt" } ],

  "habits": [ { "id", "name", "emoji", "targetPerWeek", "log": { "YYYY-MM-DD": 1 } } ],
  // emoji: en hábitos nuevos guarda el NOMBRE del icono, no un emoji.
  // Valores válidos: habits|health|tasks|water|book|target|body|sparkle|leaf|paw|mountain|music|flower
  // (los hábitos viejos con emoji real se siguen mostrando)

  "meals": { "YYYY-MM-DD": { "breakfast", "lunch", "dinner", "snacks", "supper",
                             "extra", "water": 0-8 } },

  "commitments": [ { "id", "title", "person", "date", "notes", "done", "createdAt" } ],
  "finances": { "monthlyIncome": 0, "monthlyBudget": 0,
                "expenses": [ { "id", "date", "category", "description", "amount" } ] },
  // category: Comida|Transporte|Casa|Salud|Ocio|Suscripciones|Otros

  "learning": [ { "id", "title", "type", "progress", "goal", "notes",
                  "sessions": [ ... ], "createdAt" } ],
  "projects": [ { "id", "title", "description", "status",
                  "steps": [ { "text", "done" } ], "createdAt" } ],
  "appointments": [ { "id", "title", "date", "place", "notes", "done", "createdAt" } ],
  "measurements": [ { "date", "weight", "sleep", "mood", "notes" } ],

  "routine": {                    // 0=lunes … 6=domingo
    "0": [ { "name": "Sentadillas 4x10", "done": false, "doneAt": null } ],
    "0_focus": "piernas"
  },
  "profile": { "heightCm", "weightKg", "age", "sex", "goalWeight", "activity" },
  "interests": [ "string" ],
  "newsFeeds": [ { "id", "name", "url" } ],
  "smoking": { "answered": false, "tobacco": false, "cannabis": false,
               "log": { "YYYY-MM-DD": { "cigarettes": 0, "joints": 0 } } },
  "wishlist": [ { "id", "title", "price", "priority", "bought", "boughtAt", "createdAt" } ],
  "shopping": [ { "id", "name", "qty", "done", "createdAt" } ],
  "meds": "texto libre",
  "aiUsage": { ... }              // SOLO servidor: cuota de IA
}
```

### 4.1 Gotchas que rompen integraciones

1. **Fechas en UTC.** `todayKey()` = `new Date().toISOString().slice(0,10)`. En
   Argentina (UTC−3), después de las 21:00 la app ya considera "mañana" otro día.
   Jarvis debe usar la misma regla o pedirle la fecha al servidor (`status.today`).
2. **`routine` empieza en lunes**: la clave `"0"` es lunes y `"6"` domingo
   (no es `getDay()`, que arranca en domingo). El sufijo `_focus` guarda el
   grupo muscular del día (ej. `"0_focus": "piernas"`).
3. **Hábitos:** el check es una clave en `log`; desmarcar no da XP y el servidor
   calcula la racha por día. No modifiques `log` de días futuros.
4. **`learning.progress`** acepta 0–100; el XP se otorga por el **delta**.
5. **No hay bloqueo optimista.** Todo es *last-write-wins* dentro de cada ítem.
6. **Guardado con debounce de 150 ms** en disco; no hay transacciones.

---

## 5. Parte B — Ya implementada en la app (contrato en uso)

Está implementada y cubierta por pruebas en `tests/agent-contract.test.js`
(29 pruebas). Jarvis solo tiene que consumirla tal como se describe acá.

### 5.1 Token de agente

**Cómo obtenerlo:** el servidor lo genera al arrancar la primera vez y lo guarda en
`agent-token`, dentro del directorio de datos de la app:
- Desarrollo / servidor suelto: `./data/agent-token`.
- App instalada (Electron): `%APPDATA%/procrastin-out/data/agent-token`.
- Se puede forzar uno propio con la variable de entorno `POUT_AGENT_TOKEN`.

Contenido: 64 caracteres hex (32 bytes). **Nunca se sirve por HTTP**: hay que leerlo
del sistema de archivos. Jarvis debería leerlo al arrancar y recargarlo si el
servidor responde 401 (puede haber rotado).

- Header: `Authorization: Bearer <token>`.
- Alcance: `/api/agent/*` completo, más **lectura** de `GET /api/data`,
  `/api/rewards`, `/api/<coll>`, `/api/news*`, `/api/ai/usage`, `/api/lan` y
  `/api/state/rev`. Las escrituras pasan **solo** por comandos: un `PUT /api/data`
  con token responde `401`.
- El token **no** abre páginas ni `/login.html`, no reemplaza al PIN y no sirve para
  `/api/auth/*`.
- Comparación con `crypto.timingSafeEqual`; 5 fallos de token por minuto bloquean
  con `429` durante ese minuto.
- Rotación: borrar el archivo y reiniciar el servidor. El agente deja auditoría en
  `data/agent.log` (JSONL: `ts`, `command`, `ok`, `ms`, `source`, `rev`).

### 5.2 Endpoint de comandos atómicos

```http
POST /api/agent/command
Authorization: Bearer <token>
Content-Type: application/json

{
  "command": "tasks.add",
  "args": { "title": "Llamar al dentista", "priority": "alta", "due": "2026-10-20" },
  "requestId": "uuid-v4",          // idempotencia: repetir el mismo requestId no duplica
  "source": "voice"
}
```

Respuesta:

```json
{
  "ok": true,
  "data": { "id": "k3j9f2aa1m", "title": "Llamar al dentista", "...": "..." },
  "game": { "xp": 0, "titles": [], "leveledUp": false, "newBadges": [] },
  "say": "Anotado: llamar al dentista, para el martes.",
  "ui": { "tab": "tasks", "highlight": "k3j9f2aa1m" }
}
```

- `say`: frase corta en español, **lista para TTS**. Evita que Jarvis gaste otra
  llamada al LLM y garantiza que lo dicho coincida con lo hecho.
- `ui`: sugerencia de qué resaltar. El cliente la usa para hacer *flash* del ítem;
  el HUD puede leerla. Nunca es una orden de ejecutar código.
- `undoToken` (18 hex): viene en los comandos que cambian datos. Mandalo a
  `undo` dentro de los **30 s** para revertir ese cambio exacto.
- `rev`: revisión del estado después del comando.
- `deduped: true`: este `requestId` ya se había ejecutado; la respuesta es la
  original y **no** se volvió a aplicar nada.
- Errores: `400` comando desconocido (devuelve `commands`), `401` token inválido,
  `404` ítem inexistente, `409` ambiguo (`candidates`) o `requestId` reusado con
  otro contenido, `410` undo expirado, `422` arg inválido (`{ error, field }`),
  `429` rate limit.
- Límites: 60 comandos por minuto por token. Idempotencia y undo viven en memoria:
  un reinicio de la app los pierde (el estado de los datos no).

### 5.3 Catálogo de comandos (implementado: 34)

Pedí `catalog` para obtener la lista viva con sus args. `args` en `cursiva` = opcional.
Los comandos que apuntan a un ítem aceptan `id` **o** `match` (texto libre, sin
acentos ni mayúsculas). Para hacerlo natural por voz, `habits.check` también acepta
`name`, `shopping.check` acepta `name` y `learning.progress` acepta `title`.

| Comando | Args | Implementa sobre |
|---|---|---|
| `status.today` | — | devuelve tareas vencidas y de hoy, hábitos pendientes, citas, racha y nivel |
| `catalog` | — | devuelve esta tabla (descubrimiento para el agente) |
| `tasks.list` | `filter` (`today` / `overdue` / `open` / `done`), `limit` | `GET /api/tasks` |
| `tasks.add` | `title`, `area`, `due`, `priority` | `POST /api/tasks` |
| `tasks.update` | `id` o `match` (texto), `patch` | `PATCH /api/tasks/:id` |
| `tasks.complete` | `id` o `match` | `PATCH { done: true }` |
| `tasks.uncomplete` | `id` o `match` | `PATCH { done: false }` |
| `tasks.remove` | `id` o `match` | `DELETE` (requiere confirmación) |
| `habits.list` | — | `GET /api/habits` |
| `habits.check` | `id` o `match`, `date` | `PATCH { log }` |
| `habits.add` | `name`, `icon`, `targetPerWeek` | `POST /api/habits` |
| `meals.log` | `date`, `slot`, `text` | `PUT /api/data` con `meals` |
| `water.add` | `glasses` (1–8), `date` | `PUT /api/data` con `meals` |
| `shopping.add` | `name`, `qty` | `POST /api/shopping` |
| `shopping.check` | `id` o `match` | `PATCH { done: true }` |
| `expenses.add` | `amount`, `category`, `description`, `date` | `PUT /api/data` con `finances` |
| `expenses.remove` | `id` | `PUT /api/data` con `finances` (confirmar) |
| `commitments.add` | `title`, `person`, `date`, `notes` | `POST /api/commitments` |
| `commitments.complete` | `id` o `match` | `PATCH { done: true }` |
| `appointments.add` | `title`, `date`, `place`, `notes` | `POST /api/appointments` |
| `projects.add` | `title`, `description` | `POST /api/projects` |
| `projects.step.add` | `project` (id o match), `text` | `PATCH` con `steps` |
| `projects.step.check` | `project`, `text` | `PATCH` con `steps` |
| `learning.add` | `title`, `type`, `goal` | `POST /api/learning` |
| `learning.progress` | `id` o `match`, `progress` | `PATCH { progress }` |
| `health.measure` | `weight`, `sleep`, `mood`, `date` | `PUT /api/data` con `measurements` |
| `routine.complete` | `day`, `exercise` | `PUT /api/data` con `routine` |
| `rewards.status` | — | `GET /api/rewards` |
| `coach.advise` | `kind` | `POST /api/ai/advise` |
| `news.digest` | — | `GET /api/news/digest` |
| `nav.open` | `tab` | evento SSE `nav` (el cliente cambia de sección) |
| `pomodoro.start` | `minutes`, `label`, `itemId` | evento SSE `pomodoro` |
| `pomodoro.stop` | — | evento SSE `pomodoro` |
| `undo` | `undoToken` | revierte el último comando reversible (30 s) |

Reglas de resolución de `match`: comparar sin acentos ni mayúsculas, por
`title`/`name`; si hay 0 → `404`; si hay ≥2 → `409 { "error": "ambiguo",
"candidates": [...] }` y Jarvis **pregunta**, no elige.

### 5.4 Eventos en vivo (SSE)

```http
GET /api/agent/events
Authorization: Bearer <token>
Accept: text/event-stream

event: state
data: { "rev": 42, "tab": "tasks" }

event: nav
data: { "tab": "finances" }

event: reward
data: { "xp": 15, "leveledUp": false, "newBadges": [] }

event: pomodoro
data: { "running": true, "endsAt": 1760000000000, "label": "Informe" }

event: hello
data: { "rev": 12, "voice": { "level": 0.4, "state": "listening", "text": "" } }

event: voice
data: { "level": 0.62, "state": "listening", "text": "revisá las tareas", "origin": "agent" }
```

- El stream se puede abrir con `Authorization: Bearer <token>` **o** con la cookie de
  sesión: la UI de la app lo usa con cookie (así el token nunca llega al navegador).
- Al conectar manda `event: hello` con la `rev` actual, y un comentario de ping cada 15 s.
- Cada evento incluye `rev` y `origin` (`agent` o `ui`). La UI ignora los `origin: ui`
  (los generó ella misma) y se refresca sola con los `agent`: si Jarvis agrega una
  tarea, aparece en pantalla sin recargar.
- Fallback sin SSE: `GET /api/state/rev` devuelve `{ "rev": 42 }`.
- Los eventos `state` de origen `agent` incluyen `say` y `command`: el HUD muestra
  exactamente lo que respondió Jarvis, sin inventar texto.

### 5.5 Seguridad (no negociable)

1. Con el servidor suelto (`node server.js`) el bind por defecto es `0.0.0.0`, es decir
   la LAN. La app de escritorio (Electron) fuerza `127.0.0.1`. Para voz, definir
   `HOST=127.0.0.1` o usar la app de escritorio.
2. **No** exponer `/api/agent/*` en la nube (Render) sin auth de usuario real: el token
   está pensado para loopback.
3. Comandos destructivos (`tasks.remove`, `expenses.remove`) exigen `"confirm": true`
   explícito y **confirmación hablada** previa. Sin `confirm` responden `422`.
4. Sin CORS: si algún día se agrega, que sea lista blanca explícita, no `*`.
5. `agent.log` registra comando, duración y resultado; no guarda el contenido de
   comidas ni mediciones más allá de lo que diga el propio comando.
6. El token no va en la URL (nada de `?token=`): sólo header. Si se filtra, borrar
   `agent-token` y reiniciar.
7. El micrófono: la app de escritorio concede `media` **solo** al origen de la app en
   loopback (no a cualquier página). Si Jarvis captura el audio, el HUD no necesita
   el micrófono; el modo local es un respaldo.

### 5.6 Telemetría de voz (para que el anillo reaccione al micrófono)

Jarvis ya tiene los frames del micrófono: solo tiene que reportar el nivel.

```http
POST /api/agent/voice
Authorization: Bearer <token>
Content-Type: application/json

{ "level": 0.62, "state": "listening", "text": "revisá las tareas" }
→ 200 { "ok": true }                 // o { "ok": true, "throttled": true }

GET /api/agent/voice
→ { "level": 0.62, "state": "listening", "text": "...", "at": 1792284928249 }
```

- `level`: 0–1 (se recorta). `state`: `idle` | `listening` | `thinking` | `speaking`
  (cualquier otro valor cae en `listening`). `text`: transcripción parcial, opcional.
- **Cadencia recomendada: 10–20 por segundo.** El servidor descarta lo que llegue a
  menos de 25 ms del frame anterior (~40 fps) y responde igual `200`, así que
  pasarse no rompe nada, solo se ignora.
- Es telemetría, no un comando: **no** consume el límite de 60 comandos/min y **no**
  mueve `rev` (los clientes no se recargan por hablar).
- El HUD vuelve solo a reposo si deja de recibir frames ~1.3 s.
- Quien se conecta tarde se sincroniza: el evento `hello` del SSE trae el estado de
  voz actual (si el último frame tiene menos de 5 s).
- Privacidad: el servidor no guarda audio ni la transcripción en disco; el texto vive
  solo en memoria y se pierde al reiniciar.

Del lado de Jarvis, el `level` conviene calcularlo como RMS normalizado de la ventana
corta, con suavizado asimétrico (ataque rápido, caída lenta) para que el anillo no
tiemble. El HUD aplica además su propio suavizado al usar el micrófono local.

**Costo medido del HUD** (Electron, ventana visible, micrófono activo, promedio de 12
muestras de 1 s de `app.getAppMetrics()` del proceso del HUD):

| Escenario | CPU | Pico |
|---|---|---|
| Sin micrófono | ~0,1 % | 0,1 % |
| Micrófono activo, versión inicial | 1,34 % | 2,4 % |
| Micrófono activo, con las optimizaciones | 0,58–0,68 % | 0,9 % |
| Igual, sin transiciones CSS (solo para desglosar) | 0,32 % | 0,36 % |

De lo que queda, la mitad es el trabajo de pintado del overlay animado y la otra mitad
el análisis de audio. Lo que se hizo para bajarlo: el análisis corre a **24 fps** (en vez
de seguir el refresco del monitor) y baja a **8 fps** tras 1,5 s de silencio; el nivel se
cuantifica en 64 pasos y solo se escribe al DOM cuando cambia; la variable `--voice` vive
en el panel, no en el documento; y las barras se animan con `transform` en vez de
`height`, así no provocan *layout*.

### 5.7 Puente incluido: `scripts/jarvis-voice-bridge.js`

Si Jarvis no quiere (o no puede) mandar la telemetría él mismo, el repo trae el puente:
captura el micrófono, calcula el nivel y lo reporta. Sirve tal cual para que el anillo
funcione hoy, y como referencia del cálculo esperado.

```bash
npm run voice                      # micrófono por defecto → http://127.0.0.1:4321
npm run voice -- --list-devices    # nombres de los micrófonos (DirectShow en Windows)
npm run voice -- --device "Micrófono (Realtek(R) Audio)" --verbose
npm run voice -- --file prueba.wav # entrada de archivo, para probar sin micrófono
```

Opciones: `--url`, `--token` (o `POUT_AGENT_TOKEN`, o `data/agent-token`), `--device`,
`--file`, `--ffmpeg`, `--fps`, `--idle-fps`, `--gain`, `--threshold`, `--verbose`.
Jarvis puede manejarlo como hijo **por stdin**:

| Línea escrita | Efecto |
|---|---|
| `listening` / `idle` | devuelve el control al micrófono (automático) |
| `thinking` | fija el estado; no reporta el micrófono (evita que el TTS se escuche a sí mismo) |
| `speaking` | igual, mientras Jarvis habla |
| `text revisá las tareas` | transcripción parcial para el HUD (`text` sin argumentos la limpia) |
| `status` | imprime el último payload por stderr |
| `quit` / `exit` | manda un `idle` final y sale |

Cómo mide (`lib/voice-bridge.js`, todo en memoria: **no guarda audio**):

- Captura con ffmpeg (`dshow` en Windows, `avfoundation` en macOS, `pulse`/`alsa` en
  Linux) a PCM s16le mono 16 kHz; las muestras se miden y se descartan.
- RMS normalizado × 3,2 y recortado a 0–1, igual que el micrófono local del HUD, así el
  anillo se ve igual venga de donde venga.
- Suavizado asimétrico con constantes de tiempo (ataque 30 ms, caída 150 ms), no con un
  factor fijo por frame: no depende de la cadencia.
- Umbral 0,07 y margen de 350 ms para no cortar entre sílabas; el nivel se cuantifica en
  64 pasos, los mismos que usa el HUD.
- **12 reportes/s** con voz y **4 reportes/s** en reposo (el servidor descarta lo que
  llegue a menos de 25 ms, así que no tiene sentido pasarse). Un cambio de estado se
  manda de inmediato, sin esperar el hueco de la cadencia lenta.
- Nunca apila peticiones: si la anterior sigue en vuelo, guarda la última y la manda al
  volver. Un error de red no lo tumba (reintenta en el próximo frame); un `401` avisa y
  sale. Si ffmpeg se cae, reintenta con retroceso hasta 8 s y deja el HUD en `idle`.

Verificado el 17/10/2026 (Windows, ffmpeg 9.0):

| Prueba | Resultado |
|---|---|
| `node --test tests/voice-bridge.test.js` | 19/19 |
| Tono a 30 % de escala por el puente (`--file`) → SSE | nivel medido 0,59 de pico (teórico 0,68), `listening` en 12/s y `idle` en 4/s |
| `thinking` / `speaking` por stdin → SSE | estados fijados con `level: 0`; si no, el archivo sonando los pisaba |
| `rev` en los eventos de voz | siempre 0: la telemetría no recarga la app |
| HUD real en el navegador | `--voice` siguió el tono (0,563 → 0,234 → 0,125 → 0,031 → 0) y la etiqueta alternó escuchando/en espera |
| Micrófono real de la máquina (DroidCam) | abrió el dispositivo y entregó 176 kB en 5,5 s de audio real, en silencio digital (nivel 0 incluso con ganancia 400) |
| Eco del TTS + voz encima (`--file`) | 2 interrupciones, una por cada vez que la voz entra: nivel 0,68 sobre eco 0,22, sostenido 227 ms; stdout sin una sola línea que no sea el evento |

### 5.8 Interrupción: hablarle encima a Jarvis

Mientras el estado es `speaking`, el puente **sigue midiendo** el micrófono (aunque no
reporte el nivel al HUD, si no el anillo copiaría el TTS). Con eso detecta que alguien
habla encima y avisa. No hace falta otra captura ni otro umbral: es el mismo nivel.

Protocolo: **stdout** del puente, una línea JSON por interrupción (los logs van a
stderr, así que stdout queda limpio para leerlo con `readline`):

```json
{"event":"bargeIn","level":0.68,"baseline":0.22,"threshold":0.39,"heldMs":227,"at":1792288702071}
```

Jarvis decide: cortar el TTS, cambiar el estado a `listening` (ahí el HUD pasa a
“escuchando” y el micrófono vuelve a mandar) y arrancar el STT. El puente no cambia el
estado por su cuenta: si lo hiciera, el HUD mostraría “escuchando” mientras el TTS sigue
sonando.

Cómo decide (`lib/voice-bridge.js`, `BARGE_DEFAULTS`):

1. Al empezar cada frase se ignoran **150 ms** (queda el sonido de la frase anterior) y
   se aprenden **400 ms** del eco del TTS: lo que importa es cuánto suena Jarvis en ese
   parlante y ese volumen, no un número fijo.
2. Dispara si el nivel del micrófono supera `máx(0.18, eco × 1.8)` y se sostiene
   **220 ms**. El piso absoluto evita que un ventilador lo dispare; el factor relativo,
   que lo dispare el propio eco.
3. Un aviso por interrupción: hace falta que el nivel caiga a menos de 0,7 × umbral
   durante **250 ms** para volver a armarse, con 1,2 s de refractario. Toser no cuenta.
4. El eco se sigue mientras Jarvis habla solo (el TTS sube y baja), pero **no** mientras
   el nivel está por encima del umbral: si no, el umbral treparía a la voz del usuario.
5. La comparación se hace en RMS lineal, no en la escala recortada: si el eco es fuerte,
   el usuario tiene que sonar más fuerte todavía, y eso se nota aunque el nivel llegue a 1.

`--no-barge-in` lo apaga; `--barge-floor`, `--barge-factor` y `--barge-hold` lo ajustan
(los números de arriba son los valores por defecto).

**Límite honesto**: sin cancelación de eco (AEC) no se puede separar perfectamente la voz
del usuario del TTS que sale por los parlantes. Con el volumen muy alto, o con el micrófono
pegado al parlante, la interrupción necesita que el usuario hable bastante más fuerte que
Jarvis. Con auriculares o con el micrófono del propio HUD (que sí usa AEC de Chromium) el
margen es mucho mayor.

---

## 6. Lado Jarvis: voz y HUD

### 6.0 Dónde corre Jarvis (elegir una topología)

| Topología | Pros | Contras |
|---|---|---|
| **Proceso aparte en la misma PC** (recomendado) | Aísla crash y CPU del HUD; se puede reiniciar sin cerrar la app; permite probar con curl | Dos procesos que arrancar |
| **Hijo de Electron** (`child_process` desde `electron/main.js`) | Un solo ícono, ciclo de vida conjunto | Si Jarvis se cuelga, arrastra la app |
| **Dentro del renderer** | Nada que arrancar | Micrófono bajo CSP, se pierde al recargar, mezcla responsabilidades |

Contrato mínimo en cualquiera: **Jarvis nunca importa módulos de `server.js`**; solo
HTTP. Así la app puede cambiar por dentro sin romperlo.

### 6.1 Pipeline recomendado (y presupuesto de latencia)

```
wake word → STT streaming → normalización → intent → POST /api/agent/command
        → say (del servidor) → TTS → audio
```

| Etapa | Objetivo |
|---|---|
| Wake word → captura | < 300 ms |
| Fin de habla → transcripción | < 700 ms |
| Intención → comando | < 100 ms (reglas primero, LLM solo si es ambiguo) |
| Comando → `say` | < 150 ms (es local) |
| `say` → primer audio | < 400 ms |

Claves para que se sienta Jarvis:
- **Respuestas precocinadas** para lo frecuente ("Hecho", "Anotado", "Son 3
  pendientes para hoy"). El LLM solo para lo que no encaja en el catálogo.
- **Barge-in**: si el usuario habla, cortar el TTS.
- **Confirmación por voz** solo en destructivo; para el resto, ejecutar y decir.
- Un solo turno a la vez (cola), con `requestId` para no duplicar si el STT
  entrega dos veces la misma frase.
- Nunca "inventar" datos: si `status.today` falla, decir que no hay conexión con
  la app, no improvisar pendientes.

### 6.2 HUD "Iron Man" — sí es posible, con estas restricciones

La app sirve con CSP estricta (resumen de lo que bloquea):

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
connect-src 'self'; frame-ancestors 'none'; X-Frame-Options: DENY
```

Por lo tanto, **descartado**: iframes de la app, CDNs, inyectar `<script>` remoto,
`fetch` a otro origen desde la página de la app.

**Ya está implementado** (overlay + ruta propia, la combinación de 1 y 2):

- `electron/main.js` crea una segunda `BrowserWindow` de 392×268 en la esquina
  inferior derecha, con `transparent: true, frame: false, alwaysOnTop: true
  ('screen-saver'), skipTaskbar: true, hasShadow: false, show: false`. Al servidor
  le sigue importando el loopback: el contenido se sirve desde `hud.html`.
- La página es `public/hud.html` + [hud.css](public/hud.css) + [hud.js](public/hud.js),
  servida por el mismo servidor: comparte sesión (cookie) con la ventana principal,
  así que **el token nunca llega al renderer**. También se puede abrir en el navegador
  en `/hud.html` para depurar (ahí se ocultan los botones de ventana).
- Datos: `GET /api/data` + `GET /api/rewards`; en vivo: `GET /api/agent/events`.
  Muestra el anillo de XP, el progreso del día (mismo cálculo que el badge de la app),
  pendientes/vencidas/hábitos/racha, el pomodoro y la última frase de Jarvis (`say`).
- Voz: el aro externo, la onda y el color del acento siguen la telemetría de §5.6 —
  `listening` verde, `thinking` ámbar, `speaking` menta. Como respaldo funciona sin
  Jarvis: el botón `mic` (o `?mic=1`) analiza el micrófono de la PC con Web Audio a
  24 fps (8 fps en silencio), con el costo medido que está en §5.6.
- Interactividad: el overlay **deja pasar los clics** al escritorio; se activa solo
  cuando el puntero entra en sus botones (patrón `setIgnoreMouseEvents(true, {
  forward: true })` + IPC), o de forma fija con **Ctrl+Alt+M**. **Ctrl+Alt+H**
  muestra/oculta el HUD; el botón `ocultar` hace lo mismo.
- El HUD recién aparece cuando la ventana principal ya tiene sesión: si queda en el
  login no se muestra vacío, y si la sesión se cae avisa y reintenta cada 5 s.

Límites conocidos: el pomodoro del HUD se arma con el evento `pomodoro`, así que un
HUD abierto después de `pomodoro.start` no lo muestra hasta el próximo aviso; y el
layout está pensado para pantallas grandes (el overlay mide 392×268).

Animaciones que valen la pena y no cuestan rendimiento: anillo de energía ligado a
`hero.xpInLevel/xpToNext`, onda de audio por `AnalyserNode`, pulso del ambiente
con `--mood`, y "flash" del ítem que acaba de cambiar (`ui.highlight`).
Para el HUD, `prefers-reduced-motion` y un botón de apagado siempre visibles.

### 6.3 Qué NO debe hacer Jarvis

- Inyectar JavaScript en la ventana de la app o depender de funciones `window.*`.
- Hacer `PUT /api/data` con arrays leídos minutos antes (pisa cambios del usuario).
- Escribir `hero`, `aiUsage`, `version`.
- Reintentar el PIN o adivinar credenciales.
- Mantener estado propio de tareas: la fuente de verdad es siempre `GET /api/data`.

---

## 7. Criterios de aceptación

Los primeros 12 están cubiertos por `tests/agent-contract.test.js` (29 pruebas,
correr con `npm test`). Se listan igual para que Jarvis sepa qué se garantiza.

1. `GET /api/data` con token de agente devuelve 200; sin token, 401.
2. `tasks.add` con `requestId` repetido **no** crea dos tareas.
3. `tasks.complete` con `match: "dentista"` marca la correcta; con dos candidatas
   devuelve 409 y lista `candidates`.
4. Agregar una tarea por voz mientras la UI está abierta: aparece sin recargar
   (SSE `state`) y no se pierde nada de lo que el usuario estaba editando.
5. `habits.check` dos veces el mismo día no duplica XP ni rompe la racha.
6. `water.add` respeta el tope de 8/día y el XP correspondiente.
7. `coach.advise` devuelve `reply` en español con bullets `*`.
8. Reiniciar el servidor: la cookie humana deja de valer, el token de agente sigue.
9. Comando desconocido → `400` con `{ "error": "comando desconocido" }` y lista de
   comandos válidos (o `catalog`).
10. Todo lo anterior funciona con la ventana de la app minimizada.
11. HUD: 60 fps estables, sin crecimiento de memoria en 10 min, y se apaga con una
    sola acción.
12. Sin exposición en LAN/nube: `curl` desde otra máquina a `/api/agent/command`
    debe fallar por conexión, no por auth.
13. `POST /api/agent/voice` con token emite `voice` por SSE y **no** cambia `rev`;
    el nivel se recorta a 0–1 y un estado desconocido cae en `listening`.
    (Cubierto por `tests/agent-contract.test.js`.)
14. El HUD reacciona al audio del micrófono en tiempo real y vuelve solo a reposo
    cuando el habla termina. (Verificado en Electron con el dispositivo de audio
    sintético de Chromium.)
15. El puente (`scripts/jarvis-voice-bridge.js`) captura el micrófono, mide RMS y
    reporta con los estados correctos: `listening`/`idle` automáticos según el audio y
    `thinking`/`speaking` fijados por stdin, sin apilar peticiones ni mover `rev`.
    (Cubierto por `tests/voice-bridge.test.js`.)
16. Hablarle encima a Jarvis mientras habla produce **un** aviso `bargeIn` por
    interrupción en stdout; el eco del TTS, un pico corto (una tos) o seguir hablando no
    lo disparan de nuevo, y el HUD sigue mostrando `speaking` con nivel 0 hasta que Jarvis
    decide cortar. (Cubierto por `tests/voice-bridge.test.js`.)

---

## 8. Anexos

### 8.1 Ejemplos con curl

```bash
# 0) obtener el token (una sola vez; queda igual hasta que se rote)
#    app instalada en Windows:
#    cat "$APPDATA/procrastin-out/data/agent-token"
#    servidor suelto en desarrollo:
TOKEN=$(cat ./data/agent-token)
```

```bash
# login humano (guarda cookie)
curl -s -c jar.txt -H 'Content-Type: application/json' \
  -d '{"pin":"1234"}' http://127.0.0.1:4321/api/auth/login

# ver estado
curl -s -b jar.txt http://127.0.0.1:4321/api/data | head -c 400

# crear tarea (endpoint existente)
curl -s -b jar.txt -H 'Content-Type: application/json' \
  -d '{"title":"Pagar la luz","area":"casa","due":"2026-10-20","priority":"alta"}' \
  http://127.0.0.1:4321/api/tasks

# comando de agente (ya implementado)
curl -s -H "Authorization: Bearer $POUT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"command":"tasks.add","args":{"title":"Pagar la luz","priority":"alta"},
       "requestId":"6f1c2a9e-1b0e-4b7e-9a3e-2c5d8f7a1b22"}' \
  http://127.0.0.1:4321/api/agent/command
```

### 8.2 Errores y qué hacer

| HTTP | Significado | Acción de Jarvis |
|---|---|---|
| 400 | JSON inválido / comando desconocido | No reintentar; pedir reformulación |
| 401 | Token o sesión inválidos | Reautenticar; si el token falla, avisar al usuario |
| 404 | Ítem inexistente | Decir "no lo encontré" y ofrecer listar |
| 409 | Ambiguo / requestId repetido | Preguntar; nunca elegir al azar |
| 422 | Args inválidos | Preguntar el dato faltante |
| 429 | Rate limit / bloqueo de PIN | Esperar; no insistir |
| 502 | Fuente externa (noticias) | Decir que no hay conexión con la fuente |

### 8.3 Glosario de voz (español rioplatense)

| Se dice | Comando |
|---|---|
| "anotá / agregá / acordate de…" | `tasks.add` |
| "listo / hecho / terminé…" | `tasks.complete` (con `match`) |
| "¿qué tengo hoy?" | `status.today` |
| "¿cómo vengo?" | `rewards.status` |
| "tomé agua" | `water.add` (1 vaso) |
| "arrancá 25 minutos con…" | `pomodoro.start` |
| "mostrame las finanzas" | `nav.open` |
| "¿qué hago primero?" | `coach.advise { kind: "strategy" }` |

Fechas habladas ("mañana", "el viernes", "en dos semanas") se resuelven **en
Jarvis** antes de enviar, usando la misma regla UTC que la app (`status.today`
devuelve la fecha canónica del servidor).
