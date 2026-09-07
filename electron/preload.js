const { contextBridge, ipcRenderer } = require('electron');

// SiamShop desktop till (SIAMSHOP-ELECTRON-001). The client checks
// `!!window.electron` to hide customer nav, use the hash router, read the
// cloud URL + shop slug from config, and print through the main process.
//
// `config` is read synchronously at preload time so api.js can pick up the
// cloud URL before the first fetch (no async race on boot).
let config = {};
try { config = ipcRenderer.sendSync('siamshop:get-config-sync') || {}; } catch (_) { config = {}; }

contextBridge.exposeInMainWorld('electron', {
  isElectron: true,
  platform: process.platform,
  config,
  getConfig: () => ipcRenderer.invoke('siamshop:get-config'),
  // Partial update — merged into config.json (printer settings from Admin → This device).
  saveConfig: (patch) => ipcRenderer.invoke('siamshop:save-config', patch),
  readClipboard: () => ipcRenderer.invoke('siamshop:read-clipboard'),
  pickConfigFile: () => ipcRenderer.invoke('siamshop:pick-config-file'),
  resetConfig: () => ipcRenderer.invoke('siamshop:reset-config'),
  // Printing runs in the MAIN process (Path A has no local server).
  printReceipt: (payload) => ipcRenderer.invoke('siamshop:print-receipt', payload),
  kickDrawer: () => ipcRenderer.invoke('siamshop:kick-drawer'),
  printZ: (payload) => ipcRenderer.invoke('siamshop:print-z', payload),
  testPrint: (printer) => ipcRenderer.invoke('siamshop:test-print', printer),
  listPrinters: () => ipcRenderer.invoke('siamshop:list-printers'),
  scanPrinters: () => ipcRenderer.invoke('siamshop:scan-printers'),
  // Parcel label (SIAMSHOP-POST-001): rendered HTML → hidden window → OS driver at 4×6 in.
  printLabel: (payload) => ipcRenderer.invoke('siamshop:print-label', payload),
  // Updates
  getVersion: () => ipcRenderer.invoke('siamshop:get-version'),
  checkForUpdates: () => ipcRenderer.invoke('siamshop:check-for-updates'),
  restartToUpdate: () => ipcRenderer.invoke('siamshop:restart-to-update'),
  onUpdateStatus: (cb) => { ipcRenderer.on('siamshop:update-status', (_e, payload) => cb && cb(payload)); },
  quitApp: () => ipcRenderer.invoke('siamshop:quit-app'),
});
