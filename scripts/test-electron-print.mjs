// SIAMSHOP-ELECTRON-001 — print path WITHOUT hardware (Krit, PR #1 review).
// Fakes a RAW 9100 printer and an LPR/LPD print server on localhost, drives
// electron/printService.js against them and asserts on the bytes that arrive.
//   node scripts/test-electron-print.mjs
import net from 'node:net';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ps = require('../electron/printService.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra != null ? String(extra).slice(0, 300) : ''); }
}
const ESC = 0x1b, GS = 0x1d;
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
// Strip ESC/POS control sequences so the text layout can be eyeballed.
function decode(buf) {
  let s = buf.toString('latin1');
  s = s.replace(/\x1b@/g, '').replace(/\x1bt./g, '').replace(/\x1b%./g, '').replace(/\x1b!./g, '').replace(/\x1bM./g, '').replace(/\x1bG./g, '')
    .replace(/\x1ba./g, '').replace(/\x1bE./g, '').replace(/\x1d!./g, '').replace(/\x1dVA./g, '').replace(/\x1bp.../g, '')
    .replace(/\x9c/g, '£');
  return s;
}

// ── fake RAW printer ──────────────────────────────────────────────────────────
function fakeRaw(port) {
  const jobs = [];
  const srv = net.createServer((sock) => {
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('close', () => jobs.push(Buffer.concat(chunks)));
  });
  return new Promise((res) => srv.listen(port, '127.0.0.1', () => res({ srv, jobs, close: () => new Promise((r) => srv.close(r)) })));
}
// ── fake LPR/LPD server (RFC 1179: ACK 0x00 to each of the 5 stages) ─────────
function fakeLpr(port) {
  const jobs = [];
  const srv = net.createServer((sock) => {
    let stage = 0, expect = 0, data = Buffer.alloc(0), buf = Buffer.alloc(0);
    const ack = () => sock.write(Buffer.from([0x00]));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length) {
        if (stage === 0) { // 02 queue \n
          const nl = buf.indexOf(0x0a); if (nl < 0) return;
          buf = buf.slice(nl + 1); stage = 1; ack();
        } else if (stage === 1) { // 02 len cfname \n
          const nl = buf.indexOf(0x0a); if (nl < 0) return;
          expect = parseInt(buf.slice(1, nl).toString().split(' ')[0], 10); buf = buf.slice(nl + 1); stage = 2; ack();
        } else if (stage === 2) { // control file + 00
          if (buf.length < expect + 1) return;
          buf = buf.slice(expect + 1); stage = 3; ack();
        } else if (stage === 3) { // 03 len dfname \n
          const nl = buf.indexOf(0x0a); if (nl < 0) return;
          expect = parseInt(buf.slice(1, nl).toString().split(' ')[0], 10); buf = buf.slice(nl + 1); stage = 4; ack();
        } else if (stage === 4) { // data file + 00
          if (buf.length < expect + 1) return;
          data = buf.slice(0, expect); buf = buf.slice(expect + 1); stage = 5; jobs.push(data); ack();
        } else return;
      }
    });
  });
  return new Promise((res) => srv.listen(port, '127.0.0.1', () => res({ srv, jobs, close: () => new Promise((r) => srv.close(r)) })));
}

const sample = {
  style: 'classic', // classic path under test here; rendered has its own suite
  shopName: 'Cha & Pinto Box', address: '16 London Rd, Guildford GU1 2AF', orderId: 42, staff: 'Nok', fulfilment: 'takeaway',
  items: [
    { name: 'Rice Lunch Box', qty: 1, unit_price: 11.7, line_total: 11.7, options: ['Large', 'Spicy Chilli Basil Pork', 'Fried Chicken + Panang Curry Sauce', 'Crispy Fried Egg'] },
    { name: 'Tiparos Fish Sauce 300ml', qty: 2, unit_price: 1.5, line_total: 3.0, options: [] },
    { name: 'Umbrella Premium Thai Hom Mali Jasmine Fragrant Rice 5kg Bag', qty: 1, unit_price: 14.24, line_total: 14.24, options: [] }, // 60 chars
  ],
  subtotal: 28.94, total: 28.94, payment_method: 'card', amount_tendered: null, change_given: null,
};

