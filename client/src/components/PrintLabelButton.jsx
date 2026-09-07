import React, { useState } from 'react';
import { api } from '../api.js';
import { buildLabelHtml, printLabelInBrowser } from '../label.js';
import { isElectron, desktop, electronConfig } from '../electron.js';

// "Print label" for a postal (delivery) order (SIAMSHOP-POST-001). On the
// desktop till it prints silently to the configured label printer; on the web
// admin it opens the label in a window for the browser's print dialog. Stamps
// label_printed_at on success and lets the caller refresh.
export default function PrintLabelButton({ order, onPrinted, compact = false }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const eligible = order && order.fulfilment === 'delivery' && order.status !== 'cancelled' && order.payment_status !== 'refunded';
  if (!eligible) return null;

  async function print(packingCopy = false) {
    setBusy(true);
    setMsg('');
    try {
      const data = await api.adminOrderLabel(order.id);
      const html = await buildLabelHtml(data, { packingCopy });
      if (isElectron) {
        if (!electronConfig.labelPrinter) throw new Error('No label printer chosen — Admin → This device.');
        const r = await desktop.printLabel(html, 1);
        if (!r?.ok) throw new Error(r?.error || 'Print failed');
      } else if (!printLabelInBrowser(html)) {
        throw new Error('Pop-up blocked — allow pop-ups to print the label.');
      }
      await api.adminLabelPrinted(order.id);
      setMsg(order.label_printed_at ? 'Label reprinted' : 'Label printed');
      onPrinted && onPrinted();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="row" style={{ gap: 6, alignItems: 'center', display: 'inline-flex' }}>
      <button className={`btn ${compact ? 'mini' : ''} ${order.label_printed_at ? 'secondary' : ''}`} disabled={busy} onClick={(e) => { e.stopPropagation(); print(false); }}>
        {busy ? 'Printing…' : order.label_printed_at ? '🏷 Reprint label' : '🏷 Print label'}
      </button>
      {!compact && (
        <button className="btn ghost" disabled={busy} onClick={(e) => { e.stopPropagation(); print(true); }} title="Second copy to go inside the box">
          + packing copy
        </button>
      )}
      {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
    </span>
  );
}
