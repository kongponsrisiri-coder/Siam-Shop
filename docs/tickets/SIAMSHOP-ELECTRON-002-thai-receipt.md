# SIAMSHOP-ELECTRON-002 — Thai text on printed receipts (parked)

**Raised by:** Krit, PR #1 review (2026-09-07). **Status:** parked — build only if a shop needs it.

## Problem
`electron/printService.js` prints in CP858 and strips every non-Latin-1 character, so Thai
(and any CJK) never reaches the paper. Today the receipt uses the **English** product
`name` (the till sends `sale.items[].name` = `products.name`), so a shop that fills English
names is fine. A shop that only fills `name_th`, or wants a Thai shop name / footer, would
print blanks for those strings.

## Options
1. **ESC/POS Thai codepage** (restaurant `txtTh`, CP874 / TIS-620 at codepage 30 on POS80 /
   Epson / Star). Cheap, but combining vowels/tone marks render poorly on most 80 mm heads and
   the codepage ID varies by printer (restaurant ships a probe page for that).
2. **Bitmap render** (restaurant `ticketRender` with `pureimage` + a bundled Thai font → `GS v 0`
   raster). Correct glyph shaping, printer-independent, ~2× the bytes per line. This is what the
   restaurant kitchen tickets do; port it if a client needs Thai on paper.

## Acceptance (when picked up)
- A product with only `name_th` prints its Thai name legibly on a POS80-class printer.
- Latin-only receipts are byte-identical to today (no regression in speed or layout).
- Falls back to the current Latin path if the font/raster fails — a font problem must never lose a receipt.
