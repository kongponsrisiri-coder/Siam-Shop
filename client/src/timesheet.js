// Timesheet maths (SIAMSHOP-CLOCK-001) — pure functions shared by the Admin
// Timesheets screen and scripts/test-clock.mjs, so hours are testable in Node.
//
// Events: [{ staff_id, staff_name, staff_role, event_type: 'in'|'out', event_at }]
// sorted by staff then time (the API returns them that way).

// Pair each 'in' with the next 'out'. A dangling 'in' is an OPEN shift (still
// clocked in, or a forgotten clock-out) — reported with out: null, never as 24 h.
// A stray 'out' with no 'in' is ignored (already closed).
export function pairShifts(events) {
  const byStaff = new Map();
  for (const ev of events || []) {
    if (!byStaff.has(ev.staff_id)) byStaff.set(ev.staff_id, { id: ev.staff_id, name: ev.staff_name, role: ev.staff_role, shifts: [], openIn: null });
    const b = byStaff.get(ev.staff_id);
    if (ev.event_type === 'in') {
      if (b.openIn) b.shifts.push({ in: b.openIn, out: null }); // double 'in' → previous left open
      b.openIn = ev.event_at;
    } else if (ev.event_type === 'out' && b.openIn) {
      b.shifts.push({ in: b.openIn, out: ev.event_at });
      b.openIn = null;
    }
  }
  for (const b of byStaff.values()) {
    if (b.openIn) { b.shifts.push({ in: b.openIn, out: null }); b.openIn = null; }
  }
  return [...byStaff.values()];
}

// Hours of a closed shift (0 for open). Crossing midnight is just a longer diff.
export function shiftHours(s) {
  if (!s.out) return 0;
  return Math.max(0, (new Date(s.out) - new Date(s.in)) / 3600000);
}

export function fmtHours(h) {
  const hours = Math.floor(h);
  const mins = Math.round((h - hours) * 60);
  return `${hours}h ${String(mins).padStart(2, '0')}m`;
}

// Per-staff totals for a window: total hours, closed/open shift counts.
export function summarise(events) {
  return pairShifts(events).map((b) => {
    const closed = b.shifts.filter((s) => s.out);
    const open = b.shifts.filter((s) => !s.out);
    return { ...b, totalHours: closed.reduce((a, s) => a + shiftHours(s), 0), closedCount: closed.length, openCount: open.length };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// Monday-start week containing `date` → [from, to] as YYYY-MM-DD (local).
export function weekBounds(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // Mon=0
  const mon = new Date(d); mon.setDate(d.getDate() - day);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return [iso(mon), iso(sun)];
}

// CSV rows for export: one row per shift. Opens in Numbers/Excel (BOM + CRLF).
export function timesheetCsv(events) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [['Staff', 'Role', 'Clock in', 'Clock out', 'Hours', 'Status']];
  for (const b of pairShifts(events)) {
    for (const s of b.shifts) {
      rows.push([b.name, b.role, new Date(s.in).toLocaleString('en-GB'), s.out ? new Date(s.out).toLocaleString('en-GB') : '', s.out ? shiftHours(s).toFixed(2) : '', s.out ? 'closed' : 'OPEN — no clock-out']);
    }
  }
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}
