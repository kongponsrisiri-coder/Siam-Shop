import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { desktop, electronConfig } from '../../electron.js';
import { createScanCapture, SUFFIX_KEYS } from '../../scanner.js';
import PrintersCard from '../../components/PrintersCard.jsx';
import { resolvePrinters, printerDest, invalidatePrinters } from '../../printers.js';
import { staffSession } from '../../api.js';

// "This device" (desktop till only — SIAMSHOP-ELECTRON-001 / DEVICE-001):
// receipt printer + drawer (found on the LAN, not typed), barcode scanner,
// label printer, app version + updates. Everything here lives in the device's
// own config.json, not in the shop's cloud settings.
const EMPTY_PRINTER = { ip: '', port: 9100, name: '', lprQueue: 'lp', autoPrint: true, kickDrawerOnCash: true, model: '' };
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export default function DeviceSection() {
  const [cfg, setCfg] = useState(null);
  // SIAMSHOP-PRINTERS-001 — shop-wide list; per device: receipt printer + printing-till flag.
  const [shopPrinters, setShopPrinters] = useState(null); // { printers, printing_device_id }
  const [tillMsg, setTillMsg] = useState('');
  const me = staffSession.get();
  const isManager = !me || me.role === 'manager' || me.role === 'admin';
  const loadShopPrinters = () => api.printers().then(setShopPrinters).catch(() => setShopPrinters({ printers: [] }));
  const [printer, setPrinter] = useState(EMPTY_PRINTER);
  const [editing, setEditing] = useState(false); // saved printer shows as a card; "Change" opens the fields
  const [osPrinters, setOsPrinters] = useState([]);
  const [scan, setScan] = useState(null); // { busy, printers, subnet, message, error }
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [update, setUpdate] = useState(null);
  // Barcode scanner (D2)
  const [scanner, setScanner] = useState({ suffix: 'enter', captureAnywhere: true });
  const [scannerMsg, setScannerMsg] = useState('');
  const [lastScan, setLastScan] = useState(null); // { code, product, at }
  const testBoxRef = useRef(null);
  const [testBox, setTestBox] = useState('');

  useEffect(() => {
    desktop.getConfig().then((c) => {
      setCfg(c);
      const p = { ...EMPTY_PRINTER, ...(c?.printer || {}) };
      setPrinter(p);
      setEditing(!(p.ip || p.name)); // fresh install → fields (empty); configured → card
      if (c?.scanner) setScanner({ suffix: c.scanner.suffix || 'enter', captureAnywhere: c.scanner.captureAnywhere !== false });
    }).catch(() => setEditing(true));
    desktop.listPrinters().then(setOsPrinters).catch(() => {});
    loadShopPrinters();
    desktop.onUpdateStatus((s) => setUpdate(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k, v) => setPrinter((p) => ({ ...p, [k]: v }));
  const resolved = shopPrinters ? resolvePrinters(shopPrinters, cfg || electronConfig) : null;
  const receiptChoices = (shopPrinters?.printers || []).filter((p) => p.job === 'receipt' && p.active !== false);
  const isPrintingTill = !!cfg?.deviceId && shopPrinters?.printing_device_id === cfg.deviceId;
  async function chooseReceiptPrinter(id) {
    setTillMsg('');
    const r = await desktop.saveConfig({ receipt_printer_id: id ? Number(id) : null });
    if (r?.success) { setCfg(r.config); invalidatePrinters(); setTillMsg(id ? 'Saved — receipts and the drawer now use this printer.' : 'No receipt printer chosen for this till.'); }
    else setTillMsg(`Could not save: ${r?.error || 'unknown'}`);
  }
  async function setPrintingTill(on) {
    setTillMsg('');
    try {
      await api.adminSetPrintingDevice(on ? cfg.deviceId : '');
      await desktop.saveConfig({ printing_till: on });
      await loadShopPrinters();
      setTillMsg(on ? 'This till now prints prep tickets for online orders.' : 'This till no longer prints online orders\' tickets.');
    } catch (e) { setTillMsg(e.message); }
  }
  async function testTillPrinter() {
    setBusy(true); setTillMsg('Sending test page…');
    const dest = resolved?.receipt ? printerDest(resolved.receipt) : printer;
    const r = await desktop.testPrint(dest);
    if (resolved?.receipt) api.printerTestResult(resolved.receipt.id, !!r?.ok).catch(() => {}).then(loadShopPrinters);
    setTillMsg(r?.ok ? 'Test page sent — check the printer.' : `Test failed: ${r?.error}`);
    setBusy(false);
  }
  async function tillDrawer() {
    setBusy(true); setTillMsg('');
    const r = await desktop.kickDrawer(resolved?.receiptDest || undefined);
    setTillMsg(r?.ok ? 'Drawer pulse sent.' : `Drawer failed: ${r?.error}`);
    setBusy(false);
  }
  const hasPrinter = !!(printer.ip || printer.name);

  async function save() {
    setBusy(true); setMsg('');
    const r = await desktop.saveConfig({ printer });
    if (r?.success) { setMsg('Saved — takes effect on the next receipt.'); setCfg(r.config); setEditing(false); setPrinter({ ...EMPTY_PRINTER, ...(r.config?.printer || {}) }); }
    else setMsg(`Could not save: ${r?.error || 'unknown'}`);
    setBusy(false);
  }
  async function test() {
    setBusy(true); setMsg('Sending test page…');
    const r = await desktop.testPrint(printer);
    setMsg(r?.ok ? 'Test page sent — check the printer.' : `Test failed: ${r?.error}`);
    // refresh the "last test" stamp on the card
    desktop.getConfig().then((c) => { setCfg(c); if (c?.printer) setPrinter((p) => ({ ...p, lastTestAt: c.printer.lastTestAt, lastTestOk: c.printer.lastTestOk })); }).catch(() => {});
    setBusy(false);
  }
  async function drawer() {
    setBusy(true); setMsg('');
    const r = await desktop.kickDrawer();
    setMsg(r?.ok ? 'Drawer pulse sent.' : `Drawer failed: ${r?.error}`);
    setBusy(false);
  }
  async function findPrinters() {
    setScan({ busy: true });
    const r = await desktop.scanPrinters();
    setScan({ busy: false, ...r });
  }
  function pick(p) {
    setPrinter((cur) => ({ ...cur, ip: p.ip, port: p.port || 9100, name: '', model: p.model || '' }));
    setMsg(`Selected ${p.ip} — press "Print test page", then "Save printer".`);
  }
  async function check() {
    setMsg('');
    const r = await desktop.checkForUpdates();
    if (!r?.ok) setMsg(r?.reason === 'not-packaged' ? 'Updates only run in the installed app.' : `Update check failed: ${r?.message || r?.reason}`);
  }

  // Test-scan box: a wedge scanner types into it; the suffix (or a pause, for
  // "none") completes the code, which we look up so staff see the product.
  useEffect(() => {
    const el = testBoxRef.current;
    if (!el) return undefined;
    const cap = createScanCapture({
      suffix: scanner.suffix, minLength: 3, maxGapMs: 400, // lenient: allow slow "typed-fast" tests
      onScan: async (code) => {
        setTestBox('');
        let product = null;
        try { product = await api.lookupBarcode(code); } catch { product = null; }
        setLastScan({ code, product, at: new Date().toISOString() });
      },
    });
    const onKey = (e) => cap.handleKey({ key: e.key, now: performance.now(), target: e.target, preventDefault: () => e.preventDefault() });
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [scanner.suffix]);
  async function saveScanner() {
    const r = await desktop.saveConfig({ scanner });
    setScannerMsg(r?.success ? 'Saved — the Till uses this from its next open.' : `Could not save: ${r?.error || 'unknown'}`);
  }

  const updateText = !update ? '' :
    update.state === 'checking' ? 'Checking for updates…' :
    update.state === 'available' ? `Update ${update.version} found — downloading…` :
    update.state === 'downloading' ? `Downloading update… ${update.percent}%` :
    update.state === 'downloaded' ? `Update ${update.version} ready — restart to install.` :
    update.state === 'not-available' ? 'You are on the latest version.' :
    update.state === 'error' ? `Update error: ${update.message}` : '';

  const usbLabel = (p) => p.label || p.displayName || p.name;

  return (
    <div>
      <h2>This device</h2>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Connection</h3>
        <table><tbody>
          <tr><th>Shop</th><td>{cfg?.shopName || electronConfig.shopName || '—'}</td></tr>
          <tr><th>Shop ID</th><td>{cfg?.shopSlug || electronConfig.shopSlug || '—'}</td></tr>
          <tr><th>Cloud</th><td>{cfg?.cloudApiUrl || electronConfig.cloudApiUrl || '—'}</td></tr>
        </tbody></table>
        <p className="desktop-note" style={{ marginTop: 8 }}>
          To move this device to a different shop, use "Reset this device" below — the shop's data stays in the cloud.
        </p>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>This till</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Which of the shop's printers this computer uses for receipts (the one its cash drawer is plugged into). Printers themselves are added to the shared list below.</p>
        {shopPrinters && receiptChoices.length === 0 && <p className="muted" style={{ fontSize: 13 }}>No receipt printer in the list yet — add one below, then choose it here.{hasPrinter ? ' Until then this till keeps using its old printer setting.' : ''}</p>}
        <label>Receipt printer for this till</label>
        <select value={cfg?.receiptPrinterId || ''} onChange={(e) => chooseReceiptPrinter(e.target.value)}>
          <option value="">— none —</option>
          {receiptChoices.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.kind === 'usb' ? p.usb_name : p.ip}</option>)}
        </select>
        {resolved?.receipt && (
          <div className="device-card" style={{ marginTop: 8 }}>
            <div className="device-icon">🧾</div>
            <div className="device-main">
              <div className="device-title">{resolved.receipt.name}{resolved.receipt.model ? ` · ${resolved.receipt.model}` : ''}</div>
              <div className="device-sub">{resolved.receipt.kind === 'usb' ? `USB · ${resolved.receipt.usb_name}` : `${resolved.receipt.ip}${Number(resolved.receipt.port) !== 9100 ? `:${resolved.receipt.port}` : ''}`} · {resolved.receipt.last_test_at ? `last test ${resolved.receipt.last_test_ok ? 'OK' : 'FAILED'} ${fmtWhen(resolved.receipt.last_test_at)}` : 'not tested yet'}</div>
            </div>
          </div>
        )}
        <label className="row" style={{ marginTop: 10, gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={printer.autoPrint !== false} onChange={(e) => { set('autoPrint', e.target.checked); desktop.saveConfig({ printer: { autoPrint: e.target.checked } }); }} />
          <span>Print a receipt automatically after every sale</span>
        </label>
        <label className="row" style={{ marginTop: 6, gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={printer.kickDrawerOnCash !== false} onChange={(e) => { set('kickDrawerOnCash', e.target.checked); desktop.saveConfig({ printer: { kickDrawerOnCash: e.target.checked } }); }} />
          <span>Open the cash drawer on cash sales</span>
        </label>
        <label className="row" style={{ marginTop: 6, gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={isPrintingTill} disabled={!isManager || !cfg?.deviceId} onChange={(e) => setPrintingTill(e.target.checked)} />
          <span>This till prints online orders' prep tickets{shopPrinters?.printing_device_id && !isPrintingTill ? <span className="muted"> (another till has this today)</span> : ''}</span>
        </label>
        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
          <button className="btn secondary" disabled={busy || !(resolved?.receipt || hasPrinter)} onClick={testTillPrinter}>🖨 Print test page</button>
          <button className="btn secondary" disabled={busy || !(resolved?.receipt || hasPrinter)} onClick={tillDrawer}>💵 Open drawer</button>
        </div>
        {tillMsg && <p style={{ fontSize: 13, marginTop: 8 }}>{tillMsg}</p>}
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Device id: {cfg?.deviceId ? cfg.deviceId.slice(0, 8) : '—'}</p>
      </div>

      <PrintersCard isManager={isManager} onChanged={() => { invalidatePrinters(); loadShopPrinters(); }} />

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Barcode scanner</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          A USB scanner works like a keyboard — nothing to install. Scan something into the box below to check it reads and matches a product.
        </p>
        <label>Test scan — click here, then scan</label>
        <input ref={testBoxRef} className="test-scan-box" value={testBox} onChange={(e) => setTestBox(e.target.value)} placeholder="waiting for a scan…" />
        {lastScan && (
          <div className={`device-card`} style={{ marginTop: 8 }}>
            <div className="device-icon">{lastScan.product ? '✅' : '❓'}</div>
            <div className="device-main">
              <div className="device-title">{lastScan.code}</div>
              <div className="device-sub">{lastScan.product ? `${lastScan.product.name} · £${Number(lastScan.product.price).toFixed(2)}` : 'Read OK, but no product has this barcode — add it in Admin → Products'} · {fmtWhen(lastScan.at)}</div>
            </div>
          </div>
        )}
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginTop: 10, alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 200px' }}>
            <label>Key the scanner sends after each code</label>
            <select value={scanner.suffix} onChange={(e) => setScanner((s) => ({ ...s, suffix: e.target.value }))}>
              <option value="enter">Enter (most scanners)</option>
              <option value="tab">Tab</option>
              <option value="none">Nothing — detect by speed</option>
            </select>
          </div>
          <label className="row" style={{ gap: 8, flex: '2 1 260px', marginBottom: 6 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={scanner.captureAnywhere} onChange={(e) => setScanner((s) => ({ ...s, captureAnywhere: e.target.checked }))} />
            <span>Accept scans anywhere on the Till, even when the cursor is in another box</span>
          </label>
        </div>
        <div className="row" style={{ marginTop: 10, gap: 8 }}>
          <button className="btn" onClick={saveScanner}>Save scanner</button>
          {scannerMsg && <span className="muted" style={{ fontSize: 13 }}>{scannerMsg}</span>}
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Suffix in use: {SUFFIX_KEYS[scanner.suffix] || 'none'}. The phone Scan app is separate and needs no setup.</p>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>App &amp; updates</h3>
        <p style={{ margin: '0 0 8px' }}>SiamShop desktop {cfg?.version ? `v${cfg.version}` : ''}</p>
        {updateText && <p className="muted" style={{ fontSize: 13 }}>{updateText}</p>}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn secondary" onClick={check}>Check for updates</button>
          {update?.state === 'downloaded' && <button className="btn" onClick={() => desktop.restartToUpdate()}>Restart to update</button>}
        </div>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Reset this device</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Clears the shop connection and printer settings on this device only, then reopens the setup screen. Nothing in the cloud is changed.</p>
        <button className="btn cancel-btn" onClick={() => { if (confirm('Reset this device and return to setup?')) desktop.resetConfig(); }}>Reset this device</button>
      </div>
    </div>
  );
}
