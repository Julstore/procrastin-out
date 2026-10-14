// procrastin-out — app de escritorio (Electron).
// Reutiliza server.js sin cambiar su lógica: lo levanta en 127.0.0.1:4321 y muestra la UI.
// Los datos viven en la carpeta de usuario cuando está instalada, o en ./data en desarrollo.
const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const path = require('path');
const net = require('net');

const PORT = 4321;
const URL = `http://127.0.0.1:${PORT}/`;
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
function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'procrastin-out',
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
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
  win.on('closed', () => { win = null; });
  win.loadURL(URL);
}

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
  createWindow();
});

// Guardado sincrónico al cerrar: no perder el último cambio por el debounce de 150 ms.
app.on('before-quit', () => {
  try { if (serverApi && typeof serverApi.flush === 'function') serverApi.flush(); } catch (_) {}
});

app.on('window-all-closed', () => app.quit());
