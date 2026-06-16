# SiamShop — Brand Corporate Identity

**Version:** 1.0
**Owner:** Korakot Kongponsrisiri, Founder & Director
**Contact:** info@siamepos.co.uk
**Product:** SiamShop — unified retail system for Thai supermarkets in the UK
**Maintained by:** Sandy (UI/UX Designer)

---

## 0. Relationship to SiamEPOS — read this first

SiamShop is the **retail sibling** of SiamEPOS and shares its brand family
(`restaurant-epos/BRAND_CI.md`). It uses the **same lotus mark, the same
Deep Navy + Thai Gold + Action Red palette, and the same Georgia/serif
heritage type**. The two products should read as *made by the same hand*.

The only deliberate differences are the **wordmark** (`Siam` + gold **Shop**)
and **retail-specific surfaces** (storefront, product cards, basket, checkout,
till, scanner) that SiamEPOS doesn't have. Everything in this doc that isn't
explicitly retail-specific defers to the SiamEPOS CI.

> **This is the law for SiamShop UI — no exceptions without Korakot approval.**
> Always specify exact hex, exact font weight, exact size.

If SiamShop ever needs to visually diverge from SiamEPOS, that's a deliberate
decision recorded here first — not per-screen drift.

---

## 1. Brand Overview

SiamShop is a **unified retail system** for independent Thai grocery shops in
the UK: one shared stock core with three surfaces — an in-store EPOS till, an
online shop, and a phone scanner (barcode + AI invoice). Built **by** a Thai
person **for** Thai grocers.

**Product category:** Thai grocery retail system
**Brand name:** SiamShop *(one word, "Shop" is part of the name)*
**Brand personality:** Fresh · Trustworthy · Thai heritage · Modern · Practical

---

## 2. Logo Mark — The Lotus Badge

SiamShop uses the **same geometric 5-petal lotus** as SiamEPOS (Thai heritage,
purity, elegance; graduated petal opacity 100% → 82% → 62%, gold centre dot).
The mark is **shared** — only the wordmark changes to "SiamShop".

The canonical component is `client/src/components/Logo.jsx` — always use it,
never hand-roll the SVG.

```jsx
import Logo, { LotusBadge } from './components/Logo.jsx';

<Logo />                 {/* dark bg: white "Siam" + gold "Shop", navy centre */}
<Logo light />           {/* light bg: navy "Siam" + gold "Shop" */}
<Logo wordmark={false} />{/* badge only */}
<LotusBadge size={16} /> {/* favicon / tiny */}
```

**Wordmark treatment:** `Siam` is white on dark / Deep Navy on light · **`Shop`
is always Thai Gold `#C9A84C`** · Georgia serif, weight 700, letter-spacing −0.5px.

**Recommended sizes:** 16px (favicon) · 30–32px (navbar) · 48px (app icon).
**Minimum:** never below 16px (petals become unreadable).
**Background:** Deep Navy `#0D1B3E` or White `#FFFFFF` only.

**Do not:** recolour the lotus (always gold) · separate "Siam" and "Shop" ·
add shadows/outlines/tilt · place on photos or busy backgrounds.

---

## 3. Colour Palette

These are the live CSS variables in `client/src/styles.css :root`.

### Primary brand colours

| Name | Hex | CSS var | Usage |
|------|-----|---------|-------|
| **Deep Navy** | `#0D1B3E` | `--navy` | Navbar, headers, hero, prices/totals, chart bars |
| **Thai Gold** | `#C9A84C` | `--gold` / `--siam-gold` | Accents, navbar underline, highlights, hovers, "Shop" |
| **Action Red** | `#e94560` | `--siam-red` | Primary buttons, active pills, links |
| **White** | `#FFFFFF` | — | Cards, surfaces, product grid |
| **Page BG** | `#fafafa` | `--bg` | App background |

### Neutrals

