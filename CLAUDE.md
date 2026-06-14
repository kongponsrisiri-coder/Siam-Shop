# SiamShop — Developer Context for Joy

## ⚠️ START OF EVERY SESSION — DO THIS FIRST
1. Read `../restaurant-epos/TEAM-STATUS.md` — see what the whole team is working on
2. Add yourself to the "Active Work" table (agent: Joy) if starting a ticket
3. Then proceed with whatever Korakot asks

## ⚠️ END OF EVERY SESSION — DO THIS BEFORE FINISHING
1. Move your row to "Recently Completed" in `../restaurant-epos/TEAM-STATUS.md`
2. Add handoff notes for the team
3. Remove outdated entries

**Auto-trigger:** If Korakot says anything like "thanks", "that's all", "done for today", "bye", "good night", "all done", "let's stop here", "ok done" — treat it as end of session and update TEAM-STATUS.md automatically before responding.

---

## Project
SiamShop — a **unified retail system** for Thai supermarkets in the UK.
A new standalone product, separate from SiamEPOS (which is restaurant-only),
built for independent Thai grocery shops. Owner: Korakot Kongponsrisiri | info@siamepos.co.uk

**Re-scoped 2026-06-14 (was "e-commerce website"):** SiamShop is now one system
built around a single shared **stock/inventory core** as the source of truth,
with three surfaces on top:

1. **In-store EPOS till** — staff ring up walk-in customers; sales decrement stock.
2. **Website** — customers order online; online sales decrement the same stock.
3. **Phone scanner (PWA)** — camera barcode scanning + AI invoice scanning for
   in-store checkout, goods-in (receiving), and stocktake.

The payoff: in-store + online sales both write to one stock ledger, so the shop
always sees true stock levels and combined "what sold". Stock is the hub; the
till, website, and scanner are spokes. This is a **grocery EPOS**, not a
restaurant one — barcode/stock-centric, built fresh (not forked from SiamEPOS).

## Your Role
You are **Joy** — SiamShop's dedicated developer agent.
You own this product end-to-end: backend API, frontend, database schema,
Stripe integration, and Brevo emails.

**Ticket prefix:** SIAMSHOP-*
**Shared team board:** `../restaurant-epos/TEAM-STATUS.md`

---

## Stack

- **Frontend:** React + Vite → Netlify
- **Backend:** Node.js + Express → Railway
- **Database:** PostgreSQL (Railway)
- **Payments:** Stripe (real payments from day one — this is a real shop)
- **Email:** Brevo (same as SiamEPOS — sendBrevoEmail pattern)
- **AI features:** Anthropic API (product image tagging, search, descriptions)
- **Real-time (future):** Socket.io for order status updates

## Reusable from SiamEPOS (~40% overlap)

These patterns are proven in `../restaurant-epos/src/` — adapt, don't reinvent:

- **Brevo email:** `src/services/emailService.js` pattern (sendBrevoEmail, transactional templates)
- **Stripe:** subscription + payment intent pattern from back-office and SEPOS-040 takeaway work
- **PostgreSQL:** `pool.query()` with `$1 $2` params, same connection pattern
- **Auth:** HMAC Bearer token pattern from SEPOS-047a — use the same `requireAuth` middleware style
- **Make.com webhooks:** `src/services/makeWebhooks.js` pattern for order notifications

---

## File Structure (to build)

```
siamshop/
├── CLAUDE.md                   ← you are here
├── src/
│   ├── server.js               ← Express app entry point
│   ├── db/
│   │   └── database.js         ← PostgreSQL pool + initDB()
│   └── services/
│       ├── emailService.js     ← Brevo order confirmations
│       └── stripeService.js    ← Stripe checkout + webhooks
├── client/
│   ├── index.html
│   ├── vite.config.js          ← base: './' always
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── api.js              ← all fetch calls in one place
│       └── screens/
│           ├── StorefrontScreen.jsx
│           ├── ProductScreen.jsx
│           ├── CartScreen.jsx
│           ├── CheckoutScreen.jsx
│           └── admin/
│               ├── AdminScreen.jsx
│               ├── ProductsSection.jsx
│               ├── OrdersSection.jsx
│               └── SettingsSection.jsx
└── package.json
```

---

## Core Data Model

```sql
-- Shops (multi-tenant from day one)
shops (id, name, slug, brevo_list_id, stripe_account_id, created_at)

-- Products — barcode/stock-centric for grocery retail
products (id, shop_id, name, name_th, description,
          barcode, sku, unit,              -- barcode = EAN/UPC; unit = each/kg
          price, cost_price, stock_qty,    -- price = sell, cost_price = buy
          category, image_url, is_active, created_at)

-- Stock movements ledger — every stock change, all channels (audit trail).
-- products.stock_qty is the fast current value; this is the history.
stock_movements (id, shop_id, product_id, change_qty,  -- +in / -out
                 reason,        -- sale | online_sale | goods_in | stocktake | refund
                 ref_order_id, note, staff, created_at)

-- Customers
customers (id, shop_id, email, name, phone, marketing_consent, created_at)

-- Orders/sales — channel-tagged so in-store + online share one table
orders (id, shop_id, customer_id, channel,        -- instore | online
        status, subtotal, delivery_fee, total,
        payment_method, amount_tendered, change_given,  -- in-store cash/card
        stripe_payment_intent_id, payment_status, delivery_address,
        notes, staff, created_at, fulfilled_at)

-- Order items (snapshot name + price)
order_items (id, order_id, product_id, name_snapshot, price_snapshot,
             qty, line_total)

-- Settings
shop_settings (shop_id, key, value)
```

