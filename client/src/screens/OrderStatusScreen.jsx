import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useT } from '../lang.jsx';

const money = (n) => '£' + Number(n || 0).toFixed(2);

// Friendly customer-facing status.
function statusOf(o) {
  if (o.status === 'cancelled') return { label: 'Cancelled', cls: 'off' };
  if (o.payment_status === 'refunded') return { label: 'Refunded', cls: 'off' };
  if (o.payment_status !== 'paid') return { label: 'Awaiting payment', cls: 'off' };
  if (o.status === 'dispatched') return { label: 'Dispatched 📦', cls: 'ok' };
  return { label: 'Paid — preparing your order', cls: 'ok' };
}

// Public order tracking page — used both by the email links (?order=N) and as a
// "Track your order" box where a customer types their order number.
export default function OrderStatusScreen() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const orderId = params.get('order') || params.get('order_id');
  const emailParam = params.get('email') || '';
  const [input, setInput] = useState(orderId || '');
  const [email, setEmail] = useState(emailParam);
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setInput(orderId || '');
    setEmail(emailParam);
    if (!orderId || !emailParam) { setOrder(null); setError(''); return; }
    setLoading(true);
    setError('');
    api.getOrder(orderId, emailParam)
      .then(setOrder)
      .catch((e) => { setError(e.message); setOrder(null); })
      .finally(() => setLoading(false));
  }, [orderId, emailParam]);

  function submit(e) {
    e.preventDefault();
    const v = input.trim();
    const em = email.trim();
    if (v && em) setParams({ order: v, email: em });
  }

  const trackBox = (
    <form className="panel" onSubmit={submit} style={{ maxWidth: 440 }}>
      <h3 style={{ marginTop: 0 }}>Track your order</h3>
      <label>Order number</label>
      <input inputMode="numeric" placeholder="e.g. 3" value={input} onChange={(e) => setInput(e.target.value)} />
      <label>Email used at checkout</label>
      <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      <button className="btn" type="submit" style={{ marginTop: 12 }}>Track</button>
    </form>
  );

  return (
    <div className="container" style={{ maxWidth: 560 }}>
      {trackBox}
      {loading && <div className="center muted">{t('loading')}</div>}
      {error && <div className="err" style={{ marginTop: 8 }}>{error}</div>}
      {order && <OrderResult order={order} />}
    </div>
  );
}

function OrderResult({ order }) {
  const s = statusOf(order);
  return (
    <div style={{ marginTop: 16 }}>
      <h1 style={{ marginBottom: 4 }}>Order #{order.id}</h1>
      <div style={{ margin: '8px 0 16px' }}>
        <span className={`tag ${s.cls}`} style={{ fontSize: 14, padding: '6px 12px' }}>{s.label}</span>
      </div>

      <div className="panel">
        <table>
          <tbody>
            {(order.items || []).map((it, i) => (
              <tr key={i}>
                <td>{it.name_snapshot} × {it.qty}</td>
                <td style={{ textAlign: 'right' }}>{money(it.line_total)}</td>
              </tr>
            ))}
            <tr><td>Subtotal</td><td style={{ textAlign: 'right' }}>{money(order.subtotal)}</td></tr>
            <tr><td>Delivery</td><td style={{ textAlign: 'right' }}>{money(order.delivery_fee)}</td></tr>
            <tr><td><strong>Total</strong></td><td style={{ textAlign: 'right' }}><strong>{money(order.total)}</strong></td></tr>
          </tbody>
        </table>

        {order.tracking_number && (
          <p style={{ marginTop: 12 }}>Tracking number: <strong>{order.tracking_number}</strong></p>
        )}
        {order.delivery_address && (
          <p className="muted" style={{ fontSize: 14 }}>Delivering to:<br />{order.delivery_address}</p>
        )}
        <p className="muted" style={{ fontSize: 13 }}>
          Payment: {order.payment_status}{order.payment_method ? ` (${order.payment_method})` : ''}
        </p>
      </div>

      <Link className="btn secondary" to="/">← Back to shop</Link>
    </div>
  );
}
