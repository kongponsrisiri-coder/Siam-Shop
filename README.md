# SiamShop

E-commerce platform for Thai supermarkets in the UK. A standalone product
(separate from SiamEPOS) for independent Thai grocery shops to sell online.

- **Backend:** Node + Express + PostgreSQL → Railway
- **Frontend:** React + Vite → Netlify
- **Payments:** Stripe · **Email:** Brevo · **AI:** Anthropic

See [`CLAUDE.md`](./CLAUDE.md) for the full developer context, data model, and ticket backlog.

## Local development

### 1. Backend

```bash
cp .env.example .env        # fill in DATABASE_URL, AUTH_SECRET, ADMIN_PASSWORD, etc.
npm install
npm run dev                 # http://localhost:3002  (health: /api/health)
```

You need a PostgreSQL database. Easiest is a Railway Postgres plugin — copy its
`DATABASE_URL` into `.env`. `initDB()` creates all tables and seeds a default
shop (`DEFAULT_SHOP_SLUG`, default `demo`) on first boot.

### 2. Frontend

```bash
cd client
npm install
npm run dev                 # http://localhost:5173  (proxies /api → :3002)
```

Open <http://localhost:5173> for the storefront and `/admin` for the admin
(sign in with `ADMIN_PASSWORD`).

## Deployment

- **Railway** (backend): deploy this repo root. Set the env vars from
  `.env.example` in the service Variables tab. `npm start` runs `src/server.js`.
- **Netlify** (frontend): base directory `client`, build handled by
  `client/netlify.toml`. Set `VITE_API_BASE` to the Railway backend URL.
- After the backend is live, create the Stripe webhook endpoint pointing at
  `<backend>/api/stripe/webhook` and put its signing secret in
  `STRIPE_WEBHOOK_SECRET`.

## Status

**SIAMSHOP-001 (scaffold) — done:** DB schema + initDB, Express server with HMAC
admin auth, product read/CRUD, order listing, Stripe webhook skeleton, and the
React client (storefront, product, cart, checkout placeholder, admin).

Next: **SIAMSHOP-002** product catalogue polish, **SIAMSHOP-003** Stripe checkout.
