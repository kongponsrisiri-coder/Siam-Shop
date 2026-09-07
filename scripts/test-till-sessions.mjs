// SIAMSHOP-TILL-001 — till sessions + Z report (cash-up). Acceptance path:
// open → 3 sales (cash/card/cash) → refund one → close with counted cash →
// variance correct → Z prints (fake 9100) → shows in Admin list.
//   BASE=http://localhost:4999 node scripts/test-till-sessions.mjs
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
check('owner token', !!owner);
for (const s of (await req('GET', '/api/admin/staff', null, owner)).data || []) if (/^Till /.test(s.name)) await req('DELETE', `/api/admin/staff/${s.id}`, null, owner);
const cashier = (await req('POST', '/api/admin/staff', { name: 'Till Cashier', pin: '5151', role: 'cashier' }, owner)).data;
const manager = (await req('POST', '/api/admin/staff', { name: 'Till Manager', pin: '5252', role: 'manager' }, owner)).data;
check('staff created', cashier?.id && manager?.id);
const cashTok = (await req('POST', '/api/staff/login', { pin: '5151' })).data.token;
const mgrTok = (await req('POST', '/api/staff/login', { pin: '5252' })).data.token;
// If a session is already open from a previous run, close it as owner first.
let cur = (await req('GET', '/api/till/session', null, cashTok)).data;
if (cur.session) { await req('POST', '/api/till/session/close', { counted_cash: cur.summary.expected_cash, notes: 'test cleanup' }, owner); }
const products = (await req('GET', '/api/products')).data;
const plain = products.filter((p) => !p.option_groups?.length && p.track_stock && p.stock_qty > 5 && p.available_now !== false);
if (plain.length < 2) { console.error('❌ need two in-stock plain products — seed first'); process.exit(1); }
const [A, B] = plain;

console.log('— open');
let r = await req('GET', '/api/till/session', null, cashTok);
check('no session open', r.status === 200 && r.data.session === null, r.data);
r = await req('POST', '/api/till/session/open', { float_amount: 'abc' }, cashTok);
check('bad float → 400', r.status === 400);
r = await req('POST', '/api/till/session/open', { float_amount: 50 }, cashTok);
check('cashier opens with £50 float', r.status === 201 && money(r.data.session.float_amount) === 5000 && r.data.session.opened_by === 'Till Cashier', r.data);
const sid = r.data.session.id;
r = await req('POST', '/api/till/session/open', { float_amount: 20 }, mgrTok);
check('second open → 409 with the existing session', r.status === 409 && r.data.session?.id === sid, r.data);

console.log('— sales in the session');
const s1 = (await req('POST', '/api/sales', { items: [{ product_id: A.id, qty: 2 }], payment_method: 'cash', amount_tendered: 50 }, cashTok)).data;
const s2 = (await req('POST', '/api/sales', { items: [{ product_id: B.id, qty: 1 }], payment_method: 'card' }, cashTok)).data;
const s3 = (await req('POST', '/api/sales', { items: [{ product_id: A.id, qty: 1 }], payment_method: 'cash', amount_tendered: 10 }, cashTok)).data;
check('sales stamped with session_id', s1.session_id === sid && s2.session_id === sid && s3.session_id === sid, [s1.session_id, s2.session_id, s3.session_id]);
const cashSales = Number(s1.total) + Number(s3.total), cardSales = Number(s2.total);
r = await req('GET', '/api/till/session', null, cashTok);
let z = r.data.summary;
check('live summary: 3 sales, cash/card split', z.sales.count === 3 && money(z.sales.cash) === money(cashSales) && money(z.sales.card) === money(cardSales), z.sales);
check('expected cash = float + cash sales', money(z.expected_cash) === money(50 + cashSales), { expected: z.expected_cash, cashSales });

