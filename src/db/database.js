// SiamShop — PostgreSQL pool + schema bootstrap.
// Mirrors the proven SiamEPOS pattern: a single shared pg Pool, $1/$2 params,
// and an idempotent initDB() that creates tables + runs ADD COLUMN IF NOT EXISTS
// migrations on every boot so deploys are safe to re-run.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL is not set — the database will not connect. Set it in .env (local) or Railway Variables.');
}

// SSL policy: managed/public Postgres needs SSL (with certs Node doesn't trust
// by default), but local dev AND Railway's private network (*.railway.internal)
// are plaintext — forcing SSL there throws "server does not support SSL
// connections". So enable SSL only when it's a remote, non-internal host (and
// honour an explicit sslmode=disable).
const _conn = process.env.DATABASE_URL || '';
const _noSSL =
  !_conn ||
  /@(localhost|127\.0\.0\.1)/.test(_conn) ||
  /\.railway\.internal/.test(_conn) ||
  /[?&]sslmode=disable/.test(_conn);
const _useSSL = Boolean(_conn) && !_noSSL;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: _useSSL ? { rejectUnauthorized: false } : false,
  min: 2,
  max: 10,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', (client) => {
  client.query("SET timezone='UTC'").catch(() => {});
});

pool.on('error', (err) => {
  console.error('[db] unexpected idle client error:', err.message);
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
async function initDB() {
  try {
    // Shops — multi-tenant from day one. Every other table scopes to shop_id.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shops (
        id                SERIAL PRIMARY KEY,
        name              VARCHAR(200) NOT NULL,
        slug              VARCHAR(120) UNIQUE NOT NULL,
        brevo_list_id     INTEGER,
        stripe_account_id VARCHAR(120),
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Categories — per-shop, bilingual, manually orderable (self-service admin).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id          SERIAL PRIMARY KEY,
        shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        name        VARCHAR(120) NOT NULL,
        name_th     VARCHAR(120),
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (shop_id, name)
      )
    `);

    // Products — barcode/stock-centric for grocery retail
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id          SERIAL PRIMARY KEY,
        shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        name        VARCHAR(300) NOT NULL,
        name_th     VARCHAR(300),
        description TEXT,
        barcode     VARCHAR(64),                          -- EAN/UPC; unique per shop (see index)
        sku         VARCHAR(64),
        unit        VARCHAR(20) NOT NULL DEFAULT 'each',  -- each | kg | g | pack | bottle ...
        price       NUMERIC(10,2) NOT NULL DEFAULT 0,     -- sell price
        cost_price  NUMERIC(10,2) NOT NULL DEFAULT 0,     -- buy price (for margin)
        stock_qty   INTEGER NOT NULL DEFAULT 0,
        category    VARCHAR(120),
        image_url   TEXT,
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Customers
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id                 SERIAL PRIMARY KEY,
        shop_id            INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        email              VARCHAR(300) NOT NULL,
        name               VARCHAR(200),
        phone              VARCHAR(50),
        marketing_consent  BOOLEAN NOT NULL DEFAULT FALSE,
        created_at         TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (shop_id, email)
      )
    `);

    // Orders / sales — channel-tagged so in-store + online share one table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id                        SERIAL PRIMARY KEY,
        shop_id                   INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        customer_id               INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        channel                   VARCHAR(20) NOT NULL DEFAULT 'online',  -- instore | online
        status                    VARCHAR(40) NOT NULL DEFAULT 'pending',
        subtotal                  NUMERIC(10,2) NOT NULL DEFAULT 0,
        delivery_fee              NUMERIC(10,2) NOT NULL DEFAULT 0,
        total                     NUMERIC(10,2) NOT NULL DEFAULT 0,
        payment_method            VARCHAR(20),            -- cash | card (in-store)
        amount_tendered           NUMERIC(10,2),          -- cash given by customer
        change_given              NUMERIC(10,2),          -- change handed back
        staff                     VARCHAR(120),           -- who rang it up
        stripe_payment_intent_id  VARCHAR(120),
        payment_status            VARCHAR(40) NOT NULL DEFAULT 'unpaid',
        delivery_address          TEXT,
        notes                     TEXT,
        created_at                TIMESTAMPTZ DEFAULT NOW(),
        fulfilled_at              TIMESTAMPTZ
      )
    `);

    // Order items — snapshot name + price so historical orders stay correct
    // even if the product is later renamed, repriced, or deleted.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id              SERIAL PRIMARY KEY,
        order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
        name_snapshot   VARCHAR(300) NOT NULL,
        price_snapshot  NUMERIC(10,2) NOT NULL,
        qty             INTEGER NOT NULL,
        line_total      NUMERIC(10,2) NOT NULL
      )
    `);

    // Stock movements ledger — every stock change, all channels (audit trail).
    // products.stock_qty is the fast current value; this is the history of how
    // it got there. reason: sale | online_sale | goods_in | stocktake | refund.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_movements (
        id            SERIAL PRIMARY KEY,
        shop_id       INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
        change_qty    INTEGER NOT NULL,          -- positive = in, negative = out
        reason        VARCHAR(30) NOT NULL,
        ref_order_id  INTEGER REFERENCES orders(id) ON DELETE SET NULL,
        note          TEXT,
        staff         VARCHAR(120),
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Per-shop settings — flexible key/value
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_settings (
        shop_id  INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        key      VARCHAR(120) NOT NULL,
        value    TEXT,
        PRIMARY KEY (shop_id, key)
      )
    `);

    // --- Migrations (ADD COLUMN IF NOT EXISTS) — keep existing DBs in sync ---
    // SIAMSHOP-102: grocery/stock fields. Safe to run every boot.
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode VARCHAR(64)`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sku VARCHAR(64)`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS unit VARCHAR(20) NOT NULL DEFAULT 'each'`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price NUMERIC(10,2) NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'online'`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount_tendered NUMERIC(10,2)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS change_given NUMERIC(10,2)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS staff VARCHAR(120)`);

    // SIAMSHOP-002/003 (Nick's brief): online-shop fields.
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS description_th TEXT`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS track_stock BOOLEAN NOT NULL DEFAULT TRUE`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_grams INTEGER`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL`);
    // Product photos captured in the back office are stored in-DB (bytea) and
    // served at /img/product/:id — self-contained, survives redeploys, no S3.
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_data BYTEA`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_mime VARCHAR(40)`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_updated_at TIMESTAMPTZ`);
    // orders: source is finer-grained than channel (instore|online). For online
    // orders, source distinguishes website|messenger|manual (Messenger bot, etc.).
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'website'`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatch_date DATE`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(120)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS carrier VARCHAR(40)`);
    // SIAMSHOP-006: customer accounts (password optional — set when they register).
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT`);

    // Back-in-stock notify-me requests (SIAMSHOP-010).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_notifications (
        id          SERIAL PRIMARY KEY,
        shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        email       VARCHAR(300) NOT NULL,
        notified_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (product_id, email)
      )
    `);

    // SIAMSHOP-501 — product options (size / toppings / add-ons). A group is a
    // question ("Size", "Toppings"); options are the answers, each with a price
    // delta on top of products.price. Cascade with the product; orders keep a
    // JSON snapshot so history survives edits/deletes.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_option_groups (
        id          SERIAL PRIMARY KEY,
        shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        name        VARCHAR(120) NOT NULL,
        name_th     VARCHAR(120),
        min_select  INTEGER NOT NULL DEFAULT 0,
        max_select  INTEGER NOT NULL DEFAULT 1,
        sort_order  INTEGER NOT NULL DEFAULT 0
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_options (
        id           SERIAL PRIMARY KEY,
        group_id     INTEGER NOT NULL REFERENCES product_option_groups(id) ON DELETE CASCADE,
        name         VARCHAR(120) NOT NULL,
        name_th      VARCHAR(120),
        price_delta  NUMERIC(10,2) NOT NULL DEFAULT 0,
        is_default   BOOLEAN NOT NULL DEFAULT FALSE,
        is_active    BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order   INTEGER NOT NULL DEFAULT 0
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_option_groups_product ON product_option_groups(product_id, sort_order)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_options_group ON product_options(group_id, sort_order)`);
    // order_items: chosen options (snapshot) + their per-unit total.
    // line_total = (price_snapshot + options_total) * qty.
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS options_snapshot JSONB`);
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS options_total NUMERIC(10,2) NOT NULL DEFAULT 0`);
    // SIAMSHOP-502 — retail (shelf stock) vs food (made to order at the counter).
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'retail'`);

    // SIAMSHOP-503 — per-category availability windows (null = always).
    await pool.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS availability JSONB`);
    // SIAMSHOP-504 — fulfilment: delivery | collection | dine_in | takeaway; pickup slot; ready-for-collection time.
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfilment VARCHAR(20) NOT NULL DEFAULT 'delivery'`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ`);
    // SIAMSHOP-505 — counter prep state: null (new) | preparing | ready | done.
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS prep_status VARCHAR(20)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_prep ON orders(shop_id, created_at DESC) WHERE prep_status IS DISTINCT FROM 'done'`);

    // SIAMSHOP-ELECTRON-001 — staff with PIN sign-in. Roles: manager (everything),
    // cashier (till + prep + stock), prep (prep screen only). PINs are scrypt-hashed;
    // orders.staff is written from the signed-in session, never typed.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS staff (
        id          SERIAL PRIMARY KEY,
        shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        name        VARCHAR(120) NOT NULL,
        pin_hash    TEXT NOT NULL,
        role        VARCHAR(20) NOT NULL DEFAULT 'cashier',
        active      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_staff_shop ON staff(shop_id, active)`);
    // O(1) PIN lookup: HMAC(AUTH_SECRET, shop:pin). Unique per shop = PIN uniqueness at the DB level.
    await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS pin_lookup TEXT`);
    // First-time PIN (Korakot 7 Sep): a fresh shop accepts 2526 once, then must change it.
    await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS must_change_pin BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_pin_lookup ON staff(shop_id, pin_lookup) WHERE pin_lookup IS NOT NULL`);

    // SIAMSHOP-POST-001 — parcel label printed (postal orders).
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS label_printed_at TIMESTAMPTZ`);

    // SIAMSHOP-TILL-001 — till sessions (shift open → cash-up → Z report).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS till_sessions (
        id             SERIAL PRIMARY KEY,
        shop_id        INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        status         VARCHAR(10) NOT NULL DEFAULT 'open',   -- open | closed
        opened_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        opened_by      VARCHAR(120),
        opened_by_sid  INTEGER,
        float_amount   NUMERIC(10,2) NOT NULL DEFAULT 0,
        closed_at      TIMESTAMPTZ,
        closed_by      VARCHAR(120),
        closed_by_sid  INTEGER,
        expected_cash  NUMERIC(10,2),
        counted_cash   NUMERIC(10,2),
        variance       NUMERIC(10,2),
        notes          TEXT,
        summary        JSONB                                   -- Z report snapshot at close
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_till_sessions_open ON till_sessions(shop_id) WHERE status = 'open'`);
    // Opened automatically by the first sale of the day (no float yet) — Till prompts for the float.
    await pool.query(`ALTER TABLE till_sessions ADD COLUMN IF NOT EXISTS auto_opened BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_till_sessions_shop ON till_sessions(shop_id, opened_at DESC)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES till_sessions(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id)`);

    // SIAMSHOP-CLOCK-001 — staff clock in/out events (paired into shifts client-side).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clock_events (
        id          SERIAL PRIMARY KEY,
        shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        staff_id    INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
        event_type  VARCHAR(3) NOT NULL,                 -- in | out
        event_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_clock_events_staff_at ON clock_events(staff_id, event_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_clock_events_shop_at ON clock_events(shop_id, event_at)`);

    // SIAMSHOP-DISCOUNT-001 — line + basket discounts with a reason (server-priced).
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS discount_type VARCHAR(10)`); // percent | fixed
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS discount_value NUMERIC(10,2)`);
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS discount_reason VARCHAR(80)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_type VARCHAR(10)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_value NUMERIC(10,2)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0`); // basket + line discounts, total £ off
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_reason VARCHAR(80)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_approved_by VARCHAR(120)`);

    // SIAMSHOP-REFUND-001 — refunds (full/partial, with reason + stock action) and voids before payment.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS refunds (
        id           SERIAL PRIMARY KEY,
        shop_id      INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        session_id   INTEGER REFERENCES till_sessions(id) ON DELETE SET NULL,
        staff        VARCHAR(120),
        approved_by  VARCHAR(120),
        reason       VARCHAR(80) NOT NULL,
        method       VARCHAR(20) NOT NULL,          -- cash | card | stripe
        amount       NUMERIC(10,2) NOT NULL,
        stock_action VARCHAR(10) NOT NULL,          -- restock | writeoff
        stripe_refund_id VARCHAR(120),
        note         TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS refund_items (
        id             SERIAL PRIMARY KEY,
        refund_id      INTEGER NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
        order_item_id  INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
        qty            INTEGER NOT NULL,
        amount         NUMERIC(10,2) NOT NULL
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_refunds_shop_at ON refunds(shop_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(10,2) NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS refunded_qty INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS void_log (
        id          SERIAL PRIMARY KEY,
        shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        session_id  INTEGER REFERENCES till_sessions(id) ON DELETE SET NULL,
        staff       VARCHAR(120),
        product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
        name        VARCHAR(300),
        qty         INTEGER NOT NULL,
        amount      NUMERIC(10,2) NOT NULL DEFAULT 0,
        reason      VARCHAR(80) NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_void_log_shop_at ON void_log(shop_id, created_at DESC)`);

    // SIAMSHOP-CRM-001 — customers become a CRM: operator-managed consent with
    // source + time, one-click unsubscribe, birthday (MM-DD, no year), walk-in
    // customers without an email (phone only), campaign log, automation fires.
    await pool.query(`ALTER TABLE customers ALTER COLUMN email DROP NOT NULL`).catch(() => {});
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS consent_source VARCHAR(40)`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS birthday VARCHAR(5)`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_shop_phone ON customers(shop_id, phone)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id              SERIAL PRIMARY KEY,
        shop_id         INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        subject         VARCHAR(500) NOT NULL,
        body            TEXT NOT NULL,
        segment         VARCHAR(80) NOT NULL,
        recipient_count INTEGER NOT NULL DEFAULT 0,
        sent_count      INTEGER NOT NULL DEFAULT 0,
        failed_count    INTEGER NOT NULL DEFAULT 0,
        is_test         BOOLEAN NOT NULL DEFAULT FALSE,
        created_by      VARCHAR(120),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_campaigns_shop_at ON campaigns(shop_id, created_at DESC)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS automation_fires (
        id          SERIAL PRIMARY KEY,
        shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        event_type  VARCHAR(40) NOT NULL,      -- lapsed | review | birthday
        entity_key  VARCHAR(120) NOT NULL,     -- customer:<id> | order:<id> | customer:<id>:<year>
        customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        sent        BOOLEAN NOT NULL DEFAULT FALSE,
        error       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (shop_id, event_type, entity_key)
      )
    `);

    // SIAMSHOP-PRINTERS-001 — shop-wide printers with jobs + exactly-once prep tickets.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS printers (
        id              SERIAL PRIMARY KEY,
        shop_id         INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        name            VARCHAR(100) NOT NULL,
        kind            VARCHAR(10) NOT NULL DEFAULT 'network',   -- network | usb
        ip              VARCHAR(64),
        port            INTEGER NOT NULL DEFAULT 9100,
        lpr_queue       VARCHAR(64),
        usb_name        VARCHAR(200),
        model           VARCHAR(120),
        job             VARCHAR(10) NOT NULL DEFAULT 'receipt',   -- receipt | prep | label
        prep_categories INTEGER[] NOT NULL DEFAULT '{}',          -- prep only; empty = all made-to-order items
        active          BOOLEAN NOT NULL DEFAULT TRUE,
        last_test_at    TIMESTAMPTZ,
        last_test_ok    BOOLEAN,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_printers_shop ON printers(shop_id, active)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS prep_tickets (
        id               SERIAL PRIMARY KEY,
        shop_id          INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        printer_id       INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
        seq              INTEGER NOT NULL DEFAULT 0,             -- 0 = original, 1.. = reprints
        status           VARCHAR(10) NOT NULL DEFAULT 'queued',  -- queued | printing | printed | failed
        origin_device_id VARCHAR(64),                            -- the till that took the payment (NULL = online)
        device_id        VARCHAR(64),                            -- who claimed / printed it
        attempts         INTEGER NOT NULL DEFAULT 0,
        last_error       TEXT,
        claimed_at       TIMESTAMPTZ,
        printed_at       TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (shop_id, order_id, printer_id, seq)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_prep_tickets_open ON prep_tickets(shop_id, status, created_at) WHERE status <> 'printed'`);

    // Helpful indexes for the hot paths.
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_id, is_active)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_moves_shop ON stock_movements(shop_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_moves_product ON stock_movements(product_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_categories_shop ON categories(shop_id, sort_order)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_notif_product ON stock_notifications(product_id) WHERE notified_at IS NULL`);
    // Barcode lookup must be fast and unique within a shop (partial: only when set).
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode ON products(shop_id, barcode) WHERE barcode IS NOT NULL`);

    await seedDefaultShop();

    console.log('✅ Database ready');
  } catch (err) {
    console.error('❌ Database init error:', err.message);
  }
}

// The 13 default categories for a Thai grocery (from Nick's brief, modelled on
// Raan Nuch). Seeded per shop; the owner can edit/add/remove them in admin.
const DEFAULT_CATEGORIES = [
  ['Fresh Fruits', 'ผลไม้สด'],
  ['Fresh Vegetables', 'ผักสด'],
  ['Preserved Fruits & Vegetables', 'ผักผลไม้ดอง'],
  ['Desserts, Snacks & Drinks', 'ขนมและเครื่องดื่ม'],
  ['Sauces & Seasonings', 'ซอสและเครื่องปรุง'],
  ['Fish & Meat Products', 'ปลาและเนื้อสัตว์'],
  ['Curry Paste & Chilli Products', 'พริกแกงและพริก'],
  ['Rice, Noodles & Flour', 'ข้าว เส้น และแป้ง'],
  ['Household Essentials', 'ของใช้ในบ้าน'],
  ['Ready Meals', 'อาหารพร้อมทาน'],
  ['Beauty Products', 'ผลิตภัณฑ์ความงาม'],
  ['Vegetarian Food', 'อาหารเจ'],
];

// Sensible default shop settings (overridable in admin). Values are strings.
const DEFAULT_SETTINGS = {
  minimum_order_amount: '30.00',
  delivery_fee_london: '7.95',
  delivery_fee_mainland: '8.95',
  delivery_fee_remote: '14.95',
  restock_day: 'Monday',
  currency: 'GBP',
  shop_language_default: 'en',
};

// Seed a single default shop for the demo, plus its categories and settings.
async function seedDefaultShop() {
  const slug = process.env.DEFAULT_SHOP_SLUG || 'demo';
  const name = process.env.DEFAULT_SHOP_NAME || 'SiamShop Demo';
  const { rows } = await pool.query(
    `INSERT INTO shops (name, slug)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
     RETURNING id`,
    [name, slug]
  );
  const shopId = rows[0].id;

  for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
    const [cn, cth] = DEFAULT_CATEGORIES[i];
    await pool.query(
      `INSERT INTO categories (shop_id, name, name_th, sort_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (shop_id, name) DO NOTHING`,
      [shopId, cn, cth, i]
    );
  }

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query(
      `INSERT INTO shop_settings (shop_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (shop_id, key) DO NOTHING`,
      [shopId, key, value]
    );
  }
}

// Resolve a shop id from its slug. Returns null if not found.
async function getShopIdBySlug(slug) {
  const { rows } = await pool.query(`SELECT id FROM shops WHERE slug = $1`, [slug]);
  return rows[0]?.id ?? null;
}

module.exports = { pool, initDB, getShopIdBySlug };
