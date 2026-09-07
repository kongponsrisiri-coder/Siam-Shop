// SIAMSHOP-PRINTERS-001 — shop-wide printers, prep tickets exactly-once, routing,
// designated till, reprint, prep ticket bytes over two fake 9100 listeners.
//   BASE=http://localhost:4998 node scripts/test-printers.mjs
import net from 'node:net';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ps = require('../electron/printService.js');

const BASE = process.env.BASE || 'http://localhost:4999';
const PASS = process.env.ADMIN_PASSWORD || 'test-pass-123';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra != null ? JSON.stringify(extra).slice(0, 320) : ''); }
}
async function req(method, p, body, token, headers = {}) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body != null ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const listen = (port) => new Promise((res) => { const jobs = []; const srv = net.createServer((sock) => { const c = []; sock.on('data', (d) => c.push(d)); sock.on('close', () => jobs.push(Buffer.concat(c))); }); srv.listen(port, '127.0.0.1', () => res({ srv, jobs, close: () => new Promise((r) => srv.close(r)) })); });
const strip = (b) => b.toString('latin1').replace(/\x1b[@tE%!Ma]./g, '').replace(/\x1d[!V]./g, '').replace(/\x1b\x70\x00\x19\xfa/g, '[DRAWER]');
for (let i = 0; i < 40; i++) { try { const h = await fetch(BASE + '/api/health').then((r) => r.json()); if (h.db === 'ok') break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

console.log('— setup');
const owner = (await req('POST', '/api/admin/login', { password: PASS })).data.token;
for (const s of (await req('GET', '/api/admin/staff', null, owner)).data || []) if (/^Prn /.test(s.name)) await req('DELETE', `/api/admin/staff/${s.id}`, null, owner);
await req('POST', '/api/admin/staff', { name: 'Prn Cashier', pin: '8181', role: 'cashier' }, owner);
await req('POST', '/api/admin/staff', { name: 'Prn Manager', pin: '8282', role: 'manager' }, owner);
const cashTok = (await req('POST', '/api/staff/login', { pin: '8181' })).data.token;
const mgrTok = (await req('POST', '/api/staff/login', { pin: '8282' })).data.token;
for (const p of (await req('GET', '/api/printers', null, owner)).data?.printers || []) await req('DELETE', `/api/admin/printers/${p.id}`, null, owner);
for (const p of (await req('GET', '/api/admin/products', null, owner)).data || []) if (/^Prn /.test(p.name)) await req('DELETE', `/api/admin/products/${p.id}`, null, owner);
const cats = (await req('GET', '/api/categories')).data || [];
const catOf = async (name) => cats.find((c) => c.name === name) || (await req('POST', '/api/admin/categories', { name }, owner)).data;
const lunchCat = await catOf('Prn Lunch boxes'), bakeryCat = await catOf('Prn Bakery');
const lunch = (await req('POST', '/api/admin/products', { name: 'Prn Pad Thai Box', price: 8, kind: 'food', track_stock: false, category_id: lunchCat.id }, owner)).data;
const bun = (await req('POST', '/api/admin/products', { name: 'Prn Custard Bun', price: 2, kind: 'food', track_stock: false, category_id: bakeryCat.id }, owner)).data;
const rice = (await req('POST', '/api/admin/products', { name: 'Prn Rice 5kg', price: 12, stock_qty: 40 }, owner)).data;
await req('PUT', '/api/admin/printing-device', { device_id: '' }, owner);
check('setup ok', owner && cashTok && mgrTok && lunch?.id && bun?.id && rice?.id && lunchCat?.id && bakeryCat?.id);

console.log('— printers CRUD');
let r = await req('POST', '/api/admin/printers', { name: 'Front till', kind: 'network', ip: '127.0.0.1', port: 19201, job: 'receipt' }, cashTok);
check('cashier cannot add a printer → 403', r.status === 403);
r = await req('POST', '/api/admin/printers', { name: 'Front till', kind: 'network', ip: 'not-an-ip', job: 'receipt' }, mgrTok);
check('bad IP → 400', r.status === 400);
const receiptP = (await req('POST', '/api/admin/printers', { name: 'Front till', kind: 'network', ip: '127.0.0.1', port: 19201, job: 'receipt' }, mgrTok)).data;
const prepP = (await req('POST', '/api/admin/printers', { name: 'Kitchen', kind: 'network', ip: '127.0.0.1', port: 19202, job: 'prep' }, mgrTok)).data;
check('receipt + prep printers created', receiptP?.id && prepP?.id && prepP.job === 'prep' && Array.isArray(prepP.prep_categories) && prepP.prep_categories.length === 0, { receiptP, prepP });
r = await req('POST', '/api/admin/printers', { name: 'Label', kind: 'usb', usb_name: 'Rollo X1040', job: 'label', prep_categories: [1] }, mgrTok);
check('USB label printer; prep_categories ignored for non-prep jobs', r.status === 201 && r.data.kind === 'usb' && r.data.prep_categories.length === 0, r.data);
const labelP = r.data;
// 'label' means anything that is not the 80 mm thermal, so it carries a paper size.
check('label printer defaults to the 4x6 parcel label', labelP.paper === 'label4x6', labelP.paper);
r = await req('POST', '/api/admin/printers', { name: 'Office A4', kind: 'usb', usb_name: 'HP LaserJet', job: 'label', paper: 'a4' }, mgrTok);
check('an A4 printer is a valid "other" printer', r.status === 201 && r.data.paper === 'a4', r.data);
const a4P = r.data;
r = await req('PUT', `/api/admin/printers/${a4P.id}`, { paper: 'label2x1' }, mgrTok);
check('paper size can be changed', r.status === 200 && r.data.paper === 'label2x1', r.data.paper);
r = await req('PUT', `/api/admin/printers/${a4P.id}`, { paper: 'a3-poster' }, mgrTok);
check('an unknown paper size falls back to the parcel label rather than erroring', r.status === 200 && r.data.paper === 'label4x6', r.data.paper);
await req('DELETE', `/api/admin/printers/${a4P.id}`, null, mgrTok);
r = await req('GET', '/api/printers', null, cashTok);
check('cashier can read the shop list (3 printers)', r.status === 200 && r.data.printers.length === 3 && r.data.printing_device_id === null, r.data);
r = await req('POST', `/api/printers/${prepP.id}/test-result`, { ok: true }, cashTok);
check('device reports a test result', r.status === 200 && r.data.last_test_ok === true && r.data.last_test_at);

console.log('— sale → receipt on A, prep ticket on B (only the prep item), drawer only on A');
const A = await listen(19201), B = await listen(19202);
r = await req('POST', '/api/sales', { items: [{ product_id: lunch.id, qty: 1 }, { product_id: rice.id, qty: 1 }], payment_method: 'cash', amount_tendered: 20 }, cashTok, { 'X-Device-Id': 'till-1' });
const sale = r.data;
check('sale 201 with one prep ticket for the Kitchen printer', r.status === 201 && sale.prep_tickets?.length === 1 && sale.prep_tickets[0].printer_id === prepP.id, sale.prep_tickets);
r = await req('POST', '/api/sales', { items: [{ product_id: rice.id, qty: 2 }], payment_method: 'card' }, cashTok, { 'X-Device-Id': 'till-1' });
check('grocery-only sale → no prep ticket', r.status === 201 && r.data.prep_tickets.length === 0, r.data.prep_tickets);
// The till would now print: receipt (drawer) on A via printService, ticket on B after claiming.
await ps.printReceipt({ ip: '127.0.0.1', port: 19201 }, { shopName: 'Prn Shop', orderId: sale.id, items: [{ name: 'Prn Pad Thai Box', qty: 1, line_total: 8, unit_price: 8 }, { name: 'Prn Rice 5kg', qty: 1, line_total: 12, unit_price: 12 }], subtotal: 20, total: 20, payment_method: 'cash', amount_tendered: 20, change_given: 0 });
await ps.openCashDrawer({ ip: '127.0.0.1', port: 19201 });
const ticketId = sale.prep_tickets[0].id;
r = await req('POST', `/api/prep/tickets/${ticketId}/claim`, { device_id: 'till-1' }, cashTok);
check('claim → payload with only the prep item + 1 other item', r.status === 200 && r.data.claimed && r.data.ticket.items.length === 1 && r.data.ticket.items[0].name === 'Prn Pad Thai Box' && r.data.ticket.other_items === 1 && r.data.ticket.fulfilment === 'takeaway', r.data.ticket);
const ticket = r.data.ticket;
r = await req('POST', `/api/prep/tickets/${ticketId}/claim`, { device_id: 'till-2' }, cashTok);
check('second till claiming the same ticket → 409', r.status === 409 && r.data.code === 'claimed');
r = await req('POST', '/api/prep/tickets/999999/claim', { device_id: 'till-2' }, cashTok);
check('claiming a ticket that does not exist → 404 (Krit)', r.status === 404);
await ps.printPrepTicket({ ip: '127.0.0.1', port: 19202 }, ticket);
r = await req('POST', `/api/prep/tickets/${ticketId}/ack`, { device_id: 'till-2', ok: true }, cashTok);
check('ack from a device that did not claim → 409', r.status === 409);
r = await req('POST', `/api/prep/tickets/${ticketId}/ack`, { device_id: 'till-1', ok: true }, cashTok);
check('ack from the claiming till → printed', r.status === 200 && r.data.status === 'printed');
await new Promise((res) => setTimeout(res, 250));
const aText = strip(Buffer.concat(A.jobs)), bText = strip(Buffer.concat(B.jobs));
check('printer A got the receipt (both items) + the drawer pulse', /Prn Pad Thai Box/.test(aText) && /Prn Rice 5kg/.test(aText) && /\[DRAWER\]/.test(aText) && A.jobs.length === 2, aText.slice(0, 200));
check('printer B got the prep ticket: order #, TAKE AWAY, only the prep item, grocery note, NO drawer', /#\d+/.test(bText) && /TAKE AWAY/.test(bText) && /1x Prn Pad Thai Box/.test(bText) && !/Prn Rice 5kg/.test(bText) && /1 grocery item packed at the till/.test(bText) && !/\[DRAWER\]/.test(bText) && B.jobs.length === 1, bText.slice(0, 300));
check('prep ticket bytes have the CUT and no £ totals', Buffer.concat(B.jobs).includes(Buffer.from([0x1d, 0x56, 0x41])) && !/\x9c/.test(Buffer.concat(B.jobs).toString('latin1')));

console.log('— exactly-once with two polling tills; designated till for online orders');
r = await req('GET', '/api/prep/print-queue?device_id=till-2', null, cashTok);
check('till-2 (not designated, not origin) sees nothing', r.status === 200 && r.data.tickets.length === 0 && r.data.designated === false, r.data);
const s2 = (await req('POST', '/api/sales', { items: [{ product_id: lunch.id, qty: 2 }], payment_method: 'card' }, cashTok, { 'X-Device-Id': 'till-1' })).data;
r = await req('GET', '/api/prep/print-queue?device_id=till-1', null, cashTok);
check('origin till sees its own queued ticket', r.data.tickets.some((t) => t.id === s2.prep_tickets[0].id), r.data.tickets);
const [c1, c2] = await Promise.all([req('POST', `/api/prep/tickets/${s2.prep_tickets[0].id}/claim`, { device_id: 'till-1' }, cashTok), req('POST', `/api/prep/tickets/${s2.prep_tickets[0].id}/claim`, { device_id: 'till-2' }, cashTok)]);
check('parallel claims: exactly one 200, one 409', [c1.status, c2.status].sort().join() === '200,409', [c1.status, c2.status]);
const winner = c1.status === 200 ? 'till-1' : 'till-2';
await req('POST', `/api/prep/tickets/${s2.prep_tickets[0].id}/ack`, { device_id: winner, ok: true }, cashTok);
// online order → paid → ticket with no origin → only the designated till sees it
const online = (await req('POST', '/api/orders', { items: [{ product_id: lunch.id, qty: 1 }, { product_id: rice.id, qty: 2 }], postcode: 'SW1A 1AA', delivery_address: '1 Test St', customer: { email: 'prn@example.com', name: 'Prn Online' } })).data;
check('online order created', !!online?.order_id, online);
await req('POST', `/api/admin/orders/${online.order_id}/mark-paid`, null, owner);
await new Promise((res) => setTimeout(res, 300));
let q1 = (await req('GET', '/api/prep/print-queue?device_id=till-1', null, cashTok)).data;
check('no designated till yet → online ticket waits for nobody (till-1 sees none)', q1.tickets.length === 0, q1.tickets);
r = await req('PUT', '/api/admin/printing-device', { device_id: 'till-1' }, cashTok);
check('cashier cannot set the printing till → 403', r.status === 403);
await req('PUT', '/api/admin/printing-device', { device_id: 'till-1' }, mgrTok);
q1 = (await req('GET', '/api/prep/print-queue?device_id=till-1', null, cashTok)).data;
const q2 = (await req('GET', '/api/prep/print-queue?device_id=till-2', null, cashTok)).data;
const onlineTicket = q1.tickets.find((t) => t.order_id === online.order_id);
check('designated till-1 sees the online order ticket; till-2 does not', q1.designated && onlineTicket && !q2.tickets.some((t) => t.order_id === online.order_id), { q1: q1.tickets, q2: q2.tickets });
r = await req('POST', `/api/prep/tickets/${onlineTicket.id}/claim`, { device_id: 'till-1' }, cashTok);
check('online ticket payload: DELIVERY, customer name, only the prep item', r.data.ticket.fulfilment === 'delivery' && r.data.ticket.customer_name === 'Prn Online' && r.data.ticket.items.length === 1 && r.data.ticket.other_items === 1, r.data.ticket);
await req('POST', `/api/prep/tickets/${onlineTicket.id}/ack`, { device_id: 'till-1', ok: true }, cashTok);
await req('POST', `/api/admin/orders/${online.order_id}/mark-paid`, null, owner);
r = await req('GET', `/api/prep/tickets?order_id=${online.order_id}`, null, cashTok);
check('mark-paid twice does not create a second ticket (idempotent)', r.data.length === 1 && r.data[0].status === 'printed', r.data);

console.log('— prep printer down → held, retried, printed once');
const s3 = (await req('POST', '/api/sales', { items: [{ product_id: lunch.id, qty: 1 }], payment_method: 'cash' }, cashTok, { 'X-Device-Id': 'till-1' })).data;
const t3 = s3.prep_tickets[0].id;
await req('POST', `/api/prep/tickets/${t3}/claim`, { device_id: 'till-1' }, cashTok);
r = await req('POST', `/api/prep/tickets/${t3}/ack`, { device_id: 'till-1', ok: false, error: 'ECONNREFUSED' }, cashTok);
check('failed print → status failed, error kept', r.data.status === 'failed');
r = await req('GET', '/api/prep/print-queue?device_id=till-1', null, cashTok);
check('failed ticket is back in the queue for retry', r.data.tickets.some((t) => t.id === t3), r.data.tickets);
r = await req('POST', `/api/prep/tickets/${t3}/claim`, { device_id: 'till-1' }, cashTok);
check('re-claim allowed after failure (attempt 2)', r.status === 200 && r.data.attempts === 2, r.data);
await req('POST', `/api/prep/tickets/${t3}/ack`, { device_id: 'till-1', ok: true }, cashTok);
r = await req('GET', `/api/prep/tickets?order_id=${s3.id}`, null, cashTok);
check('printed once in the end, 2 attempts', r.data.length === 1 && r.data[0].status === 'printed' && r.data[0].attempts === 2, r.data);

console.log('— category routing');
await req('PUT', `/api/admin/printers/${prepP.id}`, { prep_categories: [lunchCat.id] }, mgrTok);
const bakeryP = (await req('POST', '/api/admin/printers', { name: 'Bakery counter', kind: 'network', ip: '127.0.0.1', port: 19203, job: 'prep', prep_categories: [bakeryCat.id] }, mgrTok)).data;
const s4 = (await req('POST', '/api/sales', { items: [{ product_id: lunch.id, qty: 1 }, { product_id: bun.id, qty: 3 }, { product_id: rice.id, qty: 1 }], payment_method: 'cash' }, cashTok, { 'X-Device-Id': 'till-1' })).data;
check('mixed sale → one ticket per prep printer', s4.prep_tickets.length === 2 && s4.prep_tickets.some((t) => t.printer_id === prepP.id) && s4.prep_tickets.some((t) => t.printer_id === bakeryP.id), s4.prep_tickets);
const kt = (await req('POST', `/api/prep/tickets/${s4.prep_tickets.find((t) => t.printer_id === prepP.id).id}/claim`, { device_id: 'till-1' }, cashTok)).data.ticket;
const bt = (await req('POST', `/api/prep/tickets/${s4.prep_tickets.find((t) => t.printer_id === bakeryP.id).id}/claim`, { device_id: 'till-1' }, cashTok)).data.ticket;
check('Kitchen (Lunch boxes) ignores the bun; Bakery gets only the bun', kt.items.length === 1 && kt.items[0].name === 'Prn Pad Thai Box' && bt.items.length === 1 && bt.items[0].name === 'Prn Custard Bun' && bt.items[0].qty === 3, { kt: kt.items, bt: bt.items });
const s5 = (await req('POST', '/api/sales', { items: [{ product_id: bun.id, qty: 1 }], payment_method: 'cash' }, cashTok, { 'X-Device-Id': 'till-1' })).data;
check('bakery-only sale → only the Bakery printer gets a ticket', s5.prep_tickets.length === 1 && s5.prep_tickets[0].printer_id === bakeryP.id, s5.prep_tickets);

console.log('— reprint');
r = await req('POST', '/api/prep/tickets/reprint', { order_id: sale.id, device_id: 'till-2' }, cashTok);
check('reprint creates a new seq-1 ticket for the order', r.status === 201 && r.data.prep_tickets.length === 1 && r.data.prep_tickets[0].seq === 1, r.data);
const rp = (await req('POST', `/api/prep/tickets/${r.data.prep_tickets[0].id}/claim`, { device_id: 'till-2' }, cashTok)).data.ticket;
check('reprint payload flagged', rp.reprint === true);
const C = await listen(19203);
await ps.printPrepTicket({ ip: '127.0.0.1', port: 19203 }, rp);
await new Promise((res) => setTimeout(res, 200));
check('reprinted ticket bytes say REPRINT', /REPRINT/.test(strip(Buffer.concat(C.jobs))));
r = await req('POST', '/api/prep/tickets/reprint', { order_id: (await req('POST', '/api/sales', { items: [{ product_id: rice.id, qty: 1 }], payment_method: 'cash' }, cashTok)).data.id }, cashTok);
check('reprint of a grocery-only order → 400', r.status === 400);
r = await req('GET', `/api/prep/tickets?order_id=${sale.id}`, null, cashTok);
check('ticket list for the order shows seq 0 printed + seq 1 printing', r.data.length === 2 && r.data[0].seq === 0 && r.data[0].status === 'printed' && r.data[1].seq === 1 && r.data[1].status === 'printing', r.data);

console.log('— label printer in the list, other shop isolation');
r = await req('GET', '/api/printers', null, cashTok);
check('label printer listed with job=label (POST-001 path unchanged)', r.data.printers.some((p) => p.id === labelP.id && p.job === 'label' && p.usb_name === 'Rollo X1040'));
r = await req('DELETE', `/api/admin/printers/${labelP.id}`, null, mgrTok);
check('remove printer → ok', r.status === 200);
r = await req('DELETE', `/api/admin/printers/${labelP.id}`, null, mgrTok);
check('remove again → 404', r.status === 404);

await A.close(); await B.close(); await C.close();
await req('PUT', '/api/admin/printing-device', { device_id: '' }, mgrTok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
