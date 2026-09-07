/**
 * SiamShop Print Service (SIAMSHOP-ELECTRON-001) — ported from
 * restaurant-epos/src/services/printService.js (SEPOS-025 lineage).
 *
 * Runs in the Electron MAIN process (Path A has no local server). Sends raw
 * ESC/POS bytes to an 80 mm thermal receipt printer over the same transport
 * chain the restaurant till has proven in the field:
 *   RAW 9100 → LPR 515 → IP-matched CUPS queue    (printer has an IP)
 *   CUPS `lpr -o raw` (Mac/Linux) or spooler RAW via PowerShell (Windows)
 *                                                  (printer by NAME, e.g. USB)
 * Transport results are cached per printer so LPR-only print servers don't
 * pay the RAW timeout on every receipt. Cash-drawer kick = ESC p pulse over
 * the same socket (drawer on the receipt printer's RJ11 port).
 *
 * Kitchen tickets / Thai rendering / logo raster from the restaurant version
 * are intentionally NOT ported — SiamShop's counter uses the /prep screen and
 * the grocery receipt is Latin-only (Thai product names fall back to English).
 *
 * printer config: { ip, port (9100), name, lprQueue ('lp'), lprPort (515) }
 */

'use strict';

const net = require('net');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { exec, execFile } = require('child_process');

// ── ESC/POS command bytes ─────────────────────────────────────────────────────
const ESC = 0x1b;
const GS = 0x1d;
const CMD = {
  // Reset, CP858 (£ at 0x9C), cancel user chars / print modes / double-strike, Font A.
  INIT: Buffer.from([ESC, 0x40, ESC, 0x74, 0x13, ESC, 0x25, 0x00, ESC, 0x21, 0x00, ESC, 0x4d, 0x00, ESC, 0x47, 0x00]),
  ALIGN_LEFT: Buffer.from([ESC, 0x61, 0x00]),
  ALIGN_CENTER: Buffer.from([ESC, 0x61, 0x01]),
  ALIGN_RIGHT: Buffer.from([ESC, 0x61, 0x02]),
  BOLD_ON: Buffer.from([ESC, 0x45, 0x01]),
  BOLD_OFF: Buffer.from([ESC, 0x45, 0x00]),
  SIZE_NORMAL: Buffer.from([GS, 0x21, 0x00]),
  SIZE_TALL: Buffer.from([GS, 0x21, 0x01]),
  SIZE_BIG: Buffer.from([GS, 0x21, 0x11]),
  CUT: Buffer.from([GS, 0x56, 0x41, 0x05]),
  DRAWER_KICK: Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]),
  LF: Buffer.from([0x0a]),
};
const LINE_WIDTH = 42; // chars at normal size on 80 mm paper

// £/€/dashes/quotes remapped for CP858; anything non-Latin-1 stripped.
const stripUnsupported = (s) => String(s ?? '')
  .replace(/£/g, '\x9C').replace(/€/g, '\xD5').replace(/[—–]/g, '-')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x00-\xFF]/g, '');
const txt = (s) => Buffer.from(stripUnsupported(s), 'latin1');
const lf = (n = 1) => Buffer.alloc(n, 0x0a);
const rule = (c = '-') => txt(c.repeat(LINE_WIDTH));
function pad(str, len, align = 'left') {
  const s = String(str ?? '').slice(0, len);
  const spaces = ' '.repeat(Math.max(0, len - s.length));
  return align === 'right' ? spaces + s : s + spaces;
}
function col2(label, value, width = LINE_WIDTH) {
  const v = String(value ?? '');
  const maxL = width - v.length - 1;
  return txt(pad(String(label ?? '').slice(0, maxL), maxL) + ' ' + v);
}
function flatten(parts) {
  return Buffer.concat(parts.flat(Infinity).filter((b) => Buffer.isBuffer(b)));
}
const money = (n) => '£' + Number(n || 0).toFixed(2);

