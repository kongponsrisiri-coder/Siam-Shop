// SiamShop desktop till — Electron main process (SIAMSHOP-ELECTRON-001).
//
// Ported from restaurant-epos/electron/main.js, minus the half that does not
// apply to Path A (cloud-only): there is NO embedded server, no SQLite, no
// sync-status poll, no LAN QR window, no tunnel. Electron loads the built
// client bundle from disk and the client talks to `cloud_api_url` from
// config.json. Receipt printing therefore runs HERE, in the main process, via
// IPC (see printService.js) — the renderer never touches sockets.
//
// Kept from the restaurant shell (each one paid for by a client incident):
//   - single-instance lock + second-instance window recreate
//   - config load with BOM strip; wizard with 📋 Paste + Load-from-file
//   - clipboard shortcuts / right-click menu on every window
//   - setAppUserModelId on Windows; dock icon on Mac
//   - electron-updater with a file logger + status IPC to the renderer
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, clipboard, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const printService = require('./printService');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEV_URL = 'http://localhost:5173';
const APP_ID = 'uk.co.siamepos.shop';
const APP_ICON_PATH = path.join(__dirname, 'build', 'icon.png');

let mainWindow = null;
let tray = null;
let autoUpdater = null;

// ── Single instance ──────────────────────────────────────────────────────────
const gotSingleInstanceLock = app.isPackaged ? app.requestSingleInstanceLock() : true;
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } else if (app.isReady()) {
      createWindow(); // window was closed but the app kept running in the tray
    }
  });
}

// ── Config (per install) ────────────────────────────────────────────────────
// { shop_name, cloud_api_url, shop_slug, printer: { ip, port, name, lprQueue,
//   autoPrint, kickDrawerOnCash }, configured_at }
function getConfigPath() {
  return app.isPackaged ? path.join(app.getPath('userData'), 'config.json') : path.join(__dirname, 'config.json');
}
function loadConfig() {
  try {
    const p = getConfigPath();
    if (!fs.existsSync(p)) return null;
    // Strip a UTF-8 BOM (PowerShell `-Encoding UTF8` writes one; JSON.parse chokes).
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    console.warn('[config] load failed:', err.message);
    return null;
  }
}
function saveConfig(data) {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}
// What the renderer sees (camelCase, no secrets — there are none today).
function rendererConfig(cfg) {
  const c = cfg || loadConfig() || {};
  return {
    shopName: c.shop_name || '',
    cloudApiUrl: c.cloud_api_url || '',
    shopSlug: c.shop_slug || '',
    labelPrinter: c.label_printer || '',
    printer: {
      ip: c.printer?.ip || '', port: Number(c.printer?.port) || 9100, name: c.printer?.name || '',
      lprQueue: c.printer?.lprQueue || 'lp',
      autoPrint: c.printer?.autoPrint !== false, kickDrawerOnCash: c.printer?.kickDrawerOnCash !== false,
    },
    version: app.getVersion(),
  };
}

// ── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on('siamshop:get-config-sync', (event) => { event.returnValue = rendererConfig(); });
ipcMain.handle('siamshop:get-config', () => rendererConfig());
ipcMain.handle('siamshop:read-clipboard', () => { try { return clipboard.readText() || ''; } catch { return ''; } });

