// Puente del HUD: expone solo lo mínimo al renderer (contextIsolation sigue activo).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('poutHud', {
  // El HUD pide interactividad solo cuando el puntero está sobre un botón.
  interactive: (on) => ipcRenderer.send('hud:interactive', !!on),
  pin: () => ipcRenderer.send('hud:pin'),
  hide: () => ipcRenderer.send('hud:hide'),
  // La ventana recién se muestra cuando hay datos (es decir, con sesión abierta).
  visible: (on) => ipcRenderer.send('hud:visible', !!on),
  onPin: (cb) => ipcRenderer.on('hud:pin-state', (_e, on) => cb(!!on)),
});
