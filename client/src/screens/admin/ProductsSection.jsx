import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import PhotoButton from '../../components/PhotoButton.jsx';
import PhotoStudio from './PhotoStudio.jsx';

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
  kind: 'retail',
  weight_grams: '',
  sort_order: '',
  category_id: '',
  image_url: '',
  is_active: true,
};

const UNITS = ['each', 'kg', 'g', 'pack', 'bottle', 'can', 'box'];

// ---------------------------------------------------------------------------
// Option groups editor (SIAMSHOP-501) — "Size: Medium / Large (+£1)",
// "Toppings: choose 2", "Add-ons: up to 3". Saved as one tree on product save.
// ---------------------------------------------------------------------------
const NEW_OPTION = () => ({ name: '', name_th: '', price_delta: '', is_default: false });
const NEW_GROUP = () => ({ name: '', name_th: '', min_select: 1, max_select: 1, options: [NEW_OPTION()] });

// Server rows → editable form rows (numbers as strings for the inputs).
function groupsToForm(groups) {
  return (groups || []).map((g) => ({
    name: g.name || '',
    name_th: g.name_th || '',
    min_select: g.min_select ?? 0,
    max_select: g.max_select ?? 1,
    options: (g.options || []).map((o) => ({
      name: o.name || '',
      name_th: o.name_th || '',
      price_delta: o.price_delta ? String(o.price_delta) : '',
      is_default: !!o.is_default,
    })),
  }));
}

function OptionGroupsEditor({ groups, onChange }) {
  function setGroup(gi, patch) {
    onChange(groups.map((g, i) => (i === gi ? { ...g, ...patch } : g)));
  }
  function setOption(gi, oi, patch) {
    setGroup(gi, { options: groups[gi].options.map((o, i) => (i === oi ? { ...o, ...patch } : o)) });
  }
  function removeGroup(gi) {
    onChange(groups.filter((_, i) => i !== gi));
  }
  function removeOption(gi, oi) {
    setGroup(gi, { options: groups[gi].options.filter((_, i) => i !== oi) });
  }
  function move(gi, dir) {
    const j = gi + dir;
    if (j < 0 || j >= groups.length) return;
    const next = [...groups];
    [next[gi], next[j]] = [next[j], next[gi]];
    onChange(next);
  }

  return (
    <div className="opt-editor">
      {groups.length === 0 && (
        <p className="muted" style={{ margin: '0 0 8px', fontSize: 13 }}>
          No options. Add a group for things like <em>Size</em> (Medium / Large +£1), <em>Toppings</em> (choose 2)
          or <em>Add-ons</em> (up to 3, each priced).
        </p>
      )}
      {groups.map((g, gi) => {
        const single = Number(g.max_select) === 1;
        return (
          <div className="opt-editor-group" key={gi}>
            <div className="opt-editor-row">
              <input className="grow" placeholder="Group name, e.g. Size" value={g.name} onChange={(e) => setGroup(gi, { name: e.target.value })} required />
              <input className="grow" placeholder="ชื่อกลุ่ม (Thai, optional)" value={g.name_th} onChange={(e) => setGroup(gi, { name_th: e.target.value })} />
              <button type="button" className="btn ghost" onClick={() => move(gi, -1)} disabled={gi === 0} title="Move up">↑</button>
              <button type="button" className="btn ghost" onClick={() => move(gi, 1)} disabled={gi === groups.length - 1} title="Move down">↓</button>
              <button type="button" className="btn ghost" onClick={() => removeGroup(gi)} title="Remove group">✕</button>
            </div>
            <div className="opt-editor-row" style={{ marginTop: 6 }}>
              <label style={{ margin: 0, fontSize: 12 }}>Choose min</label>
              <input className="num" type="number" min="0" value={g.min_select} onChange={(e) => setGroup(gi, { min_select: e.target.value })} />
              <label style={{ margin: 0, fontSize: 12 }}>max</label>
              <input className="num" type="number" min="1" value={g.max_select} onChange={(e) => setGroup(gi, { max_select: e.target.value })} />
              <span className="muted" style={{ fontSize: 12 }}>
                {Number(g.min_select) === 0 ? 'optional' : 'required'} · {single ? 'single choice' : `up to ${g.max_select}`}
              </span>
            </div>
            <div style={{ marginTop: 8 }}>
              {g.options.map((o, oi) => (
                <div className="opt-editor-row" key={oi} style={{ marginBottom: 6 }}>
                  <input className="grow" placeholder="Choice, e.g. Large" value={o.name} onChange={(e) => setOption(gi, oi, { name: e.target.value })} required />
                  <input className="grow" placeholder="ชื่อ (Thai)" value={o.name_th} onChange={(e) => setOption(gi, oi, { name_th: e.target.value })} />
                  <span className="muted" style={{ fontSize: 12 }}>£ +/−</span>
                  <input className="num" type="number" step="0.01" placeholder="0.00" value={o.price_delta} onChange={(e) => setOption(gi, oi, { price_delta: e.target.value })} />
                  <label className="row" style={{ margin: 0, gap: 4, fontSize: 12 }}>
                    <input
                      type={single ? 'radio' : 'checkbox'}
                      name={`default-${gi}`}
                      style={{ width: 'auto' }}
                      checked={!!o.is_default}
                      onChange={(e) => {
                        if (single) {
                          setGroup(gi, { options: g.options.map((x, i) => ({ ...x, is_default: i === oi })) });
                        } else {
                          setOption(gi, oi, { is_default: e.target.checked });
                        }
                      }}
                    />
                    default
                  </label>
                  <button type="button" className="btn ghost" onClick={() => removeOption(gi, oi)} title="Remove choice">✕</button>
                </div>
              ))}
              <button type="button" className="btn ghost" onClick={() => setGroup(gi, { options: [...g.options, NEW_OPTION()] })}>
                + Add choice
              </button>
            </div>
          </div>
        );
      })}
      <button type="button" className="btn secondary" onClick={() => onChange([...groups, NEW_GROUP()])}>
        + Add option group
      </button>
    </div>
  );
}

