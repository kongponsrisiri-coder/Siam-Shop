// SiamShop — demo catalogue seeder.
// Loads a realistic spread of Thai-grocery products into the default shop so a
// client demo looks full instead of empty. Idempotent (skips products that
// already exist by name). Run against any database via DATABASE_URL:
//
//   DATABASE_URL=<railway-or-local-url> node scripts/seed-demo.js
//   (or: npm run seed)

const { Pool } = require('pg');

const conn = process.env.DATABASE_URL || '';
if (!conn) {
  console.error('DATABASE_URL is required. e.g. DATABASE_URL=postgres://… node scripts/seed-demo.js');
  process.exit(1);
}
const useSSL = conn && !/@(localhost|127\.0\.0\.1)/.test(conn);
const pool = new Pool({ connectionString: conn, ssl: useSSL ? { rejectUnauthorized: false } : false });

const SHOP_SLUG = process.env.DEFAULT_SHOP_SLUG || 'demo';

// [name, name_th, category, price, stock, unit, barcode, weight_grams, description]
const PRODUCTS = [
  ['Jasmine Rice 5kg', 'ข้าวหอมมะลิ 5กก.', 'Rice, Noodles & Flour', 12.99, 40, 'each', '8851111000011', 5000, 'Premium Thai Hom Mali fragrant rice.'],
  ['Sticky Rice 1kg', 'ข้าวเหนียว 1กก.', 'Rice, Noodles & Flour', 3.49, 60, 'each', '8851111000028', 1000, 'Long-grain glutinous rice for sticky rice dishes.'],
  ['Pad Thai Rice Noodles 375g', 'เส้นจันท์ผัดไทย', 'Rice, Noodles & Flour', 2.49, 120, 'pack', '8851111000035', 375, 'Flat rice noodles for authentic pad thai.'],
  ['Vermicelli Glass Noodles 100g', 'วุ้นเส้น', 'Rice, Noodles & Flour', 1.20, 90, 'pack', '8851111000042', 100, 'Mung-bean glass noodles for yum woon sen.'],
  ['Mae Ploy Red Curry Paste 400g', 'พริกแกงเผ็ดแม่พลอย', 'Curry Paste & Chilli Products', 3.20, 60, 'each', '8851111000059', 400, 'Authentic Thai red curry paste.'],
  ['Mae Ploy Green Curry Paste 400g', 'พริกแกงเขียวหวานแม่พลอย', 'Curry Paste & Chilli Products', 3.20, 55, 'each', '8851111000066', 400, 'Fragrant green curry paste with Thai basil notes.'],
  ['Roasted Chilli Paste (Nam Prik Pao) 220g', 'น้ำพริกเผา', 'Curry Paste & Chilli Products', 2.80, 40, 'each', '8851111000073', 220, 'Sweet roasted chilli jam for tom yum and stir-fries.'],
  ['Coconut Milk 400ml', 'กะทิ', 'Sauces & Seasonings', 1.49, 200, 'can', '8851111000080', 400, 'Rich coconut milk for curries and desserts.'],
  ['Fish Sauce 700ml', 'น้ำปลา', 'Sauces & Seasonings', 2.95, 80, 'bottle', '8851111000097', 700, 'Premium Thai fish sauce.'],
  ['Oyster Sauce 510g', 'ซอสหอยนางรม', 'Sauces & Seasonings', 2.60, 70, 'bottle', '8851111000103', 510, 'Thick oyster sauce for stir-fries.'],
  ['Palm Sugar 454g', 'น้ำตาลปี๊บ', 'Sauces & Seasonings', 2.40, 50, 'each', '8851111000110', 454, 'Natural palm sugar for Thai cooking.'],
  ['Singha Beer 330ml', 'เบียร์สิงห์', 'Desserts, Snacks & Drinks', 1.80, 96, 'bottle', '8850999320014', 330, 'Thailand’s classic lager.'],
  ['Thai Milk Tea 3-in-1 (10 sachets)', 'ชาไทย 3อิน1', 'Desserts, Snacks & Drinks', 3.50, 45, 'pack', '8851111000134', 360, 'Instant Thai-style milk tea.'],
  ['Mama Tom Yum Instant Noodles 55g', 'มาม่าต้มยำ', 'Ready Meals', 0.45, 300, 'pack', '8851111000141', 55, 'Iconic Thai tom yum instant noodles.'],
  ['Frozen Prawns 250g', 'กุ้งแช่แข็ง', 'Fish & Meat Products', 5.99, 30, 'pack', '8851111000158', 250, 'Cleaned, deveined frozen prawns.'],
  ['Thai Basil (Holy Basil) 50g', 'ใบกะเพรา', 'Fresh Vegetables', 1.50, 25, 'pack', '8851111000165', 50, 'Fresh holy basil for pad krapow. Restocked weekly.'],
  ['Kaffir Lime Leaves 20g', 'ใบมะกรูด', 'Fresh Vegetables', 1.30, 20, 'pack', '8851111000172', 20, 'Aromatic kaffir lime leaves.'],
  ['Mango (Nam Dok Mai) each', 'มะม่วงน้ำดอกไม้', 'Fresh Fruits', 1.95, 0, 'each', '8851111000189', 300, 'Sweet Thai honey mango (seasonal — restocked Mondays).'],
];

async function main() {
  const { rows: shopRows } = await pool.query(`SELECT id FROM shops WHERE slug = $1`, [SHOP_SLUG]);
  if (!shopRows[0]) {
    console.error(`No shop with slug "${SHOP_SLUG}". Boot the server once so the shop seeds, then re-run.`);
    process.exit(1);
  }
  const shopId = shopRows[0].id;

  const { rows: catRows } = await pool.query(`SELECT id, name FROM categories WHERE shop_id = $1`, [shopId]);
  const catByName = new Map(catRows.map((c) => [c.name, c.id]));

  let added = 0, skipped = 0;
  for (const [name, name_th, category, price, stock, unit, barcode, weight, desc] of PRODUCTS) {
    const exists = await pool.query(`SELECT 1 FROM products WHERE shop_id = $1 AND name = $2`, [shopId, name]);
    if (exists.rows[0]) { skipped++; continue; }
    const categoryId = catByName.get(category) || null;
    if (!categoryId) console.warn(`  ! category not found: "${category}" (product "${name}") — leaving uncategorised`);
    await pool.query(
      `INSERT INTO products (shop_id, name, name_th, description, category_id, price, cost_price,
                             stock_qty, track_stock, unit, barcode, weight_grams, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$10,$11,TRUE)`,
      [shopId, name, name_th, desc, categoryId, price, +(price * 0.6).toFixed(2), stock, unit, barcode, weight]
    );
    added++;
  }
  console.log(`✅ Seed complete for shop "${SHOP_SLUG}": ${added} added, ${skipped} already present.`);
  await pool.end();
}

main().catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
