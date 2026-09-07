// Shape the SiamShop demo shop as Cha & Pinto Box so the whole loop can be
// shown to the client: website → branded store → collection order → till, prep
// ticket and label. No code — everything here is settings already built.
//
//   BASE=… ADMIN_PASSWORD=… node scripts/brand-chapinto.mjs           # dry run
//   BASE=… ADMIN_PASSWORD=… node scripts/brand-chapinto.mjs --apply
//   … --shop demo        which shop to shape (default: demo)
//   … --logo round       use the round mark instead of the full lockup
//
// Idempotent: re-running just re-applies the same settings.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = (process.env.BASE || 'http://localhost:4999').replace(/\/$/, '');
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SHOP = (() => { const i = args.indexOf('--shop'); return i >= 0 ? args[i + 1] : 'demo'; })();
const LOGO_KIND = (() => { const i = args.indexOf('--logo'); return i >= 0 ? args[i + 1] : 'full'; })();

const ART = path.join(os.homedir(), 'Documents', 'SiamEPOS-Docs', 'client-sites', 'chapin-to-box', 'site', 'img');
// The app header is near-black, so the WHITE lockup is the one that reads there.
// On paper it is inverted, which prints the light artwork as ink (~44% coverage,
// under the "mostly black" warning). logo-round-white is the lighter option.
const LOGO_FILE = LOGO_KIND === 'round' ? 'logo-round-white.png' : 'logo-white.png';

// From the mockup's own CSS.
const SETTINGS = {
  brand_primary: '#131313',
  brand_accent: '#E9C09F',
  receipt_show_logo: '1',
  brand_logo_invert: '1',
  receipt_header: '16 London Road, Guildford GU1\n01483 599499',
  receipt_footer: 'Thank you — see you at the counter!',
  vat_number: '',
  receipt_style: 'rendered',
  print_size: 'normal',
  collection_enabled: 'true',
  collection_address: '16 London Road, Guildford GU1',
  shop_language_default: 'en',
  // Market and café hours; the lunch counter's own window lives on the
  // Lunch Boxes / Nibbles categories (SIAMSHOP-503).
  opening_hours: JSON.stringify({
    mon: { open: true, from: '10:30', to: '18:00' }, tue: { open: true, from: '10:30', to: '18:00' },
    wed: { open: true, from: '10:30', to: '18:00' }, thu: { open: true, from: '10:30', to: '18:00' },
    fri: { open: true, from: '10:30', to: '18:00' }, sat: { open: true, from: '10:30', to: '18:00' },
    sun: { open: true, from: '10:30', to: '17:00' },
  }),
};

// Thai names on the headline items, so the rendered receipt demo shows Thai.
const THAI_NAMES = {
  'Rice Lunch Box': 'ข้าวกล่อง',
  'Pud-Thai Noodle': 'ผัดไทย',
  'Spicy Drunken Noodle': 'ผัดขี้เมา',
  'Spicy Chilli Basil Pork Noodle': 'ผัดกะเพราหมู',
  'Deep-Fried Chicken Gyoza': 'เกี๊ยวซ่าไก่ทอด',
  'Vegetable Spring Rolls': 'ปอเปี๊ยะผัก',
  'Mixed Prawn Crackers': 'ข้าวเกรียบกุ้ง',
  'Caramel Thai Tea': 'ชาไทยคาราเมล',
  'Matcha Green Tea': 'ชาเขียวมัทฉะ',
  'CHATRAMUE THAI TEA MIX 400G': 'ชาตรามือ ชาไทย 400 กรัม',
  'TIPAROS FISH SAUCE 300ML': 'น้ำปลาทิพรส 300 มล.',
  'UMBRELLA JASMINE RICE 5KG': 'ข้าวหอมมะลิตราฉัตร 5 กก.',
};

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

async function main() {
  if (!PASSWORD) { console.error('ADMIN_PASSWORD is required.'); process.exit(1); }
  const logoPath = path.join(ART, LOGO_FILE);
  const haveLogo = existsSync(logoPath);
  console.log(`— shaping "${SHOP}" as Cha & Pinto Box on ${BASE}`);
  console.log(`  colours ${SETTINGS.brand_primary} / ${SETTINGS.brand_accent} · logo ${haveLogo ? LOGO_FILE + ' (inverted for paper)' : 'MISSING — skipping'}`);
  console.log(`  hours Mon–Sat 10:30–18:00, Sun 10:30–17:00 · lunch counter keeps its own 12:30–15:00 window`);
  console.log(`  Thai names on ${Object.keys(THAI_NAMES).length} headline products`);
  if (!APPLY) { console.log('\n[DRY RUN] Nothing written. Add --apply.'); return; }

  ({ token } = await api('POST', '/api/admin/login', { password: PASSWORD }));

  // Shop name — what the receipt and the storefront lockup say.
  try {
    await api('PUT', '/api/admin/shop', { name: 'Cha & Pinto Box' });
    console.log('  shop renamed to Cha & Pinto Box');
  } catch (e) { console.log(`  ! could not rename the shop (${e.message}) — set it in Admin → Settings → Shop`); }

  const body = { ...SETTINGS };
  if (haveLogo) body.brand_logo = `data:image/png;base64,${readFileSync(logoPath).toString('base64')}`;
  await api('PUT', '/api/admin/settings', body);
  console.log('  brand, hours, receipt and collection settings applied');

  // Thai names for the rendered-receipt demo.
  const products = (await api('GET', '/api/admin/products')) || [];
  let named = 0, missing = [];
  for (const [name, th] of Object.entries(THAI_NAMES)) {
    const p = products.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!p) { missing.push(name); continue; }
    try { await api('PUT', `/api/admin/products/${p.id}`, { ...p, name_th: th }); named++; }
    catch (e) { console.log(`  ! ${name}: ${e.message}`); }
  }
  console.log(`  Thai names set on ${named} products${missing.length ? ` (not found: ${missing.join(', ')})` : ''}`);

  const food = products.filter((p) => p.kind === 'food');
  console.log(`  ${food.length} made-to-order items — prep tickets will fire for these`);
  const settings = await api('GET', '/api/settings');
  console.log(`\n✅ Done. Storefront: ${BASE}/shop?shop=${SHOP}`);
  console.log(`   brand ${settings.brand_primary} / ${settings.brand_accent} · logo ${settings.brand_logo ? 'set' : 'none'} · receipts ${settings.receipt_style}`);
}
main().catch((e) => { console.error('✗', e.message); process.exit(1); });
