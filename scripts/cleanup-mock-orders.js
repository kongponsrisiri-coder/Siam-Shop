// SiamShop — remove the marketing mock data created by seed-mock-orders.js.
// Reads scripts/mock-orders-ids.json and deletes exactly those order_items,
// orders, and customers. Order matters: items → orders → customers (orders
// reference customers, and stock_movements/order_items reference orders).
//
// RUN (from the siamshop repo folder):
//   DATABASE_URL="<railway postgres url>" node scripts/cleanup-mock-orders.js

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const conn = process.env.DATABASE_URL || '';
if (!conn) { console.error('❌ DATABASE_URL is required.'); process.exit(1); }
const useSSL = !/@(localhost|127\.0\.0\.1)/.test(conn);
const pool = new Pool({ connectionString: conn, ssl: useSSL ? { rejectUnauthorized: false } : false });

const IDS_FILE = path.join(__dirname, 'mock-orders-ids.json');
if (!fs.existsSync(IDS_FILE)) {
  console.error('❌ scripts/mock-orders-ids.json not found — nothing to clean up (or seeder was never run).');
  process.exit(1);
}
const ids = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
const orderIds    = (ids.orderIds || []).map(Number).filter(Boolean);
const customerIds = (ids.customerIds || []).map(Number).filter(Boolean);

async function main() {
  console.log('\n=== SiamShop — mock data cleanup ===');
  console.log(`Removing ${orderIds.length} orders and ${customerIds.length} customers...`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let items = 0, sm = 0, ords = 0, custs = 0;
    if (orderIds.length) {
      // Any stock movements that referenced these orders (seeder doesn't create
      // them, but clear defensively so the FK doesn't block the delete).
      sm    = (await client.query(`DELETE FROM stock_movements WHERE ref_order_id = ANY($1::int[])`, [orderIds])).rowCount;
      items = (await client.query(`DELETE FROM order_items     WHERE order_id     = ANY($1::int[])`, [orderIds])).rowCount;
      ords  = (await client.query(`DELETE FROM orders          WHERE id           = ANY($1::int[])`, [orderIds])).rowCount;
    }
    if (customerIds.length) {
      custs = (await client.query(`DELETE FROM customers WHERE id = ANY($1::int[])`, [customerIds])).rowCount;
    }
    await client.query('COMMIT');
    console.log(`  order_items deleted    : ${items}`);
    console.log(`  stock_movements deleted: ${sm}`);
    console.log(`  orders deleted         : ${ords}`);
    console.log(`  customers deleted      : ${custs}`);
    fs.renameSync(IDS_FILE, IDS_FILE + '.done');
    console.log('\n✅ All clean. (mock-orders-ids.json archived as .done)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('💥 Cleanup failed, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
  console.log('====================================\n');
}

main().catch((e) => { console.error('💥 Fatal:', e.message); pool.end(); process.exit(1); });
