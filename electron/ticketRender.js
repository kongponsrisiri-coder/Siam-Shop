// SIAMSHOP-PRINT-RENDER-001 — receipts, prep tickets, Z reports and the test
// page are DRAWN with a real typeface and sent as one bitmap, not as printer-
// font text. Port of the restaurant's src/services/ticketRender.js.
//
// Why: the printer's built-in font is the blocky typewriter look, is Latin-1
// only (Thai product names printed blank), and the logo had to be bolted on as
// a separate raster. Drawing the whole ticket fixes all three at once — Thai
// falls out for free, which is why this supersedes SIAMSHOP-ELECTRON-002.
//
// pureimage is pure JavaScript, so this runs unchanged in the Electron main
// process AND in the Node server (the web admin's receipt preview).
//
// The classic ESC/POS text builders stay in printService.js as the fallback
// (shop setting receipt_style='classic'). Both paths take the SAME payload, so
// the two can never disagree about a number.
'use strict';

const path = require('path');
const fs = require('fs');
const PImage = require('pureimage');
const raster = require('./raster');

const W = 576;              // 80 mm printable width at 203 dpi
const LOGO_MAX_W = 384;
const LOGO_MAX_H = 200;
const FONT_DIR = path.join(__dirname, 'fonts');

// One rendered face, operator-chosen SIZE. The ticket is specified in points on
// a 576 px canvas, so scaling every size/gap/indent by one factor resizes
// cleanly and the measured word-wrap adapts by itself.
const SIZE_SCALES = { normal: 1.0, large: 1.15 };

let fontsReady = null;
function loadFonts() {
  if (!fontsReady) {
    const reg = (file, name) => {
      const p = path.join(FONT_DIR, file);
      if (!fs.existsSync(p)) throw new Error(`missing font ${p}`);
      const f = PImage.registerFont(p, name);
      return f.load ? f.load() : f;
    };
    // Sarabun carries full Thai AND full Latin, so a mixed line renders whole;
    // pure-Latin lines keep the Noto Sans look.
    fontsReady = Promise.all([
      reg('NotoSans-Regular.ttf', 'TicketSans'),
      reg('NotoSans-Bold.ttf', 'TicketSansBold'),
      reg('Sarabun-Regular.ttf', 'TicketThai'),
      reg('Sarabun-Bold.ttf', 'TicketThaiBold'),
    ]);
  }
  return fontsReady;
}

// Greedy word wrap; a single over-wide word is hard-broken. Caller sets the font.
function wrapText(scratch, text, maxW) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const segs = [];
  let cur = '';
  const flush = () => { if (cur) { segs.push(cur); cur = ''; } };
  for (const word of words) {
    const cand = cur ? cur + ' ' + word : word;
    if (scratch.measureText(cand).width <= maxW) { cur = cand; continue; }
    flush();
    if (scratch.measureText(word).width <= maxW) { cur = word; continue; }
    let piece = '';
    for (const ch of word) {
      if (scratch.measureText(piece + ch).width > maxW) { segs.push(piece); piece = ch; }
      else piece += ch;
    }
    cur = piece;
  }
  flush();
  return segs.length ? segs : [''];
}

const THAI = /[฀-๿]/;
const famFor = (l) => {
  const t = `${l.text || ''} ${l.right != null ? l.right : ''}`;
  const thai = THAI.test(t);
  return l.bold ? (thai ? 'TicketThaiBold' : 'TicketSansBold') : (thai ? 'TicketThai' : 'TicketSans');
};

function applyScale(lines, sizeKey) {
  const k = SIZE_SCALES[sizeKey] || 1.0;
  if (k === 1.0) return lines;
  return lines.map((l) => (l.rule ? l : {
    ...l,
    size: l.size ? Math.round(l.size * k) : l.size,
    gap: l.gap ? Math.round(l.gap * k) : l.gap,
    indent: l.indent ? Math.round(l.indent * k) : l.indent,
  }));
}

