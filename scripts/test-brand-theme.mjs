// Per-shop brand theme (client/src/theme.js). A shop that sets its colours must
// get them on its buttons and chips too, not just the header — the till showed
// a black header above pink controls (Korakot, 7 Sep).
//   node scripts/test-brand-theme.mjs
const props = new Map();
globalThis.document = { documentElement: { style: {
  setProperty: (k, v) => props.set(k, v),
  removeProperty: (k) => props.delete(k),
} } };
globalThis.window = { dispatchEvent: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
globalThis.CustomEvent = class { constructor(n, o) { this.type = n; this.detail = o && o.detail; } };

const { applyBrandTheme, readableInk, luminance, rgba, textOn, contrastRatio, DEFAULT_PRIMARY } = await import('../client/src/theme.js');

let pass = 0, fail = 0;
const check = (n, c, e) => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, e !== undefined ? JSON.stringify(e) : ''); } };

console.log('— readable ink over a brand colour');
check('near-black brand takes white ink', readableInk('#131313') === '#ffffff');
check('pale peach brand takes dark ink', readableInk('#E9C09F') === '#1f2328');
check('navy takes white ink', readableInk('#0D1B3E') === '#ffffff');
check('white takes dark ink', readableInk('#ffffff') === '#1f2328');
check('short hex works', readableInk('#000') === '#ffffff' && readableInk('#fff') === '#1f2328');
check('luminance rises from black to white', luminance('#000000') < luminance('#808080') && luminance('#808080') < luminance('#ffffff'));
check('rgba keeps the colour and adds alpha', rgba('#C9A84C', 0.3) === 'rgba(201, 168, 76, 0.3)');

console.log('— a shop with a brand paints its own actions');
props.clear();
applyBrandTheme({ brand_primary: '#131313', brand_accent: '#E9C09F' });
check('header colour is the brand primary', props.get('--brand-primary') === '#131313', props.get('--brand-primary'));
check('accent is the brand accent', props.get('--brand-accent') === '#E9C09F');
check('buttons follow the primary', props.get('--brand-action') === '#131313', props.get('--brand-action'));
check('button text is readable on it', props.get('--brand-action-ink') === '#ffffff');
check('a soft tint is derived for selected chips', /^rgba\(19, 19, 19, 0\.08\)$/.test(props.get('--brand-tint') || ''), props.get('--brand-tint'));
check('the header underline follows the accent', props.get('--brand-accent-soft') === 'rgba(233, 192, 159, 0.3)', props.get('--brand-accent-soft'));

console.log('— a pale brand still reads');
props.clear();
applyBrandTheme({ brand_primary: '#E9C09F', brand_accent: '#131313' });
check('pale primary gets dark button text, never white on cream', props.get('--brand-action-ink') === '#1f2328');

console.log('— a shop with no brand keeps Action Red');
props.clear();
applyBrandTheme({});
check('no action override is set, so the CSS default stands', !props.has('--brand-action') && !props.has('--brand-action-ink'), [...props.keys()]);
check('primary falls back to the SiamShop default', props.get('--brand-primary') === DEFAULT_PRIMARY);

console.log('— a broken colour cannot blank the UI');
props.clear();
applyBrandTheme({ brand_primary: 'not-a-colour', brand_accent: '#E9C09F' });
check('junk primary falls back and sets no action override', props.get('--brand-primary') === DEFAULT_PRIMARY && !props.has('--brand-action'), props.get('--brand-primary'));

console.log('— a LIGHT brand must still be readable');
// Korakot's demo shop is #fbf8f1 on #E7A3B0: the header went cream, the white
// nav links vanished into it, and headings and prices — brand-coloured on white
// cards — vanished the other way (7 Sep).
check('contrast ratio: black on white is 21, a colour on itself is 1',
  Math.round(contrastRatio('#000000', '#ffffff')) === 21 && Math.round(contrastRatio('#abcdef', '#abcdef')) === 1);
check('a pale brand steps aside as text on white', textOn('#ffffff', '#fbf8f1') === '#1f2328');
check('a dark brand is kept as text on white', textOn('#ffffff', '#0D1B3E') === '#0D1B3E');

props.clear();
applyBrandTheme({ brand_primary: '#fbf8f1', brand_accent: '#E7A3B0' });
check('header text turns dark over a cream header', props.get('--brand-on-primary') === '#1f2328', props.get('--brand-on-primary'));
check('headings and prices stop being cream on white', props.get('--brand-text') === '#1f2328', props.get('--brand-text'));
check('a pale accent on a pale header steps aside too',
  props.get('--brand-accent-on-primary') === '#1f2328', props.get('--brand-accent-on-primary'));
check('buttons still take the brand, with dark ink on it',
  props.get('--brand-action') === '#fbf8f1' && props.get('--brand-action-ink') === '#1f2328');

props.clear();
applyBrandTheme({ brand_primary: '#131313', brand_accent: '#E9C09F' });
check('a dark header keeps white text and its own accent',
  props.get('--brand-on-primary') === '#ffffff' && props.get('--brand-accent-on-primary') === '#E9C09F',
  { ink: props.get('--brand-on-primary'), accent: props.get('--brand-accent-on-primary') });
check('a dark brand is still used for headings', props.get('--brand-text') === '#131313');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
