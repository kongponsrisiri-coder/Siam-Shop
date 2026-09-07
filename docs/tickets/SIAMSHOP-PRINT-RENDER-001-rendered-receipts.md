# SIAMSHOP-PRINT-RENDER-001 — Print receipts, prep tickets and Z reports as rendered PICTURES (port of the restaurant's ticketRender)

**Korakot, 7 Sep 2026:** "why don't you give Joy all of the logo setting stuff… I'm not sure you told Joy about the font on the ticket, as we print a picture." — Correct: the restaurant does NOT send text to the printer. It draws the whole ticket as an image with a real typeface (Noto Sans + Sarabun for Thai), composes the logo into it, sends the bitmap. SiamShop today sends printer-font text (Latin-1 only, Thai blank) with a separate logo raster, and the Settings preview is a text mock. **This ticket replaces that path.** Supersedes SIAMSHOP-ELECTRON-002 (Thai on receipts) — Thai falls out of this for free.
**Owner:** Joy · **Reviewer:** Krit (renders + prints on the fake 9100 rig + eyeballs the PNG) · ~2 days · next after PRINTERS-001.

## Port list (read-only sources in ~/Desktop/restaurant-epos)
1. **`src/services/ticketRender.js`** — the whole module: `loadFonts()`, `wrapText`, `renderLines()` (pureimage canvas → 576 px wide bitmap), `applyScale(lines, sizeKey)` (SIZE_SCALES normal/large), `toRaster()` (bitmap → GS v 0), `hasUnrenderableText()`, `kitchenTicketRaster()`, `receiptLines()`, `previewPNG()`. pureimage is pure JS — runs in Electron MAIN as-is (no native dep). Copy into `electron/ticketRender.js`; your existing `raster.js` packBitmap/gsv0 can be the raster step.
2. **`src/assets/fonts/NotoSans-Regular.ttf`, `NotoSans-Bold.ttf`, `Sarabun-Regular.ttf`, `Sarabun-Bold.ttf`** (SIL OFL) → `electron/fonts/`, add `fonts/**` to build.files (globs — remember today). Font fallback: Latin → Noto, Thai → Sarabun, per run of text.
3. **`src/services/printService.js` ~line 228 (SEPOS-RECEIPT-FONT-001)** — the pattern that matters: compute everything the receipt SAYS (strings, money, grouped items) ONCE into `lines`, and feed the SAME lines to the renderer AND to the classic text builder, so the two paths can never disagree on a number. Keep your ESC/POS text builder as the **fallback** (`receipt_style = 'classic'` per shop; default 'rendered').
4. **`client/src/screens/admin/SettingsSection.jsx` ~lines 841–907** — the preview: Settings → Receipt calls a preview endpoint/IPC that runs `previewPNG()` on a SAMPLE order with the shop's real header/footer/VAT/logo/size and shows the PNG. In Electron: `window.electron.previewReceipt(settings)` → main renders → data URL. On the web admin: `POST /api/admin/receipt-preview` does the same server-side (pureimage runs in Node too) — so the owner sees the real print from a browser.
5. Logo: composed INTO the rendered image at the top (centred, ≤384 px wide, 1-bit with the dark-ratio warning + invert from DEVICE-001) — drop the separate GS v 0 logo block in the rendered path; keep it for classic.

## What renders
- **Receipt** (Till sale, reprint, refund receipt): header lines, shop name in bold, logo, date/time, receipt #, served by, items (qty · name · price, options indented, Thai names render), discounts with reason, subtotal/delivery/TOTAL big, paid by / change, "You saved", footer, VAT no, QR (order status) optional.
- **Prep ticket** (PRINTERS-001): order #, EAT IN/TAKE AWAY/COLLECTION big, items in LARGE scale with options, customer name, time, "*** REPRINT ***".
- **Z report**: the current text layout, rendered.
- **Test page**: rendered, shows the font + the shop logo so the owner sees the real look on the first print.
- **Size setting** per shop: `print_size = normal | large` (SIZE_SCALES), shown in Settings → Receipt with the preview updating live.

## Acceptance
- [ ] Fake 9100 rig: receipt bytes = one GS v 0 raster (plus cut/drawer), 576 px wide, and the decoded PNG (write it in the test) shows Thai product names + English + £ correctly. Post the PNG in the PR.
- [ ] Settings → Receipt preview PNG is byte-identical to what a real sale prints with the same settings (same function, same lines).
- [ ] Classic fallback still prints when `receipt_style='classic'`; numbers identical between the two paths (shared lines).
- [ ] Prep ticket + Z + test page rendered; size large visibly bigger; logo composed in; dark-logo warning/invert respected.
- [ ] Packaged app: `--self-test` also loads the fonts and renders a 1-line PNG (catches a missing fonts/ dir in the asar); asar check includes fonts/**.
- [ ] Render smoke green; performance: a receipt renders < 300 ms on the Mac.
