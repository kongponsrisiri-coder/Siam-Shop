import React, { useState } from 'react';
import { api } from '../api.js';
import { applyBrandTheme, fileToLogoDataUrl, BRAND_PRESETS, DEFAULT_PRIMARY, DEFAULT_ACCENT, isHex } from '../theme.js';
import { LotusBadge } from './Logo.jsx';

// Admin → Settings → Brand (SIAMSHOP-DEVICE-001 D3/D4): the shop's logo and two
// colours, saved as shop settings and applied live. "Reset to SiamShop" clears
// them. Also the receipt "show logo" switch (D4).
export default function BrandCard({ settings, onSaved }) {
  const [primary, setPrimary] = useState(settings?.brand_primary || DEFAULT_PRIMARY);
  const [accent, setAccent] = useState(settings?.brand_accent || DEFAULT_ACCENT);
  const [logo, setLogo] = useState(settings?.brand_logo || '');
  const [showLogo, setShowLogo] = useState(settings?.receipt_show_logo === '1' || settings?.receipt_show_logo === true || settings?.receipt_show_logo === 'true');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setMsg('');
    try {
      const url = await fileToLogoDataUrl(f);
      if (url.length > 400000) throw new Error('Logo is too large even after resizing — try a simpler image');
      setLogo(url);
    } catch (err) { setMsg(err.message); }
    e.target.value = '';
  }
  async function save(values) {
    setBusy(true); setMsg('');
    try {
      const body = values || { brand_primary: primary, brand_accent: accent, brand_logo: logo, receipt_show_logo: showLogo ? '1' : '0' };
      const saved = await api.adminUpdateSettings(body);
      applyBrandTheme(saved);
      onSaved && onSaved(saved);
      setMsg('Saved — the till and PIN screen now use this brand.');
    } catch (err) { setMsg(err.message); }
    setBusy(false);
  }
  function reset() {
    setPrimary(DEFAULT_PRIMARY); setAccent(DEFAULT_ACCENT); setLogo('');
    save({ brand_primary: '', brand_accent: '', brand_logo: '', receipt_show_logo: showLogo ? '1' : '0' });
  }
  const preview = { primary: isHex(primary) ? primary : DEFAULT_PRIMARY, accent: isHex(accent) ? accent : DEFAULT_ACCENT };

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Brand</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Your logo and colours on the till header, the staff PIN screen, Admin and the online shop. Leave as is for the SiamShop look.
      </p>
      <div className="row" style={{ gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 260px' }}>
          <label>Logo</label>
          <div className="brand-logo-dark" style={{ background: preview.primary }}>
            {logo ? <img className="brand-logo-preview" src={logo} alt="Shop logo preview" /> : <span className="row" style={{ gap: 8, alignItems: 'center', color: '#fff', fontFamily: 'var(--serif)', fontWeight: 700 }}><LotusBadge size={28} center={preview.primary} /> Siam<span style={{ color: preview.accent }}>Shop</span></span>}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <label className="btn secondary" style={{ cursor: 'pointer', margin: 0 }}>
              Upload logo…<input type="file" accept="image/*" onChange={onFile} style={{ display: 'none' }} />
            </label>
            {logo && <button type="button" className="btn ghost" onClick={() => setLogo('')}>Remove logo</button>}
          </div>
          <p className="muted" style={{ fontSize: 12 }}>PNG with a transparent background works best. It is resized to fit; keep it simple so it prints cleanly on receipts.</p>
          <label className="row" style={{ gap: 8, marginTop: 6 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={showLogo} onChange={(e) => setShowLogo(e.target.checked)} />
            <span>Print the logo at the top of till receipts</span>
          </label>
        </div>
        <div style={{ flex: '1 1 260px' }}>
          <label>Colours</label>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
            <label className="row" style={{ gap: 8, alignItems: 'center' }}>
              <input type="color" className="brand-swatch" value={preview.primary} onChange={(e) => setPrimary(e.target.value)} style={{ padding: 0, width: 44, height: 34 }} />
              <span>Main colour<br /><span className="muted" style={{ fontSize: 12 }}>header, headings, totals</span></span>
            </label>
            <label className="row" style={{ gap: 8, alignItems: 'center' }}>
              <input type="color" className="brand-swatch" value={preview.accent} onChange={(e) => setAccent(e.target.value)} style={{ padding: 0, width: 44, height: 34 }} />
              <span>Accent<br /><span className="muted" style={{ fontSize: 12 }}>highlights, hovers</span></span>
            </label>
          </div>
          <label style={{ marginTop: 10 }}>Presets</label>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {BRAND_PRESETS.map((p) => (
              <button type="button" key={p.name} className="brand-preset" onClick={() => { setPrimary(p.primary); setAccent(p.accent); }}>
                <span className="dot" style={{ background: p.primary }} /><span className="dot" style={{ background: p.accent }} />{p.name}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button type="button" className="btn" disabled={busy} onClick={() => save()}>{busy ? 'Saving…' : 'Save brand'}</button>
        <button type="button" className="btn ghost" disabled={busy} onClick={reset}>Reset to SiamShop</button>
        {msg && <span className="muted" style={{ fontSize: 13, alignSelf: 'center' }}>{msg}</span>}
      </div>
    </div>
  );
}
