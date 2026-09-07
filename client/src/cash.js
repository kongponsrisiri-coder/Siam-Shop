// Cash tender arithmetic for the till pad (see components/CashPad.jsx).
// Kept out of the component so it can be tested without a DOM.

// The exact money, then the notes a customer would realistically hand over for
// a total this size. Nothing below the total, since that would not settle the
// sale, and no duplicates: a £10.00 total offers £10, £20, £50, not £10 four
// times over.
export function quickTenders(total) {
  const t = Math.max(0, Number(total) || 0);
  const up = (step) => Math.ceil(t / step) * step;
  const out = [];
  for (const v of [t, up(5), up(10), up(20), 50]) {
    const n = +Number(v).toFixed(2);
    if (n >= t && !out.includes(n)) out.push(n);
  }
  return out.slice(0, 4);
}

// Guard the string the keys build: one decimal point, at most two decimals, no
// runaway leading zero. Entry is plain decimal, so 4 then 0 is £40, not £0.40.
export function pressKey(current, key) {
  const s = String(current || '');
  if (key === '⌫') return s.slice(0, -1);
  if (key === '.') return s.includes('.') ? s : (s === '' ? '0.' : s + '.');
  const next = s === '0' ? key : s + key;
  const [, dec] = next.split('.');
  if (dec != null && dec.length > 2) return s;
  return next;
}
