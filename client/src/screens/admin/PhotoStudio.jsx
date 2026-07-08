import React, { useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { compressImage } from '../../lib/image.js';

// "Snap first, tag later" bulk flow. Staff take several product photos in one
// go, then search and assign each shot to a product. Reuses the same
// /api/admin/products/:id/photo endpoint as the per-row PhotoButton.
//
// Props: products (admin list), onDone(updatedProduct) to keep the list in sync,
//        onClose() to return to the products table.
export default function PhotoStudio({ products, onDone, onClose }) {
  const [shots, setShots] = useState([]); // {key, dataUrl, product, status, error}
  const [busyAdd, setBusyAdd] = useState(false);
  const seq = useRef(0);

  // Which product ids already have a photo (from the list) or got one this session.
  const [tagged, setTagged] = useState(() => new Set(products.filter((p) => p.image_url).map((p) => p.id)));

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setBusyAdd(true);
    try {
      for (const file of files) {
        try {
          const dataUrl = await compressImage(file, { maxDim: 1000, quality: 0.82 });
          seq.current += 1;
          const key = `s${seq.current}`;
          setShots((s) => [{ key, dataUrl, product: null, status: 'pending', error: '' }, ...s]);
        } catch {
          /* skip a file that won't decode */
        }
      }
    } finally {
      setBusyAdd(false);
    }
  }

  function setShot(key, patch) {
    setShots((s) => s.map((sh) => (sh.key === key ? { ...sh, ...patch } : sh)));
  }

  async function assign(shot) {
    if (!shot.product) return;
    setShot(shot.key, { status: 'saving', error: '' });
    try {
      const updated = await api.uploadProductPhoto(shot.product.id, shot.dataUrl);
      setShot(shot.key, { status: 'done' });
      setTagged((t) => new Set(t).add(shot.product.id));
      onDone?.(updated);
    } catch (e) {
      setShot(shot.key, { status: 'pending', error: e.message || 'Upload failed' });
    }
  }

  const pending = shots.filter((s) => s.status !== 'done').length;

  return (
    <div>
      <div className="row" style={{ marginTop: 16, alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>📷 Photo studio</h2>
        <div className="spacer" />
        <button className="btn secondary" onClick={onClose}>← Back to products</button>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        Take photos of several products, then search and tag each one. {pending > 0 && <strong>{pending} to tag.</strong>}
      </p>

      <div className="panel" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="btn" style={{ cursor: 'pointer' }}>
          📷 Take photo
          <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
                 onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        </label>
        <label className="btn secondary" style={{ cursor: 'pointer' }}>
          🖼 Upload photos
          <input type="file" accept="image/*" multiple style={{ display: 'none' }}
                 onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        </label>
        {busyAdd && <span className="muted">Processing…</span>}
      </div>

      {shots.length === 0 ? (
        <div className="center muted">No photos yet. Tap <strong>Take photo</strong> to start — snap as many as you like, then tag them below.</div>
      ) : (
        <div className="studio-grid">
          {shots.map((shot) => (
            <ShotCard
              key={shot.key}
              shot={shot}
              products={products}
              tagged={tagged}
              onPick={(product) => setShot(shot.key, { product })}
              onAssign={() => assign(shot)}
              onRemove={() => setShots((s) => s.filter((x) => x.key !== shot.key))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ShotCard({ shot, products, tagged, onPick, onAssign, onRemove }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return products
      .filter((p) => `${p.name} ${p.name_th || ''} ${p.barcode || ''} ${p.sku || ''}`.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [q, products]);

  const done = shot.status === 'done';

  return (
    <div className={`studio-card ${done ? 'is-done' : ''}`}>
      <div className="studio-img" style={{ backgroundImage: `url(${shot.dataUrl})` }}>
        {done && <span className="studio-tick">✓</span>}
      </div>
      <div className="studio-body">
        {done ? (
          <div className="studio-assigned">
            Saved to <strong>{shot.product?.name}</strong>
          </div>
        ) : (
          <>
            {shot.product ? (
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span style={{ flex: 1 }}>
                  {shot.product.name}
                  {tagged.has(shot.product.id) && <span className="muted" style={{ fontSize: 11 }}> · already has a photo</span>}
                </span>
                <button className="btn ghost mini" onClick={() => { onPick(null); setQ(''); }}>change</button>
              </div>
            ) : (
              <div style={{ position: 'relative' }}>
                <input
                  placeholder="Search product (name / barcode / SKU)…"
                  value={q}
                  onChange={(e) => { setQ(e.target.value); setOpen(true); }}
                  onFocus={() => setOpen(true)}
                />
                {open && matches.length > 0 && (
                  <div className="studio-menu">
                    {matches.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="studio-opt"
                        onClick={() => { onPick({ id: p.id, name: p.name }); setOpen(false); }}
                      >
                        {p.image_url && <img src={p.image_url} alt="" className="studio-opt-thumb" />}
                        <span>
                          {p.name}
                          {p.image_url && <span className="muted" style={{ fontSize: 11 }}> · has photo</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {shot.error && <div className="err" style={{ fontSize: 12 }}>{shot.error}</div>}
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button className="btn" disabled={!shot.product || shot.status === 'saving'} onClick={onAssign}>
                {shot.status === 'saving' ? 'Saving…' : 'Assign photo'}
              </button>
              <button className="btn ghost mini" onClick={onRemove}>Discard</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
