// SiamShop — PostgreSQL pool + schema bootstrap.
// Mirrors the proven SiamEPOS pattern: a single shared pg Pool, $1/$2 params,
// and an idempotent initDB() that creates tables + runs ADD COLUMN IF NOT EXISTS
// migrations on every boot so deploys are safe to re-run.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL is not set — the database will not connect. Set it in .env (local) or Railway Variables.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway Postgres requires SSL but uses certs Node does not trust by default.
  ssl: { rejectUnauthorized: false },
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

    // Products
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id          SERIAL PRIMARY KEY,
        shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        name        VARCHAR(300) NOT NULL,
        name_th     VARCHAR(300),
        description TEXT,
        price       NUMERIC(10,2) NOT NULL DEFAULT 0,
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

    // Orders
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id                        SERIAL PRIMARY KEY,
        shop_id                   INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        customer_id               INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        status                    VARCHAR(40) NOT NULL DEFAULT 'pending',
        subtotal                  NUMERIC(10,2) NOT NULL DEFAULT 0,
        delivery_fee              NUMERIC(10,2) NOT NULL DEFAULT 0,
        total                     NUMERIC(10,2) NOT NULL DEFAULT 0,
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

    // Per-shop settings — flexible key/value
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_settings (
        shop_id  INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        key      VARCHAR(120) NOT NULL,
        value    TEXT,
        PRIMARY KEY (shop_id, key)
      )
    `);

    // Helpful indexes for the hot paths (storefront listing, admin order list).
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_id, is_active)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)`);

    // --- Migrations (ADD COLUMN IF NOT EXISTS) go here as the schema evolves ---
    // Example for future tickets:
    // await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS unit VARCHAR(40)`);

    await seedDefaultShop();

    console.log('✅ Database ready');
  } catch (err) {
    console.error('❌ Database init error:', err.message);
  }
}

// Seed a single default shop for the demo so the storefront has somewhere to
// hang products before multi-shop onboarding (SIAMSHOP-010) exists.
async function seedDefaultShop() {
  const slug = process.env.DEFAULT_SHOP_SLUG || 'demo';
  const name = process.env.DEFAULT_SHOP_NAME || 'SiamShop Demo';
  await pool.query(
    `INSERT INTO shops (name, slug)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO NOTHING`,
    [name, slug]
  );
}

// Resolve a shop id from its slug. Returns null if not found.
async function getShopIdBySlug(slug) {
  const { rows } = await pool.query(`SELECT id FROM shops WHERE slug = $1`, [slug]);
  return rows[0]?.id ?? null;
}

module.exports = { pool, initDB, getShopIdBySlug };
