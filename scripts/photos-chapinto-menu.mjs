// Counter photos for Cha & Pinto Box (SIAMSHOP-506).
//
// The grocery catalogue came from the Wix *store* sitemap, which has no food in
// it — the café menu lives in the Wix Restaurants app on /menus instead, so the
// 22 counter items were seeded without pictures. This lifts each menu item's
// photo off that page and stores it on our own product, the same way
// load-chapinto.mjs did for groceries (uploaded to /api/admin/products/:id/photo
// so nothing keeps pointing at the client's Wix account after they leave it).
//
//   BASE=… ADMIN_PASSWORD=… node scripts/photos-chapinto-menu.mjs            # dry run
//   BASE=… ADMIN_PASSWORD=… node scripts/photos-chapinto-menu.mjs --apply
//   … --shop chapinto     which shop to write to (default: chapinto)
//   … --force             replace photos that are already set
//
// Idempotent: without --force it skips any product that already has a photo.
const MENUS = 'https://www.chapintobox.co.uk/menus';
const BASE = (process.env.BASE || 'http://localhost:4999').replace(/\/$/, '');
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const SHOP = (() => { const i = args.indexOf('--shop'); return i >= 0 ? args[i + 1] : 'chapinto'; })();
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Their menu names carry the format as a suffix ("… Croffle", "… Frappé") and
// the lunch box is split by size, which is an option group on our side.
function key(name) {
  return String(name).toLowerCase()
    .replace(/é/g, 'e')
    .replace(/\b(croffle|frappe|frappé)\b/g, '')
    .replace(/^(medium|large|regular)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function menuPhotos() {
  const res = await fetch(MENUS, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET /menus → ${res.status}`);
  const html = await res.text();
  // Item objects in the embedded menu JSON carry a description; the price
  // variants nested inside them (Medium/Large) do not, so a description is what
  // separates a real item from a variant.
  const names = [...html.matchAll(/"name":"((?:[^"\\]|\\.)*)","description":"(?:[^"\\]|\\.)*"/g)]
    .map((m) => ({ at: m.index, name: JSON.parse(`"${m[1]}"`) }));
  const out = new Map();
  for (const m of html.matchAll(/"image":\{"id":"([^"]+)"/g)) {
    const owner = names.filter((n) => n.at < m.index).pop();
    if (owner && !out.has(key(owner.name))) out.set(key(owner.name), { name: owner.name, id: m[1] });
  }
  return out;
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

async function fetchPhoto(id) {
  // 1000px square is plenty for a tile and stays well under the 6 MB cap.
  const url = `https://static.wixstatic.com/media/${id}/v1/fill/w_1000,h_1000,al_c,q_85,enc_auto/${id}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: MENUS } });
  if (!r.ok) throw new Error(`photo ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const mime = /\.png$/i.test(id) ? 'image/png' : /\.webp$/i.test(id) ? 'image/webp' : 'image/jpeg';
  return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length };
}

async function main() {
  if (!PASSWORD) { console.error('ADMIN_PASSWORD is required.'); process.exit(1); }
  const photos = await menuPhotos();
  console.log(`— ${photos.size} menu items with a photo on ${MENUS}`);

  ({ token } = await api('POST', '/api/admin/login', { password: PASSWORD }));
  const products = await api('GET', '/api/admin/products');
  const food = products.filter((p) => p.kind === 'food');
  console.log(`— ${food.length} counter items on "${SHOP}" (${food.filter((p) => p.image_url).length} already have a photo)\n`);

  const plan = [], missing = [];
  for (const p of food) {
    const hit = photos.get(key(p.name));
    if (!hit) { missing.push(p.name); continue; }
    if (p.image_url && !FORCE) { console.log(`  = ${p.name} — already has a photo, skipping`); continue; }
    plan.push({ product: p, photo: hit });
  }
  for (const x of plan) console.log(`  + ${x.product.name}  ←  ${x.photo.name}`);
  if (missing.length) console.log(`\n  ! no menu photo for: ${missing.join(', ')}`);

  if (!APPLY) { console.log(`\n[DRY RUN] ${plan.length} would be set. Add --apply.`); return; }

  let ok = 0;
  for (const x of plan) {
    try {
      const { dataUrl, bytes } = await fetchPhoto(x.photo.id);
      await api('POST', `/api/admin/products/${x.product.id}/photo`, { dataUrl });
      ok++;
      console.log(`  ✓ ${x.product.name} (${Math.round(bytes / 1024)} kB)`);
    } catch (e) { console.log(`  ✗ ${x.product.name}: ${e.message}`); }
  }
  const after = (await api('GET', '/api/admin/products')).filter((p) => p.kind === 'food');
  console.log(`\n✅ ${ok} photos set — ${after.filter((p) => p.image_url).length}/${after.length} counter items now have one.`);
}
main().catch((e) => { console.error('✗', e.message); process.exit(1); });