| Name | Hex | CSS var | Usage |
|------|-----|---------|-------|
| Ink | `#1f2328` | `--ink` | Primary body text |
| Muted | `#6b7280` | `--muted` | Secondary text, captions, units |
| Line | `#e5e7eb` | `--line` | Borders, dividers, input outlines |
| Gold tint | `#fff8e1` | — | Hover wash, order-row hover, restock banner |
| Navy tint | `#eef0f5` | — | Neutral tag background |

### Status / semantic (shared with SiamEPOS)

| Name | Hex | Usage |
|------|-----|-------|
| Success | `#22c55e` / `#16a34a` | In stock, paid, change due, "Saved ✓" |
| Success bg | `#dcfce7` / `#ecfdf5` | Confirmation tags/banners |
| Warning | `#f59e0b` | Low stock, pending |
| Danger | `#ef4444` / `#991b1b` | Errors, out of stock text |
| Danger bg | `#fee2e2` | Error banners, `.tag.off` |

### Retail stock-status system

| Status | Treatment |
|--------|-----------|
| In stock | green `#16a34a` text / `.tag.ok` (`#dcfce7` bg) |
| Low stock | amber `#f59e0b`, "Only N left" |
| Out of stock | `.tag.off` (`#fee2e2` bg, `#991b1b`) + Notify-me |
| Neutral info | `.tag` (`#eef0f5` bg, navy text) |
| Fresh / restock | gold-tint banner `#fff8e1`, gold border |

**Colour rules**
- **Action Red is a CTA colour, not an alarm.** Errors use the danger family
  (`#fee2e2` / `#991b1b`), never `--siam-red`.
- Chart bars and data accents use **Deep Navy** (legible, structural) — not
  gradients. (Fixed 2026-06-15: the dashboard chart's red→gold gradient and a
  stray indigo `#3730a3` were removed in favour of navy.)
- Let product photography carry the colour; keep large surfaces white/light.

---

## 4. Typography

| Role | Font | Usage |
|------|------|-------|
| Brand / headings | **Georgia, serif** (`--serif`) | h1–h4, wordmark, section titles |
| Body / UI | **system-ui** (`system-ui, -apple-system, …`) | labels, buttons, body, data |
| Thai (web) | system-ui / Noto Sans Thai | bilingual EN/TH storefront text |

**Type rules**
- Headings are navy Georgia (`h1,h2,h3,h4 { font-family: var(--serif); color: var(--navy); }`).
- Minimum body **14px**; **form inputs 16px** (prevents iOS Safari zoom).
- Prices weight **700+**, navy. Sale price in Action Red, old price muted strike.
- **Never use Arial, Roboto, or Inter** — they break the heritage feel.

**Font weights:** 400 body · 600 labels/pills/status · 700 headings/prices/buttons · 800 KPI values / bill totals.

---

## 5. UI Component Tokens

Live classes in `client/src/styles.css`. Build against these, don't re-invent.

### Buttons
- **Primary** `.btn` — `background: var(--siam-red)`, white, radius 12, weight 700. (Add to cart, Checkout, Pay)
- **Secondary** `.btn.secondary` — white, ink text, `1px solid var(--line)`.
- **Ghost** `.btn.ghost` — outline, used for "View all →" etc.
- **Cancel** `.cancel-btn` — white, red text + red border; hover `#fee2e2`.
- Minimum tap target 40px (consumer mobile).

### Category pills
- `.cat-tab` — white, `1px solid var(--line)`, pill (radius 999px).
- `.cat-tab.active` — `background: var(--siam-red)`, white, red border. (Storefront)
- `.till-cat.active` / `.scanner-mode.active` — same red-active pattern on staff screens.

### Product card (storefront)
- White card, `1px solid var(--line)`, radius 12.
- Image area `aspect-ratio: 4/3`; photoless products use a deterministic
  on-brand hue gradient placeholder (`StorefrontScreen.jsx productHue`).
- Name: system-ui, navy, ≤2 lines. Price: navy, weight 700.
- Offer badge: top-left, `background: var(--siam-red)`, white.

### Quantity stepper
- Inline `+ / −` buttons, 34px, white, `1px solid var(--line)`, radius 6.
- Adds straight to basket from the card; shows qty when in cart.

