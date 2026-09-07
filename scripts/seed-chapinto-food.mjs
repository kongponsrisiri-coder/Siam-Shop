// Cha & Pinto Box hot food + boba counter → SiamShop products with options
// (SIAMSHOP-501/502/503). Taken from their published lunch and boba menus.
//
//   BASE=http://localhost:4999 ADMIN_PASSWORD=… node scripts/seed-chapinto-food.mjs          # dry run
//   BASE=… ADMIN_PASSWORD=… node scripts/seed-chapinto-food.mjs --apply
//   … --shop chapinto            write into another shop slug (default: demo)
//
// Idempotent: products are matched by name within the shop, so re-running
// updates price/options instead of duplicating. Everything here is
// made-to-order — kind='food', track_stock=false — so a sale never decrements
// stock and the prep screen picks the line up (SIAMSHOP-505).
//
// Sizes are modelled as ONE product with a Size option rather than separate
// "Medium"/"Large" products: that is how the counter rings it, and it keeps the
// prep ticket readable.
const BASE = (process.env.BASE || 'http://localhost:4999').replace(/\/$/, '');
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SHOP = (() => { const i = args.indexOf('--shop'); return i >= 0 ? args[i + 1] : 'demo'; })();

// Lunch counter 12:30–15:00 Mon–Sat; boba 10:30–18:00 every day (their site).
const LUNCH = { rules: [{ days: [1, 2, 3, 4, 5, 6], from: '12:30', to: '15:00' }] };
const BOBA_HOURS = { rules: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '10:30', to: '18:00' }] };

const SIZE_MED_LARGE = {
  name: 'Size', min_select: 1, max_select: 1,
  options: [{ name: 'Medium', price_delta: 0, is_default: true }, { name: 'Large', price_delta: 1.0 }],
};
const SIZE_REG_LARGE = {
  name: 'Size', min_select: 1, max_select: 1,
  options: [{ name: 'Regular', price_delta: 0, is_default: true }, { name: 'Large', price_delta: 0.75 }],
};
// Paid extras on the lunch dishes. Optional, any number.
const ADD_ONS = {
  name: 'Add-ons', min_select: 0, max_select: 3,
  options: [
    { name: 'Crispy Fried Egg', price_delta: 1.75 },
    { name: 'Panang Curry Sauce with Edamame', price_delta: 2.25 },
    { name: 'Sriracha Sauce', price_delta: 1.95 },
  ],
};
// The rice box is "choose 2 toppings". Their menu hides the rest behind "show
// more", so this is the published set — confirm the full list with the client.
const TOPPINGS = {
  name: 'Toppings (choose 2)', min_select: 2, max_select: 2,
  options: [
    { name: 'Spicy Chilli Basil Pork', price_delta: 0 },
    { name: 'Crispy Sweet Chilli Pork & Cashews', price_delta: 0 },
    { name: 'Fried Chicken & Panang Curry Sauce', price_delta: 0 },
  ],
};
const BROWN_SUGAR_BOBA = {
  name: 'Boba', min_select: 1, max_select: 1,
  options: [{ name: 'Brown sugar boba', price_delta: 0, is_default: true }, { name: 'No boba', price_delta: 0 }],
};
const POPPING_BOBA = {
  name: 'Popping boba', min_select: 1, max_select: 1,
  options: [{ name: 'Lychee', price_delta: 0, is_default: true }, { name: 'Strawberry', price_delta: 0 }, { name: 'Mango', price_delta: 0 }],
};

