import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

const EMPTY = { name: '', name_th: '', sort_order: '' };

// JS getDay() numbering; shown Monday-first.
const DAYS = [
  { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' }, { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' }, { n: 0, label: 'Sun' },
];
const NEW_RULE = () => ({ days: [1, 2, 3, 4, 5, 6], from: '12:00', to: '15:00' });

// Availability window editor (SIAMSHOP-503): "this category can only be
// ordered Mon–Sat 12:00–15:00". Empty = always available.
function AvailabilityEditor({ rules, onChange }) {
  function setRule(i, patch) {
    onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function toggleDay(i, n) {
    const r = rules[i];
    const days = r.days.includes(n) ? r.days.filter((d) => d !== n) : [...r.days, n];
    setRule(i, { days });
  }
  return (
    <div className="opt-editor">
      {rules.length === 0 && (
        <p className="muted" style={{ margin: '0 0 8px', fontSize: 13 }}>
          Always available. Add a window to limit ordering times — e.g. a lunch menu Mon–Sat 12:00–15:00.
          Times are the shop's local time; scheduled collections are checked against the pickup time.
        </p>
      )}
      {rules.map((r, i) => (
        <div className="opt-editor-group" key={i}>
          <div className="opt-editor-row">
            <div className="days-pick">
              {DAYS.map((d) => (
                <button type="button" key={d.n} className={r.days.includes(d.n) ? 'on' : ''} onClick={() => toggleDay(i, d.n)}>{d.label}</button>
              ))}
            </div>
            <span className="muted" style={{ fontSize: 12 }}>from</span>
            <input className="num" type="time" value={r.from} onChange={(e) => setRule(i, { from: e.target.value })} />
            <span className="muted" style={{ fontSize: 12 }}>to</span>
            <input className="num" type="time" value={r.to} onChange={(e) => setRule(i, { to: e.target.value })} />
            <button type="button" className="btn ghost" onClick={() => onChange(rules.filter((_, idx) => idx !== i))} title="Remove window">✕</button>
          </div>
        </div>
      ))}
      <button type="button" className="btn secondary" onClick={() => onChange([...rules, NEW_RULE()])}>+ Add time window</button>
    </div>
  );
}

function CategoryForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState({ ...EMPTY, ...initial });
  const [rules, setRules] = useState(() => (initial?.availability?.rules || []).map((r) => ({ days: r.days || [], from: r.from, to: r.to })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      for (const r of rules) {
        if (!r.days.length) throw new Error('Each time window needs at least one day');
        if (!r.from || !r.to || r.from >= r.to) throw new Error('Each time window needs from < to');
      }
      await onSave({
        name: form.name.trim(),
        name_th: (form.name_th || '').trim(),
        sort_order: form.sort_order === '' ? 0 : Number(form.sort_order),
        availability: rules.length ? { rules } : null,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={save}>
      <h3 style={{ marginTop: 0 }}>{initial?.id ? 'Edit category' : 'New category'}</h3>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px' }}>
          <label>Name *</label>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} required />
        </div>
        <div style={{ flex: '1 1 200px' }}>
          <label>Name (Thai)</label>
          <input value={form.name_th || ''} onChange={(e) => set('name_th', e.target.value)} />
        </div>
        <div style={{ flex: '1 1 110px' }}>
          <label>Sort order</label>
          <input type="number" value={form.sort_order ?? ''} onChange={(e) => set('sort_order', e.target.value)} />
        </div>
      </div>
      <label style={{ marginTop: 12 }}>Available times</label>
      <AvailabilityEditor rules={rules} onChange={setRules} />
      {error && <p className="err">{error}</p>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function CategoriesSection() {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // null | {} | category

  async function load() {
    setLoading(true);
    setError('');
    try {
      setCategories(await api.getCategories());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSave(data) {
    if (editing?.id) {
      await api.adminUpdateCategory(editing.id, data);
    } else {
      await api.adminCreateCategory(data);
    }
    setEditing(null);
    await load();
  }

  async function handleDelete(c) {
    if (!confirm(`Delete category "${c.name}"?`)) return;
    await api.adminDeleteCategory(c.id);
    await load();
  }

  if (editing !== null) {
    return <CategoryForm initial={editing} onSave={handleSave} onCancel={() => setEditing(null)} />;
  }

  return (
    <div>
      <div className="row" style={{ marginTop: 16 }}>
        <h2 style={{ margin: 0 }}>Categories</h2>
        <div className="spacer" />
        <button className="btn" onClick={() => setEditing({})}>+ New category</button>
      </div>

      {loading && <div className="center muted">Loading…</div>}
      {error && <div className="center err">{error}</div>}

      {!loading && !error && (
        <div className="panel">
          {categories.length === 0 ? (
            <p className="muted center">No categories yet. Click "New category" to add one.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Name (Thai)</th>
                  <th>Available</th>
                  <th>Sort</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{c.name_th || '—'}</td>
                    <td>
                      {c.availability_text ? (
                        <span className={`avail-badge ${c.available_now ? '' : 'off'}`}>{c.availability_text}{c.available_now ? '' : ' · closed now'}</span>
                      ) : <span className="muted">always</span>}
                    </td>
                    <td>{c.sort_order ?? 0}</td>
                    <td className="row" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn ghost" onClick={() => setEditing(c)}>Edit</button>
                      <button className="btn ghost" onClick={() => handleDelete(c)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
