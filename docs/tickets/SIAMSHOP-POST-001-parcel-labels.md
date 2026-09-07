# SIAMSHOP-POST-001 — Parcel labels for postal orders (label printer + Royal Mail)

**Owner:** Joy (builds) · **Reviewer:** Krit · **Requested by:** Korakot, 7 Sep 2026 ("they do delivery by post — can we use the thermal sticker printer?")
**Depends on:** SIAMSHOP-ELECTRON-001 merged (the label prints from the desktop till).
**Status:** Phase 1 = build with/after the Electron v0.1 trial · Phase 2 = PARKED until a shop ships 20+ parcels/day.

## Why
SiamShop's delivery fulfilment is **post** (UK zones London / Mainland / Remote by postcode, SIAMSHOP-007; orders move to `status='dispatched'` + `dispatch_date`). Today the shop re-types every address into Royal Mail Click & Drop and hand-writes or prints the packing note. A 4×6 thermal label printer on the till removes both.

## What the shop gets
- **Phase 1 — "Print label" on a postal order** (Till → order, and Admin → Orders): one click prints a **4×6 address + packing label** — ship-to name/address/postcode large, order #, item list with qty, "Packed by <staff>", a QR to the customer's tracking page (`/track?order=…`), shop name + return address small at the bottom. Optional second copy as a packing slip inside the box.
- **Phase 1 — Postage stays on Click & Drop, no re-typing needed:** the shop keeps buying postage on Click & Drop; the label PDF it gives them prints to the SAME label printer through the OS driver. Nothing to integrate for that.
- **Phase 2 (PARKED) — Click & Drop API:** SiamShop creates the Royal Mail shipment from the order automatically (address, weight, service), gets the postage label PDF back and prints it — one click, tracking number stored on the order and shown on the customer's tracking page + confirmation email. Needs a Click & Drop API key per shop (Business account), a per-order weight (products need a `weight_g` column or a default per category), and a service picker (Tracked 24/48, Letter/Large Letter/Parcel).

## Hardware rule (put in the shop onboarding manual)
- **4×6 inch (100×150 mm) direct-thermal label printer WITH a Mac + Windows driver** — Rollo, MUNBYN, Zebra ZD220/GK420 class, Brother QL-1110NWB. £100–150, no ink.
- **Not** app-only Bluetooth minis (Phomemo M-series, Niimbot) — they print only from their phone app.
- The label printer is a SECOND device beside the 80 mm receipt printer; both hang off the till (USB or Ethernet).

## How to build (Phase 1)
1. **Print through the OS driver, not raw bytes.** Label printers speak ZPL/TSPL/proprietary raster — different per brand. Rendering the label as HTML (or PDF) and using Electron's silent print to a named printer works on every brand that has a driver:
   `win.webContents.print({ silent: true, deviceName: cfg.labelPrinter, pageSize: { width: 101600, height: 152400 } /* microns */, margins: { marginType: 'none' } })` from a hidden BrowserWindow that loads the label HTML. Mac: the driver appears in `webContents.getPrintersAsync()`; Windows: same list from the spooler.
2. **Config:** `config.json` gains `label_printer` (printer name). Admin → This device gets a "Label printer" dropdown (list from `getPrintersAsync`) + "Print test label".
3. **Backend:** `GET /api/admin/orders/:id/label` (requireAuth; cashier + manager) returns the label data (ship-to, items, staff name, tracking URL, shop return address from shop_settings). No new tables. Mark `label_printed_at` on the order (one new column) so the dispatch list can show ✓.
4. **Client:** "Print label" button on postal orders in Till order view + Admin → Orders; disabled when `fulfilment !== 'delivery'` or `status` is cancelled/refunded. After printing, offer "Mark dispatched" (existing endpoint).
5. **Label layout:** 4×6 portrait, 300 dpi safe: postcode in the largest type (Royal Mail sorts on it), name/address 14–16 pt, order # + QR (use the same QR lib as the storefront) at 25 mm, item list truncated at 8 lines with "+N more", return address 8 pt at the foot. Latin-1 only for now — Thai product names print blank via the driver too? No — driver printing is font-rendered, so Thai works here (unlike ESC/POS). Use `products.name` anyway for consistency with the receipt.
6. **No printer to hand:** verify with a PDF "printer" — Mac: print to a CUPS-PDF/"Save as PDF" queue or use `webContents.printToPDF` with the same pageSize and eyeball the PDF in the PR; assert size = 4×6 and that the postcode is the largest text. Real device test when the first shop names its printer.

## Acceptance (Phase 1)
- [ ] Postal order → "Print label" → 4×6 label arrives on the configured label printer (or PDF in the rig) with postcode largest, QR resolves to the tracking page.
- [ ] `label_printed_at` stamped; dispatch list shows ✓; second print allowed (reprint).
- [ ] Non-postal orders don't show the button; cancelled/refunded orders can't print.
- [ ] Admin → This device: choose label printer + test label; survives restart (config.json).
- [ ] Click & Drop PDF prints to the same printer through the OS (manual check, documented in the onboarding manual).
- [ ] Manual page added: `~/Documents/SiamEPOS-Docs/manuals/` — SiamShop parcel labels (EN, TH later): which printer to buy, how to set it in the app, the Click & Drop flow.

## Out of scope / parked
- Royal Mail postage generation (Phase 2 — Click & Drop API), Parcel2Go/Evri, weights, customs (CN22) for non-UK.
- Kitchen/receipt printing changes — none.
