import React, { useEffect, useState } from 'react';
import { receiptPreview } from '../receiptPreview.js';
import { renderPrintPreview } from '../logoPreview.js';

// Admin → Settings receipt preview. The 42-column text mock alone could never
// show the logo, so an owner who had turned the logo on saw no sign of it and
// assumed it was not printing (Korakot, 7 Sep). This draws the logo above the
// text exactly as the printer renders it — same 1-bit conversion as the real
// ESC/POS raster — and says plainly when it is switched off.
export default function ReceiptPreview({ shopName, header, footer, vatNumber, logo, showLogo, invert }) {
  const [pv, setPv] = useState(null);

  useEffect(() => {
    let alive = true;
    if (!logo || !showLogo) { setPv(null); return undefined; }
    renderPrintPreview(logo, { invert }).then((r) => { if (alive) setPv(r); }).catch(() => { if (alive) setPv(null); });
    return () => { alive = false; };
  }, [logo, showLogo, invert]);

  const text = receiptPreview({ shopName, header, footer, vatNumber });
  return (
    <div className="receipt-preview-wrap" style={{ flex: '0 0 auto' }}>
      <pre className="receipt-preview" style={{ margin: 0 }}>
        {pv ? (
          <img
            src={pv.dataUrl}
            alt="Logo as it will print"
            style={{ display: 'block', margin: '0 auto 6px', width: Math.min(240, Math.round(pv.width / 2)), height: 'auto', imageRendering: 'pixelated' }}
          />
        ) : null}
        {text}
      </pre>
      <p className="muted" style={{ fontSize: 12, marginTop: 6, maxWidth: 260 }}>
        {!logo
          ? 'No logo uploaded yet — add one under Brand above to print it here.'
          : showLogo
            ? 'The logo prints at the top, in black and white as shown.'
            : 'Logo is off for receipts — tick “Print the logo at the top of till receipts” under Brand.'}
      </p>
    </div>
  );
}
