// SiamShop — break wholesale packs down into RETAIL single units, in place.
//
// Wholesale catalogue rows like "Aroy-d Coconut Milk 24X400ML / Case £26.95" are
// turned into a consumer product: "Aroy-D Coconut Milk 400ml £1.75", unit=each.
// - Multi-pack "N x SIZE" → single unit; price = (case ÷ N) × MARKUP.
// - Single packs ("1KG / Pack") → kept as one unit; price = cost × MARKUP.
// - Names cleaned (pack suffix + "/ Case" removed, single size kept).
//
// SAFE BY DEFAULT — dry run. It prints a sample + stats and writes NOTHING.
//   Preview from the bundled price list (no DB):   node scripts/retail-breakdown.js
//   Preview from a live DB:      DATABASE_URL=... node scripts/retail-breakdown.js
//   APPLY to a live DB:          DATABASE_URL=... APPLY=1 node scripts/retail-breakdown.js
// Tunables: MARKUP (default 1.45), DEFAULT_SHOP_SLUG.

const fs = require('fs');
const path = require('path');

const MARKUP = Number(process.env.MARKUP || 1.45);
const APPLY = process.env.APPLY === '1';
const SHOP_SLUG = process.env.DEFAULT_SHOP_SLUG || 'demo';

// --- parsing -------------------------------------------------------------
const PACK_RE = /(\d+)\s*S?\s*[xX]\s*([\d.]+)\s*(KG|G|ML|L|LTR|LITRE|GALLON)\b/i;
const SINGLE_RE = /([\d.]+)\s*(KG|G|ML|L|LTR|LITRE)\b/i; // a size mentioned in a single-pack name

function unitLower(u) {
  const m = String(u).toUpperCase();
  return { KG: 'kg', G: 'g', ML: 'ml', L: 'L', LTR: 'L', LITRE: 'L', GALLON: 'L' }[m] || m.toLowerCase();
}

// Grams for a size like "100g" / "1.5kg".
function grams(val, u) {
  const n = parseFloat(val);
  return String(u).toLowerCase() === 'kg' ? n * 1000 : n;
}

// Tidy wholesale trade jargon into consumer-readable wording.
function tidyJargon(n) {
  return n
    .replace(/\bpd\b/ig, 'Peeled')          // peeled & deveined
    .replace(/\bhlso\b/ig, 'Shell-on')      // headless shell-on
    .replace(/\bhoso\b/ig, 'Head-on')       // head-on shell-on
    .replace(/\biqf\b/ig, ' ')              // individually quick frozen
    .replace(/\bu\s?\d+\b/ig, ' ')          // prawn size grade U5/U10
    .replace(/\b\d+\/\d+\b/g, ' ')          // prawn count grade 26/30
    .replace(/\b\d+%\s*/g, ' ')             // "40% ..."
    .replace(/\b(air\s*freight|glaze|reg|frz)\b/ig, ' ')
    .replace(/\bnet\b/ig, ' ');
}

// Strip pack/case wording; keep brand + product + a single size, then tidy jargon.
function retailName(name, sizeLabel) {
  let n = name
    .replace(PACK_RE, ' ')                              // drop "24X400ML"
    .replace(/\(\s*[\d.]+\s*(?:g|kg|ml)\s*\/?\s*(?:pack|loose)?\s*\)/ig, ' ') // drop "( 100g/pack)"
    .replace(/\/\s*(case|pack|gallon|bag|box|kg|loose)\b/ig, ' ') // drop "/ Case", "/ Kg"
    .replace(/\(\s*loose\s*\)/ig, ' ')
    .replace(/\(halal\)/ig, ' (Halal)');
  n = tidyJargon(n)
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,)])/g, '$1')
    .trim();
  // If we removed the size along with the pack, append the single size back.
  if (sizeLabel && !new RegExp(`${sizeLabel.replace('.', '\\.')}\\b`, 'i').test(n)) {
    n = `${n} ${sizeLabel}`.trim();
  }
  return n;
}

function niceRound(v) {
  // round UP to a tidy price point
  if (v < 10) { const r = Math.ceil(v * 20) / 20; return Math.round(r * 100) / 100; } // nearest 5p
  return Math.ceil(v * 2) / 2; // nearest 50p over £10
}