const CATALOGUE = [
  { category: 'Lunch Boxes', availability: LUNCH, items: [
    { name: 'Rice Lunch Box', price: 8.95, groups: [SIZE_MED_LARGE, TOPPINGS, ADD_ONS] },
    { name: 'Pud-Thai Noodle', price: 8.95, groups: [SIZE_MED_LARGE, ADD_ONS] },
    { name: 'Spicy Drunken Noodle', price: 8.95, groups: [SIZE_MED_LARGE, ADD_ONS] },
    { name: 'Spicy Chilli Basil Pork Noodle', price: 8.95, groups: [ADD_ONS] },
  ] },
  { category: 'Nibbles', availability: LUNCH, items: [
    { name: 'Deep-Fried Chicken Gyoza', price: 4.5, groups: [] },
    { name: 'Vegetable Spring Rolls', price: 4.5, groups: [] },
    { name: 'Mixed Prawn Crackers', price: 4.75, groups: [] },
  ] },
  { category: 'Boba & Dessert', availability: BOBA_HOURS, items: [
    { name: 'Okinawa Brown Tiger', price: 5.25, groups: [SIZE_REG_LARGE, BROWN_SUGAR_BOBA] },
    { name: 'Extreme Taro Fudge', price: 5.25, groups: [SIZE_REG_LARGE, BROWN_SUGAR_BOBA] },
    { name: 'Caramel Thai Tea', price: 5.25, groups: [SIZE_REG_LARGE, BROWN_SUGAR_BOBA] },
    { name: 'Matcha Green Tea', price: 5.25, groups: [SIZE_REG_LARGE, BROWN_SUGAR_BOBA] },
    { name: 'Lychee & Peach Bliss', price: 6.25, groups: [SIZE_REG_LARGE, POPPING_BOBA] },
    { name: 'Passionfruit & Mango Burst', price: 6.25, groups: [SIZE_REG_LARGE, POPPING_BOBA] },
    { name: 'Extreme Berry Cloud', price: 6.25, groups: [SIZE_REG_LARGE, POPPING_BOBA] },
    { name: 'Caramel Thai Tea x Vanilla Frappé', price: 6.25, groups: [SIZE_REG_LARGE] },
    { name: 'Okinawa Brown Tiger x Vanilla Frappé', price: 6.25, groups: [SIZE_REG_LARGE] },
    { name: 'Taro Fudge Tea x Vanilla Frappé', price: 6.25, groups: [SIZE_REG_LARGE] },
    { name: 'Extreme Matcha x Matcha Frappé', price: 6.25, groups: [SIZE_REG_LARGE] },
    { name: 'Oreo Choco & Berries Croffle', price: 6.25, groups: [] },
    { name: 'Banana & Nutella Croffle', price: 6.25, groups: [] },
    { name: 'Matcha Mochi & Caramel Croffle', price: 6.25, groups: [] },
    { name: "Berries & Hershey's Chocolate Croffle", price: 6.25, groups: [] },
  ] },
];

let token = '';
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}shop=${encodeURIComponent(SHOP)}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data?.error || text.slice(0, 120)}`);
  return data;
}

async function main() {
  if (!PASSWORD) { console.error('ADMIN_PASSWORD is required.'); process.exit(1); }
  const items = CATALOGUE.flatMap((c) => c.items);
  console.log(`— Cha & Pinto counter → ${BASE} (shop ${SHOP})`);
  console.log(`  ${CATALOGUE.length} categories, ${items.length} made-to-order products${APPLY ? '' : '   [DRY RUN — pass --apply to write]'}`);
  for (const c of CATALOGUE) {
    const win = c.availability.rules[0];
    console.log(`  ${c.category} (${win.from}–${win.to}, ${win.days.length === 7 ? 'every day' : 'Mon–Sat'}): ${c.items.map((i) => i.name).join(', ')}`);
  }
  if (!APPLY) { console.log('\nNothing written.'); return; }

  ({ token } = await api('POST', '/api/admin/login', { password: PASSWORD }));
  const existingCats = await api('GET', '/api/categories');
  const existingProds = await api('GET', '/api/admin/products');
  const byName = new Map((existingProds || []).map((p) => [p.name.toLowerCase(), p]));
  let created = 0, updated = 0;

  for (const group of CATALOGUE) {
    let cat = (existingCats || []).find((c) => c.name.toLowerCase() === group.category.toLowerCase());
    if (cat) await api('PUT', `/api/admin/categories/${cat.id}`, { name: group.category, availability: group.availability });
    else cat = await api('POST', '/api/admin/categories', { name: group.category, availability: group.availability });
    console.log(`  category ${group.category} → #${cat.id}`);

    for (const item of group.items) {
      const body = {
        name: item.name, price: item.price, category_id: cat.id,
        kind: 'food', track_stock: false, stock_qty: 0, is_active: true,
      };
      const found = byName.get(item.name.toLowerCase());
      let prod;
      if (found) { prod = await api('PUT', `/api/admin/products/${found.id}`, { ...found, ...body }); updated++; }
      else { prod = await api('POST', '/api/admin/products', body); created++; }
      const id = prod?.id || found?.id;
      // The endpoint takes { groups: [...] } — a bare array silently clears them.
      const saved = await api('PUT', `/api/admin/products/${id}/options`, { groups: item.groups.map((g, i) => ({ ...g, sort_order: i })) });
      const back = (saved && saved.option_groups) || [];
      if (back.length !== item.groups.length) throw new Error(`${item.name}: sent ${item.groups.length} option groups, server kept ${back.length}`);
      console.log(`    ${found ? 'updated' : 'created'} ${item.name} £${item.price.toFixed(2)}${back.length ? ` (${back.length} option groups: ${back.map((g) => g.name).join(', ')})` : ''}`);
    }
  }
  console.log(`\n✅ ${created} created, ${updated} updated. Lunch 12:30–15:00 Mon–Sat · Boba 10:30–18:00 daily.`);
  console.log('   Confirm with the client: the full rice-box topping list (their menu hides some behind "show more").');
}
main().catch((e) => { console.error('✗', e.message); process.exit(1); });
