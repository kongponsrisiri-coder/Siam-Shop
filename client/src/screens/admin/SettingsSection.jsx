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
];

export default function SettingsSection() {
  const [form, setForm] = useState(null);
  const [shop, setShop] = useState(null);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const s = await api.adminGetSettings();
      setForm(s || {});
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
              <div key={f.key} style={{ flex: '1 1 220px' }}>
                <label>{f.label}</label>
                <input
                  type={f.type}
                  step={f.step}
                  value={form[f.key] ?? ''}
                  onChange={(e) => set(f.key, e.target.value)}
                />
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
