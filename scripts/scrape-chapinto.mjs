// Extract the Cha & Pinto Box catalogue from their live Wix site into the CSV
// shape scripts/import-wix.js already reads, plus the product photos
// (SIAMSHOP-506). Used to seed the demo shop before the client sends their
// Wix Stores CSV export — re-running the importer over the real export later
// updates the same products rather than duplicating them.
//
//   node scripts/scrape-chapinto.mjs                 # catalogue + photos → out/chapinto
//   node scripts/scrape-chapinto.mjs --no-photos     # CSV only
//   node scripts/scrape-chapinto.mjs --out DIR       # somewhere else
//
// Data comes from the schema.org JSON-LD the site publishes for search engines:
// store-products-sitemap.xml lists all 299 product pages, and each product page
// carries a Product block (name, image, price, availability). No scraping of the
// rendered layout, so a Wix template change cannot silently corrupt the import.
//
// CATEGORIES: Wix server-renders only a few items per category page (the rest
// arrive by JS), so exact membership is only available for those. Everything
// else is filed by name rules below and marked inferred=true in the JSON, to be
// corrected when the client sends their Wix Stores CSV export.
// Requests are serialised with a delay; pages and images are cached on disk so
// re-runs do not hit the site again.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const SITE = 'https://www.chapintobox.co.uk';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const DELAY_MS = 350;
const MAX_PAGES = 40;

// Wix category slug → the category name we want in SiamShop. "best-sellers" is
// a merchandising list, not a shelf, so it is recorded as a tag instead.
const CATEGORIES = {
  rice: 'Rice',
  noodles: 'Noodles',
  spices: 'Spices & Curry Pastes',
  drinks: 'Drinks',
  snacks: 'Snacks',
  japanese: 'Japanese',
  korean: 'Korean',
  'other-asian-ingredients': 'Other Asian Ingredients',
};
const TAG_ONLY = new Set(['best-sellers']);

const args = process.argv.slice(2);
const OUT = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : path.join(process.cwd(), 'out', 'chapinto'); })();
const PHOTOS = !args.includes('--no-photos');
const CACHE = path.join(OUT, 'cache');
const IMG_DIR = path.join(OUT, 'photos');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

