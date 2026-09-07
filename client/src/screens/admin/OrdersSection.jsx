import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { maskName, maskEmail, maskAddress } from '../../demo.js';
import { isElectron } from '../../electron.js';
import PrintLabelButton from '../../components/PrintLabelButton.jsx';
import PrintReceiptButton from '../../components/PrintReceiptButton.jsx';

// Clear, combined payment + fulfilment state for the list.
function orderState(o) {
  if (o.status === 'cancelled') return { label: 'Cancelled', cls: 'off' };
  if (o.payment_status === 'refunded') return { label: 'Refunded', cls: 'off' };
  if (o.payment_status !== 'paid') return { label: 'Awaiting payment', cls: 'off' };
  if (o.status === 'dispatched') return { label: 'Dispatched', cls: 'ok' };
  if (o.fulfilment === 'collection') {
    if (o.status === 'completed') return { label: 'Collected', cls: 'ok' };
    if (o.status === 'ready') return { label: 'Ready to collect', cls: 'ok' };
    return { label: 'Paid · to prepare', cls: 'ok' };
  }
  if (o.channel === 'instore') return { label: o.fulfilment === 'dine_in' ? 'Till · eat in' : 'Till sale', cls: 'ok' };
  return { label: 'Paid · to dispatch', cls: 'ok' };
}