console.log('— refund one cash sale');
r = await req('POST', `/api/admin/orders/${s3.id}/cancel`, null, owner);
check('refund (cancel paid) ok', r.status === 200 && r.data.payment_status === 'refunded');
z = (await req('GET', '/api/till/session', null, cashTok)).data.summary;
check('refund counted: 1 refund (cash); gross still counts all 3 rung', z.refunds.count === 1 && money(z.refunds.cash) === money(s3.total) && z.sales.count === 3, { refunds: z.refunds, sales: z.sales });
check('expected cash = float + cash sales − cash refunds', money(z.expected_cash) === money(50 + Number(s1.total)), { expected: z.expected_cash });
check('net = gross − refunds', money(z.net) === money(Number(s1.total) + Number(s2.total)), { net: z.net });

console.log('— close (cash-up)');
r = await req('POST', '/api/till/session/close', { counted_cash: 100 }, cashTok);
check('cashier cannot close → 403', r.status === 403, r.data);
r = await req('POST', '/api/till/session/close', { counted_cash: -1 }, mgrTok);
check('negative counted → 400', r.status === 400);
const counted = +(50 + Number(s1.total) - 2.5).toFixed(2); // £2.50 short
r = await req('POST', '/api/till/session/close', { counted_cash: counted, notes: 'short £2.50 — checked' }, mgrTok);
check('manager closes', r.status === 200 && r.data.session.status === 'closed' && r.data.session.closed_by === 'Till Manager', r.data);
z = r.data.summary;
check('variance = counted − expected = −£2.50', money(z.variance) === -250, { variance: z.variance, counted: z.counted_cash, expected: z.expected_cash });
check('summary snapshot stored with notes', z.notes === 'short £2.50 — checked' && z.closed_at);
r = await req('POST', '/api/till/session/close', { counted_cash: 10 }, mgrTok);
check('close again → 409 (nothing open)', r.status === 409);
r = await req('GET', '/api/till/session', null, cashTok);
check('after close: no open session', r.data.session === null);
r = await req('POST', '/api/sales', { items: [{ product_id: B.id, qty: 1 }], payment_method: 'cash' }, cashTok);
check('sale with no session still records (session_id null)', r.status === 201 && r.data.session_id === null, r.data.session_id);

console.log('— Admin list + detail');
r = await req('GET', '/api/till/sessions', null, mgrTok);
const row = (r.data || []).find((x) => x.id === sid);
check('list shows the closed session with gross + variance', row && row.status === 'closed' && money(row.variance) === -250 && row.sales_count === 3, row);
r = await req('GET', `/api/till/sessions/${sid}`, null, cashTok);
check('detail returns the stored snapshot (same numbers)', r.status === 200 && money(r.data.summary.expected_cash) === money(z.expected_cash) && r.data.summary.sales.count === 3);
check('prep role cannot read Z', (await req('GET', '/api/till/sessions', null, 'x')).status === 401);

console.log('— Z print via fake 9100');
const jobs = [];
const srv = net.createServer((sock) => { const c = []; sock.on('data', (d) => c.push(d)); sock.on('close', () => jobs.push(Buffer.concat(c))); });
await new Promise((res) => srv.listen(19120, '127.0.0.1', res));
await ps.printZReport({ ip: '127.0.0.1', port: 19120 }, z, 'Cha & Pinto Box');
await new Promise((res) => setTimeout(res, 200));
const text = (jobs[0] || Buffer.alloc(0)).toString('latin1').replace(/\x1b@|\x1bt.|\x1b%.|\x1b!.|\x1bM.|\x1bG.|\x1ba.|\x1bE.|\x1d!.|\x1dVA./g, '').replace(/\x9c/g, '£');
check('Z printed: title + session + variance + expected + refunds', /Z REPORT/.test(text) && new RegExp(`Session #${sid}`).test(text) && /VARIANCE\s+-£2\.50/.test(text) && /EXPECTED/.test(text) && /Refunds \(1\)/.test(text), text.slice(0, 400));
check('Z ends with cut', jobs[0] && jobs[0].indexOf(Buffer.from([0x1d, 0x56, 0x41, 0x05])) === jobs[0].length - 4);
console.log('\n' + text.split('\n').filter((l) => l.trim()).map((l) => '    │' + l.padEnd(42) + '│').join('\n') + '\n');
await new Promise((res) => srv.close(res));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
