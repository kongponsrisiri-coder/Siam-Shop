// End-to-end test for SIAMSHOP-503 (availability windows), 504 (Click & Collect)
// and 505 (prep screen) against a local server on :4999 + throwaway Postgres.
// Run after scripts/test-m5-options.mjs (or on a fresh DB): node scripts/test-m5-collect.mjs
const BASE = process.env.BASE || 'http://localhost:4999';
const PASS = process.env.ADMIN_PASSWORD || 'test-pass-123';
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
  else { fail++; console.log('  ❌', name, extra != null ? JSON.stringify(extra).slice(0, 400) : ''); }
}
const money = (n) => Math.round(Number(n) * 100);
const pad = (n) => String(n).padStart(2, '0');

// Shop-local wall clock (Europe/London) for building deterministic windows.
function londonNow() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}
const now = londonNow();
// A 1-hour window that does NOT include now (and isn't at the day edge).
const offHour = now.hour < 12 ? 14 : 3;
const OFF = { from: `${pad(offHour)}:00`, to: `${pad(offHour + 1)}:00` };
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const openAll = Object.fromEntries(DAY_KEYS.map((k) => [k, { from: '00:00', to: '23:59' }]));
// Hours that exclude now (same off window every day).
const closedNow = Object.fromEntries(DAY_KEYS.map((k) => [k, OFF]));

