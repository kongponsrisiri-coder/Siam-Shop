// Delete categories that hold nothing.
//
// A shop that has been through an import is left with the seed's categories
// sitting empty beside the real ones — Korakot tapped "Desserts, Snacks &
// Drinks" and got "No products found" (8 Sep). Shoppers and the till no longer
// see them, but they still clutter Admin, so this clears them out.
//
//   BASE=… STAFF_PIN=… node scripts/tidy-empty-categories.mjs            # dry run
//   BASE=… STAFF_PIN=… node scripts/tidy-empty-categories.mjs --apply
//   … --shop demo     which shop (default: chapinto)
//
// Only ever deletes a category with zero products, active or not, so nothing
// can be orphaned. Idempotent.
import { login } from './lib/adminAuth.mjs';

const BASE = (process.env.BASE || 'http://localhost:4999').replace(/\/$/, '');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SHOP = (() => { const i = args.indexOf('--shop'); return i >= 0 ? args[i + 1] : 'chapinto'; })();

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
  const auth = await login(BASE, SHOP);
  token = auth.token;
  console.log(`  signed in with the ${auth.as}`);

  const cats = await api('GET', '/api/categories');
  const list = Array.isArray(cats) ? cats : cats.categories || [];
  // The admin product list includes inactive stock, which the public
  // product_count does not — a category holding only hidden products is NOT
  // empty and must survive.
  const products = await api('GET', '/api/admin/products');
  const used = new Set(products.map((p) => p.category_id).filter((x) => x != null));
  const empty = list.filter((c) => !used.has(c.id));

  console.log(`— ${SHOP}: ${list.length} categories, ${empty.length} hold nothing`);
  for (const c of empty) console.log(`  − ${c.name}`);
  if (!empty.length) return;
  if (!APPLY) { console.log(`\n[DRY RUN] Nothing deleted. Add --apply.`); return; }

  let gone = 0;
  for (const c of empty) {
    try { await api('DELETE', `/api/admin/categories/${c.id}`); gone++; }
    catch (e) { console.log(`  ✗ ${c.name}: ${e.message}`); }
  }
  const after = await api('GET', '/api/categories');
  const left = Array.isArray(after) ? after : after.categories || [];
  console.log(`\n✅ ${gone} deleted — ${left.length} categories left: ${left.map((c) => c.name).join(', ')}`);
}
main().catch((e) => { console.error('✗', e.message); process.exit(1); });
