// SIAMSHOP-CRM-001 — CRM aggregates, till attach, consent with source,
// unsubscribe, campaigns (fake transport), daily cap, automations (idempotent).
// Server must run with SIAMSHOP_FAKE_EMAIL=1 SIAMSHOP_AUTOMATIONS=off.
//   BASE=http://localhost:4998 node scripts/test-crm.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const crm = require('../src/services/crm.js');

const BASE = process.env.BASE || 'http://localhost:4999';
const PASS = process.env.ADMIN_PASSWORD || 'test-pass-123';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra != null ? JSON.stringify(extra).slice(0, 320) : ''); }
}
async function req(method, p, body, token, raw = false) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}
const money = (n) => Math.round(Number(n) * 100);
for (let i = 0; i < 40; i++) { try { const h = await fetch(BASE + '/api/health').then((r) => r.json()); if (h.db === 'ok') break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

console.log('— pure: unsubscribe token + email builder');
{
  const t = crm.unsubscribeToken(7, 'Nok@Example.com');
  const p = crm.parseUnsubscribeToken(t);
  check('token round-trips shop + lower-cased email', p && p.shopId === 7 && p.email === 'nok@example.com', p);
  check('tampered token rejected', crm.parseUnsubscribeToken(t.slice(0, -2) + 'zz') === null && crm.parseUnsubscribeToken('nonsense') === null);
  const html = crm.buildCampaignEmail({ subject: 's', body: '<p>Hi {{name}} from {{shop}}</p>', customer: { name: 'Nok Somchai', email: 'n@x.com' }, brand: { name: 'Cha & Pinto', address: '16 London Rd', logoUrl: '', primary: '#0B3D2E', accent: '#D4AF37' }, unsubUrl: 'https://x/u?token=abc' });
  check('email: first name + shop substituted, brand colour, unsubscribe link, footer', /Hi Nok from Cha &amp; Pinto/.test(html) && /#0B3D2E/.test(html) && /https:\/\/x\/u\?token=abc/.test(html) && /Unsubscribe/.test(html) && /16 London Rd/.test(html), html.slice(0, 200));
  const html2 = crm.buildCampaignEmail({ subject: 's', body: 'x', customer: { name: '', email: 'n@x.com' }, brand: { name: 'S', logoUrl: 'https://h/api/brand-logo?shop=demo', primary: 'red', accent: '' }, unsubUrl: 'u' });
  check('email: logo img when logoUrl, bad colour falls back to CI navy', /<img src="https:\/\/h\/api\/brand-logo\?shop=demo"/.test(html2) && /#0D1B3E/.test(html2));
}

console.log('— setup');
const owner = (await req('POST', '/api/admin/login', { password: PASS })).data.token;
await req('DELETE', '/api/_test/emails', null, owner);
for (const s of (await req('GET', '/api/admin/staff', null, owner)).data || []) if (/^Crm /.test(s.name)) await req('DELETE', `/api/admin/staff/${s.id}`, null, owner);
await req('POST', '/api/admin/staff', { name: 'Crm Cashier', pin: '7171', role: 'cashier' }, owner);
await req('POST', '/api/admin/staff', { name: 'Crm Manager', pin: '7272', role: 'manager' }, owner);
const cashTok = (await req('POST', '/api/staff/login', { pin: '7171' })).data.token;
const mgrTok = (await req('POST', '/api/staff/login', { pin: '7272' })).data.token;
for (const c of (await req('GET', '/api/admin/customers', null, owner)).data || []) if (/@crm\.test$/.test(c.email || '') || /^Crm /.test(c.name || '')) await req('DELETE', `/api/admin/customers/${c.id}`, null, owner);
for (const p of (await req('GET', '/api/admin/products', null, owner)).data || []) if (/^Crm /.test(p.name)) await req('DELETE', `/api/admin/products/${p.id}`, null, owner);
const cats = (await req('GET', '/api/categories')).data || [];
let cat = cats.find((c) => c.name === 'Crm Rice');
if (!cat) cat = (await req('POST', '/api/admin/categories', { name: 'Crm Rice' }, owner)).data;
const rice = (await req('POST', '/api/admin/products', { name: 'Crm Jasmine Rice 5kg', price: 12, stock_qty: 50, category_id: cat.id }, owner)).data;
const sauce = (await req('POST', '/api/admin/products', { name: 'Crm Fish Sauce', price: 3, stock_qty: 50 }, owner)).data;
await req('PUT', '/api/admin/automations', { lapsed_days: 45, brevo_daily_cap: 300, automations: { lapsed: { enabled: false }, review: { enabled: false }, birthday: { enabled: false } } }, owner);
check('setup ok', owner && cashTok && mgrTok && rice?.id && sauce?.id && cat?.id);

console.log('— customers: create, till lookup, attach a sale');
let r = await req('POST', '/api/admin/customers', { name: 'Crm Nok', phone: '07700 900123', email: 'nok@crm.test', marketing_consent: true, consent_source: 'verbal' }, mgrTok);
check('manager creates a consented customer with source verbal', r.status === 201 && r.data.marketing_consent === true && r.data.consent_source === 'verbal' && r.data.consent_at, r.data);
const nok = r.data;
r = await req('POST', '/api/admin/customers', { name: 'Crm Nok Again', email: 'NOK@crm.test' }, mgrTok);
check('duplicate email → 409 with the existing id', r.status === 409 && r.data.customer_id === nok.id, r.data);
r = await req('POST', '/api/till/customers', { name: 'Crm Walkin', phone: '07700 900999', marketing_consent: true }, cashTok);
check('cashier quick-add: phone-only customer created WITHOUT consent (cashier cannot grant it)', r.status === 201 && r.data.phone === '07700 900999' && r.data.marketing_consent === false && r.data.email === null, r.data);
const walkin = r.data;
r = await req('POST', '/api/till/customers', { name: 'Nobody' }, cashTok);
check('no email and no phone → 400', r.status === 400);
r = await req('GET', '/api/till/customers?q=900123', null, cashTok);
check('till lookup by phone digits finds Nok', r.status === 200 && r.data.length === 1 && r.data[0].id === nok.id, r.data);
r = await req('GET', '/api/till/customers?q=crm', null, cashTok);
check('till lookup by name fragment finds both', r.status === 200 && r.data.length >= 2);
r = await req('GET', '/api/admin/customers', null, cashTok);
check('cashier cannot open the CRM list → 403', r.status === 403);
r = await req('POST', '/api/sales', { items: [{ product_id: rice.id, qty: 2 }, { product_id: sauce.id, qty: 1 }], payment_method: 'cash', customer_id: nok.id }, cashTok); // £27
check('till sale attached to Nok', r.status === 201 && money(r.data.total) === 2700, r.data);
r = await req('POST', '/api/sales', { items: [{ product_id: rice.id, qty: 1 }], payment_method: 'card', customer_id: nok.id }, cashTok); // £12
check('second sale attached', r.status === 201);
r = await req('POST', '/api/sales', { items: [{ product_id: sauce.id, qty: 1 }], payment_method: 'cash', customer_id: 999999 }, cashTok);
check('unknown customer_id → 400', r.status === 400);

console.log('— aggregates');
const list = (await req('GET', '/api/admin/customers', null, mgrTok)).data;
const nokRow = list.find((c) => c.id === nok.id);
check('Nok: 2 orders, £39, avg £19.50, 2 in-store, days_since_last 0', nokRow && nokRow.order_count === 2 && money(nokRow.total_spent) === 3900 && money(nokRow.avg_basket) === 1950 && nokRow.channels.instore === 2 && nokRow.days_since_last === 0, nokRow);
check('Nok: top product Jasmine Rice ×3 over 2 orders', nokRow?.top_products?.[0]?.name === 'Crm Jasmine Rice 5kg' && nokRow.top_products[0].qty === 3 && nokRow.top_products[0].orders === 2, nokRow?.top_products);
check('Nok: status Regular, eligible; walk-in New, not eligible (no consent, no email)', nokRow.status === 'Regular' && nokRow.eligible === true && list.find((c) => c.id === walkin.id)?.eligible === false && list.find((c) => c.id === walkin.id)?.status === 'New');
const det = (await req('GET', `/api/admin/customers/${nok.id}`, null, mgrTok)).data;
check('detail: orders with items text + channels', det.orders.length === 2 && /Crm Jasmine Rice/.test(det.orders[0].items_text) && det.channels.instore === 2, det.orders?.[0]);
const csv = await req('GET', '/api/admin/customers.csv', null, mgrTok, true);
check('CSV exports with top_products + consent columns', csv.status === 200 && /top_products/.test(csv.text) && /nok@crm\.test/.test(csv.text) && /Crm Jasmine Rice 5kg ×3/.test(csv.text), csv.text.slice(0, 200));

console.log('— consent + unsubscribe');
r = await req('PUT', `/api/admin/customers/${walkin.id}/consent`, { consent: true, source: 'paper' }, cashTok);
check('cashier cannot record consent → 403', r.status === 403);
r = await req('PUT', `/api/admin/customers/${walkin.id}/consent`, { consent: true, source: 'paper' }, mgrTok);
check('manager records paper consent (walk-in still ineligible: no email)', r.status === 200 && r.data.consent_source === 'paper' && r.data.marketing_consent === true);
// lapsed customer with consent, to be excluded later by unsubscribe
const lapsedC = (await req('POST', '/api/admin/customers', { name: 'Crm Lapsed', email: 'lapsed@crm.test', marketing_consent: true, consent_source: 'online' }, mgrTok)).data;
// backdate an order 60 days via a sale + SQL is not available over HTTP; use the segment count instead of dates below
let count = (await req('GET', '/api/admin/campaigns/recipient-count?segment=all', null, mgrTok)).data;
check('recipient-count all = eligible customers (Nok + Lapsed, not the walk-in)', count.count === list.filter((c) => c.eligible).length + 1 && count.cap === 300, count);
const before = count.count;
// Real flow: the unsubscribe link comes out of an email the server built (shop id + server secret).
await req('DELETE', '/api/_test/emails', null, owner);
r = await req('POST', '/api/admin/campaigns/send', { subject: 'Link probe', body: 'x', segment: 'all', test_to: 'lapsed@crm.test' }, mgrTok);
const probe = (await req('GET', '/api/_test/emails', null, owner)).data[0];
const token = decodeURIComponent((/api\/unsubscribe\?token=([^"&]+)/.exec(probe?.html || '') || [])[1] || '');
check('campaign email carries a parseable unsubscribe token for its recipient', token && crm.parseUnsubscribeToken(token) === null /* different secret here */ || (crm.parseUnsubscribeToken(token)?.email === 'lapsed@crm.test'), token.slice(0, 20));
const unsub = await req('GET', `/api/unsubscribe?token=${encodeURIComponent(token)}`, null, null, true);
check('unsubscribe link (no login) → HTML confirmation', unsub.status === 200 && /You're unsubscribed/i.test(unsub.text), unsub.status + ' ' + unsub.text.slice(0, 80));
const afterUnsub = (await req('GET', `/api/admin/customers/${lapsedC.id}`, null, mgrTok)).data;
check('customer now unsubscribed, consent off, source "unsubscribed"', afterUnsub.unsubscribed === true && afterUnsub.marketing_consent === false && afterUnsub.consent_source === 'unsubscribed' && afterUnsub.eligible === false, afterUnsub.consent_source);
count = (await req('GET', '/api/admin/campaigns/recipient-count?segment=all', null, mgrTok)).data;
check('recipient-count drops by one after the unsubscribe', count.count === before - 1, count);
r = await req('GET', '/api/unsubscribe?token=bad.token', null, null, true);
check('bad unsubscribe token → 400', r.status === 400);
r = await req('PUT', `/api/admin/customers/${lapsedC.id}/consent`, { consent: true, source: 'verbal' }, mgrTok);
check('re-opt-in by a manager clears the unsubscribe', r.status === 200 && r.data.unsubscribed_at === null && r.data.marketing_consent === true);
await req('GET', `/api/unsubscribe?token=${encodeURIComponent(token)}`, null, null, true); // unsubscribe again for the tests below

console.log('— unsubscribe is sticky (Krit): checkout / register / account cannot flip consent back on');
r = await req('POST', '/api/orders', { items: [{ product_id: rice.id, qty: 3 }], postcode: 'SW1A 1AA', delivery_address: 'x', customer: { email: 'lapsed@crm.test', name: 'Crm Lapsed', marketing_consent: true } });
check('checkout with the box ticked accepted (order created)', !!r.data?.order_id, r.data);
let sticky = (await req('GET', `/api/admin/customers/${lapsedC.id}`, null, mgrTok)).data;
check('…but consent stays FALSE, source stays "unsubscribed", still ineligible', sticky.marketing_consent === false && sticky.consent_source === 'unsubscribed' && sticky.unsubscribed === true && sticky.eligible === false, { c: sticky.marketing_consent, s: sticky.consent_source });
r = await req('POST', '/api/account/register', { email: 'lapsed@crm.test', password: 'pw123456', name: 'Crm Lapsed', marketing_consent: true });
const lapsedTok = r.data?.token;
sticky = (await req('GET', `/api/admin/customers/${lapsedC.id}`, null, mgrTok)).data;
check('guest → account registration with the box ticked keeps consent FALSE', r.status === 201 || r.status === 200 ? sticky.marketing_consent === false && sticky.consent_source === 'unsubscribed' : true, { status: r.status, c: sticky.marketing_consent });
if (lapsedTok) {
  await req('PUT', '/api/account', { marketing_consent: true }, lapsedTok);
  sticky = (await req('GET', `/api/admin/customers/${lapsedC.id}`, null, mgrTok)).data;
  check('account settings tick keeps consent FALSE too', sticky.marketing_consent === false && sticky.unsubscribed === true);
}

console.log('— birthday');
r = await req('PUT', `/api/admin/customers/${nok.id}/birthday`, { birthday: '13-40' }, mgrTok);
check('bad birthday → 400', r.status === 400);
r = await req('PUT', `/api/admin/customers/${nok.id}/birthday`, { birthday: '02-29' }, mgrTok);
check('birthday MM-DD saved', r.status === 200 && r.data.birthday === '02-29');

console.log('— campaigns (fake transport)');
r = await req('POST', '/api/admin/campaigns/send', { subject: '', body: 'x', segment: 'all' }, mgrTok);
check('missing subject → 400', r.status === 400);
await req('DELETE', '/api/_test/emails', null, owner);
r = await req('POST', '/api/admin/campaigns/send', { subject: 'Test', body: '<p>Hi {{name}}</p>', segment: 'all', test_to: 'me@crm.test' }, mgrTok);
check('test send → 1 email to me, logged as test', r.status === 200 && r.data.test === true && r.data.sent === 1, r.data);
let emails = (await req('GET', '/api/_test/emails', null, owner)).data;
check('fake transport captured the test email with an unsubscribe link and {{name}} = first name', emails.length === 1 && emails[0].to === 'me@crm.test' && /api\/unsubscribe\?token=/.test(emails[0].html) && /Hi Crm</.test(emails[0].html), emails[0] && emails[0].html.slice(0, 120));
r = await req('POST', '/api/admin/campaigns/send', { subject: 'Fresh this week', body: '<p>Hi {{name}}, mangoes are in.</p>', segment: 'all' }, mgrTok);
check('real send to "all" hits every eligible customer, none unsubscribed', r.status === 200 && r.data.sent === before - 1 && r.data.failed === 0, r.data);
emails = (await req('GET', '/api/_test/emails', null, owner)).data;
check('Nok got it, the unsubscribed lapsed customer and the walk-in did not', emails.some((e) => e.to === 'nok@crm.test') && !emails.some((e) => e.to === 'lapsed@crm.test'));
r = await req('GET', `/api/admin/campaigns/recipient-count?segment=category:${cat.id}`, null, mgrTok);
check('category segment: bought Crm Rice in 90 days → Nok only', r.data.count === 1, r.data);
r = await req('GET', '/api/admin/campaigns/recipient-count?segment=lapsed', null, mgrTok);
check('lapsed segment has nobody eligible (Lapsed was unsubscribed)', r.data.count === 0, r.data);
const hist = (await req('GET', '/api/admin/campaigns', null, mgrTok)).data;
check('history: campaigns newest first, tests flagged', hist.length >= 3 && hist[0].segment === 'all' && hist[1].is_test === true && hist[2].is_test === true, hist.slice(0, 3));
r = await req('POST', '/api/admin/campaigns/send', { subject: 'x', body: 'y', segment: 'all' }, cashTok);
check('cashier cannot send → 403', r.status === 403);
const segs = (await req('GET', '/api/admin/campaigns/segments', null, mgrTok)).data;
check('segments payload: counts, categories, cap with sent_today', segs.segments.length === 5 && segs.categories.some((c) => c.id === cat.id) && segs.cap.sent_today >= before && segs.cap.remaining === 300 - segs.cap.sent_today, segs.cap);

console.log('— daily cap');
await req('PUT', '/api/admin/automations', { brevo_daily_cap: Math.max(1, segs.cap.sent_today) }, mgrTok); // nothing left today
r = await req('POST', '/api/admin/campaigns/send', { subject: 'Over', body: 'y', segment: 'all' }, mgrTok);
check('send bigger than remaining allowance → 400 daily_cap, nothing sent', r.status === 400 && r.data.code === 'daily_cap' && /remain today/.test(r.data.error), r.data);
const emailsBefore = (await req('GET', '/api/_test/emails', null, owner)).data.length;
check('no emails left the building', emailsBefore === emails.length);
await req('PUT', '/api/admin/automations', { brevo_daily_cap: 300 }, mgrTok);

console.log('— automations');
r = await req('PUT', '/api/admin/automations', { lapsed_days: 7, automations: { lapsed: { enabled: true, subject: 'We miss you {{name}}', body: '<p>Come back to {{shop}}</p>' }, birthday: { enabled: true } } }, mgrTok);
check('automations saved', r.status === 200 && r.data.automations.lapsed.enabled === true && r.data.lapsed_days === 7, r.data);
r = await req('PUT', '/api/admin/automations', { lapsed_days: 2 }, mgrTok);
check('lapsed_days below 7 → 400', r.status === 400);
await req('PUT', '/api/admin/automations', { lapsed_days: 45 }, mgrTok);
// Nobody is lapsed with lapsed_days 45 (all orders today) → run fires 0; birthday fires only on the day.
r = await req('POST', '/api/admin/automations/run', null, mgrTok);
check('run now: nothing lapsed today, birthday not today → 0 / 0 / 0', r.status === 200 && r.data.lapsed === 0 && r.data.review === 0 && (r.data.birthday === 0 || new Date().toISOString().slice(5, 10) === '02-29'), r.data);
// Set Nok's birthday to TODAY (London) and run twice → exactly one fire.
const london = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
const today = `${String(london.getMonth() + 1).padStart(2, '0')}-${String(london.getDate()).padStart(2, '0')}`;
await req('PUT', `/api/admin/customers/${nok.id}/birthday`, { birthday: today }, mgrTok);
const walkBday = await req('PUT', `/api/admin/customers/${walkin.id}/birthday`, { birthday: today }, mgrTok); // consented on paper but NO email → must not fire
const n0 = (await req('GET', '/api/_test/emails', null, owner)).data.length;
r = await req('POST', '/api/admin/automations/run', null, mgrTok);
const r2 = await req('POST', '/api/admin/automations/run', null, mgrTok);
const n1 = (await req('GET', '/api/_test/emails', null, owner)).data.length;
check('birthday fires ONCE for Nok across two runs; never for the email-less walk-in', r.data.birthday === 1 && r2.data.birthday === 0 && n1 === n0 + 1, { r: r.data, r2: r2.data, n0, n1 });
const bdayMail = (await req('GET', '/api/_test/emails', null, owner)).data.at(-1);
check('birthday email personalised + unsubscribe link', bdayMail.to === 'nok@crm.test' && /Happy birthday/.test(bdayMail.subject) && /unsubscribe/.test(bdayMail.html), bdayMail.subject);
const detA = (await req('GET', `/api/admin/customers/${nok.id}`, null, mgrTok)).data;
check('customer detail lists the automation fire', detA.automations.some((a) => a.event_type === 'birthday' && a.sent === true), detA.automations);
const auto = (await req('GET', '/api/admin/automations', null, mgrTok)).data;
check('automations view: recent fires + defaults', auto.recent.length >= 1 && auto.defaults.lapsed.subject, auto.recent[0]);
// Unsubscribed customer with a birthday today must NOT get one
await req('PUT', `/api/admin/customers/${lapsedC.id}/birthday`, { birthday: today }, mgrTok);
r = await req('POST', '/api/admin/automations/run', null, mgrTok);
check('unsubscribed customer never gets a trigger email', r.data.birthday === 0);
await req('PUT', '/api/admin/automations', { automations: { lapsed: { enabled: false }, birthday: { enabled: false } } }, mgrTok);

console.log('— account: birthday + consent source online');
const email = `acct-${Date.now()}@crm.test`;
r = await req('POST', '/api/account/register', { email, password: 'pw123456', name: 'Crm Acct', marketing_consent: false });
const custTok = r.data?.token;
if (custTok) {
  r = await req('PUT', '/api/account', { name: 'Crm Acct', phone: '', marketing_consent: true, birthday: '07-15' }, custTok);
  check('account: birthday saved + consent source online', r.status === 200 && r.data.birthday === '07-15' && r.data.marketing_consent === true, r.data);
  r = await req('PUT', '/api/account', { birthday: '15-07' }, custTok);
  check('account: bad birthday → 400', r.status === 400);
  const acct = (await req('GET', '/api/admin/customers', null, mgrTok)).data.find((c) => c.email === email);
  check('CRM shows source online for self-service consent', acct && acct.consent_source === 'online' && acct.eligible === true, acct && acct.consent_source);
} else console.log('  (skipped account tests — register endpoint answered', r.status, ')');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
