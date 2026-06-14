# SiamShop — Demo Setup (no domain)

Goal: **backend hosted on Railway** (persistent, real DB + Stripe test), **frontend running on your PC** to show the client. No custom domain required — Railway's free `*.up.railway.app` URL is enough, and the local frontend talks straight to it.

```
   Your PC (browser)
   http://localhost:5173   ──API calls──▶   https://<your-app>.up.railway.app
   (frontend: npm run dev)                   (backend + Postgres on Railway)
```

---

## Part 1 — Backend on Railway (one-time, ~15 min)

1. **railway.app → New Project → Deploy from GitHub repo →** `kongponsrisiri-coder/Siam-Shop` (root directory).
2. In the project: **+ New → Database → PostgreSQL**. This auto-sets `DATABASE_URL` — leave it.
3. Service → **Variables** → add:

   | Variable | Value |
   |---|---|
   | `AUTH_SECRET` | run `openssl rand -hex 32` and paste the output |
   | `ADMIN_PASSWORD` | the password you'll use to log into admin / till / scanner |
   | `DEFAULT_SHOP_NAME` | the shop's display name (e.g. the client's shop) |
   | `DEFAULT_SHOP_SLUG` | `demo` |
   | `FRONTEND_URL` | `http://localhost:5173` |
   | `STRIPE_SECRET_KEY` | `sk_test_…` (from Stripe → test mode) — *optional* |
   | `STRIPE_PUBLISHABLE_KEY` | `pk_test_…` — *optional* |
   | `BREVO_API_KEY` + `FROM_EMAIL` + `FROM_NAME` | for order emails — *optional* |
   | `ANTHROPIC_API_KEY` | for AI invoice scan + Messenger parsing — *optional* |

   You can demo with **just the first five** — without Stripe, customers can still order via **bank transfer**; emails/AI simply stay off until their keys are added.

4. Service → **Settings → Networking → Generate Domain**. Copy the URL (e.g. `https://siam-shop-production.up.railway.app`).
5. Check it: open `https://<that-url>/api/health` → should show `{"status":"ok","db":"ok"}`. `db:"ok"` means the database connected and the schema + demo shop + 12 categories + default settings were created automatically.

**→ Send me that Railway URL and I'll wire up the local frontend + verify it end-to-end.**

---

## Part 2 — Frontend on your PC

Once the backend URL exists, run the frontend pointed at it:

```bash
cd ~/Desktop/siamshop/client
npm install                 # first time only
VITE_API_BASE=https://<your-app>.up.railway.app npm run dev
```

Open **http://localhost:5173**. That's the storefront. Other surfaces (same login = `ADMIN_PASSWORD`):
- `/admin` — manage products, categories, settings, orders
- `/till` — in-store EPOS
- `/scan` — phone scanner (open on a phone via your PC's LAN IP, or just demo on the laptop)

> To make the command shorter, I can drop a `client/.env.local` with `VITE_API_BASE=…` so you only need `npm run dev`. Tell me the URL and I'll add it.

---

## Part 3 — Load demo data for the client

After Part 1, the shop is empty. Two options:
- **Manually:** log into `/admin`, add a handful of products with prices/stock/category (English name + Thai name).
- **Or I can write a seed script** that loads ~15 realistic Thai-grocery products (rice, sauces, curry paste, snacks) across the categories so the demo looks full. Say the word.

---

## What needs a domain later (not now)

Nothing for the demo. A custom domain only matters when you go public: point it at a Netlify deploy of the frontend (see `DEPLOY.md`) so customers visit `siamshop.co.uk` instead of `localhost`. For showing the client, `localhost` + the Railway backend is all you need.
