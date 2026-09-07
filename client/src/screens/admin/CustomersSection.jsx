import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { maskName, maskEmail } from '../../demo.js';

// Customers → CRM (SIAMSHOP-CRM-001, port of the restaurant's SEPOS-033):
// spend, dates, days since last order, top products, channel split; status
// tiles (VIP / Regular / New / Lapsed); search + sort; operator-recorded consent
// with source + time; birthday (MM-DD); CSV. No loyalty points (Korakot's hold).
const money = (n) => `£${Number(n || 0).toFixed(2)}`;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const fmtWhen = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtBirthday = (mmdd) => { const m = /^(\d{2})-(\d{2})$/.exec(mmdd || ''); return m ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1]}` : ''; };
const STATUS = {
  VIP: { cls: 'crm-vip', icon: '⭐' }, Regular: { cls: 'crm-regular', icon: '🔁' }, New: { cls: 'crm-new', icon: '🆕' }, Lapsed: { cls: 'crm-lapsed', icon: '😴' },
};
const SOURCE_LABEL = { verbal: 'told us in person', paper: 'signed a form', counter: 'asked at the counter', phone: 'by phone', online: 'ticked the box online', import: 'imported list', unsubscribed: 'unsubscribed' };

function orderState(o) {
  if (o.status === 'cancelled') return { label: 'Cancelled', cls: 'off' };
  if (o.payment_status === 'refunded') return { label: 'Refunded', cls: 'off' };
  if (o.payment_status !== 'paid') return { label: 'Awaiting payment', cls: 'off' };
  if (o.status === 'dispatched') return { label: 'Dispatched', cls: 'ok' };
  return { label: o.channel === 'instore' ? 'In store' : 'Paid', cls: 'ok' };
}

// Consent badge — click → modal to record consent given verbally / on paper /
// at the counter (manager). Shows when and how it was given (GDPR).
function ConsentBadge({ c, onChange }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('verbal');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const label = c.unsubscribed ? 'Unsubscribed' : c.marketing_consent ? 'Opted in' : 'No consent';
  const cls = c.unsubscribed ? 'off' : c.marketing_consent ? 'ok' : '';
  const title = c.consent_at ? `${label} · ${SOURCE_LABEL[c.consent_source] || c.consent_source || ''} · ${fmtWhen(c.consent_at)}` : label;
  async function apply(consent) {
    setBusy(true); setErr('');
    try { await onChange(consent, source); setOpen(false); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  }
  return (
    <>
      <button type="button" className={`tag ${cls} tag-btn`} title={title} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>{label}{c.consent_at ? ' ·' : ''}</button>
      {open && (
        <div className="till-modal" onClick={(e) => { e.stopPropagation(); setOpen(false); }} style={{ zIndex: 55 }}>
          <div className="till-receipt" style={{ width: 400 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Marketing consent</h3>
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
              {c.name || c.email || c.phone}<br />
              {c.consent_at ? <>Currently <strong>{label}</strong> — {SOURCE_LABEL[c.consent_source] || c.consent_source} on {fmtWhen(c.consent_at)}.</> : <>No consent recorded yet.</>}
              {c.unsubscribed && <><br />They unsubscribed from an email — only record a new opt-in if they have asked to hear from you again.</>}
            </p>
            <label>How was consent given?</label>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="verbal">Told us in person</option>
              <option value="counter">Asked at the counter</option>
              <option value="paper">Signed a form</option>
              <option value="phone">By phone</option>
            </select>
            {err && <p className="err">{err}</p>}
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancel</button>
              <div className="spacer" />
              {(c.marketing_consent && !c.unsubscribed) && <button type="button" className="btn cancel-btn" disabled={busy} onClick={() => apply(false)}>Withdraw consent</button>}
              <button type="button" className="btn" disabled={busy} onClick={() => apply(true)}>Record opt-in</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function BirthdayButton({ c, onChange }) {
  const [open, setOpen] = useState(false);
  const m = /^(\d{2})-(\d{2})$/.exec(c.birthday || '');
  const [month, setMonth] = useState(m ? Number(m[1]) : 0);
  const [day, setDay] = useState(m ? Number(m[2]) : 0);
  const [err, setErr] = useState('');
  async function save(clear) {
    setErr('');
    try { await onChange(clear ? '' : `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`); setOpen(false); }
    catch (e) { setErr(e.message); }
  }
  return (
    <>
      <button type="button" className={`tag tag-btn ${c.birthday ? 'crm-bday' : 'crm-dim'}`} onClick={(e) => { e.stopPropagation(); setOpen(true); }} title={c.birthday ? 'Edit birthday' : 'Add birthday'}>{c.birthday ? `🎂 ${fmtBirthday(c.birthday)}` : '+ 🎂'}</button>
      {open && (
        <div className="till-modal" onClick={(e) => { e.stopPropagation(); setOpen(false); }} style={{ zIndex: 55 }}>
          <div className="till-receipt" style={{ width: 360 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Birthday</h3>
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Day and month only — we never store the year. Used for the birthday email when that automation is on.</p>
            <div className="row" style={{ gap: 8 }}>
              <select value={day} onChange={(e) => setDay(Number(e.target.value))}><option value={0}>Day</option>{Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select>
              <select value={month} onChange={(e) => setMonth(Number(e.target.value))}><option value={0}>Month</option>{MONTHS.map((mo, i) => <option key={mo} value={i + 1}>{mo}</option>)}</select>
            </div>
            {err && <p className="err">{err}</p>}
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancel</button>
              <div className="spacer" />
              {c.birthday && <button type="button" className="btn ghost" onClick={() => save(true)}>Clear</button>}
              <button type="button" className="btn" disabled={!day || !month} onClick={() => save(false)}>Save</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function CustomerDetail({ id, onBack, onDeleted, onChanged }) {
  const [cust, setCust] = useState(null);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const load = () => api.adminGetCustomer(id).then(setCust).catch((e) => setError(e.message));
  useEffect(() => { setError(''); load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function handleDelete() {
    setDeleting(true); setError('');
    try { await api.adminDeleteCustomer(id); onDeleted(); }
    catch (e) { setError(e.message); setDeleting(false); setConfirmDel(false); }
  }
  if (error && !cust) return <div className="center err">{error} — <button className="btn ghost" onClick={onBack}>back</button></div>;
  if (!cust) return <div className="center muted">Loading…</div>;
  const st = STATUS[cust.status] || STATUS.New;
  const orders = cust.orders || [];
  return (
    <div>
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn ghost" onClick={onBack}>← Back to customers</button>
        <div className="spacer" />
        <button className="btn danger" onClick={() => setConfirmDel(true)} disabled={deleting}>{deleting ? 'Deleting…' : '🗑 Delete customer'}</button>
      </div>
      {error && <div className="center err">{error}</div>}
      <div className="panel">
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>{maskName(cust.name || cust.email || cust.phone || '—', cust.id)}</h2>
          <span className={`tag ${st.cls}`}>{st.icon} {cust.status}</span>
          {cust.has_account && <span className="tag">Online account</span>}
        </div>
        <table style={{ marginTop: 10 }}><tbody>
          <tr><th>Email</th><td>{cust.email ? maskEmail(cust.email, cust.id) : '—'}</td></tr>
          <tr><th>Phone</th><td>{cust.phone || '—'}</td></tr>
          <tr><th>Marketing</th><td><ConsentBadge c={cust} onChange={async (consent, source) => { await api.adminSetConsent(cust.id, consent, source); await load(); onChanged && onChanged(); }} />
            {cust.consent_at && <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>{SOURCE_LABEL[cust.consent_source] || cust.consent_source} · {fmtWhen(cust.consent_at)}</span>}
            {cust.unsubscribed_at && <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>unsubscribed {fmtWhen(cust.unsubscribed_at)}</span>}</td></tr>
          <tr><th>Birthday</th><td><BirthdayButton c={cust} onChange={async (b) => { await api.adminSetBirthday(cust.id, b); await load(); onChanged && onChanged(); }} /></td></tr>
          <tr><th>Customer since</th><td>{fmtDate(cust.created_at)}</td></tr>
        </tbody></table>
      </div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Spend</h3>
        <div className="kpi-grid account-kpis">
          <div className="kpi"><div className="kpi-label">Orders</div><div className="kpi-value">{cust.order_count}</div><div className="kpi-sub">{cust.channels.instore} in store · {cust.channels.online} online</div></div>
          <div className="kpi"><div className="kpi-label">Total spent</div><div className="kpi-value">{money(cust.total_spent)}</div><div className="kpi-sub">avg basket {money(cust.avg_basket)}</div></div>
          <div className="kpi"><div className="kpi-label">Last order</div><div className="kpi-value" style={{ fontSize: 20 }}>{fmtDate(cust.last_order_at)}</div><div className="kpi-sub">{cust.days_since_last != null ? `${cust.days_since_last} days ago` : 'never'}</div></div>
          <div className="kpi"><div className="kpi-label">First order</div><div className="kpi-value" style={{ fontSize: 20 }}>{fmtDate(cust.first_order_at)}</div><div className="kpi-sub">{cust.channels.postal} posted · {cust.channels.collection} collected</div></div>
        </div>
        {cust.top_products.length > 0 && (
          <p style={{ margin: '6px 0 0' }}><strong>Buys most:</strong> {cust.top_products.map((t) => `${t.name} (×${t.qty} over ${t.orders} order${t.orders === 1 ? '' : 's'})`).join(' · ')}</p>
        )}
      </div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Orders</h3>
        {orders.length === 0 ? <p className="muted">No orders yet.</p> : (
          <table>
            <thead><tr><th>#</th><th>Date</th><th>Channel</th><th>Status</th><th>Items</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
            <tbody>
              {orders.map((o) => { const s = orderState(o); return (
                <tr key={o.id}>
                  <td><strong>#{o.id}</strong></td>
                  <td className="muted">{new Date(o.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>{o.channel === 'instore' ? 'Till' : o.fulfilment === 'collection' ? 'Online · collect' : 'Online · post'}</td>
                  <td><span className={`tag ${s.cls}`}>{s.label}</span></td>
                  <td className="muted" style={{ fontSize: 12, maxWidth: 360 }}>{o.items_text}</td>
                  <td style={{ textAlign: 'right' }}>{money(o.total)}</td>
                </tr>); })}
            </tbody>
          </table>
        )}
      </div>
      {(cust.automations || []).length > 0 && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Automatic emails</h3>
          <table><tbody>{cust.automations.map((a, i) => <tr key={i}><td>{a.event_type}</td><td className="muted">{fmtWhen(a.created_at)}</td><td><span className={`tag ${a.sent ? 'ok' : 'off'}`}>{a.sent ? 'sent' : 'failed'}</span></td></tr>)}</tbody></table>
        </div>
      )}
      {confirmDel && (
        <div className="till-modal" onClick={() => setConfirmDel(false)} style={{ zIndex: 55 }}>
          <div className="till-receipt" style={{ width: 400 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Delete {cust.name || cust.email || 'this customer'}?</h3>
            <p className="muted" style={{ fontSize: 13 }}>Removes their account and contact details permanently. {cust.order_count > 0 ? `Their ${cust.order_count} past orders stay in your sales records but are no longer linked to a name.` : ''} This cannot be undone.</p>
            <div className="row" style={{ gap: 8 }}><button className="btn secondary" onClick={() => setConfirmDel(false)}>Keep</button><div className="spacer" /><button className="btn cancel-btn" disabled={deleting} onClick={handleDelete}>Delete</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function AddCustomerModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', marketing_consent: false, consent_source: 'verbal' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function save(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try { const c = await api.adminCreateCustomer(form); onCreated(c); }
    catch (ex) { setErr(ex.message); }
    setBusy(false);
  }
  return (
    <div className="till-modal" onClick={onClose} style={{ zIndex: 55 }}>
      <form className="till-receipt" style={{ width: 420 }} onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h3 style={{ marginTop: 0 }}>Add a customer</h3>
        <label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        <label>Phone</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" />
        <label>Email (optional if phone given)</label><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} inputMode="email" />
        <label className="row" style={{ gap: 8, marginTop: 10 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.marketing_consent} onChange={(e) => setForm({ ...form, marketing_consent: e.target.checked })} />
          <span>They agreed to marketing emails</span>
        </label>
        {form.marketing_consent && (
          <select value={form.consent_source} onChange={(e) => setForm({ ...form, consent_source: e.target.value })}>
            <option value="verbal">Told us in person</option><option value="counter">Asked at the counter</option><option value="paper">Signed a form</option><option value="phone">By phone</option>
          </select>
        )}
        {err && <p className="err">{err}</p>}
        <div className="row" style={{ gap: 8, marginTop: 12 }}><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><div className="spacer" /><button className="btn" disabled={busy}>Add customer</button></div>
      </form>
    </div>
  );
}

export default function CustomersSection() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('All'); // All | VIP | Regular | New | Lapsed | Consented
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('spend'); // spend | last | orders | name
  const [lapsedDays, setLapsedDays] = useState(45);
  const [adding, setAdding] = useState(false);

  async function load() {
    setLoading(true); setError('');
    try {
      const rows = await api.adminListCustomers(false);
      setCustomers(Array.isArray(rows) ? rows : []);
      const a = await api.automations().catch(() => null);
      if (a?.lapsed_days) setLapsedDays(a.lapsed_days);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function saveLapsedDays(v) {
    setLapsedDays(v);
    try { await api.automationsSave({ lapsed_days: v }); await load(); } catch (e) { setError(e.message); }
  }
  async function setConsent(c, consent, source) {
    await api.adminSetConsent(c.id, consent, source);
    setCustomers((prev) => prev.map((x) => (x.id === c.id ? { ...x, marketing_consent: consent, consent_source: source, consent_at: new Date().toISOString(), unsubscribed: consent ? false : x.unsubscribed, eligible: consent && !!x.email } : x)));
  }

  const counts = useMemo(() => {
    const k = { VIP: 0, Regular: 0, New: 0, Lapsed: 0, Consented: 0 };
    for (const c of customers) { k[c.status] = (k[c.status] || 0) + 1; if (c.eligible) k.Consented++; }
    return k;
  }, [customers]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = customers.filter((c) => {
      if (filter === 'Consented' && !c.eligible) return false;
      if (['VIP', 'Regular', 'New', 'Lapsed'].includes(filter) && c.status !== filter) return false;
      if (!q) return true;
      return `${c.name || ''} ${c.email || ''} ${c.phone || ''} ${(c.top_products || []).map((t) => t.name).join(' ')}`.toLowerCase().includes(q);
    });
    const by = { spend: (a, b) => b.total_spent - a.total_spent, orders: (a, b) => b.order_count - a.order_count, name: (a, b) => String(a.name || a.email || '').localeCompare(String(b.name || b.email || '')),
      last: (a, b) => new Date(b.last_order_at || 0) - new Date(a.last_order_at || 0) };
    return list.sort(by[sort] || by.spend);
  }, [customers, filter, search, sort]);

  async function exportCsv() {
    try {
      const seg = filter === 'Consented' ? 'consented' : filter === 'All' ? '' : filter.toLowerCase();
      const blob = await api.exportCustomersCsv(false, seg);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `siamshop-customers-${filter.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { setError(e.message); }
  }

  if (selected != null) return <CustomerDetail id={selected} onBack={() => setSelected(null)} onDeleted={() => { setSelected(null); load(); }} onChanged={load} />;

  return (
    <div>
      <div className="row" style={{ marginTop: 16, gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Customers</h2>
        <div className="spacer" />
        <button className="btn secondary" onClick={() => setAdding(true)}>+ Add customer</button>
        {customers.length > 0 && <button className="btn secondary" onClick={exportCsv}>⬇ Export CSV</button>}
      </div>

      <div className="crm-tiles">
        <button type="button" className={`crm-tile ${filter === 'All' ? 'on' : ''}`} onClick={() => setFilter('All')}><span>👥 All</span><strong>{customers.length}</strong></button>
        {['VIP', 'Regular', 'New', 'Lapsed'].map((s) => (
          <button type="button" key={s} className={`crm-tile ${STATUS[s].cls} ${filter === s ? 'on' : ''}`} onClick={() => setFilter(filter === s ? 'All' : s)}>
            <span>{STATUS[s].icon} {s}{s === 'Lapsed' ? <small> {lapsedDays}+ d</small> : ''}</span><strong>{counts[s] || 0}</strong>
          </button>
        ))}
        <button type="button" className={`crm-tile crm-consent ${filter === 'Consented' ? 'on' : ''}`} onClick={() => setFilter(filter === 'Consented' ? 'All' : 'Consented')}><span>✉ Can be emailed</span><strong>{counts.Consented}</strong></button>
      </div>

      <div className="panel row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, phone or product…" style={{ flex: '1 1 220px', margin: 0 }} />
        <select value={sort} onChange={(e) => setSort(e.target.value)} style={{ width: 'auto', margin: 0 }}>
          <option value="spend">Sort: spend</option><option value="last">Sort: last order</option><option value="orders">Sort: orders</option><option value="name">Sort: name</option>
        </select>
        <label className="row" style={{ gap: 6, margin: 0, fontSize: 13 }}>
          Lapsed after
          <select value={lapsedDays} onChange={(e) => saveLapsedDays(Number(e.target.value))} style={{ width: 'auto', margin: 0 }}>
            {[30, 45, 60, 90, 120].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>
        <button className="btn secondary" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>

      {error && <div className="center err">{error}</div>}
      {!loading && (
        <div className="panel">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>{filtered.length} of {customers.length} customer{customers.length === 1 ? '' : 's'}. Click a row for orders, top products and consent history.</p>
          {filtered.length === 0 ? <p className="muted center">{customers.length === 0 ? 'No customers yet — they appear from online orders, or when the till attaches a sale to a customer.' : 'No customers match.'}</p> : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead><tr><th>Customer</th><th>Status</th><th style={{ textAlign: 'right' }}>Orders</th><th style={{ textAlign: 'right' }}>Spent</th><th>Last order</th><th>Buys most</th><th>Where</th><th>Marketing</th><th>🎂</th></tr></thead>
                <tbody>
                  {filtered.map((c) => { const st = STATUS[c.status] || STATUS.New; return (
                    <tr key={c.id} className="order-row" onClick={() => setSelected(c.id)}>
                      <td><strong>{maskName(c.name || '—', c.id)}</strong><div className="muted" style={{ fontSize: 12 }}>{c.email ? maskEmail(c.email, c.id) : ''}{c.email && c.phone ? ' · ' : ''}{c.phone || ''}</div></td>
                      <td><span className={`tag ${st.cls}`}>{st.icon} {c.status}</span></td>
                      <td style={{ textAlign: 'right' }}>{c.order_count}</td>
                      <td style={{ textAlign: 'right' }}><strong>{money(c.total_spent)}</strong><div className="muted" style={{ fontSize: 11 }}>avg {money(c.avg_basket)}</div></td>
                      <td>{fmtDate(c.last_order_at)}{c.days_since_last != null && <div className="muted" style={{ fontSize: 11 }}>{c.days_since_last} d ago</div>}</td>
                      <td className="muted" style={{ fontSize: 12, maxWidth: 240 }}>{(c.top_products || []).slice(0, 2).map((t) => `${t.name} ×${t.qty}`).join(', ') || '—'}</td>
                      <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{c.channels.instore ? `🏪 ${c.channels.instore} ` : ''}{c.channels.postal ? `📦 ${c.channels.postal} ` : ''}{c.channels.collection ? `🛍 ${c.channels.collection}` : ''}</td>
                      <td><ConsentBadge c={c} onChange={(consent, source) => setConsent(c, consent, source)} /></td>
                      <td><BirthdayButton c={c} onChange={async (b) => { await api.adminSetBirthday(c.id, b); setCustomers((prev) => prev.map((x) => (x.id === c.id ? { ...x, birthday: b || null } : x))); }} /></td>
                    </tr>); })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {adding && <AddCustomerModal onClose={() => setAdding(false)} onCreated={() => { setAdding(false); load(); }} />}
    </div>
  );
}
