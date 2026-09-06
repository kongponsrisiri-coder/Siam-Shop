// SiamShop — opening hours, category availability windows and pickup slots
// (SIAMSHOP-503 / 504). Everything is evaluated in the SHOP's timezone
// (Europe/London by default), never the server's or the customer's clock, so
// "lunch 12:00–15:00" means the shop's noon in BST and GMT alike.
//
// Shapes (all stored as JSON strings in shop_settings / categories.availability):
//   opening_hours: { mon: {from:'09:30',to:'18:00'}, …, sun: {from:'10:00',to:'17:00'} }
//                  a missing/null day = closed. Not configured at all = always open.
//   bank_holidays: 'YYYY-MM-DD, YYYY-MM-DD' — those dates use the Sunday hours.
//   category availability: { rules: [{ days:[1,2,3,4,5,6], from:'12:00', to:'15:00' }] }
//                  days use JS getDay() numbering (0 = Sunday). null = always.

const TZ_DEFAULT = 'Europe/London';
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Wall-clock parts of an instant in a timezone: { day 0-6, minutes since
// midnight, ymd 'YYYY-MM-DD' }.
function localParts(date, tz = TZ_DEFAULT) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const day = DAY_LABELS.indexOf(get('weekday'));
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0; // some ICU builds render midnight as 24
  return { day, minutes: hour * 60 + Number(get('minute')), ymd: `${get('year')}-${get('month')}-${get('day')}` };
}

function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= 24 * 60 ? v : null;
}
function fmtMin(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// ---- opening hours -------------------------------------------------------

// Parse the setting. Returns null when nothing usable is configured (= always
// open, so existing shops that never set hours are unaffected).
function parseOpeningHours(raw) {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || typeof o !== 'object') return null;
    const out = {};
    let any = false;
    for (const k of DAY_KEYS) {
      const v = o[k];
      if (v && toMin(v.from) != null && toMin(v.to) != null && toMin(v.from) < toMin(v.to)) {
        out[k] = { from: v.from, to: v.to };
        any = true;
      } else {
        out[k] = null;
      }
    }
    return any ? out : null;
  } catch {
    return null;
  }
}

function parseBankHolidays(raw) {
  return new Set(String(raw || '').split(/[\s,;]+/).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)));
}

// The {from,to} window that applies on a given local date (bank holidays →
// Sunday hours), or null when closed that day.
function windowFor(hours, parts, bankHolidays) {
  if (!hours) return null;
  const key = bankHolidays && bankHolidays.has(parts.ymd) ? 'sun' : DAY_KEYS[parts.day];
  return hours[key] || null;
}

// Is the shop open at this instant? Unconfigured hours = always open.
function isOpenAt(hours, date, tz = TZ_DEFAULT, bankHolidays = new Set()) {
  if (!hours) return true;
  const parts = localParts(date, tz);
  const w = windowFor(hours, parts, bankHolidays);
  return !!w && parts.minutes >= toMin(w.from) && parts.minutes < toMin(w.to);
}

// "today 09:30" / "Mon 09:30" — the next time the shop opens after `date`.
function nextOpening(hours, date, tz = TZ_DEFAULT, bankHolidays = new Set()) {
  if (!hours) return null;
  for (let d = 0; d < 8; d++) {
    const probe = new Date(date.getTime() + d * 24 * 60 * 60 * 1000);
    const parts = localParts(probe, tz);
    const w = windowFor(hours, parts, bankHolidays);
    if (!w) continue;
    if (d === 0 && parts.minutes >= toMin(w.from)) continue; // already past today's opening
    return `${d === 0 ? 'today' : d === 1 ? 'tomorrow' : DAY_LABELS[parts.day]} ${w.from}`;
  }
  return null;
}

// ---- category availability windows -------------------------------------

function parseRules(raw) {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const rules = Array.isArray(o?.rules) ? o.rules : Array.isArray(o) ? o : null;
    if (!rules) return null;
    const clean = rules
      .map((r) => ({
        days: [...new Set((Array.isArray(r.days) ? r.days : []).map(Number).filter((n) => n >= 0 && n <= 6))].sort(),
        from: r.from, to: r.to,
      }))
      .filter((r) => r.days.length && toMin(r.from) != null && toMin(r.to) != null && toMin(r.from) < toMin(r.to));
    return clean.length ? clean : null;
  } catch {
    return null;
  }
}

// Is a category with these rules orderable at `date`? No rules = always.
function availableAt(rules, date, tz = TZ_DEFAULT) {
  if (!rules || !rules.length) return true;
  const parts = localParts(date, tz);
  return rules.some((r) => r.days.includes(parts.day) && parts.minutes >= toMin(r.from) && parts.minutes < toMin(r.to));
}