console.log('— 1. RAW 9100 receipt bytes');
const RAW_PORT = 19100;
let raw = await fakeRaw(RAW_PORT);
await ps.printReceipt({ ip: '127.0.0.1', port: RAW_PORT }, sample);
await new Promise((r) => setTimeout(r, 200));
check('one job captured', raw.jobs.length === 1, raw.jobs.length);
const job = raw.jobs[0] || Buffer.alloc(0);
check('starts with ESC @ (1B 40)', job[0] === ESC && job[1] === 0x40, hex(job.slice(0, 4)));
check('selects CP858 (ESC t 0x13)', job.indexOf(Buffer.from([ESC, 0x74, 0x13])) === 2, hex(job.slice(0, 8)));
check('ends with cut GS V A 5 + feed', job.indexOf(Buffer.from([GS, 0x56, 0x41, 0x05])) === job.length - 4, hex(job.slice(-6)));
check('£ arrives as CP858 byte 0x9C, never UTF-8 C2 A3', job.includes(0x9c) && job.indexOf(Buffer.from([0xc2, 0xa3])) === -1);
const text = decode(job);
const lines = text.split('\n');
check('shop name present', text.includes('Cha & Pinto Box'));
check('TOTAL line', /TOTAL\s+£28\.94/.test(text));
check('"Paid by CARD"', /Paid by CARD/.test(text));
check('receipt # + staff', /Receipt #42/.test(text) && /Served by\s+Nok/.test(text));
const itemLines = lines.filter((l) => /^\d+x\s/.test(l));
check('3 item lines with qty column', itemLines.length === 3, itemLines);
check(`item lines exactly ${ps.LINE_WIDTH} chars (price right-aligned)`, itemLines.every((l) => l.length === ps.LINE_WIDTH), itemLines.map((l) => l.length));
check('price at the right edge', itemLines.every((l) => /£\d+\.\d\d$/.test(l)), itemLines);
check('no line wider than the paper', lines.every((l) => l.length <= ps.LINE_WIDTH), lines.filter((l) => l.length > ps.LINE_WIDTH));
console.log('\n' + lines.filter((l) => l.trim()).map((l) => '    │' + l.padEnd(ps.LINE_WIDTH) + '│').join('\n') + '\n');

console.log('— 4. wrapping');
const longIdx = lines.findIndex((l) => /^1x\s+Umbrella Premium/.test(l));
check('60-char name starts on the item line', longIdx > 0, longIdx);
check('continuation indented under the name column', longIdx > 0 && /^ {5}\S/.test(lines[longIdx + 1]) && /Bag|Rice|5kg/.test(lines[longIdx + 1]), lines[longIdx + 1]);
const optLines = lines.filter((l) => /^ {5}(- |  )\S/.test(l));
check('options: "- " prefix on the first line only', optLines.length >= 2 && optLines[0].startsWith('     - ') && optLines.slice(1).every((l) => l.startsWith('       ')), optLines);
check('"@ £1.50 each" under the qty>1 line', /@ £1\.50 each/.test(text));

console.log('— 2. drawer kick');
raw.jobs.length = 0;
await ps.openCashDrawer({ ip: '127.0.0.1', port: RAW_PORT });
await new Promise((r) => setTimeout(r, 200));
check('drawer pulse arrives alone: 1B 70 00 19 FA', raw.jobs.length === 1 && hex(raw.jobs[0]) === '1b 70 00 19 fa', raw.jobs.map(hex));
await raw.close();

console.log('— 3. transport fallback RAW → LPR + transport cache');
const LPR_PORT = 10515, DEAD_RAW = 19101; // nothing listens on DEAD_RAW
const lpr = await fakeLpr(LPR_PORT);
let t0 = Date.now();
await ps.printReceipt({ ip: '127.0.0.1', port: DEAD_RAW, lprPort: LPR_PORT, lprQueue: 'lp' }, sample);
const firstMs = Date.now() - t0;
check('receipt arrives via LPR when RAW is refused', lpr.jobs.length === 1 && lpr.jobs[0].equals(job), lpr.jobs.length);
t0 = Date.now();
await ps.printReceipt({ ip: '127.0.0.1', port: DEAD_RAW, lprPort: LPR_PORT, lprQueue: 'lp' }, sample);
const secondMs = Date.now() - t0;
check('second print delivered via LPR too', lpr.jobs.length === 2);
check(`second print skips the RAW attempt (cache): ${secondMs} ms vs first ${firstMs} ms`, secondMs < firstMs - 1000 && secondMs < 2500, { firstMs, secondMs });
await lpr.close();

console.log('— error path');
let err = null;
try { await ps.printReceipt({ ip: '', name: '' }, sample); } catch (e) { err = e.message; }
check('no printer configured → clear error', /No printer configured/.test(err || ''), err);

console.log('— 5. Windows spooler helper: not runnable on macOS — untested until a Windows trial machine exists.');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
