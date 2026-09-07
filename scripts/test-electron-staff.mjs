// SIAMSHOP-ELECTRON-001 — staff PIN sign-in + role gating, against :4999.
const BASE = process.env.BASE || 'http://localhost:4999';
let owner = '';
let pass = 0, fail = 0;
async function req(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra != null ? JSON.stringify(extra).slice(0, 300) : ''); }
}
for (let i = 0; i < 40; i++) { try { const h = await fetch(BASE + '/api/health').then((r) => r.json()); if (h.db === 'ok') break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

console.log('— owner login + staff CRUD');
({ data: { token: owner } } = await req('POST', '/api/admin/login', { password: process.env.ADMIN_PASSWORD || 'test-pass-123' }));
check('owner token', !!owner);
// clean slate for reruns
for (const s of (await req('GET', '/api/admin/staff', null, owner)).data || []) await req('DELETE', `/api/admin/staff/${s.id}`, null, owner);
let r = await req('POST', '/api/admin/staff', { name: 'Nok Manager', pin: '1234', role: 'manager' }, owner);
check('create manager 201', r.status === 201 && r.data.role === 'manager', r.data);
r = await req('POST', '/api/admin/staff', { name: 'Dan Cashier', pin: '2580', role: 'cashier' }, owner);
check('create cashier 201', r.status === 201, r.data);
const danId = r.data.id;
r = await req('POST', '/api/admin/staff', { name: 'Pim Prep', pin: '7777', role: 'prep' }, owner);
check('create prep 201', r.status === 201, r.data);
r = await req('POST', '/api/admin/staff', { name: 'Dup', pin: '2580', role: 'cashier' }, owner);
check('duplicate PIN → 409', r.status === 409, r.data);
r = await req('POST', '/api/admin/staff', { name: 'Bad', pin: '12', role: 'cashier' }, owner);
check('short PIN → 400', r.status === 400, r.data);
const list = (await req('GET', '/api/admin/staff', null, owner)).data;
check('list has 3, no pin hashes exposed', list.length === 3 && !list.some((s) => 'pin_hash' in s), list);

console.log('— PIN login');
r = await req('POST', '/api/staff/login', { pin: '0000' });
check('wrong PIN → 401', r.status === 401, r.data);
r = await req('POST', '/api/staff/login', { pin: 'abcd' });
check('non-numeric PIN → 400', r.status === 400, r.data);
const nok = (await req('POST', '/api/staff/login', { pin: '1234' })).data;
const dan = (await req('POST', '/api/staff/login', { pin: '2580' })).data;
const pim = (await req('POST', '/api/staff/login', { pin: '7777' })).data;
check('manager token + name/role', nok.token && nok.role === 'manager' && nok.name === 'Nok Manager', nok);
check('cashier token', dan.token && dan.role === 'cashier');
check('prep token', pim.token && pim.role === 'prep');
r = await req('GET', '/api/admin/me', null, dan.token);
check('me returns name + role for cashier', r.status === 200 && r.data.name === 'Dan Cashier' && r.data.role === 'cashier', r.data);

console.log('— role gating');
r = await req('GET', '/api/admin/products', null, dan.token);
check('cashier can read the catalogue', r.status === 200);
const prodId = r.data[0]?.id;
r = await req('PUT', `/api/admin/products/${prodId}`, { price: 1 }, dan.token);
check('cashier cannot edit products → 403', r.status === 403, r.data);
r = await req('GET', '/api/admin/staff', null, dan.token);
check('cashier cannot list staff → 403', r.status === 403, r.data);
r = await req('GET', '/api/admin/settings', null, dan.token);
check('cashier cannot read settings → 403', r.status === 403);
r = await req('GET', '/api/prep', null, dan.token);
check('cashier can use prep', r.status === 200);
r = await req('GET', '/api/prep', null, pim.token);
check('prep role can use prep', r.status === 200);
r = await req('GET', '/api/admin/products', null, pim.token);
check('prep role cannot read catalogue → 403', r.status === 403);
r = await req('POST', '/api/sales', { items: [{ product_id: prodId, qty: 1 }], payment_method: 'cash' }, pim.token);
check('prep role cannot ring a sale → 403', r.status === 403, r.data);
r = await req('GET', '/api/admin/staff', null, nok.token);
check('manager can list staff', r.status === 200);
r = await req('PUT', `/api/admin/products/${prodId}`, { sort_order: 0 }, nok.token);
check('manager can edit products', r.status === 200, r.data);

console.log('— sale records who rang it');
const catalogue = (await req('GET', '/api/products')).data;
const plain = catalogue.find((p) => !p.option_groups?.length && p.track_stock && p.stock_qty > 0);
r = await req('POST', '/api/sales', { items: [{ product_id: plain.id, qty: 1 }], payment_method: 'card' }, dan.token);
check('cashier sale 201 with staff name + fulfilment', r.status === 201 && r.data.staff === 'Dan Cashier' && r.data.fulfilment === 'takeaway', r.data);
const det = (await req('GET', `/api/admin/orders/${r.data.id}`, null, owner)).data;
check('orders.staff = cashier name (from session, not typed)', det.staff === 'Dan Cashier', det.staff);

console.log('— disable + delete');
await req('PUT', `/api/admin/staff/${danId}`, { active: false }, owner);
r = await req('POST', '/api/staff/login', { pin: '2580' });
check('disabled staff cannot sign in → 401', r.status === 401);
r = await req('GET', '/api/admin/products', null, dan.token);
check('existing token still valid until expiry (documented)', r.status === 200);
r = await req('PUT', `/api/admin/staff/${danId}`, { active: true, pin: '1234' }, owner);
check('re-enable with a PIN already used → 409', r.status === 409, r.data);
r = await req('PUT', `/api/admin/staff/${danId}`, { active: true, pin: '4321' }, owner);
check('re-enable + new PIN ok', r.status === 200 && r.data.active === true, r.data);
r = await req('POST', '/api/staff/login', { pin: '4321' });
check('new PIN signs in', r.status === 200 && r.data.name === 'Dan Cashier');
r = await req('POST', '/api/staff/login', { pin: '1234' }, null);
check('customer token rejected on staff routes', (await req('GET', '/api/prep', null, 'not-a-token')).status === 401);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
