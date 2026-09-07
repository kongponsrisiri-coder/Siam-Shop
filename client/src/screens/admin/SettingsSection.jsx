import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

// Editable fields driven by adminGetSettings / adminUpdateSettings. Values are
// returned/saved as strings (backend contract).
const FIELDS = [
  { key: 'minimum_order_amount', label: 'Minimum order amount (£)', type: 'number', step: '0.01' },
  { key: 'delivery_fee_london', label: 'Delivery fee — London (£)', type: 'number', step: '0.01' },
  { key: 'delivery_fee_mainland', label: 'Delivery fee — UK mainland (£)', type: 'number', step: '0.01' },
  { key: 'delivery_fee_remote', label: 'Delivery fee — remote (£)', type: 'number', step: '0.01' },
  { key: 'restock_day', label: 'Restock day (e.g. Thursday)', type: 'text' },
  { key: 'currency', label: 'Currency (e.g. GBP)', type: 'text' },
  { key: 'shop_email', label: 'Shop notification email (new orders)', type: 'email' },
  { key: 'bank_details', label: 'Bank details (emailed to bank-transfer customers)', type: 'textarea' },
  { key: 'return_address', label: 'Return address (printed on parcel labels)', type: 'textarea' },
];

// Opening hours (SIAMSHOP-503) + Click & Collect (SIAMSHOP-504) — stored as
// settings strings: opening_hours (JSON), bank_holidays, collection_* keys.
const DAY_ROWS = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
  ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
];
function parseHours(raw) {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const out = {};
    for (const [k] of DAY_ROWS) out[k] = o && o[k] ? { open: true, from: o[k].from, to: o[k].to } : { open: false, from: '09:30', to: '18:00' };
    return out;
  } catch {
    const out = {};
    for (const [k] of DAY_ROWS) out[k] = { open: false, from: '09:30', to: '18:00' };
    return out;
  }
}
function serialiseHours(h) {
  const out = {};
  let any = false;
  for (const [k] of DAY_ROWS) {
    if (h[k]?.open && h[k].from && h[k].to && h[k].from < h[k].to) { out[k] = { from: h[k].from, to: h[k].to }; any = true; }
  }
  return any ? JSON.stringify(out) : '';
}

