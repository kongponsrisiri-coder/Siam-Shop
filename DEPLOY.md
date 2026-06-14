# SiamShop — Deployment Runbook

How to take SiamShop live: **backend → Railway**, **frontend → Netlify**, **Postgres → Railway plugin**. Everything else (schema, demo shop, categories, settings) is created automatically on first boot by `initDB()`.

> **Order matters** because the two halves reference each other's URLs. Do it in this sequence:
> 1. Railway Postgres + backend (get the backend URL)
> 2. Netlify frontend with `VITE_API_BASE` = backend URL (get the site URL)
> 3. Set `FRONTEND_URL` on Railway = Netlify URL, redeploy
> 4. Wire Stripe + Messenger webhooks
> 5. Smoke-test

You'll need accounts: **Railway**, **Netlify**, **Stripe** (test mode), **Brevo**, **Anthropic**, and a **Meta/Facebook** app+page (only for the Messenger bot).

---

## 1. Backend + database on Railway

1. **Create the project & database**
   - New Project → **Deploy from GitHub repo** → pick the `siamshop` repo (root directory).
   - In the project, **+ New → Database → PostgreSQL**. Railway sets `DATABASE_URL` on the service automatically — no action needed.
   - Railway auto-detects Node and runs `npm start` (`node src/server.js`). `PORT` is injected by Railway; the server reads `process.env.PORT`.