for (let i = 0; i < 40; i++) {
  try { const h = await fetch(BASE + '/api/health').then((r) => r.json()); if (h.db === 'ok') break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

console.log('— login + settings');
({ data: { token } } = await req('POST', '/api/admin/login', { password: PASS }, false));
check('token issued', !!token);
await req('PUT', '/api/admin/settings', {
  opening_hours: JSON.stringify(openAll), bank_holidays: '', collection_enabled: 'true',
  collection_address: '16 London Rd, Guildford GU1 2AF', pickup_lead_minutes: '20', pickup_slot_minutes: '15',
  minimum_order_amount: '0', delivery_fee_london: '3', delivery_fee_mainland: '5', delivery_fee_remote: '9',
});
let s = (await req('GET', '/api/settings', null, false)).data;
check('public settings: open_now true, collection_enabled, address', s.open_now === true && s.collection_enabled === true && /Guildford/.test(s.collection_address), s);

console.log('— categories with availability (SIAMSHOP-503)');
const lunchCat = await req('POST', '/api/admin/categories', { name: 'Lunch (test window)', availability: { rules: [{ days: ALL_DAYS, ...OFF }] } });
check('category created with window', lunchCat.status === 201 && lunchCat.data.availability, lunchCat.data);
const badCat = await req('POST', '/api/admin/categories', { name: 'Bad', availability: { rules: [{ days: [], from: '12:00', to: '11:00' }] } });
check('malformed availability → 400', badCat.status === 400, badCat);
const alwaysCat = (await req('POST', '/api/admin/categories', { name: 'Always (test)' })).data;
let cats = (await req('GET', '/api/categories', null, false)).data;
const lc = cats.find((c) => c.id === lunchCat.data.id);
check('public categories: available_now=false + text', lc && lc.available_now === false && /\d\d:\d\d–\d\d:\d\d/.test(lc.availability_text), lc);
check('public categories: no-rules category available', cats.find((c) => c.id === alwaysCat.id).available_now === true && cats.find((c) => c.id === alwaysCat.id).availability_text === null);

const lunch = (await req('POST', '/api/admin/products', { name: 'Test Lunch Box', price: 8.95, kind: 'food', track_stock: false, category_id: lunchCat.data.id })).data;
await req('PUT', `/api/admin/products/${lunch.id}/options`, { groups: [{ name: 'Size', min_select: 1, max_select: 1, options: [{ name: 'Medium', is_default: true }, { name: 'Large', price_delta: 1 }] }] });
const LARGE = (await req('GET', `/api/products/${lunch.id}`, null, false)).data.option_groups[0].options.find((o) => o.name === 'Large').id;
const boba = (await req('POST', '/api/admin/products', { name: 'Test Boba Tea', price: 4.5, kind: 'food', track_stock: false, category_id: alwaysCat.id })).data;
const rice = (await req('POST', '/api/admin/products', { name: 'Test Rice 1kg', price: 3.61, stock_qty: 10, category_id: alwaysCat.id })).data;
const prods = (await req('GET', '/api/products', null, false)).data;
check('products: lunch available_now=false, boba/rice true', prods.find((p) => p.id === lunch.id).available_now === false && prods.find((p) => p.id === boba.id).available_now === true && prods.find((p) => p.id === rice.id).available_now === true);

const cust = { email: 'collect@example.com', name: 'Collect Customer' };
let r = await req('POST', '/api/orders', { items: [{ product_id: lunch.id, qty: 1, option_ids: [LARGE] }], postcode: 'SW1A 1AA', delivery_address: 'x', customer: cust }, false);
check('delivery order with off-window lunch item → 409', r.status === 409 && /only available/.test(r.data.error), r.data);
r = await req('POST', '/api/orders', { items: [{ product_id: rice.id, qty: 1 }], postcode: 'SW1A 1AA', delivery_address: '10 Test St', customer: cust }, false);
check('delivery order with always item → 201, fee £3 (London)', r.status === 201 && money(r.data.total) === 661, r.data);

console.log('— Click & Collect (SIAMSHOP-504)');
const slots = (await req('GET', '/api/pickup-slots', null, false)).data;
check('pickup slots: enabled, asap, many slots', slots.enabled && slots.asap === true && slots.slots.length > 10, { n: slots.slots?.length, asap: slots.asap });
check('slot labels Today/Tomorrow HH:MM', /^(Today|Tomorrow) \d\d:\d\d$/.test(slots.slots[0].label), slots.slots[0]);
// A slot inside the lunch window (tomorrow or today, whichever the API offers).
const inWindow = slots.slots.find((x) => { const hm = x.label.split(' ')[1]; return hm >= OFF.from && hm < OFF.to; });
check('a slot exists inside the lunch window', !!inWindow, { OFF, sample: slots.slots.slice(0, 3) });

r = await req('POST', '/api/orders', { fulfilment: 'collection', pickup_at: 'asap', items: [{ product_id: lunch.id, qty: 1, option_ids: [LARGE] }], customer: cust }, false);
check('ASAP collection of off-window lunch → 409', r.status === 409, r.data);
r = await req('POST', '/api/orders', { fulfilment: 'collection', pickup_at: new Date(Date.now() + 10 * 60000).toISOString(), items: [{ product_id: boba.id, qty: 1 }], customer: cust }, false);
check('pickup 10 min ahead (lead 20) → 400', r.status === 400 && /20 minutes/.test(r.data.error), r.data);
r = await req('POST', '/api/orders', { fulfilment: 'collection', pickup_at: 'asap', items: [{ product_id: boba.id, qty: 2 }, { product_id: rice.id, qty: 1 }], customer: cust }, false);
check('ASAP collection of always items → 201, no delivery fee (9.00 + 3.61)', r.status === 201 && money(r.data.total) === 1261, r.data);
const asapId = r.data.order_id;
r = await req('POST', '/api/orders', { fulfilment: 'collection', pickup_at: inWindow.at, items: [{ product_id: lunch.id, qty: 1, option_ids: [LARGE] }, { product_id: rice.id, qty: 2 }], customer: cust, notes: 'no chilli' }, false);
check('scheduled collection inside lunch window → 201 (£9.95 + £7.22)', r.status === 201 && money(r.data.total) === 1717, r.data);
const schedId = r.data.order_id;

let det = (await req('GET', `/api/admin/orders/${schedId}`)).data;
check('admin detail: fulfilment collection, pickup_at set, no address', det.fulfilment === 'collection' && det.pickup_at && det.delivery_address == null && money(det.delivery_fee) === 0, { f: det.fulfilment, p: det.pickup_at, a: det.delivery_address });
let pub = (await req('GET', `/api/orders/${schedId}?email=collect@example.com`, null, false)).data;
check('public order: pickup_label + collection_address', /\w{3} \d\d:\d\d/.test(pub.pickup_label || '') && /Guildford/.test(pub.collection_address || ''), pub);

// Shop closed → delivery blocked, scheduled collection inside hours still fine.
await req('PUT', '/api/admin/settings', { opening_hours: JSON.stringify(closedNow) });
s = (await req('GET', '/api/settings', null, false)).data;
check('settings: open_now false + next_open text', s.open_now === false && typeof s.next_open === 'string', s);
r = await req('POST', '/api/orders', { items: [{ product_id: rice.id, qty: 1 }], postcode: 'SW1A 1AA', delivery_address: '10 Test St', customer: cust }, false);
check('closed: delivery order → 409 Not accepting', r.status === 409 && /Not accepting/.test(r.data.error), r.data);
const s2 = (await req('GET', '/api/pickup-slots', null, false)).data;
check('closed: ASAP off, slots only inside the open window', s2.asap === false && s2.slots.length > 0 && s2.slots.every((x) => { const hm = x.label.split(' ')[1]; return hm >= OFF.from && hm <= OFF.to; }), { asap: s2.asap, first: s2.slots[0], last: s2.slots[s2.slots.length - 1] });
r = await req('POST', '/api/orders', { fulfilment: 'collection', pickup_at: s2.slots[0].at, items: [{ product_id: lunch.id, qty: 1, option_ids: [LARGE] }], customer: cust }, false);
check('closed: scheduled collection in-window → 201', r.status === 201, r.data);
r = await req('POST', '/api/orders', { fulfilment: 'collection', pickup_at: 'asap', items: [{ product_id: rice.id, qty: 1 }], customer: cust }, false);
check('closed: ASAP collection → 409 with next opening', r.status === 409 && /open/.test(r.data.error), r.data);
await req('PUT', '/api/admin/settings', { opening_hours: JSON.stringify(openAll) });

console.log('— ready / collected lifecycle');
await req('POST', `/api/admin/orders/${schedId}/mark-paid`);
let o = (await req('POST', `/api/admin/orders/${schedId}/ready`)).data;
check('ready: status ready + ready_at', o.status === 'ready' && o.ready_at, o);
const firstReady = o.ready_at;
await new Promise((res) => setTimeout(res, 1100));
o = (await req('POST', `/api/admin/orders/${schedId}/ready`)).data;
check('ready again: idempotent (ready_at unchanged)', o.ready_at === firstReady, { firstReady, again: o.ready_at });
pub = (await req('GET', `/api/orders/${schedId}?email=collect@example.com`, null, false)).data;
check('public order shows status ready', pub.status === 'ready');
o = (await req('POST', `/api/admin/orders/${schedId}/collected`)).data;
check('collected: status completed + fulfilled_at', o.status === 'completed' && o.fulfilled_at, o);
let list = (await req('GET', '/api/admin/orders')).data;
check('admin list carries fulfilment/pickup_at/prep_status', list.some((x) => x.id === schedId && x.fulfilment === 'collection' && x.pickup_at && x.prep_status === 'done'));

console.log('— till: eat in / take away + no availability block');
r = await req('POST', '/api/sales', { items: [{ product_id: lunch.id, qty: 1, option_ids: [LARGE] }, { product_id: rice.id, qty: 1 }], payment_method: 'cash', fulfilment: 'dine_in' });
check('till sells off-window lunch (warning only), dine_in recorded', r.status === 201, r.data);
const tillId = r.data.id;
list = (await req('GET', '/api/admin/orders')).data;
check('till order fulfilment = dine_in', list.find((x) => x.id === tillId)?.fulfilment === 'dine_in');
r = await req('POST', '/api/sales', { items: [{ product_id: rice.id, qty: 1 }], payment_method: 'card' });
check('grocery-only till sale → takeaway default', r.status === 201 && (await req('GET', '/api/admin/orders')).data.find((x) => x.id === r.data.id)?.fulfilment === 'takeaway');
const groceryOnlyId = r.data.id;

console.log('— prep screen (SIAMSHOP-505)');
await req('POST', `/api/admin/orders/${asapId}/mark-paid`);
let prep = (await req('GET', '/api/prep')).data;
const ids = prep.orders.map((x) => x.id);
check('prep lists till dine-in + paid ASAP collection', ids.includes(tillId) && ids.includes(asapId), ids);
check('prep excludes grocery-only sale and done order', !ids.includes(groceryOnlyId) && !ids.includes(schedId), ids);
const tp = prep.orders.find((x) => x.id === tillId);
check('till ticket: food line with options, grocery counted not listed', tp.food.length === 1 && tp.food[0].options[0].name === 'Large' && tp.grocery_count === 1 && tp.fulfilment === 'dine_in', tp);
const ap = prep.orders.find((x) => x.id === asapId);
check('collection ticket: pickup_label, first name only', /\d\d:\d\d/.test(ap.pickup_label || '') && ap.customer_name === 'Collect' && ap.food[0].qty === 2, ap);
check('sorted by pickup time (till "now" first)', ids.indexOf(tillId) < ids.indexOf(asapId) || prep.orders[0].pickup_at == null);
r = await req('POST', `/api/prep/${tillId}/status`, { prep_status: 'preparing' });
check('preparing', r.data.prep_status === 'preparing');
r = await req('POST', `/api/prep/${asapId}/status`, { prep_status: 'ready' });
check('prep ready on collection → order status ready', r.data.prep_status === 'ready' && r.data.status === 'ready', r.data);
r = await req('POST', `/api/prep/${tillId}/status`, { prep_status: 'ready' });
check('prep ready on dine-in keeps status completed', r.data.prep_status === 'ready' && r.data.status === 'completed', r.data);
r = await req('POST', `/api/prep/${tillId}/status`, { prep_status: 'bogus' });
check('bogus prep status → 400', r.status === 400);
r = await req('POST', `/api/prep/${tillId}/status`, { prep_status: 'done' });
prep = (await req('GET', '/api/prep')).data;
check('done removes ticket from the queue', !prep.orders.some((x) => x.id === tillId) && prep.orders.some((x) => x.id === asapId));
r = await req('GET', '/api/prep', null, false);
check('prep requires auth', r.status === 401, r.status);

console.log('— minimum order is a delivery rule, not a collection one');
// Regression: a £30 floor used to block click & collect too, so a customer
// picking up one £9 lunch box could not order at all (found 7 Sep).
await req('PUT', '/api/admin/settings', { minimum_order_amount: '30' });
r = await req('POST', '/api/orders', { items: [{ product_id: rice.id, qty: 1 }], postcode: 'SW1A 1AA', delivery_address: '10 Test St', customer: cust }, false);
check('delivery under the minimum → 400 naming delivery', r.status === 400 && /[Mm]inimum order for delivery/.test(r.data.error), r.data);
r = await req('POST', '/api/orders', { fulfilment: 'collection', pickup_at: 'asap', items: [{ product_id: rice.id, qty: 1 }], customer: cust }, false);
check('collection under the minimum → 201 (no floor on collection)', r.status === 201 && money(r.data.total) === 361, r.data);
r = await req('POST', '/api/orders', { items: [{ product_id: rice.id, qty: 10 }], postcode: 'SW1A 1AA', delivery_address: '10 Test St', customer: cust }, false);
check('delivery over the minimum → 201', r.status === 201, r.data);
await req('PUT', '/api/admin/settings', { minimum_order_amount: '0' });

console.log('— categories: clearing availability');
r = await req('PUT', `/api/admin/categories/${lunchCat.data.id}`, { availability: null });
check('PUT availability null → always', r.status === 200 && r.data.availability == null, r.data);
r = await req('PUT', `/api/admin/categories/${lunchCat.data.id}`, { name: 'Lunch renamed' });
check('PUT without availability key leaves it untouched', r.status === 200 && r.data.availability == null && r.data.name === 'Lunch renamed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