### Tags
- `.tag` neutral — `#eef0f5` bg, navy text.
- `.tag.ok` — `#dcfce7` bg, `#166534` (in stock / paid).
- `.tag.off` — `#fee2e2` bg, `#991b1b` (out of stock / unpaid / cancelled).

### Navigation
- `.topbar` — `background: var(--navy)`, `2px solid rgba(201,168,76,0.3)` gold underline, sticky.
- `.navlinks a` — white 90%; hover → gold.
- `.staff-links` — muted white, separated by a left border (Admin · Till · Scan).
- Staff surfaces (till/scanner) sit on **white** with a `.surface-tag` label beside the logo.

### Admin dashboard
- `.kpi` — white card, 3px top accent border. Accents: Today = red, This week = gold, This month = green, All time = **navy**.
- `.kpi-value` — weight 800, 26px.
- `.chart-bar` — **solid `var(--navy)`**, radius 6 top. No gradients.

### Banners
- Restock / info banner: `#fff8e1` bg, gold border (`.restock` pattern).
- Error: `#fee2e2` bg, `#fca5a5` border, `#991b1b` text.
- Success: `#ecfdf5` bg, `#6ee7b7` border, `#065f46` text.

---

## 6. Screen Notes

### Storefront (`StorefrontScreen.jsx`)
- Navy hero with gold accent + tagline; gold-tint "fresh stock refreshes every
  <restock_day>" banner; search; category pills; product grid with inline qty
  steppers, out-of-stock + notify-me. Bilingual EN/TH.

### Product / Cart / Checkout
- Bilingual names; minimum-order check blocks checkout with the shortfall.
- Checkout: customer + address + postcode with **live delivery quote**; Card
  (Stripe) or Bank transfer; success page reads the order and clears the cart.
- Keep colour to the family: navy headers, red primary CTA, neutral/semantic tags only.

### Account (`AccountScreen.jsx`)
- Login/Register card, editable profile, KPIs, order-history table linking to
  order status. Neutral `.tag` is navy-on-tint (no blue/purple).

### Order status (`OrderStatusScreen.jsx`)
- Friendly statuses via tags: Awaiting payment (`.tag.off`) / Paid (`.tag.ok`) /
  Dispatched / Cancelled.

### Till (`TillScreen.jsx`) — in-store EPOS
- White staff surface; red-active category pills; large numpad; **change due in
  green**; receipt card 340px.

### Scanner (`ScannerScreen.jsx`) — phone PWA
- Mobile-first, max 480px; red-active mode tabs (checkout / goods-in / stocktake);
  camera frame; log rows tinted by outcome (ok green / warn amber / err red).

### Admin
- Navy/white tool feel; KPI accents per §5; navy chart bars; printable packing slip.

---

## 7. Bilingual (EN / TH) Guidelines
- Storefront ships EN/TH (`client/src/lang.jsx`, default EN, localStorage,
  toggle in the top bar). `pickName/pickDesc/pickCategory` fall back to EN.
- Product Thai name field: `name_th`. Always leave extra width — Thai runs longer.
- Thai text: navy on light, gold on dark (same rule as SiamEPOS).

---

## 8. File & Asset Locations

| Asset | Location |
|-------|----------|
| Logo component | `client/src/components/Logo.jsx` |
| Global styles + tokens | `client/src/styles.css` (`:root`) |
| Storefront screens | `client/src/screens/` |
| Admin sections | `client/src/screens/admin/` |
| Language strings | `client/src/lang.jsx` |
| Favicon (lotus) | `client/public/favicon.svg` |
| Brand CI (this file) | `BRAND_CI.md` (repo root) |
| SiamEPOS CI (parent) | `../restaurant-epos/BRAND_CI.md` |

**Deployment:** React+Vite → Netlify · Node+Express → Railway
(`siam-shop-production.up.railway.app`).

---

*SiamShop Brand CI v1.0 — maintained by Sandy. Mirrors SiamEPOS CI v1.3;
defers to it for anything not retail-specific. Last updated: 15 June 2026.*
