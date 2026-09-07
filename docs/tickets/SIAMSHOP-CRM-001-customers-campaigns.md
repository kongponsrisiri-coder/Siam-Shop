# SIAMSHOP-CRM-001 — Customer CRM + email campaigns (port of restaurant SEPOS-033)

**From Korakot, 7 Sep 2026:** "the CRM as well" — after SIAMSHOP-DEVICE-001. **Owner:** Joy · **Reviewer:** Krit.
**What SiamShop has:** customer accounts (register/login/orders), an Admin customer list + CSV, `marketing_consent` captured at checkout (23 references). **What's missing:** the CRM *view* (who's worth contacting), operator-managed consent, campaigns, automatic lapsed-customer triggers, unsubscribe.
**⛔ Not in scope:** loyalty points (Korakot HELD loyalty 5 Sep — spa only; do not build or propose). Birthday capture is fine (restaurant has the field; trigger stays no-op until captured).

## C1 — Customers tab becomes a CRM (1 day)
Port `client/src/screens/admin/CustomersSection.jsx`: per customer — orders, total spend, average basket, first/last order, days since last, top products (shops: "buys jasmine rice every 3 weeks" is the whole point), postal vs collection vs in-store split. Search, sort by spend/last order, filters: **lapsed** (no order in N days, default 45 for a grocery — restaurant uses 60), **new this month**, **consented**. CSV export keeps working. **In-store sales attach to a customer** when the cashier looks one up by phone/email on the Till (optional, one field on the payment screen) — otherwise SiamShop's CRM only sees online orders. Restaurant source: `GET /api/customers` (aggregates), `total_spend` heuristic.

## C2 — Consent the operator can manage (½ day)
Port `PUT /api/customers/marketing-consent` + the clickable badge: consent obtained verbally / on paper / at the counter can be recorded by a manager, with `consent_source` + timestamp. GDPR: the badge shows when and how consent was given; unconsented customers are excluded from every send, no exceptions. `GET /api/unsubscribe?token=` with the HMAC token pattern (`UNSUB_SECRET`) — one-click, no login, records the opt-out; link in every campaign footer.

## C3 — Campaigns (1 day)
Port `CampaignsSection.jsx` + `GET /api/campaigns`, `GET /api/campaigns/recipient-count`, `POST /api/campaigns/send` via Brevo (SiamShop already sends order emails through Brevo; sender = `info@siamepos.co.uk` per `siamshop-email-sender` — `orders@siamshop.co.uk` fails). Audience picker = the C1 filters (all consented / lapsed / new / bought category X in the last 90 days). Subject + body (simple editor, shop logo header from DEVICE-001 D3, unsubscribe footer mandatory), **send test to me**, then send. Campaign history: sent count, opens if Brevo reports them. Rate: Brevo free-tier daily cap surfaced in the UI so a 400-customer send doesn't half-fail silently.

## C4 — Automatic triggers (½ day)
Port `src/services/makeWebhooks.js` hourly cron shape, but keep it in-app (Make.com is optional): **lapsed** (fires once per customer when they cross N days → queues a "we miss you" email if a template is enabled), **order completed** (24 h after a postal order is dispatched → "how was it?" + review link), **birthday month** (no-op until DOB captured — add the optional DOB field to account settings). Each trigger has an on/off + template in Admin → Campaigns → Automations; each email carries the unsubscribe link; a customer who unsubscribes never gets a trigger email again.

## Acceptance
- [ ] Customers tab shows spend/last-order/top-products per customer; lapsed filter matches `days_since_last > N`; CSV still exports.
- [ ] Till sale attached to a looked-up customer appears in their history.
- [ ] Manager records verbal consent → badge shows source + time; unconsented customer excluded from recipient-count; unsubscribe link flips consent off without login and is honoured by campaigns AND triggers.
- [ ] Campaign: recipient-count matches the filter; test send arrives; real send logged with count; Brevo failure surfaces as an error, not a silent partial.
- [ ] Lapsed trigger fires exactly once per customer (idempotent flag), never for unconsented.
- [ ] Render smoke green on Customers + Campaigns screens.