async function get(url, { binary = false } = {}) {
  const key = path.join(CACHE, slug(url.replace(SITE, '')).slice(0, 90) + (binary ? '.bin' : '.html'));
  if (existsSync(key)) return binary ? readFileSync(key) : readFileSync(key, 'utf8');
  await sleep(DELAY_MS);
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: binary ? 'image/*' : 'text/html' } });
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${url}`), { status: res.status });
  const body = binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(key, body);
  return body;
}

// Every category page carries an ItemList of the products on it.
function productsFromListing(html) {
  const out = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    if (!data || data['@type'] !== 'ItemList' || !Array.isArray(data.itemListElement)) continue;
    for (const el of data.itemListElement) {
      const it = el?.item;
      if (!it || it['@type'] !== 'Product' || !it.name) continue;
      out.push({
        name: String(it.name).trim(),
        url: it.url || '',
        image: typeof it.image === 'string' ? it.image : it.image?.contentUrl || '',
        price: Number(it.offers?.price ?? it.offers?.[0]?.price ?? 0),
        inStock: !/OutOfStock/i.test(JSON.stringify(it.offers || {})),
      });
    }
  }
  return out;
}

// Wix serves a resized derivative; ask for a bigger one for the shop grid.
const biggerImage = (url) => url.replace(/\/v1\/(fit|fill)\/[^/]+\//, '/v1/fit/w_1200,h_1200,q_85/');

// Name → category rules for the products whose real category the site does not
// server-render. Ordered: the first match wins.
const NAME_RULES = [
  [/\bRICE\b|JASMINE RICE|STICKY RICE|GLUTINOUS/i, 'Rice'],
  [/NOODLE|VERMICELLI|RAMEN|UDON|PAD ?THAI|MAMA\b|WAI ?WAI/i, 'Noodles'],
  [/CURRY PASTE|PASTE\b|SEASONING|POWDER|SPICE|CHILLI|PEPPER|GARLIC|TAMARIND|GALANGAL|LEMONGRASS|TURMERIC/i, 'Spices & Curry Pastes'],
  [/SAUCE|FISH SAUCE|SOY|OYSTER|VINEGAR|SRIRACHA|MIRIN|SESAME OIL|COCONUT MILK|COCONUT CREAM/i, 'Sauces & Oils'],
  [/TEA\b|COFFEE|JUICE|DRINK|SODA|WATER|MILK\b|OISHI|COLA/i, 'Drinks'],
  [/SNACK|CRACKER|CRISPS?|SEAWEED|BISCUIT|WAFER|CANDY|SWEETS?|CHOCOLATE|NUTS?\b|CASHEW/i, 'Snacks'],
  [/KIMCHI|GOCHUJANG|KOREAN|BIBIM|TTEOK/i, 'Korean'],
  [/MISO|SUSHI|JAPAN|NORI|WASABI|PANKO|DASHI/i, 'Japanese'],
  [/FROZEN|IQF/i, 'Frozen'],
  [/SUGAR|SALT|FLOUR|STARCH|BEAN|LENTIL|CANNED|TIN\b|BAMBOO|MUSHROOM/i, 'Store Cupboard'],
];
const categoryFromName = (name) => (NAME_RULES.find(([re]) => re.test(name)) || [, 'Other Asian Ingredients'])[1];

// All 299 product page URLs, straight from the store sitemap.
async function productUrlsFromSitemap() {
  const xml = await get(`${SITE}/store-products-sitemap.xml`);
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => u.includes('/product-page/'));
}

// One product page → the Product JSON-LD block.
function productFromPage(html, url) {
  for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) {
    let d;
    try { d = JSON.parse(m[1]); } catch { continue; }
    if (!d || d['@type'] !== 'Product' || !d.name) continue;
    const img = Array.isArray(d.image) ? d.image[0] : d.image;
    const offer = Array.isArray(d.offers) ? d.offers[0] : d.offers;
    return {
      name: String(d.name).trim(),
      url,
      image: (typeof img === 'string' ? img : img?.contentUrl) || '',
      price: Number(offer?.price || 0),
      inStock: !/OutOfStock/i.test(String(offer?.availability || '')),
      description: String(d.description || '').trim(),
      sku: String(d.sku || '').trim(),
    };
  }
  return null;
}

async function crawlCategory(slugName) {
  const seen = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${SITE}/category/${slugName}${page > 1 ? `?page=${page}` : ''}`;
    let html;
    try { html = await get(url); } catch (e) { if (e.status === 404) break; throw e; }
    const items = productsFromListing(html);
    if (!items.length) break;
    let fresh = 0;
    for (const p of items) if (p.url && !seen.has(p.url)) { seen.set(p.url, p); fresh++; }
    process.stdout.write(`  ${slugName} p${page}: ${items.length} items (${fresh} new)\n`);
    if (fresh === 0) break; // Wix repeats the last page instead of 404ing
  }
  return [...seen.values()];
}

