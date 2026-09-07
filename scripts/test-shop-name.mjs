// The shop can rename itself (PUT /api/admin/shop). The name was frozen at
// whatever was typed at sign-up; it is what the storefront banner, receipts,
// prep tickets and order emails all say.
//   BASE=http://localhost:5099 ADMIN_PASSWORD=… node scripts/test-shop-name.mjs
const BASE = process.env.BASE || 'http://localhost:4999';
const PASS = process.env.ADMIN_PASSWORD || 'test-pass-123';
let pass = 0, fail = 0;
const check = (n, c, e) => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, e != null ? JSON.stringify(e).slice(0, 300) : ''); } };
async function req(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
for (let i = 0; i < 40; i++) { try { const h = await fetch(BASE + '/api/health').then((r) => r.json()); if (h.db === 'ok') break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

console.log('— setup');
const owner = (await req('POST', '/api/admin/login', { password: PASS })).data.token;
check('owner token', !!owner);
for (const s of (await req('GET', '/api/admin/staff', null, owner)).data || []) if (/^Name /.test(s.name)) await req('DELETE', `/api/admin/staff/${s.id}`, null, owner);
await req('POST', '/api/admin/staff', { name: 'Name Cashier', pin: '8181', role: 'cashier' }, owner);
const cashier = (await req('POST', '/api/staff/login', { pin: '8181' })).data.token;
const before = (await req('GET', '/api/shop')).data;
check('shop reads back with a name and a slug', !!before.name && !!before.slug, before);

console.log('— who may rename');
let r = await req('PUT', '/api/admin/shop', { name: 'Sneaky Rename' });
check('no token → 401', r.status === 401, r.status);
r = await req('PUT', '/api/admin/shop', { name: 'Sneaky Rename' }, cashier);
check('cashier → 403', r.status === 403, r.data);

console.log('— validation');
r = await req('PUT', '/api/admin/shop', { name: '   ' }, owner);
check('blank name → 400', r.status === 400 && /name/i.test(r.data.error), r.data);
r = await req('PUT', '/api/admin/shop', {}, owner);
check('missing name → 400', r.status === 400, r.data);
r = await req('PUT', '/api/admin/shop', { name: 'x'.repeat(201) }, owner);
check('over 200 characters → 400', r.status === 400 && /too long/i.test(r.data.error), r.data);
check('nothing was renamed by the rejected attempts', (await req('GET', '/api/shop')).data.name === before.name);

console.log('— renaming');
r = await req('PUT', '/api/admin/shop', { name: '  Cha &  Pinto   Box  ' }, owner);
check('manager renames; spaces trimmed and collapsed', r.status === 200 && r.data.name === 'Cha & Pinto Box', r.data);
check('slug and id are untouched — the address must not move', r.data.slug === before.slug && r.data.id === before.id, r.data);
check('public /api/shop shows the new name', (await req('GET', '/api/shop')).data.name === 'Cha & Pinto Box');
check('200 characters is accepted', (await req('PUT', '/api/admin/shop', { name: 'y'.repeat(200) }, owner)).status === 200);

r = await req('PUT', '/api/admin/shop', { name: before.name }, owner);
check('renamed back for the next suite', r.status === 200 && r.data.name === before.name);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