// Form rows → API payload.
function groupsToPayload(groups) {
  return groups.map((g) => ({
    name: g.name.trim(),
    name_th: g.name_th.trim() || null,
    min_select: Number(g.min_select) || 0,
    max_select: Number(g.max_select) || 1,
    options: g.options.map((o) => ({
      name: o.name.trim(),
      name_th: o.name_th.trim() || null,
      price_delta: Number(o.price_delta) || 0,
      is_default: !!o.is_default,
    })),
  }));
}

function ProductForm({ initial, categories, onSave, onCancel }) {
  const [form, setForm] = useState({ ...EMPTY, ...initial });
  const [groups, setGroups] = useState(() => groupsToForm(initial?.option_groups));
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState('');

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // SIAMSHOP-502: made-to-order food normally isn't counted — flip the default,
  // but leave it editable (boba cups do run out).
  function setKind(kind) {
    setForm((f) => ({ ...f, kind, track_stock: kind === 'food' ? false : f.track_stock }));
  }

  // SIAMSHOP-008 — fill description (EN+TH), and the English name if missing.
  async function generate() {
    setAiBusy(true);
    setError('');
    try {
      const cat = categories.find((c) => String(c.id) === String(form.category_id));
      const out = await api.aiDescribeProduct({ name: form.name, name_th: form.name_th, category: cat?.name });
      setForm((f) => ({
        ...f,
        name: f.name?.trim() ? f.name : out.name || f.name,
        description: out.description || f.description,
        description_th: out.description_th || f.description_th,
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setAiBusy(false);
    }
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave(
        {
          ...form,
          price: Number(form.price) || 0,
          cost_price: Number(form.cost_price) || 0,
          stock_qty: Number(form.stock_qty) || 0,
          weight_grams: form.weight_grams === '' ? null : Number(form.weight_grams),
          sort_order: form.sort_order === '' ? null : Number(form.sort_order),
          category_id: form.category_id === '' ? null : Number(form.category_id),
          track_stock: !!form.track_stock,
          kind: form.kind === 'food' ? 'food' : 'retail',
        },
        groupsToPayload(groups)
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const food = form.kind === 'food';

  return (
    <form className="panel" onSubmit={save}>
      <h3 style={{ marginTop: 0 }}>{initial?.id ? 'Edit product' : 'New product'}</h3>

      <label>Type</label>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <button type="button" className={`btn ${!food ? '' : 'secondary'}`} onClick={() => setKind('retail')}>🛒 Shelf product</button>
        <button type="button" className={`btn ${food ? '' : 'secondary'}`} onClick={() => setKind('food')}>🍜 Made to order</button>
        <span className="muted" style={{ fontSize: 12 }}>
          {food ? 'Cooked/made at the counter — shows on the prep screen; stock not counted by default.' : 'Stocked on the shelf — barcode + stock count.'}
        </span>
      </div>

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
      <div className="row" style={{ marginTop: 10 }}>
        <label style={{ margin: 0 }}>Description</label>
        <div className="spacer" />
        <button type="button" className="btn ghost" onClick={generate} disabled={aiBusy || (!form.name && !form.name_th)}>
          {aiBusy ? '✨ Generating…' : '✨ Generate with AI'}
        </button>
      </div>
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
          <label>{groups.length ? 'Base price (£)' : 'Sell price (£)'}</label>
          <input type="number" step="0.01" value={form.price} onChange={(e) => set('price', e.target.value)} />
        </div>
        <div style={{ flex: '1 1 110px' }}>
          <label>Cost price (£)</label>
          <input type="number" step="0.01" value={form.cost_price} onChange={(e) => set('cost_price', e.target.value)} />
        </div>
        <div style={{ flex: '1 1 100px' }}>
          <label>Stock qty</label>
          <input type="number" value={form.stock_qty} onChange={(e) => set('stock_qty', e.target.value)} disabled={!form.track_stock} />
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

      <label style={{ marginTop: 12 }}>Options (size, toppings, add-ons)</label>
      <OptionGroupsEditor groups={groups} onChange={setGroups} />

      <label style={{ marginTop: 12 }}>Photo</label>
      {initial?.id ? (
        <PhotoButton
          product={{ id: initial.id, image_url: form.image_url }}
          onDone={(u) => set('image_url', u.image_url || '')}
        />
      ) : (
        <p className="muted" style={{ fontSize: 13, margin: '2px 0 8px' }}>
          Save the product first, then add a photo (take one with your phone camera).
        </p>
      )}
      <label>…or paste an image URL</label>
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
  const [studio, setStudio] = useState(false); // snap-first bulk photo flow

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

  // Save the product, then its option tree (needs the id for a new product).
  async function handleSave(data, groups) {
    let id = editing?.id;
    if (id) {
      await api.updateProduct(id, data);
    } else {
      ({ id } = await api.createProduct(data));
    }
    const had = (editing?.option_groups || []).length > 0;
    if (groups.length > 0 || had) await api.saveProductOptions(id, groups);
    setEditing(null);
    await load();
  }

  async function handleDelete(p) {
    if (!confirm(`Delete "${p.name}"?`)) return;
    await api.deleteProduct(p.id);
    await load();
  }

  if (studio) {
    return (
      <PhotoStudio
        products={products}
        onDone={(u) =>
          setProducts((ps) => ps.map((x) => (x.id === u.id ? { ...x, image_url: u.image_url } : x)))
        }
        onClose={() => setStudio(false)}
      />
    );
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
        <button className="btn secondary" onClick={() => setStudio(true)}>📷 Photo studio</button>
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
                  <th>Photo</th>
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
                      <PhotoButton
                        product={p}
                        compact
                        onDone={(u) =>
                          setProducts((ps) => ps.map((x) => (x.id === u.id ? { ...x, image_url: u.image_url } : x)))
                        }
                      />
                    </td>
                    <td>
                      {p.name}
                      {p.kind === 'food' && <span className="tag kind-food" style={{ marginLeft: 6 }}>made to order</span>}
                      {p.name_th && <div className="muted" style={{ fontSize: 12 }}>{p.name_th}</div>}
                      {p.barcode && <div className="muted" style={{ fontSize: 11 }}>▮ {p.barcode}</div>}
                      {p.option_groups?.length > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          ⚙ {p.option_groups.map((g) => `${g.name} (${g.options.length})`).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td>{p.category || '—'}</td>
                    <td>{p.option_groups?.length > 0 ? 'from ' : ''}£{Number(p.price).toFixed(2)}</td>
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
