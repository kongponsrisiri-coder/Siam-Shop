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
    try { window.dispatchEvent(new CustomEvent(EVENT, { detail: getBrand() })); } catch {}
  }
  return getBrand();
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
