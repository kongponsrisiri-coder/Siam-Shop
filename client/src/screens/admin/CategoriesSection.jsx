import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

const EMPTY = { name: '', name_th: '', sort_order: '' };

function CategoryForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState({ ...EMPTY, ...initial });
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
      await onSave({
        name: form.name.trim(),
        name_th: (form.name_th || '').trim(),
        sort_order: form.sort_order === '' ? 0 : Number(form.sort_order),
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
                  <th>Sort</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{c.name_th || '—'}</td>
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
