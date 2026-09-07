// SIAMSHOP-PRINT-RENDER-001 — receipts, prep tickets, Z reports and the test
// page drawn with a real typeface and sent as one bitmap.
//   BASE=http://localhost:4996 node scripts/test-print-render.mjs
// Writes the decoded receipt to out/receipt-rendered.png so the picture can be
// eyeballed (and posted in the PR).
import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ps = require('../electron/printService.js');
const tr = require('../electron/ticketRender.js');
const PImage = require('../electron/node_modules/pureimage');

const BASE = process.env.BASE || 'http://localhost:4999';
const PASS = process.env.ADMIN_PASSWORD || 'test-pass-123';
const OUT = path.join(process.cwd(), 'out');
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra != null ? JSON.stringify(extra).slice(0, 300) : ''); }
}
async function req(method, p, body, token) {
  const res = await fetch(BASE + p + (p.includes('?') ? '&' : '?') + 'shop=demo', {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const listen = (port) => new Promise((res) => { const jobs = []; const srv = net.createServer((s) => { const c = []; s.on('data', (d) => c.push(d)); s.on('close', () => jobs.push(Buffer.concat(c))); }); srv.listen(port, '127.0.0.1', () => res({ jobs, close: () => new Promise((r) => srv.close(r)) })); });

// GS v 0 → { width, height, ink } and a PNG, so the test can look at what prints.
function decodeRaster(buf) {
  const i = buf.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
  if (i < 0) return null;
  const wBytes = buf[i + 4] | (buf[i + 5] << 8);
  const height = buf[i + 6] | (buf[i + 7] << 8);
  const data = buf.subarray(i + 8, i + 8 + wBytes * height);
  let ink = 0;
  for (const b of data) for (let k = 0; k < 8; k++) if (b & (0x80 >> k)) ink++;
  return { width: wBytes * 8, height, ink, data, wBytes, headerAt: i };
}
async function rasterToPNG(r, file) {
  const img = PImage.make(r.width, r.height);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const on = r.data[y * r.wBytes + (x >> 3)] & (0x80 >> (x & 7));
      const o = (y * r.width + x) * 4;
      const v = on ? 0 : 255;
      img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
    }
  }
  mkdirSync(OUT, { recursive: true });
  const chunks = [];
  const sink = new (require('stream').Writable)({ write(c, e, cb) { chunks.push(c); cb(); } });
  await new Promise((resolve, reject) => { sink.on('finish', resolve); sink.on('error', reject); PImage.encodePNGToStream(img, sink).catch(reject); });
  writeFileSync(file, Buffer.concat(chunks));
  return file;
}

const RECEIPT = {
  shopName: 'Cha & Pinto Box', header: '16 London Rd, Guildford GU1 2AF\n01483 599499',
  footer: 'Thank you for shopping with us!', vatNote: 'VAT No. GB 123 4567 89',
  orderId: 1234, staff: 'Nok', createdAt: '2026-09-07T12:31:00.000Z', fulfilment: 'takeaway',
  items: [
    { name: 'Rice Lunch Box', qty: 1, line_total: 11.7, gross: 11.7, unit_price: 11.7, options: ['Large', 'Spicy Chilli Basil Pork'] },
    { name: 'ผัดไทยกุ้งสด Pad Thai Prawn', qty: 2, line_total: 17.9, unit_price: 8.95, options: [] },
    { name: 'Tiparos Fish Sauce 300ml', qty: 2, line_total: 3, unit_price: 1.5, options: [], discount: { reason: 'Damaged', amount: 0.5 }, gross: 3.5 },
  ],
  subtotal: 32.6, total: 32.6, payment_method: 'cash', amount_tendered: 40, change_given: 7.4, discount_amount: 0.5,
};

console.log('— fonts + rendering');
{
  const t0 = Date.now();
  const buf = await ps.receiptBytes(RECEIPT);
  const ms = Date.now() - t0;
  const r = decodeRaster(buf);
  check('receipt is ONE GS v 0 raster, 576 dots wide', !!r && r.width === 576 && r.headerAt > 0, r && { w: r.width, h: r.height });
  check('only one raster in the job', buf.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]), (r ? r.headerAt : 0) + 4) === -1);
  check('ends with the paper cut', buf.includes(Buffer.from([0x1d, 0x56, 0x41])));
  check('no drawer pulse on a receipt job', !buf.includes(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa])));
  check(`renders in under 300 ms (${ms} ms)`, ms < 300, ms);
  const file = await rasterToPNG(r, path.join(OUT, 'receipt-rendered.png'));
  console.log(`     wrote ${file} (${r.width}x${r.height}, ${(r.ink / (r.width * r.height) * 100).toFixed(1)}% ink)`);
  check('the receipt has real content, not a blank sheet', r.ink > 2000, r.ink);
}

