import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

const money = (n) => '£' + Number(n || 0).toFixed(2);
const CHANNEL_LABEL = { online: 'Online', instore: 'In-store (till)', messenger: 'Messenger' };

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function ReportsSection() {
  const [from, setFrom] = useState(isoDaysAgo(29));
  const [to, setTo] = useState(isoDaysAgo(0));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function run(e) {
    if (e) e.preventDefault();
    setLoading(true);
    setError('');
    try {
      setData(await api.adminReport(from, to));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { run(); /* initial */ /* eslint-disable-next-line */ }, []);

  function preset(days) {
    setFrom(isoDaysAgo(days - 1));
    setTo(isoDaysAgo(0));
  }

  return (
    <div>
      <h2 style={{ marginBottom: 8 }}>Sales report</h2>

      <form className="panel" onSubmit={run}>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label>From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label>To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <button className="btn" disabled={loading}>{loading ? 'Running…' : 'Run report'}</button>
          <div className="spacer" />
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn mini secondary" onClick={() => { preset(7); }}>7d</button>
            <button type="button" className="btn mini secondary" onClick={() => { preset(30); }}>30d</button>
            <button type="button" className="btn mini secondary" onClick={() => { preset(90); }}>90d</button>
          </div>
        </div>
        {error && <p className="err">{error}</p>}
      </form>

      {data && (
        <>
          <p className="muted" style={{ fontSize: 13 }}>{data.from} → {data.to}</p>
          <div className="kpi-grid">
            <div className="kpi" style={{ borderTopColor: 'var(--siam-red)' }}>
              <div className="kpi-label">Sales</div>
              <div className="kpi-value">{money(data.totals.gross)}</div>
              <div className="kpi-sub">{data.totals.count} orders</div>
            </div>
            <div className="kpi"><div className="kpi-label">Items subtotal</div><div className="kpi-value">{money(data.totals.subtotal)}</div></div>
            <div className="kpi"><div className="kpi-label">Delivery collected</div><div className="kpi-value">{money(data.totals.delivery)}</div></div>
            <div className="kpi"><div className="kpi-label">Avg order</div><div className="kpi-value">{money(data.totals.count ? data.totals.gross / data.totals.count : 0)}</div></div>
          </div>

          <div className="dash-cols">
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>By channel</h3>
              {data.by_channel.length === 0 ? <p className="muted">No sales in range.</p> : (
                <table><tbody>
                  {data.by_channel.map((r) => (
                    <tr key={r.channel}><td>{CHANNEL_LABEL[r.channel] || r.channel}</td><td>{r.count}</td><td style={{ textAlign: 'right' }}>{money(r.gross)}</td></tr>
                  ))}
                </tbody></table>
              )}
            </div>
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>By payment</h3>
              {data.by_payment.length === 0 ? <p className="muted">—</p> : (
                <table><tbody>
                  {data.by_payment.map((r) => (
                    <tr key={r.payment_method}><td>{r.payment_method}</td><td>{r.count}</td><td style={{ textAlign: 'right' }}>{money(r.gross)}</td></tr>
                  ))}
                </tbody></table>
              )}
            </div>
          </div>

          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Top products in range</h3>
            {data.top_products.length === 0 ? <p className="muted">No sales in range.</p> : (
              <table>
                <thead><tr><th>Product</th><th>Sold</th><th style={{ textAlign: 'right' }}>Revenue</th></tr></thead>
                <tbody>
                  {data.top_products.map((p, i) => (
                    <tr key={i}><td>{p.name}</td><td>{p.qty}</td><td style={{ textAlign: 'right' }}>{money(p.revenue)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
