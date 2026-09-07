// SIAMSHOP-RECEIPT-001 — receipt header/footer/VAT/copies: settings → API → printed bytes.
//   BASE=http://localhost:4999 node scripts/test-receipt-settings.mjs
import net from 'node:net';
import { createRequire } from 'node:module';
import { receiptPreview } from '../client/src/receiptPreview.js';
const require = createRequire(import.meta.url);
const ps = require('../electron/printService.js');

const BASE = process.env.BASE || 'http://localhost:4999';
const PASS = process.env.ADMIN_PASSWORD || 'test-pass-123';
let pass = 0, fail = 0;
async function req(method, p, body, token) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra != null ? JSON.stringify(extra).slice(0, 300) : ''); }
}
const decode = (buf) => buf.toString('latin1').replace(/\x1b@|\x1bt.|\x1b%.|\x1b!.|\x1bM.|\x1bG.|\x1ba.|\x1bE.|\x1d!.|\x1dVA.|\x1bp.../g, '').replace(/\x9c/g, '£');
for (let i = 0; i < 40; i++) { try { const h = await fetch(BASE + '/api/health').then((r) => r.json()); if (h.db === 'ok') break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

console.log('— settings round-trip');
const owner = (await req('POST', '/api/admin/login', { password: PASS })).data.token;
let r = await req('PUT', '/api/admin/settings', { receipt_header: '16 London Rd, Guildford GU1 2AF\n01483 599499', receipt_footer: 'Thanks — see you soon!', vat_number: 'GB 123 4567 89', receipt_copies: '2' }, owner);
check('saved', r.status === 200);
const pub = (await req('GET', '/api/settings')).data;
check('public settings expose header/footer/vat/copies', pub.receipt_header.includes('01483 599499') && pub.receipt_footer === 'Thanks — see you soon!' && pub.vat_number === 'GB 123 4567 89' && pub.receipt_copies === 2, pub);
r = await req('PUT', '/api/admin/settings', { receipt_copies: '9' }, owner);
check('copies clamped to 3', (await req('GET', '/api/settings')).data.receipt_copies === 3);
await req('PUT', '/api/admin/settings', { receipt_copies: '2' }, owner);

console.log('— printed bytes carry the settings (fake 9100)');
const jobs = [];
const srv = net.createServer((sock) => { const c = []; sock.on('data', (d) => c.push(d)); sock.on('close', () => jobs.push(Buffer.concat(c))); });
await new Promise((res) => srv.listen(19130, '127.0.0.1', res));
const payload = {
  style: 'classic', // this suite checks the printer-font layout (PRINT-RENDER-001 default is rendered)
  shopName: 'Cha & Pinto Box', header: pub.receipt_header, footer: pub.receipt_footer, vatNote: `VAT No. ${pub.vat_number}`,
  orderId: 77, staff: 'Nok', createdAt: new Date().toISOString(), fulfilment: 'takeaway',
  items: [{ name: 'Tiparos Fish Sauce 300ml', qty: 1, unit_price: 1.5, line_total: 1.5, options: [] }],
  subtotal: 1.5, total: 1.5, payment_method: 'card',
};
await ps.printReceipt({ ip: '127.0.0.1', port: 19130 }, payload);
await new Promise((res) => setTimeout(res, 200));
const text = decode(jobs[0] || Buffer.alloc(0));
check('header lines printed (address + phone on separate lines)', /16 London Rd, Guildford GU1 2AF\n/.test(text) && /01483 599499\n/.test(text), text.slice(0, 200));
check('footer printed', /Thanks - see you soon!/.test(text));
check('VAT number printed after the footer', /VAT No\. GB 123 4567 89/.test(text) && text.indexOf('VAT No.') > text.indexOf('Thanks - see you'));
check('no line wider than 42', text.split('\n').every((l) => l.length <= 42));
// reprint identical
await ps.printReceipt({ ip: '127.0.0.1', port: 19130 }, payload);
await new Promise((res) => setTimeout(res, 200));
check('reprint is byte-identical', jobs.length === 2 && jobs[0].equals(jobs[1]));
// default footer when blank
await ps.printReceipt({ ip: '127.0.0.1', port: 19130 }, { ...payload, header: '', footer: '', vatNote: '' });
await new Promise((res) => setTimeout(res, 200));
const plain = decode(jobs[2]);
check('blank settings → default footer, no VAT line, no header', /Thank you for shopping with us!/.test(plain) && !/VAT No/.test(plain) && !/London Rd/.test(plain));
await new Promise((res) => srv.close(res));

console.log('— preview mock matches the layout');
const prev = receiptPreview({ shopName: 'Cha & Pinto Box', header: pub.receipt_header, footer: pub.receipt_footer, vatNumber: pub.vat_number });
check('preview: 42 cols max, header/footer/VAT present', prev.split('\n').every((l) => l.length <= 42) && /01483 599499/.test(prev) && /Thanks — see you soon!/.test(prev) && /VAT No\. GB 123 4567 89/.test(prev));
console.log('\n' + prev.split('\n').map((l) => '    │' + l.padEnd(42) + '│').join('\n') + '\n');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
