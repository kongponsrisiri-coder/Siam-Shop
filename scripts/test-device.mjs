// SIAMSHOP-DEVICE-001 — find printers (fake 9100 listener), USB label rule,
// receipt logo raster (GS v 0), scanner burst capture, brand settings API.
//   BASE=http://localhost:4998 node scripts/test-device.mjs
import net from 'node:net';
import { createRequire } from 'node:module';
import { createScanCapture, SUFFIX_KEYS } from '../client/src/scanner.js';
const require = createRequire(import.meta.url);
const scan = require('../electron/printerScan.js');
const raster = require('../electron/raster.js');
const ps = require('../electron/printService.js');

const BASE = process.env.BASE || 'http://localhost:4999';
const PASS = process.env.ADMIN_PASSWORD || 'test-pass-123';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra != null ? JSON.stringify(extra).slice(0, 300) : ''); }
}
async function req(method, p, body, token) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const listen = (port, onSock) => new Promise((res) => { const srv = net.createServer(onSock || ((s) => s.end())); srv.listen(port, '127.0.0.1', () => res(srv)); });

console.log('— D1 find printers (fake 9100 listener on 127.0.0.1)');
{
  const srv = await listen(19100);
  const r = await scan.scanPrinters({ port: 19100, hosts: ['127.0.0.1', '127.0.0.2'], passes: 1, timeoutMs: 400 });
  check('finds the listener and not the closed host', r.printers.length === 1 && r.printers[0].ip === '127.0.0.1' && r.printers[0].port === 19100, r);
  await new Promise((res) => srv.close(res));
  const r2 = await scan.scanPrinters({ port: 19100, hosts: ['127.0.0.1'], passes: 1, timeoutMs: 400 });
  check('nothing listening → empty list', r2.printers.length === 0, r2);
  const bases = scan.localBases();
  check('localBases() returns x.y.z bases (no loopback)', Array.isArray(bases) && bases.every((b) => /^\d+\.\d+\.\d+$/.test(b) && !b.startsWith('127.')), bases);
  const r3 = await scan.scanPrinters({ bases: [], passes: 1 });
  check('no LAN → friendly message', r3.printers.length === 0 && /No LAN/.test(r3.message), r3);
}

