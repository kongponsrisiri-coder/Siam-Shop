// Demo / presentation mode — masks real customer PII (names + emails) with
// realistic fake data so the admin can take clean marketing screenshots without
// exposing anyone's details. Toggled via the URL (?demo=1 on, ?demo=0 off) and
// remembered in localStorage. Purely a display layer — no data is changed.

const KEY = 'siamshop_demo';

// Apply any ?demo= flag in the URL once, then persist the choice.
(function syncFromUrl() {
  try {
    const v = new URLSearchParams(window.location.search).get('demo');
    if (v === '1' || v === 'true') localStorage.setItem(KEY, '1');
    else if (v === '0' || v === 'false') localStorage.removeItem(KEY);
  } catch {
    /* SSR / no window — ignore */
  }
})();

export function isDemo() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setDemo(on) {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

// A pool of plausible Thai-UK customer names for screenshots.
const NAMES = [
  'Ploy Saetang', 'Nattapong Wong', 'Mali Chaiyaphum', 'Somchai Bunmee',
  'Praew Intira', 'Anan Thongdee', 'Kwan Pimchan', 'Decha Srisai',
  'Nong Aroon', 'Wipa Boonmee', 'Kittisak Phon', 'Suda Manee',
  'Arthit Charoen', 'Lalita Sun', 'Tassanee Keo', 'Chai Rattana',
];

// Deterministic hash so the same seed always maps to the same fake identity
// (consistent across re-renders and multiple screenshots).
function hash(seed) {
  const s = String(seed == null ? '' : seed);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function demoName(seed) {
  return NAMES[hash(seed) % NAMES.length];
}

export function demoEmail(seed) {
  const name = demoName(seed).toLowerCase().replace(/[^a-z]+/g, '.');
  const domains = ['gmail.com', 'icloud.com', 'outlook.com', 'hotmail.co.uk'];
  return `${name}@${domains[hash(seed) % domains.length]}`;
}

// Plausible UK addresses for screenshots.
const STREETS = [
  'Maple Road', 'High Street', 'Church Lane', 'Victoria Avenue', 'Oak Drive',
  'Station Road', 'Kingsway', 'Elm Close', 'Park View', 'Queens Road',
];
const TOWNS = [
  ['London', 'SW2 1AB'], ['Manchester', 'M14 5RT'], ['Birmingham', 'B12 9QW'],
  ['Leeds', 'LS6 3HG'], ['Bristol', 'BS5 7DE'], ['Reading', 'RG1 4PL'],
  ['Croydon', 'CR0 2NF'], ['Hounslow', 'TW3 1KS'], ['Coventry', 'CV1 5JX'],
  ['Nottingham', 'NG7 2BX'],
];

export function demoAddress(seed) {
  const h = hash(seed);
  const num = (h % 98) + 1;
  const street = STREETS[(h >>> 3) % STREETS.length];
  const [town, postcode] = TOWNS[(h >>> 7) % TOWNS.length];
  return `${num} ${street}\n${town}\n${postcode}`;
}

// Convenience: given a real name/email and a seed, return what to display.
export function maskName(realName, seed) {
  return isDemo() ? demoName(seed) : realName;
}
export function maskEmail(realEmail, seed) {
  return isDemo() ? demoEmail(seed) : realEmail;
}
export function maskAddress(realAddress, seed) {
  return isDemo() ? demoAddress(seed) : realAddress;
}
