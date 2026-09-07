// The logo must survive to the printer on BOTH receipt paths.
//
// v0.1.10 shipped rendered receipts, and the main process still rasterised the
// logo for the classic path and then deleted the data URL — so every rendered
// bill printed with no logo while the Admin preview showed one.
//   node scripts/test-print-logo.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { preparePrintPayload, isClassic } = require('../electron/printPayload.js');
const ticketRender = require('../electron/ticketRender.js');

let pass = 0, fail = 0;
const check = (n, c, e) => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, e !== undefined ? JSON.stringify(e).slice(0, 200) : ''); } };

// A real PNG, drawn here rather than pasted as base64: a hand-typed literal was
// silently corrupt and the renderer skipped it, which made a check pass for the
// wrong reason.
const LOGO = await (async () => {
  const PImage = require('pureimage');
  const { PassThrough } = require('node:stream');
  const img = PImage.make(120, 60);
  const ctx = img.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 120, 60);
  ctx.fillStyle = '#000000'; ctx.fillRect(10, 10, 100, 40);
  const chunks = [];
  const out = new PassThrough();
  out.on('data', (d) => chunks.push(d));
  await PImage.encodePNGToStream(img, out);
  return `data:image/png;base64,${Buffer.concat(chunks).toString('base64')}`;
})();
let rasterised = 0;
const fakeRaster = () => { rasterised++; return Buffer.from([1, 2, 3]); };

console.log('— what each path is handed');
let p = preparePrintPayload({ showLogo: true, logo: LOGO, style: 'rendered' }, fakeRaster);
check('rendered keeps the data URL for the renderer to draw', p.logo === LOGO, { logo: !!p.logo });
check('rendered does not pre-rasterise', rasterised === 0 && !p.logoRaster);

rasterised = 0;
p = preparePrintPayload({ showLogo: true, logo: LOGO, style: 'classic' }, fakeRaster);
check('classic gets a bitmap instead', Buffer.isBuffer(p.logoRaster) && rasterised === 1);
check('classic drops the data URL it no longer needs', p.logo === undefined);

rasterised = 0;
p = preparePrintPayload({ showLogo: true, logo: LOGO }, fakeRaster);
check('no style means rendered — the data URL survives', p.logo === LOGO && rasterised === 0);

p = preparePrintPayload({ showLogo: false, logo: LOGO, style: 'classic' }, fakeRaster);
check('logo switched off → nothing rasterised', !p.logoRaster);
p = preparePrintPayload({ showLogo: true, logo: '', style: 'classic' }, fakeRaster);
check('no logo uploaded → nothing rasterised', !p.logoRaster);
check('a missing payload does not throw', typeof preparePrintPayload(null, fakeRaster) === 'object');
check('isClassic defaults to rendered', isClassic({}) === false && isClassic({ style: 'classic' }) === true);

console.log('— and it actually reaches the paper');
const sale = {
  shopName: 'Cha & Pinto Box', orderId: 4321, staff: 'Nok', createdAt: new Date().toISOString(),
  items: [{ name: 'Rice Lunch Box', qty: 1, line_total: 8.95, unit_price: 8.95, options: [] }],
  subtotal: 8.95, total: 8.95, payment_method: 'cash', amount_tendered: 10, change_given: 1.05,
};
const withLogo = await ticketRender.receiptRaster({ ...sale, showLogo: true, logo: LOGO },
  { size: 'normal', logo: LOGO, invert: false });
const without = await ticketRender.receiptRaster(sale, { size: 'normal', logo: null, invert: false });
check('a receipt with a logo is taller than one without', withLogo.length > without.length, { with: withLogo.length, without: without.length });

// The end-to-end shape: what main.js hands printService must still render a logo.
const prepared = preparePrintPayload({ ...sale, showLogo: true, logo: LOGO, style: 'rendered' }, fakeRaster);
const endToEnd = await ticketRender.receiptRaster(prepared,
  { size: 'normal', logo: prepared.showLogo ? prepared.logo : null, invert: !!prepared.logoInvert });
check('after the main process prepares it, the logo still prints', endToEnd.length === withLogo.length, { prepared: endToEnd.length, expected: withLogo.length });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