// Wrap a long product name onto continuation lines under a fixed left margin.
function wrap(s, width) {
  const words = String(s || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) { if (cur) lines.push(cur); cur = w.slice(0, width); }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

// ── Receipt (grocery + counter) ───────────────────────────────────────────────
// receipt = { shopName, header (multi-line, e.g. address/phone), orderId, staff, createdAt, fulfilment,
//             items: [{ name, qty, unit_price, line_total, options: [names] }],
//             subtotal, total, payment_method, amount_tendered, change_given,
//             footer, vatNote }
function buildReceipt(r) {
  const when = r.createdAt ? new Date(r.createdAt) : new Date();
  const dateStr = when.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const QTY_W = 4, PRICE_W = 9;
  const NAME_W = LINE_WIDTH - QTY_W - PRICE_W - 2;
  const lines = [];
  for (const it of r.items || []) {
    const name = wrap(it.name, NAME_W);
    // With a line discount, show the gross on the item line and the discount beneath it.
    const shown = it.discount && Number(it.discount.amount) > 0 && it.gross != null ? it.gross : it.line_total;
    lines.push(txt(pad(`${it.qty}x`, QTY_W) + ' ' + pad(name[0], NAME_W) + ' ' + pad(money(shown), PRICE_W, 'right')), lf());
    for (const extra of name.slice(1)) lines.push(txt(' '.repeat(QTY_W + 1) + extra), lf());
    const opts = (it.options || []).map((o) => (typeof o === 'string' ? o : o.name)).filter(Boolean);
    if (opts.length) wrap(opts.join(', '), NAME_W - 2).forEach((ol, i) => lines.push(txt(' '.repeat(QTY_W + 1) + (i === 0 ? '- ' : '  ') + ol), lf()));
    if (it.qty > 1) lines.push(txt(' '.repeat(QTY_W + 1) + `@ ${money(it.unit_price)} each`), lf());
    if (it.discount && Number(it.discount.amount) > 0) {
      const label = `Discount - ${it.discount.reason || ''}`.slice(0, NAME_W);
      lines.push(txt(' '.repeat(QTY_W + 1) + pad(label, NAME_W) + ' ' + pad('-' + money(it.discount.amount), PRICE_W, 'right')), lf());
    }
  }
  const basketDisc = r.discount && Number(r.discount.amount) > 0 ? r.discount : null;
  const anyDiscount = basketDisc || Number(r.discount_amount) > 0;
  const FULFIL = { dine_in: 'EAT IN', takeaway: 'TAKE AWAY', collection: 'COLLECTION', delivery: 'DELIVERY' };
  const pay = String(r.payment_method || '').toUpperCase();
  return flatten([
    CMD.INIT,
    CMD.ALIGN_CENTER,
    CMD.BOLD_ON, CMD.SIZE_BIG, txt(String(r.shopName || 'SiamShop').slice(0, 20)), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    (r.header || r.address) ? String(r.header || r.address).split(/\r?\n/).flatMap((line) => wrap(line, LINE_WIDTH).map((l) => [txt(l), lf()])) : [],
    lf(),
    CMD.ALIGN_LEFT,
    col2(`Receipt #${r.orderId}`, dateStr), lf(),
    r.staff ? [col2('Served by', String(r.staff).slice(0, 20)), lf()] : [],
    r.fulfilment && FULFIL[r.fulfilment] ? [CMD.BOLD_ON, txt(FULFIL[r.fulfilment]), CMD.BOLD_OFF, lf()] : [],
    rule(), lf(),
    lines,
    rule(), lf(),
    r.delivery_fee > 0 ? [col2('Subtotal', money(r.subtotal)), lf(), col2('Delivery', money(r.delivery_fee)), lf()] : [],
    basketDisc ? [col2('Subtotal', money(r.subtotal)), lf(), col2(`Discount - ${basketDisc.reason || ''}`.slice(0, 30), '-' + money(basketDisc.amount)), lf()] : [],
    CMD.BOLD_ON, CMD.SIZE_TALL, col2('TOTAL', money(r.total)), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    anyDiscount ? [txt(`You saved ${money(r.discount_amount || basketDisc.amount)}`), lf()] : [],
    col2(`Paid by ${pay || 'CASH'}`, r.amount_tendered != null ? money(r.amount_tendered) : ''), lf(),
    r.change_given != null ? [col2('Change', money(r.change_given)), lf()] : [],
    rule(), lf(),
    CMD.ALIGN_CENTER,
    txt(String(r.footer || 'Thank you for shopping with us!').slice(0, LINE_WIDTH)), lf(),
    r.vatNote ? [txt(String(r.vatNote).slice(0, LINE_WIDTH)), lf()] : [],
    lf(3),
    CMD.CUT,
  ]);
}

// ── Z report / cash-up (SIAMSHOP-TILL-001) ────────────────────────────────────
// z = the session summary from GET /api/till/sessions/:id (+ shopName).
function buildZReport(z, shopName = 'SiamShop') {
  const fmt = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const sign = (n) => (Number(n) > 0 ? '+' : Number(n) < 0 ? '-' : '') + money(Math.abs(Number(n || 0)));
  return flatten([
    CMD.INIT, CMD.ALIGN_CENTER,
    CMD.BOLD_ON, CMD.SIZE_BIG, txt('Z REPORT'), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    txt(String(shopName).slice(0, LINE_WIDTH)), lf(),
    txt(`Session #${z.session_id}${z.closed_at ? '' : ' (OPEN — provisional)'}`), lf(),
    CMD.ALIGN_LEFT, rule(), lf(),
    col2('Opened', fmt(z.opened_at)), lf(),
    col2('By', String(z.opened_by || '').slice(0, 20)), lf(),
    col2('Closed', fmt(z.closed_at)), lf(),
    z.closed_by ? [col2('By', String(z.closed_by).slice(0, 20)), lf()] : [],
    rule(), lf(),
    CMD.BOLD_ON, txt('SALES (till)'), CMD.BOLD_OFF, lf(),
    col2(`Cash sales`, money(z.sales?.cash)), lf(),
    col2(`Card sales`, money(z.sales?.card)), lf(),
    col2(`Sales (${z.sales?.count || 0} / ${z.sales?.items || 0} items)`, money(z.sales?.gross)), lf(),
    col2(`Refunds (${z.refunds?.count || 0})`, '-' + money(z.refunds?.total)), lf(),
    Number(z.discounts?.total) ? [col2(`Discounts (${z.discounts.count})`, '-' + money(z.discounts.total)), lf()] : [],
    CMD.BOLD_ON, col2('NET TAKINGS', money(z.net)), CMD.BOLD_OFF, lf(),
    rule(), lf(),
    CMD.BOLD_ON, txt('CASH DRAWER'), CMD.BOLD_OFF, lf(),
    col2('Opening float', money(z.float_amount)), lf(),
    col2('+ Cash sales', money(z.sales?.cash)), lf(),
    col2('- Cash refunds', money(z.refunds?.cash)), lf(),
    CMD.BOLD_ON, col2('EXPECTED', money(z.expected_cash)), CMD.BOLD_OFF, lf(),
    z.counted_cash != null ? [
      col2('Counted', money(z.counted_cash)), lf(),
      CMD.BOLD_ON, CMD.SIZE_TALL, col2('VARIANCE', sign(z.variance)), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    ] : [],
    rule(), lf(),
    z.online?.count ? [txt(`Online orders paid in shift: ${z.online.count} (${money(z.online.gross)}) - not in drawer`), lf()] : [],
    z.notes ? wrap('Notes: ' + z.notes, LINE_WIDTH).map((l) => [txt(l), lf()]) : [],
    lf(), CMD.ALIGN_CENTER, txt(`Printed ${fmt(new Date())}`), lf(3), CMD.CUT,
  ]);
}

function buildTestPage(info = {}) {
  const now = new Date().toLocaleString('en-GB');
  const target = info.ip ? `${info.ip}:${info.port || 9100}` : '';
  return flatten([
    CMD.INIT, CMD.ALIGN_CENTER,
    CMD.BOLD_ON, CMD.SIZE_BIG, txt('SiamShop'), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    rule(), lf(),
    CMD.BOLD_ON, txt('Printer test OK'), CMD.BOLD_OFF, lf(),
    info.name ? [CMD.SIZE_BIG, txt(String(info.name).slice(0, 24)), CMD.SIZE_NORMAL, lf()] : [],
    target ? [CMD.SIZE_BIG, txt(target), CMD.SIZE_NORMAL, lf()] : [],
    txt('Pounds: ' + money(12.34)), lf(),
    txt(now), lf(),
    rule(), lf(2),
    CMD.CUT,
  ]);
}

// ── Transports (unchanged from the restaurant service) ────────────────────────
let _printQueue = Promise.resolve();

function _sendTcp(ip, port, buf, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      setTimeout(() => (err ? reject(err) : resolve()), 1500);
    };
    sock.setTimeout(timeoutMs);
    sock.connect(parseInt(port, 10) || 9100, ip, () => {
      sock.write(buf, (err) => { if (err) return done(err); });
      sock.once('drain', () => setTimeout(() => done(null), 600));
      setTimeout(() => done(null), 800);
    });
    sock.on('error', (e) => done(e));
    sock.on('timeout', () => done(new Error(`Printer at ${ip} timed out`)));
  });
}

