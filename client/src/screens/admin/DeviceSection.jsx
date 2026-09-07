import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { desktop, electronConfig } from '../../electron.js';
import { buildLabelHtml, SAMPLE_LABEL } from '../../label.js';
import { createScanCapture, SUFFIX_KEYS } from '../../scanner.js';

// "This device" (desktop till only — SIAMSHOP-ELECTRON-001 / DEVICE-001):
// receipt printer + drawer (found on the LAN, not typed), barcode scanner,
// label printer, app version + updates. Everything here lives in the device's
// own config.json, not in the shop's cloud settings.
const EMPTY_PRINTER = { ip: '', port: 9100, name: '', lprQueue: 'lp', autoPrint: true, kickDrawerOnCash: true, model: '' };
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export default function DeviceSection() {
  const [cfg, setCfg] = useState(null);
  const [printer, setPrinter] = useState(EMPTY_PRINTER);
  const [editing, setEditing] = useState(false); // saved printer shows as a card; "Change" opens the fields
  const [osPrinters, setOsPrinters] = useState([]);
  const [scan, setScan] = useState(null); // { busy, printers, subnet, message, error }
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [update, setUpdate] = useState(null);
  const [labelPrinter, setLabelPrinter] = useState('');
  const [labelMsg, setLabelMsg] = useState('');
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
      setLabelPrinter(c?.labelPrinter || '');
      if (c?.scanner) setScanner({ suffix: c.scanner.suffix || 'enter', captureAnywhere: c.scanner.captureAnywhere !== false });
    }).catch(() => setEditing(true));
    desktop.listPrinters().then(setOsPrinters).catch(() => {});
    desktop.onUpdateStatus((s) => setUpdate(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k, v) => setPrinter((p) => ({ ...p, [k]: v }));
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
        <h3 style={{ marginTop: 0 }}>Receipt printer &amp; cash drawer</h3>
        {!editing && hasPrinter ? (
          <div className="device-card">
            <div className="device-icon">🖨</div>
            <div className="device-main">
              <div className="device-title">Receipt printer: {printer.ip ? `${printer.ip}${Number(printer.port) !== 9100 ? `:${printer.port}` : ''}` : printer.name}{printer.model ? ` · ${printer.model}` : ''}</div>
              <div className="device-sub">
                {printer.lastTestAt ? `Last test ${printer.lastTestOk ? 'OK' : 'FAILED'} ${fmtWhen(printer.lastTestAt)}` : 'Not tested yet'}
                {' · '}{printer.autoPrint !== false ? 'auto-prints receipts' : 'manual receipts'}
                {' · '}{printer.kickDrawerOnCash !== false ? 'opens drawer on cash' : 'drawer off'}
              </div>
            </div>
            <button className="btn secondary" disabled={busy} onClick={() => setEditing(true)}>Change</button>
          </div>
        ) : (
          <>
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
              Most receipt printers are on the shop's network — press <strong>Find printers</strong> and pick yours.
              A USB printer installed on this computer is chosen from the list instead. The cash drawer plugs into the receipt printer.
            </p>
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn" disabled={scan?.busy} onClick={findPrinters}>{scan?.busy ? 'Looking on your network…' : '🔍 Find printers'}</button>
              {scan && !scan.busy && <span className="muted" style={{ fontSize: 13 }}>{scan.error ? `Scan failed: ${scan.error}` : scan.printers?.length ? `${scan.printers.length} found on ${scan.subnet}` : (scan.message || `Nothing answered on ${scan.subnet || 'your network'} — is the printer on and plugged into the router?`)}</span>}
            </div>
            {scan?.printers?.length > 0 && (
              <div className="scan-list">
                {scan.printers.map((p) => (
                  <div key={p.ip} className={`scan-hit ${printer.ip === p.ip ? 'on' : ''}`}>
                    <span>🖨 <strong>{p.ip}</strong>{p.model ? <span className="muted"> · {p.model}</span> : <span className="muted"> · network receipt printer (port {p.port})</span>}</span>
                    <button type="button" className="btn mini secondary" onClick={() => pick(p)}>{printer.ip === p.ip ? 'Selected' : 'Use this'}</button>
                  </div>
                ))}
              </div>
            )}
            <details style={{ marginTop: 10 }} open={!!printer.ip && !scan?.printers?.some((p) => p.ip === printer.ip)}>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 13 }}>Enter the address by hand</summary>
              <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
                <div style={{ flex: '2 1 200px' }}>
                  <label>Printer IP</label>
                  <input value={printer.ip} onChange={(e) => set('ip', e.target.value)} placeholder="e.g. 192.168.1.50" />
                </div>
                <div style={{ flex: '1 1 100px' }}>
                  <label>Port</label>
                  <input type="number" value={printer.port} onChange={(e) => set('port', e.target.value)} />
                </div>
                <div style={{ flex: '1 1 100px' }}>
                  <label>LPR queue</label>
                  <input value={printer.lprQueue} onChange={(e) => set('lprQueue', e.target.value)} placeholder="lp" />
                </div>
              </div>
            </details>
            <label style={{ marginTop: 10 }}>USB printer on this computer (instead of a network address)</label>
            <select value={printer.name} onChange={(e) => { const q = osPrinters.find((p) => p.name === e.target.value); setPrinter((cur) => ({ ...cur, name: e.target.value, model: q?.model || q?.label || '', ...(e.target.value ? { ip: '' } : {}) })); }}>
              <option value="">— none —</option>
              {osPrinters.map((p) => <option key={p.name} value={p.name}>{usbLabel(p)}{p.queue && p.queue !== usbLabel(p) ? ` (${p.queue})` : ''}{p.isDefault ? ' · default' : ''}</option>)}
            </select>
            <label className="row" style={{ marginTop: 10, gap: 8 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={printer.autoPrint !== false} onChange={(e) => set('autoPrint', e.target.checked)} />
              <span>Print a receipt automatically after every sale</span>
            </label>
            <label className="row" style={{ marginTop: 6, gap: 8 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={printer.kickDrawerOnCash !== false} onChange={(e) => set('kickDrawerOnCash', e.target.checked)} />
              <span>Open the cash drawer on cash sales</span>
            </label>
          </>
        )}
        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
          {editing && <button className="btn" disabled={busy || !hasPrinter} onClick={save}>Save printer</button>}
          {editing && hasPrinter && (cfg?.printer?.ip || cfg?.printer?.name) && <button className="btn ghost" disabled={busy} onClick={() => { setPrinter({ ...EMPTY_PRINTER, ...(cfg?.printer || {}) }); setEditing(false); setMsg(''); }}>Cancel</button>}
          <button className="btn secondary" disabled={busy || !hasPrinter} onClick={test}>🖨 Print test page</button>
          <button className="btn secondary" disabled={busy || !hasPrinter} onClick={drawer}>💵 Open drawer</button>
        </div>
        {msg && <p style={{ fontSize: 13, marginTop: 8 }}>{msg}</p>}
      </div>

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
        <h3 style={{ marginTop: 0 }}>Parcel label printer (4×6 in)</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          For postal orders. A direct-thermal 4×6 label printer installed on this computer with its own driver
          (Rollo, MUNBYN, Zebra ZD220/GK420, Brother QL-1110). Labels print through the driver, so any brand works.
          Not app-only Bluetooth minis. Royal Mail Click &amp; Drop postage PDFs print to the same printer.
        </p>
        <label>Label printer</label>
        <select value={labelPrinter} onChange={(e) => setLabelPrinter(e.target.value)}>
          <option value="">— none —</option>
          {osPrinters.map((p) => <option key={p.name} value={p.name}>{usbLabel(p)}{p.queue && p.queue !== usbLabel(p) ? ` (${p.queue})` : ''}{p.isDefault ? ' · default' : ''}</option>)}
        </select>
        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" disabled={busy} onClick={async () => { setBusy(true); const r = await desktop.saveConfig({ label_printer: labelPrinter }); setLabelMsg(r?.success ? 'Saved.' : `Could not save: ${r?.error}`); setBusy(false); }}>Save label printer</button>
          <button className="btn secondary" disabled={busy || !labelPrinter} onClick={async () => {
            setBusy(true); setLabelMsg('Sending test label…');
            try {
              const saved = await desktop.saveConfig({ label_printer: labelPrinter });
              if (!saved?.success) throw new Error(saved?.error || 'save failed');
              const r = await desktop.printLabel(await buildLabelHtml(SAMPLE_LABEL), 1);
              setLabelMsg(r?.ok ? 'Test label sent — check the printer.' : `Test failed: ${r?.error}`);
            } catch (e) { setLabelMsg(`Test failed: ${e.message}`); } finally { setBusy(false); }
          }}>🏷 Print test label</button>
        </div>
        {labelMsg && <p style={{ fontSize: 13, marginTop: 8 }}>{labelMsg}</p>}
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
