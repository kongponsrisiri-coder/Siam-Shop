// Per-shop brand theme (SIAMSHOP-DEVICE-001 D3) — port of the restaurant's
// SEPOS-BRAND-001 CSS-variable system.
//
// styles.css declares `--navy: var(--brand-primary, #0D1B3E)` and
// `--gold: var(--brand-accent, #C9A84C)`, so setting the two brand vars on
// <html> repaints the till header, PIN screen, Admin and storefront. With no
// override the defaults are the SiamShop CI colours (BRAND_CI.md §3) and
// nothing changes. Action Red / status colours are functional, never themed.
//
// The hex literals below must stay PLAIN hex — they feed <input type=color>.
export const DEFAULT_PRIMARY = '#0D1B3E'; // Deep Navy
export const DEFAULT_ACCENT = '#C9A84C';  // Thai Gold

export const BRAND_PRESETS = [
  { name: 'SiamShop (default)', primary: '#0D1B3E', accent: '#C9A84C' },
  { name: 'Emerald & Gold', primary: '#0B3D2E', accent: '#D4AF37' },
  { name: 'Charcoal & Copper', primary: '#1E1E1E', accent: '#B87333' },
  { name: 'Burgundy & Cream', primary: '#5B1A1A', accent: '#E8D9B5' },
  { name: 'Teal & Coral', primary: '#0E4D54', accent: '#E4572E' },
  { name: 'Plum & Blush', primary: '#3B1F3B', accent: '#E7A3B0' },
];

// --- derived colours -------------------------------------------------------
// A shop sets two colours; the UI needs a few more. Rather than ask the owner
// for them, derive them so a brand always paints a coherent screen.
function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
// WCAG relative luminance, used only to choose readable text over a colour.
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const c = [r, g, b].map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
// Ink that stays legible on a brand colour, so a pale brand does not produce
// white-on-cream buttons and a dark one does not produce black-on-navy.
export function readableInk(hex) { return luminance(hex) > 0.5 ? '#1f2328' : '#ffffff'; }
// WCAG contrast ratio, 1 (identical) to 21 (black on white).
export function contrastRatio(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
// A brand colour is also used as TEXT on white cards — headings, prices, tags.
// A pale brand cannot do that job, so it steps aside for the normal ink rather
// than printing cream on white (Korakot's demo shop is #fbf8f1).
export function textOn(bg, brand, fallback = '#1f2328') {
  return contrastRatio(brand, bg) >= 4.5 ? brand : fallback;
}
export function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
export const isHex = (v) => typeof v === 'string' && HEX.test(v.trim());
const DATA_IMG = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
export const isLogoDataUrl = (v) => typeof v === 'string' && v.length < 600000 && DATA_IMG.test(v);

// Module-level brand state + change event, so the Logo component (used on the
// header, the PIN screen and Admin) can swap to the shop's own logo.
const state = { logo: '', primary: DEFAULT_PRIMARY, accent: DEFAULT_ACCENT };
const EVENT = 'siamshop:brand';

export function getBrand() { return { ...state }; }

// Apply a shop's brand to the whole app. Bad or missing values fall back to
// the defaults, so a broken colour can never blank the UI.
export function applyBrandTheme(settings) {
  const s = settings || {};
  state.primary = isHex(s.brand_primary) ? s.brand_primary.trim() : DEFAULT_PRIMARY;
  state.accent = isHex(s.brand_accent) ? s.brand_accent.trim() : DEFAULT_ACCENT;
  state.logo = isLogoDataUrl(s.brand_logo) ? s.brand_logo : '';
  if (typeof document !== 'undefined' && document.documentElement) {
    const root = document.documentElement;
    root.style.setProperty('--brand-primary', state.primary);
    root.style.setProperty('--brand-accent', state.accent);
    // Buttons, active chips and links used a fixed Action Red, so a branded
    // shop got its own header above pink controls (Korakot, 7 Sep). They now
    // follow the shop's primary, with ink picked for contrast. A shop that has
    // set no brand colour keeps Action Red, because these stay unset.
    // A brand can only be a BUTTON FILL if it stands out from the white page.
    // The demo shop's #fbf8f1 does not: its buttons and its active category
    // chip came out the same colour as the page behind them, and the language
    // pill vanished into the header. A brand that pale steps aside entirely and
    // the product's Action Red stands, which is visible on any header.
    const branded = isHex(s.brand_primary) && contrastRatio(state.primary, '#ffffff') >= 3;
    if (branded) {
      root.style.setProperty('--brand-action', state.primary);
      root.style.setProperty('--brand-action-ink', readableInk(state.primary));
      root.style.setProperty('--brand-tint', rgba(state.primary, 0.08));
    } else {
      for (const v of ['--brand-action', '--brand-action-ink', '--brand-tint']) root.style.removeProperty(v);
    }
    root.style.setProperty('--brand-accent-soft', rgba(state.accent, 0.3));
    // Text that sits ON the brand primary (header links, hero wording). It was
    // hard-coded white, which disappeared the moment a shop chose a light
    // brand (Korakot, 7 Sep).
    root.style.setProperty('--brand-on-primary', readableInk(state.primary));
    // Text that sits on white and wants to be brand-coloured.
    root.style.setProperty('--brand-text', textOn('#ffffff', state.primary));
    // The accent over the primary — a pale accent on a pale header is the same
    // problem again, so it steps aside for whatever reads on that header.
    root.style.setProperty('--brand-accent-on-primary',
      contrastRatio(state.accent, state.primary) >= 3 ? state.accent : readableInk(state.primary));
    try { window.dispatchEvent(new CustomEvent(EVENT, { detail: getBrand() })); } catch {}
  }
  return getBrand();
}

// The picture that goes on paper. A logo drawn for a dark app header prints as
// a black slab, so a shop can give the printer its own artwork; empty means
// "use the app logo" (Korakot, 8 Sep). One rule, so the till, the reprint
// button, the test page and the preview cannot disagree.
export function receiptLogoOf(settings) {
  const s = settings || {};
  if (isLogoDataUrl(s.receipt_logo)) return s.receipt_logo;
  return isLogoDataUrl(s.brand_logo) ? s.brand_logo : '';
}

export function onBrandChange(cb) {
  if (typeof window === 'undefined') return () => {};
  const h = (e) => cb(e.detail || getBrand());
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}

// Downscale an uploaded image file to a PNG data URL no wider than maxWidth
// (transparency kept — the receipt raster treats transparent as paper).
export function fileToLogoDataUrl(file, maxWidth = 600, maxHeight = 300) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width, maxHeight / img.height);
      const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image')); };
    img.src = url;
  });
}
