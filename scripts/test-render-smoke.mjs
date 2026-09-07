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
const SHIM = `<script>
window.electron = {
  isElectron: true, platform: 'smoke',
  config: { shopName: 'Smoke Shop', cloudApiUrl: 'http://127.0.0.1:1', shopSlug: 'demo', printer: { ip: '', port: 9100, autoPrint: false, kickDrawerOnCash: false }, labelPrinter: '' },
  getConfig: async () => ({ shop_name: 'Smoke Shop', cloud_api_url: 'http://127.0.0.1:1', shop_slug: 'demo', printer: {} }),
  saveConfig: async () => ({ success: true }), readClipboard: async () => '', pickConfigFile: async () => null, resetConfig: () => {},
  printReceipt: async () => ({ ok: false, error: 'smoke' }), kickDrawer: async () => ({ ok: false }), printZ: async () => ({ ok: false }),
  testPrint: async () => ({ ok: false }), listPrinters: async () => [], printLabel: async () => ({ ok: false }),
  getVersion: async () => '0.0.0-smoke', checkForUpdates: async () => ({ ok: false, reason: 'smoke' }), restartToUpdate: () => {},
  onUpdateStatus: () => {}, quitApp: () => {},
};
</script>`;

const ROUTES = ['#/', '#/till', '#/admin', '#/prep', '#/scan', '#/shop'];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

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
      const html = readFileSync(path.join(dist, 'index.html'), 'utf8').replace(/<script type="module"/, `${SHIM}\n    <script type="module"`);
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html);
    }
    const file = path.join(dist, p);
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // Headless Chrome ignores --timeout/--dump-dom while the staff screens keep
  // timers alive, so each run ends on our own kill (30 s). Run the routes in
  // PARALLEL (separate profiles) so the whole smoke stays ~30 s.
  const results = await Promise.all(ROUTES.map(async (route, idx) => {
    const url = `http://127.0.0.1:${port}/index.html${route}`;
    const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--enable-logging=stderr', '--v=0',
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
      }, 25000);
      c.on('close', () => { clearTimeout(t); finish(); });
      c.on('error', () => { clearTimeout(t); finish(); });
    });
    const uncaught = out.se.split('\n').filter((l) => /CONSOLE/.test(l) && /Uncaught|ChunkLoadError|Minified React error|\[siamshop\] render error/.test(l));
    const rootHtml = (out.so.match(/<div id="root">([\s\S]*?)<\/div>\s*<\/body>/) || [])[1] || '';
    const boundary = /Something went wrong on this screen/.test(rootHtml);
    return { route, uncaught, rootHtml, boundary, ok: uncaught.length === 0 && rootHtml.trim().length > 40 && !boundary };
  }));
  let fail = 0;
  for (const { route, uncaught, rootHtml, boundary, ok } of results) {
    console.log(`  ${ok ? '✅' : '❌'} ${route.padEnd(8)} root=${rootHtml.trim().length}ch${boundary ? ' ERROR-BOUNDARY' : ''}${uncaught.length ? ` uncaught=${uncaught.length}` : ''}`);
    if (!ok) { fail++; for (const l of uncaught.slice(0, 5)) console.log('     ', l.trim().slice(0, 300)); if (!rootHtml.trim().length) console.log('      (empty #root — blank window)'); if (boundary) console.log('      ', rootHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)); }
  }
  server.close();
  console.log(fail ? `\n❌ ${fail} route(s) failed to render` : `\n✅ all ${ROUTES.length} routes rendered`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
