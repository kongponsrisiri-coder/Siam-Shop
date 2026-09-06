// SiamShop — import a Wix Stores "Export products" CSV into a shop (SIAMSHOP-506).
//
//   DATABASE_URL=<url> DEFAULT_SHOP_SLUG=chapinto node scripts/import-wix.js path/to/wix.csv           # dry run (prints plan)
//   DATABASE_URL=<url> DEFAULT_SHOP_SLUG=chapinto node scripts/import-wix.js path/to/wix.csv --apply   # write
//   … --photos   also download each product's first image into the DB (served at /img/product/:id)
//
// Wix's export (Store Products → More actions → Export) is one row per product
// (fieldType=Product) plus optional Variant rows. Header names vary a little
// between Wix versions, so columns are matched loosely by name. Idempotent:
// a product is matched by SKU, else by Wix handleId stored in the SKU when the
// product has none ("wix:<handleId>"), else by exact name — re-running updates
// price/category/stock instead of duplicating.
//
// Columns used (any casing): handleId, fieldType, name, description,
// productImageUrl, collection, sku, price, visible, inventory, weight, cost.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const APPLY = args.includes('--apply');
const PHOTOS = args.includes('--photos');
if (!file) { console.error('Usage: node scripts/import-wix.js <wix-export.csv> [--apply] [--photos]'); process.exit(1); }

const conn = process.env.DATABASE_URL || '';
if (!conn) { console.error('DATABASE_URL is required.'); process.exit(1); }
const useSSL = !/@(localhost|127\.0\.0\.1)/.test(conn) && !/\.railway\.internal/.test(conn) && !/sslmode=disable/.test(conn);
const pool = new Pool({ connectionString: conn, ssl: useSSL ? { rejectUnauthorized: false } : false });
const SHOP_SLUG = process.env.DEFAULT_SHOP_SLUG || 'demo';

// --- tiny RFC4180 CSV parser (handles quotes, embedded commas/newlines) ------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((x) => x !== '')) rows.push(row); }
  return rows;
}

// Loose header lookup: "productImageUrl", "Product Image Url", "image" all match.
function colIndex(headers, ...names) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const hs = headers.map(norm);
  for (const n of names) {
    const i = hs.indexOf(norm(n));
    if (i >= 0) return i;
  }
  for (const n of names) {
    const i = hs.findIndex((h) => h.includes(norm(n)));
    if (i >= 0) return i;
  }
  return -1;
}

// Wix weights are in the store's unit (kg by default); "0.4" → 400 g.
function weightGrams(v) {
  const n = Number(String(v || '').replace(/[^0-9.]/g, ''));
  if (!n) return null;
  return n < 50 ? Math.round(n * 1000) : Math.round(n);
}
function money(v) {
  const n = Number(String(v || '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? +n.toFixed(2) : 0;
}
function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
// Wix image field: "a.jpg;b.jpg" of wixstatic filenames or full URLs.
function firstImageUrl(v) {
  const first = String(v || '').split(';').map((s) => s.trim()).filter(Boolean)[0];
  if (!first) return null;
  if (/^https?:\/\//.test(first)) return first;
  return `https://static.wixstatic.com/media/${first}`;
}

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(download(res.headers.location));
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), mime: (res.headers['content-type'] || 'image/jpeg').split(';')[0] }));
    }).on('error', reject);
  });
}