// ── Logo ─────────────────────────────────────────────────────────────────────
// Decoded to the SAME 1-bit rules the printer uses (alpha < 128 = paper,
// luminance < 140 = ink, invert for a light-on-dark logo) so the preview, the
// Settings thumbnail and the paper all agree.
async function decodeLogo(dataUrl) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  const { Readable } = require('stream');
  const stream = Readable.from(buf);
  try {
    return /png/i.test(m[1]) ? await PImage.decodePNGFromStream(stream) : await PImage.decodeJPEGFromStream(stream);
  } catch (e) {
    console.warn('[render] logo decode failed:', e.message);
    return null;
  }
}
// Nearest-neighbour into the ticket canvas; returns the height it used.
function drawLogo(img, logo, { invert = false, top = 0 } = {}) {
  const scale = Math.min(LOGO_MAX_W / logo.width, LOGO_MAX_H / logo.height, 1);
  const w = Math.max(1, Math.round(logo.width * scale));
  const h = Math.max(1, Math.round(logo.height * scale));
  const x0 = Math.round((W - w) / 2);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(logo.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(logo.width - 1, Math.floor(x / scale));
      const px = logo.getPixelRGBA(sx, sy);
      const r = (px >>> 24) & 0xff, g = (px >>> 16) & 0xff, b = (px >>> 8) & 0xff, a = px & 0xff;
      if (a < 128) continue;                       // transparent stays paper
      const dark = r * 0.3 + g * 0.59 + b * 0.11 < 140;
      if (!(invert ? !dark : dark)) continue;
      const o = ((top + y) * W + (x0 + x)) * 4;
      img.data[o] = 0; img.data[o + 1] = 0; img.data[o + 2] = 0; img.data[o + 3] = 255;
    }
  }
  return h;
}

// ── The engine ───────────────────────────────────────────────────────────────
// lines: [{ text, size, bold, center, gap, rule, heavy, indent, right }]
//   right — two-column line; long left text wraps UNDER itself with the value
//   pinned to the first line, so a product name can never collide with a price.
async function renderTicket(lines, { logo = null, invert = false } = {}) {
  await loadFonts();
  const PAD = 8, LH = 1.35, COL_GAP = 16;

  const scratch = PImage.make(1, 1).getContext('2d');
  const wrapped = [];
  for (const l of lines) {
    if (l.rule || l.blank) { wrapped.push(l); continue; }
    const size = l.size || 22;
    scratch.font = `${size}pt ${famFor(l)}`;
    const right = l.right != null && String(l.right) !== '' ? String(l.right) : null;
    const rightW = right ? scratch.measureText(right).width : 0;
    const maxW = W - PAD * 2 - (l.indent || 0) - (right ? rightW + COL_GAP : 0);
    const segs = wrapText(scratch, l.text, maxW);
    segs.forEach((s, i) => wrapped.push({
      ...l,
      text: s,
      right: i === 0 ? right : null,
      indent: (l.indent || 0) + (right && i > 0 ? Math.round(size * 1.1) : 0),
      gap: i === segs.length - 1 ? (l.gap || 0) : 0,
    }));
  }

  const logoImg = logo ? await decodeLogo(logo) : null;
  const logoH = logoImg ? Math.max(1, Math.round(logoImg.height * Math.min(LOGO_MAX_W / logoImg.width, LOGO_MAX_H / logoImg.height, 1))) + 12 : 0;

  let h = 24 + logoH;
  for (const l of wrapped) h += l.rule ? (l.heavy ? 22 : 18) : (l.blank ? Math.ceil((l.size || 14) * LH) : Math.ceil((l.size || 22) * LH) + (l.gap || 0));
  h += 30;

  const img = PImage.make(W, h);
  const ctx = img.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, h);
  ctx.fillStyle = '#000000';

  let y = 12;
  if (logoImg) { drawLogo(img, logoImg, { invert, top: y }); y += logoH; }
  y += 12;

  for (const l of wrapped) {
    if (l.rule) { ctx.fillRect(PAD, y + 6, W - PAD * 2, l.heavy ? 5 : 3); y += l.heavy ? 22 : 18; continue; }
    if (l.blank) { y += Math.ceil((l.size || 14) * LH); continue; }
    const size = l.size || 22;
    ctx.font = `${size}pt ${famFor(l)}`;
    const tw = ctx.measureText(l.text).width;
    const x = l.center ? Math.max(PAD, (W - tw) / 2) : PAD + (l.indent || 0);
    y += Math.ceil(size * LH);
    const baseline = y - Math.ceil(size * 0.28);
    ctx.fillText(l.text, x, baseline);
    if (l.right != null) {
      const rw = ctx.measureText(String(l.right)).width;
      ctx.fillText(String(l.right), W - PAD - rw, baseline);
    }
    y += (l.gap || 0);
  }
  return img;
}