console.log('— D4 raster: pixels → GS v 0');
{
  // 16×2 image: row 0 all black, row 1 white except a black pixel at x=3 (rgba)
  const w = 16, h = 2, data = Buffer.alloc(w * h * 4, 255);
  for (let x = 0; x < w; x++) { data.set([0, 0, 0, 255], x * 4); }
  data.set([0, 0, 0, 255], (w + 3) * 4);
  const packed = raster.packBitmap({ width: w, height: h, data });
  check('widthBytes 2, bytes = [ff ff, 10 00]', packed.widthBytes === 2 && Buffer.compare(packed.bytes, Buffer.from([0xff, 0xff, 0x10, 0x00])) === 0, packed.bytes);
  const cmd = raster.gsv0(packed);
  check('GS v 0 header 1d 76 30 00 xL=2 xH=0 yL=2 yH=0', Buffer.compare(cmd.subarray(0, 8), Buffer.from([0x1d, 0x76, 0x30, 0x00, 2, 0, 2, 0])) === 0, cmd.subarray(0, 8));
  // transparent pixels are paper, BGRA order honoured
  const t = Buffer.alloc(8 * 1 * 4, 0); // all black but alpha 0 → white
  check('alpha 0 → white', raster.packBitmap({ width: 8, height: 1, data: t }).bytes[0] === 0);
  const bgra = Buffer.from([0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]); // px0 red(bgra), px1 blue, px2 black, px3 white, rest black
  const pb = raster.packBitmap({ width: 8, height: 1, data: bgra, order: 'bgra' });
  // red lum = 255*0.3 = 76 <140 → black; blue lum = 255*0.11 = 28 → black; black → black; white → white; rest black → 1110 1111
  check('BGRA order + luminance threshold', pb.bytes[0] === 0b11101111, pb.bytes[0].toString(2));
  // width padding to a byte boundary
  const odd = raster.packBitmap({ width: 10, height: 1, data: Buffer.alloc(40, 255).fill(0, 0, 3) });
  check('width 10 → 2 bytes, pixel 0 black only', odd.widthBytes === 2 && odd.bytes[0] === 0x80 && odd.bytes[1] === 0, odd.bytes);
  // invert: same pixels print the light parts; transparent stays paper either way
  const inv = raster.packBitmap({ width: 8, height: 1, data: bgra, order: 'bgra', invert: true });
  check('invert flips ink except transparency', inv.bytes[0] === 0b00010000, inv.bytes[0].toString(2));
  const tInv = Buffer.alloc(8 * 4, 0); // black, alpha 0
  check('invert keeps transparent pixels white', raster.packBitmap({ width: 8, height: 1, data: tInv, invert: true }).bytes[0] === 0);
  check('darkRatio: 16×2 sample = 17/32', Math.abs(raster.darkRatio(packed, w) - 17 / 32) < 1e-9, raster.darkRatio(packed, w));
  check('darkRatio > 0.5 flags a dark-background logo', raster.darkRatio(pb, 8) > 0.5 && raster.darkRatio(inv, 8) < 0.5);
  let threw = false; try { raster.packBitmap({ width: 700, height: 1, data: Buffer.alloc(2800) }); } catch { threw = true; }
  check('width > 576 dots rejected', threw);
  // through buildReceipt: raster first (after INIT + ALIGN_CENTER), then the shop name
  const receipt = ps.buildReceipt({ shopName: 'Logo Shop', orderId: 1, items: [{ name: 'Rice', qty: 1, line_total: 1, unit_price: 1 }], subtotal: 1, total: 1, payment_method: 'cash', logoRaster: cmd });
  const idx = receipt.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
  const nameIdx = receipt.indexOf(Buffer.from('Logo Shop', 'latin1'));
  check('receipt bytes contain GS v 0 before the shop name', idx > 0 && idx < nameIdx, { idx, nameIdx });
  const plain = ps.buildReceipt({ shopName: 'Logo Shop', orderId: 1, items: [], subtotal: 0, total: 0 });
  check('no logoRaster → no GS v 0', plain.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00])) === -1);
  check('hashString stable + length-tagged', raster.hashString('abc') === raster.hashString('abc') && raster.hashString('abc') !== raster.hashString('abd') && raster.hashString('abc').endsWith(':3'));
  // full path over the fake 9100 rig: printReceipt sends the raster bytes
  const jobs = [];
  const srv = await listen(19150, (sock) => { const c = []; sock.on('data', (d) => c.push(d)); sock.on('close', () => jobs.push(Buffer.concat(c))); });
  await ps.printReceipt({ ip: '127.0.0.1', port: 19150 }, { shopName: 'Logo Shop', orderId: 2, items: [], subtotal: 0, total: 0, logoRaster: cmd });
  await new Promise((r) => setTimeout(r, 200));
  check('fake 9100 job contains the raster header + 4 data bytes', jobs[0] && jobs[0].indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00, 2, 0, 2, 0, 0xff, 0xff, 0x10, 0x00])) > 0);
  await new Promise((res) => srv.close(res));
}

