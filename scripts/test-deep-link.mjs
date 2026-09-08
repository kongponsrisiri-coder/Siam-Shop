// SIAMSHOP-DEEPLINK-001 — a marketing site's "Add to basket" must land the
// customer on the basket with the item in it, not on the whole catalogue.
// This covers the resolver those links use.
//   BASE=http://localhost:5151 ADMIN_PASSWORD=… node scripts/test-deep-link.mjs
const BASE = process.env.BASE || 'http://localhost:4999';
const PASS = process.env.ADMIN_PASSWORD || 'test-pass-123';
let pass = 0, fail = 0;
const check = (n, c, e) => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, e !== undefined ? JSON.stringify(e).slice(0, 240) : ''); } };
async function req(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const resolve = (ref) => req('GET', `/api/products/resolve?ref=${encodeURIComponent(ref)}`);
for (let i = 0; i < 40; i++) { try { const h = await fetch(BASE + '/api/health').then((r) => r.json()); if (h.db === 'ok') break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

console.log('— setup');
const owner = (await req('POST', '/api/admin/login', { password: PASS })).data.token;
check('owner token', !!owner);
const cat = (await req('POST', '/api/admin/categories', { name: 'Deep Link Test' }, owner)).data;
const tea = (await req('POST', '/api/admin/products', { name: 'CHATRAMUE THAI TEA MIX 400G', price: 6.2, stock_qty: 5, barcode: '8850126001234', category_id: cat.id }, owner)).data;
await req('POST', '/api/admin/products', { name: 'Deep Gone', price: 1, stock_qty: 0, track_stock: true, category_id: cat.id }, owner);

console.log('— a site can use whatever it knows about the product');
let r = await resolve(String(tea.id));
check('by id', r.status === 200 && r.data.id === tea.id, r.data);
r = await resolve('8850126001234');
check('by barcode', r.status === 200 && r.data.id === tea.id, r.data);
r = await resolve('CHATRAMUE THAI TEA MIX 400G');
check('by exact name', r.status === 200 && r.data.id === tea.id);
r = await resolve('Chatramue Thai Tea Mix 400g');
check('by the name as the marketing site writes it — different case', r.status === 200 && r.data.id === tea.id, r.data);
r = await resolve('chatramue-thai-tea-mix-400g');
check('by a slug — punctuation and spacing ignored', r.status === 200 && r.data.id === tea.id, r.data);

console.log('— it refuses rather than guessing');
r = await resolve('something we do not sell');
check('unknown product → 404', r.status === 404, r.data);
r = await resolve('');
check('empty ref → 400', r.status === 400, r.data);
const twinA = (await req('POST', '/api/admin/products', { name: 'Twin Item', price: 1, category_id: cat.id }, owner)).data;
await req('POST', '/api/admin/products', { name: 'twin-item', price: 2, category_id: cat.id }, owner);
r = await resolve('Twin Item');
check('an ambiguous name → 409, and it says which ones', r.status === 409 && (r.data.matches || []).length === 2, r.data);
check('the ambiguous ids are still usable', (await resolve(String(twinA.id))).status === 200);

console.log('— what the deep-link screen needs to decide');
r = await resolve(String(tea.id));
check('it knows the stock and whether options must be chosen',
  r.data.track_stock !== undefined && Array.isArray(r.data.option_groups || []), { track: r.data.track_stock, opts: r.data.option_groups });
r = await resolve('Deep Gone');
check('an out-of-stock item still resolves, so the shopper is told why',
  r.status === 200 && Number(r.data.stock_qty) <= 0 && r.data.track_stock === true, r.data);

console.log('— a hidden product is not linkable');
await req('PUT', `/api/admin/products/${twinA.id}`, { ...twinA, is_active: false }, owner);
check('deactivated → 404 by id', (await resolve(String(twinA.id))).status === 404);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