function toCsv(rows) {
  // Column names match what scripts/import-wix.js looks for in a real Wix export.
  const cols = ['handleId', 'fieldType', 'name', 'description', 'productImageUrl', 'collection', 'sku', 'price', 'visible', 'inventory'];
  const esc = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\r\n');
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`— Cha & Pinto Box → ${OUT}`);
  const byUrl = new Map();
  const addAll = (items, category, tag) => {
    for (const p of items) {
      const cur = byUrl.get(p.url) || { ...p, categories: [], tags: [] };
      if (category && !cur.categories.includes(category)) cur.categories.push(category);
      if (tag && !cur.tags.includes(tag)) cur.tags.push(tag);
      cur.price = cur.price || p.price;
      cur.image = cur.image || p.image;
      byUrl.set(p.url, cur);
    }
  };
  // 1. Category pages first — whatever Wix server-renders here is the client's
  //    OWN filing, so it wins over the name rules.
  console.log('— categories (server-rendered subset)');
  for (const [s, name] of Object.entries(CATEGORIES)) addAll(await crawlCategory(s), name, null);
  for (const s of TAG_ONLY) addAll(await crawlCategory(s), null, 'best-seller');
  const confirmed = new Set([...byUrl.values()].filter((p) => p.categories.length).map((p) => p.url));
  console.log(`  ${confirmed.size} products have a confirmed category`);

  // 2. Then the full catalogue from the sitemap.
  const urls = await productUrlsFromSitemap();
  console.log(`— sitemap lists ${urls.length} products; fetching each page`);
  let done = 0;
  for (const url of urls) {
    let page;
    try { page = await get(url); } catch (e) { console.log(`  ! ${url}: ${e.message}`); continue; }
    const p = productFromPage(page, url);
    if (!p) { console.log(`  ! no product data on ${url}`); continue; }
    const cur = byUrl.get(url) || { ...p, categories: [], tags: [] };
    Object.assign(cur, { name: p.name, image: p.image || cur.image, price: p.price || cur.price, inStock: p.inStock, description: p.description, sku: p.sku });
    byUrl.set(url, cur);
    if (++done % 25 === 0) console.log(`  ${done}/${urls.length}`);
  }

  // 3. File the rest by name.
  let inferred = 0;
  for (const p of byUrl.values()) {
    p.inferredCategory = !p.categories.length;
    if (p.inferredCategory) { p.categories = [categoryFromName(p.name)]; inferred++; }
  }
  console.log(`— ${byUrl.size} products (${inferred} filed by name rules, ${byUrl.size - inferred} by the client's own categories)`);

  const products = [...byUrl.values()].sort((a, b) => a.name.localeCompare(b.name));
  const rows = [];
  let photos = 0, missing = 0;
  for (const p of products) {
    const handle = slug(p.url.split('/').pop() || p.name);
    let localImage = '';
    if (PHOTOS && p.image) {
      const ext = (p.image.match(/\.(jpe?g|png|webp)/i) || [, 'jpg'])[1].toLowerCase().replace('jpeg', 'jpg');
      const file = path.join(IMG_DIR, `${handle}.${ext}`);
      if (existsSync(file)) { localImage = file; photos++; }
      else {
        try {
          const buf = await get(biggerImage(p.image), { binary: true });
          mkdirSync(IMG_DIR, { recursive: true });
          writeFileSync(file, buf);
          localImage = file; photos++;
        } catch (e) { missing++; console.log(`  ! photo failed for ${p.name}: ${e.message}`); }
      }
    }
    rows.push({
      handleId: handle,
      fieldType: 'Product',
      name: p.name,
      description: p.description || '',
      // The importer takes a URL or a local path; a local file avoids a second fetch.
      productImageUrl: localImage || biggerImage(p.image),
      collection: p.categories.join(';'),
      sku: p.sku || '',
      price: p.price ? p.price.toFixed(2) : '',
      visible: 'true',
      inventory: p.inStock ? 'InStock' : 'OutOfStock',
    });
  }
  const csv = path.join(OUT, 'chapinto-products.csv');
  writeFileSync(csv, '﻿' + toCsv(rows));
  writeFileSync(path.join(OUT, 'chapinto-products.json'), JSON.stringify(products, null, 2));
  const noPrice = rows.filter((r) => !r.price).length;
  const noCat = rows.filter((r) => !r.collection).length;
  console.log(`\n✅ ${rows.length} products → ${csv}`);
  console.log(`   photos: ${photos} downloaded/cached${missing ? `, ${missing} failed` : ''}`);
  console.log(`   without a price: ${noPrice} · without a category: ${noCat}`);
  const byCat = {};
  for (const r of rows) for (const c of r.collection.split(';').filter(Boolean)) byCat[c] = (byCat[c] || 0) + 1;
  console.log('   categories: ' + Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(' · '));
}
main().catch((e) => { console.error(e); process.exit(1); });
