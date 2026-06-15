import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

function money(n) {
  return `£${Number(n || 0).toFixed(2)}`;
}

// Friendly status wording — same mapping the rest of the admin uses.
function orderState(o) {
  if (o.status === 'cancelled') return { label: 'Cancelled', cls: 'off' };
  if (o.payment_status === 'refunded') return { label: 'Refunded', cls: 'off' };
  if (o.payment_status !== 'paid') return { label: 'Awaiting payment', cls: 'off' };
  if (o.status === 'dispatched') return { label: 'Dispatched', cls: 'ok' };
  return { label: 'Paid', cls: 'ok' };
}

function CustomerDetail({ id, onBack }) {
  const [cust, setCust] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    api
      .adminGetCustomer(id)
      .then(setCust)
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) return (
    <div className="center err">
      {error} — <button className="btn ghost" onClick={onBack}>back</button>
    </div>
  );
  if (!cust) return <div className="center muted">Loading…</div>;

  const orders = cust.orders || [];

  return (
    <div>
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn ghost" onClick={onBack}>← Back to customers</button>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>{cust.name || '—'}</h2>
        <table>
          <tbody>
            <tr><th>Email</th><td>{cust.email || '—'}</td></tr>
            <tr><th>Phone</th><td>{cust.phone || '—'}</td></tr>
            <tr>
              <th>Marketing</th>
              <td>
                <span className={`tag ${cust.marketing_consent ? 'ok' : 'off'}`}>
                  {cust.marketing_consent ? 'Opted in' : 'No consent'}
                </span>
              </td>
            </tr>
            {cust.created_at && (
              <tr><th>Joined</th><td>{new Date(cust.created_at).toLocaleString()}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Totals</h3>
        <div className="kpi-grid account-kpis">
          <div className="kpi">
            <div className="kpi-label">Orders</div>
            <div className="kpi-value">{cust.order_count ?? orders.length}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Total spent</div>
            <div className="kpi-value">{money(cust.total_spent)}</div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Orders</h3>
        {orders.length === 0 ? (
          <p className="muted">No orders yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Date</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const st = orderState(o);
                return (
                  <tr key={o.id}>
                    <td><strong>#{o.id}</strong></td>
                    <td className="muted">{new Date(o.created_at).toLocaleString()}</td>
                    <td><span className={`tag ${st.cls}`}>{st.label}</span></td>
                    <td style={{ textAlign: 'right' }}>{money(o.total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function CustomersSection() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      setCustomers(await api.adminListCustomers());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (selected != null) {
    return <CustomerDetail id={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div>
      <h2 style={{ marginTop: 16 }}>Customers</h2>
      {loading && <div className="center muted">Loading…</div>}
      {error && <div className="center err">{error}</div>}
      {!loading && !error && (
        <div className="panel">
          {customers.length === 0 ? (
            <p className="muted center">No customers yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Orders</th>
                  <th style={{ textAlign: 'right' }}>Total spent</th>
                  <th>Last order</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id} className="order-row" onClick={() => setSelected(c.id)}>
                    <td><strong>{c.name || '—'}</strong></td>
                    <td>{c.email || '—'}</td>
                    <td>{c.phone || '—'}</td>
                    <td>{c.order_count ?? 0}</td>
                    <td style={{ textAlign: 'right' }}>{money(c.total_spent)}</td>
                    <td className="muted">
                      {c.last_order_at ? new Date(c.last_order_at).toLocaleDateString() : '—'}
                    </td>
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