// pureimage bitmap → ESC/POS GS v 0, through the same packer the logo uses.
const toRaster = (img) => raster.bitmapToEscPos({ width: img.width, height: img.height, data: img.data, channels: 4, order: 'rgba' });

function toPNG(img) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new (require('stream').Writable)({ write(c, e, cb) { chunks.push(c); cb(); } });
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    PImage.encodePNGToStream(img, sink).catch(reject);
  });
}

// ── What each ticket says ────────────────────────────────────────────────────
const money = (n) => '£' + Number(n || 0).toFixed(2);
const FULFIL = { dine_in: 'EAT IN', takeaway: 'TAKE AWAY', collection: 'COLLECTION', delivery: 'DELIVERY' };

// Receipt. Takes the SAME payload the classic builder takes, so the two paths
// cannot disagree about a number.
function receiptLines(r) {
  const when = r.createdAt ? new Date(r.createdAt) : new Date();
  const dateStr = when.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  // Type sizes match the restaurant till's customer bill, which is the size a
  // customer can actually read at arm's length; ours was roughly a third
  // smaller across the board and the item lines were not bold, so a receipt was
  // hard work (Korakot, 8 Sep, holding both bills side by side). A long shop
  // name steps down a size rather than wrapping.
  const L = [];
  const name = String(r.shopName || 'SiamShop');
  L.push({ text: name, size: name.length <= 16 ? 42 : 32, bold: true, center: true, gap: 6 });
  if (r.header) String(r.header).split(/\r?\n/).filter(Boolean).forEach((h) => L.push({ text: h, size: 21, center: true, gap: 2 }));
  L.push({ blank: true, size: 10 });
  L.push({ text: `Receipt #${r.orderId}`, right: dateStr, size: 23, gap: 2 });
  if (r.staff) L.push({ text: 'Served by', right: String(r.staff), size: 23, gap: 2 });
  if (r.fulfilment && FULFIL[r.fulfilment]) L.push({ text: FULFIL[r.fulfilment], size: 32, bold: true, center: true, gap: 4 });
  L.push({ rule: true });

  for (const it of r.items || []) {
    const gross = it.discount && Number(it.discount.amount) > 0 && it.gross != null ? it.gross : it.line_total;
    L.push({ text: `${it.qty}x  ${it.name}`, right: money(gross), size: 27, bold: true, gap: 4 });
    const opts = (it.options || []).map((o) => (typeof o === 'string' ? o : o && o.name)).filter(Boolean);
    if (opts.length) L.push({ text: opts.join(', '), size: 21, indent: 30, gap: 2 });
    if (it.qty > 1) L.push({ text: `@ ${money(it.unit_price)} each`, size: 20, indent: 30, gap: 2 });
    if (it.discount && Number(it.discount.amount) > 0) {
      L.push({ text: `Discount - ${it.discount.reason || ''}`.trim(), right: '-' + money(it.discount.amount), size: 21, indent: 30, gap: 2 });
    }
  }
  L.push({ rule: true });

  const basketDisc = r.discount && Number(r.discount.amount) > 0 ? r.discount : null;
  if (Number(r.delivery_fee) > 0) {
    L.push({ text: 'Subtotal', right: money(r.subtotal), size: 24, gap: 2 });
    L.push({ text: 'Delivery', right: money(r.delivery_fee), size: 24, gap: 2 });
  }
  if (basketDisc) {
    L.push({ text: 'Subtotal', right: money(r.subtotal), size: 24, gap: 2 });
    L.push({ text: `Discount - ${basketDisc.reason || ''}`.trim(), right: '-' + money(basketDisc.amount), size: 24, gap: 2 });
  }
  L.push({ rule: true, heavy: true });
  L.push({ text: 'TOTAL', right: money(r.total), size: 38, bold: true, gap: 4 });
  if (basketDisc || Number(r.discount_amount) > 0) {
    L.push({ text: `You saved ${money(r.discount_amount || (basketDisc && basketDisc.amount))}`, size: 23, center: true, gap: 2 });
  }
  L.push({ text: `Paid by ${String(r.payment_method || 'cash').toUpperCase()}`, right: r.amount_tendered != null ? money(r.amount_tendered) : '', size: 24, gap: 2 });
  if (r.change_given != null) L.push({ text: 'Change', right: money(r.change_given), size: 24, gap: 2 });
  L.push({ rule: true });
  L.push({ text: String(r.footer || 'Thank you for shopping with us!'), size: 22, center: true });
  if (r.vatNote) L.push({ text: String(r.vatNote), size: 21, center: true });
  return L;
}

