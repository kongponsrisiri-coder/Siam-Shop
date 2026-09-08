// Render smoke test (HOTFIX 0.1.2). v0.1.1 shipped a Till that threw a TDZ
// ReferenceError on first render → blank window; every API test was green
// because nobody RENDERED the screens. This builds the Electron client, serves
// client/dist-electron with a stub `window.electron` injected, loads each staff
// route in headless Chrome and FAILS on any "Uncaught" console error or an
// empty #root. Runs in release.yml before electron-builder.
//
//   node scripts/test-render-smoke.mjs            # build + smoke
//   node scripts/test-render-smoke.mjs --no-build # smoke the existing dist-electron
//   CHROME_BIN=/path/to/chrome node scripts/test-render-smoke.mjs
import { spawnSync, spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'client', 'dist-electron');
const noBuild = process.argv.includes('--no-build');

function chromeBin() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  const hit = candidates.find((c) => existsSync(c));
  if (hit) return hit;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
    const w = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
    if (w.status === 0 && w.stdout.trim()) return w.stdout.trim().split('\n')[0];
  }
  return null;
}

// Stub of electron/preload.js — same surface as client/src/electron.js expects.
// Cloud URL points at a closed port so API calls fail fast (a fetch error must
// never blank the screen either).
const shim = (apiUrl, authed) => `<script>
${authed ? `try { localStorage.setItem('siamshop_admin_token', 'smoke-token'); localStorage.setItem('siamshop_staff', JSON.stringify({ name: 'Smoke Manager', role: 'manager', sid: 1 })); } catch (e) {}` : `try { localStorage.clear(); } catch (e) {}`}
window.electron = {
  isElectron: true, platform: 'smoke',
  config: { shopName: 'Smoke Shop', cloudApiUrl: '${apiUrl}', shopSlug: 'demo', printer: { ip: '', port: 9100, autoPrint: false, kickDrawerOnCash: false }, labelPrinter: '', scanner: { suffix: 'enter', captureAnywhere: true }, deviceId: 'smoke-device', receiptPrinterId: 1, printingTill: true },
  getConfig: async () => ({ shopName: 'Smoke Shop', cloudApiUrl: '${apiUrl}', shopSlug: 'demo', printer: { ip: '', port: 9100, name: '', lprQueue: 'lp', autoPrint: true, kickDrawerOnCash: true }, scanner: { suffix: 'enter', captureAnywhere: true }, deviceId: 'smoke-device', receiptPrinterId: 1, printingTill: true, version: '0.0.0-smoke' }),
  printPrep: async () => ({ ok: true }),
  saveConfig: async () => ({ success: true }), readClipboard: async () => '', pickConfigFile: async () => null, resetConfig: () => {},
  printReceipt: async () => ({ ok: false, error: 'smoke' }), kickDrawer: async () => ({ ok: false }), printZ: async () => ({ ok: false }),
  testPrint: async () => ({ ok: false }), listPrinters: async () => [{ name: '_192_168_68_54', displayName: '_192_168_68_54', label: 'POS-80', model: 'POS-80', queue: '_192_168_68_54', isDefault: true }], printLabel: async () => ({ ok: false }),
  scanPrinters: async () => ({ subnet: '10.0.0.0/24', printers: [{ ip: '10.0.0.50', port: 9100, model: '' }] }),
  getVersion: async () => '0.0.0-smoke', checkForUpdates: async () => ({ ok: false, reason: 'smoke' }), restartToUpdate: () => {},
  onUpdateStatus: () => {}, quitApp: () => {},
};
</script>`;

