# SiamShop M5 — Food counter on the grocery till (Cha & Pinto Box)

**Client:** Cha & Pinto Box, 16 London Rd, Guildford GU1 2AF · 01483 599499 · cha.and.pinto@gmail.com
(formerly Rumwong Thai Market — Surrey's first Asian supermarket, 1980s). Website today: Wix
(Wix Stores for ~299 grocery SKUs + Wix Restaurants for the café menu — **two separate carts**).

**Business shape:** Thai/Asian grocery (the bulk) + a grab-and-go café counter:
Thai lunch boxes (rice or noodle, Medium £8.95 / Large £9.95, "choice of 2 toppings", paid
add-ons £1.75–£2.25), nibbles, signature boba teas, croffles/desserts, small eat-in corner.
Lunch 12:00–15:00 Mon–Sat; boba/desserts 10:30–18:00 (Sun 10:30–17:00). Shop 09:30–18:00
Mon–Sat, 10:00–17:00 Sun & bank holidays. Pickup, delivery, dine-in, Too Good To Go bags.

**Goal of M5:** one till, one online shop, one stock ledger for BOTH sides — a customer buys a
lunch box and a bag of rice in one basket (their Wix site can't), and the owner sees one "what
sold" view. Built on the SiamShop stack (right-lane rule: it's a shop with a food counter, not
a restaurant — no tables, no courses, no kitchen stations).

**Author:** Joy · **Written:** 2026-09-06 · **Status:** proposed, awaiting Korakot's go.

---

## What already fits (no work)

- Grocery catalogue with barcodes, stock, goods-in, stocktake, phone scanner, invoice scan.
- Till (`/till`), storefront (`/shop`), categories, customer accounts, AI assistant, Messenger.
- `products.track_stock` already exists → made-to-order food is `track_stock = FALSE`.
- Wix Stores exports products as CSV → `scripts/import-products.js` pattern.
- Dine-in needs nothing: it's a channel/fulfilment tag, not table management.
- Too Good To Go stays external.

## Ticket map & order

| # | Ticket | Depends on | Est. |
|---|---|---|---|
| SIAMSHOP-501 | Product options (size / toppings / add-ons) | — | 4–5 d |
| SIAMSHOP-502 | Food items: `kind` flag + till honours `track_stock` (bug) | — | 0.5 d |
| SIAMSHOP-503 | Availability windows (lunch 12–3, boba hours) | 502 | 1–1.5 d |
| SIAMSHOP-504 | Click & Collect with pickup time + "Ready" notice | — | 2–3 d |
| SIAMSHOP-505 | Prep screen for the counter (`/prep`) | 501, 502, 504 | 2 d |
| SIAMSHOP-506 | Cha & Pinto onboarding: fork, brand, Wix import, menu build, go-live | all | 2–3 d |

Total ≈ 12–15 working days. 501 + 502 first (data model); 503/504 can run in parallel; 505
last before onboarding. Every DB change follows the CLAUDE.md rule: `ALTER TABLE … ADD COLUMN
IF NOT EXISTS` in `initDB()` **and** the SELECTs/endpoints. Every query stays `shop_id`-scoped.

---

## SIAMSHOP-501 — Product options (option groups + choices)

**Why:** "Medium/Large", "choice of 2 toppings", "add a fried egg", boba sugar/ice level.
SiamShop products are flat today; `order_items` snapshots only name + price.

**Data model**
```sql
product_option_groups (id, shop_id, product_id → products, name, name_th,
                       min_select INT DEFAULT 0, max_select INT DEFAULT 1,
                       sort_order INT DEFAULT 0)
product_options       (id, group_id → product_option_groups, name, name_th,
                       price_delta NUMERIC(10,2) DEFAULT 0, is_default BOOL DEFAULT FALSE,
                       is_active BOOL DEFAULT TRUE, sort_order INT DEFAULT 0)
order_items           + options_snapshot JSONB   -- [{group, name, price_delta}]
                      + options_total   NUMERIC(10,2) DEFAULT 0
```
Line price = `price_snapshot + options_total`; `line_total = (price + options_total) × qty`.
Size is just a group with `min 1 / max 1` and a £1.00 delta on Large — no separate variant table.

**Server**
- `GET /api/products`, `/api/products/:id`, admin products: include `option_groups[]` with
  `options[]` (one query with `json_agg`, not N+1).
- Admin CRUD: `PUT /api/admin/products/:id/options` replaces the whole option tree in one
  transaction (simplest to reason about; the tree is small).
- Item payload everywhere (`POST /api/sales`, `POST /api/checkout/session`, `POST /api/orders`,
  Messenger parse): `{ product_id, qty, option_ids: [] }`.
- **Authoritative pricing server-side**: validate every `option_id` belongs to that product
  and shop, enforce `min_select/max_select` per group, sum deltas. Never trust client prices
  (same rule as Stripe amounts).
- Receipts, order emails, admin order detail, `/order/:id` status page: print options under
  the item line (`Rice Lunch Box (Large) — Chilli Basil Pork, Panang Chicken`).

**Client**
- Till: tapping a product that has option groups opens a picker modal (big touch targets,
  required groups highlighted, running price). Basket lines keyed by `product_id + sorted
  option_ids` so two different builds don't merge.
- Storefront `ProductScreen` / cart: same picker; cart line shows chosen options.
- Admin `ProductsSection`: "Options" editor per product (add group → add choices → delta).
- AI assistant: only adds the product's default build; if a required group has no default,
  the assistant says "choose your toppings in the basket" — do not extend the tool schema now.

**Acceptance**
- Lunch box Medium + 2 toppings rings £8.95; Large + 2 toppings + fried egg rings £11.70.
- Sending a foreign/invalid `option_id`, or 3 toppings on a max-2 group → 400, nothing written.
- Options survive product rename/delete on historical orders (snapshot).
- A product with zero option groups behaves exactly as today (regression: existing till,
  checkout, Messenger flows unchanged; `option_ids` optional).

---

## SIAMSHOP-502 — Food items: `kind` flag + till honours `track_stock` (bug fix)

**Bug found while scoping:** `POST /api/sales` (`src/server.js` ~L1299–1345) checks
`p.stock_qty < qty` and decrements stock **regardless of `track_stock`**. A made-to-order
item with `track_stock = FALSE` and `stock_qty = 0` is rejected at the till with "Not enough
stock". `fulfilOrder()` (online path) already does it right (`AND track_stock = TRUE`).
Fix the class, not the instance: sweep every stock-decrement path (`/api/sales`,
`fulfilOrder`, cancel/refund restore) so all of them respect the flag.

**Model**
```sql
products + kind VARCHAR(20) NOT NULL DEFAULT 'retail'   -- retail | food
```
- `food` = made at the counter → shows on the prep screen (505), defaults `track_stock=FALSE`,
  can carry availability windows (503). `retail` = shelf stock, exactly as today.
- Admin product form: "Type: Shelf product / Made to order" toggle; picking "Made to order"
  flips `track_stock` off by default (still editable — boba cups do run out).
- Storefront/till: `food` items never show "out of stock" or stock counts.

**Acceptance**
- Till sells a `track_stock=FALSE` item at stock 0; no `stock_movements` row is written.
- Retail items still block at insufficient stock and still log movements.
- Cancel/refund of an order with a food line restores nothing for that line.

---

## SIAMSHOP-503 — Availability windows

**Why:** Lunch boxes only 12:00–15:00 Mon–Sat; boba 10:30–18:00 (Sun to 17:00). Outside the
window the site must not take the order; the owner shouldn't have to toggle items daily.

**Model** (category-level — matches how the shop thinks; product-level override optional later)
```sql
categories + availability JSONB   -- null = always. e.g.
-- {"tz":"Europe/London","rules":[{"days":[1,2,3,4,5,6],"from":"12:00","to":"15:00"}]}
shop_settings: opening_hours JSON (per weekday from/to), bank-holiday days honour Sunday hours
```
**Server**
- `GET /api/categories`, `/api/products`: add `available_now: bool` and `next_available:
  "Mon–Sat 12:00–15:00"` (computed in shop tz, never client clock).
- Checkout (`/api/checkout/session`, `/api/orders`): reject unavailable items with 409 and a
  clear message. When the order has a pickup time (504), evaluate the window **at the pickup
  time**, not "now" — so a 10:00 pre-order of lunch for 12:30 is allowed.
- Shop closed (outside `opening_hours`) → storefront banner "Not accepting orders — opens
  Mon 09:30", checkout disabled, **except** scheduled pickups within opening hours.
- Till: warning only ("Lunch menu is 12–3"), never blocking — staff decide.

**Acceptance**
- 16:00 Tuesday: lunch boxes greyed with "Available Mon–Sat 12:00–15:00"; boba addable.
- 10:00 Tuesday with pickup 12:30 selected: lunch box addable and accepted.
- Sunday: lunch category hidden/greyed all day; shop hours show 10:00–17:00.
- Clocks: checked against `Europe/London` including BST — test with a fixed-clock unit test.

---

## SIAMSHOP-504 — Click & Collect with pickup time + "Ready" notice

**Why:** Their Wix flow offers Pickup / Delivery / Dine-In with "Schedule Pickup Time".
Our checkout only knows delivery (address + postcode required; `deliveryQuote` by postcode).

**Model**
```sql
orders + fulfilment VARCHAR(20) NOT NULL DEFAULT 'delivery'   -- delivery | collection | dine_in
       + pickup_at  TIMESTAMPTZ
       + ready_at   TIMESTAMPTZ
shop_settings: collection_enabled (bool), pickup_lead_minutes (default 20),
               pickup_slot_minutes (default 15), collection_address (text)
```
**Server**
- `GET /api/pickup-slots` → ASAP + slots from now+lead to closing, stepped by slot size,
  within `opening_hours` (503); today and tomorrow.
- Checkout: `fulfilment=collection` → no address, `delivery_fee = 0`, `pickup_at` required
  (server re-validates slot is still valid). `dine_in` is till-only (staff picks it).
- New status `ready` between `paid` and `completed`. `POST /api/admin/orders/:id/ready` →
  sets `ready_at`, emails the customer via Brevo ("Your order is ready to collect at 16
  London Rd") — reuse `emailService` transactional pattern, `FROM_EMAIL=info@siamepos.co.uk`.
- `POST /api/admin/orders/:id/collected` → `completed`, `fulfilled_at`.
- Admin Orders: fulfilment badge, "Collections today" filter sorted by `pickup_at`.
- Order status page + confirmation email show pickup time and address instead of delivery.

**Acceptance**
- Collection order: total = subtotal, no address stored, `pickup_at` inside opening hours.
- Slot 10 minutes from now rejected (lead is 20).
- Marking Ready sends exactly one email (idempotent on repeat click).
- Existing delivery orders untouched (default `delivery`).

---

## SIAMSHOP-505 — Prep screen for the counter (`/prep`)

**Why:** A lunch box ordered online at 11:50 for 12:30 pickup, or rung up at the till, has to
reach the person cooking. Nothing does that today.

**Scope**
- Route `/prep` (staff auth, same token as till). One column of tickets, newest at the bottom,
  each: order #, channel (till / online / Messenger), fulfilment + `pickup_at` (or "now"),
  customer first name, the **food lines with options**, notes. Grocery lines collapsed to
  "+ 3 grocery items" (counter doesn't need them).
- Only orders containing ≥1 `kind='food'` line and status in `paid | preparing | ready`
  (till sales are `completed` on payment → include `completed` instore orders from the last
  60 min that have food lines and no `ready_at`).
- Buttons: **Start** (`preparing`) → **Ready** (→ 504 `ready` + email if collection) →
  **Done**. Colour by age: green <5 min, amber <10, red after.
- Polling every 10 s (`GET /api/prep?since=`); chime on new ticket. Socket.io later.
- Print: `@media print` 80 mm ticket CSS + a "Print" button — a browser-printed slip to any
  receipt printer that has a driver. No ESC/POS in this ticket.
- Big-touch, tablet landscape, works on the till iPad/phone.

**Acceptance**
- Till sale with a lunch box appears within 10 s with size + toppings readable.
- Online pre-order for 12:30 shows the pickup time prominently and sorts by it.
- Pure-grocery order never appears.
- Ready on a collection order fires the 504 email once.

---

## SIAMSHOP-506 — Cha & Pinto onboarding: fork, brand, Wix import, menu build, go-live

**Deploy (same pattern as Thann Shop / Thai Tana)**
1. New GitHub repo `chapinto-shop` under kongponsrisiri-coder, forked from main SiamShop
   **after** 501–505 land. New Railway project "Cha & Pinto" (service + Postgres), generate a
   domain **after** the first deploy (Maya's gotcha: pre-deploy domains get `targetPort:null`).
2. Env checklist: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `AUTH_SECRET` (long random),
   `ADMIN_PASSWORD`, `DEFAULT_SHOP_SLUG=chapinto`, `FRONTEND_URL`, `BREVO_API_KEY`,
   `FROM_EMAIL=info@siamepos.co.uk`, `ANTHROPIC_API_KEY` (own key), Stripe **live** keys from
   the client's own Stripe account (real shop, real payments) + webhook secret after creating
   the Railway webhook. Korakot pastes secrets; I generate + verify.
3. Re-skin via `styles.css :root` variables only (keep var names). Colours/logo from the
   client's real brand files — **never redraw their wordmark** (Maya's Juicery lesson).
   Favicon/manifest/title from their assets.

**Data**
4. Wix Stores → Settings → Export products CSV. Map: name, price, SKU, weight, category
   (Drinks · Japanese · Korean · Noodles · Rice · Snacks · Spices · Other Asian Ingredients),
   image URL (download → `POST /api/admin/products/:id/photo` via a one-off script), stock.
   Barcodes: Wix export has none → scan-to-assign at the shop with the PWA (`/scan` goods-in
   already looks products up by barcode; add a "assign this barcode to product X" affordance
   if missing — small).
5. Menu build (via 501/502/503): categories **Thai Lunch Box** (12–3 Mon–Sat), **Boba Teas**,
   **Desserts**, **Nibbles**. Products: Rice Lunch Box (Size M/L; Toppings min2 max2; Add-ons
   0–3), Pud-Thai / Drunken Noodle boxes (same), Chilli Basil Pork Noodle £8.95, gyoza £4.50,
   spring rolls £4.50, prawn crackers £4.75, boba menu once the client sends it (the Wix menu
   page doesn't list boba items — ask for their counter menu card).
6. Photo Studio session at the shop for anything Wix had no image for.

**Cut-over**
7. Run on the Railway URL first; staff use `/till` + `/prep` in-store while Wix stays live.
8. When happy: point `chapintobox.co.uk` at Railway (custom domain), switch Wix ordering off.
   Keep Too Good To Go as-is. Give the owner the DEMO.md-style one-pager for staff.

**Acceptance**
- 299 products imported with categories and prices matching a spot check of 20 against Wix.
- A test basket of "Large lunch box + 2 toppings + Tiparos fish sauce" completes as one order
  at the till and as one collection order online, appears once on `/prep`, and decrements
  fish sauce stock by 1 only.
- Health `db:ok`, Stripe `configured`, test email delivered, admin login works.

---

## Out of scope (say no politely)

- Table management, courses, kitchen stations, split bills → SiamEPOS territory.
- Deliveroo / Uber Eats / Too Good To Go integrations.
- Loyalty/stamps (SiamShop-wide, own ticket later).
- ESC/POS thermal printing (browser print only in M5).
- Stripe Terminal card hardware (card stays "recorded only" at the till).

## Open questions for the client (via Korakot)
1. Boba menu: items, sizes, sugar/ice levels, toppings and prices (not on the website).
2. Do they deliver themselves? Radius and fee, or collection-only online?
3. Brand files: logo (vector), colours, fonts. Who owns the Wix account/domain DNS?
4. Do they have a Stripe account, or do we help set one up?
5. Card terminal in use today (so till "card" matches their settlement reports).
6. How many staff need till/prep logins; one shared PIN or named accounts?
