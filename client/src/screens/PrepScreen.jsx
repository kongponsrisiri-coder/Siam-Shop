import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, auth, staffSession } from '../api.js';
import { Logo } from '../components/Logo.jsx';
import { isElectron, electronConfig } from '../electron.js';
import { usePrepPrinting } from '../usePrepPrinting.js';
import StaffGate, { StaffChip } from '../components/StaffGate.jsx';

// Counter prep screen (SIAMSHOP-505). One column of tickets for every paid
// order (or till sale) that contains a made-to-order line: what to cook, with
// options, who it's for, when they're collecting. Start → Ready → Done.
// Polls every 10 s; chimes on a new ticket; each ticket prints as an 80 mm slip.

const POLL_MS = 10000;

// Two short beeps via WebAudio — no asset to load, works on tablets after the
// first user interaction (browsers gate audio until then).
function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = (t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.start(t);
      o.stop(t + 0.3);
    };
    beep(ctx.currentTime);
    beep(ctx.currentTime + 0.35);
  } catch {
    /* no audio — fine */
  }
}

function ageMinutes(iso, now) {
  return Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
}

const FULFILMENT_LABEL = {
  collection: 'Collection',
  delivery: 'Delivery',
  dine_in: 'Eat in',
  takeaway: 'Take away',
};

function Ticket({ o, now, busy, onStatus, onPrint, printMe }) {
  const age = ageMinutes(o.created_at, now);
  const urgency = o.prep_status === 'ready' ? 'ready' : age < 5 ? 'fresh' : age < 10 ? 'warm' : 'late';
  const source = o.channel === 'instore' ? 'Till' : o.source === 'messenger' ? 'Messenger' : 'Online';
  return (
    <div className={`prep-ticket ${urgency} ${printMe ? 'print-me' : ''}`} data-order={o.id}>
      <div className="prep-head">
        <div>
          <span className="prep-no">#{o.id}</span>
          <span className="prep-src">{source}</span>
          <span className={`tag ${o.fulfilment === 'collection' ? 'ok' : ''}`}>{FULFILMENT_LABEL[o.fulfilment] || o.fulfilment}</span>
        </div>
        <div className="prep-when">
          {o.pickup_label ? <strong>Pickup {o.pickup_label}</strong> : <strong>Now</strong>}
          <span className="muted"> · {age} min ago</span>
        </div>
      </div>
      {o.customer_name && <div className="prep-cust">{o.customer_name}</div>}
      <ul className="prep-lines">
        {o.food.map((f, i) => (
          <li key={i}>
            <span className="prep-qty">{f.qty}×</span>
            <span>
              <span className="prep-name">{f.name}</span>
              {f.options?.length > 0 && <div className="prep-opts">{f.options.map((x) => x.name).join(', ')}</div>}
            </span>
          </li>
        ))}
      </ul>
      {o.grocery_count > 0 && <div className="muted prep-groc">+ {o.grocery_count} grocery item{o.grocery_count === 1 ? '' : 's'} (packed at the till)</div>}
      {o.notes && <div className="prep-notes">📝 {o.notes}</div>}
      <div className="prep-actions no-print">
        {!o.prep_status && <button className="btn" disabled={busy} onClick={() => onStatus(o.id, 'preparing')}>▶ Start</button>}
        {o.prep_status === 'preparing' && <button className="btn" disabled={busy} onClick={() => onStatus(o.id, 'ready')}>✅ Ready</button>}
        {o.prep_status === 'ready' && (
          <button className="btn" disabled={busy} onClick={() => onStatus(o.id, 'done')}>
            {o.fulfilment === 'collection' ? '🛍️ Collected' : '✔ Done'}
          </button>
        )}
        {!o.prep_status && <button className="btn secondary" disabled={busy} onClick={() => onStatus(o.id, 'ready')}>Ready</button>}
        <button className="btn ghost" onClick={() => onPrint(o.id)}>🖨 Print</button>
      </div>
    </div>
  );
}

