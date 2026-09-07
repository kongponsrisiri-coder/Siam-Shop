// SIAMSHOP-DISCOUNT-001 — line/basket discounts, reasons, manager approval
// (one-off token: 60 s, single use, shop-bound), receipt + Z + report agree.
//   BASE=http://localhost:4999 node scripts/test-discounts.mjs
import net from 'node:net';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ps = require('../electron/printService.js');
// These checks read the receipt as text, so they pin the classic (printer-font)
// path; the rendered picture has its own suite in test-print-render.mjs.

const BASE = process.env.BASE || 'http://localhost:4999';
const PASS = process.env.ADMIN_PASSWORD || 'test-pass-123';
let pass = 0, fail = 0;
async function req(method, p, body, token) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra != null ? JSON.stringify(extra).slice(0, 300) : ''); }
}
const money = (n) => Math.round(Number(n) * 100);
const decode = (buf) => buf.toString('latin1').replace(/\x1b@|\x1bt.|\x1b%.|\x1b!.|\x1bM.|\x1bG.|\x1ba.|\x1bE.|\x1d!.|\x1dVA.|\x1bp.../g, '').replace(/\x9c/g, '£');
for (let i = 0; i < 40; i++) { try { const h = await fetch(BASE + '/api/health').then((r) => r.json()); if (h.db === 'ok') break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

console.log('— setup');
const owner = (await req('POST', '/api/admin/login', { password: PASS })).data.token;
await req('PUT', '/api/admin/settings', { discount_reasons: 'Damaged, Near date, Staff, Manager goodwill, Price match', discount_pin_threshold_amount: '10', discount_pin_threshold_percent: '20' }, owner);
for (const s of (await req('GET', '/api/admin/staff', null, owner)).data || []) if (/^Disc /.test(s.name)) await req('DELETE', `/api/admin/staff/${s.id}`, null, owner);
await req('POST', '/api/admin/staff', { name: 'Disc Cashier', pin: '4141', role: 'cashier' }, owner);
await req('POST', '/api/admin/staff', { name: 'Disc Manager', pin: '4242', role: 'manager' }, owner);
const cashTok = (await req('POST', '/api/staff/login', { pin: '4141' })).data.token;
const mgrTok = (await req('POST', '/api/staff/login', { pin: '4242' })).data.token;
for (const s of (await req('GET', '/api/admin/products', null, owner)).data || []) if (/^Disc Test /.test(s.name)) await req('DELETE', `/api/admin/products/${s.id}`, null, owner);
const A = (await req('POST', '/api/admin/products', { name: 'Disc Test Rice 5kg', price: 20, stock_qty: 50 }, owner)).data;   // £20
const B = (await req('POST', '/api/admin/products', { name: 'Disc Test Sauce', price: 4, stock_qty: 50 }, owner)).data;      // £4
check('setup ok', cashTok && mgrTok && A?.id && B?.id);
const pub = (await req('GET', '/api/settings')).data;
check('public settings expose reasons + thresholds', pub.discount_reasons?.includes('Near date') && pub.discount_pin_threshold_amount === 10 && pub.discount_pin_threshold_percent === 20, pub.discount_reasons);
// fresh session for clean Z numbers
let cur = (await req('GET', '/api/till/session', null, mgrTok)).data;
if (cur.session) await req('POST', '/api/till/session/close', { counted_cash: cur.summary.expected_cash, notes: 'test cleanup' }, mgrTok);
await req('POST', '/api/till/session/open', { float_amount: 0 }, cashTok);
const today = new Date().toISOString().slice(0, 10);
const rep0 = (await req('GET', `/api/admin/report?from=${today}&to=${today}`, null, owner)).data; // baseline (demo DBs hold earlier runs)
const byReason0 = Object.fromEntries((rep0.discounts?.by_reason || []).map((x) => [x.reason, money(x.amount)]));
const byStaff0 = Object.fromEntries((rep0.discounts?.by_staff || []).map((x) => [x.staff, money(x.amount)]));

console.log('— validation');
let r = await req('POST', '/api/sales', { items: [{ product_id: A.id, qty: 1, discount: { type: 'percent', value: 10 } }], payment_method: 'cash' }, cashTok);
check('discount without a reason → 400', r.status === 400 && /reason/.test(r.data.error), r.data);
r = await req('POST', '/api/sales', { items: [{ product_id: A.id, qty: 1, discount: { type: 'percent', value: 10, reason: 'Because' } }], payment_method: 'cash' }, cashTok);
check('reason not in the shop list → 400', r.status === 400, r.data);
r = await req('POST', '/api/sales', { items: [{ product_id: A.id, qty: 1, discount: { type: 'percent', value: 150, reason: 'Staff' } }], payment_method: 'cash' }, cashTok);
check('150% → 400', r.status === 400);

console.log('— cashier within threshold: no PIN');
r = await req('POST', '/api/sales', { items: [{ product_id: A.id, qty: 1, discount: { type: 'percent', value: 10, reason: 'Near date' } }], payment_method: 'cash', amount_tendered: 20 }, cashTok);
check('10% line on £20 → £18, no approval needed', r.status === 201 && money(r.data.total) === 1800 && money(r.data.discount_amount) === 200 && r.data.items[0].discount.reason === 'Near date' && !r.data.discount_approved_by, r.data);
const s1 = r.data;
r = await req('POST', '/api/sales', { items: [{ product_id: B.id, qty: 2 }], discount: { type: 'fixed', value: 3, reason: 'Damaged' }, payment_method: 'card' }, cashTok);
check('£3 basket discount on £8 → £5 (under £10, under 20%: 37.5%!)… wait — 37.5% > 20% → approval', r.status === 403 && r.data.code === 'approval_required', r.data);
r = await req('POST', '/api/sales', { items: [{ product_id: B.id, qty: 2 }], discount: { type: 'fixed', value: 1, reason: 'Damaged' }, payment_method: 'card' }, cashTok);
check('£1 basket discount on £8 (12.5%) → £7, no approval', r.status === 201 && money(r.data.total) === 700 && money(r.data.discount_amount) === 100 && r.data.discount.reason === 'Damaged', r.data);
const s2 = r.data;

console.log('— cashier over threshold: manager approval token');
const big = { items: [{ product_id: A.id, qty: 1, discount: { type: 'percent', value: 30, reason: 'Manager goodwill' } }], payment_method: 'cash', amount_tendered: 20 };
r = await req('POST', '/api/sales', big, cashTok);
check('30% by cashier → 403 approval_required, nothing sold', r.status === 403 && r.data.code === 'approval_required', r.data);
r = await req('POST', '/api/staff/approve', { pin: '4141' });
check('cashier PIN cannot approve → 403', r.status === 403, r.data);
r = await req('POST', '/api/staff/approve', { pin: '4242' });
check('manager PIN → approval token (60 s)', r.status === 200 && r.data.token && r.data.ttl_ms === 60000 && r.data.name === 'Disc Manager', r.data);
const approval = r.data.token;
r = await req('GET', '/api/admin/products', null, approval);
check('approval token is NOT a session (401 on normal routes)', r.status === 401);
r = await req('POST', '/api/sales', { ...big, approval_token: approval }, cashTok);
check('30% with approval → £14, approved_by recorded', r.status === 201 && money(r.data.total) === 1400 && money(r.data.discount_amount) === 600 && r.data.discount_approved_by === 'Disc Manager', r.data);
const s3 = r.data;
r = await req('POST', '/api/sales', { ...big, approval_token: approval }, cashTok);
check('REPLAY of the same approval token → 403', r.status === 403 && /already used/i.test(r.data.error), r.data);
r = await req('POST', '/api/sales', { ...big, approval_token: mgrTok }, cashTok);
check('a manager SESSION token is not accepted as an approval → 403', r.status === 403, r.data);
r = await req('POST', '/api/sales', { items: [{ product_id: A.id, qty: 1 }], discount: { type: 'fixed', value: 12, reason: 'Price match' }, payment_method: 'cash' }, cashTok);
check('£12 off (over £10) by cashier → approval_required', r.status === 403 && r.data.code === 'approval_required');
r = await req('POST', '/api/sales', { items: [{ product_id: A.id, qty: 1, discount: { type: 'percent', value: 50, reason: 'Staff' } }], payment_method: 'card' }, mgrTok);
check('manager gives 50% without any approval token → 201, £10', r.status === 201 && money(r.data.total) === 1000 && !r.data.discount_approved_by, r.data);
const s4 = r.data;
r = await req('POST', '/api/staff/approve', { password: PASS });
check('owner password also issues an approval', r.status === 200 && r.data.role === 'admin');

console.log('— stored on the order + receipt + Z + report agree to the penny');
const det = (await req('GET', `/api/admin/orders/${s3.id}`, null, owner)).data;
check('order stores discount_amount 6.00 + approved_by; item stores type/value/reason', money(det.discount_amount) === 600 && det.discount_approved_by === 'Disc Manager' && det.items[0].discount_type === 'percent' && money(det.items[0].discount_amount) === 600 && det.items[0].discount_reason === 'Manager goodwill', det);
const jobs = [];
const srv = net.createServer((sock) => { const c = []; sock.on('data', (d) => c.push(d)); sock.on('close', () => jobs.push(Buffer.concat(c))); });
await new Promise((res) => srv.listen(19140, '127.0.0.1', res));
await ps.printReceipt({ ip: '127.0.0.1', port: 19140 }, { style: 'classic', shopName: 'Test', orderId: s3.id, staff: 'Disc Cashier', items: s3.items.map((it) => ({ name: it.name, qty: it.qty, line_total: it.line_total, gross: it.gross, unit_price: it.gross / it.qty, options: [], discount: it.discount })), discount: s3.discount, discount_amount: s3.discount_amount, subtotal: s3.subtotal, total: s3.total, payment_method: 'cash', amount_tendered: 20, change_given: 6 });
await ps.printReceipt({ ip: '127.0.0.1', port: 19140 }, { style: 'classic', shopName: 'Test', orderId: s2.id, staff: 'Disc Cashier', items: s2.items.map((it) => ({ name: it.name, qty: it.qty, line_total: it.line_total, gross: it.gross, unit_price: it.gross / it.qty, options: [], discount: it.discount })), discount: s2.discount, discount_amount: s2.discount_amount, subtotal: s2.subtotal, total: s2.total, payment_method: 'card' });
await new Promise((res) => setTimeout(res, 300));
const t1 = decode(jobs[0]), t2 = decode(jobs[1]);
check('receipt: item line shows gross £20.00, then "Discount - Manager goodwill -£6.00", TOTAL £14.00, You saved £6.00', /Disc Test Rice 5kg\s+£20\.00/.test(t1) && /Discount - Manager goodwill\s+-£6\.00/.test(t1) && /TOTAL\s+£14\.00/.test(t1) && /You saved £6\.00/.test(t1), t1);
check('receipt: basket "Discount - Damaged -£1.00" after Subtotal £8.00, TOTAL £7.00', /Subtotal\s+£8\.00/.test(t2) && /Discount - Damaged\s+-£1\.00/.test(t2) && /TOTAL\s+£7\.00/.test(t2), t2);
check('receipts ≤42 cols', [...t1.split('\n'), ...t2.split('\n')].every((l) => l.length <= 42));
await new Promise((res) => srv.close(res));
console.log('\n' + t1.split('\n').filter((l) => l.trim()).map((l) => '    │' + l.padEnd(42) + '│').join('\n') + '\n');
const z = (await req('GET', '/api/till/session', null, mgrTok)).data.summary;
const expectedDisc = money(s1.discount_amount) + money(s2.discount_amount) + money(s3.discount_amount) + money(s4.discount_amount); // 200+100+600+1000
check(`Z discounts: 4 sales, total £${(expectedDisc / 100).toFixed(2)}`, z.discounts.count === 4 && money(z.discounts.total) === expectedDisc, z.discounts);
check('Z gross = sum of totals after discount (18 + 7 + 14 + 10 = £49)', money(z.sales.gross) === 4900, z.sales);
const rep = (await req('GET', `/api/admin/report?from=${today}&to=${today}`, null, owner)).data;
const goodwill = rep.discounts.by_reason.find((x) => x.reason === 'Manager goodwill');
const cashierRow = rep.discounts.by_staff.find((x) => x.staff === 'Disc Cashier');
check('report: Manager goodwill grew by £6.00 this run; total grew by the 4 discounts', goodwill && money(goodwill.amount) - (byReason0['Manager goodwill'] || 0) === 600 && money(rep.discounts.total) - money(rep0.discounts?.total || 0) === expectedDisc, { goodwill, total: rep.discounts.total, base: rep0.discounts?.total });
check('report: Disc Cashier grew by £9.00 (2+1+6)', cashierRow && money(cashierRow.amount) - (byStaff0['Disc Cashier'] || 0) === 900, cashierRow);
await req('POST', '/api/till/session/close', { counted_cash: z.expected_cash, notes: 'test cleanup' }, mgrTok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
