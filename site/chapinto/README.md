# Cha & Pinto Box — marketing site with live SiamShop data

Sandy's design, unchanged, with the sample content replaced at runtime by what
is actually in SiamShop. If the API is unreachable the page falls back to her
static content, so it can never look worse than the mockup.

| File | Whose | What |
|---|---|---|
| `index.html`, `style.css`, `app.js`, `img/` | Sandy | The design. Only two lines of `index.html` were touched: the `<body>` attributes and one `<script>` tag. |
| `siamshop.js` | Joy | The data layer. Self-contained, no build step, no dependencies. |
| `netlify.toml` | Joy | Static publish config. |

## How it is wired

`<body data-shop="demo" data-api="https://siam-shop-production.up.railway.app">`
sets which shop the page reads. `siamshop.js` then:

- replaces the five sample product cards with the real retail catalogue
  (`/api/products`), reusing her `.prod` markup so the CSS is untouched, and
  adds category chips built from the categories that actually have products;
- fills any `[data-menu="lunch"]` or `[data-menu="boba"]` element with the live
  menu, and corrects the "from £x" figures in the existing copy;
- points every "order" and "browse" link at the real shop;
- hides the "sample menu / mockup" disclaimer once real data is showing.

To show a different shop, change `data-shop`. To point at a local server for
testing, change `data-api` to `http://localhost:4999`.

## Deploying

The Netlify site is **chapintobox-sandy.netlify.app**, which Sandy owns. Either:

1. **Deploy this folder.** In Netlify, set the site's *Base directory* to
   `site/chapinto` and connect this repo. No build command; it is static.
2. **Or keep Sandy's repo as the source** and copy `siamshop.js` into it, then
   add these two lines to her `index.html`:
   ```html
   <body data-shop="demo" data-api="https://siam-shop-production.up.railway.app">
   <script src="siamshop.js" defer></script>   <!-- immediately after app.js -->
   ```
   Nothing else changes, so her design work stays the source of truth.

Option 2 is the better long-term shape if Sandy keeps iterating on the design.

## Loading the catalogue

The products the page shows come from the shop, so load them first:

```bash
# 1. Pull the catalogue and photos from their live Wix site (writes to out/chapinto)
node scripts/scrape-chapinto.mjs

# 2. Load it into the shop (dry run first — drop --apply to preview)
BASE=https://siam-shop-production.up.railway.app ADMIN_PASSWORD=… \
  node scripts/load-chapinto.mjs out/chapinto --apply --replace

# 3. Add the lunch counter and boba menu
BASE=https://siam-shop-production.up.railway.app ADMIN_PASSWORD=… \
  node scripts/seed-chapinto-food.mjs --apply
```

`--replace` deletes the shop's existing products first and writes a JSON backup
next to the CSV before it does. Sales history is unaffected either way: order
lines keep their own name and price snapshots.

## Known gaps

- **Stock levels are a placeholder** (10 each). Their Wix site does not publish
  stock, so this needs their CSV export or a stocktake.
- **Categories are partly inferred.** Wix only server-renders a few products per
  category page, so the rest are filed by name rules. Their Wix Stores export
  fixes this, and re-running the loader corrects them in place.
- **The rice-box topping list is incomplete** — their menu hides some behind
  "show more". Confirm the full list with the client.
- Prices are a snapshot of their public site on the day of the scrape.
