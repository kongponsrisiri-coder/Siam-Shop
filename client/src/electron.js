// SiamShop — desktop (Electron) detection + per-install config.
// The Electron preload exposes `window.electron` (SIAMSHOP-ELECTRON-001). In a
// normal browser it is undefined and every helper here is a harmless no-op, so
// the same client bundle serves the website, the phone PWA and the desktop till.
export const isElectron = typeof window !== 'undefined' && !!window.electron;

// { shopName, cloudApiUrl, shopSlug, printer: { ip, port, name, lprQueue, autoPrint, kickDrawerOnCash } }
export const electronConfig = (isElectron && window.electron.config) || {};

export const desktop = {
  printReceipt: (payload) => (isElectron ? window.electron.printReceipt(payload) : Promise.resolve({ ok: false, error: 'not-desktop' })),
  kickDrawer: (dest) => (isElectron ? window.electron.kickDrawer(dest) : Promise.resolve({ ok: false, error: 'not-desktop' })),
  // Prep ticket on a prep printer (SIAMSHOP-PRINTERS-001)
  printPrep: (ticket, dest) => (isElectron && window.electron.printPrep ? window.electron.printPrep({ ticket, dest }) : Promise.resolve({ ok: false, error: 'not-desktop' })),
  printZ: (z, shopName, dest) => (isElectron ? window.electron.printZ({ z, shopName, dest }) : Promise.resolve({ ok: false, error: 'not-desktop' })),
  testPrint: (printer) => (isElectron ? window.electron.testPrint(printer) : Promise.resolve({ ok: false, error: 'not-desktop' })),
  listPrinters: () => (isElectron ? window.electron.listPrinters() : Promise.resolve([])),
  // Find network receipt printers on the till's LAN (SIAMSHOP-DEVICE-001 D1).
  scanPrinters: () => (isElectron && window.electron.scanPrinters ? window.electron.scanPrinters() : Promise.resolve({ printers: [], message: 'Scanning only works in the desktop app.' })),
  // Parcel labels (SIAMSHOP-POST-001) — HTML → OS driver, 4×6 in.
  printLabel: (html, copies = 1, deviceName, paper) => (isElectron ? window.electron.printLabel({ html, copies, deviceName, paper }) : Promise.resolve({ ok: false, error: 'not-desktop' })),
  getConfig: () => (isElectron ? window.electron.getConfig() : Promise.resolve({})),
  saveConfig: (patch) => (isElectron ? window.electron.saveConfig(patch) : Promise.resolve({ success: false })),
  getVersion: () => (isElectron ? window.electron.getVersion() : Promise.resolve(null)),
  checkForUpdates: () => (isElectron ? window.electron.checkForUpdates() : Promise.resolve({ ok: false, reason: 'not-desktop' })),
  restartToUpdate: () => isElectron && window.electron.restartToUpdate(),
  onUpdateStatus: (cb) => isElectron && window.electron.onUpdateStatus(cb),
  resetConfig: () => isElectron && window.electron.resetConfig(),
  quit: () => isElectron && window.electron.quitApp(),
};
