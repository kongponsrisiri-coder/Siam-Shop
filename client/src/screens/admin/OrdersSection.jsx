import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

const STATUS_TAG = {
  paid: 'tag',
  pending: 'tag off',
  fulfilled: 'tag',
  dispatched: 'tag',
};

function OrderDetail({ id, onBack, onChanged }) {
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [tracking, setTracking] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setError('');
    try {
      const o = await api.adminGetOrder(id);
      setOrder(o);
      setTracking(o.tracking_number || '');
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function dispatch() {
    if (!tracking.trim()) {
      setError('Enter a tracking number first.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.adminDispatchOrder(id, tracking.trim());
      await load();
      onChanged && onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function markPaid() {
    setBusy(true);
    setError('');
    try {
      await api.adminMarkPaid(id);
      await load();
      onChanged && onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !order) return <div className="center err">{error} — <button className="btn ghost" onClick={onBack}>back</button></div>;
  if (!order) return <div className="center muted">Loading…</div>;

  const cust = order.customer || {};
  const items = order.items || [];

  return (
    <div>
      <div className="row no-print" style={{ marginTop: 16 }}>
        <button className="btn ghost" onClick={onBack}>← Back to orders</button>
        <div className="spacer" />
        <button className="btn secondary" onClick={() => window.print()}>Print packing slip</button>
      </div>

      {/* Printable packing slip area */}
      <div className="panel packing-slip">
        <div className="slip-head">
          <h2 style={{ margin: 0 }}>Packing slip — Order #{order.id}</h2>
          <div className="muted">{new Date(order.created_at).toLocaleString()}</div>
        </div>

        <div className="slip-cols">
          <div>
            <h4>Deliver to</h4>
            <div>{cust.name || order.customer_name || '—'}</div>
            {(cust.email || order.customer_email) && <div className="muted">{cust.email || order.customer_email}</div>}
            {cust.phone && <div className="muted">{cust.phone}</div>}
            <pre className="addr">{order.delivery_address || '—'}</pre>
          </div>
          <div>
            <h4>Order</h4>
            <div>Status: <strong>{order.status}</strong></div>
            <div>Payment: {order.payment_status} ({order.payment_method})</div>
            {order.source && <div>Source: {order.source}</div>}
            {order.tracking_number && <div>Tracking: {order.tracking_number}</div>}
            {order.dispatch_date && <div>Dispatched: {new Date(order.dispatch_date).toLocaleString()}</div>}
          </div>
        </div>

        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th style={{ textAlign: 'right' }}>Line total</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => (
              <tr key={idx}>
                <td>{it.name_snapshot}</td>
                <td>{it.qty}</td>
                <td style={{ textAlign: 'right' }}>£{Number(it.line_total).toFixed(2)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan="2">Subtotal</td>
              <td style={{ textAlign: 'right' }}>£{Number(order.subtotal).toFixed(2)}</td>
            </tr>
            <tr>
              <td colSpan="2">Delivery</td>
              <td style={{ textAlign: 'right' }}>£{Number(order.delivery_fee).toFixed(2)}</td>
            </tr>
            <tr>
              <td colSpan="2"><strong>Total</strong></td>
              <td style={{ textAlign: 'right' }}><strong>£{Number(order.total).toFixed(2)}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Actions (not printed) */}
      <div className="panel no-print">
        <h3 style={{ marginTop: 0 }}>Actions</h3>
        {error && <p className="err">{error}</p>}
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 240px' }}>
            <label>Tracking number</label>
            <input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="e.g. RM123456789GB" />
          </div>
          <button className="btn" disabled={busy} onClick={dispatch}>Mark as dispatched</button>
          {order.payment_method === 'bank_transfer' && order.payment_status !== 'paid' && (
            <button className="btn secondary" disabled={busy} onClick={markPaid}>Mark as paid</button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function OrdersSection() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      setOrders(await api.adminListOrders());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function exportCsv() {
    try {
      const blob = await api.exportOrdersCsv();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `siamshop-orders-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    }
  }

  if (selected != null) {
    return (
      <OrderDetail
        id={selected}
        onBack={() => setSelected(null)}
        onChanged={load}
      />
    );
  }

  return (
    <div>
      <div className="row" style={{ marginTop: 16 }}>
        <h2 style={{ margin: 0 }}>Orders</h2>
        <div className="spacer" />
        {orders.length > 0 && <button className="btn secondary" onClick={exportCsv}>⬇ Export CSV</button>}
      </div>
      {loading && <div className="center muted">Loading…</div>}
      {error && <div className="center err">{error}</div>}
      {!loading && !error && (
        <div className="panel">
          {orders.length === 0 ? (
            <p className="muted center">No orders yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Customer</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th>Total</th>
                  <th>Placed</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="order-row" onClick={() => setSelected(o.id)}>
                    <td>{o.id}</td>
                    <td>
                      {o.customer_name || '—'}
                      {o.customer_email && <div className="muted" style={{ fontSize: 12 }}>{o.customer_email}</div>}
                    </td>
                    <td>{o.source || o.channel || '—'}</td>
                    <td><span className={STATUS_TAG[o.status] || 'tag'}>{o.status}</span></td>
                    <td>{o.payment_status}{o.payment_method ? ` (${o.payment_method})` : ''}</td>
                    <td>£{Number(o.total).toFixed(2)}</td>
                    <td className="muted">{new Date(o.created_at).toLocaleString()}</td>
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
