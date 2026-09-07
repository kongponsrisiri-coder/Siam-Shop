import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { receiptPreview } from '../receiptPreview.js';
import { renderPrintPreview } from '../logoPreview.js';
import { isElectron, desktop } from '../electron.js';

// Admin → Settings receipt preview.
//
// Rendered receipts (the default) are drawn by the SAME code that prints, so
// this shows the actual print rather than an approximation — Thai and logo
// included. The desktop renders locally over IPC so it works offline; the web
// admin asks the server, which runs the identical module.
//
// Classic receipts use the printer's own built-in font, which no browser can
// show faithfully, so those keep the 42-column text mock with the 1-bit logo
// above it — otherwise an owner with the logo switched on sees no sign of it
// and assumes it is not printing (Korakot, 7 Sep).
const SAMPLE_ITEMS = [
  { name: 'Rice Lunch Box', qty: 1, line_total: 11.7, gross: 11.7, unit_price: 11.7, options: ['Large', 'Spicy Chilli Basil Pork'] },
  { name: 'ผัดไทยกุ้งสด Pad Thai Prawn', qty: 2, line_total: 17.9, unit_price: 8.95, options: [] },
  { name: 'Tiparos Fish Sauce 300ml', qty: 2, line_total: 3, unit_price: 1.5, options: [] },
];

export default function ReceiptPreview({ shopName, header, footer, vatNumber, logo, showLogo, invert, style = 'rendered', size = 'normal' }) {
  const [png, setPng] = useState(null);
  const [logoPv, setLogoPv] = useState(null);
  const [error, setError] = useState('');
  const rendered = style !== 'classic';

  // Rendered: fetch the real picture, debounced while the owner types.
  useEffect(() => {
    if (!rendered) { setPng(null); return undefined; }
    let alive = true;
    setError('');
    const t = setTimeout(async () => {
      try {
        if (isElectron) {
          const r = await desktop.previewReceipt({
            shopName, header, footer, vatNote: vatNumber ? `VAT No. ${vatNumber}` : '',
            orderId: 1234, staff: 'Nok', createdAt: new Date().toISOString(), fulfilment: 'takeaway',
            items: SAMPLE_ITEMS, subtotal: 32.6, total: 32.6,
            payment_method: 'cash', amount_tendered: 40, change_given: 7.4,
            logo: logo || '', showLogo: !!showLogo, logoInvert: !!invert, size,
          });
          if (!alive) return;
          if (r && r.ok) setPng(r.png); else setError((r && r.error) || 'Preview failed');
        } else {
          const r = await api.receiptPreview({
            receipt_header: header || '', receipt_footer: footer || '', vat_number: vatNumber || '',
            brand_logo: logo || '', receipt_show_logo: showLogo ? '1' : '0', brand_logo_invert: invert ? '1' : '0',
            receipt_style: 'rendered', print_size: size,
          });
          if (!alive) return;
          setPng(r.png || null);
          if (!r.png) setError('Preview unavailable');
        }
      } catch (e) { if (alive) setError(e.message); }
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [rendered, shopName, header, footer, vatNumber, logo, showLogo, invert, size]);

  // Classic: the 1-bit logo above the text mock.
  useEffect(() => {
    let alive = true;
    if (rendered || !logo || !showLogo) { setLogoPv(null); return undefined; }
    renderPrintPreview(logo, { invert }).then((r) => { if (alive) setLogoPv(r); }).catch(() => { if (alive) setLogoPv(null); });
    return () => { alive = false; };
  }, [rendered, logo, showLogo, invert]);

  return (
    <div className="receipt-preview-wrap" style={{ flex: '0 0 auto' }}>
      {rendered ? (
        png
          ? <img src={png} alt="Receipt as it will print" style={{ width: 288, maxWidth: '100%', display: 'block', border: '1px solid var(--line)', borderRadius: 6, background: '#fff' }} />
          : <div className="receipt-preview" style={{ width: 288, minHeight: 220, display: 'grid', placeItems: 'center' }}>{error ? <span className="err" style={{ fontSize: 12 }}>{error}</span> : 'Rendering…'}</div>
      ) : (
        <pre className="receipt-preview" style={{ margin: 0 }}>
          {logoPv ? <img src={logoPv.dataUrl} alt="Logo as it will print" style={{ display: 'block', margin: '0 auto 6px', width: Math.min(240, Math.round(logoPv.width / 2)), imageRendering: 'pixelated' }} /> : null}
          {receiptPreview({ shopName, header, footer, vatNumber })}
        </pre>
      )}
      <p className="muted" style={{ fontSize: 12, marginTop: 6, maxWidth: 288 }}>
        {rendered
          ? 'Drawn with a real typeface, exactly as it prints — Thai included. The logo prints when it is switched on under Brand.'
          : !logo ? 'The printer’s own font. No logo uploaded yet — add one under Brand.'
            : showLogo ? 'The printer’s own font, with the logo above. Thai does not print in this mode.'
              : 'The printer’s own font. Logo is off — tick “Print the logo at the top of till receipts” under Brand.'}
      </p>
    </div>
  );
}