// "Mon–Sat 12:00–15:00" (one segment per rule; consecutive days compressed).
function describeRules(rules) {
  if (!rules || !rules.length) return '';
  const dayText = (days) => {
    const sorted = [...days].sort((a, b) => a - b);
    // Rotate so Monday-first ranges read naturally (Mon–Sat, not Sun/Mon–Sat).
    const order = [1, 2, 3, 4, 5, 6, 0];
    const seq = order.filter((d) => sorted.includes(d));
    const groups = [];
    for (const d of seq) {
      const g = groups[groups.length - 1];
      if (g && order.indexOf(d) === order.indexOf(g[g.length - 1]) + 1) g.push(d);
      else groups.push([d]);
    }
    return groups
      .map((g) => (g.length >= 3 ? `${DAY_LABELS[g[0]]}–${DAY_LABELS[g[g.length - 1]]}` : g.map((d) => DAY_LABELS[d]).join(', ')))
      .join(', ');
  };
  return rules.map((r) => `${dayText(r.days)} ${r.from}–${r.to}`).join(' · ');
}

// ---- pickup slots (Click & Collect) -------------------------------------

// Slots from now+lead to closing, today and tomorrow, stepped by `stepMin`.
// With no opening hours configured, offers the next 6 hours. Returns
// [{ at: ISO, label: 'Today 12:30' | 'Tomorrow 09:30' }].
function pickupSlots({ hours, now = new Date(), tz = TZ_DEFAULT, bankHolidays = new Set(), leadMin = 20, stepMin = 15 }) {
  const step = Math.max(5, Number(stepMin) || 15);
  const lead = Math.max(0, Number(leadMin) || 0);
  const earliest = now.getTime() + lead * 60 * 1000;
  // Round the first candidate up to the next step boundary (in wall-clock minutes).
  const p0 = localParts(new Date(earliest), tz);
  const roundUp = (Math.ceil(p0.minutes / step) * step - p0.minutes) * 60 * 1000;
  let t = earliest - (new Date(earliest).getSeconds() * 1000) - (new Date(earliest).getMilliseconds()) + roundUp;
  const horizon = hours ? now.getTime() + 36 * 60 * 60 * 1000 : now.getTime() + 6 * 60 * 60 * 1000;
  const today = localParts(now, tz).ymd;
  const tomorrow = localParts(new Date(now.getTime() + 24 * 60 * 60 * 1000), tz).ymd;
  const out = [];
  for (; t <= horizon && out.length < 200; t += step * 60 * 1000) {
    const d = new Date(t);
    const parts = localParts(d, tz);
    if (hours) {
      const w = windowFor(hours, parts, bankHolidays);
      if (!w || parts.minutes < toMin(w.from) || parts.minutes > toMin(w.to)) continue;
    }
    const dayLabel = parts.ymd === today ? 'Today' : parts.ymd === tomorrow ? 'Tomorrow' : DAY_LABELS[parts.day];
    out.push({ at: d.toISOString(), label: `${dayLabel} ${fmtMin(parts.minutes)}` });
  }
  return out;
}

// Validate a requested pickup instant: not in the past (minus lead), inside
// opening hours when configured, within 2 days. Returns an error string or null.
function validatePickup(at, { hours, now = new Date(), tz = TZ_DEFAULT, bankHolidays = new Set(), leadMin = 20 }) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return 'Choose a pickup time';
  const lead = Math.max(0, Number(leadMin) || 0);
  // 2-minute grace so a slot picked just before the minute ticks over still passes.
  if (d.getTime() < now.getTime() + lead * 60 * 1000 - 2 * 60 * 1000) return `Pickup time must be at least ${lead} minutes from now`;
  if (d.getTime() > now.getTime() + 2 * 24 * 60 * 60 * 1000) return 'Pickup time is too far ahead';
  if (hours) {
    const parts = localParts(d, tz);
    const w = windowFor(hours, parts, bankHolidays);
    if (!w || parts.minutes < toMin(w.from) || parts.minutes > toMin(w.to)) return 'The shop is closed at that time — pick another slot';
  }
  return null;
}

// "Fri 12:30" label for a stored pickup_at.
function labelFor(date, tz = TZ_DEFAULT) {
  const parts = localParts(new Date(date), tz);
  return `${DAY_LABELS[parts.day]} ${fmtMin(parts.minutes)}`;
}

module.exports = {
  TZ_DEFAULT, DAY_KEYS, DAY_LABELS, localParts, toMin, fmtMin,
  parseOpeningHours, parseBankHolidays, isOpenAt, nextOpening,
  parseRules, availableAt, describeRules,
  pickupSlots, validatePickup, labelFor,
};