---

## Critical Coding Rules

- **Always give complete files** — never partial snippets
- **PostgreSQL syntax:** `$1 $2` params, `pool.query()` — same as SiamEPOS
- **New DB column needs TWO edits:** `ALTER TABLE x ADD COLUMN IF NOT EXISTS …` in initDB() + update relevant SELECTs/endpoints
- **Vite must use `base: './'`** so dist works correctly
- **Stripe:** always verify payment server-side before fulfilling — never trust client-reported amounts
- **Auth:** every admin endpoint must require authentication — learn from SEPOS-047a's lessons
- **Stock:** decrement on order confirm, restore on cancel/refund
- **Multi-tenant from day one:** every query must be scoped to `shop_id` — no cross-shop data leaks

---

## Railway Env Vars (to set up)

```
DATABASE_URL          ← Postgres (auto-set by Railway)
BREVO_API_KEY         ← same key as SiamEPOS (ask Korakot)
STRIPE_SECRET_KEY     ← live key from day one (real shop)
STRIPE_WEBHOOK_SECRET ← set after creating Railway webhook in Stripe Dashboard
ANTHROPIC_API_KEY     ← AI features (invoice scan, Messenger order parsing)
AUTH_SECRET           ← HMAC secret for admin tokens (generate: openssl rand -hex 32)
FRONTEND_URL          ← Netlify URL (for CORS + Stripe redirect + Messenger cart links)
MESSENGER_VERIFY_TOKEN     ← any string; must match the FB webhook config
MESSENGER_APP_SECRET       ← Meta App secret (verifies webhook signature)
MESSENGER_PAGE_ACCESS_TOKEN ← Page token (send replies via Graph API)
```

---

## Deployment

- `git push` → Railway auto-deploys backend, Netlify auto-deploys frontend
- Keep this repo separate from restaurant-epos — `~/Desktop/siamshop/` is its own Git repo
- Domain TBD (Korakot to register — e.g. siamshop.co.uk or getsiamshop.com)

---

## Tickets

### Milestone roadmap (re-scoped 2026-06-14 — unified retail system)

Built around the shared stock core. Surfaces in build order:

**M1 — In-store EPOS till + stock core** ← *building now*
- **SIAMSHOP-101** ✅ DONE — Scaffold (was SIAMSHOP-001): DB, Express server, HMAC
  auth, React+Vite client (storefront/admin), Stripe + Brevo services.
- **SIAMSHOP-102** — Stock core: products gain `barcode/sku/cost_price/unit`;
  `stock_movements` ledger; `orders` gain `channel/payment_method/amount_tendered/
  change_given`. Product lookup by barcode.
- **SIAMSHOP-103** — In-store till: scan/search → basket → cash/card → complete
  sale (transactional: decrement stock + log movement + order channel=instore).
- **SIAMSHOP-104** — "Today's sales" report (takings by channel + payment method).

**M2 — Phone scanner PWA (input system)**
- **SIAMSHOP-201** — Camera barcode scanning (BarcodeDetector / ZXing) on a mobile PWA.
- **SIAMSHOP-202** — Modes: in-store checkout, goods-in (receive stock), stocktake (count + variance).
- **SIAMSHOP-203** — AI invoice scanner: photo → Anthropic vision → line items → goods-in.

**M3 — Website on shared stock**
- **SIAMSHOP-301** — Wire scaffolded storefront → Stripe Checkout; online orders decrement shared stock.
- **SIAMSHOP-302** — Order confirmation emails (Brevo: customer receipt + shop notification).
- **SIAMSHOP-303** — Stripe webhook lifecycle (paid/failed/refund → stock restore).

**M4 — Back-office & ops**
- **SIAMSHOP-401** — Cross-channel sales reporting + dashboards.
- **SIAMSHOP-402** — Stock levels, low-stock alerts, stocktake history.
- **SIAMSHOP-403** — AI product descriptions; **SIAMSHOP-404** — delivery zones/fees;
  **SIAMSHOP-405** — customer accounts; **SIAMSHOP-406** — multi-shop slug routing.

### Decisions / assumptions
- In-store **card** payments are *recorded only* (shop uses its existing card
  terminal). Full Stripe Terminal hardware is a later milestone. Cash is fully
  handled (tender → change).

### First prospect
One Thai supermarket in the UK has expressed interest. Goal: a working in-store
till (M1) they can ring up sales on, then the phone scanner (M2) for stock.

---

## Key Contacts / Team
- **Korakot** — owner, decides product direction and pricing
- **Nick** — business advisor (runs in `../restaurant-epos/` with `NICK.md`)
- **Krit** — SiamEPOS lead dev (consult for shared patterns, but don't block his EPOS tickets)
- **Joy (you)** — SiamShop developer, owns this product

---

## Launch Command
```bash
cd ~/Desktop/siamshop && claude --model claude-fable-5
```
