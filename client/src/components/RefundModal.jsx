import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import ManagerPin from './ManagerPin.jsx';
import { isElectron, desktop } from '../electron.js';
import { loadPrinters } from '../printers.js';

// Refund a paid order (SIAMSHOP-REFUND-001): full or pick items, reason
// (decides restock vs write-off), money back by cash / card / Stripe. Every
// refund needs a manager — cashiers get the ManagerPin modal; managers pass.
const money = (n) => '£' + Number(n || 0).toFixed(2);

export default function RefundModal({ order, isManager, onDone, onClose }) {
  const [reasons, setReasons] = useState({ refund: [], restock: [] });
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState(order.payment_method === 'stripe' ? 'stripe' : order.payment_method === 'card' ? 'card' : 'cash');
  const [mode, setMode] = useState('full'); // full | items
  const [qtys, setQtys] = useState({}); // order_item_id → qty
  const [note, setNote] = useState('');
  const [needPin, setNeedPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api.refundReasons().then((r) => { setReasons(r); setReason(r.refund?.[0] || ''); }).catch(() => {}); }, []);

  const remaining = Number(order.total) - Number(order.refunded_amount || 0);
  const lines = (order.items || []).filter((it) => it.qty - (it.refunded_qty || 0) > 0);
  const pickedAmount = lines.reduce((a, it) => a + (Number(qtys[it.id]) || 0) * Number(it.line_total) / it.qty, 0);
  const amount = mode === 'full' ? remaining : Math.min(pickedAmount, remaining);
  const willRestock = reasons.restock?.includes(reason);

  async function doRefund(approvalToken) {
    setBusy(true); setError('');
    try {
      const items = mode === 'items' ? Object.entries(qtys).filter(([, q]) => Number(q) > 0).map(([id, q]) => ({ order_item_id: Number(id), qty: Number(q) })) : undefined;
      if (mode === 'items' && (!items || !items.length)) throw new Error('Pick at least one item to refund');
      const r = await api.adminRefundOrder(order.id, { items, reason, method, note, approval_token: approvalToken });
      if (isElectron && method === 'cash') loadPrinters().catch(() => null).then((p) => desktop.kickDrawer(p?.receiptDest)).catch(() => {});
      onDone(r);
    } catch (e) {
      if (e.status === 403 && /manager/i.test(e.message)) setNeedPin(true);
      else setError(e.message);
    } finally { setBusy(false); }
  }
  function submit() {
    if (!reason) return setError('Choose a reason');
    if (isManager) doRefund();
    else setNeedPin(true);
  }

  return (
    <>
      <div className="till-modal" onClick={onClose} style={{ zIndex: 55 }}>
        <div className="till-receipt" style={{ width: 460, maxHeight: '88vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
          <h3 style={{ marginTop: 0 }}>↩ Refund order #{order.id}</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Paid {money(order.total)} by {order.payment_method}{Number(order.refunded_amount) > 0 ? ` · already refunded ${money(order.refunded_amount)}` : ''}.</p>
          <div className="fulfil-toggle">
            <button type="button" className={mode === 'full' ? 'on' : ''} onClick={() => setMode('full')}>Whole order · {money(remaining)}</button>
            <button type="button" className={mode === 'items' ? 'on' : ''} onClick={() => setMode('items')}>Some items</button>
          </div>
          {mode === 'items' && (
            <table style={{ marginBottom: 8 }}>
              <tbody>
                {lines.map((it) => (
                  <tr key={it.id}>
                    <td>{it.name_snapshot}<div className="muted" style={{ fontSize: 12 }}>{it.qty - (it.refunded_qty || 0)} left · {money(Number(it.line_total) / it.qty)} each</div></td>
                    <td style={{ width: 90 }}>
                      <input type="number" min="0" max={it.qty - (it.refunded_qty || 0)} value={qtys[it.id] ?? ''} placeholder="0"
                        onChange={(e) => setQtys((q) => ({ ...q, [it.id]: Math.max(0, Math.min(it.qty - (it.refunded_qty || 0), Number(e.target.value) || 0)) }))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <label>Reason</label>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            {(reasons.refund || []).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {reason ? (willRestock ? '📦 Items go back into stock.' : '🗑 Items are written off as wastage (stock not returned).') : ''}
          </div>
          <label>Money back by</label>
          <div className="row" style={{ gap: 8 }}>
            {['cash', 'card', ...(order.payment_method === 'stripe' ? ['stripe'] : [])].map((m) => (
              <button type="button" key={m} className={`btn ${method === m ? '' : 'secondary'}`} onClick={() => setMethod(m)}>
                {m === 'cash' ? '💵 Cash' : m === 'card' ? '💳 Card terminal' : '🌐 Stripe (online card)'}
              </button>
            ))}
          </div>
          <label>Note (optional)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
          <div style={{ marginTop: 10, fontWeight: 800, fontSize: 18 }}>Refund {money(amount)}</div>
          {error && <p className="err">{error}</p>}
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <div className="spacer" />
            <button type="button" className="btn cancel-btn" disabled={busy || amount <= 0} onClick={submit}>{busy ? 'Refunding…' : isManager ? 'Refund' : 'Refund (manager PIN)'}</button>
          </div>
        </div>
      </div>
      {needPin && <ManagerPin title="Manager approval for this refund" reason={`Refund ${money(amount)} — ${reason}`} onClose={() => setNeedPin(false)} onApproved={({ token }) => { setNeedPin(false); doRefund(token); }} />}
    </>
  );
}
