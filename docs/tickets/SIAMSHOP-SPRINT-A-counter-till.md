# SIAMSHOP-SPRINT-A — Counter-till completeness (5 ports from the restaurant)

**Approved by Korakot 7 Sep 2026** ("go with sprint A"). **Owner:** Joy · **Reviewer:** Krit (runs each port against the restaurant original) · **After:** ELECTRON-001 merge + tag; POST-001 can interleave.
**Ground rule:** port the *pattern* into SiamShop's own code and schema — copy, adapt names (shop/product/sale, not restaurant/menu/order), never import restaurant files. Every ticket ships with its own test script like `test-electron-staff.mjs`, and the till UI must fit the Electron Till/Admin surfaces (staff roles from ELECTRON-001 apply: cashier vs manager).

Suggested order (each independently mergeable):

## A1 — SIAMSHOP-TILL-001 · Till sessions + Z report (cash-up) · ~2 days
- `till_sessions` (shop_id, opened_by staff, opened_at, float_amount, closed_by, closed_at, expected_cash, counted_cash, variance, notes) · sales carry `session_id`.
- Open shift (float) on first sign-in of the day; close shift = count the drawer → expected vs counted → variance; Z report print (ESC/POS via printService: totals by payment method, refunds, discounts, VAT split if #10 later, cash in drawer) + saved copy in Admin → Reports → Z reports; reprint.
- Manager-only close; cashier can open. Restaurant source: `/api/till-sessions/*`, `/api/z-report`, `ZReportSection.jsx`.
- Accept: open → 3 sales (cash/card/mixed) → refund one → close with counted cash → variance correct → Z prints (fake 9100 rig) → shows in Admin.

## A2 — SIAMSHOP-CLOCK-001 · Staff clock in/out + timesheets · ~1 day
- `clock_events` (shop_id, staff_id, in/out, event_at). Toggle button on the PIN pad ("Clock in/out" beside "Sign in") — same one-button toggle as restaurant SEPOS-CLOCK-002 (server looks at last event, records the opposite).
- Admin → Staff → Timesheets: week picker, paired in/out → hours per staff, CSV export, "currently in" list. Cloud-native already (SiamShop is cloud-only) — no sync work.
- Accept: in/out/in for two staff → hours sum correct across midnight → CSV opens in Numbers/Excel → forgotten clock-out shows as "open" not as 24 h.

## A3 — SIAMSHOP-RECEIPT-001 · Receipt settings · ~½ day
- shop_settings: `receipt_header`, `receipt_footer`, `vat_number`, `show_logo` (logo already in brand), `receipt_copies`. Admin → Settings → Receipt card with live preview (text mock of the 42-col layout).
- printService `buildReceipt` reads them (it already accepts footer/vatNote); "Reprint last receipt" button on Till; reprint from Admin → Orders.
- Accept: change footer + VAT no → next receipt shows both (fake 9100) → reprint identical.

## A4 — SIAMSHOP-DISCOUNT-001 · Discounts with a reason · ~1 day
- Line discount (% or £) and basket discount; reasons list configurable (Damaged / Near date / Staff / Manager goodwill / Price match); manager PIN required above `discount_pin_threshold` (setting, default £10 or 20%); stored on `sale_items.discount_*` + `sales.discount_*` with reason + staff; receipt shows "Discount – reason".
- Reports: discounts by reason/staff for the day (feeds the Z).
- Restaurant source: `apply_discount`, `apply_item_discount`, discount_scope.
- Accept: cashier 10% on a line → no PIN; 30% → PIN modal (React modal — window.prompt is dead in Electron) → manager PIN → applied; receipt + Z + report agree to the penny.

## A5 — SIAMSHOP-REFUND-001 · Void / refund reasons · ~1 day
- Void before payment (line/basket) and refund after (full/partial, cash or card via Stripe refund for online sales) with reason: Wastage / Damaged / Wrong item / Customer changed mind / Faulty; manager PIN for any refund; stock put back for "wrong item / changed mind", written off for "wastage / damaged" (movement type `writeoff`).
- Admin → Orders: refund button + history; wastage total on the day report (this is the seed of ● #11).
- Accept: refund a cash sale → drawer kick → stock movement correct per reason → Z shows refunds → Stripe refund for a card online order lands (test mode).

## Definition of done for the sprint
All five merged, each with a test script green on a fresh DB, Krit review passed by running the acceptance path, one combined client-facing note (EN + TH, no ticket IDs) delivered to Korakot, and the SiamShop onboarding manual gains "End of day (Z)", "Timesheets", "Discounts & refunds" sections in `~/Documents/SiamEPOS-Docs/manuals/`.
