// Parcel label (SIAMSHOP-POST-001) — 4×6 in (100×150 mm) address + packing
// label as a self-contained HTML document. Printed through the OS driver by the
// desktop till (Electron silent print) or via the browser print dialog on the
// web admin. Royal Mail sorts on the postcode, so it is the largest text.
import QRCode from 'qrcode';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MAX_ITEM_LINES = 8;

export async function buildLabelHtml(d, { packingCopy = false } = {}) {
  const qr = d.tracking_url ? await QRCode.toString(d.tracking_url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }) : '';
  const items = d.items || [];
  const shown = items.slice(0, MAX_ITEM_LINES);
  const more = items.length - shown.length;
  const when = d.created_at ? new Date(d.created_at).toLocaleDateString('en-GB') : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Label #${esc(d.order_id)}</title>
<style>
  @page { size: 4in 6in; margin: 0; }
  html, body { margin: 0; padding: 0; width: 4in; height: 6in; }
  body { font-family: Helvetica, Arial, 'Noto Sans Thai', sans-serif; color: #000; -webkit-print-color-adjust: exact; }
  .label { box-sizing: border-box; width: 4in; height: 6in; padding: 0.22in 0.25in 0.2in; display: flex; flex-direction: column; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; font-size: 10pt; }
  .top .shop { font-weight: 700; }
  .top .order { text-align: right; font-weight: 700; font-size: 12pt; }
  .kind { margin-top: 0.05in; font-size: 9pt; letter-spacing: 0.12em; text-transform: uppercase; color: #333; }
  .to { margin-top: 0.12in; border-top: 2px solid #000; padding-top: 0.1in; }
  .to .name { font-size: 16pt; font-weight: 700; }
  .to .line { font-size: 14pt; line-height: 1.25; }
  .to .postcode { font-size: 34pt; font-weight: 900; letter-spacing: 0.06em; margin-top: 0.05in; }
  .to .phone { font-size: 10pt; color: #333; margin-top: 0.03in; }
  .mid { display: flex; gap: 0.15in; margin-top: 0.14in; border-top: 1px solid #000; padding-top: 0.1in; flex: 1; min-height: 0; }
  .items { flex: 1; font-size: 9.5pt; line-height: 1.3; }
  .items .h { font-weight: 700; margin-bottom: 0.03in; }
  .items .row { display: flex; gap: 0.08in; }
  .items .q { width: 0.3in; font-weight: 700; }
  .items .opt { color: #444; font-size: 8pt; }
  .qrbox { width: 1in; text-align: center; font-size: 7.5pt; color: #333; }
  .qrbox svg { width: 1in; height: 1in; display: block; }
  .foot { border-top: 1px solid #000; margin-top: 0.08in; padding-top: 0.06in; font-size: 8pt; color: #222; display: flex; justify-content: space-between; gap: 0.1in; }
  .foot .ret { white-space: pre-line; }
  .packing { position: absolute; top: 0.08in; right: 0.25in; font-size: 8pt; border: 1px solid #000; padding: 1px 4px; }
</style></head><body>
<div class="label">
  ${packingCopy ? '<div class="packing">PACKING COPY</div>' : ''}
  <div class="top">
    <div class="shop">${esc(d.shop?.name || 'SiamShop')}</div>
    <div class="order">Order #${esc(d.order_id)}<div style="font-size:9pt;font-weight:400">${esc(when)}</div></div>
  </div>
  <div class="kind">Postal delivery</div>
  <div class="to">
    <div class="name">${esc(d.ship_to?.name || '')}</div>
    ${(d.ship_to?.lines || []).map((l) => `<div class="line">${esc(l)}</div>`).join('')}
    <div class="postcode">${esc(d.ship_to?.postcode || '')}</div>
    ${d.ship_to?.phone ? `<div class="phone">☎ ${esc(d.ship_to.phone)}</div>` : ''}
  </div>
  <div class="mid">
    <div class="items">
      <div class="h">${items.reduce((n, i) => n + Number(i.qty || 0), 0)} item(s)</div>
      ${shown.map((i) => `<div class="row"><span class="q">${esc(i.qty)}×</span><span>${esc(i.name)}${i.options?.length ? `<div class="opt">${esc(i.options.join(', '))}</div>` : ''}</span></div>`).join('')}
      ${more > 0 ? `<div class="row"><span class="q"></span><span>+${more} more</span></div>` : ''}
      ${d.notes ? `<div class="opt" style="margin-top:0.05in">Note: ${esc(d.notes)}</div>` : ''}
    </div>
    <div class="qrbox">${qr}<div>Scan to track</div></div>
  </div>
  <div class="foot">
    <div class="ret">${esc(d.shop?.return_address ? 'Return to: ' + d.shop.return_address : d.shop?.name || '')}</div>
    <div>Packed by ${esc(d.staff || '')}</div>
  </div>
</div>
</body></html>`;
}

// Used by Admin → This device → "Print test label" and the PDF rig.
export const SAMPLE_LABEL = {
  order_id: 1234,
  created_at: new Date().toISOString(),
  ship_to: { name: 'Somchai Prasert', lines: ['Flat 2, 42 Stoke Road', 'Guildford', 'Surrey'], postcode: 'GU1 3AA', phone: '07700 900123' },
  items: [
    { name: 'Umbrella Jasmine Rice 5kg', qty: 1, options: [] },
    { name: 'M/S Green Curry Paste 400g', qty: 2, options: [] },
    { name: 'Tiparos Fish Sauce 300ml', qty: 1, options: [] },
    { name: 'Oishi Green Tea Original 500ml', qty: 6, options: [] },
  ],
  staff: 'Nok',
  tracking_url: 'https://siam-shop-production.up.railway.app/order/status?order=1234',
  shop: { name: 'Cha & Pinto Box', return_address: '16 London Rd, Guildford GU1 2AF' },
  notes: '',
};

// Web fallback: open the label in a window and print it (browser dialog).
export function printLabelInBrowser(html) {
  const w = window.open('', '_blank', 'width=420,height=640');
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch { /* user closed */ } }, 300);
  return true;
}
