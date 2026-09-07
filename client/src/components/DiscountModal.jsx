import React, { useState } from 'react';

// Discount picker (SIAMSHOP-DISCOUNT-001) for a basket line or the whole
// basket: % or £ + a reason from the shop's list. Pure UI — the server re-prices
// and decides whether a manager must approve.
const money = (n) => '£' + Number(n || 0).toFixed(2);

export default function DiscountModal({ title, base, reasons, initial, onApply, onRemove, onClose }) {
  const [type, setType] = useState(initial?.type || 'percent');
  const [value, setValue] = useState(initial?.value != null ? String(initial.value) : '');
  const [reason, setReason] = useState(initial?.reason || reasons[0] || '');
  const [error, setError] = useState('');
  const v = Number(value);
  const amount = !Number.isFinite(v) || v <= 0 ? 0 : type === 'percent' ? Math.min(100, v) * base / 100 : Math.min(v, base);

  function apply() {
    if (!Number.isFinite(v) || v <= 0) return setError('Enter a discount amount');
    if (type === 'percent' && v > 100) return setError('Percent cannot exceed 100');
    if (!reason) return setError('Choose a reason');
    onApply({ type, value: +v.toFixed(2), reason, amount: +amount.toFixed(2) });
  }

  return (
    <div className="till-modal" onClick={onClose} style={{ zIndex: 55 }}>
      <div className="till-receipt" style={{ width: 380 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>On {money(base)}</p>
        <div className="fulfil-toggle">
          <button type="button" className={type === 'percent' ? 'on' : ''} onClick={() => setType('percent')}>% off</button>
          <button type="button" className={type === 'fixed' ? 'on' : ''} onClick={() => setType('fixed')}>£ off</button>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          {(type === 'percent' ? [5, 10, 20, 50] : [1, 2, 5, 10]).map((q) => (
            <button type="button" key={q} className={`btn mini ${String(q) === value ? '' : 'secondary'}`} onClick={() => setValue(String(q))}>{type === 'percent' ? `${q}%` : money(q)}</button>
          ))}
        </div>
        <label>{type === 'percent' ? 'Percent' : 'Amount (£)'}</label>
        <input type="number" inputMode="decimal" step="0.01" min="0" value={value} onChange={(e) => { setValue(e.target.value); setError(''); }} autoFocus />
        <label>Reason</label>
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <div style={{ marginTop: 8, fontWeight: 700 }}>Takes off {money(amount)}</div>
        {error && <p className="err">{error}</p>}
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          {initial && <button type="button" className="btn ghost" onClick={onRemove}>Remove discount</button>}
          <div className="spacer" />
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" onClick={apply}>Apply</button>
        </div>
      </div>
    </div>
  );
}