function toRetail(p) {
  const name0 = p.name;
  const m = name0.match(PACK_RE);
  let count = 1, sizeLabel = '', perUnitCost = Number(p.price), retUnit = 'each';
  if (m) {
    // multi-pack case "N x SIZE" → one unit; divide the case price by N
    count = Number(m[1]) || 1;
    sizeLabel = `${m[2]}${unitLower(m[3])}`;
    perUnitCost = Number(p.price) / count;
  } else if (String(p.unit).toLowerCase() === 'kg') {
    // priced PER KILO — if sold as a pack ("(100g/pack)"), scale £/kg by the pack fraction
    const pk = name0.match(/\(\s*([\d.]+)\s*(g|kg|ml)\b/i);
    if (pk) { perUnitCost = Number(p.price) * (grams(pk[1], pk[2]) / 1000); sizeLabel = `${pk[1]}${unitLower(pk[2])}`; }
    else { retUnit = 'kg'; }               // loose produce → keep selling by the kg
  } else {
    const s = name0.match(SINGLE_RE);       // already a single pack
    sizeLabel = s ? `${s[1]}${unitLower(s[2])}` : '';
  }
  const price = niceRound(perUnitCost * MARKUP);
  let name = retailName(name0, sizeLabel);
  if (retUnit === 'kg') name = `${name} (per kg)`;
  return { id: p.id, name, price, unit: retUnit, count, sizeLabel, perUnitCost,
           was: { name: name0, price: Number(p.price), unit: p.unit } };
}

// --- run -----------------------------------------------------------------
async function fromDb() {
  const { Pool } = require('pg');
  const conn = process.env.DATABASE_URL;
  const ssl = !/@(localhost|127\.0\.0\.1)/.test(conn) && !/sslmode=disable/.test(conn);
  const pool = new Pool({ connectionString: conn, ssl: ssl ? { rejectUnauthorized: false } : false });
  const { rows: shopRows } = await pool.query(`SELECT id FROM shops WHERE slug=$1`, [SHOP_SLUG]);
  if (!shopRows[0]) { console.error(`No shop "${SHOP_SLUG}".`); process.exit(1); }
  const shopId = shopRows[0].id;
  // Re-derive from the WHOLESALE source (products.json, matched by sku) so a re-run
  // always recomputes from the original — never double-processes already-broken rows.
  const src = new Map(
    JSON.parse(fs.readFileSync(path.join(__dirname, 'products.json'), 'utf8')).map((p) => [p.sku, p])
  );
  const { rows } = await pool.query(
    `SELECT id, sku, name, price, unit FROM products WHERE shop_id=$1 ORDER BY id`, [shopId]);
  const changes = rows.map((r) => {
    const o = r.sku && src.get(r.sku);
    return toRetail(o ? { id: r.id, name: o.name, price: o.price, unit: o.unit } : r);
  });
  preview(changes);
  if (!APPLY) { console.log('\n(dry run — nothing written. Re-run with APPLY=1 to apply.)'); await pool.end(); return; }
  let n = 0;
  for (const c of changes) {
    await pool.query(`UPDATE products SET name=$2, price=$3, unit=$4, cost_price=$5 WHERE id=$1 AND shop_id=$6`,
      [c.id, c.name, c.price, c.unit, Math.round(c.perUnitCost * 100) / 100, shopId]);
    n++;
  }
  console.log(`\n✅ Applied retail breakdown to ${n} products on "${SHOP_SLUG}".`);
  await pool.end();
}

function fromJson() {
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'products.json'), 'utf8'))
    .map((p, i) => ({ id: i + 1, name: p.name, price: p.price, unit: p.unit }));
  preview(items.map(toRetail));
  console.log('\n(preview from scripts/products.json — set DATABASE_URL to preview/apply against a shop.)');
}

function preview(changes) {
  const multipack = changes.filter((c) => c.count > 1);
  const bigSingles = changes.filter((c) => c.count === 1 && /(\d+(?:\.\d+)?)(kg|L)$/i.test(c.sizeLabel) && parseFloat(c.sizeLabel) >= 3);
  console.log(`Products: ${changes.length}  |  broken from multi-packs: ${multipack.length}  |  markup ×${MARKUP}`);
  console.log(`Large single units (≥3kg/3L — may still read as bulk): ${bigSingles.length}`);
  console.log('\n--- sample (wholesale  →  retail) ---');
  changes.filter((c) => c.count > 1).slice(0, 14).forEach((c) => {
    console.log(`£${c.was.price.toFixed(2)} ${c.was.name}`);
    console.log(`   → £${c.price.toFixed(2)}  ${c.name}  (÷${c.count})\n`);
  });
}

(process.env.DATABASE_URL ? fromDb() : Promise.resolve(fromJson()))
  .catch((e) => { console.error('Failed:', e.message); process.exit(1); });
