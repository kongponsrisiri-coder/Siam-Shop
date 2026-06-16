// SiamShop — Marketing mock customers + orders seeder.
// Creates a realistic spread of customers and online orders so the admin
// Orders list, Customers CRM, order detail, and dashboard look like a real
// shop with history — NOT 30 identical orders stamped "now".
//
// Talks straight to the database (same pattern as seed-demo.js) so it can
// backdate orders across the last few weeks and set mixed statuses. There is
// no public "delete order" API, so every row it creates is logged to
//   scripts/mock-orders-ids.json
// and  cleanup-mock-orders.js  removes exactly those rows afterwards.
//
// RUN (from the siamshop repo folder):
//   DATABASE_URL="<railway postgres url>" node scripts/seed-mock-orders.js
//
// Get DATABASE_URL from Railway → your Postgres service → Variables →
// DATABASE_URL (use the public/proxy connection string, not the internal one).
//
// Optional env:
//   DEFAULT_SHOP_SLUG=demo   N_CUSTOMERS=20   N_ORDERS=30

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const conn = process.env.DATABASE_URL || '';
if (!conn) {
  console.error('❌ DATABASE_URL is required. e.g.\n   DATABASE_URL="postgres://…" node scripts/seed-mock-orders.js');
  process.exit(1);
}
const useSSL = !/@(localhost|127\.0\.0\.1)/.test(conn);
const pool = new Pool({ connectionString: conn, ssl: useSSL ? { rejectUnauthorized: false } : false });

const SHOP_SLUG   = process.env.DEFAULT_SHOP_SLUG || 'demo';
const N_CUSTOMERS = parseInt(process.env.N_CUSTOMERS || '20', 10);
const N_ORDERS    = parseInt(process.env.N_ORDERS || '30', 10);
const IDS_FILE    = path.join(__dirname, 'mock-orders-ids.json');

// ── helpers ──────────────────────────────────────────────────────────────
const rnd   = (n) => Math.floor(Math.random() * n);
const pick  = (a) => a[rnd(a.length)];
const money = (n) => Math.round(n * 100) / 100;
const pad   = (n, w) => String(n).padStart(w, '0');

// Customers — a Thai-supermarket mix of Thai expats and British locals.
const FIRST = ['Somchai','Naphat','Ploy','Anan','Kanya','Nattapong','Suda','Pim','Chai','Mali',
               'Sarah','David','Emily','Mark','Laura','Tom','Hannah','Daniel','Rachel','Jack',
               'Olivia','Megan','Ben','Chloe','Niran','Ying'];
const LAST  = ['Phanit','Srisai','Tangkit','Wong','Mookjai','Lertsiri','Chaiyo','Rattana','Boonmee','Saetang',
               'Hughes','Clarke','Watson','Robinson','Bennett','Fielding','Price','Knight','Owen','Sutton',
               'Reed','Lloyd','Carter','Adams'];
const EMAIL_DOMAINS = ['gmail.com','outlook.com','hotmail.co.uk','yahoo.co.uk','icloud.com'];

// Delivery zones → fee fallback (overridden by shop_settings if present) + sample postcodes/towns.
const ZONES = {
  london:   { postcodes: ['SW9 8PQ','E8 3DL','N4 2RF','SE15 4ST','W12 8QT','EC1V 9BD','NW5 2LP'], towns: ['London'] },
  mainland: { postcodes: ['M14 5RT','B12 8AS','LS6 1AB','BS5 6QW','CV1 2GH','NG7 3KL','RG1 4MN','OX4 1PQ'], towns: ['Manchester','Birmingham','Leeds','Bristol','Coventry','Nottingham','Reading','Oxford'] },
  remote:   { postcodes: ['IV2 3XX','AB10 1YY','PA34 4LZ','LL57 2AA'], towns: ['Inverness','Aberdeen','Oban','Bangor'] },
};
const STREETS = ['High Street','Station Road','Victoria Road','Mill Lane','Church Street','Park Avenue',
                 'Kings Road','Albert Street','Queens Road','Grove Lane','Maple Close','Oxford Road'];
const CARRIERS = ['royal_mail','parcelforce','dpd','evri','ups','dhl','apc'];
const ORDER_NOTES = ['', '', '', 'Please leave with the neighbour at no. 12 if out.',
                     'Ring the doorbell — flat is upstairs.', 'No coriander if possible, thank you!',
                     'Leave in the porch.', 'Call on arrival.'];

