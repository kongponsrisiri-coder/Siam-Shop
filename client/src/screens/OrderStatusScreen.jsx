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

// Public order tracking page (linked from confirmation/dispatch emails).
export default function OrderStatusScreen() {
  const t = useT();
  const [params] = useSearchParams();
  const orderId = params.get('order') || params.get('order_id');
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orderId) { setError('No order number provided.'); setLoading(false); return; }
    api.getOrder(orderId)
      .then(setOrder)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [orderId]);

  if (loading) return <div className="container center muted">{t('loading')}</div>;
  if (error) return <div className="container center err">{error} — <Link to="/">back to shop</Link></div>;

  const s = statusOf(order);

  return (
    <div className="container" style={{ maxWidth: 560 }}>
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
