# SIAMSHOP-PRINTERS-001 — Multiple printers with jobs (receipt · prep ticket · label)

**Korakot, 7 Sep 2026:** "maybe we should allow multi printer, we never know in the future we might need it" → yes. **Owner:** Joy · **Reviewer:** Krit · **Queue:** after CRM-001. ~2 days. Port of the restaurant printer model (printers table + routing, v1.8.3) — not an invention.
**Why now, not "the future":** the M5 food counter. A lunch box rung at the till needs a ticket at the PREP counter, not the front. Today SiamShop holds exactly one receipt printer + one label printer per device (config.json).

## Model
- **`printers` — shop-wide, in the cloud** (every till sees the same list): `id, shop_id, name, kind ('network'|'usb'), ip, port (9100), lpr_queue, usb_name, job ('receipt'|'prep'|'label'), active, last_test_at, last_test_ok, created_at`. Found via DEVICE-001's "Find printers" scan or typed. Test page + status card per printer (reuse the D1 card).
- **Per device (config.json):** `receipt_printer_id` — "this till's receipt printer" (the one with the cash drawer). Nothing else is per device. `label_printer` from POST-001 migrates into the list as `job='label'` (one-time config → cloud migration on first boot after update; keep the old field readable for one version).
- **Prep printer(s) — shop-wide:** `job='prep'`. Optional `prep_categories` (array of category ids) on a prep printer — empty = all prep items. A shop with two counters (hot food / bakery) routes by category; most shops have one.

## Behaviour
- **Sale paid** (Till or online paid order) → receipt on THIS device's receipt printer (as now) **+ a prep ticket** on every `prep` printer whose categories match items in the sale: shop name, order #, EAT IN / TAKE AWAY / COLLECTION, time, items with options (M5) in large text, customer name for collection. ESC/POS text via printService; Latin-1 only for now (ELECTRON-002 raster later). Prep tickets never kick the drawer.
- **Who prints the prep ticket when there are 2 tills?** The till that took the payment. For ONLINE orders (no till took payment) → the shop's **designated printing till**: `printing_device_id` in shop_settings; that device polls `/api/prep/print-queue` (cloud-only product, no socket relay) every 10 s and prints + acks. Exactly-once via `prep_tickets` rows (`order_id, printer_id, printed_at, device_id`) — a second till never reprints an acked ticket. Restaurant equivalent: `till_send_lock` (cloud-authoritative).
- **Reprint** prep ticket from Prep screen (🖨 on the order card) and Admin → Orders.
- **Label printers:** unchanged behaviour (OS-driver path), just listed in the same table.
- **Failure:** a prep printer that fails → red badge on the Prep screen "Prep printer offline — tickets held" + retry every 30 s; held tickets print in order when it returns; never blocks the sale.

## Admin → This device / Printers
- "Printers" card (shop-wide list): add (scan or manual) · job selector · test · status · categories (prep only) · remove.
- "This device" keeps: my receipt printer (dropdown from the list, job=receipt), cash drawer toggle, designated printing till toggle ("This till prints online orders' prep tickets").

## Acceptance
- [ ] Fresh shop: add 2 fake 9100 listeners as printers (receipt + prep) → sale with one prep item and one grocery item → receipt bytes on printer A, prep ticket bytes on printer B (only the prep item), drawer pulse only on A.
- [ ] Two devices in the rig → one sale → exactly one prep ticket (prep_tickets row) even with both polling.
- [ ] Online paid order → designated till prints the prep ticket within 10 s; non-designated till never does.
- [ ] Prep printer down → sale still 201, ticket held with badge, prints on recovery, once.
- [ ] Category routing: prep printer scoped to "Lunch boxes" ignores a bakery item; a second prep printer scoped to "Bakery" gets it.
- [ ] POST-001 label printer migrates into the list unchanged; labels still print.
- [ ] Render smoke on Device + Prep + Admin Orders.