function trackingFor(carrier) {
  if (carrier === 'royal_mail') return 'RM' + pad(rnd(1e9), 9) + 'GB';
  if (carrier === 'dpd')        return '15' + pad(rnd(1e12), 12);
  if (carrier === 'evri')       return 'H' + pad(rnd(1e15), 15);
  return pad(rnd(1e10), 10);
}

// Backdated timestamp within the last `days` days, business hours-ish.
function backdate(days) {
  const d = new Date();
  d.setDate(d.getDate() - rnd(days));
  d.setHours(8 + rnd(13), rnd(60), rnd(60), 0); // 08:00–20:59
  return d;
}

const created = { shopSlug: SHOP_SLUG, createdAt: new Date().toISOString(), customerIds: [], orderIds: [] };
const save = () => fs.writeFileSync(IDS_FILE, JSON.stringify(created, null, 2));

async function main() {
  console.log('\n=== SiamShop — mock customers + orders ===');
  console.log('Shop slug:', SHOP_SLUG);

  const { rows: shopRows } = await pool.query(`SELECT id, name FROM shops WHERE slug = $1`, [SHOP_SLUG]);
  if (!shopRows[0]) { console.error(`❌ No shop with slug "${SHOP_SLUG}".`); process.exit(1); }
  const shopId = shopRows[0].id;

  const { rows: products } = await pool.query(
    `SELECT id, name, price FROM products WHERE shop_id = $1 AND is_active = TRUE AND price > 0`, [shopId]
  );
  if (products.length < 4) { console.error('❌ Need at least 4 active products. Run seed-demo.js first.'); process.exit(1); }
  console.log(`Found ${products.length} active products.`);

  // Settings (delivery fees + minimum order) with sensible fallbacks.
  const { rows: setRows } = await pool.query(`SELECT key, value FROM shop_settings WHERE shop_id = $1`, [shopId]);
  const S = Object.fromEntries(setRows.map((r) => [r.key, r.value]));
  const feeFor = (zone) => Number(
    ({ london: S.delivery_fee_london, mainland: S.delivery_fee_mainland, remote: S.delivery_fee_remote }[zone])
    ?? ({ london: 4.99, mainland: 5.99, remote: 9.99 }[zone])
  );
  const minOrder = Number(S.minimum_order_amount || 25);

  // ── 1) Customers ─────────────────────────────────────────────────────────
  console.log(`\nCreating ${N_CUSTOMERS} customers...`);
  const customers = [];
  const usedEmails = new Set();
  for (let i = 0; i < N_CUSTOMERS; i++) {
    const first = FIRST[i % FIRST.length];
    const last  = pick(LAST);
    const name  = `${first} ${last}`;
    let email;
    do {
      email = `${first}.${last}${rnd(90) + 10}@${pick(EMAIL_DOMAINS)}`.toLowerCase();
    } while (usedEmails.has(email));
    usedEmails.add(email);
    const phone   = '07' + pad(rnd(1e9), 9);
    const consent = Math.random() < 0.6;
    const cAt     = backdate(60); // signed up over the last couple of months
    const { rows } = await pool.query(
      `INSERT INTO customers (shop_id, email, name, phone, marketing_consent, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [shopId, email, name, phone, consent, cAt]
    );
    const id = rows[0].id;
    created.customerIds.push(id);
    customers.push({ id, name, email });
  }
  save();
  console.log(`  → ${customers.length} customers created.`);

  // ── 2) Orders ──────────────────────────────────────────────────────────────
  // Status mix (sums to N_ORDERS by proportion): dispatched > paid > new > cancelled.
  function chooseState(i) {
    const r = i / N_ORDERS;
    if (r < 0.20) return 'new';        // pending / unpaid
    if (r < 0.50) return 'paid';       // pending / paid (awaiting dispatch)
    if (r < 0.87) return 'dispatched'; // dispatched / paid + tracking
    if (r < 0.94) return 'cancelled';  // cancelled / unpaid
    return 'refunded';                 // cancelled / refunded (was paid)
  }

  // Spread orders across customers: everyone gets >=1, some get repeats.
  const ownerSequence = [];
  customers.forEach((c) => ownerSequence.push(c));            // 1 each
  while (ownerSequence.length < N_ORDERS) ownerSequence.push(pick(customers)); // extras → loyal customers
  // shuffle
  for (let i = ownerSequence.length - 1; i > 0; i--) { const j = rnd(i + 1); [ownerSequence[i], ownerSequence[j]] = [ownerSequence[j], ownerSequence[i]]; }

  console.log(`\nCreating ${N_ORDERS} orders...`);
  const tally = {};
  for (let i = 0; i < N_ORDERS; i++) {
    const cust  = ownerSequence[i];
    const state = chooseState(i);
    const zone  = pick(['london','london','mainland','mainland','mainland','remote']); // weighted
    const deliveryFee = feeFor(zone);
    const source = pick(['website','website','website','website','messenger','manual']);
    const channel = 'online';

    // Build a varied basket that clears the minimum order.
    const nItems = 2 + rnd(5); // 2–6 distinct items
    const chosen = [];
    const seen = new Set();
    while (chosen.length < nItems && seen.size < products.length) {
      const p = pick(products);
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      chosen.push({ p, qty: 1 + rnd(4) });
    }
    let subtotal = chosen.reduce((s, l) => s + Number(l.p.price) * l.qty, 0);
    // Top up if under the minimum order.
    while (subtotal < minOrder) {
      const l = pick(chosen); l.qty += 1; subtotal += Number(l.p.price);
    }
    subtotal = money(subtotal);
    const total = money(subtotal + deliveryFee);

    const createdAt = backdate(28);
    const zoneInfo = ZONES[zone];
    const pc = pick(zoneInfo.postcodes);
    const town = pick(zoneInfo.towns);
    const address = `${1 + rnd(180)} ${pick(STREETS)}, ${town}, ${pc}`;
    const notes = pick(ORDER_NOTES) || null;

    // Per-state fields
    let status = 'pending', paymentStatus = 'pending', paymentMethod = 'bank_transfer';
    let fulfilledAt = null, dispatchDate = null, tracking = null, carrier = null;
    if (state === 'paid' || state === 'dispatched') {
      paymentStatus = 'paid';
      fulfilledAt = new Date(createdAt.getTime() + (2 + rnd(34)) * 3600 * 1000);
    }
    if (state === 'dispatched') {
      status = 'dispatched';
      carrier = pick(CARRIERS);
      tracking = trackingFor(carrier);
      const dd = new Date(createdAt.getTime() + (1 + rnd(2)) * 86400 * 1000);
      dispatchDate = dd.toISOString().slice(0, 10);
    }
    if (state === 'cancelled') { status = 'cancelled'; }
    if (state === 'refunded')  { status = 'cancelled'; paymentStatus = 'refunded'; fulfilledAt = new Date(createdAt.getTime() + 5 * 3600 * 1000); }

    const oRes = await pool.query(
      `INSERT INTO orders (shop_id, customer_id, channel, source, status, subtotal, delivery_fee, total,
                           payment_method, payment_status, delivery_address, notes,
                           created_at, fulfilled_at, dispatch_date, tracking_number, carrier)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [shopId, cust.id, channel, source, status, subtotal, deliveryFee, total,
       paymentMethod, paymentStatus, address, notes,
       createdAt, fulfilledAt, dispatchDate, tracking, carrier]
    );
    const orderId = oRes.rows[0].id;
    created.orderIds.push(orderId);

    for (const l of chosen) {
      await pool.query(
        `INSERT INTO order_items (order_id, product_id, name_snapshot, price_snapshot, qty, line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [orderId, l.p.id, l.p.name, l.p.price, l.qty, money(Number(l.p.price) * l.qty)]
      );
    }
    tally[state] = (tally[state] || 0) + 1;
    if ((i + 1) % 5 === 0) save();
  }
  save();

  console.log(`  → ${N_ORDERS} orders created.`);
  console.log('    status mix:', JSON.stringify(tally));
  console.log('\n========================================================');
  console.log('  DONE — mock data is live (stock NOT touched).');
  console.log('  Customers:', created.customerIds.length, '| Orders:', created.orderIds.length);
  console.log('  IDs saved to:', IDS_FILE);
  console.log('  Screenshot: Admin → Orders, Customers, an order detail, Dashboard.');
  console.log('  Remove afterwards:  DATABASE_URL="…" node scripts/cleanup-mock-orders.js');
  console.log('========================================================\n');
  await pool.end();
}

main().catch((e) => { console.error('💥 Seed failed:', e.message); save(); pool.end(); process.exit(1); });
