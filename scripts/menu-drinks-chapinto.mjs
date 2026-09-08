// The Drinks section of Cha & Pinto's café menu (SIAMSHOP-506).
//
// The counter seed covered lunch boxes, nibbles, boba and croffles but stopped
// there, so the fifteen bottles the café sells over the counter — Mogu Mogu,
// Oishi, Coke, Aloe Vera, Grass Jelly, Coconut Water, Thai Tea, Still Water —
// existed nowhere in the till (Korakot, 8 Sep). This reads them off the live
// menu with their prices and photos and creates them.
//
//   BASE=… ADMIN_PASSWORD=… node scripts/menu-drinks-chapinto.mjs            # dry run
//   BASE=… ADMIN_PASSWORD=… node scripts/menu-drinks-chapinto.mjs --apply
//   … --shop demo     which shop (default: chapinto)
//
// They are retail bottles, not made to order, so they are stock-tracked and
// start at 10 like the rest of the imported catalogue. Idempotent: a product
// with the same name is left alone.
const MENUS = 'https://www.chapintobox.co.uk/menus';
import { login } from './lib/adminAuth.mjs';

const BASE = (process.env.BASE || 'http://localhost:4999').replace(/\/$/, '');
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SHOP = (() => { const i = args.indexOf('--shop'); return i >= 0 ? args[i + 1] : 'chapinto'; })();
const CATEGORY = 'Drinks';
const OPENING_STOCK = 10;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// The menu's Drinks section, by name. Taken from the page rather than guessed,
// but pinned here so a change on their side is visible as a miss rather than
// silently importing something else.
const DRINKS = [
  'MOGU MOGU BLACKCURRANT 320ML', 'MOGU MOGU PASSIONFRUIT 320ML', 'MOGU PINK GUAVA 320ML',
  'MOGU MOGU LYCHEE 320ML', 'MOGU MOGU WATERMELON 320ML', 'MOGU MOGU STRAWBERRY 320ML',
  'Oishi Green Tea - Original', 'Oishi Green Tea - Genmai', 'Diet Coke', 'Coke',
  'Aloe Vera Drink', 'Thai Tea with Basil Seeds', 'Grass Jelly Drink', 'Coconut Water',
  'Still Water 500 ml',
];
const norm = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function menuItems() {
  const res = await fetch(MENUS, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET /menus → ${res.status}`);
  const html = await res.text();
  // Items carry a description; the price variants nested inside them do not.
  const anchors = [...html.matchAll(/"name":"((?:[^"\\]|\\.)*)","description":"(?:[^"\\]|\\.)*"/g)]
    .map((m) => ({ at: m.index, name: JSON.parse(`"${m[1]}"`) }));
  return anchors.map((a, i) => {
    const chunk = html.slice(a.at, i + 1 < anchors.length ? anchors[i + 1].at : a.at + 4000);
    const price = /"price":"([0-9.]+)"/.exec(chunk);
    const image = /"image":\{"id":"([^"]+)"/.exec(chunk);
    return { name: a.name, price: price ? Number(price[1]) : null, image: image ? image[1] : null };
  });
}

let token = '';
async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}${p.includes('?') ? '&' : '?'}shop=${encodeURIComponent(SHOP)}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${(data && data.error) || text.slice(0, 140)}`);
  return data;
}
async function photo(id) {
  const url = `https://static.wixstatic.com/media/${id}/v1/fill/w_1000,h_1000,al_c,q_85,enc_auto/${id}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: MENUS } });
  if (!r.ok) throw new Error(`photo ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const mime = /\.png$/i.test(id) ? 'image/png' : /\.webp$/i.test(id) ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function main() {
  if (!PASSWORD && !process.env.STAFF_PIN) { console.error('Set STAFF_PIN (a manager PIN) or ADMIN_PASSWORD.'); process.exit(1); }
  const menu = await menuItems();
  const wanted = DRINKS.map((n) => {
    const hit = menu.find((m) => norm(m.name) === norm(n));
    return hit || { name: n, price: null, image: null, notOnMenu: true };
  });
  const gone = wanted.filter((d) => d.notOnMenu || d.price == null);
  if (gone.length) console.log(`  ! not found on the menu any more: ${gone.map((g) => g.name).join(', ')}`);

  const auth = await login(BASE, SHOP);
  token = auth.token;
  console.log(`  signed in with the ${auth.as}`);
  const cats = await api('GET', '/api/categories');
  const cat = (Array.isArray(cats) ? cats : cats.categories || []).find((c) => c.name === CATEGORY);
  if (!cat) throw new Error(`No "${CATEGORY}" category on ${SHOP} — create it first`);
  const products = await api('GET', '/api/admin/products');
  const have = new Set(products.map((p) => norm(p.name)));

  const todo = wanted.filter((d) => !d.notOnMenu && d.price != null && !have.has(norm(d.name)));
  const already = wanted.length - gone.length - todo.length;
  console.log(`— ${SHOP}: ${wanted.length} drinks on the menu, ${already} already in the till, ${todo.length} to add`);
  for (const d of todo) console.log(`  + ${d.name}  £${d.price.toFixed(2)}  ${d.image ? 'with photo' : 'NO PHOTO'}`);

  // Same bottle, two prices: worth a look rather than a silent duplicate.
  for (const d of todo) {
    const words = norm(d.name).split(' ').filter((w) => w.length > 3);
    const near = products.filter((p) => words.length && words.slice(0, 2).every((w) => norm(p.name).includes(w)));
    for (const n of near) console.log(`    ~ looks like the existing "${n.name}" (£${n.price}) — check before selling both`);
  }
  if (!APPLY) { console.log(`\n[DRY RUN] Nothing written. Add --apply.`); return; }

  let made = 0;
  for (const d of todo) {
    try {
      const p = await api('POST', '/api/admin/products', {
        name: d.name, price: d.price, category_id: cat.id, kind: 'retail',
        unit: 'each', stock_qty: OPENING_STOCK, track_stock: true, is_active: true,
      });
      if (d.image) await api('POST', `/api/admin/products/${p.id}/photo`, { dataUrl: await photo(d.image) });
      made++;
      console.log(`  ✓ ${d.name}${d.image ? ' + photo' : ''}`);
    } catch (e) { console.log(`  ✗ ${d.name}: ${e.message}`); }
  }
  const after = await api('GET', '/api/admin/products');
  const inCat = after.filter((p) => p.category_id === cat.id);
  console.log(`\n✅ ${made} added — "${CATEGORY}" now holds ${inCat.length}, ${inCat.filter((p) => p.image_url).length} with a photo.`);
}
main().catch((e) => { console.error('✗', e.message); process.exit(1); });
