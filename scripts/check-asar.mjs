// Packaged-app check (HOTFIX v0.1.7): every local `require('./x')` referenced by
// the Electron main-process files must exist INSIDE app.asar, and every
// electron/*.js must be packaged. v0.1.5/v0.1.6 shipped without raster.js and
// printerScan.js (a hand-written build.files list) and crashed on launch.
//   node scripts/check-asar.mjs <path/to/app.asar>
import { readdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asar = process.argv[2];
if (!asar) { console.error('usage: node scripts/check-asar.mjs <app.asar>'); process.exit(2); }
const listing = execSync(`npx --yes @electron/asar list "${asar}"`, { encoding: 'utf8' }).split(/\r?\n/).map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean);
const has = (rel) => listing.includes('/' + rel) || listing.includes(rel);

const electronDir = path.join(root, 'electron');
const jsFiles = readdirSync(electronDir).filter((f) => f.endsWith('.js'));
let fail = 0;
for (const f of jsFiles) {
  if (!has(f)) { console.log(`  ❌ ${f} is NOT in app.asar`); fail++; } else console.log(`  ✅ ${f} packaged`);
  const src = readFileSync(path.join(electronDir, f), 'utf8');
  for (const m of src.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)) {
    const target = m[1].replace(/^\.\//, '').replace(/\.js$/, '') + '.js';
    if (!has(target)) { console.log(`  ❌ ${f} requires ./${target} which is NOT in app.asar`); fail++; }
  }
}
if (!has('package.json')) { console.log('  ❌ package.json missing from app.asar'); fail++; }
// The renderer needs its typefaces at runtime; a missing fonts/ dir only shows
// when someone prints (SIAMSHOP-PRINT-RENDER-001).
for (const f of ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'Sarabun-Regular.ttf', 'Sarabun-Bold.ttf']) {
  if (has(`fonts/${f}`)) console.log(`  ✅ fonts/${f} packaged`);
  else { console.log(`  ❌ fonts/${f} is NOT in app.asar — rendered tickets would fail`); fail++; }
}
if (!listing.some((l) => /node_modules\/pureimage\//.test(l))) { console.log('  ❌ pureimage is NOT in app.asar'); fail++; }
else console.log('  ✅ pureimage packaged');
console.log(fail ? `\n❌ app.asar is missing ${fail} module(s) — the app would crash on launch` : `\n✅ app.asar contains every main-process module (${jsFiles.length} files)`);
process.exit(fail ? 1 : 0);
