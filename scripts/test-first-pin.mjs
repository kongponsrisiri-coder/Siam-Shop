// First-time PIN (Korakot, 7 Sep 2026): a shop with NO staff accepts 2526 once,
// which creates the first manager and forces a PIN change before the till opens.
//   BASE=http://localhost:4998 node scripts/test-first-pin.mjs
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
for (let i = 0; i < 40; i++) { try { const h = await fetch(BASE + '/api/health').then((r) => r.json()); if (h.db === 'ok') break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

console.log('— setup: empty the staff list');
const owner = (await req('POST', '/api/admin/login', { password: PASS })).data.token;
for (const s of (await req('GET', '/api/admin/staff', null, owner)).data || []) await req('DELETE', `/api/admin/staff/${s.id}`, null, owner);
check('no staff left', ((await req('GET', '/api/admin/staff', null, owner)).data || []).length === 0);

console.log('— first-time PIN');
let r = await req('POST', '/api/staff/login', { pin: '1111' });
check('random PIN on an empty shop → 401', r.status === 401);
r = await req('POST', '/api/staff/login', { pin: '2526' });
check('2526 on an empty shop signs in as manager with must_change_pin', r.status === 200 && r.data.role === 'manager' && r.data.must_change_pin === true && r.data.name === 'Manager', r.data);
const firstTok = r.data.token;
const staffList = (await req('GET', '/api/admin/staff', null, owner)).data;
check('exactly one staff row was created', staffList.length === 1 && staffList[0].role === 'manager', staffList);
r = await req('POST', '/api/staff/login', { pin: '2526' });
check('2526 again still works (not changed yet), still must_change_pin', r.status === 200 && r.data.must_change_pin === true);

console.log('— the bootstrap token is restricted until the PIN is changed (Krit)');
const prod = (await req('POST', '/api/admin/products', { name: 'Pin Test Item', price: 1, stock_qty: 5 }, owner)).data;
r = await req('POST', '/api/sales', { items: [{ product_id: prod.id, qty: 1 }], payment_method: 'cash' }, firstTok);
check('bootstrap token → POST /api/sales 403 pin_change_required', r.status === 403 && r.data.code === 'pin_change_required', r.data);
r = await req('GET', '/api/admin/orders', null, firstTok);
check('bootstrap token → GET /api/admin/orders 403 too (manager role does not help)', r.status === 403 && r.data.code === 'pin_change_required', r.data);
r = await req('GET', '/api/staff/me', null, firstTok);
check('bootstrap token → GET /api/staff/me allowed', r.status === 200);

console.log('— forced change');
r = await req('POST', '/api/staff/change-pin', { new_pin: '2526' }, firstTok);
check('new PIN = 2526 → 400', r.status === 400);
r = await req('POST', '/api/staff/change-pin', { new_pin: '1111' }, firstTok);
check('1111 → 400 too easy', r.status === 400);
r = await req('POST', '/api/staff/change-pin', { new_pin: '12' }, firstTok);
check('2 digits → 400', r.status === 400);
r = await req('POST', '/api/staff/change-pin', { new_pin: '4820' }, owner);
check('owner (password) token cannot change a PIN → 400', r.status === 400, r.data);
r = await req('POST', '/api/staff/change-pin', { new_pin: '4820', name: 'Korakot' }, firstTok);
check('4820 + name → new token, name Korakot, must_change_pin false', r.status === 200 && r.data.name === 'Korakot' && r.data.role === 'manager' && r.data.must_change_pin === false && r.data.token, r.data);
const newTok = r.data.token;
r = await req('POST', '/api/sales', { items: [{ product_id: prod.id, qty: 1 }], payment_method: 'cash' }, newTok);
check('token from change-pin → POST /api/sales 201', r.status === 201, r.data);
r = await req('POST', '/api/sales', { items: [{ product_id: prod.id, qty: 1 }], payment_method: 'cash' }, firstTok);
check('old bootstrap token stays restricted (403) even after the change', r.status === 403 && r.data.code === 'pin_change_required');
r = await req('POST', '/api/staff/login', { pin: '4820' });
check('sign in with 4820 → manager Korakot, no forced change', r.status === 200 && r.data.name === 'Korakot' && r.data.must_change_pin === false, r.data);
r = await req('POST', '/api/sales', { items: [{ product_id: prod.id, qty: 1 }], payment_method: 'cash' }, r.data.token);
check('fresh 4820 token → sale 201', r.status === 201);
await req('DELETE', `/api/admin/products/${prod.id}`, null, owner);
r = await req('POST', '/api/staff/login', { pin: '2526' });
check('2526 is dead once the shop has staff → 401', r.status === 401, r.data);
r = await req('GET', '/api/staff/me', null, newTok);
check('new token works on /api/staff/me', r.status === 200 && r.data.name === 'Korakot');

console.log('— staff can change their own PIN any time; uniqueness');
await req('POST', '/api/admin/staff', { name: 'Pin Cashier', pin: '7373', role: 'cashier' }, owner);
const cashTok = (await req('POST', '/api/staff/login', { pin: '7373' })).data.token;
r = await req('POST', '/api/staff/change-pin', { new_pin: '4820' }, cashTok);
check("cashier picks the manager's PIN → 409", r.status === 409, r.data);
r = await req('POST', '/api/staff/change-pin', { new_pin: '9081' }, cashTok);
check('cashier changes own PIN → 200', r.status === 200 && r.data.role === 'cashier');
r = await req('POST', '/api/staff/login', { pin: '7373' });
check('old cashier PIN dead', r.status === 401);
r = await req('POST', '/api/staff/login', { pin: '9081' });
check('new cashier PIN works', r.status === 200 && r.data.name === 'Pin Cashier');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