console.log('— D2 scanner burst capture');
{
  const scans = [];
  const cap = createScanCapture({ suffix: 'enter', onScan: (code, meta) => scans.push({ code, meta }) });
  let t = 1000; const fast = (k) => cap.handleKey({ key: k, now: (t += 20), target: 'box' });
  for (const k of '5012345678900') fast(k);
  let prevented = false; cap.handleKey({ key: 'Enter', now: (t += 20), preventDefault: () => { prevented = true; } });
  check('fast 13 digits + Enter → scan, Enter swallowed', scans.length === 1 && scans[0].code === '5012345678900' && scans[0].meta.target === 'box' && prevented, scans);
  t += 5000; for (const k of '501234') cap.handleKey({ key: k, now: (t += 300) }); cap.handleKey({ key: 'Enter', now: (t += 300) });
  check('slow human typing + Enter → no scan', scans.length === 1);
  t += 5000; for (const k of '12') cap.handleKey({ key: k, now: (t += 10) }); cap.handleKey({ key: 'Enter', now: (t += 10) });
  check('short burst (2 chars) → no scan', scans.length === 1);
  t += 5000; for (const k of 'ABC-123') cap.handleKey({ key: k, now: (t += 10) }); cap.handleKey({ key: 'Enter', now: (t += 10) });
  check('letters and dashes allowed', scans.length === 2 && scans[1].code === 'ABC-123');
  t += 5000; for (const k of '123456') cap.handleKey({ key: k, now: (t += 10) }); cap.handleKey({ key: 'Shift', now: (t += 10) }); cap.handleKey({ key: 'Enter', now: (t += 10) });
  check('a modifier key ends the burst', scans.length === 2);
  const tabs = [];
  const capT = createScanCapture({ suffix: 'tab', onScan: (c) => tabs.push(c) });
  t = 0; for (const k of '4006381333931') capT.handleKey({ key: k, now: (t += 15) }); capT.handleKey({ key: 'Enter', now: (t += 15) });
  check('tab-suffix scanner ignores Enter', tabs.length === 0);
  for (const k of '4006381333931') capT.handleKey({ key: k, now: (t += 15) }); capT.handleKey({ key: 'Tab', now: (t += 15) });
  check('tab-suffix scanner fires on Tab', tabs.length === 1 && tabs[0] === '4006381333931');
  const timers = []; const none = [];
  const capN = createScanCapture({ suffix: 'none', onScan: (c) => none.push(c), setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: (id) => { timers[id - 1] = null; } });
  t = 0; for (const k of '9780201379624') capN.handleKey({ key: k, now: (t += 10) });
  const live = timers.filter(Boolean);
  check('no-suffix scanner arms one settle timer per key, only the last live', live.length === 1 && live[0].ms === 120, timers.length);
  live[0].fn();
  check('settle timer fires the scan', none.length === 1 && none[0] === '9780201379624', none);
  check('SUFFIX_KEYS map', SUFFIX_KEYS.enter === 'Enter' && SUFFIX_KEYS.tab === 'Tab' && SUFFIX_KEYS.none === null);
}

console.log('— D3 brand settings API');
{
  for (let i = 0; i < 40; i++) { try { const h = await fetch(BASE + '/api/health').then((r) => r.json()); if (h.db === 'ok') break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  const owner = (await req('POST', '/api/admin/login', { password: PASS })).data.token;
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  let r = await req('PUT', '/api/admin/settings', { brand_primary: '#0B3D2E', brand_accent: '#D4AF37', brand_logo: PNG, receipt_show_logo: '1' }, owner);
  check('save brand → 200', r.status === 200 && r.data.brand_primary === '#0B3D2E', r.data && r.data.brand_primary);
  const pub = (await req('GET', '/api/settings')).data;
  check('public settings expose brand + receipt_show_logo', pub.brand_primary === '#0B3D2E' && pub.brand_accent === '#D4AF37' && pub.brand_logo === PNG && pub.receipt_show_logo === true, { p: pub.brand_primary, a: pub.brand_accent, l: (pub.brand_logo || '').slice(0, 20), s: pub.receipt_show_logo });
  await req('PUT', '/api/admin/settings', { brand_logo_invert: '1' }, owner);
  check('brand_logo_invert exposed publicly', (await req('GET', '/api/settings')).data.brand_logo_invert === true);
  r = await req('PUT', '/api/admin/settings', { brand_primary: 'red' }, owner);
  check('non-hex colour → 400', r.status === 400, r.data);
  r = await req('PUT', '/api/admin/settings', { brand_logo: 'javascript:alert(1)' }, owner);
  check('non-image logo → 400', r.status === 400, r.data);
  r = await req('PUT', '/api/admin/settings', { brand_logo: 'data:image/png;base64,' + 'A'.repeat(450000) }, owner);
  check('oversized logo → 400', r.status === 400, r.data);
  r = await req('PUT', '/api/admin/settings', { brand_primary: '', brand_accent: '', brand_logo: '', receipt_show_logo: '0' }, owner);
  const pub2 = (await req('GET', '/api/settings')).data;
  check('reset → empty brand, logo off', r.status === 200 && pub2.brand_primary === '' && pub2.brand_logo === '' && pub2.receipt_show_logo === false, pub2.brand_primary);
  r = await req('PUT', '/api/admin/settings', { brand_primary: '#123' }, (await req('POST', '/api/staff/login', { pin: '9081' })).data?.token || 'x');
  check('cashier / bad token cannot save brand', r.status === 401 || r.status === 403, r.status);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