// LPR/LPD (RFC 1179) for older USB print servers that only expose port 515.
function _sendLpr(ip, port, buf, queueName = 'lp', timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let stage = 0;
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      setTimeout(() => (err ? reject(err) : resolve()), 1500);
    };
    const host = 'siamshop', user = 'siamshop', job = 'SiamShop print';
    const stamp = String(Date.now()).slice(-3);
    const dfn = `dfA${stamp}${host}`, cfn = `cfA${stamp}${host}`;
    const ctrl = `H${host}\nP${user}\nJ${job}\nl${dfn}\nU${dfn}\nN${dfn}\n`;
    sock.setTimeout(timeoutMs);
    sock.on('error', (e) => done(e));
    sock.on('timeout', () => done(new Error(`LPR timeout to ${ip}:${port}`)));
    sock.connect(parseInt(port, 10) || 515, ip, () => {
      sock.write(Buffer.concat([Buffer.from([0x02]), Buffer.from(`${queueName}\n`)]));
    });
    sock.on('data', (chunk) => {
      for (const byte of chunk) {
        if (byte !== 0x00) return done(new Error(`LPR rejected at stage ${stage} (byte 0x${byte.toString(16).padStart(2, '0')}) — queue '${queueName}' may be wrong`));
        stage += 1;
        if (stage === 1) sock.write(Buffer.concat([Buffer.from([0x02]), Buffer.from(`${ctrl.length} ${cfn}\n`)]));
        else if (stage === 2) sock.write(Buffer.concat([Buffer.from(ctrl), Buffer.from([0x00])]));
        else if (stage === 3) sock.write(Buffer.concat([Buffer.from([0x03]), Buffer.from(`${buf.length} ${dfn}\n`)]));
        else if (stage === 4) sock.write(Buffer.concat([buf, Buffer.from([0x00])]));
        else if (stage === 5) done(null);
      }
    });
  });
}

