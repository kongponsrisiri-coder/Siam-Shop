import React, { useEffect, useState } from 'react';
import { desktop, electronConfig } from '../../electron.js';
import { buildLabelHtml, SAMPLE_LABEL } from '../../label.js';

// "This device" (desktop till only — SIAMSHOP-ELECTRON-001): receipt printer,
// cash drawer, app version + updates. Everything here lives in the device's
// own config.json, not in the shop's cloud settings.
export default function DeviceSection() {
  const [cfg, setCfg] = useState(null);
  const [printer, setPrinter] = useState({ ip: '', port: 9100, name: '', lprQueue: 'lp', autoPrint: true, kickDrawerOnCash: true });
  const [osPrinters, setOsPrinters] = useState([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [update, setUpdate] = useState(null);
  const [labelPrinter, setLabelPrinter] = useState('');
  const [labelMsg, setLabelMsg] = useState('');

  useEffect(() => {
    desktop.getConfig().then((c) => { setCfg(c); if (c?.printer) setPrinter({ ...printer, ...c.printer }); setLabelPrinter(c?.labelPrinter || ''); }).catch(() => {});
    desktop.listPrinters().then(setOsPrinters).catch(() => {});
    desktop.onUpdateStatus((s) => setUpdate(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k, v) => setPrinter((p) => ({ ...p, [k]: v }));

  async function save() {
    setBusy(true); setMsg('');
    const r = await desktop.saveConfig({ printer });
    setMsg(r?.success ? 'Saved — takes effect on the next receipt.' : `Could not save: ${r?.error || 'unknown'}`);
    setBusy(false);
  }
  async function test() {
    setBusy(true); setMsg('Sending test page…');
    const r = await desktop.testPrint(printer);
    setMsg(r?.ok ? 'Test page sent — check the printer.' : `Test failed: ${r?.error}`);
    setBusy(false);
  }
  async function drawer() {
    setBusy(true); setMsg('');
    const r = await desktop.kickDrawer();
    setMsg(r?.ok ? 'Drawer pulse sent.' : `Drawer failed: ${r?.error}`);
    setBusy(false);
  }
  async function check() {
    setMsg('');
    const r = await desktop.checkForUpdates();
    if (!r?.ok) setMsg(r?.reason === 'not-packaged' ? 'Updates only run in the installed app.' : `Update check failed: ${r?.message || r?.reason}`);
  }

  const updateText = !update ? '' :
    update.state === 'checking' ? 'Checking for updates…' :
    update.state === 'available' ? `Update ${update.version} found — downloading…` :
    update.state === 'downloading' ? `Downloading update… ${update.percent}%` :
    update.state === 'downloaded' ? `Update ${update.version} ready — restart to install.` :
    update.state === 'not-available' ? 'You are on the latest version.' :
    update.state === 'error' ? `Update error: ${update.message}` : '';

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
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          A network receipt printer needs its IP (port 9100 is standard). A USB printer installed on this device is used by name.
          The cash drawer plugs into the receipt printer and opens on cash sales.
        </p>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '2 1 200px' }}>
            <label>Printer IP</label>
            <input value={printer.ip} onChange={(e) => set('ip', e.target.value)} placeholder="192.168.1.50" />
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
        <label>USB printer name (if no IP)</label>
        <input value={printer.name} onChange={(e) => set('name', e.target.value)} placeholder="as shown in your device's printer list" list="os-printers" />
        <datalist id="os-printers">{osPrinters.map((p) => <option key={p.name} value={p.name}>{p.displayName}</option>)}</datalist>
        <label className="row" style={{ marginTop: 10, gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={printer.autoPrint !== false} onChange={(e) => set('autoPrint', e.target.checked)} />
          <span>Print a receipt automatically after every sale</span>
        </label>
        <label className="row" style={{ marginTop: 6, gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={printer.kickDrawerOnCash !== false} onChange={(e) => set('kickDrawerOnCash', e.target.checked)} />
          <span>Open the cash drawer on cash sales</span>
        </label>
        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" disabled={busy} onClick={save}>Save printer</button>
          <button className="btn secondary" disabled={busy} onClick={test}>🖨 Print test page</button>
          <button className="btn secondary" disabled={busy} onClick={drawer}>💵 Open drawer</button>
        </div>
        {msg && <p style={{ fontSize: 13, marginTop: 8 }}>{msg}</p>}
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Parcel label printer (4×6 in)</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          For postal orders. A direct-thermal 4×6 label printer installed on this device with its own driver
          (Rollo, MUNBYN, Zebra ZD220/GK420, Brother QL-1110). Labels print through the driver, so any brand works.
          Not app-only Bluetooth minis. Royal Mail Click &amp; Drop postage PDFs print to the same printer.
        </p>
        <label>Label printer</label>
        <select value={labelPrinter} onChange={(e) => setLabelPrinter(e.target.value)}>
          <option value="">— none —</option>
          {osPrinters.map((p) => <option key={p.name} value={p.name}>{p.displayName}{p.isDefault ? ' (default)' : ''}</option>)}
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