console.log('— Thai actually draws (this is what the printer font could not do)');
{
  const thai = decodeRaster(await ps.receiptBytes({ ...RECEIPT, items: [{ name: 'ผัดไทยกุ้งสด', qty: 1, line_total: 8.95, unit_price: 8.95, options: [] }] }));
  const blank = decodeRaster(await ps.receiptBytes({ ...RECEIPT, items: [{ name: ' ', qty: 1, line_total: 8.95, unit_price: 8.95, options: [] }] }));
  check('a Thai product name puts ink on the paper', thai.ink > blank.ink + 300, { thai: thai.ink, blank: blank.ink });
  const line = await tr.renderRaster([{ text: 'ผัดไทยกุ้งสด', size: 24 }], {});
  const empty = await tr.renderRaster([{ text: '', size: 24 }], {});
  check('a Thai-only line is not blank', decodeRaster(line).ink > 200 && decodeRaster(empty).ink === 0, { thai: decodeRaster(line).ink, empty: decodeRaster(empty).ink });
  const mixed = await tr.renderRaster([{ text: 'ผัดไทย Pad Thai £8.95', size: 24 }], {});
  check('Thai and Latin render on ONE line', decodeRaster(mixed).ink > decodeRaster(line).ink, { mixed: decodeRaster(mixed).ink });
}

console.log('— size, logo, and the classic fallback');
{
  const normal = decodeRaster(await ps.receiptBytes({ ...RECEIPT, size: 'normal' }));
  const large = decodeRaster(await ps.receiptBytes({ ...RECEIPT, size: 'large' }));
  check('large is visibly taller than normal', large.height > normal.height * 1.08, { normal: normal.height, large: large.height });
  // A 64x24 logo: black bar with a white middle.
  const px = [];
  for (let y = 0; y < 24; y++) for (let x = 0; x < 64; x++) { const v = (y > 6 && y < 18 && x > 8 && x < 56) ? 255 : 0; px.push(v, v, v, 255); }
  const logoImg = PImage.make(64, 24); logoImg.data.set(Uint8Array.from(px));
  const chunks = [];
  const sink = new (require('stream').Writable)({ write(c, e, cb) { chunks.push(c); cb(); } });
  await new Promise((res, rej) => { sink.on('finish', res); sink.on('error', rej); PImage.encodePNGToStream(logoImg, sink).catch(rej); });
  const logo = 'data:image/png;base64,' + Buffer.concat(chunks).toString('base64');
  const withLogo = decodeRaster(await ps.receiptBytes({ ...RECEIPT, logo, showLogo: true }));
  check('the logo is composed INTO the receipt image', withLogo.height > normal.height && withLogo.ink > normal.ink, { h: withLogo.height, base: normal.height });
  const inverted = decodeRaster(await ps.receiptBytes({ ...RECEIPT, logo, showLogo: true, logoInvert: true }));
  check('invert flips which part of the logo is ink', inverted.ink !== withLogo.ink, { normal: withLogo.ink, inverted: inverted.ink });
  const off = decodeRaster(await ps.receiptBytes({ ...RECEIPT, logo, showLogo: false }));
  check('logo off leaves the receipt unchanged', off.height === normal.height, { off: off.height, normal: normal.height });

  const classic = await ps.receiptBytes({ ...RECEIPT, style: 'classic' });
  const text = classic.toString('latin1');
  check('classic fallback still prints the printer-font receipt', /TOTAL/.test(text) && !classic.includes(Buffer.from([0x1d, 0x76, 0x30, 0x00])));
  // Same payload feeds both paths, so the numbers cannot drift apart.
  const lines = tr.receiptLines(RECEIPT);
  const totalLine = lines.find((l) => l.text === 'TOTAL');
  check('both paths show the same total', totalLine.right === '£32.60' && /£32\.60/.test(text.replace(/\x9c/g, '£')), { rendered: totalLine.right });
  check('both paths show the same change', lines.find((l) => l.text === 'Change').right === '£7.40' && /7\.40/.test(text));
}

