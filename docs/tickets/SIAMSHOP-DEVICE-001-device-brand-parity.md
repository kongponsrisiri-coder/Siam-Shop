# SIAMSHOP-DEVICE-001 — Device & brand parity with the restaurant till

**From Korakot's first walk through SiamShop v0.1.4 Admin → This device (7 Sep 2026):** "they need printer scanner (system just put a printer IP — confusing for staff), till theme with the logo, bill setting with logo as the restaurant side. So many good things from the restaurant side can reuse on the shop."
**Owner:** Joy · **Reviewer:** Krit (runs it + renders it) · **Priority:** before the first shop trial — this is the screen an owner sees on day one.

## D1 — Find the printer, don't type its IP (½ day)
- Port the restaurant's `GET /api/printers/scan` (sweeps the till's /24 for port 9100 responders, ~3 s) into the Electron MAIN process (SiamShop has no embedded server): `window.electron.scanPrinters()` → list of `{ip, port, model?}`; "🔍 Find printers" button beside the IP field → pick one → IP fills in. Keep manual entry for odd subnets.
- **Empty by default.** Never pre-fill an IP; placeholder text only. Show the saved printer as a card ("Receipt printer: 192.168.1.182 · last test OK 7 Sep 17:40") rather than a bare field, with "Change" to edit.
- USB list: label entries by the printer's *driver name* (e.g. "EPSON TM-T20III"), with the CUPS queue in small text — `_192_168_68_54` means nothing to staff.
- Restaurant source: `src/server.js` `/api/printers/scan`; the transport chain is already in `electron/printService.js`.

## D2 — Barcode scanner section (½ day)
- New card "Barcode scanner": a USB scanner works as a keyboard (no config), but staff can't tell if it's working. Add: a **"Test scan" box** that shows the last code read + which product it matched; a **suffix setting** (Enter / Tab / none — most scanners send Enter; Till listens for that); **"Scan when not focused"** — the Till captures fast keyboard bursts anywhere on the screen so a scan never lands in a search box (restaurant has no equivalent; keep simple).
- Phone Scan app stays as is; this card is for the counter.

## D3 — Brand theme with logo (1 day)
- Port the restaurant `theme.js` CSS-variable system: shop_settings `brand_primary`, `brand_accent`, `brand_logo` (upload → stored as data URL / small PNG in shop_settings, as the restaurant does with `brand_logo`); applied to the till header, PIN screen, and Admin. The three existing SiamShop forks already re-skin via `styles.css :root` — this makes it a per-shop setting instead of a code fork.
- Admin → Settings → "Brand" card: logo upload with preview, two colour pickers, "Reset to SiamShop".
- Read BRAND_CI.md before designing (standing rule). Never hardcode hexes in components.

## D4 — Receipt logo (½ day, unlocks Thai later)
- `show_logo` on the receipt: raster the brand logo to a 384-px-wide 1-bit ESC/POS bitmap (GS v 0) at the top of the receipt. Restaurant renders tickets with `pureimage` — port that helper into `electron/printService.js`. Cache the rasterised bitmap per logo hash.
- This is the same raster path SIAMSHOP-ELECTRON-002 (Thai on receipts) needs — build the raster helper generically so ELECTRON-002 becomes "render the text lines through it too".

## Acceptance
- [ ] Fresh install: printer fields empty; "Find printers" lists a fake 9100 listener on 127.0.0.1 in the rig; picking it fills the IP; test page prints.
- [ ] USB list shows driver names.
- [ ] Test-scan box shows the code + product for a scanned (typed-fast) EAN; Enter suffix handled; scan while focus is elsewhere still adds to basket.
- [ ] Logo + colours set in Admin → visible on till header, PIN screen, receipt (fake 9100 bytes contain GS v 0 raster) — and survive a restart.
- [ ] Headless render smoke green on every touched screen (the v0.1.1 lesson).
