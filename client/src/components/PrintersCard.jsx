import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { desktop, electronConfig } from '../electron.js';
import { printerDest, invalidatePrinters, migrateLegacyPrinters } from '../printers.js';

// Shop-wide printers (SIAMSHOP-PRINTERS-001): every till sees the same list.
// Add via Find printers / USB list / typed IP · job (receipt · prep · label) ·
// prep categories · test (this device runs it, reports the result) · remove.
// 'label' covers every printer that is NOT the 80 mm thermal at the till or
// kitchen — parcel labels, shelf labels, an office A4 — all driven through the
// computer's own printer driver rather than ESC/POS.
const JOB_LABEL = { receipt: 'Receipt + drawer (80 mm)', prep: 'Prep ticket (80 mm)', label: 'Other printer' };
const PAPER_LABEL = {
  label4x6: '4 × 6 in parcel label', label4x2: '4 × 2 in label', label2x1: '2 × 1 in label',
  a4: 'A4 paper', a5: 'A5 paper',
};
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export default function PrintersCard({ onChanged, isManager }) {
  const [list, setList] = useState(null); // { printers, printing_device_id }
  const [cats, setCats] = useState([]);
  const [osPrinters, setOsPrinters] = useState([]);
  const [adding, setAdding] = useState(null); // form
  const [scan, setScan] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [migrated, setMigrated] = useState(null);

  async function load() {
    try {
      const l = await api.printers();
      setList(l);
      // One-time migration of this device's old printer/label config into the list.
      if (isManager && migrated === null) {
        try { const created = await migrateLegacyPrinters(l, desktop.saveConfig); setMigrated(created.length); if (created.length) { invalidatePrinters(); setList(await api.printers()); } }
        catch (e) { setMigrated(0); }
      }
    } catch (e) { setMsg(e.message); }
  }
  useEffect(() => { load(); api.getCategories?.().then((c) => setCats(Array.isArray(c) ? c : [])).catch(() => {}); desktop.listPrinters().then(setOsPrinters).catch(() => {}); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function save(form) {
    setBusy(true); setMsg('');
    try {
      if (form.id) await api.adminUpdatePrinter(form.id, form); else await api.adminAddPrinter(form);
      invalidatePrinters(); setAdding(null); await load(); onChanged && onChanged();
    } catch (e) { setMsg(e.message); }
    setBusy(false);
  }
  async function remove(p) {
    setBusy(true); setMsg('');
    try { await api.adminDeletePrinter(p.id); invalidatePrinters(); await load(); onChanged && onChanged(); } catch (e) { setMsg(e.message); }
    setBusy(false);
  }
  async function test(p) {
    setBusy(true); setMsg(`Testing ${p.name}…`);
    let r;
    if (p.job === 'label') {
      const { buildLabelHtml, SAMPLE_LABEL } = await import('../label.js');
      r = await desktop.printLabel(await buildLabelHtml(SAMPLE_LABEL), 1, p.usb_name);
    } else {
      let o = {};
      try { const st = await api.getSettings(); o = { style: st.receipt_style || 'rendered', size: st.print_size || 'normal', logo: st.brand_logo || '', showLogo: !!st.receipt_show_logo, logoInvert: !!st.brand_logo_invert, shopName: electronConfig.shopName }; } catch {}
      r = await desktop.testPrint(printerDest(p), o);
    }
    await api.printerTestResult(p.id, !!r?.ok).catch(() => {});
    setMsg(r?.ok ? `${p.name}: test sent — check the printer.` : `${p.name}: ${r?.error || 'test failed'}`);
    await load(); setBusy(false);
  }
  async function findPrinters() { setScan({ busy: true }); const r = await desktop.scanPrinters(); setScan({ busy: false, ...r }); }
  const startAdd = (preset = {}) => setAdding({ name: '', kind: 'network', ip: '', port: 9100, lpr_queue: 'lp', usb_name: '', job: 'receipt', prep_categories: [], model: '', paper: 'label4x6', ...preset });

  const printers = list?.printers || [];
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Printers <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>· shop-wide, every till sees this list</span></h3>
      {migrated > 0 && <p className="muted" style={{ fontSize: 12 }}>Moved this device's old printer settings into the list ({migrated}).</p>}
      {printers.length === 0 && <p className="muted" style={{ fontSize: 13 }}>No printers yet. Find your receipt printer on the network, or add a USB one.</p>}
      {printers.length > 0 && (
        <div className="scan-list" style={{ marginTop: 0 }}>
          {printers.map((p) => (
            <div key={p.id} className={`device-card ${p.active === false ? 'crm-dim' : ''}`} style={{ padding: '10px 12px' }}>
              <div className="device-icon">{p.job === 'label' ? '🏷' : p.job === 'prep' ? '🍜' : '🧾'}</div>
              <div className="device-main">
                <div className="device-title">{p.name} <span className="tag">{JOB_LABEL[p.job]}</span>{electronConfig.receiptPrinterId === p.id && <span className="tag ok">this till's receipts</span>}</div>
                <div className="device-sub">
                  {p.kind === 'usb' ? `USB · ${p.usb_name}` : `${p.ip}${Number(p.port) !== 9100 ? `:${p.port}` : ''}`}{p.model ? ` · ${p.model}` : ''}
                  {p.job === 'label' && <> · {PAPER_LABEL[p.paper] || p.paper}</>}
                  {p.job === 'prep' && <> · {p.prep_categories?.length ? `categories: ${p.prep_categories.map((id) => cats.find((c) => c.id === id)?.name || id).join(', ')}` : 'all made-to-order items'}</>}
                  {' · '}{p.last_test_at ? `last test ${p.last_test_ok ? 'OK' : 'FAILED'} ${fmtWhen(p.last_test_at)}` : 'not tested'}
                </div>
              </div>
              <button type="button" className="btn mini secondary" disabled={busy} onClick={() => test(p)}>Test</button>
              {isManager && <button type="button" className="btn mini secondary" disabled={busy} onClick={() => setAdding({ ...p, prep_categories: p.prep_categories || [] })}>Edit</button>}
            </div>
          ))}
        </div>
      )}
      {isManager && !adding && (
        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn" disabled={scan?.busy} onClick={findPrinters}>{scan?.busy ? 'Looking on your network…' : '🔍 Find printers'}</button>
          <button type="button" className="btn secondary" onClick={() => startAdd({ kind: 'usb' })}>+ USB printer</button>
          <button type="button" className="btn secondary" onClick={() => startAdd()}>+ Enter an address</button>
          {scan && !scan.busy && <span className="muted" style={{ fontSize: 13 }}>{scan.error ? `Scan failed: ${scan.error}` : scan.printers?.length ? `${scan.printers.length} found on ${scan.subnet}` : (scan.message || `Nothing answered on ${scan.subnet || 'your network'}`)}</span>}
        </div>
      )}
      {scan?.printers?.length > 0 && !adding && (
        <div className="scan-list">
          {scan.printers.filter((f) => !printers.some((p) => p.ip === f.ip)).map((f) => (
            <div key={f.ip} className="scan-hit"><span>🖨 <strong>{f.ip}</strong>{f.model ? <span className="muted"> · {f.model}</span> : <span className="muted"> · network printer (port {f.port})</span>}</span>
              <button type="button" className="btn mini secondary" onClick={() => startAdd({ ip: f.ip, port: f.port || 9100, model: f.model || '', name: f.model || `Printer ${f.ip}` })}>Add…</button></div>
          ))}
        </div>
      )}
      {adding && (
        <form className="device-card" style={{ display: 'block', marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); save(adding); }}>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '2 1 200px' }}><label>Name</label><input value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="e.g. Front till, Kitchen, Label" autoFocus /></div>
            <div style={{ flex: '1 1 160px' }}><label>Job</label>
              <select value={adding.job} onChange={(e) => setAdding({ ...adding, job: e.target.value, kind: e.target.value === 'label' ? 'usb' : adding.kind })}>
                <option value="receipt">Receipt + drawer — 80 mm thermal</option><option value="prep">Prep ticket — 80 mm thermal at the kitchen / counter</option><option value="label">Anything else — labels, A4, via this computer's driver</option>
              </select></div>
            {adding.job !== 'label' && <div style={{ flex: '1 1 140px' }}><label>Connection</label>
              <select value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value })}><option value="network">Network (IP)</option><option value="usb">USB on this computer</option></select></div>}
          </div>
          {adding.kind === 'network' ? (
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: '2 1 160px' }}><label>IP address</label><input value={adding.ip || ''} onChange={(e) => setAdding({ ...adding, ip: e.target.value })} placeholder="e.g. 192.168.1.50" /></div>
              <div style={{ flex: '1 1 90px' }}><label>Port</label><input type="number" value={adding.port} onChange={(e) => setAdding({ ...adding, port: e.target.value })} /></div>
              <div style={{ flex: '1 1 90px' }}><label>LPR queue</label><input value={adding.lpr_queue || ''} onChange={(e) => setAdding({ ...adding, lpr_queue: e.target.value })} placeholder="lp" /></div>
            </div>
          ) : (
            <><label>USB printer on this computer</label>
              <select value={adding.usb_name || ''} onChange={(e) => { const q = osPrinters.find((p) => p.name === e.target.value); setAdding({ ...adding, usb_name: e.target.value, model: q?.model || adding.model, name: adding.name || q?.label || '' }); }}>
                <option value="">— choose —</option>{osPrinters.map((p) => <option key={p.name} value={p.name}>{p.label || p.displayName}{p.queue && p.queue !== (p.label || p.displayName) ? ` (${p.queue})` : ''}</option>)}
              </select></>
          )}
          {adding.job === 'label' && (
            <>
              <label>Paper / label size</label>
              <select value={adding.paper || 'label4x6'} onChange={(e) => setAdding({ ...adding, paper: e.target.value })}>
                {Object.entries(PAPER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>Anything that is not the 80 mm till or kitchen printer goes here — parcel labels, shelf labels, or an ordinary A4 printer.</p>
            </>
          )}
          {adding.job === 'prep' && (
            <><label>Only items from these categories (none ticked = every made-to-order item)</label>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {cats.map((c) => { const on = (adding.prep_categories || []).includes(c.id); return (
                  <button type="button" key={c.id} className={`brand-preset ${on ? 'on' : ''}`} style={on ? { background: 'var(--navy)', color: '#fff' } : {}} onClick={() => setAdding({ ...adding, prep_categories: on ? adding.prep_categories.filter((x) => x !== c.id) : [...(adding.prep_categories || []), c.id] })}>{c.name}</button>); })}
              </div></>
          )}
          {adding.id && <label className="row" style={{ gap: 8, marginTop: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={adding.active !== false} onChange={(e) => setAdding({ ...adding, active: e.target.checked })} /><span>Active</span></label>}
          <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn" disabled={busy}>{adding.id ? 'Save printer' : 'Add printer'}</button>
            <button type="button" className="btn secondary" onClick={() => setAdding(null)}>Cancel</button>
            {adding.id && <><div className="spacer" /><button type="button" className="btn cancel-btn" disabled={busy} onClick={() => remove(adding).then(() => setAdding(null))}>Remove</button></>}
          </div>
        </form>
      )}
      {msg && <p style={{ fontSize: 13, marginTop: 8 }}>{msg}</p>}
    </div>
  );
}
