// procrastin-out — app de escritorio (Electron).
// Reutiliza server.js sin cambiar su lógica: lo levanta en 127.0.0.1:4321 y muestra la UI.
// Los datos viven en la carpeta de usuario cuando está instalada, o en ./data en desarrollo.
// Además abre el HUD: una ventana transparente, siempre visible, que refleja la app
// y lo que va haciendo Jarvis (se conecta sola al stream de eventos).
const { app, BrowserWindow, dialog, shell, Menu, ipcMain, globalShortcut, screen, session } = require('electron');
const path = require('path');
const net = require('net');

const PORT = 4321;
const URL = `http://127.0.0.1:${PORT}/`;
const HUD_URL = `http://127.0.0.1:${PORT}/hud.html`;
const SERVER_PATH = path.join(__dirname, '..', 'server.js');

let serverApi = null;

function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

function startServer() {
  if (app.isPackaged) {
    // Instalada: datos y .env (clave de IA) en la carpeta de usuario, no dentro del programa.
    process.env.POUT_DATA_DIR = path.join(app.getPath('userData'), 'data');
  }
  process.env.PORT = String(PORT);
  // Solo loopback: el servidor por defecto escucha en 0.0.0.0 (para el celular en la WiFi),
  // pero la app de escritorio no debe exponerse a la red local.
  // (El token de Jarvis vive en la carpeta de datos: sin loopback no hay comandos.)
  process.env.HOST = '127.0.0.1';
  serverApi = require(SERVER_PATH);
}

async function waitForServer(tries = 75) {
  for (let i = 0; i < tries; i++) {
    if (await portBusy(PORT)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

let win = null;
let splash = null;
let hud = null;
let hudPinned = false;   // clics fijos (Ctrl+Alt+M o el botón del HUD)
let hudHover = false;    // el puntero está sobre un botón del HUD

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'procrastin-out',
    icon: path.join(__dirname, '..', 'public', 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#0D251C',
  });
  Menu.setApplicationMenu(null);
  // Los links externos (noticias, Wikipedia) se abren en el navegador del sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${PORT}`) || url.startsWith('http://localhost:4321')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // "Exportar datos" descarga el JSON a Descargas.
  win.webContents.session.on('will-download', (_e, item) => {
    item.setSavePath(path.join(app.getPath('downloads'), item.getFilename()));
  });
  // El splash se cierra cuando la app terminó de cargar.
  win.webContents.once('did-finish-load', () => {
    if (splash) { splash.close(); splash = null; }
  });
  // El HUD aparece cuando hay app cargada (o sea, con sesión): si no, queda en el login
  // y su script no corre, así que nunca se muestra vacío.
  win.webContents.on('did-navigate', (_e, url) => {
    if (url.startsWith(URL) && !url.includes('login.html')) ensureHud();
  });
  win.on('closed', () => { win = null; if (hud) hud.close(); });
  win.loadURL(URL);
}

// El HUD deja pasar los clics al escritorio salvo cuando el puntero está sobre
// uno de sus botones (o cuando se fijan los clics con Ctrl+Alt+M).
function applyHudMouse() {
  if (!hud) return;
  hud.setIgnoreMouseEvents(!hudPinned && !hudHover, { forward: true });
}

function setHudPin(on) {
  hudPinned = on;
  applyHudMouse();
  if (hud) hud.webContents.send('hud:pin-state', hudPinned);
}

function createHud() {
  let area = { x: 0, y: 0, width: 1280, height: 800 };
  try { area = screen.getPrimaryDisplay().workArea; } catch (_) { /* sin pantalla: usar default */ }
  const width = 392;
  const height = 268;
  hud = new BrowserWindow({
    width,
    height,
    x: area.x + area.width - width - 20,
    y: area.y + area.height - height - 20,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'hud-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  // Por encima de las ventanas normales, sin quitarle el foco a lo que el usuario hace.
  hud.setAlwaysOnTop(true, 'screen-saver');
  try { hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) { /* solo macOS */ }
  hud.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  hud.on('closed', () => { hud = null; hudHover = false; hudPinned = false; });
  applyHudMouse();
  hud.loadURL(HUD_URL);
  return hud;
}

// Crea el HUD la primera vez y lo recarga si quedó en el login (p. ej. tras cerrar sesión).
function ensureHud() {
  if (!hud) { createHud(); return; }
  try { hud.loadURL(HUD_URL); } catch (_) { /* ventana cerrándose */ }
}

function registerHudShortcuts() {
  try {
    globalShortcut.register('CommandOrControl+Alt+H', () => {
      if (!hud) return;
      if (hud.isVisible()) hud.hide();
      else hud.showInactive();
    });
    globalShortcut.register('CommandOrControl+Alt+M', () => setHudPin(!hudPinned));
  } catch (e) {
    console.error('Atajos del HUD:', e.message);
  }
}

ipcMain.on('hud:interactive', (_e, on) => { hudHover = !!on; applyHudMouse(); });
ipcMain.on('hud:pin', () => setHudPin(!hudPinned));
ipcMain.on('hud:hide', () => { if (hud) hud.hide(); });
ipcMain.on('hud:visible', (_e, on) => {
  if (!hud) return;
  if (on) { if (!hud.isVisible()) hud.showInactive(); }
  else if (hud.isVisible()) hud.hide();
});

app.whenReady().then(async () => {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); return; }
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  if (await portBusy(PORT)) {
    dialog.showErrorBox(
      'procrastin-out ya está en marcha',
      'El puerto 4321 está ocupado: probablemente ya tenés la app abierta o el servidor (node server.js / start.bat) corriendo.\n\nCerralo e intentá de nuevo.'
    );
    app.quit();
    return;
  }
  try {
    startServer();
  } catch (e) {
    dialog.showErrorBox('No se pudo iniciar el servidor', String(e && e.message || e));
    app.quit();
    return;
  }
  if (!(await waitForServer())) {
    dialog.showErrorBox('procrastin-out no arrancó', 'El servidor local no respondió en el puerto 4321.');
    app.quit();
    return;
  }
  // Splash de marca mientras la UI carga (misma pantalla que la PWA).
  splash = new BrowserWindow({
    width: 405,
    height: 720,
    frame: false,
    resizable: false,
    center: true,
    backgroundColor: '#0D251C',
  });
  splash.loadFile(path.join(__dirname, '..', 'public', 'splash.html'));
  createWindow();
  registerHudShortcuts();
  allowMicForApp();
});

// El HUD puede analizar el micrófono (respaldo cuando Jarvis no manda niveles).
// Solo se concede `media`, y solo a la propia app en loopback.
function allowMicForApp() {
  const forApp = (url) => String(url || '').startsWith(URL);
  try {
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      callback(permission === 'media' && forApp(details?.requestingUrl || wc?.getURL?.()));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
      return permission === 'media' && forApp(origin);
    });
  } catch (e) {
    console.error('Permisos de micrófono:', e.message);
  }
}

// Guardado sincrónico al cerrar: no perder el último cambio por el debounce de 150 ms.
app.on('before-quit', () => {
  try { if (serverApi && typeof serverApi.flush === 'function') serverApi.flush(); } catch (_) {}
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => app.quit());
