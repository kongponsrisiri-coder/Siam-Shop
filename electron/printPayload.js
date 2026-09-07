// What each printing path needs from a receipt payload.
//
// The two paths want the logo in different shapes. The classic path prints a
// pre-rasterised 1-bit bitmap built here in the main process (nativeImage lives
// only here). The rendered path draws the logo itself and needs the original
// data URL to reach printService.
//
// This used to be three lines inside the IPC handler that rasterised the logo
// and then deleted the data URL unconditionally. That was harmless while
// classic was the only path, but PRINT-RENDER-001 made rendered the default, so
// every rendered bill reached the printer with no logo at all while the Admin
// preview still showed one (Korakot, 7 Sep). It lives here so it can be tested
// without Electron.
function isClassic(p) {
  return String((p && p.style) || 'rendered') === 'classic';
}

// `rasterise(dataUrl, invert) -> Buffer` is injected so this module stays free
// of Electron.
function preparePrintPayload(payload, rasterise) {
  const p = { ...(payload || {}) };
  if (!p.showLogo || !p.logo) return p;
  if (isClassic(p)) {
    p.logoRaster = rasterise(p.logo, !!p.logoInvert);
    delete p.logo; // the bitmap replaces it; the classic path never reads it
  }
  return p; // rendered: the data URL must survive to printService
}

module.exports = { isClassic, preparePrintPayload };