// Prep ticket (SIAMSHOP-PRINTERS-001) — big and readable across a counter.
function prepLines(t) {
  const when = t.created_at ? new Date(t.created_at) : new Date();
  const time = when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  const service = FULFIL[t.fulfilment] || String(t.fulfilment || '').toUpperCase() || 'TAKE AWAY';
  const source = t.channel === 'instore' ? 'Till' : t.source === 'messenger' ? 'Messenger' : 'Online';
  const L = [];
  if (t.reprint) L.push({ text: '*** REPRINT ***', size: 20, bold: true, center: true });
  L.push({ text: String(t.shop_name || 'SiamShop'), size: 18, center: true });
  if (t.printer_name) L.push({ text: String(t.printer_name), size: 16, center: true });
  L.push({ text: `#${t.order_id}`, size: 40, bold: true, center: true });
  L.push({ text: service, size: 28, bold: true, center: true, gap: 6 });
  L.push({ text: `${source}${t.staff ? ' - ' + t.staff : ''}`, right: time, size: 17 });
  if (t.pickup_at) L.push({ text: 'PICKUP', right: new Date(t.pickup_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }), size: 20, bold: true });
  if (t.customer_name) L.push({ text: 'Customer', right: String(t.customer_name), size: 17 });
  L.push({ rule: true });
  for (const it of t.items || []) {
    L.push({ text: `${it.qty}x  ${it.name}`, size: 30, bold: true, gap: 2 });
    if (it.options && it.options.length) L.push({ text: it.options.join(', '), size: 20, indent: 30, gap: 6 });
  }
  if (t.other_items > 0) L.push({ text: `+ ${t.other_items} grocery item${t.other_items === 1 ? '' : 's'} packed at the till`, size: 16 });
  if (t.notes) { L.push({ rule: true }); L.push({ text: `NOTE: ${t.notes}`, size: 20, bold: true }); }
  L.push({ rule: true });
  return L;
}

