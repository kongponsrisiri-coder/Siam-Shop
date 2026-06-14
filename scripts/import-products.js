// SiamShop — import parsed supplier products into a shop.
// Reads scripts/products.json (from parse-xlsx.py), creates any missing
// categories, and upserts products (idempotent: skips by sku). Run against any
// database via DATABASE_URL:
//
//   DATABASE_URL=<railway-or-local-url> node scripts/import-products.js
//   (or: npm run import-products)

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const conn = process.env.DATABASE_URL || '';
if (!conn) { console.error('DATABASE_URL is required.'); process.exit(1); }
const useSSL = conn && !/@(localhost|127\.0\.0\.1)/.test(conn) && !/\.railway\.internal/.test(conn) && !/sslmode=disable/.test(conn);
const pool = new Pool({ connectionString: conn, ssl: useSSL ? { rejectUnauthorized: false } : false });

const SHOP_SLUG = process.env.DEFAULT_SHOP_SLUG || 'demo';
const DEFAULT_STOCK = Number(process.env.IMPORT_STOCK || 20);

async function main() {
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'products.json'), 'utf8'));

  const { rows: shopRows } = await pool.query(`SELECT id FROM shops WHERE slug = $1`, [SHOP_SLUG]);
  if (!shopRows[0]) { console.error(`No shop "${SHOP_SLUG}" — boot the server once first.`); process.exit(1); }
  const shopId = shopRows[0].id;

  // Category cache (create missing ones, appended after the seeded defaults).
  const { rows: catRows } = await pool.query(`SELECT id, name, sort_order FROM categories WHERE shop_id = $1`, [shopId]);
  const catId = new Map(catRows.map((c) => [c.name, c.id]));
  let nextSort = catRows.reduce((m, c) => Math.max(m, c.sort_order || 0), 0) + 1;
  async function ensureCategory(name) {
    if (catId.has(name)) return catId.get(name);
    const { rows } = await pool.query(
      `INSERT INTO categories (shop_id, name, sort_order) VALUES ($1,$2,$3)
       ON CONFLICT (shop_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [shopId, name, nextSort++]
    );
    catId.set(name, rows[0].id);
    console.log(`  + category: ${name}`);
    return rows[0].id;
  }

  let added = 0, skipped = 0;
  for (const p of items) {
    const dup = await pool.query(`SELECT 1 FROM products WHERE shop_id = $1 AND sku = $2`, [shopId, p.sku]);
    if (dup.rows[0]) { skipped++; continue; }
    const cId = await ensureCategory(p.category);
    await pool.query(
      `INSERT INTO products (shop_id, name, sku, price, cost_price, stock_qty, track_stock,
                             unit, category_id, is_active)
       VALUES ($1,$2,$3,$4,0,$5,TRUE,$6,$7,TRUE)`,
      [shopId, p.name, p.sku, p.price, DEFAULT_STOCK, p.unit || 'each', cId]
    );
    added++;
  }
  console.log(`\n✅ Import complete for "${SHOP_SLUG}": ${added} added, ${skipped} already present.`);
  await pool.end();
}

main().catch((e) => { console.error('Import failed:', e.message); process.exit(1); });
