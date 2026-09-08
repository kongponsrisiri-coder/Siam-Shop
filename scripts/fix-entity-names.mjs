// Repair product names and descriptions that carry raw HTML entities.
//
// The Wix JSON-LD serves HTML-escaped text, so "S&B Golden Curry" was imported
// as "S&amp;B GOLDEN CURRY" and shoppers saw that on the shelf and on their
// receipt. scrape-chapinto.mjs now decodes at the source; this repairs the
// catalogues already loaded (Korakot, 8 Sep — found because a deep link to
// "Oishi Green Tea Honey & Lemon" could not match the stored name).
//
//   BASE=… ADMIN_PASSWORD=… node scripts/fix-entity-names.mjs            # dry run
//   BASE=… ADMIN_PASSWORD=… node scripts/fix-entity-names.mjs --apply
//   … --shop demo      which shop (default: chapinto)
//
// Idempotent: decoded text contains no entities, so a second run finds nothing.
const BASE = (process.env.BASE || 'http://localhost:4999').replace(/\/$/, '');
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SHOP = (() => { const i = args.indexOf('--shop'); return i >= 0 ? args[i + 1] : 'chapinto'; })();

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const HAS_ENTITY = /&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/i;
export function decodeEntities(v) {
  return String(v == null ? '' : v)
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => ENTITIES[n])
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
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

async function main() {
  if (!PASSWORD) { console.error('ADMIN_PASSWORD is required.'); process.exit(1); }
  ({ token } = await api('POST', '/api/admin/login', { password: PASSWORD }));
  const products = await api('GET', '/api/admin/products');
  const bad = products.filter((p) => HAS_ENTITY.test(p.name || '') || HAS_ENTITY.test(p.description || ''));
  console.log(`— ${SHOP}: ${products.length} products, ${bad.length} carrying a raw HTML entity`);
  for (const p of bad) console.log(`  ${p.name}  →  ${decodeEntities(p.name)}`);
  if (!APPLY) { console.log(`\n[DRY RUN] Nothing written. Add --apply.`); return; }

  let fixed = 0;
  for (const p of bad) {
    try {
      await api('PUT', `/api/admin/products/${p.id}`, {
        ...p, name: decodeEntities(p.name),
        description: p.description ? decodeEntities(p.description) : p.description,
      });
      fixed++;
    } catch (e) { console.log(`  ✗ ${p.name}: ${e.message}`); }
  }
  const after = await api('GET', '/api/admin/products');
  console.log(`\n✅ ${fixed} repaired — ${after.filter((p) => HAS_ENTITY.test(p.name || '')).length} still carrying an entity.`);
}
if (process.argv[1] && process.argv[1].endsWith('fix-entity-names.mjs')) {
  main().catch((e) => { console.error('✗', e.message); process.exit(1); });
}