// Routes. Unauthed ones show the PIN pad / storefront; AUTHED ones run with a
// stub staff session + a fake API (below), so the screens BEHIND the gate
// render too — Till, Prep and every Admin section (DEVICE-001 lesson: the
// device/brand cards never appeared in the unauthed smoke).
const ROUTES = [
  { hash: '#/', authed: false, expect: /Enter your PIN|Till sign in/ },
  { hash: '#/till', authed: false, expect: /Enter your PIN/ },
  { hash: '#/shop', authed: false },
  // A marketing site's deep link: resolves, adds, and lands on the basket.
  { hash: '#/p/Test%20Product?add=1', authed: false, expect: /added to your basket|Cart|basket/i },
  // cashpad-keys: the cash tender pad must draw on the till, not just compile.
  { hash: '#/till', authed: true, expect: /(Scan barcode|till-scan)[\s\S]*cashpad-keys/, forbid: /Enter your PIN/ },
  { hash: '#/prep', authed: true, forbid: /Enter your PIN/ },
  { hash: '#/scan', authed: true },
  ...['dashboard', 'reports', 'products', 'categories', 'orders', 'customers', 'campaigns', 'chats', 'staff', 'settings', 'device'].map((t) => ({ hash: `#/admin?tab=${t}`, authed: true, forbid: /Enter your PIN|Manager or owner only/ })),
];
// Minimal JSON the screens need to draw with an empty shop. Anything not
// listed gets [] — a screen that crashes on empty data is a real bug.
const FAKE_API = {
  '/api/health': { status: 'ok', db: 'ok', stripe: 'unconfigured' },
  '/api/staff/me': { role: 'manager', name: 'Smoke Manager', sid: 1 },
  '/api/admin/me': { ok: true, role: 'manager', name: 'Smoke Manager' },
  '/api/settings': { minimum_order_amount: 0, currency: 'GBP', discount_reasons: ['Staff'], receipt_copies: 1, opening_hours: null, open_now: true, collection_enabled: false, brand_primary: '', brand_accent: '', brand_logo: '', receipt_show_logo: false },
  '/api/admin/settings': { minimum_order_amount: '0', receipt_header: '', receipt_footer: '', vat_number: '', receipt_copies: '1' },
  '/api/admin/shop': { id: 1, name: 'Smoke Shop', slug: 'demo' },
  '/api/admin/chats': { sessions: [] },
  '/api/products/resolve': { id: 7, name: 'Test Product', price: 2.5, stock_qty: 5, track_stock: true, option_groups: [], available_now: true },
  '/api/shop': { id: 1, name: 'Smoke Shop', slug: 'demo' },
  '/api/till/session': { session: null, summary: null },
  '/api/admin/report': { range: {}, totals: { gross: 0, count: 0 }, by_channel: [], by_payment: [], by_day: [], top_products: [], discounts: { total: 0, by_reason: [], by_staff: [] }, refunds: { count: 0, total: 0, by_reason: [] }, voids: { count: 0, total: 0 }, wastage: { value: 0, items: [] } },
  '/api/admin/stats': { today: { gross: 0, count: 0 }, week: [], low_stock: [], recent: [] },
  '/api/sales/summary': { totals: { gross: 0, order_count: 0, cash: 0, card: 0 }, by_payment: [], by_channel: [] },
  '/api/prep': { orders: [] },
  '/api/admin/dashboard': { counts: { products: 0, orders: 0, customers: 0, low_stock: 0, pending: 0, active_products: 0, out_of_stock: 0 }, sales: { day: { gross: 0, count: 0 }, week: { gross: 0, count: 0 }, month: { gross: 0, count: 0 }, all: { gross: 0, count: 0 } }, sales_7d: [], top_products: [], by_channel: [], low_stock: [], recent_orders: [] },
  '/api/refund-reasons': { refund: [], void: [], restock: [] },
  '/api/printers': { printers: [{ id: 1, name: 'Front till', kind: 'network', ip: '10.0.0.50', port: 9100, job: 'receipt', prep_categories: [], active: true }, { id: 2, name: 'Kitchen', kind: 'network', ip: '10.0.0.51', port: 9100, job: 'prep', prep_categories: [], active: true }], printing_device_id: 'smoke-device' },
  '/api/prep/print-queue': { device_id: 'smoke-device', designated: true, tickets: [], held: 0 },
  '/api/prep/tickets': [],
  '/api/admin/campaigns/segments': { lapsed_days: 45, total: 0, eligible: 0, segments: [{ id: 'all', label: 'All consented', count: 0 }], categories: [], cap: { daily: 300, sent_today: 0, remaining: 300 } },
  '/api/admin/campaigns/recipient-count': { count: 0, cap: 300, sent_today: 0, remaining: 300 },
  '/api/admin/automations': { lapsed_days: 45, brevo_daily_cap: 300, automations: { lapsed: { enabled: false, subject: 's', body: 'b' }, review: { enabled: false, subject: 's', body: 'b' }, birthday: { enabled: false, subject: 's', body: 'b' } }, recent: [], defaults: {} },
  '/api/pickup-slots': { asap: true, slots: [] },
  '/api/clock/status': { clocked_in: [] },
};
function startFakeApi() {
  const srv = createServer((req, res) => {
    const p = req.url.split('?')[0];
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Device-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    res.setHeader('Content-Type', 'application/json');
    const hit = FAKE_API[p];
    res.writeHead(200);
    res.end(JSON.stringify(hit !== undefined ? hit : []));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

let apiUrl = 'http://127.0.0.1:1';
async function main() {
  if (!noBuild) {
    console.log('— building Electron client (ELECTRON_BUILD=1, empty VITE_API_BASE)');
    const b = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-electron-client.js')], { stdio: 'inherit' });
    if (b.status !== 0) { console.log('❌ client build failed'); process.exit(1); }
  }
  if (!existsSync(path.join(dist, 'index.html'))) { console.log(`❌ ${dist}/index.html missing`); process.exit(1); }
  const chrome = chromeBin();
  if (!chrome) { console.log('❌ No Chrome/Chromium found — set CHROME_BIN'); process.exit(1); }
  console.log('— chrome:', chrome);

  const server = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    if (p === '/' || p === '/index.html') {
      const authed = /(^|[?&])authed=1/.test(req.url.split('#')[0]);
      const html = readFileSync(path.join(dist, 'index.html'), 'utf8').replace(/<script type="module"/, `${shim(apiUrl, authed)}\n    <script type="module"`);
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html);
    }
    const file = path.join(dist, p);
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  const fake = await startFakeApi();
  apiUrl = `http://127.0.0.1:${fake.address().port}`;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // Headless Chrome ignores --timeout/--dump-dom while the staff screens keep
  // timers alive, so each run ends on our own kill. Routes run in parallel
  // (separate profiles), but in BATCHES: launching all sixteen at once starved
  // a 2-core CI runner and every one was killed before it printed a thing, so
  // the v0.1.10 release read as sixteen blank screens when the app was fine.
  // Concurrency and the kill are sized off the machine, and can be overridden.
  const CONCURRENCY = Number(process.env.SMOKE_CONCURRENCY) || Math.max(2, Math.min(8, cpus().length));
  const KILL_MS = Number(process.env.SMOKE_KILL_MS) || (process.env.CI ? 60000 : 25000);
  console.log(`— ${ROUTES.length} routes, ${CONCURRENCY} at a time, ${KILL_MS / 1000}s each`);
  const runRoute = async (route, idx) => {
    const url = `http://127.0.0.1:${port}/index.html${route.authed ? '?authed=1' : ''}${route.hash}`;
    const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--enable-logging=stderr', '--v=0',
      '--virtual-time-budget=5000', '--timeout=8000', '--window-size=1280,800', `--user-data-dir=${path.join(root, 'client', '.smoke-profile', String(idx))}`, '--dump-dom', url];
    const out = await new Promise((resolve) => {
      // detached → own process group, so the kill takes Chrome's helpers too
      // (an orphaned helper keeps our pipes open and 'close' never fires).
      const c = spawn(chrome, args, { detached: process.platform !== 'win32' });
      let so = '', se = '', done = false;
      const finish = () => { if (!done) { done = true; resolve({ so, se }); } };
      c.stdout.on('data', (d) => (so += d)); c.stderr.on('data', (d) => (se += d));
      const t = setTimeout(() => {
        try { process.platform === 'win32' ? c.kill('SIGKILL') : process.kill(-c.pid, 'SIGKILL'); } catch {}
        setTimeout(finish, 500); // resolve with whatever we captured
      }, KILL_MS);
      c.on('close', () => { clearTimeout(t); finish(); });
      c.on('error', () => { clearTimeout(t); finish(); });
    });
    const uncaught = out.se.split('\n').filter((l) => /CONSOLE/.test(l) && /Uncaught|ChunkLoadError|Minified React error|\[siamshop\] render error/.test(l));
    const rootHtml = (out.so.match(/<div id="root">([\s\S]*?)<\/div>\s*<\/body>/) || [])[1] || '';
    const boundary = /Something went wrong on this screen/.test(rootHtml);
    const text = rootHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const expectOk = !route.expect || route.expect.test(rootHtml);
    const forbidOk = !route.forbid || !route.forbid.test(text);
    return { route, uncaught, rootHtml, boundary, expectOk, forbidOk, stderrTail: out.se.trim().split('\n').slice(-6).join('\n'),
             ok: uncaught.length === 0 && rootHtml.trim().length > 40 && !boundary && expectOk && forbidOk };
  };
  const results = [];
  for (let i = 0; i < ROUTES.length; i += CONCURRENCY) {
    const batch = ROUTES.slice(i, i + CONCURRENCY);
    results.push(...await Promise.all(batch.map((route, j) => runRoute(route, i + j))));
  }
  fake.close();
  let fail = 0;
  for (const { route, uncaught, rootHtml, boundary, expectOk, forbidOk, stderrTail, ok } of results) {
    const label = `${route.hash}${route.authed ? ' (signed in)' : ''}`;
    console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(30)} root=${rootHtml.trim().length}ch${boundary ? ' ERROR-BOUNDARY' : ''}${uncaught.length ? ` uncaught=${uncaught.length}` : ''}${!expectOk ? ' EXPECTED-TEXT-MISSING' : ''}${!forbidOk ? ' STILL-ON-GATE' : ''}`);
    if (!ok) { fail++; for (const l of uncaught.slice(0, 5)) console.log('     ', l.trim().slice(0, 300)); if (!rootHtml.trim().length) console.log('      (empty #root — blank window, or Chrome never dumped the DOM)'); if (boundary || !expectOk || !forbidOk) console.log('      ', rootHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
      if (!rootHtml.trim().length && stderrTail) for (const l of stderrTail.split('\n')) console.log('       chrome:', l.slice(0, 220)); }
  }
  server.close();
  console.log(fail ? `\n❌ ${fail} route(s) failed to render` : `\n✅ all ${ROUTES.length} routes rendered`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