function HoursEditor({ hours, onChange }) {
  function set(k, patch) {
    onChange({ ...hours, [k]: { ...hours[k], ...patch } });
  }
  return (
    <div className="hours-grid">
      {DAY_ROWS.map(([k, label]) => (
        <React.Fragment key={k}>
          <label className="row" style={{ margin: 0, gap: 6 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!hours[k].open} onChange={(e) => set(k, { open: e.target.checked })} />
            {label.slice(0, 3)}
          </label>
          <input type="time" value={hours[k].from} disabled={!hours[k].open} onChange={(e) => set(k, { from: e.target.value })} />
          <input type="time" value={hours[k].to} disabled={!hours[k].open} onChange={(e) => set(k, { to: e.target.value })} />
          <span className="muted" style={{ fontSize: 12 }}>{hours[k].open ? '' : 'closed'}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

export default function SettingsSection() {
  const [form, setForm] = useState(null);
  const [hours, setHours] = useState(parseHours(null));
  const [shop, setShop] = useState(null);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [testBusy, setTestBusy] = useState(false);

  async function sendTest(e) {
    e.preventDefault();
    setTestBusy(true);
    setTestResult(null);
    try {
      const r = await api.adminTestEmail(testTo);
      setTestResult({ ok: true, text: `Sent to ${r.sent_to} from ${r.from}. Check the inbox (and spam).` });
    } catch (err) {
      setTestResult({ ok: false, text: err.message });
    } finally {
      setTestBusy(false);
    }
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const s = await api.adminGetSettings();
      setForm(s || {});
      setHours(parseHours(s?.opening_hours));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    api.getShop().then(setShop).catch(() => {});
    api.health().then(setHealth).catch(() => {});
  }, []);

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const patch = {};
      FIELDS.forEach((f) => { patch[f.key] = form[f.key] ?? ''; });
      patch.shop_language_default = form.shop_language_default ?? 'en';
      patch.opening_hours = serialiseHours(hours);
      patch.bank_holidays = form.bank_holidays ?? '';
      patch.collection_enabled = form.collection_enabled === 'true' ? 'true' : 'false';
      patch.collection_address = form.collection_address ?? '';
      patch.pickup_lead_minutes = String(Number(form.pickup_lead_minutes) || 20);
      patch.pickup_slot_minutes = String(Number(form.pickup_slot_minutes) || 15);
      const updated = await api.adminUpdateSettings(patch);
      setForm(updated || form);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>Settings</h2>

      {loading && <div className="center muted">Loading…</div>}
      {error && <div className="center err">{error}</div>}

      {!loading && form && (
        <form className="panel" onSubmit={save}>
          <h3 style={{ marginTop: 0 }}>Shop settings</h3>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            {FIELDS.map((f) => (
              <div key={f.key} style={{ flex: f.type === 'textarea' ? '1 1 100%' : '1 1 220px' }}>
                <label>{f.label}</label>
                {f.type === 'textarea' ? (
                  <textarea
                    rows="4"
                    placeholder="Account name&#10;Sort code: 00-00-00&#10;Account no: 12345678"
                    value={form[f.key] ?? ''}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                ) : (
                  <input
                    type={f.type}
                    step={f.step}
                    value={form[f.key] ?? ''}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                )}
              </div>
            ))}
            <div style={{ flex: '1 1 220px' }}>
              <label>Default language</label>
              <select
                value={form.shop_language_default ?? 'en'}
                onChange={(e) => set('shop_language_default', e.target.value)}
              >
                <option value="en">English</option>
                <option value="th">Thai</option>
              </select>
            </div>
          </div>
          <h3 style={{ marginTop: 20 }}>Opening hours</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Leave every day unticked to accept orders at any time. When set, the website stops taking
            orders outside these hours (scheduled collections inside them still work) and the till warns.
            Times are UK local time.
          </p>
          <HoursEditor hours={hours} onChange={(h) => { setHours(h); setSaved(false); }} />
          <label style={{ marginTop: 10 }}>Bank holidays (use Sunday hours) — dates YYYY-MM-DD, comma separated</label>
          <input value={form.bank_holidays ?? ''} onChange={(e) => set('bank_holidays', e.target.value)} placeholder="2026-12-25, 2026-12-28, 2027-01-01" />

          <h3 style={{ marginTop: 20 }}>Click &amp; Collect</h3>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={form.collection_enabled === 'true'} onChange={(e) => set('collection_enabled', e.target.checked ? 'true' : 'false')} />
            <span>Offer collection at checkout (customer picks a time; you mark it ready and they get an email)</span>
          </label>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 100%' }}>
              <label>Collection address (shown to customers)</label>
              <input value={form.collection_address ?? ''} onChange={(e) => set('collection_address', e.target.value)} placeholder="16 London Rd, Guildford GU1 2AF" />
            </div>
            <div style={{ flex: '1 1 160px' }}>
              <label>Lead time (minutes)</label>
              <input type="number" min="0" value={form.pickup_lead_minutes ?? 20} onChange={(e) => set('pickup_lead_minutes', e.target.value)} />
            </div>
            <div style={{ flex: '1 1 160px' }}>
              <label>Slot length (minutes)</label>
              <input type="number" min="5" value={form.pickup_slot_minutes ?? 15} onChange={(e) => set('pickup_slot_minutes', e.target.value)} />
            </div>
          </div>

          {saved && <p style={{ color: '#16a34a', fontSize: 13 }}>Saved ✓</p>}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
          </div>
        </form>
      )}

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Shop</h3>
        {shop ? (
          <table>
            <tbody>
              <tr><th>Name</th><td>{shop.name}</td></tr>
              <tr><th>Slug</th><td>{shop.slug}</td></tr>
              <tr><th>Shop ID</th><td>{shop.id}</td></tr>
            </tbody>
          </table>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Email test</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Sends a test email via Brevo and shows the exact result — handy for confirming the sender + key.
        </p>
        <form className="row" onSubmit={sendTest} style={{ gap: 8 }}>
          <input
            type="email"
            placeholder="you@example.com"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            style={{ flex: '1 1 220px' }}
          />
          <button className="btn secondary" disabled={testBusy}>{testBusy ? 'Sending…' : 'Send test'}</button>
        </form>
        {testResult && (
          <p style={{ marginTop: 8, fontSize: 13, color: testResult.ok ? '#16a34a' : 'var(--siam-red)' }}>
            {testResult.ok ? '✅ ' : '❌ '}{testResult.text}
          </p>
        )}
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>System status</h3>
        {health ? (
          <table>
            <tbody>
              <tr><th>Service</th><td>{health.service}</td></tr>
              <tr><th>Database</th><td>{health.db}</td></tr>
              <tr><th>Stripe</th><td>{health.stripe}</td></tr>
            </tbody>
          </table>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>
    </div>
  );
}
