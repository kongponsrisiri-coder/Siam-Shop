// Shop-wide printers (SIAMSHOP-PRINTERS-001) — resolve which printer this
// device uses for each job, and turn a printer row into the destination the
// Electron main process understands ({ ip, port, name, lprQueue }).
//
// Per device only `receiptPrinterId` (the one with the cash drawer) and the
// "printing till" flag live in config.json; everything else is the cloud list.
import { api } from './api.js';
import { electronConfig, isElectron } from './electron.js';

export function printerDest(p) {
  if (!p) return null;
  return p.kind === 'usb'
    ? { ip: '', port: 9100, name: p.usb_name || '', lprQueue: 'lp' }
    : { ip: p.ip || '', port: Number(p.port) || 9100, name: '', lprQueue: p.lpr_queue || 'lp' };
}

// Legacy per-device printer block (pre-PRINTERS-001) as a destination, or null.
export function legacyDest() {
  const lp = electronConfig.printer || {};
  return lp.ip || lp.name ? { ip: lp.ip || '', port: Number(lp.port) || 9100, name: lp.name || '', lprQueue: lp.lprQueue || 'lp' } : null;
}

// { receipt, receiptDest, prep: [...], label, labelName, printingDeviceId, all }
export function resolvePrinters(list, cfg = electronConfig) {
  const printers = (list?.printers || list || []).filter((p) => p.active !== false);
  const receipt = printers.find((p) => p.id === cfg.receiptPrinterId && p.job === 'receipt') || null;
  const label = printers.find((p) => p.job === 'label') || null;
  return {
    all: printers,
    receipt,
    receiptDest: receipt ? printerDest(receipt) : legacyDest(),
    prep: printers.filter((p) => p.job === 'prep'),
    label,
    labelName: label?.kind === 'usb' ? label.usb_name : (cfg.labelPrinter || ''),
    printingDeviceId: list?.printing_device_id || null,
  };
}

let cache = { at: 0, value: null };
export async function loadPrinters(force = false) {
  if (!isElectron) return resolvePrinters({ printers: [] });
  if (!force && cache.value && Date.now() - cache.at < 30000) return cache.value;
  const list = await api.printers();
  cache = { at: Date.now(), value: resolvePrinters(list) };
  return cache.value;
}
export function invalidatePrinters() { cache = { at: 0, value: null }; }

// One-time migration of the pre-PRINTERS-001 per-device config into the shop
// list: legacy receipt printer → a 'receipt' row + receipt_printer_id; legacy
// label_printer → a 'label' row. Manager only; idempotent; keeps the old fields.
export async function migrateLegacyPrinters(list, saveConfig) {
  const printers = list?.printers || [];
  const cfg = electronConfig;
  const created = [];
  const lp = cfg.printer || {};
  if (!cfg.receiptPrinterId && (lp.ip || lp.name)) {
    let row = printers.find((p) => p.job === 'receipt' && ((lp.ip && p.ip === lp.ip) || (lp.name && p.usb_name === lp.name)));
    if (!row) {
      row = await api.adminAddPrinter(lp.ip
        ? { name: `Receipt printer ${lp.ip}`, kind: 'network', ip: lp.ip, port: lp.port || 9100, lpr_queue: lp.lprQueue || 'lp', job: 'receipt', model: lp.model || '' }
        : { name: lp.model || lp.name, kind: 'usb', usb_name: lp.name, job: 'receipt', model: lp.model || '' });
      created.push(row);
    }
    await saveConfig({ receipt_printer_id: row.id });
  }
  if (cfg.labelPrinter && !printers.some((p) => p.job === 'label')) {
    created.push(await api.adminAddPrinter({ name: `Label printer`, kind: 'usb', usb_name: cfg.labelPrinter, job: 'label' }));
  }
  return created;
}