export default function PrepScreen() {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [orders, setOrders] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sound, setSound] = useState(true);
  const [printing, setPrinting] = useState(null);
  const seen = useRef(null); // Set of ids seen so far (null until first load)
  // Prep printers (SIAMSHOP-PRINTERS-001): this device prints queued tickets; 🖨 reprints.
  const prep = usePrepPrinting({ enabled: authed && isElectron });
  const [reprintMsg, setReprintMsg] = useState('');

  useEffect(() => {
    if (!auth.get()) { setChecking(false); return; }
    api.me().then(() => setAuthed(true)).catch((e) => { if (e.status === 401 || e.status === 403) { auth.clear(); staffSession.clear(); } }).finally(() => setChecking(false));
  }, []);

  async function load() {
    try {
      const { orders: list } = await api.prepList();
      setOrders(list);
      setError('');
      const ids = new Set(list.map((o) => o.id));
      if (seen.current && sound && [...ids].some((id) => !seen.current.has(id))) chime();
      seen.current = ids;
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    if (!authed) return;
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 15000);
    return () => { clearInterval(poll); clearInterval(tick); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, sound]);

  async function setStatus(id, status) {
    setBusy(true);
    try {
      await api.prepStatus(id, status);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Print one ticket. Desktop: reprint on the prep printer(s) via the queue
  // (SIAMSHOP-PRINTERS-001). Browser: mark it, window.print(), unmark.
  async function printTicket(id) {
    if (isElectron) {
      setReprintMsg('Reprinting…');
      try {
        const r = await api.prepReprint(id, electronConfig.deviceId);
        await prep.printTickets(r.prep_tickets);
        setReprintMsg(prep.lastError ? `Held — ${prep.lastError}` : 'Prep ticket reprinted');
      } catch (e) { setReprintMsg(e.message); }
      setTimeout(() => setReprintMsg(''), 4000);
      return;
    }
    setPrinting(id);
    setTimeout(() => {
      window.print();
      setPrinting(null);
    }, 50);
  }

  if (checking) return <div className="container center muted">Loading…</div>;
  if (!authed) return <StaffGate need="staff" title="Prep screen sign in" onIn={() => setAuthed(true)} />;

  const heldBadge = isElectron && (prep.held > 0 || prep.lastError) ? (
    <div className="till-flash err no-print">🍜 Prep printer offline — {prep.held || 1} ticket{(prep.held || 1) === 1 ? '' : 's'} held, retrying every 30 s{prep.lastError ? ` · ${prep.lastError}` : ''}</div>
  ) : null;
  const queue = orders.filter((o) => o.prep_status !== 'ready');
  const ready = orders.filter((o) => o.prep_status === 'ready');

  return (
    <div className={`prep ${printing ? 'printing' : ''}`} data-printing={printing || ''}>
      <div className="till-head no-print">
        <Link to="/" className="brand surface-brand"><Logo size={26} light /><span className="surface-tag">Prep</span></Link>
        <StaffChip onOut={() => setAuthed(false)} />
        <div className="spacer" />
        <span className="till-takings">{queue.length} to make · {ready.length} ready</span>
        <button className={`btn ${sound ? 'secondary' : 'ghost'}`} style={{ marginLeft: 12 }} onClick={() => setSound((s) => !s)} title="New-order chime">
          {sound ? '🔔 Sound on' : '🔕 Sound off'}
        </button>
        <Link to="/till" className="btn secondary" style={{ marginLeft: 8 }}>Till</Link>
      </div>
      {error && <div className="till-flash err no-print">{error}</div>}
      {heldBadge}
      {reprintMsg && <div className="till-flash ok no-print">{reprintMsg}</div>}

      <div className="prep-cols">
        <section className="prep-col">
          <h3 className="no-print">To make</h3>
          {queue.length === 0 && <p className="muted no-print">Nothing to make right now.</p>}
          {queue.map((o) => (
            <Ticket key={o.id} o={o} now={now} busy={busy} onStatus={setStatus} onPrint={printTicket} printMe={printing === o.id} />
          ))}
        </section>
        <section className="prep-col">
          <h3 className="no-print">Ready</h3>
          {ready.length === 0 && <p className="muted no-print">—</p>}
          {ready.map((o) => (
            <Ticket key={o.id} o={o} now={now} busy={busy} onStatus={setStatus} onPrint={printTicket} printMe={printing === o.id} />
          ))}
        </section>
      </div>
    </div>
  );
}