2. **Set the service variables** (service → **Variables**). Minimum to boot:

   | Variable | Value / how to get it |
   |---|---|
   | `DATABASE_URL` | auto-set by the Postgres plugin — leave it |
   | `AUTH_SECRET` | `openssl rand -hex 32` (generate locally, paste) |
   | `ADMIN_PASSWORD` | the owner's admin/till/scanner login password |
   | `DEFAULT_SHOP_SLUG` | `demo` (or the client's slug, e.g. `nuch`) |
   | `DEFAULT_SHOP_NAME` | the shop's display name |

   Add the rest as you enable each feature (you can deploy and smoke-test with just the above; payments/emails/AI degrade gracefully when unset):

   | Variable | For |
   |---|---|
   | `STRIPE_SECRET_KEY` | `sk_test_…` (card checkout) |
   | `STRIPE_PUBLISHABLE_KEY` | `pk_test_…` |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_…` (set in step 4) |
   | `BREVO_API_KEY` | order-confirmation emails |
   | `FROM_EMAIL` / `FROM_NAME` | sender shown on emails (e.g. `orders@siamshop.co.uk`) |
   | `ANTHROPIC_API_KEY` | AI invoice scan + Messenger order parsing |
   | `MESSENGER_VERIFY_TOKEN` | any string (matches FB config, step 5) |
   | `MESSENGER_APP_SECRET` | Meta App secret |
   | `MESSENGER_PAGE_ACCESS_TOKEN` | Meta Page token |
   | `FRONTEND_URL` | the Netlify URL (set in step 3) |

3. **Deploy & verify.** After the deploy goes green, open the service URL (Settings → Networking → **Generate Domain** if needed). It looks like `https://siamshop-production.up.railway.app`. Check:
   ```
   curl https://<backend>/api/health
   → {"service":"siamshop","status":"ok","db":"ok","stripe":...}
   ```
   `db:"ok"` confirms Postgres connected and `initDB()` ran (tables created; demo shop + 12 categories + default settings seeded). If `db:"down"`, the Postgres plugin isn't linked to this service.

---

## 2. Frontend on Netlify

1. **New site → Import from GitHub** → the same repo.
2. **Build settings:**
   - **Base directory:** `client`
   - Build command and publish dir come from `client/netlify.toml` (`npm install && npm run build`, publish `dist`). SPA redirects are already in that file, so deep links (`/product/12`, `/admin`, `/till`, `/scan`) work.
3. **Environment variables** (Site config → Environment):
   - `VITE_API_BASE` = the Railway backend URL from step 1.3 (no trailing slash).
   - *(Vite inlines this at build time — set it before the first build, and redeploy after any change.)*
4. **Deploy.** Note the site URL (e.g. `https://siamshop.netlify.app`). Open it — the storefront should load products from the backend.

---

## 3. Close the loop

- On **Railway**, set `FRONTEND_URL` = the Netlify URL and redeploy. This is used for CORS, Stripe success/cancel redirects, and the Messenger checkout links.
- (CORS is currently `*`, so the storefront works even before this — but Stripe redirects and Messenger links need the real URL.)

---

## 4. Stripe webhook (card payments)

Stripe stays in **test mode** for now (per Korakot's decision).

1. Stripe Dashboard (toggle to **Test mode**) → Developers → **Webhooks → Add endpoint**.
2. Endpoint URL: `https://<backend>/api/stripe/webhook`
3. Events to send: **`checkout.session.completed`** (add `charge.refunded` later for refunds).
4. Save → copy the **Signing secret** (`whsec_…`) → set `STRIPE_WEBHOOK_SECRET` on Railway → redeploy.
5. Make sure `STRIPE_SECRET_KEY`/`STRIPE_PUBLISHABLE_KEY` are the **test** keys, matching the test-mode webhook.

> Test card at checkout: `4242 4242 4242 4242`, any future expiry, any CVC, any postcode.
> Even if the webhook isn't set, paid orders still fulfil — the success page lazily confirms the session server-side (idempotent). The webhook is the production-grade path.

---

## 5. Messenger bot (optional, SIAMSHOP-011)

1. **Meta for Developers** → create an App (type: Business) → add the **Messenger** product → connect the shop's Facebook **Page**, generate a **Page access token** → `MESSENGER_PAGE_ACCESS_TOKEN`.
2. App **Settings → Basic** → copy the **App Secret** → `MESSENGER_APP_SECRET`.
3. Pick any string for `MESSENGER_VERIFY_TOKEN` (set it on Railway).
4. Messenger → **Configure webhook:**
   - Callback URL: `https://<backend>/api/messenger/webhook`
   - Verify token: the same `MESSENGER_VERIFY_TOKEN`
   - Subscribe the Page to the **`messages`** field.
   - Meta calls the URL with a GET to verify — it should succeed immediately.
5. Ensure `ANTHROPIC_API_KEY` is set (the bot uses Claude to parse order messages). Redeploy.
6. Test from the Page's Messenger: send "2x Jasmine Rice, 1x coconut milk" → the bot replies with a priced summary + a checkout link.

---

## 6. Brevo email (order confirmations)

- Set `BREVO_API_KEY`, `FROM_EMAIL`, `FROM_NAME` on Railway.
- Verify the sender domain/address in Brevo (Senders & Domains) or emails may be rejected.
- For the **shop-owner new-order notification**, set the `shop_email` setting in the **Admin → Settings** page once you're logged in (it's a shop setting, not an env var).

---

## 7. First-run configuration (in the app)

Sign in at `https://<site>/admin` with `ADMIN_PASSWORD`, then:
- **Settings:** confirm minimum order, the three delivery fees (London / Mainland / Remote), restock day, default language; add `shop_email`.
- **Categories:** the 12 Thai-grocery defaults are seeded — edit/add as needed.
- **Products:** add the catalogue (English name required, Thai optional; set category, price, stock, barcode if used).
- **Till / Scanner:** staff sign in at `/till` and `/scan` with the same password.

---

## 8. Post-deploy smoke test

- [ ] `GET /api/health` → `db:"ok"`
- [ ] Storefront lists products; category tabs + EN/TH toggle work
- [ ] Add to cart inline (+/−) → cart enforces the £-minimum
- [ ] Checkout: postcode shows the right delivery fee; pay with `4242…` test card → redirected to the success page → order shows **paid**
- [ ] Stripe Dashboard → webhook delivery shows **200**
- [ ] Admin → Orders: the order appears; **Mark dispatched** + tracking; **packing slip** prints
- [ ] (If enabled) Messenger: a DM order list returns a parsed summary + link
- [ ] (If enabled) Confirmation email received

---

## Notes & gotchas

- **`git push` auto-deploys both** (Railway backend + Netlify frontend) from the connected branch. Pick the production branch in each dashboard (currently work is on `siamshop-001-scaffold` — merge to `main` or point both at that branch).
- **Schema migrations are automatic & safe** — `initDB()` runs `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS` on every boot, so deploys never need manual SQL.
- **SSL** is enabled automatically for the remote `DATABASE_URL` and disabled for localhost — no config needed.
- **Going fully live (real money):** switch Stripe to live keys + recreate the webhook in **live** mode, and use live price handling. Until then, test mode is correct for demos.
- **Custom domain:** point it at Netlify for the storefront; the Railway backend can keep its `*.up.railway.app` domain (only referenced via `VITE_API_BASE`), or add a custom subdomain like `api.siamshop.co.uk`.
