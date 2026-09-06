// End-to-end test for SIAMSHOP-501 (options) + 502 (track_stock fix) against a
// local server on :4999 and a throwaway Postgres. Run: node test-m5-options.mjs
const BASE = 'http://localhost:4999';
let token = '';
let pass = 0, fail = 0;

async function req(method, path, body, authed = true) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(authed && token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra != null ? JSON.stringify(extra).slice(0, 300) : ''); }
}
const money = (n) => Math.round(Number(n) * 100);

// wait for health
for (let i = 0; i < 40; i++) {
  try { const h = await fetch(BASE + '/api/health').then((r) => r.json()); if (h.db === 'ok') break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

console.log('— login');
({ data: { token } } = await req('POST', '/api/admin/login', { password: 'test-pass-123' }, false));
check('token issued', !!token);

console.log('— products');
const cat = (await req('POST', '/api/admin/categories', { name: 'Thai Lunch Box', name_th: 'ข้าวกล่อง' })).data;
const lunch = (await req('POST', '/api/admin/products', {
  name: 'Rice Lunch Box', name_th: 'ข้าวราดแกง', price: 8.95, kind: 'food', track_stock: false, stock_qty: 0, category_id: cat.id,
})).data;
check('food product created (kind=food, track_stock=false)', lunch.kind === 'food' && lunch.track_stock === false, lunch);

const opts = await req('PUT', `/api/admin/products/${lunch.id}/options`, { groups: [
  { name: 'Size', name_th: 'ขนาด', min_select: 1, max_select: 1, options: [
    { name: 'Medium', price_delta: 0, is_default: true }, { name: 'Large', price_delta: 1.00 } ] },
  { name: 'Toppings', min_select: 2, max_select: 2, options: [
    { name: 'Spicy Chilli Basil Pork' }, { name: 'Crispy Sweet Chilli Pork + Cashews' },
    { name: 'Fried Chicken + Panang Curry' }, { name: 'Stir-fried Mixed Veg' } ] },
  { name: 'Add-ons', min_select: 0, max_select: 3, options: [
    { name: 'Crispy Fried Egg', price_delta: 1.75 }, { name: 'Panang Sauce + Edamame', price_delta: 2.25 }, { name: 'Sriracha', price_delta: 1.95 } ] },
]});
check('options saved (3 groups)', opts.status === 200 && opts.data.option_groups.length === 3, opts.data);
const G = Object.fromEntries(opts.data.option_groups.map((g) => [g.name, g]));
const id = (g, n) => G[g].options.find((o) => o.name === n).id;
const LARGE = id('Size', 'Large'), MEDIUM = id('Size', 'Medium');
const T1 = id('Toppings', 'Spicy Chilli Basil Pork'), T2 = id('Toppings', 'Fried Chicken + Panang Curry'), T3 = id('Toppings', 'Stir-fried Mixed Veg');
const EGG = id('Add-ons', 'Crispy Fried Egg');

const badOpts = await req('PUT', `/api/admin/products/${lunch.id}/options`, { groups: [{ name: 'X', min_select: 2, max_select: 1, options: [{ name: 'a' }] }] });
check('options validation: min>max rejected 400', badOpts.status === 400, badOpts);

const sauce = (await req('POST', '/api/admin/products', { name: 'Tiparos Fish Sauce 300ml', price: 1.50, stock_qty: 5, barcode: '8850000000011' })).data;
check('retail product created (kind defaults retail)', sauce.kind === 'retail' && sauce.track_stock === true, sauce);

const pub = (await req('GET', '/api/products', null, false)).data;
const pubLunch = pub.find((p) => p.id === lunch.id);
check('public listing carries option_groups + kind', pubLunch?.kind === 'food' && pubLunch.option_groups.length === 3 && pubLunch.option_groups[0].options[0].is_default === true, pubLunch);
check('public listing: retail product has empty option_groups', Array.isArray(pub.find((p) => p.id === sauce.id).option_groups) && pub.find((p) => p.id === sauce.id).option_groups.length === 0);
const one = (await req('GET', `/api/products/${lunch.id}`, null, false)).data;
check('product detail carries option_groups + track_stock', one.option_groups?.length === 3 && one.track_stock === false, one);
const lk = (await req('GET', `/api/products/lookup?barcode=8850000000011`)).data;
check('barcode lookup carries track_stock/kind/option_groups', lk.track_stock === true && lk.kind === 'retail' && Array.isArray(lk.option_groups), lk);
const adm = (await req('GET', '/api/admin/products')).data;
check('admin listing carries option_groups', adm.find((p) => p.id === lunch.id).option_groups.length === 3);

console.log('— till sale (SIAMSHOP-502: food at stock 0 + options priced server-side)');
const sale = await req('POST', '/api/sales', { items: [
  { product_id: lunch.id, qty: 1, option_ids: [LARGE, T1, T2, EGG] },
  { product_id: sauce.id, qty: 1 },
], payment_method: 'cash', amount_tendered: 20 });
check('sale accepted (201)', sale.status === 201, sale.data);
check('Large + 2 toppings + egg = £11.70', money(sale.data.items?.[0]?.line_total) === 1170, sale.data.items);
check('total = £13.20, change = £6.80', money(sale.data.total) === 1320 && money(sale.data.change_given) === 680, sale.data);
check('receipt line carries options', sale.data.items?.[0]?.options?.length === 4 && sale.data.items[0].options_total === 2.75, sale.data.items?.[0]);
let adm2 = (await req('GET', '/api/admin/products')).data;
check('fish sauce stock 5 → 4', adm2.find((p) => p.id === sauce.id).stock_qty === 4);
check('lunch box stock untouched (0)', adm2.find((p) => p.id === lunch.id).stock_qty === 0);
const moves = (await req('GET', `/api/stock/movements`)).data;
const mv = Array.isArray(moves) ? moves : moves.movements || moves.rows || [];
check('stock movement written for fish sauce only', mv.some((m) => m.product_name === sauce.name && m.change_qty === -1) && !mv.some((m) => (m.product_name || '').startsWith('Rice Lunch Box')), mv.slice(0, 4));

console.log('— rejections');
let r = await req('POST', '/api/sales', { items: [{ product_id: lunch.id, qty: 1, option_ids: [LARGE, T1, T2, T3] }], payment_method: 'cash' });
check('3 toppings on a max-2 group → 400', r.status === 400, r.data);
r = await req('POST', '/api/sales', { items: [{ product_id: lunch.id, qty: 1, option_ids: [T1, T2] }], payment_method: 'cash' });
check('no size (min 1) → 400', r.status === 400, r.data);
r = await req('POST', '/api/sales', { items: [{ product_id: lunch.id, qty: 1, option_ids: [MEDIUM, T1, T2, 999999] }], payment_method: 'cash' });
check('foreign option id → 400', r.status === 400, r.data);
r = await req('POST', '/api/sales', { items: [{ product_id: sauce.id, qty: 1, option_ids: [LARGE] }], payment_method: 'cash' });
check('options on a plain product → 400', r.status === 400, r.data);
r = await req('POST', '/api/sales', { items: [{ product_id: sauce.id, qty: 10 }], payment_method: 'cash' });
check('retail oversell still blocked → 409', r.status === 409, r.data);
adm2 = (await req('GET', '/api/admin/products')).data;
check('no stock changed by rejected sales', adm2.find((p) => p.id === sauce.id).stock_qty === 4);

console.log('— regression: plain sale without option_ids');
r = await req('POST', '/api/sales', { items: [{ product_id: sauce.id, qty: 2 }], payment_method: 'card' });
check('plain card sale ok, £3.00', r.status === 201 && money(r.data.total) === 300, r.data);

console.log('— online order (bank transfer) → mark paid → cancel');
const ord = await req('POST', '/api/orders', {
  items: [{ product_id: lunch.id, qty: 4, option_ids: [MEDIUM, T1, T3] }, { product_id: sauce.id, qty: 1 }],
  postcode: 'SW1A 1AA', delivery_address: '10 Test St, London',
  customer: { email: 'test@example.com', name: 'Test Customer' },
}, false);
check('pending order created (201)', ord.status === 201, ord.data);
const oid = ord.data.order_id;
let det = (await req('GET', `/api/admin/orders/${oid}`)).data;
const li = det.items.find((i) => i.name_snapshot === 'Rice Lunch Box');
check('order_items snapshot: 3 options, options_total 0, line 4×8.95=35.80', li && li.options_snapshot.length === 3 && money(li.options_total) === 0 && money(li.line_total) === 3580, li);
check('subtotal = 35.80 + 1.50 = 37.30', money(det.subtotal) === 3730, det.subtotal);
const pubOrd = (await req('GET', `/api/orders/${oid}?email=test@example.com`, null, false)).data;
check('public order view carries options_snapshot', pubOrd.items?.some((i) => Array.isArray(i.options_snapshot) && i.options_snapshot.length === 3), pubOrd.items);
await req('POST', `/api/admin/orders/${oid}/mark-paid`);
adm2 = (await req('GET', '/api/admin/products')).data;
check('mark-paid: fish sauce 2 → 1, lunch box untouched', adm2.find((p) => p.id === sauce.id).stock_qty === 1 && adm2.find((p) => p.id === lunch.id).stock_qty === 0, adm2.map((p) => [p.name, p.stock_qty]));
await req('POST', `/api/admin/orders/${oid}/cancel`);
adm2 = (await req('GET', '/api/admin/products')).data;
check('cancel: fish sauce restored to 2, lunch box still 0', adm2.find((p) => p.id === sauce.id).stock_qty === 2 && adm2.find((p) => p.id === lunch.id).stock_qty === 0);
const mv2 = (await req('GET', `/api/stock/movements`)).data;
const mvl = Array.isArray(mv2) ? mv2 : mv2.movements || mv2.rows || [];
check('no movement rows ever written for the food item', !mvl.some((m) => (m.product_name || '').startsWith('Rice Lunch Box')));

console.log('— product edit keeps options; delete cascades');
await req('PUT', `/api/admin/products/${lunch.id}`, { name: 'Rice Lunch Box (renamed)', price: 9.25 });
det = (await req('GET', `/api/admin/orders/${oid}`)).data;
check('historic order keeps original name + options after rename', det.items.some((i) => i.name_snapshot === 'Rice Lunch Box' && i.options_snapshot.length === 3));
const cleared = await req('PUT', `/api/admin/products/${lunch.id}/options`, { groups: [] });
check('clearing options → empty groups', cleared.status === 200 && cleared.data.option_groups.length === 0, cleared.data);
r = await req('POST', '/api/sales', { items: [{ product_id: lunch.id, qty: 1 }], payment_method: 'cash' });
check('food item now sells plain at £9.25 (stock 0, untracked)', r.status === 201 && money(r.data.total) === 925, r.data);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
