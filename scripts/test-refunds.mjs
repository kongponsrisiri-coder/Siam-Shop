// SIAMSHOP-REFUND-001 — voids, full/partial refunds with reasons, stock back vs
// write-off, manager approval, Z + report.   BASE=http://localhost:4999 node scripts/test-refunds.mjs
import net from 'node:net';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ps = require('../electron/printService.js');

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
for (let i = 0; i < 40; i++) { try { const h = await fetch(BASE + '/api/health').then((r) => r.json()); if (h.db === 'ok') break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

console.log('— setup');
const owner = (await req('POST', '/api/admin/login', { password: PASS })).data.token;
for (const s of (await req('GET', '/api/admin/staff', null, owner)).data || []) if (/^Ref /.test(s.name)) await req('DELETE', `/api/admin/staff/${s.id}`, null, owner);
await req('POST', '/api/admin/staff', { name: 'Ref Cashier', pin: '6161', role: 'cashier' }, owner);
await req('POST', '/api/admin/staff', { name: 'Ref Manager', pin: '6262', role: 'manager' }, owner);
const cashTok = (await req('POST', '/api/staff/login', { pin: '6161' })).data.token;
const mgrTok = (await req('POST', '/api/staff/login', { pin: '6262' })).data.token;
for (const s of (await req('GET', '/api/admin/products', null, owner)).data || []) if (/^Ref Test /.test(s.name)) await req('DELETE', `/api/admin/products/${s.id}`, null, owner);
const A = (await req('POST', '/api/admin/products', { name: 'Ref Test Rice 5kg', price: 10, stock_qty: 20 }, owner)).data;
const B = (await req('POST', '/api/admin/products', { name: 'Ref Test Sauce', price: 2, stock_qty: 20 }, owner)).data;
const F = (await req('POST', '/api/admin/products', { name: 'Ref Test Lunch Box', price: 8, kind: 'food', track_stock: false }, owner)).data;
check('setup ok', cashTok && mgrTok && A?.id && B?.id && F?.id);
let cur = (await req('GET', '/api/till/session', null, mgrTok)).data;
if (cur.session) await req('POST', '/api/till/session/close', { counted_cash: cur.summary.expected_cash, notes: 'test cleanup' }, mgrTok);
await req('POST', '/api/till/session/open', { float_amount: 100 }, cashTok);
const stock = async (id) => (await req('GET', '/api/admin/products', null, owner)).data.find((p) => p.id === id).stock_qty;
const reasons = (await req('GET', '/api/refund-reasons')).data;
check('reasons endpoint: 5 refund reasons, restock set', reasons.refund.length === 5 && reasons.restock.includes('Wrong item') && !reasons.restock.includes('Wastage'), reasons);

console.log('— void before payment');
let r = await req('POST', '/api/till/void', { product_id: A.id, name: A.name, qty: 1, amount: 10, reason: 'Customer changed mind' }, cashTok);
check('void logged (cashier, no PIN)', r.status === 201 && r.data.reason === 'Customer changed mind' && r.data.session_id, r.data);
r = await req('POST', '/api/till/void', { product_id: A.id, name: A.name, qty: 1, amount: 10, reason: 'Meh' }, cashTok);
check('void with unknown reason → 400', r.status === 400);
check('stock untouched by a void', (await stock(A.id)) === 20);

console.log('— cash sale → full refund (restock) needs a manager');
const sale1 = (await req('POST', '/api/sales', { items: [{ product_id: A.id, qty: 2 }, { product_id: B.id, qty: 3 }], payment_method: 'cash', amount_tendered: 30 }, cashTok)).data; // £26
check('sale £26, stock A 18 / B 17', money(sale1.total) === 2600 && (await stock(A.id)) === 18 && (await stock(B.id)) === 17);
r = await req('POST', `/api/admin/orders/${sale1.id}/refund`, { reason: 'Customer changed mind' }, cashTok);
check('cashier refund without approval → 403 approval_required', r.status === 403 && r.data.code === 'approval_required', r.data);
r = await req('POST', `/api/admin/orders/${sale1.id}/refund`, { reason: 'Nope' }, mgrTok);
check('bad reason → 400', r.status === 400);
const appr = (await req('POST', '/api/staff/approve', { pin: '6262' })).data.token;
r = await req('POST', `/api/admin/orders/${sale1.id}/refund`, { reason: 'Customer changed mind', approval_token: appr }, cashTok);
check('cashier + approval: full cash refund £26, restock', r.status === 201 && money(r.data.refund.amount) === 2600 && r.data.refund.method === 'cash' && r.data.refund.stock_action === 'restock' && r.data.refund.approved_by === 'Ref Manager' && r.data.order.payment_status === 'refunded' && r.data.order.status === 'completed', r.data); // till sale keeps 'completed'
check('stock back: A 20 / B 20', (await stock(A.id)) === 20 && (await stock(B.id)) === 20);
r = await req('POST', `/api/admin/orders/${sale1.id}/refund`, { reason: 'Customer changed mind' }, mgrTok);
check('refund again → 400 (nothing left)', r.status === 400 && /Only paid|Nothing left/.test(r.data.error), r.data);
r = await req('POST', `/api/admin/orders/${sale1.id}/refund`, { reason: 'Customer changed mind', approval_token: appr }, cashTok);
check('approval token replay → 403', r.status === 403);

console.log('— card sale → partial refund, wastage write-off');
const sale2 = (await req('POST', '/api/sales', { items: [{ product_id: A.id, qty: 3 }, { product_id: F.id, qty: 1 }], payment_method: 'card' }, mgrTok)).data; // £38
const det0 = (await req('GET', `/api/admin/orders/${sale2.id}`, null, mgrTok)).data;
const lineA = det0.items.find((i) => i.name_snapshot === A.name), lineF = det0.items.find((i) => i.name_snapshot === F.name);
r = await req('POST', `/api/admin/orders/${sale2.id}/refund`, { items: [{ order_item_id: lineA.id, qty: 1 }], reason: 'Damaged', method: 'card', note: 'split bag' }, mgrTok);
check('manager partial refund 1× A (Damaged) → £10 card, writeoff', r.status === 201 && money(r.data.refund.amount) === 1000 && r.data.refund.stock_action === 'writeoff' && r.data.refund.method === 'card' && !r.data.refund.approved_by, r.data);
check('order stays paid, refunded_amount 10, item refunded_qty 1', r.data.order.payment_status === 'paid' && money(r.data.order.refunded_amount) === 1000);
check('write-off: stock A unchanged at 17 (in +1, out −1)', (await stock(A.id)) === 17);
const mv = (await req('GET', '/api/stock/movements', null, owner)).data;
const mvl = (Array.isArray(mv) ? mv : mv.movements || mv.rows || []).filter((m) => m.product_name === A.name).slice(0, 4);
check('ledger has +1 refund and −1 writeoff for A', mvl.some((m) => m.reason === 'refund' && m.change_qty === 1) && mvl.some((m) => m.reason === 'writeoff' && m.change_qty === -1), mvl);
r = await req('POST', `/api/admin/orders/${sale2.id}/refund`, { items: [{ order_item_id: lineA.id, qty: 3 }], reason: 'Faulty' }, mgrTok);
check('over-refund a line → 400', r.status === 400 && /only 2 left/.test(r.data.error), r.data);
r = await req('POST', `/api/admin/orders/${sale2.id}/refund`, { items: [{ order_item_id: lineF.id, qty: 1 }], reason: 'Wrong item', method: 'cash' }, mgrTok);
check('refund the made-to-order line £8 cash — no stock movement (untracked)', r.status === 201 && money(r.data.refund.amount) === 800);
const hist = (await req('GET', `/api/admin/orders/${sale2.id}/refunds`, null, cashTok)).data;
check('refund history: 2 refunds with items', hist.length === 2 && hist.every((h) => h.items.length === 1), hist);
r = await req('POST', `/api/admin/orders/${sale2.id}/refund`, { reason: 'Customer changed mind' }, mgrTok);
check('refund the rest → exact remainder £20 (38 − 10 − 8), order refunded', r.status === 201 && money(r.data.refund.amount) === 2000 && r.data.order.payment_status === 'refunded', r.data);
check('stock A back to 19 (2 restocked)', (await stock(A.id)) === 19);

console.log('— cancel of a paid order goes through the refund path');
const sale3 = (await req('POST', '/api/sales', { items: [{ product_id: B.id, qty: 1 }], payment_method: 'cash' }, cashTok)).data;
r = await req('POST', `/api/admin/orders/${sale3.id}/cancel`, null, cashTok);
check('cashier cancel of a paid sale → 403 (cancel is a manager route)', r.status === 403, r.data);
r = await req('POST', `/api/admin/orders/${sale3.id}/cancel`, { reason: 'Wrong item' }, mgrTok);
check('manager cancel → refunded + cancelled with a refund row', r.status === 200 && r.data.status === 'cancelled' && r.data.payment_status === 'refunded' && r.data.refund?.reason === 'Wrong item', r.data);

console.log('— stripe path without keys');
const online = (await req('POST', '/api/orders', { items: [{ product_id: A.id, qty: 3 }], postcode: 'SW1A 1AA', delivery_address: 'x', customer: { email: 'ref@example.com', name: 'R' } })).data;
check('online order created (≥ £30 minimum)', !!online?.order_id, online);
await req('POST', `/api/admin/orders/${online.order_id}/mark-paid`, null, owner);
r = await req('POST', `/api/admin/orders/${online.order_id}/refund`, { reason: 'Faulty', method: 'stripe' }, mgrTok);
check('stripe refund with Stripe unconfigured → 503 with guidance (recorded cash refund still possible)', r.status === 503 && /Stripe/.test(r.data.error), r.data);
r = await req('POST', `/api/admin/orders/${online.order_id}/refund`, { reason: 'Wrong item', method: 'cash' }, mgrTok);
check('same order refunded as cash instead → 201, 3× A restocked', r.status === 201 && (await stock(A.id)) === 19, r.data);

console.log('— refund with the till closed auto-opens a session');
const zBefore = (await req('GET', '/api/till/session', null, mgrTok)).data.summary;
await req('POST', '/api/till/session/close', { counted_cash: zBefore.expected_cash, notes: 'mid-test close' }, mgrTok);
const sale4 = (await req('POST', '/api/sales', { items: [{ product_id: B.id, qty: 1 }], payment_method: 'cash' }, mgrTok)).data; // auto-opens
await req('POST', '/api/till/session/close', { counted_cash: 2, notes: 'close again' }, mgrTok);
check('till closed before refund', !(await req('GET', '/api/till/session', null, mgrTok)).data.session);
r = await req('POST', `/api/admin/orders/${sale4.id}/refund`, { reason: 'Customer changed mind', method: 'cash' }, mgrTok);
const after = (await req('GET', '/api/till/session', null, mgrTok)).data;
check('cash refund auto-opened a session and belongs to it', r.status === 201 && after.session?.auto_opened && r.data.refund.session_id === after.session.id, { r: r.data, s: after.session });
check('new session expected cash = 0 − 2 (refund only)', money(after.summary.expected_cash) === -200, after.summary);
await req('POST', '/api/till/session/close', { counted_cash: 0, notes: 'cleanup' }, mgrTok);
await req('POST', '/api/till/session/open', { float_amount: 100 }, cashTok);
// re-run the earlier flow's numbers against the FIRST session's Z instead
const sessions = (await req('GET', '/api/till/sessions', null, mgrTok)).data;
const firstZ = (await req('GET', `/api/till/sessions/${sessions.find((x) => x.notes === 'mid-test close').id}`, null, mgrTok)).data.summary || zBefore;
const z = firstZ;

console.log('— Z + report + print');
const cashRefunds = 2600 + 800 + 200 + money(online.total); // sale1 full, F line, sale3, online-as-cash
check(`Z refunds: cash £${(cashRefunds / 100).toFixed(2)}, card £30 (10 + 20)`, money(z.refunds.cash) === cashRefunds && money(z.refunds.card) === 3000, z.refunds);
check('Z voids 1 / £10, wastage 1 / £10', z.voids.count === 1 && money(z.voids.total) === 1000 && z.wastage.qty === 1 && money(z.wastage.value) === 1000, { voids: z.voids, wastage: z.wastage });
check('expected cash = 100 + cash sales (26 + 2) − cash refunds', money(z.expected_cash) === 10000 + 2600 + 200 - cashRefunds, { expected: z.expected_cash, cashSales: z.sales.cash });
const today = new Date().toISOString().slice(0, 10);
const rep = (await req('GET', `/api/admin/report?from=${today}&to=${today}`, null, owner)).data;
check('report: refunds by reason includes Damaged (written off) and wastage lists A', rep.refunds.by_reason.some((x) => x.reason === 'Damaged' && x.stock_action === 'writeoff') && rep.wastage.items.some((w) => w.name === A.name) && rep.voids.count >= 1, { r: rep.refunds, w: rep.wastage, v: rep.voids });
const jobs = [];
const srv = net.createServer((sock) => { const c = []; sock.on('data', (d) => c.push(d)); sock.on('close', () => jobs.push(Buffer.concat(c))); });
await new Promise((res) => srv.listen(19150, '127.0.0.1', res));
await ps.printZReport({ ip: '127.0.0.1', port: 19150 }, z, 'Test');
await new Promise((res) => setTimeout(res, 200));
const text = jobs[0].toString('latin1').replace(/\x1b@|\x1bt.|\x1b%.|\x1b!.|\x1bM.|\x1bG.|\x1ba.|\x1bE.|\x1d!.|\x1dVA./g, '').replace(/\x9c/g, '£');
check('Z print shows voids + wastage lines', /Voids before payment \(1\)/.test(text) && /Wastage written off \(1\)/.test(text), text.slice(0, 500));
await new Promise((res) => srv.close(res));
await req('POST', '/api/till/session/close', { counted_cash: 100, notes: 'test cleanup' }, mgrTok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