async function main() {
  const rows = parseCsv(fs.readFileSync(path.resolve(file), 'utf8'));
  if (rows.length < 2) { console.error('CSV has no data rows'); process.exit(1); }
  const headers = rows[0];
  const ix = {
    handle: colIndex(headers, 'handleId', 'handle'),
    type: colIndex(headers, 'fieldType', 'type'),
    name: colIndex(headers, 'name', 'productName', 'title'),
    desc: colIndex(headers, 'description'),
    image: colIndex(headers, 'productImageUrl', 'imageUrl', 'image'),
    collection: colIndex(headers, 'collection', 'category'),
    sku: colIndex(headers, 'sku'),
    price: colIndex(headers, 'price'),
    visible: colIndex(headers, 'visible'),
    inventory: colIndex(headers, 'inventory', 'stock', 'quantity'),
    weight: colIndex(headers, 'weight'),
    cost: colIndex(headers, 'cost'),
  };
  if (ix.name < 0 || ix.price < 0) { console.error('Could not find name/price columns. Headers:', headers.join(' | ')); process.exit(1); }
  console.log(`Columns: ${Object.entries(ix).map(([k, v]) => `${k}=${v >= 0 ? headers[v] : '—'}`).join(', ')}`);

  const products = [];
  for (const r of rows.slice(1)) {
    const type = ix.type >= 0 ? String(r[ix.type] || '').toLowerCase() : 'product';
    if (type && type !== 'product') continue; // skip variant rows
    const name = stripHtml(r[ix.name]);
    if (!name) continue;
    const handle = ix.handle >= 0 ? String(r[ix.handle] || '').trim() : '';
    const sku = (ix.sku >= 0 && String(r[ix.sku] || '').trim()) || (handle ? `wix:${handle}` : '');
    const inventoryRaw = ix.inventory >= 0 ? String(r[ix.inventory] || '').trim() : '';
    const tracked = inventoryRaw !== '' && !/instock|outofstock/i.test(inventoryRaw);
    const collections = ix.collection >= 0 ? String(r[ix.collection] || '').split(';').map((s) => s.trim()).filter((s) => s && !/^all products$/i.test(s)) : [];
    products.push({
      name,
      sku,
      description: ix.desc >= 0 ? stripHtml(r[ix.desc]).slice(0, 2000) : null,
      image_url: ix.image >= 0 ? firstImageUrl(r[ix.image]) : null,
      category: collections[0] || null,
      price: money(r[ix.price]),
      cost_price: ix.cost >= 0 ? money(r[ix.cost]) : 0,
      stock_qty: tracked ? Math.max(0, parseInt(inventoryRaw, 10) || 0) : 0,
      track_stock: tracked || /outofstock/i.test(inventoryRaw),
      weight_grams: ix.weight >= 0 ? weightGrams(r[ix.weight]) : null,
      is_active: ix.visible >= 0 ? !/^(false|no|0)$/i.test(String(r[ix.visible] || 'true').trim()) : true,
    });
  }
  console.log(`${products.length} products parsed from ${rows.length - 1} rows.`);
  const cats = [...new Set(products.map((p) => p.category).filter(Boolean))];
  console.log(`Categories: ${cats.join(', ') || '(none)'}`);
  const noPrice = products.filter((p) => !p.price);
  if (noPrice.length) console.log(`⚠ ${noPrice.length} with no price: ${noPrice.slice(0, 5).map((p) => p.name).join('; ')}${noPrice.length > 5 ? '…' : ''}`);

  if (!APPLY) {
    console.log('\nSample:');
    for (const p of products.slice(0, 8)) console.log(`  ${p.sku || '—'} | ${p.name} | £${p.price} | ${p.category || '—'} | stock ${p.track_stock ? p.stock_qty : '∞'} | ${p.image_url ? 'img' : 'no img'}`);
    console.log('\nDry run — nothing written. Re-run with --apply to import (add --photos to pull images).');
    await pool.end();
    return;
  }

  const { rows: shopRows } = await pool.query(`SELECT id FROM shops WHERE slug = $1`, [SHOP_SLUG]);
  if (!shopRows[0]) { console.error(`No shop "${SHOP_SLUG}" — boot the server once first (DEFAULT_SHOP_SLUG).`); process.exit(1); }
  const shopId = shopRows[0].id;

  const { rows: catRows } = await pool.query(`SELECT id, name, sort_order FROM categories WHERE shop_id = $1`, [shopId]);
  const catId = new Map(catRows.map((c) => [c.name.toLowerCase(), c.id]));
  let nextSort = catRows.reduce((m, c) => Math.max(m, c.sort_order || 0), 0) + 1;
  async function ensureCategory(name) {
    const key = name.toLowerCase();
    if (catId.has(key)) return catId.get(key);
    const { rows } = await pool.query(
      `INSERT INTO categories (shop_id, name, sort_order) VALUES ($1,$2,$3)
       ON CONFLICT (shop_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [shopId, name, nextSort++]
    );
    catId.set(key, rows[0].id);
    console.log(`  + category: ${name}`);
    return rows[0].id;
  }

  let added = 0, updated = 0, photos = 0, photoFail = 0;
  for (const p of products) {
    const cId = p.category ? await ensureCategory(p.category) : null;
    let existing = null;
    if (p.sku) ({ rows: [existing] } = await pool.query(`SELECT id, image_data IS NOT NULL AS has_photo FROM products WHERE shop_id = $1 AND sku = $2`, [shopId, p.sku]));
    if (!existing) ({ rows: [existing] } = await pool.query(`SELECT id, image_data IS NOT NULL AS has_photo FROM products WHERE shop_id = $1 AND lower(name) = lower($2)`, [shopId, p.name]));
    let id;
    if (existing) {
      id = existing.id;
      await pool.query(
        `UPDATE products SET name = $3, sku = COALESCE($4, sku), description = COALESCE($5, description),
                image_url = CASE WHEN image_data IS NULL THEN COALESCE($6, image_url) ELSE image_url END,
                category_id = COALESCE($7, category_id), price = $8, cost_price = $9,
                stock_qty = $10, track_stock = $11, weight_grams = COALESCE($12, weight_grams), is_active = $13
         WHERE id = $1 AND shop_id = $2`,
        [id, shopId, p.name, p.sku || null, p.description, p.image_url, cId, p.price, p.cost_price, p.stock_qty, p.track_stock, p.weight_grams, p.is_active]
      );
      updated++;
    } else {
      ({ rows: [{ id }] } = await pool.query(
        `INSERT INTO products (shop_id, name, sku, description, image_url, category_id, price, cost_price,
                               stock_qty, track_stock, weight_grams, is_active, unit, kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'each','retail') RETURNING id`,
        [shopId, p.name, p.sku || null, p.description, p.image_url, cId, p.price, p.cost_price, p.stock_qty, p.track_stock, p.weight_grams, p.is_active]
      ));
      added++;
    }
    if (PHOTOS && p.image_url && !(existing && existing.has_photo)) {
      try {
        const { buf, mime } = await download(p.image_url);
        if (/^image\/(jpeg|png|webp)$/.test(mime) && buf.length <= 6 * 1024 * 1024) {
          await pool.query(
            `UPDATE products SET image_data = $3, image_mime = $4, image_updated_at = NOW(), image_url = '/img/product/' || id WHERE id = $1 AND shop_id = $2`,
            [id, shopId, buf, mime]
          );
          photos++;
        } else photoFail++;
      } catch (e) {
        photoFail++;
        console.log(`  ⚠ photo failed for ${p.name}: ${e.message}`);
      }
    }
  }
  console.log(`\n✅ Wix import for "${SHOP_SLUG}": ${added} added, ${updated} updated${PHOTOS ? `, ${photos} photos stored, ${photoFail} photo failures` : ''}.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
