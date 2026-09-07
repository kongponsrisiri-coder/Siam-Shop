// Load the scraped Cha & Pinto Box catalogue into a SiamShop shop, over the
// admin API — so it needs the shop's admin password, never database
// credentials (SIAMSHOP-506).
//
//   BASE=http://localhost:4999 ADMIN_PASSWORD=… node scripts/load-chapinto.mjs OUTDIR            # dry run
//   BASE=… ADMIN_PASSWORD=… node scripts/load-chapinto.mjs OUTDIR --apply
//   … --shop chapinto     write into another shop slug (default: demo)
//   … --replace           DELETE every existing product in the shop first
//   … --no-photos         skip photo upload (much faster)
//
// OUTDIR is what scripts/scrape-chapinto.mjs produced (chapinto-products.csv
// + photos/). Idempotent without --replace: a product is matched by name and
// updated rather than duplicated.
//
// --replace writes a JSON backup of every product it is about to delete
// (OUTDIR/backup-<shop>-<timestamp>.json) before touching anything. Sales
// history is unaffected either way: order lines keep their own name and price
// snapshots, and orders.product_id is ON DELETE SET NULL.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const BASE = (process.env.BASE || 'http://localhost:4999').replace(/\/$/, '');
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const args = process.argv.slice(2);
const DIR = args.find((a) => !a.startsWith('--')) || path.join(process.cwd(), 'out', 'chapinto');
const APPLY = args.includes('--apply');
const REPLACE = args.includes('--replace');
const PHOTOS = !args.includes('--no-photos');
const SHOP = (() => { const i = args.indexOf('--shop'); return i >= 0 ? args[i + 1] : 'demo'; })();

let token = '';
async function api(method, p, bodyObj) {
  const url = `${BASE}${p}${p.includes('?') ? '&' : '?'}shop=${encodeURIComponent(SHOP)}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: bodyObj != null ? JSON.stringify(bodyObj) : undefined,
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${(data && data.error) || text.slice(0, 140)}`);
  return data;
}

// Minimal RFC4180 reader (the CSV carries commas inside product names).
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.some((v) => v !== '')).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

const mimeOf = (f) => (/\.png$/i.test(f) ? 'image/png' : /\.webp$/i.test(f) ? 'image/webp' : 'image/jpeg');

async function main() {
  if (!PASSWORD) { console.error('ADMIN_PASSWORD is required.'); process.exit(1); }
  const csvPath = path.join(DIR, 'chapinto-products.csv');
  if (!existsSync(csvPath)) { console.error(`No catalogue at ${csvPath} — run scripts/scrape-chapinto.mjs first.`); process.exit(1); }
  const rows = parseCsv(readFileSync(csvPath, 'utf8')).filter((r) => (r.fieldType || 'Product') === 'Product' && r.name);
  const cats = [...new Set(rows.flatMap((r) => (r.collection || '').split(';')).filter(Boolean))].sort();
  const withPhoto = rows.filter((r) => r.productImageUrl && existsSync(r.productImageUrl)).length;

  console.log(`— Cha & Pinto catalogue → ${BASE} (shop ${SHOP})`);
  console.log(`  ${rows.length} products · ${cats.length} categories · ${withPhoto} local photos`);
  console.log(`  categories: ${cats.join(', ')}`);
  if (REPLACE) console.log('  --replace: every existing product in this shop will be DELETED first (backed up to JSON).');
  if (!APPLY) { console.log('\n[DRY RUN] Nothing written. Add --apply to write.'); return; }

  ({ token } = await api('POST', '/api/admin/login', { password: PASSWORD }));

  // 1. Backup + optional wipe.
  const existing = (await api('GET', '/api/admin/products')) || [];
  if (REPLACE && existing.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(DIR, `backup-${SHOP}-${stamp}.json`);
    writeFileSync(backup, JSON.stringify({ shop: SHOP, base: BASE, taken_at: new Date().toISOString(), products: existing }, null, 2));
    console.log(`  backed up ${existing.length} existing products → ${backup}`);
    let gone = 0;
    for (const p of existing) {
      try { await api('DELETE', `/api/admin/products/${p.id}`); gone++; }
      catch (e) { console.log(`  ! could not delete #${p.id} ${p.name}: ${e.message}`); }
      if (gone % 50 === 0) console.log(`    deleted ${gone}/${existing.length}`);
    }
    console.log(`  deleted ${gone} products (sales history keeps its own name/price snapshots)`);
  }

  // 2. Categories.
  const catRows = (await api('GET', '/api/categories')) || [];
  const catId = new Map(catRows.map((c) => [c.name.toLowerCase(), c.id]));
  for (const name of cats) {
    if (catId.has(name.toLowerCase())) continue;
    const c = await api('POST', '/api/admin/categories', { name });
    catId.set(name.toLowerCase(), c.id);
    console.log(`  category ${name} → #${c.id}`);
  }

  // 3. Products (+ photo).
  const after = REPLACE ? [] : existing;
  const byName = new Map(after.map((p) => [p.name.toLowerCase(), p]));
  let created = 0, updated = 0, photos = 0, photoFail = 0, noPrice = 0;
  for (const [i, r] of rows.entries()) {
    const price = Number(r.price || 0);
    if (!price) noPrice++;
    const firstCat = (r.collection || '').split(';').filter(Boolean)[0];
    const body = {
      name: r.name,
      description: r.description || '',
      price,
      category_id: firstCat ? catId.get(firstCat.toLowerCase()) || null : null,
      sku: r.sku || '',
      stock_qty: /OutOfStock/i.test(r.inventory) ? 0 : 10,
      track_stock: true,
      kind: 'retail',
      is_active: !/false/i.test(r.visible || 'true'),
    };
    let prod;
    try {
      const found = byName.get(r.name.toLowerCase());
      if (found) { prod = await api('PUT', `/api/admin/products/${found.id}`, { ...found, ...body }); updated++; }
      else { prod = await api('POST', '/api/admin/products', body); created++; }
    } catch (e) { console.log(`  ! ${r.name}: ${e.message}`); continue; }

    const id = (prod && prod.id) || null;
    if (PHOTOS && id && r.productImageUrl && existsSync(r.productImageUrl)) {
      try {
        const buf = readFileSync(r.productImageUrl);
        if (buf.length > 6 * 1024 * 1024) throw new Error('photo over 6 MB');
        await api('POST', `/api/admin/products/${id}/photo`, { dataUrl: `data:${mimeOf(r.productImageUrl)};base64,${buf.toString('base64')}` });
        photos++;
      } catch (e) { photoFail++; console.log(`  ! photo for ${r.name}: ${e.message}`); }
    }
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${rows.length}`);
  }

  console.log(`\n✅ ${created} created, ${updated} updated · ${photos} photos${photoFail ? `, ${photoFail} photo failures` : ''}`);
  if (noPrice) console.log(`   ${noPrice} products had no price on the source site — check them in Admin → Products.`);
  console.log('   Stock is a placeholder (10 each): the source site does not publish stock levels.');
  console.log('   Next: node scripts/seed-chapinto-food.mjs --apply   (lunch boxes, nibbles, boba)');
}
main().catch((e) => { console.error('✗', e.message); process.exit(1); });
