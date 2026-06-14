import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

const STATUS_TAG = {
  paid: 'tag',
  pending: 'tag off',
  fulfilled: 'tag',
};

export default function OrdersSection() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api
      .adminListOrders()
      .then((o) => live && setOrders(o || []))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  return (
    <div>
      <h2 style={{ marginBottom: 0 }}>Orders</h2>
      {loading && <div className="center muted">Loading…</div>}
      {error && <div className="center err">{error}</div>}
      {!loading && !error && (
        <div className="panel">
          {orders.length === 0 ? (
            <p className="muted center">No orders yet. They’ll appear here after checkout (SIAMSHOP-003).</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th>Total</th>
                  <th>Placed</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>{o.id}</td>
                    <td>
                      {o.customer_name || '—'}
                      {o.customer_email && <div className="muted" style={{ fontSize: 12 }}>{o.customer_email}</div>}
                    </td>
                    <td><span className={STATUS_TAG[o.status] || 'tag'}>{o.status}</span></td>
                    <td>{o.payment_status}</td>
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
