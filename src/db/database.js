// SiamShop — PostgreSQL pool + schema bootstrap.
// Mirrors the proven SiamEPOS pattern: a single shared pg Pool, $1/$2 params,
// and an idempotent initDB() that creates tables + runs ADD COLUMN IF NOT EXISTS
// migrations on every boot so deploys are safe to re-run.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL is not set — the database will not connect. Set it in .env (local) or Railway Variables.');
}

// Railway/managed Postgres requires SSL (with certs Node does not trust by
// default), but a local dev Postgres usually has SSL disabled. Enable SSL only
// for a remote DATABASE_URL so local development works without extra config.
const _conn = process.env.DATABASE_URL || '';
const _useSSL = _conn && !/@(localhost|127\.0\.0\.1)/.test(_conn);

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
    // orders: source is finer-grained than channel (instore|online). For online
    // orders, source distinguishes website|messenger|manual (Messenger bot, etc.).
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'website'`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatch_date DATE`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(120)`);

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
