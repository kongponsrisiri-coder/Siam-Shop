// SIAMSHOP-POST-001 — parcel label endpoint + roles, and the 4×6 PDF rig.
//   BASE=http://localhost:4999 node scripts/test-post-labels.mjs           (API checks)
//   … --pdf   also renders the sample label to a PDF via Electron's hidden-window path
//             (writes docs/tickets/assets/SIAMSHOP-POST-001-sample-label.{html,pdf})
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLabelHtml, SAMPLE_LABEL } from '../client/src/label.js';

const BASE = process.env.BASE || 'http://localhost:4999';
const PASS = process.env.ADMIN_PASSWORD || 'test-pass-123';
const here = path.dirname(fileURLToPath(import.meta.url));
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

console.log('— label HTML');
const html = await buildLabelHtml(SAMPLE_LABEL);
const sizes = [...html.matchAll(/font-size:\s*([\d.]+)pt/g)].map((m) => Number(m[1]));
const pcSize = Number(/\.postcode \{[^}]*font-size:\s*([\d.]+)pt/.exec(html)[1]);
check('postcode is the largest type on the label', pcSize === Math.max(...sizes), { pcSize, max: Math.max(...sizes) });
check('@page is 4in × 6in, no margin', /@page \{ size: 4in 6in; margin: 0; \}/.test(html));
check('QR rendered as inline SVG for the tracking URL', /<svg[^>]*viewBox/.test(html) && html.includes('Scan to track'));
check('SHIPPING face shows item count only — no product names', /5 item\(s\)|10 item\(s\)/.test(html) && !/Oishi Green Tea|Jasmine Rice/.test(html));
const packing = await buildLabelHtml(SAMPLE_LABEL, { packingCopy: true });
check('PACKING COPY lists items (6× Oishi)', /6×<\/span><span>Oishi Green Tea/.test(packing) && /PACKING COPY/.test(packing));
check('delivery note stays on the shipping face', /Delivery note: Leave with neighbour/.test(html));
check('no email anywhere in the label (QR/tracking)', !/[\w.+-]+@[\w-]+\.\w+/.test(html) && !/[\w.+-]+@[\w-]+\.\w+/.test(packing));
check('return address + packed-by in the footer', /Return to: 16 London Rd/.test(html) && /Packed by Nok/.test(html));
const many = await buildLabelHtml({ ...SAMPLE_LABEL, items: Array.from({ length: 12 }, (_, i) => ({ name: `Item ${i + 1}`, qty: 1, options: [] })) }, { packingCopy: true });
check('item list truncates at 8 with "+N more"', (many.match(/class="row"/g) || []).length === 9 && /\+4 more/.test(many));
const escaped = await buildLabelHtml({ ...SAMPLE_LABEL, ship_to: { ...SAMPLE_LABEL.ship_to, name: '<b>x</b> & co' } });
check('customer text is HTML-escaped', escaped.includes('&lt;b&gt;x&lt;/b&gt; &amp; co'));

console.log('— API');
const owner = (await req('POST', '/api/admin/login', { password: PASS })).data.token;
check('owner token', !!owner);
await req('PUT', '/api/admin/settings', { return_address: '16 London Rd, Guildford GU1 2AF', minimum_order_amount: '0', delivery_fee_london: '3', delivery_fee_mainland: '5', delivery_fee_remote: '9', opening_hours: '' }, owner);
// staff for role checks (reuse existing if present)
for (const s of (await req('GET', '/api/admin/staff', null, owner)).data || []) if (/^Label /.test(s.name)) await req('DELETE', `/api/admin/staff/${s.id}`, null, owner);
const cash = (await req('POST', '/api/admin/staff', { name: 'Label Cashier', pin: '6060', role: 'cashier' }, owner)).data;
const prepS = (await req('POST', '/api/admin/staff', { name: 'Label Prep', pin: '7070', role: 'prep' }, owner)).data;
check('test staff created', cash?.id && prepS?.id, { cash, prepS });
const cashTok = (await req('POST', '/api/staff/login', { pin: '6060' })).data.token;
const prepTok = (await req('POST', '/api/staff/login', { pin: '7070' })).data.token;

const products = (await req('GET', '/api/products')).data;
const plain = products.find((p) => !p.option_groups?.length && p.track_stock && p.stock_qty > 2 && p.available_now !== false);
if (!plain) { console.error('❌ need an in-stock plain product — seed first'); process.exit(1); }
let r = await req('POST', '/api/orders', { items: [{ product_id: plain.id, qty: 2 }], postcode: 'GU1 3AA', delivery_address: 'Flat 2, 42 Stoke Road, Guildford, Surrey, GU1 3AA', customer: { email: 'label@example.com', name: 'Somchai Prasert', phone: '07700 900123' }, notes: 'Leave with neighbour' });
check('postal order created', r.status === 201, r.data);
const oid = r.data.order_id;
await req('POST', `/api/admin/orders/${oid}/mark-paid`, null, owner);

