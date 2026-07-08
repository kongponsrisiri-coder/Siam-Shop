import React, { useRef, useState } from 'react';
import { api } from '../api.js';
import { compressImage } from '../lib/image.js';

// Back-office product photo control. Shows the current thumbnail and a button
// that opens the phone camera (capture="environment") or a file picker, then
// compresses and uploads. On mobile this is a one-tap "snap the product" flow.
//
// Props: product {id, image_url}, onDone(updated) to refresh the list,
//        compact (small variant for table rows).
export default function PhotoButton({ product, onDone, compact = false }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Cache-bust the thumbnail after a fresh upload within this session.
  const [bust, setBust] = useState(0);

  const hasPhoto = !!product.image_url;
  const thumbSrc = hasPhoto ? `${product.image_url}${bust ? `${product.image_url.includes('?') ? '&' : '?'}b=${bust}` : ''}` : '';

  async function onPick(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setErr('');
    setBusy(true);
    try {
      const dataUrl = await compressImage(file, { maxDim: 1000, quality: 0.82 });
      const updated = await api.uploadProductPhoto(product.id, dataUrl);
      setBust(Date.now());
      onDone?.(updated);
    } catch (e2) {
      setErr(e2.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm('Remove this photo?')) return;
    setBusy(true);
    setErr('');
    try {
      const updated = await api.deleteProductPhoto(product.id);
      setBust(Date.now());
      onDone?.(updated);
    } catch (e2) {
      setErr(e2.message || 'Failed to remove');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`photo-btn ${compact ? 'compact' : ''}`}>
      <div className="photo-thumb" onClick={() => !busy && inputRef.current?.click()} title={hasPhoto ? 'Replace photo' : 'Add photo'}>
        {hasPhoto ? (
          <img src={thumbSrc} alt="" />
        ) : (
          <span className="photo-ph">📷</span>
        )}
        {busy && <span className="photo-spin">…</span>}
      </div>
      {!compact && (
        <div className="photo-actions">
          <button type="button" className="btn ghost mini" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? 'Uploading…' : hasPhoto ? '📷 Replace' : '📷 Add photo'}
          </button>
          {hasPhoto && (
            <button type="button" className="btn ghost mini" disabled={busy} onClick={remove}>Remove</button>
          )}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={onPick}
      />
      {err && <div className="err" style={{ fontSize: 11 }}>{err}</div>}
    </div>
  );
}
