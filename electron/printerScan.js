// "Find printers" (SIAMSHOP-DEVICE-001 D1) — port of the restaurant's
// GET /api/printers/scan into the desktop MAIN process (SiamShop has no local
// server). Sweeps every attached IPv4 /24 for hosts answering on the RAW print
// port (9100). Pure node, no Electron — testable with a fake listener.
const os = require('os');
const net = require('net');

// The /24 bases of every non-internal IPv4 interface on this machine.
function localBases() {
  const bases = new Set();
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const ni of ifaces || []) {
      if (ni.family === 'IPv4' && !ni.internal) bases.add(ni.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...bases];
}

function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(ok ? host : null); };
    // 900 ms not 500 — cold ARP on a fresh subnet ate most of a 500 ms budget (restaurant lesson).
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    s.connect(port, host);
  });
}

// scanPrinters({ port, hosts, bases, passes, timeoutMs, chunk })
//   hosts  — explicit host list (tests / odd subnets); otherwise every x.y.z.1-254 of `bases`
//   bases  — /24 bases; default = this machine's interfaces
// Two passes by default: budget POS80 boards drop a probe while busy, so a
// single sweep can miss a live printer. Chunked so 254 SYNs don't storm ARP.
async function scanPrinters({ port = 9100, hosts, bases, passes = 2, timeoutMs = 900, chunk = 128 } = {}) {
  const b = bases || localBases();
  const all = hosts || b.flatMap((base) => Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`));
  if (!all.length) return { subnet: '', printers: [], message: 'No LAN connection found on this device.' };
  const found = new Set();
  for (let pass = 0; pass < passes; pass++) {
    if (pass) await new Promise((r) => setTimeout(r, 600));
    const remaining = all.filter((h) => !found.has(h));
    for (let i = 0; i < remaining.length; i += chunk) {
      (await Promise.all(remaining.slice(i, i + chunk).map((h) => probe(h, port, timeoutMs)))).filter(Boolean).forEach((ip) => found.add(ip));
    }
  }
  const sortIp = (a, z) => a.split('.').map(Number).reduce((acc, n, i) => acc || n - Number(z.split('.')[i]), 0);
  return { subnet: b.map((x) => `${x}.0/24`).join(', '), printers: [...found].sort(sortIp).map((ip) => ({ ip, port })) };
}

module.exports = { scanPrinters, localBases };
