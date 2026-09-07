import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { isElectron, electronConfig } from '../electron.js';
import { usePrepPrinting } from '../usePrepPrinting.js';

// Admin → Orders: reprint the prep ticket(s) for an order on the prep printer(s)
// (SIAMSHOP-PRINTERS-001). Desktop only; shows the ticket history for the order.
export default function PrepReprintButton({ order }) {
  const [tickets, setTickets] = useState([]);
  const [msg, setMsg] = useState('');
  const prep = usePrepPrinting({ enabled: false });
  useEffect(() => { if (order?.id) api.prepTicketsFor(order.id).then(setTickets).catch(() => setTickets([])); }, [order?.id]);
  if (!isElectron || !order) return null;
  async function reprint() {
    setMsg('Reprinting…');
    try {
      const r = await api.prepReprint(order.id, electronConfig.deviceId);
      await prep.printTickets(r.prep_tickets);
      setMsg(prep.lastError ? `Held — ${prep.lastError}` : 'Prep ticket reprinted');
      setTickets(await api.prepTicketsFor(order.id));
    } catch (e) { setMsg(e.message); }
  }
  return (
    <span className="row" style={{ gap: 6, alignItems: 'center', display: 'inline-flex', flexWrap: 'wrap' }}>
      <button className="btn secondary" onClick={reprint}>🍜 Reprint prep ticket</button>
      {tickets.length > 0 && <span className="muted" style={{ fontSize: 12 }}>{tickets.map((t) => `${t.printer_name}: ${t.status}${t.seq ? ` (reprint ${t.seq})` : ''}`).join(' · ')}</span>}
      {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
    </span>
  );
}