r = await req('GET', `/api/admin/orders/${oid}/label`, null, cashTok);
check('cashier can fetch label data', r.status === 200, r.data);
const L = r.data || {};
check('postcode split out of the address', L.ship_to?.postcode === 'GU1 3AA' && !L.ship_to.lines.join(' ').includes('GU1 3AA'), L.ship_to);
check('address lines kept', L.ship_to?.lines?.[0] === 'Flat 2' && L.ship_to.lines.includes('Guildford'), L.ship_to?.lines);
check('items, staff, shop, tracking url, notes present', L.items?.[0]?.qty === 2 && L.staff === 'Label Cashier' && /Guildford/.test(L.shop?.return_address) && /order\/status\?order=/.test(L.tracking_url) && L.notes === 'Leave with neighbour', L);
check('tracking URL carries the order # only — no email', /order=\d+$/.test(L.tracking_url || '') && !/@|email=/.test(L.tracking_url || ''), L.tracking_url);
check('label_printed_at null before printing', L.label_printed_at == null);
r = await req('GET', `/api/admin/orders/${oid}/label`, null, prepTok);
check('prep role cannot fetch labels → 403', r.status === 403, r.data);
r = await req('POST', `/api/admin/orders/${oid}/label-printed`, null, cashTok);
check('cashier stamps label_printed_at', r.status === 200 && r.data.label_printed_at, r.data);
const list = (await req('GET', '/api/admin/orders', null, cashTok)).data;
check('orders list carries label_printed_at ✓', !!list.find((o) => o.id === oid)?.label_printed_at);
r = await req('GET', `/api/admin/orders/${oid}/label`, null, cashTok);
check('reprint allowed (label data still served, printed_at set)', r.status === 200 && r.data.label_printed_at);

// collection order → no label
const slots = (await req('GET', '/api/pickup-slots')).data;
await req('PUT', '/api/admin/settings', { collection_enabled: 'true' }, owner);
r = await req('POST', '/api/orders', { fulfilment: 'collection', pickup_at: 'asap', items: [{ product_id: plain.id, qty: 1 }], customer: { email: 'label@example.com', name: 'Somchai Prasert' } });
if (r.status === 201) {
  const cid = r.data.order_id;
  r = await req('GET', `/api/admin/orders/${cid}/label`, null, owner);
  check('collection order → 400 (labels are for postal orders)', r.status === 400, r.data);
} else console.log('  ⏭  collection order not created (shop closed?) — skipped that check', r.data?.error);
// cancelled postal order → 400
r = await req('POST', '/api/orders', { items: [{ product_id: plain.id, qty: 1 }], postcode: 'SW1A 1AA', delivery_address: '10 Test St, London SW1A 1AA', customer: { email: 'label@example.com', name: 'X' } });
const cancelId = r.data?.order_id;
await req('POST', `/api/admin/orders/${cancelId}/cancel`, null, owner);
r = await req('GET', `/api/admin/orders/${cancelId}/label`, null, owner);
check('cancelled order → 400', r.status === 400, r.data);
r = await req('POST', `/api/admin/orders/${oid}/dispatch`, { tracking_number: '' }, cashTok);
check('cashier can mark dispatched', r.status === 200 && r.data.status === 'dispatched', r.data);

if (process.argv.includes('--pdf')) {
  console.log('— 4×6 PDF via Electron hidden-window path');
  const outDir = path.join(here, '..', 'docs', 'tickets', 'assets');
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'SIAMSHOP-POST-001-sample-label.html');
  const pdfPath = path.join(outDir, 'SIAMSHOP-POST-001-sample-label.pdf');
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(path.join(outDir, 'SIAMSHOP-POST-001-sample-packing-copy.html'), packing);
  const electronDir = path.join(here, '..', 'electron');
  const r2 = spawnSync('npx', ['electron', '.'], { cwd: electronDir, env: { ...process.env, SIAMSHOP_LABEL_HTML: htmlPath, SIAMSHOP_LABEL_PDF: pdfPath }, encoding: 'utf8', timeout: 60000 });
  const out = (r2.stdout || '') + (r2.stderr || '');
  check('rig wrote the PDF', fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 5000, out.split('\n').filter((l) => /label-rig/.test(l)).join(' | '));
  if (fs.existsSync(pdfPath)) {
    const pdf = fs.readFileSync(pdfPath, 'latin1');
    const boxes = [...pdf.matchAll(/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
    check('PDF page is 4in × 6in (288 × 432 pt)', boxes.length >= 1 && boxes.every(([w, h]) => Math.abs(w - 288) < 1 && Math.abs(h - 432) < 1), boxes);
    check('single page', (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length === 1, (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length);
    console.log('  →', path.relative(process.cwd(), pdfPath));
  }
  const packPdf = path.join(outDir, 'SIAMSHOP-POST-001-sample-packing-copy.pdf');
  const r3 = spawnSync('npx', ['electron', '.'], { cwd: electronDir, env: { ...process.env, SIAMSHOP_LABEL_HTML: path.join(outDir, 'SIAMSHOP-POST-001-sample-packing-copy.html'), SIAMSHOP_LABEL_PDF: packPdf }, encoding: 'utf8', timeout: 60000 });
  check('packing copy PDF written', fs.existsSync(packPdf) && fs.statSync(packPdf).size > 5000, (r3.stdout || '').split('\n').filter((l) => /label-rig/.test(l)).join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
