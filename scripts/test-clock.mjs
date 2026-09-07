// SIAMSHOP-CLOCK-001 — clock in/out toggle + timesheet maths.
//   BASE=http://localhost:4999 DATABASE_URL=postgres://… node scripts/test-clock.mjs
// DATABASE_URL lets the test back-date events (midnight crossing) — skipped without it.
import { pairShifts, summarise, shiftHours, fmtHours, weekBounds, timesheetCsv } from '../client/src/timesheet.js';

const BASE = process.env.BASE || 'http://localhost:4999';
const PASS = process.env.ADMIN_PASSWORD || 'test-pass-123';
let pass = 0, fail = 0;
async function req(method, p, body, token) {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra != null ? JSON.stringify(extra).slice(0, 300) : ''); }
}
for (let i = 0; i < 40; i++) { try { const h = await fetch(BASE + '/api/health').then((r) => r.json()); if (h.db === 'ok') break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

console.log('— timesheet maths (pure)');
const T = (s) => new Date(s).toISOString();
const ev = [
  { staff_id: 1, staff_name: 'Ann', staff_role: 'cashier', event_type: 'in', event_at: T('2026-09-01T09:00:00Z') },
  { staff_id: 1, staff_name: 'Ann', staff_role: 'cashier', event_type: 'out', event_at: T('2026-09-01T17:30:00Z') },
  { staff_id: 1, staff_name: 'Ann', staff_role: 'cashier', event_type: 'in', event_at: T('2026-09-02T22:00:00Z') },
  { staff_id: 1, staff_name: 'Ann', staff_role: 'cashier', event_type: 'out', event_at: T('2026-09-03T02:15:00Z') }, // crosses midnight
  { staff_id: 2, staff_name: 'Bob', staff_role: 'manager', event_type: 'in', event_at: T('2026-09-01T08:00:00Z') },  // forgotten clock-out
  { staff_id: 2, staff_name: 'Bob', staff_role: 'manager', event_type: 'in', event_at: T('2026-09-02T08:00:00Z') },
  { staff_id: 2, staff_name: 'Bob', staff_role: 'manager', event_type: 'out', event_at: T('2026-09-02T12:00:00Z') },
];
const sum = summarise(ev);
const ann = sum.find((s) => s.name === 'Ann'), bob = sum.find((s) => s.name === 'Bob');
check('Ann: 8.5h + 4.25h across midnight = 12h 45m', Math.abs(ann.totalHours - 12.75) < 1e-9 && fmtHours(ann.totalHours) === '12h 45m', ann);
check('Bob: forgotten clock-out = 1 OPEN shift (0 h), plus 4h closed', bob.openCount === 1 && bob.closedCount === 1 && Math.abs(bob.totalHours - 4) < 1e-9, bob);
check('open shift is never counted as 24 h', shiftHours({ in: T('2026-09-01T08:00:00Z'), out: null }) === 0);
check('stray out without in is ignored', pairShifts([{ staff_id: 3, staff_name: 'C', event_type: 'out', event_at: T('2026-09-01T10:00:00Z') }])[0].shifts.length === 0);
const csv = timesheetCsv(ev);
check('CSV: BOM + header + one row per shift (4) + OPEN flagged', csv.startsWith('﻿Staff,Role,Clock in') && csv.split('\r\n').length === 5 && /OPEN — no clock-out/.test(csv));
const [wf, wt] = weekBounds(new Date('2026-09-09T12:00:00')); // a Wednesday
check('weekBounds → Monday..Sunday', wf === '2026-09-07' && wt === '2026-09-13', [wf, wt]);

console.log('— API toggle');
const owner = (await req('POST', '/api/admin/login', { password: PASS })).data.token;
for (const s of (await req('GET', '/api/admin/staff', null, owner)).data || []) if (/^Clock /.test(s.name)) await req('DELETE', `/api/admin/staff/${s.id}`, null, owner);
const a = (await req('POST', '/api/admin/staff', { name: 'Clock Ann', pin: '3131', role: 'cashier' }, owner)).data;
const b = (await req('POST', '/api/admin/staff', { name: 'Clock Bob', pin: '3232', role: 'manager' }, owner)).data;
check('staff created', a?.id && b?.id);
let r = await req('POST', '/api/clock/toggle', { pin: '0000' });
check('unknown PIN → 401', r.status === 401);
r = await req('POST', '/api/clock/toggle', { pin: '3131' });
check('first toggle = IN', r.status === 200 && r.data.event_type === 'in' && r.data.name === 'Clock Ann', r.data);
r = await req('POST', '/api/clock/toggle', { pin: '3232' });
check('Bob IN', r.data.event_type === 'in');
const mgr = (await req('POST', '/api/staff/login', { pin: '3232' })).data.token;
const cashTok = (await req('POST', '/api/staff/login', { pin: '3131' })).data.token;
r = await req('GET', '/api/clock/status', null, mgr);
check('status lists both as clocked in', r.status === 200 && r.data.some((x) => x.name === 'Clock Ann') && r.data.some((x) => x.name === 'Clock Bob'), r.data);
r = await req('GET', '/api/clock/status', null, cashTok);
check('cashier cannot read status → 403', r.status === 403);
r = await req('POST', '/api/clock/toggle', { pin: '3131' });
check('second toggle = OUT', r.data.event_type === 'out');
r = await req('POST', '/api/clock/toggle', { pin: '3131' });
check('third toggle = IN again', r.data.event_type === 'in');
r = await req('GET', '/api/clock/status', null, mgr);
check('Ann back in the clocked-in list', r.data.some((x) => x.name === 'Clock Ann'));
const today = new Date().toISOString().slice(0, 10);
r = await req('GET', `/api/clock/records?from=${today}&to=${today}`, null, mgr);
const annEv = (r.data || []).filter((e) => e.staff_id === a.id);
check('records: Ann has 3 events today (in/out/in)', annEv.length === 3 && annEv.map((e) => e.event_type).join('') === 'inoutin', annEv.map((e) => e.event_type));
const live = summarise(r.data || []).find((s) => s.name === 'Clock Ann');
check('pairing on live data: 1 closed + 1 open shift', live && live.closedCount === 1 && live.openCount === 1, live);

if (process.env.DATABASE_URL) {
  console.log('— midnight crossing via back-dated events');
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /sslmode=disable|localhost/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } });
  const shop = (await pool.query(`SELECT shop_id FROM staff WHERE id = $1`, [b.id])).rows[0].shop_id;
  await pool.query(`DELETE FROM clock_events WHERE staff_id = $1`, [b.id]);
  await pool.query(`INSERT INTO clock_events (shop_id, staff_id, event_type, event_at) VALUES ($1,$2,'in', NOW() - interval '1 day 2 hours'), ($1,$2,'out', NOW() - interval '22 hours')`, [shop, b.id]);
  await pool.end();
  const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  r = await req('GET', `/api/clock/records?from=${y}&to=${today}`, null, mgr);
  const bobSum = summarise(r.data || []).find((s) => s.name === 'Clock Bob');
  check('Bob: 4h shift spanning yesterday→today counted once, 4h 00m', bobSum && bobSum.closedCount === 1 && fmtHours(bobSum.totalHours) === '4h 00m', bobSum);
  r = await req('GET', `/api/clock/status`, null, mgr);
  check('Bob no longer clocked in', !r.data.some((x) => x.name === 'Clock Bob'));
} else console.log('  ⏭  midnight test skipped (set DATABASE_URL)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