// Wizard "Load from config.json" — remote-session typing can be unreliable.
ipcMain.handle('siamshop:pick-config-file', async () => {
  try {
    const r = await dialog.showOpenDialog({ title: 'Load SiamShop config.json', properties: ['openFile'], filters: [{ name: 'Config', extensions: ['json', 'txt'] }] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    const d = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8').replace(/^﻿/, ''));
    return {
      shop_name: d.shop_name || d.shopName || '',
      cloud_api_url: d.cloud_api_url || d.cloudApiUrl || '',
      shop_slug: d.shop_slug || d.shopSlug || '',
      printer_ip: d.printer?.ip || d.printer_ip || '',
      printer_port: d.printer?.port || d.printer_port || '',
      printer_name: d.printer?.name || d.printer_name || '',
    };
  } catch (e) {
    return { error: e.message };
  }
});

function validateCore(data) {
  if (!data.shop_name || !data.cloud_api_url || !data.shop_slug) return 'Shop name, cloud URL and shop ID are required.';
  try { new URL(data.cloud_api_url); } catch { return 'Cloud URL is not a valid URL.'; }
  if (!/^[a-z0-9-]+$/i.test(data.shop_slug)) return 'Shop ID can only contain letters, numbers and dashes.';
  return null;
}
// First-run wizard save (full) and Admin → This device save (partial merge).
ipcMain.handle('siamshop:save-config', async (event, patch) => {
  try {
    const cur = loadConfig() || {};
    const next = { ...cur };
    if (patch.shop_name != null) next.shop_name = String(patch.shop_name).trim();
    if (patch.cloud_api_url != null) next.cloud_api_url = String(patch.cloud_api_url).trim().replace(/\/$/, '');
    if (patch.shop_slug != null) next.shop_slug = String(patch.shop_slug).trim();
    if (patch.label_printer != null) next.label_printer = String(patch.label_printer).trim();
    if (patch.printer) {
      next.printer = {
        ...(cur.printer || {}),
        ...(patch.printer.ip != null ? { ip: String(patch.printer.ip).trim() } : {}),
        ...(patch.printer.port != null ? { port: parseInt(patch.printer.port, 10) || 9100 } : {}),
        ...(patch.printer.name != null ? { name: String(patch.printer.name).trim() } : {}),
        ...(patch.printer.lprQueue != null ? { lprQueue: String(patch.printer.lprQueue).trim() || 'lp' } : {}),
        ...(patch.printer.autoPrint != null ? { autoPrint: !!patch.printer.autoPrint } : {}),
        ...(patch.printer.kickDrawerOnCash != null ? { kickDrawerOnCash: !!patch.printer.kickDrawerOnCash } : {}),
      };
    }
    const err = validateCore(next);
    if (err) return { success: false, error: err };
    next.configured_at = cur.configured_at || new Date().toISOString();
    saveConfig(next);
    return { success: true, config: rendererConfig(next) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Hand this install to a different shop: wipe config.json and relaunch into the wizard.
ipcMain.handle('siamshop:reset-config', async () => {
  try {
    const cfg = getConfigPath();
    if (fs.existsSync(cfg)) fs.unlinkSync(cfg);
    app.relaunch();
    app.exit(0);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Printing — main process, ESC/POS over the network/USB (see printService.js).
function printerCfg() { return rendererConfig().printer; }
ipcMain.handle('siamshop:print-receipt', async (event, payload) => {
  try {
    const copies = Math.min(3, Math.max(1, parseInt(payload?.copies, 10) || 1));
    for (let i = 0; i < copies; i++) await printService.printReceipt(printerCfg(), payload || {});
    return { ok: true, copies };
  } catch (e) {
    console.error('[print] receipt failed:', e.message);
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('siamshop:print-z', async (event, payload) => {
  try {
    await printService.printZReport(printerCfg(), payload?.z || {}, payload?.shopName || rendererConfig().shopName || 'SiamShop');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('siamshop:kick-drawer', async () => {
  try { await printService.openCashDrawer(printerCfg()); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('siamshop:test-print', async (event, printer) => {
  try { await printService.testPrint(printer || printerCfg()); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
// OS printer list — helps the operator pick a USB printer NAME on Admin → This device.
ipcMain.handle('siamshop:list-printers', async () => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return [];
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
  } catch (e) {
    return [];
  }
});

// ── Parcel labels (SIAMSHOP-POST-001) ───────────────────────────────────────
// Label printers speak ZPL/TSPL/raster per brand, so the label goes through
// the OS DRIVER: render the HTML in a hidden window and print silently at
// 4×6 in (101600 × 152400 µm) to the configured label printer. Not ESC/POS.
const LABEL_PAGE = { width: 101600, height: 152400 };
function renderLabelWindow(html) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({ show: false, width: 400, height: 600, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const timer = setTimeout(() => { try { win.close(); } catch (_) {} reject(new Error('Label render timed out')); }, 15000);
    win.webContents.once('did-finish-load', () => setTimeout(() => { clearTimeout(timer); resolve(win); }, 250));
    win.webContents.once('did-fail-load', (e, code, desc) => { clearTimeout(timer); try { win.close(); } catch (_) {} reject(new Error(`Label failed to render: ${desc}`)); });
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}
async function printLabelHtml(html, { deviceName, copies = 1 } = {}) {
  if (!deviceName) throw new Error('No label printer chosen — set one in Admin → This device.');
  const win = await renderLabelWindow(html);
  try {
    await new Promise((resolve, reject) => {
      win.webContents.print(
        { silent: true, printBackground: true, deviceName, copies: Math.max(1, Number(copies) || 1), margins: { marginType: 'none' }, pageSize: LABEL_PAGE },
        (ok, reason) => (ok ? resolve() : reject(new Error(reason || 'Print failed')))
      );
    });
  } finally {
    try { win.close(); } catch (_) {}
  }
}
async function labelHtmlToPdf(html) {
  const win = await renderLabelWindow(html);
  try {
    return await win.webContents.printToPDF({ printBackground: true, margins: { marginType: 'none' }, pageSize: { width: 4, height: 6 } });
  } finally {
    try { win.close(); } catch (_) {}
  }
}
ipcMain.handle('siamshop:print-label', async (event, payload) => {
  try {
    const { html, copies } = payload || {};
    if (!html) return { ok: false, error: 'Nothing to print' };
    await printLabelHtml(html, { deviceName: rendererConfig().labelPrinter, copies });
    return { ok: true };
  } catch (e) {
    console.error('[label] print failed:', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('siamshop:get-version', () => { try { return app.getVersion(); } catch (_) { return null; } });
ipcMain.handle('siamshop:check-for-updates', async () => {
  if (!autoUpdater) return { ok: false, reason: 'not-packaged' };
  try { const r = await autoUpdater.checkForUpdates(); return { ok: true, version: r?.updateInfo?.version || null }; }
  catch (e) { return { ok: false, reason: 'error', message: e?.message || String(e) }; }
});
ipcMain.handle('siamshop:restart-to-update', () => { try { autoUpdater && autoUpdater.quitAndInstall(); } catch (e) { console.warn('[updater] quitAndInstall failed:', e?.message || e); } });
ipcMain.handle('siamshop:quit-app', () => app.quit());

// ── Clipboard / context menu (keyboard-less tills, Windows Ctrl+V) ──────────
function enableClipboardShortcuts(win) {
  const wc = win.webContents;
  wc.on('context-menu', (event, params) => {
    const f = params.editFlags || {};
    Menu.buildFromTemplate([
      { role: 'cut', enabled: !!f.canCut }, { role: 'copy', enabled: !!f.canCopy }, { role: 'paste', enabled: !!f.canPaste },
      { type: 'separator' }, { role: 'selectAll' },
    ]).popup({ window: win });
  });
  if (process.platform !== 'darwin') {
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
      const key = (input.key || '').toLowerCase();
      if (key === 'v') { wc.paste(); event.preventDefault(); }
      else if (key === 'c') { wc.copy(); event.preventDefault(); }
      else if (key === 'x') { wc.cut(); event.preventDefault(); }
      else if (key === 'a') { wc.selectAll(); event.preventDefault(); }
    });
  }
}

// ── First-run wizard ────────────────────────────────────────────────────────
async function runSetupWizard() {
  return new Promise((resolve) => {
    const setupWin = new BrowserWindow({
      width: 580, height: 720, title: 'SiamShop — First-time Setup',
      resizable: false, minimizable: false, maximizable: false,
      backgroundColor: '#0D1B3E', icon: APP_ICON_PATH, autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    setupWin.setMenuBarVisibility(false);
    enableClipboardShortcuts(setupWin);

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>SiamShop — First-time Setup</title>
<style>
  body { margin:0; padding:32px 36px 24px; background:#0D1B3E; color:white; font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; }
  h1 { margin:0 0 4px; font-size:24px; color:#C9A84C; font-family: Georgia, 'Times New Roman', serif; }
  .subtitle { color:rgba(201,168,76,0.65); font-size:12px; letter-spacing:0.08em; text-transform:uppercase; margin-bottom:14px; }
  .intro { font-size:13px; color:rgba(255,255,255,0.7); line-height:1.6; margin-bottom:16px; }
  label { display:block; font-size:12px; font-weight:700; color:rgba(255,255,255,0.85); margin:12px 0 6px; text-transform:uppercase; letter-spacing:0.05em; }
  .fieldrow { display:flex; gap:8px; align-items:stretch; }
  .fieldrow input { flex:1; }
  .pastebtn { flex:none; width:auto; margin-top:0; padding:0 14px; border-radius:10px; cursor:pointer; border:1px solid rgba(201,168,76,0.4); background:rgba(201,168,76,0.12); color:#C9A84C; font-size:12px; font-weight:700; white-space:nowrap; }
  input { width:100%; padding:10px 14px; border-radius:10px; border:1px solid rgba(201,168,76,0.3); background:rgba(255,255,255,0.05); color:white; font-size:15px; box-sizing:border-box; font-family:inherit; }
  input:focus { outline:none; border-color:#C9A84C; background:rgba(255,255,255,0.08); }
  .hint { font-size:11px; color:rgba(255,255,255,0.45); margin-top:4px; }
  .grid2 { display:grid; grid-template-columns: 2fr 1fr; gap:8px; }
  #error { display:none; background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.4); color:#fca5a5; padding:10px 14px; border-radius:8px; font-size:13px; margin-top:14px; }
  #error.show { display:block; }
  button { width:100%; margin-top:14px; padding:13px; border-radius:10px; border:none; cursor:pointer; background:#C9A84C; color:#0D1B3E; font-weight:700; font-size:15px; }
  button:disabled { background:rgba(201,168,76,0.3); color:rgba(13,27,62,0.5); cursor:not-allowed; }
  .secondary { background:rgba(255,255,255,0.1); color:#fff; border:1px solid rgba(255,255,255,0.25); margin-top:18px; }
</style></head>
<body>
  <h1>Welcome to SiamShop</h1>
  <div class="subtitle">First-time setup — this till</div>
  <div class="intro">Connect this device to your shop in the cloud. Saved on this device only; done once.</div>

  <label for="name">Shop name</label>
  <div class="fieldrow"><input id="name" type="text" placeholder="e.g. Cha &amp; Pinto Box" autofocus /><button type="button" class="pastebtn" data-for="name">📋 Paste</button></div>

  <label for="url">Cloud URL</label>
  <div class="fieldrow"><input id="url" type="url" placeholder="https://your-shop.up.railway.app" /><button type="button" class="pastebtn" data-for="url">📋 Paste</button></div>
  <div class="hint">The address of your SiamShop cloud (the same one your website uses).</div>

  <label for="slug">Shop ID</label>
  <div class="fieldrow"><input id="slug" type="text" placeholder="e.g. chapinto" /><button type="button" class="pastebtn" data-for="slug">📋 Paste</button></div>
  <div class="hint">Lowercase letters, numbers and dashes — identifies this shop in the cloud.</div>

  <label>Receipt printer <span style="color:rgba(255,255,255,0.4);text-transform:none;font-weight:400;letter-spacing:0;">(optional — can be set later in Admin → This device)</span></label>
  <div class="grid2"><input id="pip" type="text" placeholder="Printer IP, e.g. 192.168.1.50" /><input id="pport" type="text" placeholder="Port (9100)" /></div>
  <div class="hint">Or leave the IP blank and type the printer's name as shown on your device for a USB printer:</div>
  <input id="pname" type="text" placeholder="USB printer name (optional)" style="margin-top:6px" />

  <div id="error"></div>
  <button id="loadfile" type="button" class="secondary">📁 Load from config.json file</button>
  <button id="save">Save &amp; open the till</button>
<script>
  const $ = (id) => document.getElementById(id);
  const errEl = $('error'), btn = $('save');
  const showError = (m) => { errEl.textContent = m; errEl.classList.add('show'); };
  const clearError = () => errEl.classList.remove('show');
  document.querySelectorAll('.pastebtn').forEach((pb) => pb.addEventListener('click', async () => {
    try {
      const t = String(await window.electron.readClipboard() || '').trim();
      if (!t) return showError('Clipboard is empty — copy the value first.');
      const el = $(pb.dataset.for); el.value = t; el.focus(); clearError();
    } catch (e) { showError('Could not read the clipboard: ' + e); }
  }));
  $('loadfile').addEventListener('click', async () => {
    clearError();
    try {
      const d = await window.electron.pickConfigFile();
      if (!d) return;
      if (d.error) return showError('Could not read that file: ' + d.error);
      if (d.shop_name) $('name').value = d.shop_name;
      if (d.cloud_api_url) $('url').value = d.cloud_api_url;
      if (d.shop_slug) $('slug').value = d.shop_slug;
      if (d.printer_ip) $('pip').value = d.printer_ip;
      if (d.printer_port) $('pport').value = d.printer_port;
      if (d.printer_name) $('pname').value = d.printer_name;
    } catch (e) { showError('Could not load the file: ' + e); }
  });
  btn.addEventListener('click', async () => {
    clearError();
    const data = {
      shop_name: $('name').value.trim(), cloud_api_url: $('url').value.trim(), shop_slug: $('slug').value.trim(),
      printer: { ip: $('pip').value.trim(), port: $('pport').value.trim() || 9100, name: $('pname').value.trim(), autoPrint: true, kickDrawerOnCash: true },
    };
    if (!data.shop_name || !data.cloud_api_url || !data.shop_slug) return showError('Please fill in shop name, cloud URL and shop ID.');
    if (!/^https?:\\/\\//i.test(data.cloud_api_url)) return showError('Cloud URL must start with http:// or https://');
    if (!/^[a-z0-9-]+$/i.test(data.shop_slug)) return showError('Shop ID can only contain letters, numbers and dashes.');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const result = await window.electron.saveConfig(data);
      if (result && result.success) window.close();
      else { showError((result && result.error) || 'Failed to save.'); btn.disabled = false; btn.textContent = 'Save & open the till'; }
    } catch (e) { showError(String(e)); btn.disabled = false; btn.textContent = 'Save & open the till'; }
  });
<\/script>
</body></html>`;
    setupWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    setupWin.on('closed', () => resolve(loadConfig()));
  });
}

// ── Main window ─────────────────────────────────────────────────────────────
function resolveClientIndex() {
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'client-dist', 'index.html');
    if (fs.existsSync(packaged)) return packaged;
  }
  const local = path.join(PROJECT_ROOT, 'client', 'dist-electron', 'index.html');
  if (fs.existsSync(local)) return local;
  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    fullscreen: app.isPackaged, width: 1280, height: 800, minWidth: 1024, minHeight: 600,
    backgroundColor: '#0D1B3E', title: 'SiamShop', icon: APP_ICON_PATH, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  enableClipboardShortcuts(mainWindow);

  const forceDev = process.env.ELECTRON_DEV === '1';
  const indexFile = resolveClientIndex();
  if (forceDev || (!indexFile && !app.isPackaged)) {
    mainWindow.loadURL(DEV_URL).catch((err) => console.error('[siamshop] dev URL failed — is `npm run dev` running in client/?', err.message));
  } else if (indexFile) {
    // Hash router: open straight on the till.
    mainWindow.loadFile(indexFile, { hash: '/till' });
  } else {
    console.error('[siamshop] no client build found. Run `npm run build:electron-client` first.');
  }

  // External links → OS browser; nothing else opens new Electron windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // Dev-only canary hook: SIAMSHOP_SCREENSHOT=/path.png captures the window a
  // few seconds after load (lets a headless check confirm the till renders).
  // Dev-only: surface renderer console errors in the terminal (canary runs).
  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', (e, level, message, line, source) => {
      if (level >= 2) console.log(`[renderer:${level}] ${message} (${String(source).split('/').pop()}:${line})`);
    });
  }
  if (!app.isPackaged && process.env.SIAMSHOP_SCREENSHOT) {
    mainWindow.webContents.once('did-finish-load', () => {
      // Optional: sign the canary in first (SIAMSHOP_CANARY_TOKEN = a staff/owner token).
      if (process.env.SIAMSHOP_CANARY_TOKEN) {
        mainWindow.webContents.executeJavaScript(`localStorage.setItem('siamshop_admin_token', ${JSON.stringify(process.env.SIAMSHOP_CANARY_TOKEN)}); localStorage.setItem('siamshop_staff', JSON.stringify({ name: 'Canary', role: 'manager' })); history.replaceState(null, '', '#' + ${JSON.stringify(process.env.SIAMSHOP_CANARY_HASH || '/till')}); location.reload();`, true).catch(() => {});
      }
      setTimeout(async () => {
        try {
          const diag = await mainWindow.webContents.executeJavaScript(`(async () => {
            const tok = localStorage.getItem('siamshop_admin_token') || '';
            let me = null; try { const r = await fetch((window.electron?.config?.cloudApiUrl || '') + '/api/admin/me?shop=' + (window.electron?.config?.shopSlug || ''), { headers: { Authorization: 'Bearer ' + tok } }); me = r.status + ' ' + (await r.text()).slice(0, 80); } catch (e) { me = 'ERR ' + e.message; }
            return { href: location.href, hasToken: !!tok, staff: localStorage.getItem('siamshop_staff'), me, text: document.body.innerText.slice(0, 160).split(String.fromCharCode(10)).join(' / ') };
          })()`, true);
          console.log('[canary] diag:', JSON.stringify(diag));
          const img = await mainWindow.capturePage();
          fs.writeFileSync(process.env.SIAMSHOP_SCREENSHOT, img.toPNG());
          console.log('[canary] screenshot written:', process.env.SIAMSHOP_SCREENSHOT);
        } catch (e) { console.warn('[canary] screenshot failed:', e.message); }
      }, Number(process.env.SIAMSHOP_SCREENSHOT_DELAY_MS) || 4000);
    });
  }
}

function createTray() {
  const trayImage = fs.existsSync(APP_ICON_PATH) ? nativeImage.createFromPath(APP_ICON_PATH).resize({ width: 22, height: 22 }) : nativeImage.createEmpty();
  tray = new Tray(trayImage);
  tray.setToolTip('SiamShop');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show SiamShop', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else createWindow(); } },
    { type: 'separator' },
    { label: 'Printer test page', click: () => printService.testPrint(printerCfg()).catch((e) => dialog.showErrorBox('Printer test failed', e.message)) },
    { label: 'Open cash drawer', click: () => printService.openCashDrawer(printerCfg()).catch((e) => dialog.showErrorBox('Cash drawer', e.message)) },
    { type: 'separator' },
    { label: 'Quit SiamShop', click: () => app.quit() },
  ]));
}

// ── Auto-update (electron-updater → github kongponsrisiri-coder/siamshop-releases) ──
function setupAutoUpdater() {
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = true;
    try {
      const logDir = app.getPath('logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'updater.log');
      const write = (level, ...args) => {
        const line = `[${new Date().toISOString()}] ${level} ${args.map((a) => (a && a.stack) || (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}\n`;
        try { fs.appendFileSync(logFile, line); } catch (_) {}
      };
      autoUpdater.logger = {
        info: (...a) => { write('INFO', ...a); console.log('[updater]', ...a); },
        warn: (...a) => { write('WARN', ...a); console.warn('[updater]', ...a); },
        error: (...a) => { write('ERROR', ...a); console.error('[updater]', ...a); },
        debug: (...a) => write('DEBUG', ...a),
      };
    } catch (e) { console.warn('[updater] file logger not set:', e?.message || e); }
    const sendStatus = (payload) => { try { if (mainWindow) mainWindow.webContents.send('siamshop:update-status', payload); } catch (_) {} };
    autoUpdater.on('checking-for-update', () => sendStatus({ state: 'checking' }));
    autoUpdater.on('update-available', (info) => sendStatus({ state: 'available', version: info?.version }));
    autoUpdater.on('update-not-available', () => sendStatus({ state: 'not-available' }));
    autoUpdater.on('download-progress', (p) => sendStatus({ state: 'downloading', percent: Math.round(p?.percent || 0) }));
    autoUpdater.on('error', (err) => sendStatus({ state: 'error', message: err?.message || String(err) }));
    autoUpdater.on('update-downloaded', (info) => sendStatus({ state: 'downloaded', version: info?.version }));
    autoUpdater.checkForUpdatesAndNotify().catch((err) => console.warn('[updater] check skipped:', err?.message || err));
  } catch (err) {
    console.warn('[updater] not initialised:', err?.message || err);
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  if (process.platform === 'win32') { try { app.setAppUserModelId(APP_ID); } catch (err) { console.warn('[win] setAppUserModelId failed:', err.message); } }
  if (process.platform === 'darwin' && app.dock && fs.existsSync(APP_ICON_PATH)) { try { app.dock.setIcon(APP_ICON_PATH); } catch (_) {} }

  let config = loadConfig();
  let justSetUp = false;
  if (!config) {
    config = await runSetupWizard();
    if (!config) { console.log('[setup] cancelled — quitting'); app.quit(); return; }
    justSetUp = true;
    console.log('[setup] complete:', config.shop_name, '→', config.cloud_api_url);
  }
  if (justSetUp && app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32')) {
    try { app.setLoginItemSettings({ openAtLogin: true, openAsHidden: false }); } catch (err) { console.warn('[setup] login-item failed:', err.message); }
  }

  // Dev-only rig (SIAMSHOP-POST-001): SIAMSHOP_LABEL_HTML=<file> SIAMSHOP_LABEL_PDF=<out.pdf>
  // renders the label through the same hidden-window path and writes a PDF, then quits.
  if (!app.isPackaged && process.env.SIAMSHOP_LABEL_HTML && process.env.SIAMSHOP_LABEL_PDF) {
    try {
      const pdf = await labelHtmlToPdf(fs.readFileSync(process.env.SIAMSHOP_LABEL_HTML, 'utf8'));
      fs.writeFileSync(process.env.SIAMSHOP_LABEL_PDF, pdf);
      console.log('[label-rig] pdf written:', process.env.SIAMSHOP_LABEL_PDF, pdf.length, 'bytes');
    } catch (e) { console.error('[label-rig] failed:', e.message); }
    app.exit(0);
    return;
  }

  createWindow();
  createTray();
  if (app.isPackaged) setupAutoUpdater();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Keep running in the tray when the window is closed; quit via tray/Exit.
app.on('window-all-closed', () => {});
