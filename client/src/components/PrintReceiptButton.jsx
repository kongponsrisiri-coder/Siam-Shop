import React, { useState } from 'react';
import { api } from '../api.js';
import { isElectron, desktop, electronConfig } from '../electron.js';

// Reprint a till receipt from Admin → Orders (SIAMSHOP-RECEIPT-001). Desktop
// only — builds the same payload the till prints from the stored order.
export default function PrintReceiptButton({ order, settings }) {
  const [msg, setMsg] = useState('');
  if (!isElectron || !order || order.channel !== 'instore') return null;
  async function print() {
    setMsg('Printing…');
    const st = settings || (await api.getSettings().catch(() => ({})));
    const r = await desktop.printReceipt({
      shopName: electronConfig.shopName || 'SiamShop',
      header: st.receipt_header || '', footer: st.receipt_footer || '',
      vatNote: st.vat_number ? `VAT No. ${st.vat_number}` : '', copies: 1,
      orderId: order.id, staff: order.staff || '', createdAt: order.created_at, fulfilment: order.fulfilment,
      items: (order.items || []).map((it) => ({
        name: it.name_snapshot, qty: it.qty, line_total: it.line_total,
        unit_price: Number(it.price_snapshot) + Number(it.options_total || 0),
        options: (it.options_snapshot || []).map((o) => o.name),
      })),
      subtotal: order.subtotal, total: order.total,
      payment_method: order.payment_method, amount_tendered: order.amount_tendered, change_given: order.change_given,
    });
    setMsg(r?.ok ? 'Receipt reprinted' : `Print failed: ${r?.error}`);
  }
  return (
    <span className="row" style={{ gap: 6, alignItems: 'center', display: 'inline-flex' }}>
      <button className="btn secondary" onClick={print}>🖨 Reprint receipt</button>
      {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
    </span>
  );
}