async function findCupsQueueForIp(ip) {
  if (!ip) return null;
  return new Promise((resolve) => {
    exec('lpstat -v', { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      for (const line of String(stdout).split('\n')) {
        const m = line.match(/device for (\S+):\s+\S+:\/\/([0-9.]+)/);
        if (m && m[2] === ip) return resolve(m[1]);
      }
      resolve(null);
    });
  });
}
const _cupsQueueCache = new Map();
async function getOrAutoDetectCupsQueue(ip, explicitName) {
  if (explicitName) return explicitName;
  if (_cupsQueueCache.has(ip)) return _cupsQueueCache.get(ip);
  const detected = await findCupsQueueForIp(ip);
  _cupsQueueCache.set(ip, detected);
  return detected;
}

async function _sendCups(printerName, buf) {
  const tmp = path.join(os.tmpdir(), `siamshop-print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);
  await fs.writeFile(tmp, buf);
  try {
    await new Promise((resolve, reject) => {
      // execFile (not exec): printer name is a literal argv entry, never a shell string.
      execFile('lpr', ['-P', String(printerName), '-o', 'raw', tmp], (err, _o, stderr) => {
        if (err) return reject(new Error(`CUPS print failed: ${(stderr || '').trim() || err.message}`));
        resolve();
      });
    });
  } finally {
    fs.unlink(tmp).catch(() => {});
  }
}

// Windows: spooler RAW datatype via a persistent PowerShell helper (no native module).
const _WIN_RAW_CSHARP = [
  'using System;', 'using System.IO;', 'using System.Runtime.InteropServices;',
  'public class SiamShopRawPrinter {',
  '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }',
  '  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);',
  '  [DllImport("winspool.drv", SetLastError=true)] static extern bool ClosePrinter(IntPtr h);',
  '  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool StartDocPrinter(IntPtr h, int level, ref DOCINFO di);',
  '  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndDocPrinter(IntPtr h);',
  '  [DllImport("winspool.drv", SetLastError=true)] static extern bool StartPagePrinter(IntPtr h);',
  '  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndPagePrinter(IntPtr h);',
  '  [DllImport("winspool.drv", SetLastError=true)] static extern bool WritePrinter(IntPtr h, byte[] data, int n, out int written);',
  '  public static void Send(string printer, string file) {',
  '    IntPtr h; if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter failed (" + Marshal.GetLastWin32Error() + ") for printer: " + printer);',
  '    try {',
  '      DOCINFO di = new DOCINFO(); di.pDocName = "SiamShop"; di.pDataType = "RAW";',
  '      if (!StartDocPrinter(h, 1, ref di)) throw new Exception("StartDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");',
  '      StartPagePrinter(h);',
  '      byte[] b = File.ReadAllBytes(file); int w;',
  '      if (!WritePrinter(h, b, b.Length, out w)) throw new Exception("WritePrinter failed (" + Marshal.GetLastWin32Error() + ")");',
  '      EndPagePrinter(h); EndDocPrinter(h);',
  '    } finally { ClosePrinter(h); }',
  '  }',
  '}',
].join('\n');
let _winPrintProc = null;
let _winJobSeq = 0;
function _getWinPrintProc() {
  if (_winPrintProc && _winPrintProc.exitCode === null && !_winPrintProc.killed && _winPrintProc.stdin && _winPrintProc.stdin.writable) return _winPrintProc;
  if (_winPrintProc) { try { _winPrintProc.kill(); } catch (e) {} _winPrintProc = null; }
  const { spawn } = require('child_process');
  const readline = require('readline');
  const reader = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${_WIN_RAW_CSHARP}
'@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $p = $line.Split(' ')
  $id = $p[0]
  try {
    $name = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))
    $path = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2]))
    [SiamShopRawPrinter]::Send($name, $path)
    [Console]::Out.WriteLine($id + ' OK')
  } catch {
    [Console]::Out.WriteLine($id + ' ERR ' + ($_.Exception.Message -replace '[\\r\\n]',' '))
  }
  [Console]::Out.Flush()
}`;
  const encoded = Buffer.from(reader, 'utf16le').toString('base64');
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { stdio: ['pipe', 'pipe', 'pipe'] });
  proc._jobs = new Map();
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    const sp = line.indexOf(' ');
    const id = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? '' : line.slice(sp + 1);
    const job = proc._jobs.get(id);
    if (!job) return;
    proc._jobs.delete(id);
    if (rest.startsWith('OK')) job.resolve();
    else job.reject(new Error(`Windows raw print failed: ${rest.replace(/^ERR /, '')}`));
  });
  proc.stderr.on('data', (d) => console.warn('[winprint]', String(d).trim()));
  const die = (err) => { for (const job of proc._jobs.values()) job.reject(err); proc._jobs.clear(); if (_winPrintProc === proc) _winPrintProc = null; };
  proc.on('exit', (code) => die(new Error(`print helper exited (${code})`)));
  proc.on('error', (e) => die(e));
  _winPrintProc = proc;
  return proc;
}
function _sendWindowsRaw(printerName, buf) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `siamshop-print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);
    fs.writeFile(tmp, buf).then(() => {
      let proc;
      try { proc = _getWinPrintProc(); } catch (e) { fs.unlink(tmp).catch(() => {}); return reject(e); }
      const id = String(++_winJobSeq);
      let settled = false;
      const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); proc._jobs.delete(id); fs.unlink(tmp).catch(() => {}); fn(arg); };
      const timer = setTimeout(() => { proc._jobs.delete(id); try { proc.kill(); } catch (e) {} finish(reject, new Error('Windows raw print timed out')); }, 15000);
      proc._jobs.set(id, { resolve: () => finish(resolve), reject: (e) => finish(reject, e) });
      const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
      try { proc.stdin.write(`${id} ${b64(printerName)} ${b64(tmp)}\n`); } catch (e) { finish(reject, e); }
    }).catch(reject);
  });
}
function _sendToNamedPrinter(printerName, buf) {
  if (process.platform === 'win32') return _sendWindowsRaw(printerName, buf);
  return _sendCups(printerName, buf);
}

const _transportCache = new Map(); // `${ip}:${port}` → 'lpr'
function sendRaw(ip, port, buf, options = {}) {
  const explicitName = (options.printerName || '').trim();
  const lprQueue = (options.lprQueue || 'lp').trim();
  const lprPort = parseInt(options.lprPort, 10) || 515;
  const hasTcp = !!ip;
  if (!hasTcp && !explicitName) return Promise.reject(new Error('No printer configured — set an IP or a printer name in Admin → This device.'));
  const job = async () => {
    if (hasTcp) {
      const cacheKey = `${ip}:${port}`;
      if (_transportCache.get(cacheKey) === 'lpr') {
        try { return await _sendLpr(ip, lprPort, buf, lprQueue); }
        catch (cachedErr) { _transportCache.delete(cacheKey); console.warn(`[print] cached LPR route to ${ip} failed (${cachedErr.message}) — re-probing`); }
      }
      try { return await _sendTcp(ip, port, buf); }
      catch (rawErr) {
        try {
          console.warn(`[print] RAW ${ip}:${port} failed (${rawErr.message}) — trying LPR ${lprPort} ('${lprQueue}')`);
          const res = await _sendLpr(ip, lprPort, buf, lprQueue);
          _transportCache.set(cacheKey, 'lpr');
          return res;
        } catch (lprErr) {
          // CUPS only via an IP-matched queue — never hand a free-text label to lpr.
          const queueName = await getOrAutoDetectCupsQueue(ip, null);
          if (queueName) {
            console.warn(`[print] LPR also failed (${lprErr.message}) — IP-matched CUPS '${queueName}'`);
            return _sendCups(queueName, buf);
          }
          throw new Error(`All print methods failed for ${ip}. RAW: ${rawErr.message}. LPR: ${lprErr.message}.`);
        }
      }
    }
    return _sendToNamedPrinter(explicitName, buf);
  };
  _printQueue = _printQueue.catch(() => {}).then(job);
  return _printQueue;
}

// ── Public API ────────────────────────────────────────────────────────────────
function dest(printer = {}) {
  return {
    ip: String(printer.ip || '').trim(),
    port: parseInt(printer.port, 10) || 9100,
    printerName: String(printer.name || '').trim(),
    lprQueue: String(printer.lprQueue || 'lp').trim(),
    lprPort: parseInt(printer.lprPort, 10) || 515,
  };
}
async function printReceipt(printer, receipt) {
  const d = dest(printer);
  await sendRaw(d.ip, d.port, buildReceipt(receipt), { printerName: d.printerName, lprQueue: d.lprQueue, lprPort: d.lprPort });
}
async function openCashDrawer(printer) {
  const d = dest(printer);
  await sendRaw(d.ip, d.port, CMD.DRAWER_KICK, { printerName: d.printerName, lprQueue: d.lprQueue, lprPort: d.lprPort });
}
async function printZReport(printer, z, shopName) {
  const d = dest(printer);
  await sendRaw(d.ip, d.port, buildZReport(z, shopName), { printerName: d.printerName, lprQueue: d.lprQueue, lprPort: d.lprPort });
}
async function testPrint(printer) {
  const d = dest(printer);
  await sendRaw(d.ip, d.port, buildTestPage({ ip: d.ip, port: d.port, name: d.printerName }), { printerName: d.printerName, lprQueue: d.lprQueue, lprPort: d.lprPort });
}

module.exports = { printReceipt, openCashDrawer, testPrint, printZReport, buildReceipt, buildZReport, buildTestPage, findCupsQueueForIp, LINE_WIDTH, CMD };