const FULFIL_LABEL = { delivery: '🚚 Delivery', collection: '🛍️ Collection', dine_in: '🍽 Eat in', takeaway: '🥡 Take away' };
function pickupText(o) {
  if (!o.pickup_at) return '';
  return new Date(o.pickup_at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

function OrderDetail({ id, onBack, onChanged }) {
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [tracking, setTracking] = useState('');
  const [carrier, setCarrier] = useState('');
  const [carrierList, setCarrierList] = useState([]);
  const [busy, setBusy] = useState(false);

  async function load() {
    setError('');
    try {
      const o = await api.adminGetOrder(id);
      setOrder(o);
      setTracking(o.tracking_number || '');
      setCarrier(o.carrier || '');
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    load();
    api.adminCarriers().then(setCarrierList).catch(() => {});
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
      await api.adminDispatchOrder(id, tracking.trim(), carrier || null);
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

  async function ready() {
    setBusy(true);
    setError('');
    try {
      await api.adminMarkReady(id);
      await load();
      onChanged && onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function collected() {
    setBusy(true);
    setError('');
    try {
      await api.adminMarkCollected(id);
      await load();
      onChanged && onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!confirm('Cancel this order? If it was paid, stock will be restored.')) return;
    setBusy(true);
    setError('');
    try {
      await api.adminCancelOrder(id);
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
            <h4>{order.fulfilment === 'collection' ? 'Collection' : 'Deliver to'}</h4>
            <div>{maskName(cust.name || order.customer_name || '—', order.id)}</div>
            {(cust.email || order.customer_email) && <div className="muted">{maskEmail(cust.email || order.customer_email, order.id)}</div>}
            {(cust.phone || order.customer_phone) && <div className="muted">{cust.phone || order.customer_phone}</div>}
            {order.channel === 'instore' && <div style={{ flex: '1 1 100%' }}><PrintReceiptButton order={order} /></div>}
          {order.fulfilment === 'collection' ? (
              <div style={{ marginTop: 6 }}>
                🛍️ Pickup: <strong>{order.pickup_at ? new Date(order.pickup_at).toLocaleString() : 'ASAP'}</strong>
                {order.ready_at && <div className="muted">Ready since {new Date(order.ready_at).toLocaleTimeString()}</div>}
              </div>
            ) : (
              <pre className="addr">{maskAddress(order.delivery_address, order.id) || '—'}</pre>
            )}
          </div>
          <div>
            <h4>Order</h4>
            <div>Status: <strong>{order.status}</strong></div>
            {order.fulfilment && <div>Fulfilment: {FULFIL_LABEL[order.fulfilment] || order.fulfilment}</div>}
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
                <td>
                  {it.name_snapshot}
                  {Array.isArray(it.options_snapshot) && it.options_snapshot.length > 0 && (
                    <div className="line-opts">{it.options_snapshot.map((o) => o.name).join(', ')}</div>
                  )}
                </td>
                <td>{it.qty}</td>
                <td style={{ textAlign: 'right' }}>£{Number(it.line_total).toFixed(2)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan="2">Subtotal</td>
              <td style={{ textAlign: 'right' }}>£{Number(order.subtotal).toFixed(2)}</td>
            </tr>
            {order.fulfilment !== 'collection' && (
              <tr>
                <td colSpan="2">Delivery</td>
                <td style={{ textAlign: 'right' }}>£{Number(order.delivery_fee).toFixed(2)}</td>
              </tr>
            )}
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
          {order.fulfilment === 'collection' ? (
            <>
              {order.payment_status === 'paid' && order.status !== 'cancelled' && order.status !== 'ready' && order.status !== 'completed' && (
                <button className="btn" disabled={busy} onClick={ready}>Mark ready · email customer</button>
              )}
              {order.status === 'ready' && (
                <button className="btn" disabled={busy} onClick={collected}>Mark collected</button>
              )}
            </>
          ) : order.channel !== 'instore' && (
            <>
              <div style={{ flex: '1 1 100%' }}>
                <PrintLabelButton order={order} onPrinted={() => { load(); onChanged && onChanged(); }} />
                {order.label_printed_at && <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>printed {new Date(order.label_printed_at).toLocaleString()}</span>}
              </div>
              <div style={{ flex: '1 1 160px' }}>
                <label>Carrier</label>
                <select value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                  <option value="">— choose —</option>
                  {carrierList.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                </select>
              </div>
              <div style={{ flex: '1 1 200px' }}>
                <label>Tracking number</label>
                <input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="e.g. RM123456789GB" />
              </div>
              {order.status !== 'cancelled' && (
                <button className="btn" disabled={busy} onClick={dispatch}>Mark as dispatched</button>
              )}
            </>
          )}
          {order.payment_method === 'bank_transfer' && order.payment_status !== 'paid' && order.status !== 'cancelled' && (
            <button className="btn secondary" disabled={busy} onClick={markPaid}>Mark as paid</button>
          )}
          {order.status !== 'cancelled' && order.status !== 'dispatched' && (
            <button className="btn cancel-btn" disabled={busy} onClick={cancel}>Cancel order</button>
          )}
          {order.status === 'cancelled' && <span className="tag off">Cancelled</span>}
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
  const [filter, setFilter] = useState('all'); // all | collections | online | till

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

  // Inline quick actions (no need to open the detail).
  async function act(fn) {
    setError('');
    try { await fn(); await load(); } catch (e) { setError(e.message); }
  }
  function quickDispatch(e, o) {
    e.stopPropagation();
    if (isElectron) return setSelected(o.id); // window.prompt is disabled in Electron — use the detail form
    const t = window.prompt(`Dispatch order #${o.id} — tracking number (optional):`, o.tracking_number || '');
    if (t === null) return;
    act(() => api.adminDispatchOrder(o.id, t.trim()));
  }
  function quickPaid(e, o) {
    e.stopPropagation();
    if (window.confirm(`Mark order #${o.id} as paid? (stock will be deducted)`)) act(() => api.adminMarkPaid(o.id));
  }
  function quickCancel(e, o) {
    e.stopPropagation();
    if (window.confirm(`Cancel order #${o.id}? If it was paid, stock is restored.`)) act(() => api.adminCancelOrder(o.id));
  }
  function quickReady(e, o) {
    e.stopPropagation();
    act(() => api.adminMarkReady(o.id));
  }
  function quickCollected(e, o) {
    e.stopPropagation();
    act(() => api.adminMarkCollected(o.id));
  }

  const visible = orders.filter((o) => {
    if (filter === 'collections') return o.fulfilment === 'collection' && o.status !== 'cancelled' && o.status !== 'completed';
    if (filter === 'online') return o.channel !== 'instore';
    if (filter === 'till') return o.channel === 'instore';
    return true;
  }).sort((a, b) => {
    // Collections view: soonest pickup first.
    if (filter !== 'collections') return 0;
    return new Date(a.pickup_at || a.created_at) - new Date(b.pickup_at || b.created_at);
  });
  const collectionsToday = orders.filter((o) => o.fulfilment === 'collection' && isToday(o.pickup_at) && o.status !== 'cancelled' && o.status !== 'completed').length;

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
      <div className="till-cats" style={{ marginTop: 10 }}>
        {[['all', 'All'], ['collections', `Collections${collectionsToday ? ` · ${collectionsToday} today` : ''}`], ['online', 'Online'], ['till', 'Till']].map(([k, label]) => (
          <button key={k} className={`till-cat ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>{label}</button>
        ))}
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
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((o) => {
                  const paid = o.payment_status === 'paid';
                  const isCollection = o.fulfilment === 'collection';
                  const isTill = o.channel === 'instore';
                  const open = o.status !== 'cancelled' && o.status !== 'completed';
                  const canDispatch = paid && !isCollection && !isTill && o.status !== 'dispatched' && o.status !== 'cancelled';
                  const canReady = paid && isCollection && open && o.status !== 'ready';
                  const canCollected = isCollection && o.status === 'ready';
                  const canMarkPaid = o.payment_method === 'bank_transfer' && !paid && o.status !== 'cancelled';
                  const canCancel = o.status !== 'cancelled' && o.status !== 'dispatched' && o.status !== 'completed';
                  return (
                  <tr key={o.id} className="order-row" onClick={() => setSelected(o.id)}>
                    <td><strong>#{o.id}</strong></td>
                    <td>
                      {maskName(o.customer_name || '—', o.id)}
                      {o.customer_email && <div className="muted" style={{ fontSize: 12 }}>{maskEmail(o.customer_email, o.id)}</div>}
                    </td>
                    <td>
                      {o.source || o.channel || '—'}
                      {o.label_printed_at && <div className="muted" style={{ fontSize: 12 }}>🏷 label ✓</div>}
                      {o.fulfilment && o.fulfilment !== 'delivery' && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {FULFIL_LABEL[o.fulfilment] || o.fulfilment}{o.pickup_at ? ` · ${pickupText(o)}` : ''}
                        </div>
                      )}
                    </td>
                    <td><span className={`tag ${orderState(o).cls}`}>{orderState(o).label}</span></td>
                    <td>{o.payment_status}{o.payment_method ? ` (${o.payment_method})` : ''}</td>
                    <td>£{Number(o.total).toFixed(2)}</td>
                    <td className="muted">{new Date(o.created_at).toLocaleString()}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="order-actions">
                        {canMarkPaid && <button className="btn mini" onClick={(e) => quickPaid(e, o)}>Mark paid</button>}
                        {canDispatch && <PrintLabelButton order={o} compact onPrinted={load} />}
                        {canDispatch && <button className="btn mini" onClick={(e) => quickDispatch(e, o)}>Dispatch</button>}
                        {canReady && <button className="btn mini" onClick={(e) => quickReady(e, o)}>Ready</button>}
                        {canCollected && <button className="btn mini" onClick={(e) => quickCollected(e, o)}>Collected</button>}
                        {canCancel && <button className="btn mini cancel-btn" onClick={(e) => quickCancel(e, o)}>Cancel</button>}
                        <button className="btn mini secondary" onClick={(e) => { e.stopPropagation(); setSelected(o.id); }}>Open</button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
