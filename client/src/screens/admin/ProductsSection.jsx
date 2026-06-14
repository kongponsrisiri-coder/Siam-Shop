import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

const EMPTY = {
  name: '',
  name_th: '',
  description: '',
  description_th: '',
  barcode: '',
  sku: '',
  unit: 'each',
  price: '',
  cost_price: '',
  stock_qty: '',
  track_stock: true,
  weight_grams: '',
  sort_order: '',
  category_id: '',
  image_url: '',
  is_active: true,
};

const UNITS = ['each', 'kg', 'g', 'pack', 'bottle', 'can', 'box'];

function ProductForm({ initial, categories, onSave, onCancel }) {
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
        ...form,
        price: Number(form.price) || 0,
        cost_price: Number(form.cost_price) || 0,
        stock_qty: Number(form.stock_qty) || 0,
        weight_grams: form.weight_grams === '' ? null : Number(form.weight_grams),
        sort_order: form.sort_order === '' ? null : Number(form.sort_order),
        category_id: form.category_id === '' ? null : Number(form.category_id),
        track_stock: !!form.track_stock,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={save}>
      <h3 style={{ marginTop: 0 }}>{initial?.id ? 'Edit product' : 'New product'}</h3>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 240px' }}>
          <label>Name *</label>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} required />
        </div>
        <div style={{ flex: '1 1 240px' }}>
          <label>Name (Thai)</label>
          <input value={form.name_th || ''} onChange={(e) => set('name_th', e.target.value)} />
        </div>
      </div>
      <label>Description</label>
      <textarea rows="3" value={form.description || ''} onChange={(e) => set('description', e.target.value)} />
      <label>Description (Thai)</label>
      <textarea rows="3" value={form.description_th || ''} onChange={(e) => set('description_th', e.target.value)} />
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px' }}>
          <label>Barcode (EAN/UPC)</label>
          <input value={form.barcode || ''} onChange={(e) => set('barcode', e.target.value)} placeholder="e.g. 8850999320014" />
        </div>
        <div style={{ flex: '1 1 140px' }}>
          <label>SKU</label>
          <input value={form.sku || ''} onChange={(e) => set('sku', e.target.value)} />
        </div>
        <div style={{ flex: '1 1 100px' }}>
          <label>Unit</label>
          <select value={form.unit || 'each'} onChange={(e) => set('unit', e.target.value)}>
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 110px' }}>
          <label>Sell price (£)</label>
          <input type="number" step="0.01" value={form.price} onChange={(e) => set('price', e.target.value)} />
        </div>
        <div style={{ flex: '1 1 110px' }}>
          <label>Cost price (£)</label>
          <input type="number" step="0.01" value={form.cost_price} onChange={(e) => set('cost_price', e.target.value)} />
        </div>
        <div style={{ flex: '1 1 100px' }}>
          <label>Stock qty</label>
          <input type="number" value={form.stock_qty} onChange={(e) => set('stock_qty', e.target.value)} />
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <label>Category</label>
          <select value={form.category_id ?? ''} onChange={(e) => set('category_id', e.target.value)}>
            <option value="">— none —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.name_th ? ` / ${c.name_th}` : ''}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 130px' }}>
          <label>Weight (grams)</label>
          <input type="number" value={form.weight_grams ?? ''} onChange={(e) => set('weight_grams', e.target.value)} />
        </div>
        <div style={{ flex: '1 1 110px' }}>
          <label>Sort order</label>
          <input type="number" value={form.sort_order ?? ''} onChange={(e) => set('sort_order', e.target.value)} />
        </div>
      </div>
      <label>Image URL</label>
      <input value={form.image_url || ''} onChange={(e) => set('image_url', e.target.value)} />
      <label className="row" style={{ marginTop: 12, gap: 8 }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={!!form.track_stock}
          onChange={(e) => set('track_stock', e.target.checked)}
        />
        <span>Track stock (show out-of-stock & notify-me)</span>
      </label>
      <label className="row" style={{ marginTop: 8, gap: 8 }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={form.is_active}
          onChange={(e) => set('is_active', e.target.checked)}
        />
        <span>Active (visible on storefront)</span>
      </label>
      {error && <p className="err">{error}</p>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function ProductsSection() {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // null | {} | product

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [prods, cats] = await Promise.all([
        api.adminListProducts(),
        api.getCategories().catch(() => []),
      ]);
      setProducts(prods);
      setCategories(cats || []);
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
      await api.updateProduct(editing.id, data);
    } else {
      await api.createProduct(data);
    }
    setEditing(null);
    await load();
  }

  async function handleDelete(p) {
    if (!confirm(`Delete "${p.name}"?`)) return;
    await api.deleteProduct(p.id);
    await load();
  }

  if (editing !== null) {
    return (
      <ProductForm
        initial={editing}
        categories={categories}
        onSave={handleSave}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <div>
      <div className="row" style={{ marginTop: 16 }}>
        <h2 style={{ margin: 0 }}>Products</h2>
        <div className="spacer" />
        <button className="btn" onClick={() => setEditing({})}>+ New product</button>
      </div>

      {loading && <div className="center muted">Loading…</div>}
      {error && <div className="center err">{error}</div>}

      {!loading && !error && (
        <div className="panel">
          {products.length === 0 ? (
            <p className="muted center">No products yet. Click "New product" to add one.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Category</th>
                  <th>Price</th>
                  <th>Stock</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.name}
                      {p.name_th && <div className="muted" style={{ fontSize: 12 }}>{p.name_th}</div>}
                      {p.barcode && <div className="muted" style={{ fontSize: 11 }}>▮ {p.barcode}</div>}
                    </td>
                    <td>{p.category || '—'}</td>
                    <td>£{Number(p.price).toFixed(2)}</td>
                    <td>{p.track_stock ? p.stock_qty : '∞'}</td>
                    <td>
                      <span className={`tag ${p.is_active ? '' : 'off'}`}>
                        {p.is_active ? 'Active' : 'Hidden'}
                      </span>
                    </td>
                    <td className="row" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn ghost" onClick={() => setEditing(p)}>Edit</button>
                      <button className="btn ghost" onClick={() => handleDelete(p)}>Delete</button>
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
