import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { ZSummary, PrintZButton } from '../../components/TillSession.jsx';

const money = (n) => '£' + Number(n || 0).toFixed(2);
const CHANNEL_LABEL = { online: 'Online', instore: 'In-store (till)', messenger: 'Messenger' };

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Z reports — closed till sessions (SIAMSHOP-TILL-001).
function ZReports() {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null); // { session, summary }
  const [error, setError] = useState('');
  useEffect(() => { api.tillSessions().then(setList).catch((e) => setError(e.message)); }, []);
  async function show(id) {
    try { setOpen(await api.tillSessionDetail(id)); } catch (e) { setError(e.message); }
  }
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Z reports (till cash-ups)</h3>
      {error && <p className="err">{error}</p>}
      {list === null && <p className="muted">Loading…</p>}
      {list && list.length === 0 && <p className="muted">No till sessions yet — open the till on the Till screen.</p>}
      {list && list.length > 0 && (
        <table>
          <thead><tr><th>#</th><th>Opened</th><th>Closed</th><th>Sales</th><th style={{ textAlign: 'right' }}>Expected</th><th style={{ textAlign: 'right' }}>Counted</th><th style={{ textAlign: 'right' }}>Variance</th><th></th></tr></thead>
          <tbody>
            {list.map((z) => (
              <tr key={z.id} className="order-row" onClick={() => show(z.id)}>
                <td><strong>#{z.id}</strong> {z.status === 'open' && <span className="tag ok">open</span>}</td>
                <td>{new Date(z.opened_at).toLocaleString()}<div className="muted" style={{ fontSize: 12 }}>{z.opened_by}</div></td>
                <td>{z.closed_at ? new Date(z.closed_at).toLocaleString() : '—'}{z.closed_by && <div className="muted" style={{ fontSize: 12 }}>{z.closed_by}</div>}</td>
                <td>{z.sales_count ?? '—'}{z.gross != null ? ` · ${money(z.gross)}` : ''}</td>
                <td style={{ textAlign: 'right' }}>{z.expected_cash != null ? money(z.expected_cash) : '—'}</td>
                <td style={{ textAlign: 'right' }}>{z.counted_cash != null ? money(z.counted_cash) : '—'}</td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: z.variance == null ? undefined : Math.abs(z.variance) < 0.005 ? '#16a34a' : z.variance < 0 ? '#b91c1c' : '#b45309' }}>
                  {z.variance != null ? `${z.variance > 0 ? '+' : ''}${money(z.variance)}` : '—'}
                </td>
                <td><button className="btn mini secondary" onClick={(e) => { e.stopPropagation(); show(z.id); }}>View</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && (
        <div className="till-modal" onClick={() => setOpen(null)}>
          <div className="till-receipt" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Z report — session #{open.session.id}</h3>
            <ZSummary z={open.summary} />
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <PrintZButton z={open.summary} label="🖨 Reprint Z" />
              <div className="spacer" />
              <button className="btn secondary" onClick={() => setOpen(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
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
      <h2 style={{ marginBottom: 8 }}>Reports</h2>
      <ZReports />
      <h3 style={{ marginBottom: 8 }}>Sales report</h3>

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

          {data.discounts && (
            <div className="dash-cols">
              <div className="panel">
                <h3 style={{ marginTop: 0 }}>Discounts by reason <span className="muted" style={{ fontSize: 13 }}>· total {money(data.discounts.total)}</span></h3>
                {data.discounts.by_reason.length === 0 ? <p className="muted">No discounts in range.</p> : (
                  <table><tbody>
                    {data.discounts.by_reason.map((r) => (
                      <tr key={r.reason}><td>{r.reason}</td><td>{r.count}</td><td style={{ textAlign: 'right' }}>−{money(r.amount)}</td></tr>
                    ))}
                  </tbody></table>
                )}
              </div>
              <div className="panel">
                <h3 style={{ marginTop: 0 }}>Discounts by staff</h3>
                {data.discounts.by_staff.length === 0 ? <p className="muted">—</p> : (
                  <table><tbody>
                    {data.discounts.by_staff.map((r) => (
                      <tr key={r.staff}><td>{r.staff}</td><td>{r.count} sales</td><td style={{ textAlign: 'right' }}>−{money(r.amount)}</td></tr>
                    ))}
                  </tbody></table>
                )}
              </div>
            </div>
          )}

          {data.refunds && (
            <div className="dash-cols">
              <div className="panel">
                <h3 style={{ marginTop: 0 }}>Refunds by reason <span className="muted" style={{ fontSize: 13 }}>· {data.refunds.count} · {money(data.refunds.total)}</span></h3>
                {data.refunds.by_reason.length === 0 ? <p className="muted">No refunds in range.</p> : (
                  <table><tbody>
                    {data.refunds.by_reason.map((r, i) => (
                      <tr key={i}><td>{r.reason} <span className={`tag ${r.stock_action === 'restock' ? 'ok' : 'off'}`}>{r.stock_action === 'restock' ? 'restocked' : 'written off'}</span></td><td>{r.count}</td><td style={{ textAlign: 'right' }}>−{money(r.amount)}</td></tr>
                    ))}
                  </tbody></table>
                )}
                {data.voids?.count > 0 && <p className="muted" style={{ fontSize: 13 }}>Voids before payment: {data.voids.count} · {money(data.voids.total)}</p>}
              </div>
              <div className="panel">
                <h3 style={{ marginTop: 0 }}>Wastage <span className="muted" style={{ fontSize: 13 }}>· {money(data.wastage?.value)}</span></h3>
                {!data.wastage?.items?.length ? <p className="muted">Nothing written off in range.</p> : (
                  <table><tbody>
                    {data.wastage.items.map((w, i) => (
                      <tr key={i}><td>{w.name}</td><td>{w.qty}</td><td style={{ textAlign: 'right' }}>{money(w.value)}</td></tr>
                    ))}
                  </tbody></table>
                )}
              </div>
            </div>
          )}

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