// Z report / cash-up.
function zLines(z, shopName) {
  const t = (label, value, o = {}) => ({ text: label, right: value, size: 18, ...o });
  const L = [];
  L.push({ text: 'Z REPORT', size: 30, bold: true, center: true });
  L.push({ text: String(shopName || 'SiamShop'), size: 18, center: true });
  if (z.session_id || z.id) L.push({ text: `Session #${z.session_id || z.id}`, size: 17, center: true });
  L.push({ rule: true });
  if (z.opened_at) L.push(t('Opened', new Date(z.opened_at).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })));
  if (z.opened_by) L.push(t('By', String(z.opened_by)));
  if (z.closed_at) L.push(t('Closed', new Date(z.closed_at).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })));
  if (z.closed_by) L.push(t('By', String(z.closed_by)));
  L.push({ rule: true });
  L.push({ text: `SALES (${(z.sales && z.sales.count) || 0})`, right: money(z.sales && z.sales.gross), size: 20, bold: true });
  L.push(t('Cash', money(z.sales && z.sales.cash), { indent: 20 }));
  L.push(t('Card', money(z.sales && z.sales.card), { indent: 20 }));
  if (z.discounts && Number(z.discounts.total) > 0) L.push(t('Discounts', '-' + money(z.discounts.total)));
  L.push(t(`Refunds (${(z.refunds && z.refunds.count) || 0})`, '-' + money(z.refunds && z.refunds.total)));
  if (z.voids && Number(z.voids.count) > 0) L.push(t(`Voids before payment (${z.voids.count})`, money(z.voids.total)));
  if (z.wastage && Number(z.wastage.qty) > 0) L.push(t(`Wastage written off (${z.wastage.qty})`, money(z.wastage.value)));
  L.push({ rule: true });
  L.push(t('Float', money(z.float_amount)));
  L.push({ text: 'EXPECTED CASH', right: money(z.expected_cash), size: 22, bold: true });
  if (z.counted_cash != null) {
    L.push(t('Counted', money(z.counted_cash)));
    L.push({ text: 'DIFFERENCE', right: money(z.variance), size: 22, bold: true });
  }
  if (z.online && z.online.count) L.push({ text: `Online orders paid in shift: ${z.online.count} (${money(z.online.gross)}) - not in drawer`, size: 15 });
  if (z.refunds && Number(z.refunds.stripe) > 0) L.push({ text: `Online (Stripe) refunds: ${money(z.refunds.stripe)} - not in drawer`, size: 15 });
  if (z.notes) L.push({ text: `Notes: ${z.notes}`, size: 16 });
  L.push({ rule: true });
  return L;
}

// Test page — shows the real typeface and the shop's logo, so the first print
// tells the owner exactly what receipts will look like.
function testLines(info = {}) {
  const L = [];
  L.push({ text: 'PRINTER TEST', size: 30, bold: true, center: true });
  L.push({ text: String(info.shopName || 'SiamShop'), size: 20, center: true, gap: 6 });
  L.push({ rule: true });
  L.push({ text: 'Address', right: info.ip ? `${info.ip}:${info.port || 9100}` : (info.name || 'USB'), size: 17 });
  L.push({ text: 'Printed', right: new Date().toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }), size: 17 });
  L.push({ rule: true });
  L.push({ text: 'The quick brown fox jumps over the lazy dog', size: 18 });
  L.push({ text: 'ผัดไทยกุ้งสด · ข้าวหอมมะลิ · น้ำปลา', size: 20 });
  L.push({ text: 'Prices £1.50 · £14.24 · €9.99', size: 18 });
  L.push({ text: 'Sample item', right: money(8.95), size: 20 });
  L.push({ rule: true, heavy: true });
  L.push({ text: 'TOTAL', right: money(8.95), size: 26, bold: true });
  L.push({ rule: true });
  L.push({ text: 'If this reads cleanly, the printer is set up.', size: 16, center: true });
  return L;
}

// ── Public: lines → raster / PNG ─────────────────────────────────────────────
const opt = (o = {}) => ({ size: o.size || 'normal', logo: o.showLogo === false ? null : (o.logo || null), invert: !!o.invert });

async function renderRaster(lines, o) {
  const c = opt(o);
  return toRaster(await renderTicket(applyScale(lines, c.size), { logo: c.logo, invert: c.invert }));
}
async function renderPNG(lines, o) {
  const c = opt(o);
  return toPNG(await renderTicket(applyScale(lines, c.size), { logo: c.logo, invert: c.invert }));
}

const receiptRaster = (r, o) => renderRaster(receiptLines(r), o);
const receiptPNG = (r, o) => renderPNG(receiptLines(r), o);
const prepRaster = (t, o) => renderRaster(prepLines(t), { ...o, logo: null });
const zRaster = (z, shopName, o) => renderRaster(zLines(z, shopName), o);
const testRaster = (info, o) => renderRaster(testLines(info), o);

module.exports = {
  W, SIZE_SCALES, FONT_DIR,
  loadFonts, wrapText, applyScale, renderTicket, toRaster, toPNG,
  receiptLines, prepLines, zLines, testLines,
  renderRaster, renderPNG, receiptRaster, receiptPNG, prepRaster, zRaster, testRaster,
};
