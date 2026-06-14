import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

const money = (n) => '£' + Number(n || 0).toFixed(2);
const CHANNEL_LABEL = { online: 'Online', instore: 'In-store (till)', messenger: 'Messenger' };

// Dependency-free 7-day bar chart of daily paid sales.
function SalesChart({ data }) {
  const max = Math.max(1, ...data.map((d) => d.gross));
  return (
    <div className="chart">
      {data.map((d) => {
        const dt = new Date(d.date + 'T00:00:00');
        const day = dt.toLocaleDateString(undefined, { weekday: 'short' });
        return (
          <div className="chart-col" key={d.date} title={`${d.date}: ${money(d.gross)} · ${d.count} orders`}>
            <div className="chart-val">{d.gross > 0 ? '£' + Math.round(d.gross) : ''}</div>
            <div className="chart-bar-wrap">
              <div className="chart-bar" style={{ height: Math.max(2, (d.gross / max) * 100) + '%' }} />
            </div>
            <div className="chart-x">{day}</div>
          </div>
        );
      })}
    </div>
  );
}

function Kpi({ label, value, sub, accent }) {
  return (
    <div className="kpi" style={accent ? { borderTopColor: accent } : {}}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub != null && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export default function DashboardSection({ onGoToOrders }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.adminDashboard().then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="center err">{error}</div>;
  if (!data) return <div className="center muted">Loading dashboard…</div>;

  const s = data.sales;
  const c = data.counts;

  return (
    <div>
      <h2 style={{ marginBottom: 4 }}>Dashboard</h2>

      {/* Sales KPIs */}
      <div className="kpi-grid">
        <Kpi label="Today" value={money(s.day.gross)} sub={`${s.day.count} orders`} accent="var(--siam-red)" />
        <Kpi label="This week" value={money(s.week.gross)} sub={`${s.week.count} orders`} accent="var(--siam-gold)" />
        <Kpi label="This month" value={money(s.month.gross)} sub={`${s.month.count} orders`} accent="#16a34a" />
        <Kpi label="All time" value={money(s.all.gross)} sub={`${s.all.count} orders`} accent="#3730a3" />
      </div>

      {/* Operational counts */}
      <div className="kpi-grid" style={{ marginTop: 4 }}>
        <Kpi label="To dispatch" value={c.to_dispatch} sub="paid, awaiting send" />
        <Kpi label="Awaiting payment" value={c.awaiting_payment} sub="bank transfer / pending" />
        <Kpi label="Products" value={`${c.active_products}/${c.products}`} sub="active / total" />
        <Kpi label="Out of stock" value={c.out_of_stock} sub="tracked items at 0" />
      </div>

      {/* 7-day sales chart + top sellers */}
      <div className="dash-cols">
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Last 7 days</h3>
          <SalesChart data={data.sales_7d || []} />
        </div>
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Top sellers</h3>
          {(!data.top_products || data.top_products.length === 0) ? (
            <p className="muted">No sales yet.</p>
          ) : (
            <table>
              <thead><tr><th>Product</th><th>Sold</th><th style={{ textAlign: 'right' }}>Revenue</th></tr></thead>
              <tbody>
                {data.top_products.map((p, i) => (
                  <tr key={p.product_id || i}>
                    <td>{p.name}</td>
                    <td>{p.qty}</td>
                    <td style={{ textAlign: 'right' }}>{money(p.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="dash-cols">
        {/* Sales by channel */}
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Sales by channel (all time)</h3>
          {data.by_channel.length === 0 ? (
            <p className="muted">No paid sales yet.</p>
          ) : (
            <table>
              <thead><tr><th>Channel</th><th>Orders</th><th style={{ textAlign: 'right' }}>Sales</th></tr></thead>
              <tbody>
                {data.by_channel.map((r) => (
                  <tr key={r.channel}>
                    <td>{CHANNEL_LABEL[r.channel] || r.channel}</td>
                    <td>{r.count}</td>
                    <td style={{ textAlign: 'right' }}>{money(r.gross)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Low stock */}
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Low stock (≤ {data.low_stock_threshold})</h3>
          {data.low_stock.length === 0 ? (
            <p className="muted">Everything's well stocked. 👍</p>
          ) : (
            <table>
              <tbody>
                {data.low_stock.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span className={`tag ${p.stock_qty <= 0 ? 'off' : ''}`}>{p.stock_qty} {p.unit}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Recent orders */}
      <div className="panel">
        <div className="row">
          <h3 style={{ marginTop: 0 }}>Recent orders</h3>
          <div className="spacer" />
          {onGoToOrders && <button className="btn ghost" onClick={onGoToOrders}>View all →</button>}
        </div>
        {data.recent_orders.length === 0 ? (
          <p className="muted">No orders yet.</p>
        ) : (
          <table>
            <thead><tr><th>#</th><th>Customer</th><th>Channel</th><th>Status</th><th style={{ textAlign: 'right' }}>Total</th><th>When</th></tr></thead>
            <tbody>
              {data.recent_orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.id}</td>
                  <td>{o.customer_name || '—'}</td>
                  <td>{CHANNEL_LABEL[o.channel] || o.channel}</td>
                  <td><span className={`tag ${o.payment_status === 'paid' ? '' : 'off'}`}>{o.status}</span></td>
                  <td style={{ textAlign: 'right' }}>{money(o.total)}</td>
                  <td className="muted">{new Date(o.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
