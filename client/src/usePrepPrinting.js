// Prep-ticket printing on the desktop till (SIAMSHOP-PRINTERS-001).
//
// Two feeds into one printer loop:
//   • the tickets a sale just created (the till that took payment prints them)
//   • the cloud queue polled every 10 s — this till's own leftovers, plus
//     online orders + other tills' stale tickets when this till is the shop's
//     designated printing till.
// Exactly-once: a ticket is CLAIMED on the server before printing; only the
// winner prints; ack marks printed/failed. A failing prep printer holds the
// ticket (badge) and we retry every 30 s — never blocking the sale.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { desktop, electronConfig, isElectron } from './electron.js';
import { loadPrinters, printerDest } from './printers.js';

export const POLL_MS = 10000;
export const RETRY_MS = 30000;

export function usePrepPrinting({ enabled = true } = {}) {
  const [held, setHeld] = useState(0);      // tickets waiting because a printer failed
  const [lastError, setLastError] = useState('');
  const [designated, setDesignated] = useState(false);
  const busy = useRef(false);
  const failedAt = useRef(new Map()); // ticket id → time of last failure (retry pacing)
  const deviceId = electronConfig.deviceId || '';

  const printOne = useCallback(async (ticketId) => {
    if (!isElectron || !deviceId) return false;
    const last = failedAt.current.get(ticketId);
    if (last && Date.now() - last < RETRY_MS) return false;
    let claim;
    try { claim = await api.prepTicketClaim(ticketId, deviceId); }
    catch (e) { if (e.status === 409) return false; throw e; } // another till has it
    const t = claim.ticket;
    const printers = await loadPrinters();
    const printer = printers.all.find((p) => p.id === t.printer_id);
    const dest = printerDest(printer);
    const r = dest ? await desktop.printPrep(t, dest) : { ok: false, error: 'Prep printer missing from the list' };
    await api.prepTicketAck(ticketId, deviceId, !!r.ok, r.error);
    if (!r.ok) { failedAt.current.set(ticketId, Date.now()); setLastError(`${printer?.name || 'Prep printer'}: ${r.error}`); }
    else { failedAt.current.delete(ticketId); setLastError(''); }
    return !!r.ok;
  }, [deviceId]);

  // Print the tickets a sale just returned (fire and forget from the caller).
  const printTickets = useCallback(async (tickets) => {
    for (const t of tickets || []) { try { await printOne(t.id); } catch (e) { setLastError(e.message); } }
  }, [printOne]);

  useEffect(() => {
    if (!enabled || !isElectron || !deviceId) return undefined;
    let alive = true;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const q = await api.prepPrintQueue(deviceId);
        if (!alive) return;
        setDesignated(!!q.designated);
        setHeld(q.held || 0);
        for (const t of q.tickets || []) { try { await printOne(t.id); } catch (e) { setLastError(e.message); } }
      } catch (e) { /* offline — try again next tick */ }
      finally { busy.current = false; }
    };
    tick();
    const h = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(h); };
  }, [enabled, deviceId, printOne]);

  return { printTickets, held, lastError, designated, deviceId };
}
