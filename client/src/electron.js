// SiamShop — desktop (Electron) detection + per-install config.
// The Electron preload exposes `window.electron` (SIAMSHOP-ELECTRON-001). In a
// normal browser it is undefined and every helper here is a harmless no-op, so
// the same client bundle serves the website, the phone PWA and the desktop till.
export const isElectron = typeof window !== 'undefined' && !!window.electron;

// { shopName, cloudApiUrl, shopSlug, printer: { ip, port, name, lprQueue, autoPrint, kickDrawerOnCash } }
export const electronConfig = (isElectron && window.electron.config) || {};

export const desktop = {
  printReceipt: (payload) => (isElectron ? window.electron.printReceipt(payload) : Promise.resolve({ ok: false, error: 'not-desktop' })),
  kickDrawer: () => (isElectron ? window.electron.kickDrawer() : Promise.resolve({ ok: false, error: 'not-desktop' })),
  printZ: (z, shopName) => (isElectron ? window.electron.printZ({ z, shopName }) : Promise.resolve({ ok: false, error: 'not-desktop' })),
  testPrint: (printer) => (isElectron ? window.electron.testPrint(printer) : Promise.resolve({ ok: false, error: 'not-desktop' })),
  listPrinters: () => (isElectron ? window.electron.listPrinters() : Promise.resolve([])),
  // Parcel labels (SIAMSHOP-POST-001) — HTML → OS driver, 4×6 in.
  printLabel: (html, copies = 1) => (isElectron ? window.electron.printLabel({ html, copies }) : Promise.resolve({ ok: false, error: 'not-desktop' })),
  getConfig: () => (isElectron ? window.electron.getConfig() : Promise.resolve({})),
  saveConfig: (patch) => (isElectron ? window.electron.saveConfig(patch) : Promise.resolve({ success: false })),
  getVersion: () => (isElectron ? window.electron.getVersion() : Promise.resolve(null)),
  checkForUpdates: () => (isElectron ? window.electron.checkForUpdates() : Promise.resolve({ ok: false, reason: 'not-desktop' })),
  restartToUpdate: () => isElectron && window.electron.restartToUpdate(),
  onUpdateStatus: (cb) => isElectron && window.electron.onUpdateStatus(cb),
  resetConfig: () => isElectron && window.electron.resetConfig(),
  quit: () => isElectron && window.electron.quitApp(),
};
