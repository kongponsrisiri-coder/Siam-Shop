import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import PrintLabelButton from './PrintLabelButton.jsx';

// Till → 📦 Post: paid postal orders waiting to go out (SIAMSHOP-POST-001).
// Cashiers can print the label and mark dispatched without opening Admin.
export default function PostalOrders({ onClose }) {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);

  async function load() {
    try {
      const all = await api.adminListOrders();
      setOrders(all.filter((o) => o.fulfilment === 'delivery' && o.payment_status === 'paid' && o.status !== 'cancelled' && o.status !== 'dispatched' && o.status !== 'completed'));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => { load(); }, []);

  async function dispatch(o) {
    setBusy(o.id);
    try {
      await api.adminDispatchOrder(o.id, '', null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="till-modal" onClick={onClose}>
      <div className="till-receipt" style={{ width: 640, maxHeight: '86vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>📦 Postal orders to pack</h2>
          <button className="till-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>Paid delivery orders not yet dispatched. Print the label, pack, then mark dispatched.</p>
        {error && <p className="err">{error}</p>}
        {orders === null && <p className="muted">Loading…</p>}
        {orders && orders.length === 0 && <p className="muted">Nothing waiting to go out.</p>}
        {orders && orders.map((o) => (
          <div key={o.id} className="till-line" style={{ alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div><strong>#{o.id}</strong> · {o.customer_name || '—'} <span className="muted">· £{Number(o.total).toFixed(2)}</span></div>
              <div className="muted" style={{ fontSize: 12 }}>
                {new Date(o.created_at).toLocaleString()} {o.label_printed_at ? '· 🏷 label printed' : ''}
              </div>
            </div>
            <PrintLabelButton order={o} compact onPrinted={load} />
            <button className="btn mini secondary" disabled={busy === o.id} onClick={() => dispatch(o)}>Mark dispatched</button>
          </div>
        ))}
      </div>
    </div>
  );
}
