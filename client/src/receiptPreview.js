// Text mock of the 42-column till receipt (SIAMSHOP-RECEIPT-001) for the
// Admin → Settings live preview. Mirrors electron/printService.buildReceipt's
// layout (the printer builds the real bytes; this is only for the eye).
const W = 42;
const pad = (s, n, right = false) => { s = String(s ?? '').slice(0, n); return right ? s.padStart(n) : s.padEnd(n); };
const col2 = (l, v) => pad(l, W - String(v).length - 1) + ' ' + v;
const center = (s) => { s = String(s ?? '').slice(0, W); const left = Math.floor((W - s.length) / 2); return ' '.repeat(left) + s; };
const money = (n) => '£' + Number(n || 0).toFixed(2);
const rule = '-'.repeat(W);
function wrap(s, width) {
  const words = String(s || '').split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > width) { if (cur) lines.push(cur); cur = w.slice(0, width); } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

export function receiptPreview({ shopName = 'SiamShop', header = '', footer = '', vatNumber = '' } = {}) {
  const out = [];
  out.push(center(String(shopName).slice(0, 20).toUpperCase()));
  for (const line of String(header || '').split(/\r?\n/)) if (line.trim()) for (const l of wrap(line, W)) out.push(center(l));
  out.push('');
  out.push(col2('Receipt #1234', '07/09/2026, 12:31'));
  out.push(col2('Served by', 'Nok'));
  out.push(rule);
  out.push(pad('1x', 4) + ' ' + pad('Rice Lunch Box', 27) + ' ' + pad(money(11.7), 9, true));
  out.push('     - Large, Spicy Chilli Basil Pork');
  out.push(pad('2x', 4) + ' ' + pad('Tiparos Fish Sauce 300ml', 27) + ' ' + pad(money(3), 9, true));
  out.push('     @ £1.50 each');
  out.push(rule);
  out.push(col2('TOTAL', money(14.7)));
  out.push(col2('Paid by CASH', money(20)));
  out.push(col2('Change', money(5.3)));
  out.push(rule);
  out.push(center(String(footer || 'Thank you for shopping with us!').slice(0, W)));
  if (vatNumber) out.push(center(`VAT No. ${vatNumber}`.slice(0, W)));
  return out.join('\n');
}
