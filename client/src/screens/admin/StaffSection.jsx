import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { summarise, pairShifts, shiftHours, fmtHours, weekBounds, timesheetCsv } from '../../timesheet.js';

// Staff & PINs (SIAMSHOP-ELECTRON-001). Manager/owner only. A PIN is 4–6
// digits and unique within the shop — the till identifies who is signed in
// from the PIN alone, and writes their name on every sale.
const ROLES = [
  { key: 'manager', label: 'Manager', hint: 'Till, Prep and Admin' },
  { key: 'cashier', label: 'Cashier', hint: 'Till, Prep and stock scanner' },
  { key: 'prep', label: 'Prep', hint: 'Prep screen only' },
];
const EMPTY = { name: '', role: 'cashier', pin: '' };

function StaffForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState({ ...EMPTY, ...initial, pin: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editing = !!initial?.id;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) return setError('Name is required');
    if (!editing && !/^\d{4,6}$/.test(form.pin)) return setError('PIN must be 4–6 digits');
    if (editing && form.pin && !/^\d{4,6}$/.test(form.pin)) return setError('PIN must be 4–6 digits');
    setBusy(true);
    try {
      await onSave({ name: form.name.trim(), role: form.role, ...(form.pin ? { pin: form.pin } : {}) });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={save}>
      <h3 style={{ marginTop: 0 }}>{editing ? `Edit ${initial.name}` : 'Add staff member'}</h3>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px' }}>
          <label>Name *</label>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} required autoFocus />
        </div>
        <div style={{ flex: '1 1 180px' }}>
          <label>Role</label>
          <select value={form.role} onChange={(e) => set('role', e.target.value)}>
            {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label} — {r.hint}</option>)}
          </select>
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <label>{editing ? 'New PIN (leave blank to keep)' : 'PIN (4–6 digits) *'}</label>
          <input inputMode="numeric" pattern="\d*" maxLength={6} value={form.pin} onChange={(e) => set('pin', e.target.value.replace(/\D/g, ''))} placeholder="••••" />
        </div>
      </div>
      {error && <p className="err">{error}</p>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// Timesheets (SIAMSHOP-CLOCK-001): week picker → paired shifts → hours per
// staff, who is in right now, CSV export. Open shifts show as OPEN, never 24 h.
function Timesheets() {
  const [[from, to], setRange] = useState(() => weekBounds());
  const [events, setEvents] = useState(null);
  const [nowIn, setNowIn] = useState([]);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);

  async function load(f = from, t = to) {
    setError('');
    try {
      const [ev, st] = await Promise.all([api.clockRecords(f, t), api.clockStatus()]);
      setEvents(ev); setNowIn(st);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [from, to]);

  function shiftWeek(delta) {
    const d = new Date(from); d.setDate(d.getDate() + delta * 7);
    setRange(weekBounds(d));
  }
  function exportCsv() {
    const blob = new Blob([timesheetCsv(events || [])], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `timesheets_${from}_to_${to}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  const rows = summarise(events || []);
  const fmtT = (d) => new Date(d).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Clocked in now</h3>
        {nowIn.length === 0 ? <p className="muted">Nobody is clocked in.</p> : (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {nowIn.map((s) => <span key={s.id} className="tag ok">🟢 {s.name} · since {new Date(s.clocked_in_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>)}
          </div>
        )}
      </div>
      <div className="panel">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <h3 style={{ margin: 0 }}>Timesheets</h3>
          <div className="spacer" />
          <button className="btn mini secondary" onClick={() => shiftWeek(-1)}>‹ Prev week</button>
          <div>
            <label>From</label>
            <input type="date" value={from} onChange={(e) => setRange([e.target.value, to])} />
          </div>
          <div>
            <label>To</label>
            <input type="date" value={to} onChange={(e) => setRange([from, e.target.value])} />
          </div>
          <button className="btn mini secondary" onClick={() => shiftWeek(1)}>Next week ›</button>
          <button className="btn mini secondary" onClick={() => setRange(weekBounds())}>This week</button>
          <button className="btn mini" onClick={exportCsv} disabled={!events || events.length === 0}>⬇ Export CSV</button>
        </div>
        {error && <p className="err">{error}</p>}
        {events === null && <p className="muted">Loading…</p>}
        {events && rows.length === 0 && <p className="muted">No clock events in this range.</p>}
        {rows.length > 0 && (
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Staff</th><th>Shifts</th><th style={{ textAlign: 'right' }}>Hours</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <React.Fragment key={r.id}>
                  <tr className="order-row" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                    <td><strong>{r.name}</strong> <span className="muted">· {r.role}</span></td>
                    <td>{r.closedCount}{r.openCount ? <span className="tag off" style={{ marginLeft: 6 }}>{r.openCount} open — no clock-out</span> : ''}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtHours(r.totalHours)}</td>
                    <td className="muted">{expanded === r.id ? '▲' : '▼'}</td>
                  </tr>
                  {expanded === r.id && r.shifts.map((s, i) => (
                    <tr key={i} style={{ background: '#fafafa' }}>
                      <td className="muted" style={{ paddingLeft: 24 }}>{fmtT(s.in)}</td>
                      <td className="muted">{s.out ? `→ ${fmtT(s.out)}` : <span className="tag off">OPEN — no clock-out</span>}</td>
                      <td style={{ textAlign: 'right' }}>{s.out ? fmtHours(shiftHours(s)) : '—'}</td>
                      <td></td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted" style={{ fontSize: 12 }}>Staff clock in and out with the ⏱ button on the sign-in screen. A shift that crosses midnight is counted in full; a forgotten clock-out shows as OPEN, not as hours.</p>
      </div>
    </div>
  );
}

export default function StaffSection() {
  const [view, setView] = useState('staff'); // staff | timesheets
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);

  async function load() {
    setLoading(true);
    setError('');
    try { setStaff(await api.adminListStaff()); } catch (e) { setError(e.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function handleSave(data) {
    if (editing?.id) await api.adminUpdateStaff(editing.id, data);
    else await api.adminCreateStaff(data);
    setEditing(null);
    await load();
  }
  async function toggleActive(s) {
    try { await api.adminUpdateStaff(s.id, { active: !s.active }); await load(); } catch (e) { setError(e.message); }
  }
  async function remove(s) {
    if (!confirm(`Remove ${s.name}? Past sales keep their name.`)) return;
    try { await api.adminDeleteStaff(s.id); await load(); } catch (e) { setError(e.message); }
  }

  if (editing !== null) return <StaffForm initial={editing} onSave={handleSave} onCancel={() => setEditing(null)} />;

  return (
    <div>
      <div className="row" style={{ marginTop: 16 }}>
        <h2 style={{ margin: 0 }}>Staff</h2>
        <div className="till-cats" style={{ marginLeft: 12 }}>
          <button className={`till-cat ${view === 'staff' ? 'active' : ''}`} onClick={() => setView('staff')}>PINs &amp; roles</button>
          <button className={`till-cat ${view === 'timesheets' ? 'active' : ''}`} onClick={() => setView('timesheets')}>⏱ Timesheets</button>
        </div>
        <div className="spacer" />
        {view === 'staff' && <button className="btn" onClick={() => setEditing({})}>+ Add staff</button>}
      </div>
      {view === 'timesheets' && <Timesheets />}
      {view === 'staff' && <>
      <p className="muted" style={{ fontSize: 13 }}>
        Staff sign in to the till and prep screen with their PIN. Managers can also open Admin. The owner password always works as a fallback.
      </p>
      {loading && <div className="center muted">Loading…</div>}
      {error && <div className="center err">{error}</div>}
      {!loading && (
        <div className="panel">
          {staff.length === 0 ? (
            <p className="muted center">No staff yet — add the first cashier or manager.</p>
          ) : (
            <table>
              <thead>
                <tr><th>Name</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr>
              </thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id} style={{ opacity: s.active ? 1 : 0.55 }}>
                    <td><strong>{s.name}</strong></td>
                    <td>{ROLES.find((r) => r.key === s.role)?.label || s.role}</td>
                    <td><span className={`tag ${s.active ? 'ok' : 'off'}`}>{s.active ? 'Active' : 'Disabled'}</span></td>
                    <td className="muted">{s.last_login_at ? new Date(s.last_login_at).toLocaleString() : '—'}</td>
                    <td className="row" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn ghost" onClick={() => setEditing(s)}>Edit / PIN</button>
                      <button className="btn ghost" onClick={() => toggleActive(s)}>{s.active ? 'Disable' : 'Enable'}</button>
                      <button className="btn ghost" onClick={() => remove(s)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      </>}
    </div>
  );
}
