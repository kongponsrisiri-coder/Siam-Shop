import React, { useState } from 'react';
import { api, staffSession } from '../api.js';
import { isElectron, desktop, electronConfig } from '../electron.js';
import ManagerPin from './ManagerPin.jsx';

// Till session UI (SIAMSHOP-TILL-001): open the till with a float, close it
// with the counted cash (manager approval), see the Z, print/reprint it.
const money = (n) => '£' + Number(n || 0).toFixed(2);
const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

// mode 'open' = start a shift; mode 'float' = the shift auto-opened on the first
// sale, so just record the float that was in the drawer.
export function OpenTillModal({ onOpened, onClose, mode = 'open' }) {
  const [float, setFloat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function open() {
    setBusy(true); setError('');
    try {
      const r = mode === 'float' ? await api.tillSetFloat(Number(float || 0)) : await api.tillOpen(Number(float || 0));
      onOpened(r);
    } catch (e) {
      // Someone else opened it meanwhile — just load it.
      if (e.status === 409) { try { onOpened(await api.tillSession()); return; } catch (_) {} }
      setError(e.message);
    } finally { setBusy(false); }
  }
  return (
    <div className="till-modal" onClick={onClose}>
      <div className="till-receipt" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>{mode === 'float' ? 'Shift started — set your float' : 'Open the till'}</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {mode === 'float'
            ? 'The first sale opened this shift automatically. Enter the cash that was in the drawer at the start so the cash-up adds up.'
            : 'Count the cash in the drawer to start the shift. Sales from now on are reconciled against it at cash-up.'}
        </p>
        <label>Opening float (£)</label>
        <input type="number" inputMode="decimal" step="0.01" min="0" value={float} onChange={(e) => setFloat(e.target.value)} placeholder="50.00" autoFocus />
        {error && <p className="err">{error}</p>}
        <button className="btn" style={{ width: '100%', marginTop: 12 }} disabled={busy} onClick={open}>{busy ? 'Saving…' : mode === 'float' ? 'Save float' : 'Open till'}</button>
        <button className="btn ghost" style={{ width: '100%', marginTop: 6 }} onClick={onClose}>Not now</button>
      </div>
    </div>
  );
}

// Z report body — shared by the close modal, the Admin → Reports viewer and the printout preview.
export function ZSummary({ z }) {
  if (!z) return null;
  const row = (l, v, strong) => (
    <div className="row" style={{ justifyContent: 'space-between', fontWeight: strong ? 800 : 400 }}><span>{l}</span><span>{v}</span></div>
  );
  return (
    <div className="z-summary">
      <div className="muted" style={{ fontSize: 12 }}>Opened {when(z.opened_at)} by {z.opened_by || '—'}{z.closed_at ? ` · closed ${when(z.closed_at)} by ${z.closed_by || '—'}` : ' · still open'}</div>
      <hr />
      {row('Cash sales', money(z.sales?.cash))}
      {row('Card sales', money(z.sales?.card))}
      {row(`Sales (${z.sales?.count || 0} · ${z.sales?.items || 0} items)`, money(z.sales?.gross))}
      {row(`Refunds (${z.refunds?.count || 0})`, '−' + money(z.refunds?.total))}
      {Number(z.discounts?.total) > 0 && row(`Discounts (${z.discounts.count})`, '−' + money(z.discounts.total))}
      {row('Net takings', money(z.net), true)}
      <hr />
      {row('Opening float', money(z.float_amount))}
      {row('+ Cash sales', money(z.sales?.cash))}
      {row('− Cash refunds', money(z.refunds?.cash))}
      {row('Expected cash in drawer', money(z.expected_cash), true)}
      {z.counted_cash != null && row('Counted', money(z.counted_cash))}
      {z.variance != null && (
        <div className="row" style={{ justifyContent: 'space-between', fontWeight: 800, color: Math.abs(z.variance) < 0.005 ? '#16a34a' : z.variance < 0 ? '#b91c1c' : '#b45309' }}>
          <span>Variance</span><span>{z.variance > 0 ? '+' : ''}{money(z.variance)}</span>
        </div>
      )}
      {z.online?.count > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Online orders paid during the shift: {z.online.count} ({money(z.online.gross)}) — not in the drawer.</div>}
      {z.notes && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Notes: {z.notes}</div>}
    </div>
  );
}

export function PrintZButton({ z, label = '🖨 Print Z' }) {
  const [msg, setMsg] = useState('');
  if (!isElectron) return null;
  return (
    <span className="row" style={{ gap: 8, alignItems: 'center', display: 'inline-flex' }}>
      <button className="btn secondary" onClick={async () => { setMsg('Printing…'); const r = await desktop.printZ(z, electronConfig.shopName); setMsg(r?.ok ? 'Printed' : `Print failed: ${r?.error}`); }}>{label}</button>
      {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
    </span>
  );
}

export function CloseTillModal({ summary, onClosed, onClose }) {
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [needPin, setNeedPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const me = staffSession.get();
  const isManager = me && (me.role === 'manager' || me.role === 'admin');
  const variance = counted === '' ? null : Number(counted) - Number(summary?.expected_cash || 0);

  async function doClose(approvalToken) {
    setBusy(true); setError('');
    try {
      const r = await api.tillClose(Number(counted), notes, approvalToken);
      setResult(r.summary);
      if (isElectron && electronConfig.printer?.autoPrint !== false) desktop.printZ(r.summary, electronConfig.shopName).catch(() => {});
    } catch (e) {
      setError(e.message);
    } finally { setBusy(false); }
  }
  function submit() {
    if (counted === '' || Number(counted) < 0) return setError('Enter the cash counted in the drawer.');
    if (isManager) doClose();
    else setNeedPin(true);
  }

  if (result) {
    return (
      <div className="till-modal">
        <div className="till-receipt" style={{ width: 420 }}>
          <h2 style={{ marginTop: 0 }}>✅ Till closed — Z report</h2>
          <ZSummary z={result} />
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <PrintZButton z={result} />
            <div className="spacer" />
            <button className="btn" onClick={() => onClosed(result)}>Done</button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="till-modal" onClick={onClose}>
        <div className="till-receipt" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
          <h2 style={{ marginTop: 0 }}>Close the till (cash-up)</h2>
          <ZSummary z={summary} />
          <label style={{ marginTop: 10 }}>Cash counted in the drawer (£) *</label>
          <input type="number" inputMode="decimal" step="0.01" min="0" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder={Number(summary?.expected_cash || 0).toFixed(2)} autoFocus />
          {variance != null && (
            <div style={{ marginTop: 4, fontWeight: 700, color: Math.abs(variance) < 0.005 ? '#16a34a' : variance < 0 ? '#b91c1c' : '#b45309' }}>
              Variance: {variance > 0 ? '+' : ''}{money(variance)}
            </div>
          )}
          <label>Notes</label>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. £5 petty cash for milk" />
          {error && <p className="err">{error}</p>}
          <button className="btn" style={{ width: '100%', marginTop: 12 }} disabled={busy} onClick={submit}>
            {busy ? 'Closing…' : isManager ? 'Close till' : 'Close till (manager approval)'}
          </button>
          <button className="btn ghost" style={{ width: '100%', marginTop: 6 }} onClick={onClose}>Cancel</button>
        </div>
      </div>
      {needPin && (
        <ManagerPin title="Manager approval to close the till" reason="Closing the shift needs a manager PIN." onClose={() => setNeedPin(false)} onApproved={({ token }) => { setNeedPin(false); doClose(token); }} />
      )}
    </>
  );
}