console.log('— prep ticket, Z report, test page');
{
  const prep = decodeRaster(await ps.prepBytes({ shop_name: 'Cha & Pinto', printer_name: 'Kitchen', order_id: 42, fulfilment: 'collection', channel: 'instore', staff: 'Nok', created_at: new Date().toISOString(), customer_name: 'Nok S', items: [{ name: 'ผัดไทย Pad Thai', qty: 2, options: ['Large'] }], other_items: 1 }));
  check('prep ticket renders', prep && prep.width === 576 && prep.ink > 1500, prep && prep.ink);
  const prepBuf = await ps.prepBytes({ shop_name: 'S', order_id: 1, items: [{ name: 'X', qty: 1, options: [] }] });
  check('prep ticket never opens the drawer', !prepBuf.includes(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa])));
  const z = decodeRaster(await ps.zBytes({ id: 7, opened_at: new Date().toISOString(), opened_by: 'Nok', sales: { count: 12, gross: 240.5, cash: 100, card: 140.5 }, refunds: { count: 1, total: 5 }, float_amount: 100, expected_cash: 195, counted_cash: 195, variance: 0 }, 'Cha & Pinto'));
  check('Z report renders', z && z.width === 576 && z.ink > 1500, z && z.ink);
  const test = decodeRaster(await ps.testBytes({ ip: '192.168.1.182', port: 9100 }, { shopName: 'Cha & Pinto' }));
  check('test page renders and shows Thai so the owner sees the real look', test && test.ink > 1500, test && test.ink);
}

console.log('— the Settings preview is the same picture the printer gets');
{
  const png = await tr.receiptPNG(RECEIPT, { size: 'normal' });
  check('preview returns a PNG', png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', png.subarray(0, 8).toString('hex'));
  const a = await tr.receiptRaster(RECEIPT, { size: 'normal' });
  const b = await tr.receiptRaster(RECEIPT, { size: 'normal' });
  check('rendering is deterministic (preview == print)', Buffer.compare(a, b) === 0);
  // Server-side preview: the web admin sees the same thing without Electron.
  const owner = (await req('POST', '/api/admin/login', { password: PASS })).data?.token;
  if (owner) {
    const r = await req('POST', '/api/admin/receipt-preview', { receipt_header: 'x', print_size: 'normal' }, owner);
    check('server renders the preview for the web admin', r.status === 200 && r.data.style === 'rendered' && String(r.data.png || '').startsWith('data:image/png;base64,'), { s: r.status, style: r.data && r.data.style });
    const c = await req('POST', '/api/admin/receipt-preview', { receipt_style: 'classic' }, owner);
    check('classic shops get no picture (they use the printer font)', c.status === 200 && c.data.style === 'classic', c.data);
    const bad = await req('PUT', '/api/admin/settings', { print_size: 'enormous' }, owner);
    check('an invalid print size is rejected', bad.status === 400, bad.data);
    const ok = await req('PUT', '/api/admin/settings', { receipt_style: 'classic', print_size: 'large' }, owner);
    const pub = (await req('GET', '/api/settings')).data;
    check('style and size are saved and published to the till', ok.status === 200 && pub.receipt_style === 'classic' && pub.print_size === 'large', { style: pub.receipt_style, size: pub.print_size });
    await req('PUT', '/api/admin/settings', { receipt_style: 'rendered', print_size: 'normal' }, owner);
  } else console.log('  (skipped server preview — no admin login)');
}

console.log('— over the wire to a printer');
{
  const rig = await listen(19310);
  await ps.printReceipt({ ip: '127.0.0.1', port: 19310 }, RECEIPT);
  await new Promise((r) => setTimeout(r, 250));
  const job = Buffer.concat(rig.jobs);
  const r = decodeRaster(job);
  check('the printer receives one 576-dot raster', !!r && r.width === 576 && r.ink > 2000, r && { w: r.width, h: r.height, ink: r.ink });
  await rig.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
