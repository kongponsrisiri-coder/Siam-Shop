import React, { useEffect, useState } from 'react';
import { api, auth, staffSession } from '../api.js';
import { Logo } from './Logo.jsx';
import { isElectron, desktop } from '../electron.js';

// Staff sign-in (SIAMSHOP-ELECTRON-001). PIN pad first — a shop counter must
// know who rang the sale — with the owner's password as the fallback (also
// how the very first PIN gets created: sign in as owner → Admin → Staff).
//
//   <StaffGate need="staff"   onIn={...} />  — any role (Till, Prep)
//   <StaffGate need="manager" onIn={...} />  — manager or owner (Admin)
//
// Big touch targets for keyboard-less tills; the physical keyboard / USB
// scanner keypad also works (digits, Backspace, Enter).

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'];
const ROLE_LABEL = { admin: 'Owner', manager: 'Manager', cashier: 'Cashier', prep: 'Prep' };

export function roleAllowed(role, need) {
  if (need === 'manager') return role === 'admin' || role === 'manager';
  return !!role;
}

export default function StaffGate({ need = 'staff', title = 'Staff sign in', onIn }) {
  const [pin, setPin] = useState('');
  const [mode, setMode] = useState('pin'); // pin | owner | clock
  const [clocked, setClocked] = useState(null); // { name, event_type, event_at } after a clock toggle
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(null);

  useEffect(() => {
    if (isElectron) desktop.getVersion().then(setVersion).catch(() => {});
  }, []);

  async function submitPin(value) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      // Clock mode (SIAMSHOP-CLOCK-001): the same pad clocks you in or out and
      // stays on the sign-in screen — no till session is opened.
      if (mode === 'clock') {
        const c = await api.clockToggle(value);
        setClocked(c);
        setPin('');
        setTimeout(() => { setClocked(null); setMode('pin'); }, 3500);
        return;
      }
      const r = await api.staffLogin(value);
      if (!roleAllowed(r.role, need)) {
        setError(need === 'manager' ? 'Manager PIN required for Admin.' : 'Not allowed.');
        setPin('');
        return;
      }
      auth.set(r.token);
      staffSession.set({ name: r.name, role: r.role, sid: r.sid });
      onIn(r);
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
    setPin((p) => {
      const next = (p + k).slice(0, 6);
      if (next.length === 6) submitPin(next);
      return next;
    });
  }

  // Physical keyboard / scanner keypad.
  useEffect(() => {
    if (mode !== 'pin' && mode !== 'clock') return undefined;
    const onKey = (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('⌫');
      else if (e.key === 'Escape') press('C');
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
      auth.set(token);
      staffSession.set({ name: 'Owner', role: 'admin' });
      onIn({ role: 'admin', name: 'Owner' });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-brand"><Logo size={34} light /></div>
        <h1 style={{ margin: '6px 0 2px' }}>{title}</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          {need === 'manager' ? 'Manager or owner only' : 'Enter your PIN'}
        </p>

        {clocked ? (
          <div className="clock-done">
            <div style={{ fontSize: 42 }}>{clocked.event_type === 'in' ? '🟢' : '🔴'}</div>
            <h2 style={{ margin: '6px 0' }}>{clocked.name}</h2>
            <p style={{ margin: 0 }}>{clocked.repeated ? 'Already clocked' : 'Clocked'} <strong>{clocked.event_type === 'in' ? 'IN' : 'OUT'}</strong> at {new Date(clocked.event_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</p>
            {clocked.repeated && <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>No change made — you tapped twice within a minute.</p>}
          </div>
        ) : mode === 'pin' || mode === 'clock' ? (
          <>
            {mode === 'clock' && <div className="tag ok" style={{ marginBottom: 6 }}>⏱ Clock in / out — enter your PIN</div>}
            <div className="pin-dots" aria-label="PIN">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <span key={i} className={`pin-dot ${i < pin.length ? 'on' : ''} ${i >= 4 ? 'opt' : ''}`} />
              ))}
            </div>
            <div className="pin-pad">
              {KEYS.map((k) => (
                <button type="button" key={k} className={`pin-key ${/\d/.test(k) ? '' : 'fn'}`} onClick={() => press(k)} disabled={busy}>
                  {k}
                </button>
              ))}
            </div>
            <button type="button" className="btn" style={{ width: '100%', marginTop: 10 }} disabled={busy || pin.length < 4} onClick={() => submitPin(pin)}>
              {busy ? 'Checking…' : mode === 'clock' ? 'Clock in / out' : 'Sign in'}
            </button>
            {error && <p className="err" style={{ marginTop: 10 }}>{error}</p>}
            <div className="row" style={{ gap: 6, justifyContent: 'center', marginTop: 8 }}>
              {mode === 'clock' ? (
                <button type="button" className="btn ghost" onClick={() => { setMode('pin'); setError(''); setPin(''); }}>← Back to sign in</button>
              ) : (
                <>
                  <button type="button" className="btn ghost" onClick={() => { setMode('clock'); setError(''); setPin(''); }}>⏱ Clock in / out</button>
                  <button type="button" className="btn ghost" onClick={() => { setMode('owner'); setError(''); }}>Owner password</button>
                </>
              )}
            </div>
          </>
        ) : (
          <form onSubmit={submitOwner}>
            <label>Owner password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            {error && <p className="err">{error}</p>}
            <button className="btn" style={{ marginTop: 12, width: '100%' }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in as owner'}</button>
            <button type="button" className="btn ghost" style={{ marginTop: 8 }} onClick={() => { setMode('pin'); setError(''); }}>
              ← Back to PIN
            </button>
          </form>
        )}

        {isElectron && (
          <div className="gate-foot muted">
            <span>SiamShop{version ? ` v${version}` : ''}</span>
            <button type="button" className="btn ghost" onClick={() => desktop.quit()}>Exit</button>
          </div>
        )}
      </div>
    </div>
  );
}

// Small "who's signed in" chip + sign out for the staff headers.
export function StaffChip({ onOut }) {
  const s = staffSession.get();
  if (!s) return null;
  return (
    <span className="staff-chip">
      👤 {s.name} <small>· {ROLE_LABEL[s.role] || s.role}</small>
      <button type="button" className="till-x" title="Sign out" onClick={() => { auth.clear(); staffSession.clear(); onOut && onOut(); }}>⎋</button>
    </span>
  );
}
