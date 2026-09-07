import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// Manager approval (SIAMSHOP-TILL-001, reused by discounts/refunds): a manager
// types their PIN on a React modal (window.prompt is dead in Electron). The
// cashier stays signed in — the manager's one-off token is handed back to the
// caller for that single request. Owner password also works.
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'];

export default function ManagerPin({ title = 'Manager approval', reason, onApproved, onClose }) {
  const [pin, setPin] = useState('');
  const [mode, setMode] = useState('pin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submitPin(value) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.staffLogin(value);
      if (r.role !== 'manager' && r.role !== 'admin') { setError('That PIN is not a manager.'); setPin(''); return; }
      onApproved({ token: r.token, name: r.name, role: r.role });
    } catch (e) {
      setError(e.message);
      setPin('');
    } finally {
      setBusy(false);
    }
  }
  function press(k) {
    setError('');
    if (k === 'C') return setPin('');
    if (k === '⌫') return setPin((p) => p.slice(0, -1));
    setPin((p) => { const n = (p + k).slice(0, 6); if (n.length === 6) submitPin(n); return n; });
  }
  useEffect(() => {
    if (mode !== 'pin') return undefined;
    const onKey = (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('⌫');
      else if (e.key === 'Escape') onClose();
      else if (e.key === 'Enter' && pin.length >= 4) submitPin(pin);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pin, busy]);

  async function submitOwner(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { token } = await api.login(password);
      onApproved({ token, name: 'Owner', role: 'admin' });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="till-modal" onClick={onClose} style={{ zIndex: 60 }}>
      <div className="till-receipt" style={{ width: 360 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>🔐 {title}</h3>
        {reason && <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>{reason}</p>}
        {mode === 'pin' ? (
          <>
            <div className="pin-dots">{[0, 1, 2, 3, 4, 5].map((i) => <span key={i} className={`pin-dot ${i < pin.length ? 'on' : ''} ${i >= 4 ? 'opt' : ''}`} />)}</div>
            <div className="pin-pad">
              {KEYS.map((k) => <button type="button" key={k} className={`pin-key ${/\d/.test(k) ? '' : 'fn'}`} disabled={busy} onClick={() => press(k)}>{k}</button>)}
            </div>
            <button type="button" className="btn" style={{ width: '100%', marginTop: 10 }} disabled={busy || pin.length < 4} onClick={() => submitPin(pin)}>{busy ? 'Checking…' : 'Approve'}</button>
            {error && <p className="err" style={{ marginTop: 8 }}>{error}</p>}
            <button type="button" className="btn ghost" style={{ marginTop: 6 }} onClick={() => setMode('owner')}>Owner password instead</button>
          </>
        ) : (
          <form onSubmit={submitOwner}>
            <label>Owner password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            {error && <p className="err">{error}</p>}
            <button className="btn" style={{ width: '100%', marginTop: 10 }} disabled={busy}>Approve</button>
            <button type="button" className="btn ghost" style={{ marginTop: 6 }} onClick={() => setMode('pin')}>← PIN</button>
          </form>
        )}
        <button type="button" className="btn secondary" style={{ width: '100%', marginTop: 8 }} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
