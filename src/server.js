// SiamShop — Express app entry point.
// Backend for the Thai-supermarket e-commerce platform. Postgres + Stripe +
// Brevo. Multi-tenant from day one: every data query is scoped to a shop_id.
//
// SIAMSHOP-001 scaffold: boots the DB, exposes health + a default-shop lookup,
// HMAC admin auth, product read/CRUD, order listing, and a Stripe webhook
// skeleton. Catalogue UX (002), checkout (003) and emails (004) build on this.

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const { pool, initDB, getShopIdBySlug } = require('./db/database');
const stripeService = require('./services/stripeService');
const aiService = require('./services/aiService');
const delivery = require('./services/delivery');
const messenger = require('./services/messengerService');
const emailService = require('./services/emailService');
const carriers = require('./services/carriers');
const assistant = require('./services/assistantService');
const availability = require('./services/availability');

const app = express();

// Railway runs behind a single reverse proxy. Trust it so req.ip is the real
// client IP (rate limiting keys on it) and Stripe/Messenger origin detection works.
app.set('trust proxy', 1);

// --- Security headers -------------------------------------------------------
// helmet sets sensible secure headers. CSP is disabled: this service also serves
// the React SPA from the same origin, and a default CSP would block it; the app
// is a same-origin SPA + Bearer-token API, so the other helmet defaults are the
// valuable part (HSTS, no-sniff, frameguard, referrer policy).
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

// --- Rate limiting ----------------------------------------------------------
// Brute-force guard on auth endpoints (admin/customer login, registration) and a
// broad limiter on the order-tracking lookup. Standard headers; trust-proxy set.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 attempts per 15 min per IP on a single auth route
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — please wait a few minutes and try again.' },
});
// Staff PIN pad (SIAMSHOP-ELECTRON-001): a whole counter shares one IP and
// signs in/out all day, so only FAILED attempts count against the limit —
// brute force is still capped at 10 wrong PINs per 15 min per IP.
const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many wrong PINs — please wait a few minutes and try again.' },
});
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60, // order tracking: generous, but blocks scripted enumeration
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
});

// --- CORS -------------------------------------------------------------------
// Admin auth uses Bearer tokens (not cookies), so a permissive origin is safe.
app.use(
  cors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type,Authorization',
    optionsSuccessStatus: 204,
  })
);

// --- Body parsing -----------------------------------------------------------
// The Stripe webhook needs the raw, unparsed body for signature verification,
// so its raw parser MUST be registered before the global express.json().
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
// Messenger signs the raw body (X-Hub-Signature-256), so capture it raw too.
app.use('/api/messenger/webhook', express.raw({ type: 'application/json' }));
// 20mb: invoice-scan uploads carry a base64 phone photo, which inflates ~33%.
app.use(express.json({ limit: '20mb' }));

// ---------------------------------------------------------------------------
// Auth — HMAC Bearer tokens (SiamEPOS SEPOS-047a pattern)
// ---------------------------------------------------------------------------
const AUTH_SECRET = process.env.AUTH_SECRET || 'siamshop-dev-auth-secret-change-me';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

if (!process.env.AUTH_SECRET) {
  console.warn('⚠️  AUTH_SECRET not set — using an insecure default. Set it in Railway before launch.');
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// Staff roles (SIAMSHOP-ELECTRON-001). The owner's password token is role
// 'admin' and can do everything; staff PIN tokens carry one of these roles.
// Non-manager staff are limited to the surfaces their job needs — the list
// is by path prefix so a new admin endpoint is closed to them by default.
const STAFF_ROLES = ['manager', 'cashier', 'prep'];
const ROLE_ALLOW = {
  cashier: [
    ['GET', /^\/api\/admin\/me$/], ['GET', /^\/api\/admin\/products$/], ['GET', /^\/api\/admin\/orders(\/|$)/],
    ['*', /^\/api\/sales(\/|$)/], ['*', /^\/api\/prep(\/|$)/], ['GET', /^\/api\/products\/lookup$/],
    ['*', /^\/api\/stock\/(receive|stocktake|goods-in-batch|scan-invoice|movements)$/], ['GET', /^\/api\/staff\/me$/],
    ['*', /^\/api\/till\/(\/|$)/], ['*', /^\/api\/till\/session(\/|$)/], ['GET', /^\/api\/till\/sessions(\/|$)/],
    ['POST', /^\/api\/admin\/orders\/\d+\/(ready|collected|dispatch|label-printed)$/],
  ],
  prep: [
    ['GET', /^\/api\/admin\/me$/], ['*', /^\/api\/prep(\/|$)/], ['GET', /^\/api\/staff\/me$/],
  ],
};
function roleAllows(role, method, path) {
  if (role === 'admin' || role === 'manager') return true;
  const rules = ROLE_ALLOW[role] || [];
  return rules.some(([m, re]) => (m === '*' || m === method) && re.test(path));
}

// Route gate for staff-only endpoints (till, prep, admin). Accepts the owner's
// password token (role admin) or a staff PIN token (manager | cashier | prep),
// then applies the role allow-list. Customer tokens are never accepted here.
async function requireAuth(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  const payload = m ? verifyToken(m[1]) : null;
  if (!payload || payload.role === 'customer' || payload.purpose === 'approve') {
    return res.status(401).json({ error: 'Not authenticated — please sign in again.' });
  }
  if (!roleAllows(payload.role, req.method, req.path)) {
    return res.status(403).json({ error: 'Your staff role cannot do that — ask a manager.' });
  }
  // Staff tokens are bound to the shop they signed in to (Krit, PR #1 review):
  // a cashier token from shop A must not act on shop B by changing ?shop=.
  // The owner's password token has no shop and keeps today's behaviour.
  if (payload.shop != null) {
    try {
      const shopId = await resolveShopId(req);
      if (!shopId || Number(shopId) !== Number(payload.shop)) {
        return res.status(403).json({ error: 'This sign-in belongs to a different shop.' });
      }
    } catch (e) {
      return res.status(500).json({ error: 'Could not verify shop' });
    }
  }
  req.auth = payload;
  next();
}

// Cheap O(1) PIN lookup (Krit, PR #1 review): HMAC(AUTH_SECRET, shop:pin) is
// stored beside the scrypt hash so sign-in finds one row instead of running
// scrypt over every staff member; scrypt still verifies the match.
function pinLookup(shopId, pin) {
  return crypto.createHmac('sha256', AUTH_SECRET).update(`${shopId}:${pin}`).digest('base64url');
}
// One-off manager APPROVAL tokens (SIAMSHOP-DISCOUNT-001 / Krit A1 review):
// a manager taps their PIN on the cashier's screen to approve ONE money action.
// The token is not a session: purpose='approve', 60 s TTL, single use (jti).
const APPROVAL_TTL_MS = 60 * 1000;
const _usedApprovals = new Map(); // jti → exp
function issueApproval(staff) {
  const jti = crypto.randomBytes(12).toString('base64url');
  const exp = Date.now() + APPROVAL_TTL_MS;
  return { token: signToken({ purpose: 'approve', role: staff.role, name: staff.name, sid: staff.sid || null, shop: staff.shop, jti, exp }), exp };
}
// Verify + consume. Returns { name, role } or throws httpError(403, …).
function consumeApproval(token, shopId) {
  const p = token ? verifyToken(token) : null;
  if (!p || p.purpose !== 'approve') throw httpError(403, 'Manager approval required');
  if (p.role !== 'manager' && p.role !== 'admin') throw httpError(403, 'Approval must come from a manager');
  if (p.shop != null && Number(p.shop) !== Number(shopId)) throw httpError(403, 'Approval belongs to a different shop');
  if (_usedApprovals.has(p.jti)) throw httpError(403, 'That approval was already used — ask the manager again');
  _usedApprovals.set(p.jti, p.exp);
  for (const [k, e] of _usedApprovals) if (e < Date.now()) _usedApprovals.delete(k); // sweep
  return { name: p.name || 'Owner', role: p.role };
}

// Manager/owner only (staff management, settings…). Use after requireAuth.
function requireManager(req, res, next) {
  if (req.auth?.role === 'admin' || req.auth?.role === 'manager') return next();
  return res.status(403).json({ error: 'Manager access required.' });
}

// Customer accounts (SIAMSHOP-006). Passwords hashed with scrypt (salt:hash).
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(pw), salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const calc = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  const a = Buffer.from(calc);
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Route gate for logged-in customers (token role=customer, carries cid).
function requireCustomer(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  const payload = m ? verifyToken(m[1]) : null;
  if (!payload || payload.role !== 'customer' || !payload.cid) {
    return res.status(401).json({ error: 'Please sign in to your account.' });
  }
  req.customer = payload;
  next();
}

// Small helper to throw an error that carries an HTTP status through a try/catch
// (used inside transactions so a failed line rolls the whole sale back).
// products.kind (SIAMSHOP-502): 'retail' = shelf stock, 'food' = made to order
// at the counter (shows on the prep screen, usually track_stock = FALSE).
const PRODUCT_KINDS = ['retail', 'food'];
function productKind(v) {
  return PRODUCT_KINDS.includes(v) ? v : 'retail';
}

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

// Resolve the shop for a request. For now the scaffold is single-tenant: it
// uses ?shop=<slug> or falls back to DEFAULT_SHOP_SLUG. Slug-based routing for
// real multi-shop is SIAMSHOP-010.
async function resolveShopId(req) {
  const slug = (req.query.shop || process.env.DEFAULT_SHOP_SLUG || 'demo').toString();
  return getShopIdBySlug(slug);
}

// Load a shop's settings as a plain { key: value } object.
async function getSettings(shopId) {
  const { rows } = await pool.query(`SELECT key, value FROM shop_settings WHERE shop_id = $1`, [shopId]);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// ---------------------------------------------------------------------------
// Opening hours + category availability (SIAMSHOP-503) and Click & Collect
// settings (SIAMSHOP-504), resolved once per request into a context object.
// ---------------------------------------------------------------------------
async function shopContext(shopId, settings) {
  const s = settings || (await getSettings(shopId));
  const { rows: cats } = await pool.query(
    `SELECT id, availability FROM categories WHERE shop_id = $1 AND availability IS NOT NULL`, [shopId]
  );
  const catRules = new Map();
  for (const c of cats) {
    const rules = availability.parseRules(c.availability);
    if (rules) catRules.set(c.id, rules);
  }
  return {
    settings: s,
    tz: s.timezone || availability.TZ_DEFAULT,
    hours: availability.parseOpeningHours(s.opening_hours),
    bankHolidays: availability.parseBankHolidays(s.bank_holidays),
    catRules,
    collectionEnabled: s.collection_enabled === 'true',
    leadMin: Number(s.pickup_lead_minutes) || 20,
    stepMin: Number(s.pickup_slot_minutes) || 15,
    collectionAddress: s.collection_address || '',
  };
}

// Add available_now / availability_text to product rows from their category's
// window. `at` defaults to now; pass the pickup time for pre-orders.
function annotateAvailability(rows, ctx, at = new Date()) {
  for (const r of rows) {
    const rules = r.category_id ? ctx.catRules.get(Number(r.category_id)) : null;
    r.available_now = availability.availableAt(rules, at, ctx.tz);
    r.availability_text = rules ? availability.describeRules(rules) : null;
  }
  return rows;
}

// Compute the delivery fee for a postcode against a shop's settings.
// Returns { zone, label, fee } or null for an invalid postcode.
function quoteDelivery(settings, postcode) {
  const zone = delivery.classifyZone(postcode);
  if (!zone) return null;
  const feeKey = { london: 'delivery_fee_london', mainland: 'delivery_fee_mainland', remote: 'delivery_fee_remote' }[zone];
  const fee = Number(settings[feeKey] ?? settings.delivery_fee_mainland ?? 0);
  return { zone, label: delivery.ZONE_LABELS[zone], fee };
}

// Upsert a customer by (shop, email) and return its id.
async function upsertCustomer(client, shopId, customer) {
  const email = String(customer?.email || '').trim().toLowerCase();
  if (!email) return null;
  const { rows } = await client.query(
    `INSERT INTO customers (shop_id, email, name, phone, marketing_consent)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (shop_id, email) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, customers.name),
       phone = COALESCE(EXCLUDED.phone, customers.phone),
       marketing_consent = EXCLUDED.marketing_consent
     RETURNING id`,
    [shopId, email, customer?.name || null, customer?.phone || null, Boolean(customer?.marketing_consent)]
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Product options (SIAMSHOP-501) — size / toppings / add-ons.
// ---------------------------------------------------------------------------

// Attach option_groups[] (each with options[]) to a list of product rows in ONE
// query. Inactive options are dropped, and a group left with no options is
// omitted so the picker never shows an empty question.
async function attachOptionGroups(rows, db = pool) {
  if (!rows || rows.length === 0) return rows;
  const ids = rows.map((r) => r.id);
  const { rows: groups } = await db.query(
    `SELECT g.id, g.product_id, g.name, g.name_th, g.min_select, g.max_select, g.sort_order,
            COALESCE(json_agg(json_build_object(
              'id', o.id, 'name', o.name, 'name_th', o.name_th,
              'price_delta', o.price_delta, 'is_default', o.is_default, 'sort_order', o.sort_order
            ) ORDER BY o.sort_order, o.id) FILTER (WHERE o.id IS NOT NULL), '[]') AS options
     FROM product_option_groups g
     LEFT JOIN product_options o ON o.group_id = g.id AND o.is_active = TRUE
     WHERE g.product_id = ANY($1::int[])
     GROUP BY g.id
     ORDER BY g.sort_order, g.id`,
    [ids]
  );
  const byProduct = new Map();
  for (const g of groups) {
    if (!g.options.length) continue;
    const list = byProduct.get(g.product_id) || [];
    list.push({ ...g, options: g.options.map((o) => ({ ...o, price_delta: Number(o.price_delta) })) });
    byProduct.set(g.product_id, list);
  }
  for (const r of rows) r.option_groups = byProduct.get(r.id) || [];
  return rows;
}

// Validate a basket line's chosen option ids against the product's groups and
// price them. Returns { snapshot: [{group, name, name_th, price_delta}] | null,
// total } where total is the per-unit add-on. Throws 400 on anything the client
// got wrong — the client never dictates a price (same rule as Stripe amounts).
async function resolveOptions(db, product, optionIds) {
  const ids = Array.isArray(optionIds)
    ? [...new Set(optionIds.map(Number).filter((n) => Number.isInteger(n)))]
    : [];
  const [withGroups] = await attachOptionGroups([{ id: product.id }], db);
  const groups = withGroups.option_groups;
  if (groups.length === 0) {
    if (ids.length) throw httpError(400, `${product.name} has no options`);
    return { snapshot: null, total: 0 };
  }
  const known = new Set();
  for (const g of groups) for (const o of g.options) known.add(o.id);
  for (const id of ids) if (!known.has(id)) throw httpError(400, `Invalid option for ${product.name}`);

  const snapshot = [];
  let total = 0;
  for (const g of groups) {
    const chosen = g.options.filter((o) => ids.includes(o.id));
    if (chosen.length < g.min_select) {
      throw httpError(400, `${product.name}: choose at least ${g.min_select} for ${g.name}`);
    }
    if (chosen.length > g.max_select) {
      throw httpError(400, `${product.name}: choose at most ${g.max_select} for ${g.name}`);
    }
    for (const o of chosen) {
      snapshot.push({ group: g.name, name: o.name, name_th: o.name_th || undefined, price_delta: o.price_delta });
      total += o.price_delta;
    }
  }
  return { snapshot, total: +total.toFixed(2) };
}

// "Large, Chilli Basil Pork, Fried Egg" — for Stripe line names, Messenger
// summaries and plain-text receipts. Empty string when no options.
function describeOptions(snapshot) {
  return (Array.isArray(snapshot) ? snapshot : []).map((o) => o.name).join(', ');
}
function itemLabel(it) {
  const opts = describeOptions(it.options_snapshot);
  return (it.name_snapshot || it.name) + (opts ? ` (${opts})` : '');
}

// Create a PENDING online order from a basket. Recomputes all prices and the
// delivery fee server-side (never trusts the client), enforces the minimum
// order, and writes order + items. Stock is NOT decremented here — that happens
// on fulfilment (payment confirmed). Shared by website checkout, bank transfer,
// and (later) the Messenger bot. Returns { orderId, subtotal, deliveryFee, total }.
async function createPendingOrder(client, shopId, body, { paymentMethod, source }) {
  const items = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0) throw httpError(400, 'Your basket is empty');

  const settings = await getSettings(shopId);
  const ctx = await shopContext(shopId, settings);
  const now = new Date();

  // Fulfilment (SIAMSHOP-504): collection needs a pickup slot and no address;
  // delivery keeps the postcode quote. Collection is only offered when enabled.
  const wantsCollection = body?.fulfilment === 'collection';
  if (wantsCollection && !ctx.collectionEnabled) throw httpError(400, 'Collection is not available for this shop');
  const fulfilment = wantsCollection ? 'collection' : 'delivery';
  let pickupAt = null;
  let quote = null;
  if (fulfilment === 'collection') {
    const raw = body?.pickup_at;
    if (raw === 'asap' || raw == null || raw === '') {
      pickupAt = new Date(now.getTime() + ctx.leadMin * 60 * 1000);
      if (!availability.isOpenAt(ctx.hours, pickupAt, ctx.tz, ctx.bankHolidays)) {
        const next = availability.nextOpening(ctx.hours, now, ctx.tz, ctx.bankHolidays);
        throw httpError(409, `We're closed right now${next ? ` — we open ${next}` : ''}. Choose a pickup time instead.`);
      }
    } else {
      const err = availability.validatePickup(raw, { hours: ctx.hours, now, tz: ctx.tz, bankHolidays: ctx.bankHolidays, leadMin: ctx.leadMin });
      if (err) throw httpError(400, err);
      pickupAt = new Date(raw);
    }
  } else {
    quote = quoteDelivery(settings, body?.postcode);
    if (!quote) throw httpError(400, 'Enter a valid UK postcode for delivery');
    // Shop closed (only when opening hours are configured) → not accepting
    // ASAP orders; scheduled collections above are the way round it.
    if (ctx.hours && !availability.isOpenAt(ctx.hours, now, ctx.tz, ctx.bankHolidays)) {
      const next = availability.nextOpening(ctx.hours, now, ctx.tz, ctx.bankHolidays);
      throw httpError(409, `Not accepting orders right now${next ? ` — we open ${next}` : ''}.`);
    }
  }
  // Menu windows (SIAMSHOP-503) are judged at the pickup time, so a 10:00
  // pre-order of lunch for 12:30 is fine.
  const availabilityAt = pickupAt || now;

  // Recompute subtotal from live prices (+ chosen options) and snapshot each line.
  let subtotal = 0;
  const lines = [];
  for (const it of items) {
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw httpError(400, 'Invalid quantity');
    const { rows } = await client.query(
      `SELECT id, name, price, category_id FROM products WHERE id = $1 AND shop_id = $2 AND is_active = TRUE`,
      [it.product_id, shopId]
    );
    const p = rows[0];
    if (!p) throw httpError(404, `Product ${it.product_id} is unavailable`);
    const rules = p.category_id ? ctx.catRules.get(Number(p.category_id)) : null;
    if (!availability.availableAt(rules, availabilityAt, ctx.tz)) {
      throw httpError(409, `${p.name} is only available ${availability.describeRules(rules)}`);
    }
    const { snapshot, total: optionsTotal } = await resolveOptions(client, p, it.option_ids);
    const lineTotal = +((Number(p.price) + optionsTotal) * qty).toFixed(2);
    subtotal += lineTotal;
    lines.push({ product: p, qty, lineTotal, snapshot, optionsTotal });
  }

  const minOrder = Number(settings.minimum_order_amount || 0);
  if (subtotal < minOrder) {
    throw httpError(400, `Minimum order is £${minOrder.toFixed(2)} (your items total £${subtotal.toFixed(2)})`);
  }

  const deliveryFee = quote ? quote.fee : 0;
  const total = subtotal + deliveryFee;
  const customerId = await upsertCustomer(client, shopId, body?.customer);

  const orderRes = await client.query(
    `INSERT INTO orders (shop_id, customer_id, channel, source, status, subtotal, delivery_fee, total,
                         payment_method, payment_status, delivery_address, notes, fulfilment, pickup_at)
     VALUES ($1,$2,'online',$3,'pending',$4,$5,$6,$7,'pending',$8,$9,$10,$11)
     RETURNING id, created_at`,
    [shopId, customerId, source, subtotal, deliveryFee, total, paymentMethod,
     fulfilment === 'delivery' ? body?.delivery_address || null : null, body?.notes || null,
     fulfilment, pickupAt]
  );
  const orderId = orderRes.rows[0].id;

  for (const ln of lines) {
    await client.query(
      `INSERT INTO order_items (order_id, product_id, name_snapshot, price_snapshot, qty, line_total,
                                options_snapshot, options_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [orderId, ln.product.id, ln.product.name, ln.product.price, ln.qty, ln.lineTotal,
       ln.snapshot ? JSON.stringify(ln.snapshot) : null, ln.optionsTotal]
    );
  }

  return {
    orderId, subtotal, deliveryFee, total, created_at: orderRes.rows[0].created_at,
    fulfilment, pickupAt,
    pickupLabel: pickupAt ? availability.labelFor(pickupAt, ctx.tz) : null,
    collectionAddress: ctx.collectionAddress,
  };
}

// Fulfil an order once payment is confirmed: decrement stock + write movements
// (reason online_sale), mark paid, and email the customer + shop. Idempotent —
// safe to call from the Stripe webhook, the success page, and admin mark-paid.
async function fulfilOrder(orderId, baseUrl) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const order = rows[0];
    if (!order) { await client.query('ROLLBACK'); return { ok: false, reason: 'not found' }; }
    if (order.payment_status === 'paid') { await client.query('ROLLBACK'); return { ok: true, already: true }; }

    const { rows: items } = await client.query(
      `SELECT oi.product_id, oi.name_snapshot, oi.price_snapshot, oi.qty, oi.line_total,
              oi.options_snapshot, oi.options_total, p.track_stock
       FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1`,
      [orderId]
    );
    for (const it of items) {
      // Made-to-order / untracked items (SIAMSHOP-502) never touch the ledger.
      if (!it.product_id || !it.track_stock) continue;
      await client.query(
        `UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2`,
        [it.qty, it.product_id]
      );
      await client.query(
        `INSERT INTO stock_movements (shop_id, product_id, change_qty, reason, ref_order_id)
         VALUES ($1,$2,$3,'online_sale',$4)`,
        [order.shop_id, it.product_id, -it.qty, orderId]
      );
    }
    await client.query(`UPDATE orders SET payment_status = 'paid' WHERE id = $1`, [orderId]);
    await client.query('COMMIT');

    // Emails are best-effort (don't fail the order if Brevo is down/unset).
    sendOrderEmails(order, items, baseUrl).catch((e) => console.warn('[email] order', orderId, e.message));
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[fulfilOrder]', err.message);
    return { ok: false, reason: err.message };
  } finally {
    client.release();
  }
}

// Build a website link that pre-fills the cart from matched Messenger items, so
// the customer completes delivery address + payment with the full website flow.
// Public site base URL. Prefer an explicit base (e.g. derived from the live
// request), then FRONTEND_URL, then Railway's auto-provided public domain, and
// finally localhost for dev. This keeps Messenger links pointing at the real site.
function publicBaseUrl(base) {
  if (base) return base.replace(/\/$/, '');
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return 'http://localhost:5173';
}

function buildCartLink(lines, base) {
  const frontend = publicBaseUrl(base);
  const compact = lines.map((l) => ({ id: l.product_id, qty: l.qty }));
  const b64 = Buffer.from(JSON.stringify(compact)).toString('base64url');
  return `${frontend}/cart?cart=${b64}&src=messenger`;
}

// Parse a customer's Messenger order message, price it, and reply with a summary
// + a ready-to-checkout link. This is the manual-bill-typing eliminator.
async function handleMessengerOrder(shopId, senderId, text, baseUrl) {
  const settings = await getSettings(shopId);
  const { rows: catalogue } = await pool.query(
    `SELECT id, name, name_th FROM products WHERE shop_id = $1 AND is_active = TRUE`,
    [shopId]
  );

  let parsed;
  try {
    parsed = await aiService.parseOrderItems(text, catalogue);
  } catch (e) {
    await messenger.sendMessage(senderId,
      "Sorry, I couldn't read that. Please send a list like: 2x Jasmine Rice 5kg, 1x Coconut Milk");
    return;
  }
  const th = parsed.language === 'th';

  // Price the matched items from live data.
  let subtotal = 0;
  const lines = [];
  for (const it of parsed.items) {
    const { rows } = await pool.query(
      `SELECT id, name, price FROM products WHERE id = $1 AND shop_id = $2 AND is_active = TRUE`,
      [it.product_id, shopId]
    );
    const p = rows[0];
    if (!p) continue;
    const qty = Math.max(1, Number(it.qty) || 1);
    const lineTotal = Number(p.price) * qty;
    subtotal += lineTotal;
    lines.push({ product_id: p.id, name: p.name, qty, lineTotal });
  }

  if (lines.length === 0) {
    await messenger.sendMessage(senderId, th
      ? 'ขออภัยค่ะ ไม่พบสินค้าที่ตรงกับรายการของคุณ ลองพิมพ์ชื่อสินค้าอีกครั้งนะคะ'
      : "Sorry, I couldn't match any items. Try product names, e.g. 2x Jasmine Rice 5kg, 1x Coconut Milk.");
    return;
  }

  const minOrder = Number(settings.minimum_order_amount || 0);
  const summary = lines.map((l) => `• ${l.name} × ${l.qty} — £${l.lineTotal.toFixed(2)}`).join('\n');
  let reply = (th ? 'นี่คือรายการสั่งซื้อของคุณค่ะ:\n' : "Here's your order:\n") +
    summary + '\n' + (th ? `รวม: £${subtotal.toFixed(2)}` : `Subtotal: £${subtotal.toFixed(2)}`);
  if (subtotal < minOrder) {
    reply += '\n' + (th
      ? `(ยอดสั่งซื้อขั้นต่ำ £${minOrder.toFixed(2)} — กรุณาเพิ่มสินค้าค่ะ)`
      : `(Minimum order is £${minOrder.toFixed(2)} — please add a little more.)`);
  }
  if (parsed.unmatched.length) {
    reply += '\n' + (th ? 'ไม่พบ: ' : "Couldn't find: ") + parsed.unmatched.join(', ');
  }
  reply += '\n\n' + (th ? 'ชำระเงินและกรอกที่อยู่จัดส่งที่นี่ค่ะ:\n' : 'Pay & enter delivery address here:\n') +
    buildCartLink(lines, baseUrl);

  await messenger.sendMessage(senderId, reply);
  console.log('[messenger] reply sent to', senderId, `(${lines.length} item(s), £${subtotal.toFixed(2)})`);
}

// Derive the public site origin from a request (Railway is behind a proxy),
// falling back to FRONTEND_URL. Used to build customer-facing links in emails.
function originFromReq(req) {
  if (!req) return process.env.FRONTEND_URL || '';
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `${proto}://${host}` : process.env.FRONTEND_URL || '';
}
// Public "check my order" link for emails (carries the email so the link works
// without the customer re-typing it; tracking requires order# + matching email).
function orderStatusUrl(base, orderId, email) {
  const b = (base || process.env.FRONTEND_URL || '').replace(/\/$/, '');
  if (!b) return null;
  const e = email ? `&email=${encodeURIComponent(email)}` : '';
  return `${b}/order/status?order=${orderId}${e}`;
}

// Look up a paid order's customer email + shop name (for lifecycle emails).
async function orderEmailContext(order) {
  const { rows: shopRows } = await pool.query(`SELECT name FROM shops WHERE id = $1`, [order.shop_id]);
  const shopName = shopRows[0]?.name || 'SiamShop';
  const { rows: custRows } = order.customer_id
    ? await pool.query(`SELECT email FROM customers WHERE id = $1`, [order.customer_id])
    : { rows: [] };
  return { shopName, customerEmail: custRows[0]?.email };
}

// Send the customer receipt + shop-owner notification for a paid order.
async function sendOrderEmails(order, items, baseUrl) {
  const { shopName, customerEmail } = await orderEmailContext(order);
  const settings = await getSettings(order.shop_id);
  const payload = {
    id: order.id,
    subtotal: order.subtotal,
    delivery_fee: order.delivery_fee,
    total: order.total,
    delivery_address: order.delivery_address,
    notes: order.notes,
    fulfilment: order.fulfilment,
    pickup_label: order.pickup_at ? availability.labelFor(order.pickup_at, settings.timezone || availability.TZ_DEFAULT) : null,
    collection_address: settings.collection_address || '',
    items,
  };
  const statusUrl = orderStatusUrl(baseUrl, order.id, customerEmail);
  if (customerEmail) await emailService.sendOrderConfirmation(customerEmail, shopName, payload, statusUrl);
  if (settings.shop_email) await emailService.sendShopNotification(settings.shop_email, shopName, payload);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  let db = 'down';
  try {
    await pool.query('SELECT 1');
    db = 'ok';
  } catch {
    db = 'down';
  }
  res.json({
    service: 'siamshop',
    status: 'ok',
    db,
    stripe: stripeService.isConfigured() ? 'configured' : 'unconfigured',
    time: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------------
// Scaffold login: a single shared owner password → admin token. Per-staff
// accounts come later. Uses a constant-time compare to avoid timing leaks.
app.post('/api/admin/login', authLimiter, (req, res) => {
  const password = String(req.body?.password || '');
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected) {
    return res.status(503).json({ error: 'Admin login is not configured (ADMIN_PASSWORD unset).' });
  }
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const token = signToken({ role: 'admin', exp: Date.now() + TOKEN_TTL_MS });
  res.json({ token, role: 'admin', expiresAt: Date.now() + TOKEN_TTL_MS });
});

// Lightweight check the client can use to validate a stored token.
app.get('/api/admin/me', requireAuth, (req, res) => {
  res.json({ role: req.auth.role, name: req.auth.name || (req.auth.role === 'admin' ? 'Owner' : null), sid: req.auth.sid || null, expiresAt: req.auth.exp });
});

// ---------------------------------------------------------------------------
// Staff PIN sign-in (SIAMSHOP-ELECTRON-001)
// ---------------------------------------------------------------------------
const PIN_RE = /^\d{4,6}$/;

// PIN → token. PINs are unique per shop (enforced on create), so the pad needs
// no name grid: type the PIN, we find who it is. Rate-limited like admin login.
app.post('/api/staff/login', pinLimiter, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const pin = String(req.body?.pin || '');
    if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'Enter your 4–6 digit PIN' });
    const { rows } = await pool.query(
      `SELECT id, name, pin_hash, role FROM staff
       WHERE shop_id = $1 AND active = TRUE AND (pin_lookup = $2 OR pin_lookup IS NULL)`,
      [shopId, pinLookup(shopId, pin)]
    );
    const hit = rows.find((s) => verifyPassword(pin, s.pin_hash));
    if (!hit) return res.status(401).json({ error: 'PIN not recognised' });
    await pool.query(`UPDATE staff SET last_login_at = NOW(), pin_lookup = COALESCE(pin_lookup, $2) WHERE id = $1`, [hit.id, pinLookup(shopId, pin)]);
    const exp = Date.now() + TOKEN_TTL_MS;
    // shop is bound into the token — requireAuth rejects use against another shop.
    const token = signToken({ role: hit.role, name: hit.name, sid: hit.id, shop: shopId, exp });
    res.json({ token, role: hit.role, name: hit.name, sid: hit.id, expiresAt: exp });
  } catch (err) {
    console.error('[staff/login]', err.message);
    res.status(500).json({ error: 'Sign-in failed' });
  }
});
// Manager PIN → one-off approval token (60 s, single use). Owner password also works via /api/admin/login? No —
// approvals always go through this endpoint so they are short-lived and single-use.
app.post('/api/staff/approve', pinLimiter, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const pin = String(req.body?.pin || '');
    const password = String(req.body?.password || '');
    let who = null;
    if (password) {
      const expected = process.env.ADMIN_PASSWORD || '';
      const a = Buffer.from(password), b = Buffer.from(expected);
      if (expected && a.length === b.length && crypto.timingSafeEqual(a, b)) who = { role: 'admin', name: 'Owner', shop: shopId };
    } else {
      if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'Enter the manager PIN' });
      const { rows } = await pool.query(
        `SELECT id, name, pin_hash, role FROM staff WHERE shop_id = $1 AND active = TRUE AND (pin_lookup = $2 OR pin_lookup IS NULL)`,
        [shopId, pinLookup(shopId, pin)]
      );
      const hit = rows.find((s) => verifyPassword(pin, s.pin_hash));
      if (hit) who = { role: hit.role, name: hit.name, sid: hit.id, shop: shopId };
    }
    if (!who) return res.status(401).json({ error: 'PIN not recognised' });
    if (who.role !== 'manager' && who.role !== 'admin') return res.status(403).json({ error: 'That PIN is not a manager' });
    const { token, exp } = issueApproval(who);
    res.json({ token, name: who.name, role: who.role, expiresAt: exp, ttl_ms: APPROVAL_TTL_MS });
  } catch (err) {
    console.error('[staff/approve]', err.message);
    res.status(500).json({ error: 'Approval failed' });
  }
});
app.get('/api/staff/me', requireAuth, (req, res) => {
  res.json({ role: req.auth.role, name: req.auth.name || 'Owner', sid: req.auth.sid || null, expiresAt: req.auth.exp });
});

// ---------------------------------------------------------------------------
// Clock in/out (SIAMSHOP-CLOCK-001). One button on the PIN pad: the server
// looks at the person's LAST event and records the opposite. Timesheets pair
// in→out client-side (shared client/src/timesheet.js) so the maths is testable.
// ---------------------------------------------------------------------------
const CLOCK_DEBOUNCE_MS = 60 * 1000;
app.post('/api/clock/toggle', pinLimiter, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const pin = String(req.body?.pin || '');
    if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'Enter your 4–6 digit PIN' });
    const { rows } = await pool.query(
      `SELECT id, name, pin_hash FROM staff WHERE shop_id = $1 AND active = TRUE AND (pin_lookup = $2 OR pin_lookup IS NULL)`,
      [shopId, pinLookup(shopId, pin)]
    );
    const hit = rows.find((s) => verifyPassword(pin, s.pin_hash));
    if (!hit) return res.status(401).json({ error: 'PIN not recognised' });
    const last = await pool.query(
      `SELECT event_type, event_at FROM clock_events WHERE staff_id = $1 ORDER BY event_at DESC, id DESC LIMIT 1`, [hit.id]
    );
    // Debounce (Krit, PR #4): a double tap inside 60 s must not flip in→out —
    // that leaves a 0-minute shift and someone who thinks they're clocked in.
    // Return the existing event instead so the card says "Already clocked IN".
    if (last.rows[0] && Date.now() - new Date(last.rows[0].event_at).getTime() < CLOCK_DEBOUNCE_MS) {
      return res.json({ ok: true, repeated: true, staff_id: hit.id, name: hit.name, event_type: last.rows[0].event_type, event_at: last.rows[0].event_at });
    }
    const next = last.rows[0]?.event_type === 'in' ? 'out' : 'in';
    const { rows: ev } = await pool.query(
      `INSERT INTO clock_events (shop_id, staff_id, event_type) VALUES ($1,$2,$3) RETURNING event_at`, [shopId, hit.id, next]
    );
    res.json({ ok: true, repeated: false, staff_id: hit.id, name: hit.name, event_type: next, event_at: ev[0].event_at });
  } catch (err) {
    console.error('[clock/toggle]', err.message);
    res.status(500).json({ error: 'Clock in/out failed' });
  }
});
// Who is clocked in right now (latest event = in). Manager/owner.
app.get('/api/clock/status', requireAuth, requireManager, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.role, ce.event_at AS clocked_in_at
       FROM staff s JOIN clock_events ce ON ce.id = (
         SELECT id FROM clock_events WHERE staff_id = s.id ORDER BY event_at DESC, id DESC LIMIT 1)
       WHERE s.shop_id = $1 AND ce.event_type = 'in' ORDER BY s.name`, [shopId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[clock/status]', err.message);
    res.status(500).json({ error: 'Failed to load clock status' });
  }
});
// Raw events in a window (inclusive dates, shop-local). Manager/owner.
app.get('/api/clock/records', requireAuth, requireManager, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const from = String(req.query.from || '1970-01-01');
    const to = String(req.query.to || '2999-12-31');
    const { rows } = await pool.query(
      `SELECT ce.id, ce.staff_id, s.name AS staff_name, s.role AS staff_role, ce.event_type, ce.event_at
       FROM clock_events ce JOIN staff s ON s.id = ce.staff_id
       WHERE ce.shop_id = $1 AND ce.event_at >= $2::date AND ce.event_at < ($3::date + interval '1 day')
       ORDER BY ce.staff_id, ce.event_at, ce.id`, [shopId, from, to]
    );
    res.json(rows);
  } catch (err) {
    console.error('[clock/records]', err.message);
    res.status(500).json({ error: 'Failed to load clock records' });
  }
});

// Staff management — owner or manager only.
app.get('/api/admin/staff', requireAuth, requireManager, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `SELECT id, name, role, active, created_at, last_login_at FROM staff WHERE shop_id = $1 ORDER BY active DESC, name`, [shopId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[admin/staff]', err.message);
    res.status(500).json({ error: 'Failed to load staff' });
  }
});
// A PIN must be unique within the shop — otherwise the pad can't tell two
// people apart. Compares against every active hash (small list).
async function pinTaken(shopId, pin, exceptId = null) {
  const { rows } = await pool.query(
    `SELECT id, pin_hash, pin_lookup FROM staff WHERE shop_id = $1 AND (pin_lookup = $2 OR pin_lookup IS NULL)`,
    [shopId, pinLookup(shopId, pin)]
  );
  return rows.some((s) => s.id !== exceptId && (s.pin_lookup ? true : verifyPassword(pin, s.pin_hash)));
}
app.post('/api/admin/staff', requireAuth, requireManager, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const name = String(req.body?.name || '').trim();
    const pin = String(req.body?.pin || '');
    const role = STAFF_ROLES.includes(req.body?.role) ? req.body.role : 'cashier';
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'PIN must be 4–6 digits' });
    if (await pinTaken(shopId, pin)) return res.status(409).json({ error: 'That PIN is already in use — choose another' });
    const { rows } = await pool.query(
      `INSERT INTO staff (shop_id, name, pin_hash, pin_lookup, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, role, active, created_at`,
      [shopId, name, hashPassword(pin), pinLookup(shopId, pin), role]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That PIN is already in use — choose another' });
    console.error('[admin/staff POST]', err.message);
    res.status(500).json({ error: 'Failed to add staff' });
  }
});
app.put('/api/admin/staff/:id', requireAuth, requireManager, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const id = Number(req.params.id);
    const { name, role, active, pin } = req.body || {};
    if (pin != null && pin !== '') {
      if (!PIN_RE.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4–6 digits' });
      if (await pinTaken(shopId, String(pin), id)) return res.status(409).json({ error: 'That PIN is already in use — choose another' });
    }
    const { rows } = await pool.query(
      `UPDATE staff SET name = COALESCE($3, name), role = COALESCE($4, role), active = COALESCE($5, active),
              pin_hash = COALESCE($6, pin_hash), pin_lookup = COALESCE($7, pin_lookup)
       WHERE id = $1 AND shop_id = $2 RETURNING id, name, role, active, created_at, last_login_at`,
      [id, shopId, name != null ? String(name).trim() : null, STAFF_ROLES.includes(role) ? role : null,
       active != null ? Boolean(active) : null, pin ? hashPassword(String(pin)) : null, pin ? pinLookup(shopId, String(pin)) : null]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Staff member not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That PIN is already in use — choose another' });
    console.error('[admin/staff PUT]', err.message);
    res.status(500).json({ error: 'Failed to update staff' });
  }
});
app.delete('/api/admin/staff/:id', requireAuth, requireManager, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rowCount } = await pool.query(`DELETE FROM staff WHERE id = $1 AND shop_id = $2`, [req.params.id, shopId]);
    if (!rowCount) return res.status(404).json({ error: 'Staff member not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/staff DELETE]', err.message);
    res.status(500).json({ error: 'Failed to remove staff' });
  }
});

// ---------------------------------------------------------------------------
// Public storefront
// ---------------------------------------------------------------------------
app.get('/api/shop', async (req, res) => {
  try {
    const slug = (req.query.shop || process.env.DEFAULT_SHOP_SLUG || 'demo').toString();
    const { rows } = await pool.query(
      `SELECT id, name, slug FROM shops WHERE slug = $1`,
      [slug]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Shop not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[shop]', err.message);
    res.status(500).json({ error: 'Failed to load shop' });
  }
});

// Public shop settings the storefront needs (min order, delivery fees, restock).
app.get('/api/settings', async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const s = await getSettings(shopId);
    const ctx = await shopContext(shopId, s);
    const now = new Date();
    res.json({
      minimum_order_amount: Number(s.minimum_order_amount || 0),
      delivery_fee_london: Number(s.delivery_fee_london || 0),
      delivery_fee_mainland: Number(s.delivery_fee_mainland || 0),
      delivery_fee_remote: Number(s.delivery_fee_remote || 0),
      restock_day: s.restock_day || null,
      currency: s.currency || 'GBP',
      shop_language_default: s.shop_language_default || 'en',
      // SIAMSHOP-DISCOUNT-001 — the till needs the reasons list + approval thresholds.
      discount_reasons: discountRules(s).reasons,
      discount_pin_threshold_amount: discountRules(s).thresholdAmount,
      discount_pin_threshold_percent: discountRules(s).thresholdPercent,
      // SIAMSHOP-RECEIPT-001 — printed on every till receipt (not secrets).
      receipt_header: s.receipt_header || '',
      receipt_footer: s.receipt_footer || '',
      vat_number: s.vat_number || '',
      receipt_copies: Math.min(3, Math.max(1, parseInt(s.receipt_copies, 10) || 1)),
      // SIAMSHOP-503/504 — hours + collection (null hours = always open).
      timezone: ctx.tz,
      opening_hours: ctx.hours,
      open_now: availability.isOpenAt(ctx.hours, now, ctx.tz, ctx.bankHolidays),
      next_open: ctx.hours ? availability.nextOpening(ctx.hours, now, ctx.tz, ctx.bankHolidays) : null,
      collection_enabled: ctx.collectionEnabled,
      collection_address: ctx.collectionAddress,
      pickup_lead_minutes: ctx.leadMin,
      pickup_slot_minutes: ctx.stepMin,
    });
  } catch (err) {
    console.error('[settings]', err.message);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// Public category list (ordered).
app.get('/api/categories', async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `SELECT id, name, name_th, sort_order, availability FROM categories WHERE shop_id = $1 ORDER BY sort_order, name`,
      [shopId]
    );
    const ctx = await shopContext(shopId);
    const now = new Date();
    for (const c of rows) {
      const rules = availability.parseRules(c.availability);
      c.availability = rules ? { rules } : null;
      c.available_now = availability.availableAt(rules, now, ctx.tz);
      c.availability_text = rules ? availability.describeRules(rules) : null;
    }
    res.json(rows);
  } catch (err) {
    console.error('[categories]', err.message);
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

// Click & Collect pickup slots (SIAMSHOP-504) — today + tomorrow, inside
// opening hours, from now + lead time. Empty when collection is off.
app.get('/api/pickup-slots', async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const ctx = await shopContext(shopId);
    if (!ctx.collectionEnabled) return res.json({ enabled: false, asap: false, slots: [] });
    const now = new Date();
    const asapAt = new Date(now.getTime() + ctx.leadMin * 60 * 1000);
    res.json({
      enabled: true,
      asap: availability.isOpenAt(ctx.hours, asapAt, ctx.tz, ctx.bankHolidays),
      asap_label: `ASAP (about ${ctx.leadMin} min)`,
      slots: availability.pickupSlots({ hours: ctx.hours, now, tz: ctx.tz, bankHolidays: ctx.bankHolidays, leadMin: ctx.leadMin, stepMin: ctx.stepMin }),
      collection_address: ctx.collectionAddress,
    });
  } catch (err) {
    console.error('[pickup-slots]', err.message);
    res.status(500).json({ error: 'Failed to load pickup slots' });
  }
});

// Delivery quote for a postcode.
app.post('/api/delivery-quote', async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const settings = await getSettings(shopId);
    const quote = quoteDelivery(settings, req.body?.postcode);
    if (!quote) return res.status(400).json({ error: 'Enter a valid UK postcode' });
    res.json(quote);
  } catch (err) {
    console.error('[delivery-quote]', err.message);
    res.status(500).json({ error: 'Failed to quote delivery' });
  }
});

// AI shopping assistant — bilingual chat over the live in-stock catalogue; can
// propose products to add to the basket (recipe → ingredients) and is aware of
// what's already in the customer's basket so it won't add duplicates.
app.post('/api/assistant', lookupLimiter, async (req, res) => {
  try {
    if (!assistant.isConfigured()) {
      return res.status(503).json({ error: 'The assistant is not available right now.' });
    }
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });

    const { rows: products } = await pool.query(
      `SELECT p.id, p.name, p.name_th, p.price, p.stock_qty, p.track_stock, c.name AS category
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.shop_id = $1 AND p.is_active = TRUE
         AND (p.track_stock = FALSE OR p.stock_qty > 0)   -- in-stock only
       ORDER BY c.sort_order NULLS LAST, p.name`,
      [shopId]
    );
    const settings = await getSettings(shopId);
    const { rows: shopRows } = await pool.query(`SELECT name FROM shops WHERE id = $1`, [shopId]);
    const shopName = shopRows[0]?.name || 'SiamShop';
    const basket = Array.isArray(req.body?.basket) ? req.body.basket : [];
    const { reply, add } = await assistant.chat({ messages: req.body?.messages, products, settings, shopName, basket });

    const inBasket = new Set(basket.map((b) => Number(b.id ?? b.product_id)).filter(Boolean));
    const byId = new Map(products.map((p) => [p.id, p]));
    const items = add
      .filter((a) => !inBasket.has(a.product_id))
      .map((a) => {
        const p = byId.get(a.product_id);
        return { id: p.id, product_id: a.product_id, qty: a.qty, name: p.name, name_th: p.name_th, price: Number(p.price) };
      });
    // Items with option groups (size/toppings) open the picker client-side.
    await attachOptionGroups(items);
    res.json({ reply, add: items });
  } catch (err) {
    console.error('[assistant]', err.message);
    res.status(500).json({ error: 'The assistant had a problem — please try again.' });
  }
});

// "Notify me when back in stock" capture (SIAMSHOP-010).
app.post('/api/products/:id/notify', async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const email = String(req.body?.email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
    const { rows } = await pool.query(`SELECT id FROM products WHERE id = $1 AND shop_id = $2`, [req.params.id, shopId]);
    if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
    await pool.query(
      `INSERT INTO stock_notifications (shop_id, product_id, email)
       VALUES ($1,$2,$3) ON CONFLICT (product_id, email) DO NOTHING`,
      [shopId, req.params.id, email]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[notify]', err.message);
    res.status(500).json({ error: 'Failed to register' });
  }
});

// Card checkout — create a pending order + a Stripe Checkout Session (test mode).
// Returns { url } to redirect to. If Stripe isn't configured, url is null and the
// order is left pending (the shop can still see it).
app.post('/api/checkout/session', async (req, res) => {
  const shopId = await resolveShopId(req);
  if (!shopId) return res.status(404).json({ error: 'Shop not found' });
  const slug = (req.query.shop || process.env.DEFAULT_SHOP_SLUG || 'demo').toString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = await createPendingOrder(client, shopId, req.body, { paymentMethod: 'stripe', source: 'website' });
    await client.query('COMMIT');

    if (!stripeService.isConfigured()) {
      return res.json({ url: null, order_id: order.orderId, message: 'Card payments not configured yet — order saved as pending.' });
    }
    // Build the redirect base from where the request actually came from
    // (Railway is behind a proxy, so honour x-forwarded-*).
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = host ? `${proto}://${host}` : undefined;

    const session = await stripeService.createCheckoutSession({
      orderId: order.orderId,
      shopSlug: slug,
      origin,
      lineItems: (await pool.query(
        `SELECT name_snapshot, price_snapshot, options_snapshot, options_total, qty
         FROM order_items WHERE order_id = $1`,
        [order.orderId]
      )).rows.map((r) => ({
        name: itemLabel(r),
        amount_pence: Math.round((Number(r.price_snapshot) + Number(r.options_total || 0)) * 100),
        qty: r.qty,
      })),
      deliveryFeePence: Math.round(order.deliveryFee * 100),
      customerEmail: req.body?.customer?.email,
    });
    await pool.query(`UPDATE orders SET stripe_payment_intent_id = $1 WHERE id = $2`, [session.id, order.orderId]);
    res.json({ url: session.url, order_id: order.orderId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('[checkout/session]', err.message);
    res.status(500).json({ error: 'Checkout failed' });
  } finally {
    client.release();
  }
});

// Unified order creation for non-card payment (bank transfer) — also the entry
// point the Messenger bot (SIAMSHOP-011) will call. Creates a pending order.
app.post('/api/orders', async (req, res) => {
  const shopId = await resolveShopId(req);
  if (!shopId) return res.status(404).json({ error: 'Shop not found' });
  const source = ['website', 'messenger', 'manual'].includes(req.body?.source) ? req.body.source : 'website';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = await createPendingOrder(client, shopId, req.body, { paymentMethod: 'bank_transfer', source });
    await client.query('COMMIT');
    const settings = await getSettings(shopId);
    const bankDetails = settings.bank_details || '';
    res.status(201).json({
      order_id: order.orderId,
      total: order.total,
      bank_instructions:
        (bankDetails ? bankDetails + '\n\n' : '') +
        `Please transfer £${order.total.toFixed(2)} and quote order #${order.orderId} as the reference. Your order will be dispatched once payment is confirmed.`,
    });

    // Email the customer the bank details + reference (best-effort).
    (async () => {
      try {
        const email = req.body?.customer?.email;
        if (!email) return;
        const { rows: shopRows } = await pool.query(`SELECT name FROM shops WHERE id = $1`, [shopId]);
        const { rows: items } = await pool.query(
          `SELECT name_snapshot, qty, line_total, options_snapshot FROM order_items WHERE order_id = $1`,
          [order.orderId]
        );
        await emailService.sendBankTransferInstructions(
          email,
          shopRows[0]?.name || 'SiamShop',
          { id: order.orderId, total: order.total, items,
            delivery_address: order.fulfilment === 'delivery' ? req.body?.delivery_address : null,
            fulfilment: order.fulfilment, pickup_label: order.pickupLabel, collection_address: order.collectionAddress },
          bankDetails,
          orderStatusUrl(originFromReq(req), order.orderId, email)
        );
      } catch (e) {
        console.warn('[email] bank transfer', e.message);
      }
    })();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('[orders POST]', err.message);
    res.status(500).json({ error: 'Failed to create order' });
  } finally {
    client.release();
  }
});

// Public order summary — requires the order number AND the matching customer
// email (so customers can only see their own order, not guess numbers). Also
// lazily fulfils a paid-but-unconfirmed Stripe order (idempotent).
app.get('/api/orders/:id', lookupLimiter, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const provided = String(req.query.email || '').trim().toLowerCase();
    let { rows } = await pool.query(
      `SELECT o.id, o.status, o.payment_status, o.payment_method, o.subtotal, o.delivery_fee, o.total,
              o.delivery_address, o.stripe_payment_intent_id, o.tracking_number, o.carrier, o.created_at,
              o.fulfilment, o.pickup_at, o.ready_at,
              c.email AS customer_email
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.id = $1 AND o.shop_id = $2`,
      [req.params.id, shopId]
    );
    let order = rows[0];
    // Same 404 whether the order is missing or the email doesn't match — don't
    // reveal which orders exist.
    if (!order || !order.customer_email || provided !== order.customer_email.toLowerCase()) {
      return res.status(404).json({ error: 'Order not found — check the order number and email.' });
    }

    if (order.payment_status === 'pending' && order.payment_method === 'stripe' &&
        order.stripe_payment_intent_id && stripeService.isConfigured()) {
      try {
        const session = await stripeService.retrieveSession(order.stripe_payment_intent_id);
        if (session && session.payment_status === 'paid') {
          await fulfilOrder(order.id, originFromReq(req));
          ({ rows } = await pool.query(
            `SELECT id, status, payment_status, payment_method, subtotal, delivery_fee, total,
                    delivery_address, tracking_number, carrier, created_at, fulfilment, pickup_at, ready_at
             FROM orders WHERE id = $1`,
            [order.id]
          ));
          order = { ...rows[0], customer_email: order.customer_email };
        }
      } catch (e) {
        console.warn('[orders GET] stripe confirm', e.message);
      }
    }

    delete order.customer_email; // never expose the email in the response
    const { rows: items } = await pool.query(
      `SELECT name_snapshot, price_snapshot, qty, line_total, options_snapshot, options_total
       FROM order_items WHERE order_id = $1`,
      [order.id]
    );
    const carrier_tracking_url = carriers.trackingUrl(order.carrier, order.tracking_number);
    const carrier_name = order.tracking_number ? carriers.nameOf(order.carrier) : null;
    let collection_address = null;
    let pickup_label = null;
    if (order.fulfilment === 'collection') {
      const s = await getSettings(shopId);
      collection_address = s.collection_address || null;
      pickup_label = order.pickup_at ? availability.labelFor(order.pickup_at, s.timezone || availability.TZ_DEFAULT) : null;
    }
    res.json({ ...order, items, carrier_tracking_url, carrier_name, collection_address, pickup_label });
  } catch (err) {
    console.error('[orders GET]', err.message);
    res.status(500).json({ error: 'Failed to load order' });
  }
});

// ---------------------------------------------------------------------------
// Customer accounts (SIAMSHOP-006)
// ---------------------------------------------------------------------------
app.post('/api/account/register', authLimiter, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const { rows: ex } = await pool.query(
      `SELECT id, password_hash FROM customers WHERE shop_id = $1 AND email = $2`, [shopId, email]
    );
    let cid;
    if (ex[0]) {
      if (ex[0].password_hash) return res.status(409).json({ error: 'An account already exists for this email — please log in.' });
      // Existing customer (from a past order) claiming their account.
      ({ rows: [{ id: cid }] } = await pool.query(
        `UPDATE customers SET password_hash = $3, name = COALESCE($4, name), phone = COALESCE($5, phone),
                marketing_consent = $6 WHERE id = $1 AND shop_id = $2 RETURNING id`,
        [ex[0].id, shopId, hashPassword(password), req.body?.name || null, req.body?.phone || null, Boolean(req.body?.marketing_consent)]
      ));
    } else {
      ({ rows: [{ id: cid }] } = await pool.query(
        `INSERT INTO customers (shop_id, email, name, phone, marketing_consent, password_hash)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [shopId, email, req.body?.name || null, req.body?.phone || null, Boolean(req.body?.marketing_consent), hashPassword(password)]
      ));
    }
    const token = signToken({ role: 'customer', cid, exp: Date.now() + TOKEN_TTL_MS });
    const { rows: prof } = await pool.query(
      `SELECT id, name, email, phone, marketing_consent FROM customers WHERE id = $1`, [cid]
    );
    res.status(201).json({ token, customer: prof[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account already exists for this email — please log in.' });
    console.error('[account/register]', err.message);
    res.status(500).json({ error: 'Could not create account' });
  }
});

app.post('/api/account/login', authLimiter, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const { rows } = await pool.query(
      `SELECT id, password_hash FROM customers WHERE shop_id = $1 AND email = $2`, [shopId, email]
    );
    const c = rows[0];
    if (!c || !verifyPassword(password, c.password_hash)) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    const token = signToken({ role: 'customer', cid: c.id, exp: Date.now() + TOKEN_TTL_MS });
    const { rows: prof } = await pool.query(
      `SELECT id, name, email, phone, marketing_consent FROM customers WHERE id = $1`, [c.id]
    );
    res.json({ token, customer: prof[0] });
  } catch (err) {
    console.error('[account/login]', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/account', requireCustomer, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.email, c.phone, c.marketing_consent, c.created_at,
              (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id)::int AS order_count,
              (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.customer_id = c.id AND o.payment_status='paid')::numeric AS total_spent
       FROM customers c WHERE c.id = $1`, [req.customer.cid]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Account not found' });
    res.json({ ...rows[0], total_spent: Number(rows[0].total_spent) });
  } catch (err) {
    console.error('[account GET]', err.message);
    res.status(500).json({ error: 'Failed to load account' });
  }
});

app.put('/api/account', requireCustomer, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE customers SET name = COALESCE($2, name), phone = $3,
              marketing_consent = COALESCE($4, marketing_consent)
       WHERE id = $1 RETURNING id, name, email, phone, marketing_consent`,
      [req.customer.cid, req.body?.name != null ? String(req.body.name) : null,
       req.body?.phone ?? null, req.body?.marketing_consent != null ? Boolean(req.body.marketing_consent) : null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[account PUT]', err.message);
    res.status(500).json({ error: 'Failed to update account' });
  }
});

app.get('/api/account/orders', requireCustomer, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, status, payment_status, payment_method, total, created_at, tracking_number, carrier
       FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 100`, [req.customer.cid]
    );
    res.json(rows);
  } catch (err) {
    console.error('[account/orders]', err.message);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// Public product listing — active products only, optional category/search.
app.get('/api/products', async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });

    const params = [shopId];
    let sql = `SELECT p.id, p.name, p.name_th, p.description, p.description_th, p.price,
                      p.stock_qty, p.track_stock, p.kind, p.image_url, p.weight_grams,
                      p.category_id, c.name AS category, c.name_th AS category_th
               FROM products p
               LEFT JOIN categories c ON c.id = p.category_id
               WHERE p.shop_id = $1 AND p.is_active = TRUE`;
    if (req.query.category_id) {
      params.push(req.query.category_id);
      sql += ` AND p.category_id = $${params.length}`;
    }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      sql += ` AND (p.name ILIKE $${params.length} OR p.name_th ILIKE $${params.length})`;
    }
    sql += ` ORDER BY c.sort_order NULLS LAST, p.sort_order, p.name`;
    const { rows } = await pool.query(sql, params);
    annotateAvailability(rows, await shopContext(shopId));
    res.json(await attachOptionGroups(rows));
  } catch (err) {
    console.error('[products]', err.message);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// Look up a product by barcode (or SKU) for the till — staff only. MUST be
// declared before "/api/products/:id" or the :id matcher swallows "lookup".
app.get('/api/products/lookup', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const code = String(req.query.barcode || req.query.code || '').trim();
    if (!code) return res.status(400).json({ error: 'barcode is required' });
    const { rows } = await pool.query(
      `SELECT id, name, name_th, barcode, sku, unit, price, stock_qty, track_stock, kind
       FROM products
       WHERE shop_id = $1 AND is_active = TRUE AND (barcode = $2 OR sku = $2)
       LIMIT 1`,
      [shopId, code]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No product with that barcode' });
    res.json((await attachOptionGroups(rows))[0]);
  } catch (err) {
    console.error('[products/lookup]', err.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.name_th, p.description, p.description_th, p.price, p.stock_qty,
              p.track_stock, p.kind, p.image_url, p.category_id, c.name AS category, c.name_th AS category_th
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = $1 AND p.shop_id = $2 AND p.is_active = TRUE`,
      [req.params.id, shopId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
    annotateAvailability(rows, await shopContext(shopId));
    res.json((await attachOptionGroups(rows))[0]);
  } catch (err) {
    console.error('[product]', err.message);
    res.status(500).json({ error: 'Failed to load product' });
  }
});

// ---------------------------------------------------------------------------
// Product photos (SIAMSHOP-410) — captured in the back office, stored in-DB,
// served here. Public read; write is admin-only and shop-scoped.
// ---------------------------------------------------------------------------

// Serve a product photo. Registered before express.static so /img/... resolves
// to bytes, not the SPA shell. ETag from image_updated_at → cheap revalidation.
app.get('/img/product/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT image_data, image_mime, image_updated_at FROM products WHERE id = $1`,
      [req.params.id]
    );
    const row = rows[0];
    if (!row || !row.image_data) return res.status(404).end();
    const etag = row.image_updated_at ? `"${new Date(row.image_updated_at).getTime()}"` : undefined;
    if (etag && req.get('if-none-match') === etag) return res.status(304).end();
    res.set('Content-Type', row.image_mime || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=60, must-revalidate');
    if (etag) res.set('ETag', etag);
    res.send(row.image_data);
  } catch (err) {
    console.error('[img/product]', err.message);
    res.status(500).end();
  }
});

// Upload / replace a product photo. Body: { dataUrl: "data:image/jpeg;base64,…" }
// (the client compresses to ~1000px before sending). Sets image_url to the
// served path with a cache-busting version so storefront thumbnails refresh.
app.post('/api/admin/products/:id/photo', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const dataUrl = (req.body && req.body.dataUrl) || '';
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) return res.status(400).json({ error: 'Expected a JPEG, PNG or WebP image.' });
    const mime = m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 6 * 1024 * 1024) return res.status(413).json({ error: 'Image too large — please retake.' });
    const version = Date.now();
    const imageUrl = `/img/product/${req.params.id}?v=${version}`;
    const { rows } = await pool.query(
      `UPDATE products
         SET image_data = $3, image_mime = $4, image_updated_at = NOW(), image_url = $5
       WHERE id = $1 AND shop_id = $2
       RETURNING id, image_url`,
      [req.params.id, shopId, buf, mime, imageUrl]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[admin/products photo POST]', err.message);
    res.status(500).json({ error: 'Failed to save photo' });
  }
});

// Remove a product photo.
app.delete('/api/admin/products/:id/photo', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `UPDATE products
         SET image_data = NULL, image_mime = NULL, image_updated_at = NULL, image_url = NULL
       WHERE id = $1 AND shop_id = $2
       RETURNING id, image_url`,
      [req.params.id, shopId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[admin/products photo DELETE]', err.message);
    res.status(500).json({ error: 'Failed to remove photo' });
  }
});

// ---------------------------------------------------------------------------
// Admin — products CRUD (every query scoped to shop_id)
// ---------------------------------------------------------------------------
app.get('/api/admin/products', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.name_th, p.description, p.description_th, p.barcode, p.sku, p.unit,
              p.price, p.cost_price, p.stock_qty, p.track_stock, p.kind, p.weight_grams, p.sort_order,
              p.category_id, c.name AS category, p.image_url, p.is_active, p.created_at
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.shop_id = $1 ORDER BY p.created_at DESC`,
      [shopId]
    );
    annotateAvailability(rows, await shopContext(shopId));
    res.json(await attachOptionGroups(rows));
  } catch (err) {
    console.error('[admin/products]', err.message);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

app.post('/api/admin/products', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { name, name_th, description, description_th, barcode, sku, unit, price, cost_price,
            stock_qty, track_stock, weight_grams, sort_order, category_id, image_url, is_active, kind } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    const { rows } = await pool.query(
      `INSERT INTO products (shop_id, name, name_th, description, description_th, barcode, sku, unit,
                             price, cost_price, stock_qty, track_stock, weight_grams, sort_order,
                             category_id, image_url, is_active, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        shopId,
        String(name).trim(),
        name_th || null,
        description || null,
        description_th || null,
        barcode ? String(barcode).trim() : null,
        sku ? String(sku).trim() : null,
        unit || 'each',
        Number(price) || 0,
        Number(cost_price) || 0,
        Number.isInteger(stock_qty) ? stock_qty : Number(stock_qty) || 0,
        track_stock !== false,
        weight_grams != null ? Number(weight_grams) : null,
        Number(sort_order) || 0,
        category_id || null,
        image_url || null,
        is_active !== false,
        productKind(kind),
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That barcode is already used by another product' });
    console.error('[admin/products POST]', err.message);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

app.put('/api/admin/products/:id', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { name, name_th, description, description_th, barcode, sku, unit, price, cost_price,
            stock_qty, track_stock, weight_grams, sort_order, category_id, image_url, is_active, kind } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE products SET
         name = COALESCE($3, name),
         name_th = $4,
         description = $5,
         description_th = $6,
         barcode = $7,
         sku = $8,
         unit = COALESCE($9, unit),
         price = COALESCE($10, price),
         cost_price = COALESCE($11, cost_price),
         stock_qty = COALESCE($12, stock_qty),
         track_stock = COALESCE($13, track_stock),
         weight_grams = $14,
         sort_order = COALESCE($15, sort_order),
         category_id = $16,
         image_url = $17,
         is_active = COALESCE($18, is_active),
         kind = COALESCE($19, kind)
       WHERE id = $1 AND shop_id = $2
       RETURNING *`,
      [
        req.params.id,
        shopId,
        name != null ? String(name).trim() : null,
        name_th ?? null,
        description ?? null,
        description_th ?? null,
        barcode ? String(barcode).trim() : null,
        sku ? String(sku).trim() : null,
        unit ?? null,
        price != null ? Number(price) : null,
        cost_price != null ? Number(cost_price) : null,
        stock_qty != null ? Number(stock_qty) : null,
        track_stock != null ? Boolean(track_stock) : null,
        weight_grams != null ? Number(weight_grams) : null,
        sort_order != null ? Number(sort_order) : null,
        category_id || null,
        image_url ?? null,
        is_active != null ? Boolean(is_active) : null,
        kind != null ? productKind(kind) : null,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That barcode is already used by another product' });
    console.error('[admin/products PUT]', err.message);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Replace a product's whole option tree in one transaction (SIAMSHOP-501).
// Body: { groups: [{ name, name_th, min_select, max_select, options: [{ name, name_th, price_delta, is_default }] }] }
// The tree is small, so replace-all is simpler and safer than diffing. Past
// orders are unaffected — they carry their own options_snapshot.
app.put('/api/admin/products/:id/options', requireAuth, async (req, res) => {
  const shopId = await resolveShopId(req);
  if (!shopId) return res.status(404).json({ error: 'Shop not found' });
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
  const client = await pool.connect();
  try {
    // Validate before touching the DB.
    const clean = groups.map((g, gi) => {
      const name = String(g?.name || '').trim();
      if (!name) throw httpError(400, `Option group ${gi + 1} needs a name`);
      const options = (Array.isArray(g.options) ? g.options : [])
        .map((o, oi) => {
          const oname = String(o?.name || '').trim();
          if (!oname) throw httpError(400, `"${name}": choice ${oi + 1} needs a name`);
          const delta = Number(o.price_delta) || 0;
          if (delta < -1000 || delta > 1000) throw httpError(400, `"${name}": price change out of range`);
          return { name: oname, name_th: o.name_th ? String(o.name_th).trim() : null, price_delta: +delta.toFixed(2), is_default: Boolean(o.is_default), sort_order: oi };
        });
      if (options.length === 0) throw httpError(400, `"${name}" needs at least one choice`);
      const min = Math.max(0, Math.floor(Number(g.min_select) || 0));
      const max = Math.max(1, Math.floor(Number(g.max_select) || 1));
      if (min > max) throw httpError(400, `"${name}": minimum can't exceed maximum`);
      if (min > options.length) throw httpError(400, `"${name}": minimum exceeds the number of choices`);
      return { name, name_th: g.name_th ? String(g.name_th).trim() : null, min_select: min, max_select: max, sort_order: gi, options };
    });

    await client.query('BEGIN');
    const { rows: prod } = await client.query(
      `SELECT id FROM products WHERE id = $1 AND shop_id = $2 FOR UPDATE`, [req.params.id, shopId]
    );
    if (!prod[0]) throw httpError(404, 'Product not found');
    await client.query(`DELETE FROM product_option_groups WHERE product_id = $1 AND shop_id = $2`, [prod[0].id, shopId]);
    for (const g of clean) {
      const { rows: [grp] } = await client.query(
        `INSERT INTO product_option_groups (shop_id, product_id, name, name_th, min_select, max_select, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [shopId, prod[0].id, g.name, g.name_th, g.min_select, g.max_select, g.sort_order]
      );
      for (const o of g.options) {
        await client.query(
          `INSERT INTO product_options (group_id, name, name_th, price_delta, is_default, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [grp.id, o.name, o.name_th, o.price_delta, o.is_default, o.sort_order]
        );
      }
    }
    await client.query('COMMIT');
    const [out] = await attachOptionGroups([{ id: prod[0].id }]);
    res.json({ id: out.id, option_groups: out.option_groups });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('[admin/products options PUT]', err.message);
    res.status(500).json({ error: 'Failed to save options' });
  } finally {
    client.release();
  }
});

// AI-generate product copy (SIAMSHOP-008) for the self-service admin form.
app.post('/api/admin/products/ai-describe', requireAuth, async (req, res) => {
  if (!aiService.isConfigured()) {
    return res.status(503).json({ error: 'AI descriptions not configured (ANTHROPIC_API_KEY unset).' });
  }
  try {
    const { name, name_th, category } = req.body || {};
    if (!name && !name_th) return res.status(400).json({ error: 'Enter a product name first' });
    const content = await aiService.generateProductContent({ name, name_th, category });
    res.json(content);
  } catch (err) {
    console.error('[ai-describe]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.delete('/api/admin/products/:id', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rowCount } = await pool.query(
      `DELETE FROM products WHERE id = $1 AND shop_id = $2`,
      [req.params.id, shopId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Product not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/products DELETE]', err.message);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ---------------------------------------------------------------------------
// Admin — settings (self-service, SIAMSHOP-007/010)
// ---------------------------------------------------------------------------
app.get('/api/admin/settings', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    res.json(await getSettings(shopId));
  } catch (err) {
    console.error('[admin/settings]', err.message);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

app.put('/api/admin/settings', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const updates = req.body || {};
    for (const [key, value] of Object.entries(updates)) {
      await pool.query(
        `INSERT INTO shop_settings (shop_id, key, value) VALUES ($1,$2,$3)
         ON CONFLICT (shop_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [shopId, key, String(value)]
      );
    }
    res.json(await getSettings(shopId));
  } catch (err) {
    console.error('[admin/settings PUT]', err.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Email diagnostics — send a test email and surface Brevo's exact response.
app.post('/api/admin/test-email', requireAuth, async (req, res) => {
  const to = String(req.body?.to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'Enter a valid recipient email' });
  const cfg = emailService.getEmailConfig();
  if (!cfg.has_key) return res.status(503).json({ error: 'BREVO_API_KEY is not set on the server', from: cfg.from_email });
  try {
    await emailService.sendBrevoEmail(
      to,
      'SiamShop test email',
      '<p>✅ This is a SiamShop test email. If you can read this, transactional email is working.</p>'
    );
    res.json({ ok: true, sent_to: to, from: cfg.from_email });
  } catch (e) {
    // e.message includes Brevo's response body (e.g. sender not valid)
    res.status(502).json({ error: e.message, from: cfg.from_email });
  }
});

// ---------------------------------------------------------------------------
// Admin — category management (SIAMSHOP-002)
// ---------------------------------------------------------------------------
// Body.availability → JSON string for the column. undefined/null/[] → null
// (always available); malformed → false (caller returns 400).
function categoryAvailabilityParam(body) {
  const raw = body?.availability;
  if (raw == null || raw === '' || (Array.isArray(raw?.rules) && raw.rules.length === 0)) return null;
  const rules = availability.parseRules(raw);
  return rules ? JSON.stringify({ rules }) : false;
}
app.post('/api/admin/categories', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { name, name_th, sort_order } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    const avail = categoryAvailabilityParam(req.body);
    if (avail === false) return res.status(400).json({ error: 'Availability needs at least one day and from < to' });
    const { rows } = await pool.query(
      `INSERT INTO categories (shop_id, name, name_th, sort_order, availability) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [shopId, String(name).trim(), name_th || null, Number(sort_order) || 0, avail]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A category with that name already exists' });
    console.error('[admin/categories POST]', err.message);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

app.put('/api/admin/categories/:id', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { name, name_th, sort_order } = req.body || {};
    const avail = categoryAvailabilityParam(req.body);
    if (avail === false) return res.status(400).json({ error: 'Availability needs at least one day and from < to' });
    const { rows } = await pool.query(
      `UPDATE categories SET name = COALESCE($3, name), name_th = $4, sort_order = COALESCE($5, sort_order),
              availability = CASE WHEN $6::boolean THEN $7::jsonb ELSE availability END
       WHERE id = $1 AND shop_id = $2 RETURNING *`,
      [req.params.id, shopId, name != null ? String(name).trim() : null, name_th ?? null,
       sort_order != null ? Number(sort_order) : null,
       Object.prototype.hasOwnProperty.call(req.body || {}, 'availability'), avail]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Category not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A category with that name already exists' });
    console.error('[admin/categories PUT]', err.message);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

app.delete('/api/admin/categories/:id', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rowCount } = await pool.query(`DELETE FROM categories WHERE id = $1 AND shop_id = $2`, [req.params.id, shopId]);
    if (!rowCount) return res.status(404).json({ error: 'Category not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/categories DELETE]', err.message);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// ---------------------------------------------------------------------------
// In-store EPOS till (SIAMSHOP-103) — staff-facing, requires auth.
// (The barcode lookup route lives above, before /api/products/:id, so the
// literal "lookup" path isn't swallowed by the :id matcher.)
// ---------------------------------------------------------------------------

// Record an in-store sale. Transactional: create the order + items, decrement
// stock, and write a stock_movements row per line — all or nothing. Stock is
// the source of truth, so we re-read the live price/stock inside the txn and
// never trust client-supplied prices (CLAUDE.md rule).
app.post('/api/sales', requireAuth, async (req, res) => {
  const shopId = await resolveShopId(req);
  if (!shopId) return res.status(404).json({ error: 'Shop not found' });

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const paymentMethod = req.body?.payment_method === 'card' ? 'card' : 'cash';
  const tendered = req.body?.amount_tendered != null ? Number(req.body.amount_tendered) : null;
  const staff = req.auth?.name || 'admin';
  // Till sales are takeaway unless staff mark the customer as eating in (SIAMSHOP-504).
  const fulfilment = req.body?.fulfilment === 'dine_in' ? 'dine_in' : 'takeaway';

  if (items.length === 0) return res.status(400).json({ error: 'Cart is empty' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock each product row, validate stock, compute the authoritative total.
    // Stock only matters for tracked items — made-to-order food (SIAMSHOP-502)
    // sells at any stock level and never writes a movement.
    let subtotal = 0;
    const lines = [];
    const rules = discountRules(await getSettings(shopId));
    let lineDiscountTotal = 0, maxPercent = 0;
    for (const it of items) {
      const qty = Number(it.qty);
      if (!Number.isInteger(qty) || qty <= 0) throw httpError(400, 'Invalid quantity');
      const { rows } = await client.query(
        `SELECT id, name, price, stock_qty, track_stock FROM products
         WHERE id = $1 AND shop_id = $2 AND is_active = TRUE FOR UPDATE`,
        [it.product_id, shopId]
      );
      const p = rows[0];
      if (!p) throw httpError(404, `Product ${it.product_id} not found`);
      if (p.track_stock && p.stock_qty < qty) {
        throw httpError(409, `Not enough stock for ${p.name} (${p.stock_qty} left)`);
      }
      const { snapshot, total: optionsTotal } = await resolveOptions(client, p, it.option_ids);
      const gross = +((Number(p.price) + optionsTotal) * qty).toFixed(2);
      // Line discount (SIAMSHOP-DISCOUNT-001) — priced here, never trusted from the client.
      const disc = applyDiscount(it.discount, gross, rules, p.name);
      const lineTotal = +(gross - (disc ? disc.amount : 0)).toFixed(2);
      subtotal += lineTotal;
      if (disc) { lineDiscountTotal += disc.amount; maxPercent = Math.max(maxPercent, disc.type === 'percent' ? disc.value : (gross ? disc.amount / gross * 100 : 0)); }
      lines.push({ product: p, qty, gross, lineTotal, snapshot, optionsTotal, disc });
    }

    // Basket discount on the (line-discounted) subtotal.
    const basketDisc = applyDiscount(req.body?.discount, subtotal, rules, 'Basket');
    if (basketDisc) maxPercent = Math.max(maxPercent, basketDisc.type === 'percent' ? basketDisc.value : (subtotal ? basketDisc.amount / subtotal * 100 : 0));
    const discountAmount = +(lineDiscountTotal + (basketDisc ? basketDisc.amount : 0)).toFixed(2);
    // Manager approval above the shop's threshold (£ total off, or % on any line/basket) — cashiers only.
    let approvedBy = null;
    if (discountAmount > 0 && req.auth?.role !== 'manager' && req.auth?.role !== 'admin' &&
        (discountAmount > rules.thresholdAmount || maxPercent > rules.thresholdPercent)) {
      if (!req.body?.approval_token) {
        const e = httpError(403, `Discounts over £${rules.thresholdAmount.toFixed(2)} or ${rules.thresholdPercent}% need a manager's approval`);
        e.code = 'approval_required';
        throw e;
      }
      approvedBy = consumeApproval(req.body.approval_token, shopId).name;
    }
    const total = +(subtotal - (basketDisc ? basketDisc.amount : 0)).toFixed(2); // no delivery fee in-store
    let change = null;
    if (paymentMethod === 'cash' && tendered != null) {
      if (tendered < total) throw httpError(400, 'Amount tendered is less than the total');
      change = +(tendered - total).toFixed(2);
    }

    // Every paid till sale belongs to a session (SIAMSHOP-TILL-001, Krit's review):
    // if nobody opened the till yet, AUTO-OPEN one with float 0 — never block a
    // queue, never leave cash outside a Z. The Till then asks for the float.
    let { rows: sess } = await client.query(
      `SELECT id, auto_opened, float_amount FROM till_sessions WHERE shop_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1`, [shopId]
    );
    let sessionAutoOpened = false;
    if (!sess[0]) {
      const ins = await client.query(
        `INSERT INTO till_sessions (shop_id, opened_by, opened_by_sid, float_amount, auto_opened)
         VALUES ($1,$2,$3,0,TRUE)
         ON CONFLICT (shop_id) WHERE status = 'open' DO NOTHING
         RETURNING id, auto_opened, float_amount`,
        [shopId, staff, req.auth?.sid || null]
      );
      if (ins.rows[0]) { sess = ins.rows; sessionAutoOpened = true; }
      else ({ rows: sess } = await client.query(`SELECT id, auto_opened, float_amount FROM till_sessions WHERE shop_id = $1 AND status = 'open' LIMIT 1`, [shopId]));
    }
    const sessionId = sess[0]?.id || null;
    const sessionNeedsFloat = !!sess[0]?.auto_opened && Number(sess[0]?.float_amount) === 0;
    const orderRes = await client.query(
      `INSERT INTO orders (shop_id, channel, status, subtotal, total, payment_method,
                           amount_tendered, change_given, staff, payment_status, fulfilled_at, fulfilment, session_id,
                           discount_type, discount_value, discount_amount, discount_reason, discount_approved_by)
       VALUES ($1,'instore','completed',$2,$3,$4,$5,$6,$7,'paid',NOW(),$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, created_at`,
      [shopId, subtotal, total, paymentMethod, tendered, change, staff, fulfilment, sessionId,
       basketDisc?.type || null, basketDisc?.value ?? null, discountAmount, basketDisc?.reason || null, approvedBy]
    );
    const orderId = orderRes.rows[0].id;

    for (const ln of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, name_snapshot, price_snapshot, qty, line_total,
                                  options_snapshot, options_total, discount_type, discount_value, discount_amount, discount_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [orderId, ln.product.id, ln.product.name, ln.product.price, ln.qty, ln.lineTotal,
         ln.snapshot ? JSON.stringify(ln.snapshot) : null, ln.optionsTotal,
         ln.disc?.type || null, ln.disc?.value ?? null, ln.disc?.amount || 0, ln.disc?.reason || null]
      );
      if (!ln.product.track_stock) continue;
      await client.query(
        `UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2`,
        [ln.qty, ln.product.id]
      );
      await client.query(
        `INSERT INTO stock_movements (shop_id, product_id, change_qty, reason, ref_order_id, staff)
         VALUES ($1,$2,$3,'sale',$4,$5)`,
        [shopId, ln.product.id, -ln.qty, orderId, staff]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      id: orderId,
      channel: 'instore',
      subtotal: +subtotal.toFixed(2),
      total: +total.toFixed(2),
      payment_method: paymentMethod,
      fulfilment,
      staff,
      session_id: sessionId,
      session_auto_opened: sessionAutoOpened,
      session_needs_float: sessionNeedsFloat,
      amount_tendered: tendered,
      change_given: change,
      created_at: orderRes.rows[0].created_at,
      discount: basketDisc ? { ...basketDisc } : null,
      discount_amount: discountAmount,
      discount_approved_by: approvedBy,
      items: lines.map((l) => ({
        name: l.product.name, qty: l.qty, line_total: l.lineTotal, gross: l.gross,
        options: l.snapshot || [], options_total: l.optionsTotal,
        discount: l.disc ? { ...l.disc } : null,
      })),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message, code: err.code || undefined });
    console.error('[sales POST]', err.message);
    res.status(500).json({ error: 'Failed to record sale' });
  } finally {
    client.release();
  }
});

// Today's takings (since local midnight UTC for now), broken down by channel
// and payment method — the "how much it sold" view.
app.get('/api/sales/summary', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `SELECT channel,
              COALESCE(payment_method, '—') AS payment_method,
              COUNT(*)::int AS order_count,
              COALESCE(SUM(total), 0)::numeric AS gross
       FROM orders
       WHERE shop_id = $1
         AND payment_status = 'paid'
         AND created_at >= date_trunc('day', NOW())
       GROUP BY channel, payment_method
       ORDER BY channel, payment_method`,
      [shopId]
    );
    const totals = rows.reduce(
      (acc, r) => {
        acc.order_count += r.order_count;
        acc.gross += Number(r.gross);
        return acc;
      },
      { order_count: 0, gross: 0 }
    );
    res.json({ date: new Date().toISOString().slice(0, 10), breakdown: rows, totals });
  } catch (err) {
    console.error('[sales/summary]', err.message);
    res.status(500).json({ error: 'Failed to load summary' });
  }
});

// ---------------------------------------------------------------------------
// Stock operations (SIAMSHOP-202) — used by the phone scanner: goods-in
// (receiving), stocktake (counting), and batch goods-in (from an invoice).
// Every change writes a stock_movements row so the ledger is the audit trail.
// ---------------------------------------------------------------------------

// Resolve a product within a shop by id or barcode using the given client.
// Returns the row (locked FOR UPDATE) or null.
async function findProductForUpdate(client, shopId, { product_id, barcode }) {
  if (product_id) {
    const { rows } = await client.query(
      `SELECT * FROM products WHERE id = $1 AND shop_id = $2 FOR UPDATE`,
      [product_id, shopId]
    );
    return rows[0] || null;
  }
  if (barcode) {
    const { rows } = await client.query(
      `SELECT * FROM products WHERE shop_id = $1 AND barcode = $2 FOR UPDATE`,
      [shopId, String(barcode).trim()]
    );
    return rows[0] || null;
  }
  return null;
}

// Receive stock (goods-in): increment a product's stock and log the movement.
app.post('/api/stock/receive', requireAuth, async (req, res) => {
  const shopId = await resolveShopId(req);
  if (!shopId) return res.status(404).json({ error: 'Shop not found' });
  const qty = Number(req.body?.qty);
  if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: 'qty must be a positive integer' });
  const staff = req.auth?.name || 'admin';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await findProductForUpdate(client, shopId, req.body || {});
    if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Product not found' }); }
    const { rows } = await client.query(
      `UPDATE products SET stock_qty = stock_qty + $1 WHERE id = $2 RETURNING stock_qty`,
      [qty, p.id]
    );
    await client.query(
      `INSERT INTO stock_movements (shop_id, product_id, change_qty, reason, note, staff)
       VALUES ($1,$2,$3,'goods_in',$4,$5)`,
      [shopId, p.id, qty, req.body?.note || null, staff]
    );
    await client.query('COMMIT');
    res.json({ product_id: p.id, name: p.name, received: qty, stock_qty: rows[0].stock_qty });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[stock/receive]', err.message);
    res.status(500).json({ error: 'Failed to receive stock' });
  } finally {
    client.release();
  }
});

// Stocktake: set a product's stock to a physically-counted value and log the
// variance (counted − previous) so over/under-counts are auditable.
app.post('/api/stock/stocktake', requireAuth, async (req, res) => {
  const shopId = await resolveShopId(req);
  if (!shopId) return res.status(404).json({ error: 'Shop not found' });
  const counted = Number(req.body?.counted_qty);
  if (!Number.isInteger(counted) || counted < 0) return res.status(400).json({ error: 'counted_qty must be a non-negative integer' });
  const staff = req.auth?.name || 'admin';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await findProductForUpdate(client, shopId, req.body || {});
    if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Product not found' }); }
    const previous = p.stock_qty;
    const variance = counted - previous;
    await client.query(`UPDATE products SET stock_qty = $1 WHERE id = $2`, [counted, p.id]);
    if (variance !== 0) {
      await client.query(
        `INSERT INTO stock_movements (shop_id, product_id, change_qty, reason, note, staff)
         VALUES ($1,$2,$3,'stocktake',$4,$5)`,
        [shopId, p.id, variance, `count ${previous}→${counted}`, staff]
      );
    }
    await client.query('COMMIT');
    res.json({ product_id: p.id, name: p.name, previous, counted, variance, stock_qty: counted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[stock/stocktake]', err.message);
    res.status(500).json({ error: 'Failed to record stocktake' });
  } finally {
    client.release();
  }
});

// Batch goods-in — used after an invoice scan. Each line is matched by
// product_id or barcode; unmatched lines are returned so the user can handle
// them (e.g. create the product first). Applied atomically.
app.post('/api/stock/goods-in-batch', requireAuth, async (req, res) => {
  const shopId = await resolveShopId(req);
  if (!shopId) return res.status(404).json({ error: 'Shop not found' });
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  if (lines.length === 0) return res.status(400).json({ error: 'No lines' });
  const staff = req.auth?.name || 'admin';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const applied = [];
    const unmatched = [];
    for (const ln of lines) {
      const qty = Number(ln.qty);
      if (!Number.isInteger(qty) || qty <= 0) { unmatched.push({ ...ln, reason: 'bad qty' }); continue; }
      const p = await findProductForUpdate(client, shopId, ln);
      if (!p) { unmatched.push({ ...ln, reason: 'no match' }); continue; }
      const { rows } = await client.query(
        `UPDATE products SET stock_qty = stock_qty + $1 WHERE id = $2 RETURNING stock_qty`,
        [qty, p.id]
      );
      await client.query(
        `INSERT INTO stock_movements (shop_id, product_id, change_qty, reason, note, staff)
         VALUES ($1,$2,$3,'goods_in',$4,$5)`,
        [shopId, p.id, qty, ln.note || 'invoice', staff]
      );
      applied.push({ product_id: p.id, name: p.name, received: qty, stock_qty: rows[0].stock_qty });
    }
    await client.query('COMMIT');
    res.json({ applied, unmatched });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[stock/goods-in-batch]', err.message);
    res.status(500).json({ error: 'Failed to apply goods-in' });
  } finally {
    client.release();
  }
});

// Recent stock movements (the ledger) for a history view.
app.get('/api/stock/movements', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const { rows } = await pool.query(
      `SELECT m.id, m.change_qty, m.reason, m.ref_order_id, m.note, m.staff, m.created_at,
              p.name AS product_name
       FROM stock_movements m
       LEFT JOIN products p ON p.id = m.product_id
       WHERE m.shop_id = $1
       ORDER BY m.id DESC
       LIMIT $2`,
      [shopId, limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('[stock/movements]', err.message);
    res.status(500).json({ error: 'Failed to load movements' });
  }
});

// AI invoice scanner (SIAMSHOP-203). Photo of a supplier invoice -> Claude
// extracts line items -> we match each to a product by barcode/name and return
// the lines for the user to review before applying via /stock/goods-in-batch.
app.post('/api/stock/scan-invoice', requireAuth, async (req, res) => {
  if (!aiService.isConfigured()) {
    return res.status(503).json({ error: 'AI invoice scanning is not configured (ANTHROPIC_API_KEY unset).' });
  }
  const shopId = await resolveShopId(req);
  if (!shopId) return res.status(404).json({ error: 'Shop not found' });
  let { image_base64, media_type } = req.body || {};
  if (!image_base64) return res.status(400).json({ error: 'image_base64 is required' });
  // Tolerate a full data: URL by stripping the prefix.
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(image_base64);
  if (m) {
    media_type = media_type || m[1];
    image_base64 = m[2];
  }

  try {
    const extracted = await aiService.extractInvoice(image_base64, media_type || 'image/jpeg');
    const { rows: products } = await pool.query(
      `SELECT id, name, barcode FROM products WHERE shop_id = $1`,
      [shopId]
    );
    const byBarcode = new Map(products.filter((p) => p.barcode).map((p) => [String(p.barcode), p]));

    const lines = extracted.lines.map((ln) => {
      let match = null;
      if (ln.barcode && byBarcode.has(String(ln.barcode))) match = byBarcode.get(String(ln.barcode));
      if (!match && ln.name) {
        const lc = String(ln.name).toLowerCase().trim();
        match =
          products.find((p) => p.name.toLowerCase() === lc) ||
          products.find((p) => p.name.toLowerCase().includes(lc) || lc.includes(p.name.toLowerCase())) ||
          null;
      }
      return {
        name: ln.name,
        qty: ln.qty,
        unit_cost: ln.unit_cost ?? null,
        barcode: ln.barcode ?? null,
        matched_product_id: match ? match.id : null,
        matched_name: match ? match.name : null,
      };
    });

    res.json({ supplier: extracted.supplier, lines });
  } catch (err) {
    console.error('[stock/scan-invoice]', err.message);
    res.status(502).json({ error: err.message || 'Invoice scan failed' });
  }
});

// ---------------------------------------------------------------------------
// Admin — orders (read-only in the scaffold; fulfilment is SIAMSHOP-005)
// ---------------------------------------------------------------------------
app.get('/api/admin/orders', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `SELECT o.id, o.channel, o.source, o.status, o.payment_status, o.payment_method,
              o.subtotal, o.delivery_fee, o.total, o.created_at, o.fulfilled_at,
              o.dispatch_date, o.tracking_number,
              o.fulfilment, o.pickup_at, o.ready_at, o.prep_status, o.label_printed_at, o.session_id,
              c.name AS customer_name, c.email AS customer_email
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.shop_id = $1
       ORDER BY o.created_at DESC
       LIMIT 200`,
      [shopId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[admin/orders]', err.message);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// Export all orders as CSV (one row per order, with an item summary column).
app.get('/api/admin/orders.csv', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `SELECT o.id, o.created_at, o.channel, o.source, o.status, o.payment_status, o.payment_method,
              c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
              o.subtotal, o.delivery_fee, o.total, o.dispatch_date, o.tracking_number, o.delivery_address,
              o.fulfilment, o.pickup_at,
              (SELECT string_agg(oi.qty || 'x ' || oi.name_snapshot, '; ')
                 FROM order_items oi WHERE oi.order_id = o.id) AS items
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.shop_id = $1 ORDER BY o.created_at DESC`,
      [shopId]
    );
    const cols = [
      'id', 'created_at', 'channel', 'source', 'status', 'payment_status', 'payment_method',
      'customer_name', 'customer_email', 'customer_phone',
      'subtotal', 'delivery_fee', 'total', 'dispatch_date', 'tracking_number', 'delivery_address', 'items',
    ];
    const esc = (v) => {
      if (v == null) return '';
      const s = v instanceof Date ? v.toISOString() : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
    const csv = lines.join('\r\n');
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="siamshop-orders-${date}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[admin/orders.csv]', err.message);
    res.status(500).json({ error: 'Failed to export orders' });
  }
});

// Full order detail (items + customer + address) for the admin/packing slip.
app.get('/api/admin/orders/:id', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `SELECT o.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.id = $1 AND o.shop_id = $2`,
      [req.params.id, shopId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
    const { rows: items } = await pool.query(
      `SELECT name_snapshot, price_snapshot, qty, line_total, options_snapshot, options_total,
              discount_type, discount_value, discount_amount, discount_reason
       FROM order_items WHERE order_id = $1`,
      [req.params.id]
    );
    res.json({ ...rows[0], items });
  } catch (err) {
    console.error('[admin/orders/:id]', err.message);
    res.status(500).json({ error: 'Failed to load order' });
  }
});

// ---------------------------------------------------------------------------
// Parcel labels (SIAMSHOP-POST-001) — data for the 4×6 address + packing label
// printed from the desktop till through the OS driver. Cashier + manager.
// ---------------------------------------------------------------------------
const UK_POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
function splitPostcode(address) {
  const text = String(address || '').trim();
  const m = UK_POSTCODE_RE.exec(text.toUpperCase());
  if (!m) return { lines: text.split(/\r?\n|,\s*/).map((l) => l.trim()).filter(Boolean), postcode: '' };
  const pc = m[1].replace(/\s+/, ' ').replace(/^(.+?)(\d[A-Z]{2})$/, '$1 $2').replace(/\s{2,}/g, ' ');
  const without = text.replace(new RegExp(m[1].replace(/\s+/g, '\\s*'), 'i'), '').replace(/[,\s]+$/, '');
  return { lines: without.split(/\r?\n|,\s*/).map((l) => l.trim()).filter(Boolean), postcode: pc };
}
app.get('/api/admin/orders/:id/label', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `SELECT o.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone, s.name AS shop_name
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id JOIN shops s ON s.id = o.shop_id
       WHERE o.id = $1 AND o.shop_id = $2`,
      [req.params.id, shopId]
    );
    const o = rows[0];
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.fulfilment !== 'delivery') return res.status(400).json({ error: 'Labels are for postal (delivery) orders only' });
    if (o.status === 'cancelled' || o.payment_status === 'refunded') return res.status(400).json({ error: 'This order is cancelled/refunded' });
    const { rows: items } = await pool.query(
      `SELECT name_snapshot, qty, options_snapshot FROM order_items WHERE order_id = $1 ORDER BY id`, [o.id]
    );
    const settings = await getSettings(shopId);
    const { lines, postcode } = splitPostcode(o.delivery_address);
    res.json({
      order_id: o.id,
      created_at: o.created_at,
      ship_to: { name: o.customer_name || '', lines, postcode, phone: o.customer_phone || '' },
      items: items.map((it) => ({ name: it.name_snapshot, qty: it.qty, options: (it.options_snapshot || []).map((x) => x.name) })),
      staff: req.auth?.name || 'Owner',
      // No email in the QR — the outside of a parcel is public; the tracking page asks for it.
      tracking_url: orderStatusUrl(originFromReq(req), o.id, null),
      shop: { name: o.shop_name, return_address: settings.return_address || '' },
      label_printed_at: o.label_printed_at,
      notes: o.notes || '',
    });
  } catch (err) {
    console.error('[admin/orders label]', err.message);
    res.status(500).json({ error: 'Failed to build label' });
  }
});
app.post('/api/admin/orders/:id/label-printed', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `UPDATE orders SET label_printed_at = NOW() WHERE id = $1 AND shop_id = $2 RETURNING id, label_printed_at`,
      [req.params.id, shopId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[admin/orders label-printed]', err.message);
    res.status(500).json({ error: 'Failed to record label print' });
  }
});

// Mark an order dispatched (+ optional tracking number).
app.post('/api/admin/orders/:id/dispatch', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `UPDATE orders SET status = 'dispatched', dispatch_date = COALESCE(dispatch_date, CURRENT_DATE),
              tracking_number = $3, carrier = $4, fulfilled_at = NOW()
       WHERE id = $1 AND shop_id = $2 RETURNING *`,
      [req.params.id, shopId, req.body?.tracking_number || null, req.body?.carrier || null]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
    const order = rows[0];
    res.json(order);

    // Notify the customer their order is on its way, with a carrier tracking link.
    (async () => {
      try {
        const { shopName, customerEmail } = await orderEmailContext(order);
        if (customerEmail) {
          const carrierUrl = carriers.trackingUrl(order.carrier, order.tracking_number);
          await emailService.sendDispatchNotification(
            customerEmail, shopName, order,
            orderStatusUrl(originFromReq(req), order.id, customerEmail),
            carrierUrl, order.carrier ? carriers.nameOf(order.carrier) : null
          );
        }
      } catch (e) {
        console.warn('[email] dispatch', order.id, e.message);
      }
    })();
  } catch (err) {
    console.error('[admin/orders dispatch]', err.message);
    res.status(500).json({ error: 'Failed to mark dispatched' });
  }
});

// Courier list for the dispatch dropdown.
app.get('/api/admin/carriers', requireAuth, (req, res) => {
  res.json(carriers.list());
});

// Cancel an order (e.g. customer never paid). If it was already paid, restore
// the stock and write refund movements; otherwise just mark it cancelled.
app.post('/api/admin/orders/:id/cancel', requireAuth, async (req, res) => {
  const shopId = await resolveShopId(req);
  if (!shopId) return res.status(404).json({ error: 'Shop not found' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND shop_id = $2 FOR UPDATE`,
      [req.params.id, shopId]
    );
    const order = rows[0];
    if (!order) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }
    if (order.status === 'cancelled') { await client.query('ROLLBACK'); return res.json(order); }

    // If it was paid, the stock was decremented — put it back (tracked items only;
    // made-to-order lines never moved stock, so they get no refund movement).
    if (order.payment_status === 'paid') {
      const { rows: items } = await client.query(
        `SELECT oi.product_id, oi.qty, p.track_stock
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = $1`, [order.id]
      );
      for (const it of items) {
        if (!it.product_id || !it.track_stock) continue;
        await client.query(
          `UPDATE products SET stock_qty = stock_qty + $1 WHERE id = $2`,
          [it.qty, it.product_id]
        );
        await client.query(
          `INSERT INTO stock_movements (shop_id, product_id, change_qty, reason, ref_order_id, staff)
           VALUES ($1,$2,$3,'refund',$4,$5)`,
          [shopId, it.product_id, it.qty, order.id, req.auth?.name || 'admin']
        );
      }
      await client.query(`UPDATE orders SET payment_status = 'refunded', refunded_at = NOW() WHERE id = $1`, [order.id]);
    }
    const { rows: updated } = await client.query(
      `UPDATE orders SET status = 'cancelled' WHERE id = $1 RETURNING *`, [order.id]
    );
    await client.query('COMMIT');
    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[admin/orders cancel]', err.message);
    res.status(500).json({ error: 'Failed to cancel order' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Click & Collect lifecycle (SIAMSHOP-504) + counter prep (SIAMSHOP-505)
// ---------------------------------------------------------------------------

// Mark an order ready. Collection orders → status 'ready' + one "ready to
// collect" email (idempotent: a second call never re-sends). Till/dine-in
// orders just get prep_status/ready_at. Returns the updated order row.
async function markOrderReady(shopId, orderId, baseUrl) {
  const client = await pool.connect();
  let order;
  let firstTime = false;
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(
      `SELECT ready_at FROM orders WHERE id = $1 AND shop_id = $2 FOR UPDATE`, [orderId, shopId]
    );
    if (!cur[0]) { await client.query('ROLLBACK'); return null; }
    firstTime = !cur[0].ready_at;
    ({ rows: [order] } = await client.query(
      `UPDATE orders
          SET ready_at = COALESCE(ready_at, NOW()),
              prep_status = 'ready',
              status = CASE WHEN fulfilment = 'collection' AND status NOT IN ('cancelled','completed') THEN 'ready' ELSE status END
        WHERE id = $1 AND shop_id = $2
        RETURNING *`,
      [orderId, shopId]
    ));
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  // Email exactly once — on the call that set ready_at.
  if (order.fulfilment === 'collection' && firstTime && order.status === 'ready') {
    (async () => {
      try {
        const { shopName, customerEmail } = await orderEmailContext(order);
        if (!customerEmail) return;
        const s = await getSettings(shopId);
        await emailService.sendOrderReady(customerEmail, shopName, {
          id: order.id,
          collection_address: s.collection_address || '',
          pickup_label: order.pickup_at ? availability.labelFor(order.pickup_at, s.timezone || availability.TZ_DEFAULT) : null,
        }, orderStatusUrl(baseUrl, order.id, customerEmail));
      } catch (e) {
        console.warn('[email] ready', order.id, e.message);
      }
    })();
  }
  return order;
}

// Collected / handed over → completed.
async function markOrderCollected(shopId, orderId) {
  const { rows } = await pool.query(
    `UPDATE orders
        SET status = CASE WHEN status = 'cancelled' THEN status ELSE 'completed' END,
            prep_status = 'done',
            fulfilled_at = COALESCE(fulfilled_at, NOW()),
            ready_at = COALESCE(ready_at, NOW())
      WHERE id = $1 AND shop_id = $2 RETURNING *`,
    [orderId, shopId]
  );
  return rows[0] || null;
}

app.post('/api/admin/orders/:id/ready', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const order = await markOrderReady(shopId, req.params.id, originFromReq(req));
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    console.error('[admin/orders ready]', err.message);
    res.status(500).json({ error: 'Failed to mark ready' });
  }
});

app.post('/api/admin/orders/:id/collected', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const order = await markOrderCollected(shopId, req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    console.error('[admin/orders collected]', err.message);
    res.status(500).json({ error: 'Failed to mark collected' });
  }
});

// ---------------------------------------------------------------------------
// Till sessions + Z report (SIAMSHOP-TILL-001). One open session per shop
// (partial unique index). Cashiers open with a float; a manager closes with the
// counted cash; the Z snapshot is stored on the session and reprintable.
// ---------------------------------------------------------------------------
async function sessionSummary(shopId, session) {
  const from = session.opened_at;
  const to = session.closed_at || new Date();
  const win = [shopId, from, to]; // window queries must not carry unused params (pg can't type them)
  // GROSS = everything rung in this session, including sales refunded later
  // (a refund is its own line below) — so drawer cash = float + cash rung − cash refunded.
  const sales = (await pool.query(
    `SELECT COALESCE(payment_method,'other') AS method, COUNT(*)::int AS count, COALESCE(SUM(total),0)::numeric AS gross
     FROM orders WHERE shop_id = $1 AND channel = 'instore' AND session_id = $2 AND payment_status IN ('paid','refunded')
     GROUP BY payment_method`, [shopId, session.id]
  )).rows;
  // Refunds are counted when they HAPPEN (refunded_at inside the shift), whatever session sold the item.
  const refunds = (await pool.query(
    `SELECT COALESCE(payment_method,'other') AS method, COUNT(*)::int AS count, COALESCE(SUM(total),0)::numeric AS total
     FROM orders WHERE shop_id = $1 AND channel = 'instore' AND payment_status = 'refunded'
       AND refunded_at >= $2 AND refunded_at <= $3 GROUP BY payment_method`, win
  )).rows;
  const items = (await pool.query(
    `SELECT COALESCE(SUM(oi.qty),0)::int AS qty FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.shop_id = $1 AND o.session_id = $2 AND o.payment_status IN ('paid','refunded')`, [shopId, session.id]
  )).rows[0];
  const discounts = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE discount_amount > 0)::int AS count, COALESCE(SUM(discount_amount),0)::numeric AS total
     FROM orders WHERE shop_id = $1 AND session_id = $2 AND payment_status IN ('paid','refunded')`, [shopId, session.id]
  )).rows[0];
  discounts.total = Number(discounts.total);
  const online = (await pool.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0)::numeric AS gross FROM orders
     WHERE shop_id = $1 AND channel <> 'instore' AND payment_status = 'paid' AND created_at >= $2 AND created_at <= $3`, win
  )).rows[0];
  const by = (rows, m) => rows.find((r) => r.method === m) || { count: 0, gross: 0, total: 0 };
  const cashSales = Number(by(sales, 'cash').gross), cardSales = Number(by(sales, 'card').gross);
  const cashRefunds = Number(by(refunds, 'cash').total), cardRefunds = Number(by(refunds, 'card').total);
  const gross = sales.reduce((a, r) => a + Number(r.gross), 0);
  const refundTotal = refunds.reduce((a, r) => a + Number(r.total), 0);
  const expectedCash = +(Number(session.float_amount) + cashSales - cashRefunds).toFixed(2);
  return {
    session_id: session.id, opened_at: from, closed_at: session.closed_at || null,
    opened_by: session.opened_by, closed_by: session.closed_by,
    float_amount: Number(session.float_amount),
    sales: { count: sales.reduce((a, r) => a + r.count, 0), gross: +gross.toFixed(2), cash: +cashSales.toFixed(2), card: +cardSales.toFixed(2), items: items.qty },
    refunds: { count: refunds.reduce((a, r) => a + r.count, 0), total: +refundTotal.toFixed(2), cash: +cashRefunds.toFixed(2), card: +cardRefunds.toFixed(2) },
    discounts: discounts,
    net: +(gross - refundTotal).toFixed(2),
    online: { count: online.count, gross: Number(online.gross) },
    expected_cash: expectedCash,
    counted_cash: session.counted_cash != null ? Number(session.counted_cash) : null,
    variance: session.variance != null ? Number(session.variance) : null,
    notes: session.notes || '',
  };
}
async function openSession(shopId) {
  const { rows } = await pool.query(
    `SELECT * FROM till_sessions WHERE shop_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1`, [shopId]
  );
  return rows[0] || null;
}
// Current open session (+ live summary) or { session: null }.
app.get('/api/till/session', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const s = await openSession(shopId);
    if (!s) return res.json({ session: null });
    res.json({ session: s, summary: await sessionSummary(shopId, s) });
  } catch (err) {
    console.error('[till/session]', err.message);
    res.status(500).json({ error: 'Failed to load till session' });
  }
});
app.post('/api/till/session/open', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const float = Number(req.body?.float_amount);
    if (!Number.isFinite(float) || float < 0 || float > 100000) return res.status(400).json({ error: 'Enter the opening float (£)' });
    const existing = await openSession(shopId);
    if (existing) return res.status(409).json({ error: 'The till is already open', session: existing });
    const { rows } = await pool.query(
      `INSERT INTO till_sessions (shop_id, opened_by, opened_by_sid, float_amount) VALUES ($1,$2,$3,$4) RETURNING *`,
      [shopId, req.auth?.name || 'Owner', req.auth?.sid || null, +float.toFixed(2)]
    );
    res.status(201).json({ session: rows[0], summary: await sessionSummary(shopId, rows[0]) });
  } catch (err) {
    if (err.code === '23505') { const ex = await openSession(await resolveShopId(req)); return res.status(409).json({ error: 'The till is already open', session: ex }); }
    console.error('[till/session open]', err.message);
    res.status(500).json({ error: 'Failed to open the till' });
  }
});
// Set / correct the opening float on the OPEN session (after an auto-open, or a typo). Cashier ok.
app.put('/api/till/session/float', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const float = Number(req.body?.float_amount);
    if (!Number.isFinite(float) || float < 0 || float > 100000) return res.status(400).json({ error: 'Enter the opening float (£)' });
    const { rows } = await pool.query(
      `UPDATE till_sessions SET float_amount = $3, auto_opened = FALSE,
              opened_by = COALESCE(opened_by, $4)
       WHERE shop_id = $1 AND status = 'open' AND id = (SELECT id FROM till_sessions WHERE shop_id = $2 AND status = 'open' LIMIT 1)
       RETURNING *`,
      [shopId, shopId, +float.toFixed(2), req.auth?.name || 'Owner']
    );
    if (!rows[0]) return res.status(409).json({ error: 'No till session is open' });
    res.json({ session: rows[0], summary: await sessionSummary(shopId, rows[0]) });
  } catch (err) {
    console.error('[till/session float]', err.message);
    res.status(500).json({ error: 'Failed to set the float' });
  }
});
// Close = cash-up. Manager or owner only. Snapshots the Z onto the session.
app.post('/api/till/session/close', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    // Manager/owner, or a cashier carrying a one-off manager approval token.
    let closedBy = req.auth?.name || 'Owner';
    if (req.auth?.role !== 'manager' && req.auth?.role !== 'admin') {
      if (!req.body?.approval_token) return res.status(403).json({ error: 'Manager approval required to close the till', code: 'approval_required' });
      try { closedBy = `${consumeApproval(req.body.approval_token, shopId).name} (for ${req.auth?.name || 'cashier'})`; }
      catch (e) { return res.status(e.httpStatus || 403).json({ error: e.message }); }
    }
    const counted = Number(req.body?.counted_cash);
    if (!Number.isFinite(counted) || counted < 0) return res.status(400).json({ error: 'Enter the cash counted in the drawer (£)' });
    const s = await openSession(shopId);
    if (!s) return res.status(409).json({ error: 'No till session is open' });
    const closing = { ...s, closed_at: new Date(), closed_by: closedBy, counted_cash: counted };
    const summary = await sessionSummary(shopId, closing);
    summary.counted_cash = +counted.toFixed(2);
    summary.variance = +(counted - summary.expected_cash).toFixed(2);
    summary.notes = String(req.body?.notes || '').slice(0, 500);
    const { rows } = await pool.query(
      `UPDATE till_sessions SET status = 'closed', closed_at = $3, closed_by = $4, closed_by_sid = $5,
              expected_cash = $6, counted_cash = $7, variance = $8, notes = $9, summary = $10
       WHERE id = $1 AND shop_id = $2 AND status = 'open' RETURNING *`,
      [s.id, shopId, closing.closed_at, closing.closed_by, req.auth?.sid || null,
       summary.expected_cash, summary.counted_cash, summary.variance, summary.notes, JSON.stringify(summary)]
    );
    if (!rows[0]) return res.status(409).json({ error: 'Session was already closed' });
    res.json({ session: rows[0], summary });
  } catch (err) {
    console.error('[till/session close]', err.message);
    res.status(500).json({ error: 'Failed to close the till' });
  }
});
// Z report history (Admin → Reports). Managers/owner; cashiers may read too.
app.get('/api/till/sessions', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `SELECT id, status, opened_at, opened_by, float_amount, closed_at, closed_by, expected_cash, counted_cash, variance, notes,
              (summary->'sales'->>'gross')::numeric AS gross, (summary->'sales'->>'count')::int AS sales_count
       FROM till_sessions WHERE shop_id = $1 ORDER BY opened_at DESC LIMIT 60`, [shopId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[till/sessions]', err.message);
    res.status(500).json({ error: 'Failed to load Z reports' });
  }
});
app.get('/api/till/sessions/:id', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(`SELECT * FROM till_sessions WHERE id = $1 AND shop_id = $2`, [req.params.id, shopId]);
    const s = rows[0];
    if (!s) return res.status(404).json({ error: 'Session not found' });
    const summary = s.status === 'closed' && s.summary ? s.summary : await sessionSummary(shopId, s);
    res.json({ session: s, summary });
  } catch (err) {
    console.error('[till/sessions/:id]', err.message);
    res.status(500).json({ error: 'Failed to load Z report' });
  }
});

// Discount settings (SIAMSHOP-DISCOUNT-001) with defaults.
const DEFAULT_DISCOUNT_REASONS = ['Damaged', 'Near date', 'Staff', 'Manager goodwill', 'Price match'];
function discountRules(settings) {
  const reasons = String(settings.discount_reasons || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  return {
    reasons: reasons.length ? reasons : DEFAULT_DISCOUNT_REASONS,
    thresholdAmount: Number.isFinite(Number(settings.discount_pin_threshold_amount)) && settings.discount_pin_threshold_amount !== '' ? Number(settings.discount_pin_threshold_amount) : 10,
    thresholdPercent: Number.isFinite(Number(settings.discount_pin_threshold_percent)) && settings.discount_pin_threshold_percent !== '' ? Number(settings.discount_pin_threshold_percent) : 20,
  };
}
// Validate a discount spec { type: percent|fixed, value, reason } against a base amount.
// Returns { type, value, reason, amount } or null when absent; throws 400 when malformed.
function applyDiscount(spec, base, rules, what) {
  if (!spec || spec.type == null) return null;
  const type = spec.type === 'percent' ? 'percent' : spec.type === 'fixed' ? 'fixed' : null;
  const value = Number(spec.value);
  if (!type || !Number.isFinite(value) || value <= 0) throw httpError(400, `${what}: discount needs a type (percent/fixed) and a positive value`);
  if (type === 'percent' && value > 100) throw httpError(400, `${what}: percent discount cannot exceed 100`);
  const reason = String(spec.reason || '').trim();
  if (!reason || !rules.reasons.includes(reason)) throw httpError(400, `${what}: pick a discount reason (${rules.reasons.join(', ')})`);
  const amount = type === 'percent' ? +(base * value / 100).toFixed(2) : +Math.min(value, base).toFixed(2);
  return { type, value: +value.toFixed(2), reason, amount };
}

// Prep screen feed (SIAMSHOP-505): orders from the last 12h that contain at
// least one made-to-order (kind='food') line, are paid (or till sales), not
// cancelled and not yet done. Food lines carry their options; grocery lines
// are counted, not listed — the counter doesn't pack shelf items.
app.get('/api/prep', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows: orders } = await pool.query(
      `SELECT o.id, o.channel, o.source, o.status, o.fulfilment, o.pickup_at, o.ready_at, o.prep_status,
              o.notes, o.created_at, o.payment_status, c.name AS customer_name
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.shop_id = $1
         AND o.created_at > NOW() - INTERVAL '12 hours'
         AND o.status <> 'cancelled'
         AND o.prep_status IS DISTINCT FROM 'done'
         AND (o.payment_status = 'paid' OR o.channel = 'instore')
         AND EXISTS (SELECT 1 FROM order_items oi JOIN products p ON p.id = oi.product_id
                      WHERE oi.order_id = o.id AND p.kind = 'food')
       ORDER BY o.pickup_at NULLS FIRST, o.created_at`,
      [shopId]
    );
    if (orders.length === 0) return res.json({ orders: [], server_time: new Date().toISOString() });
    const ids = orders.map((o) => o.id);
    const { rows: items } = await pool.query(
      `SELECT oi.order_id, oi.name_snapshot, oi.qty, oi.options_snapshot, COALESCE(p.kind, 'retail') AS kind
       FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ANY($1::int[]) ORDER BY oi.id`,
      [ids]
    );
    const byOrder = new Map(orders.map((o) => [o.id, { ...o, food: [], grocery_count: 0 }]));
    for (const it of items) {
      const o = byOrder.get(it.order_id);
      if (it.kind === 'food') o.food.push({ name: it.name_snapshot, qty: it.qty, options: it.options_snapshot || [] });
      else o.grocery_count += it.qty;
    }
    const s = await getSettings(shopId);
    const tz = s.timezone || availability.TZ_DEFAULT;
    const out = [...byOrder.values()].map((o) => ({
      ...o,
      customer_name: o.customer_name ? String(o.customer_name).split(' ')[0] : null,
      pickup_label: o.pickup_at ? availability.labelFor(o.pickup_at, tz) : null,
    }));
    res.json({ orders: out, server_time: new Date().toISOString() });
  } catch (err) {
    console.error('[prep]', err.message);
    res.status(500).json({ error: 'Failed to load prep queue' });
  }
});

// Prep state transitions: preparing → ready → done.
app.post('/api/prep/:id/status', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const next = String(req.body?.prep_status || '');
    let order;
    if (next === 'preparing') {
      ({ rows: [order] } = await pool.query(
        `UPDATE orders SET prep_status = 'preparing' WHERE id = $1 AND shop_id = $2 AND prep_status IS DISTINCT FROM 'done' RETURNING *`,
        [req.params.id, shopId]
      ));
    } else if (next === 'ready') {
      order = await markOrderReady(shopId, req.params.id, originFromReq(req));
    } else if (next === 'done') {
      order = await markOrderCollected(shopId, req.params.id);
    } else {
      return res.status(400).json({ error: 'prep_status must be preparing, ready or done' });
    }
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    console.error('[prep status]', err.message);
    res.status(500).json({ error: 'Failed to update prep status' });
  }
});

// Mark a (bank-transfer) order paid — fulfils it: decrements stock + emails.
app.post('/api/admin/orders/:id/mark-paid', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(`SELECT id FROM orders WHERE id = $1 AND shop_id = $2`, [req.params.id, shopId]);
    if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
    const r = await fulfilOrder(Number(req.params.id), originFromReq(req));
    if (!r.ok) return res.status(500).json({ error: r.reason || 'Failed to mark paid' });
    const { rows: updated } = await pool.query(`SELECT * FROM orders WHERE id = $1`, [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    console.error('[admin/orders mark-paid]', err.message);
    res.status(500).json({ error: 'Failed to mark paid' });
  }
});

// ---------------------------------------------------------------------------
// Admin dashboard — the EPOS back-office overview (SIAMSHOP-401/402)
// ---------------------------------------------------------------------------
app.get('/api/admin/dashboard', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const LOW_STOCK = Number(req.query.low || 5);

    // Sales totals over rolling periods (paid orders only), in one pass.
    const sales = (await pool.query(
      `SELECT
         COALESCE(SUM(total) FILTER (WHERE created_at >= date_trunc('day',   now())),0)::numeric  AS day_gross,
         COUNT(*)            FILTER (WHERE created_at >= date_trunc('day',   now()))              AS day_count,
         COALESCE(SUM(total) FILTER (WHERE created_at >= date_trunc('week',  now())),0)::numeric  AS week_gross,
         COUNT(*)            FILTER (WHERE created_at >= date_trunc('week',  now()))              AS week_count,
         COALESCE(SUM(total) FILTER (WHERE created_at >= date_trunc('month', now())),0)::numeric  AS month_gross,
         COUNT(*)            FILTER (WHERE created_at >= date_trunc('month', now()))              AS month_count,
         COALESCE(SUM(total),0)::numeric AS all_gross,
         COUNT(*)                        AS all_count
       FROM orders WHERE shop_id = $1 AND payment_status = 'paid'`,
      [shopId]
    )).rows[0];

    // Sales by channel (paid, all-time).
    const byChannel = (await pool.query(
      `SELECT channel, COUNT(*)::int AS count, COALESCE(SUM(total),0)::numeric AS gross
       FROM orders WHERE shop_id = $1 AND payment_status = 'paid'
       GROUP BY channel ORDER BY gross DESC`,
      [shopId]
    )).rows;

    // Catalogue + fulfilment counts.
    const counts = (await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM products WHERE shop_id = $1)                                          AS products,
         (SELECT COUNT(*) FROM products WHERE shop_id = $1 AND is_active)                             AS active_products,
         (SELECT COUNT(*) FROM products WHERE shop_id = $1 AND track_stock AND stock_qty <= 0)        AS out_of_stock,
         (SELECT COUNT(*) FROM orders   WHERE shop_id = $1 AND status = 'pending' AND payment_status='paid') AS to_dispatch,
         (SELECT COUNT(*) FROM orders   WHERE shop_id = $1 AND payment_status = 'pending')            AS awaiting_payment`,
      [shopId]
    )).rows[0];

    // Low-stock alerts.
    const lowStock = (await pool.query(
      `SELECT id, name, stock_qty, unit FROM products
       WHERE shop_id = $1 AND track_stock AND stock_qty <= $2
       ORDER BY stock_qty ASC, name LIMIT 12`,
      [shopId, LOW_STOCK]
    )).rows;

    // Recent orders.
    const recent = (await pool.query(
      `SELECT o.id, o.channel, o.status, o.payment_status, o.total, o.created_at,
              c.name AS customer_name
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.shop_id = $1 ORDER BY o.created_at DESC LIMIT 8`,
      [shopId]
    )).rows;

    // Top-selling products (paid orders, all-time) by revenue.
    const topProducts = (await pool.query(
      `SELECT oi.product_id, oi.name_snapshot AS name,
              SUM(oi.qty)::int AS qty, SUM(oi.line_total)::numeric AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.shop_id = $1 AND o.payment_status = 'paid'
       GROUP BY oi.product_id, oi.name_snapshot
       ORDER BY revenue DESC, qty DESC LIMIT 8`,
      [shopId]
    )).rows;

    // Last 7 days of sales, zero-filled (paid orders).
    const sales7d = (await pool.query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS date,
              COALESCE(SUM(o.total), 0)::numeric AS gross,
              COUNT(o.id)::int AS count
       FROM generate_series(date_trunc('day', now()) - interval '6 days',
                            date_trunc('day', now()), interval '1 day') d
       LEFT JOIN orders o
         ON o.shop_id = $1 AND o.payment_status = 'paid'
        AND date_trunc('day', o.created_at) = d
       GROUP BY d ORDER BY d`,
      [shopId]
    )).rows;

    res.json({
      sales: {
        day:   { gross: Number(sales.day_gross),   count: Number(sales.day_count) },
        week:  { gross: Number(sales.week_gross),  count: Number(sales.week_count) },
        month: { gross: Number(sales.month_gross), count: Number(sales.month_count) },
        all:   { gross: Number(sales.all_gross),   count: Number(sales.all_count) },
      },
      by_channel: byChannel.map((r) => ({ channel: r.channel, count: r.count, gross: Number(r.gross) })),
      counts: {
        products: Number(counts.products),
        active_products: Number(counts.active_products),
        out_of_stock: Number(counts.out_of_stock),
        to_dispatch: Number(counts.to_dispatch),
        awaiting_payment: Number(counts.awaiting_payment),
      },
      low_stock: lowStock,
      recent_orders: recent,
      low_stock_threshold: LOW_STOCK,
      top_products: topProducts.map((r) => ({ product_id: r.product_id, name: r.name, qty: r.qty, revenue: Number(r.revenue) })),
      sales_7d: sales7d.map((r) => ({ date: r.date, gross: Number(r.gross), count: r.count })),
    });
  } catch (err) {
    console.error('[admin/dashboard]', err.message);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// Date-range sales report (paid orders). ?from=YYYY-MM-DD&to=YYYY-MM-DD;
// defaults to the last 30 days when omitted.
app.get('/api/admin/report', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const from = String(req.query.from || '').trim() || null;
    const to = String(req.query.to || '').trim() || null;
    // Shared date bounds: created_at in [from, to] inclusive (paid orders).
    const WHERE = `o.shop_id = $1 AND o.payment_status = 'paid'
       AND o.created_at >= COALESCE($2::date, (date_trunc('day', now()) - interval '29 days')::date)
       AND o.created_at <  COALESCE($3::date, date_trunc('day', now())::date) + interval '1 day'`;
    const args = [shopId, from, to];

    const range = (await pool.query(
      `SELECT COALESCE($1::date, (date_trunc('day', now()) - interval '29 days')::date)::text AS from_date,
              COALESCE($2::date, date_trunc('day', now())::date)::text AS to_date`,
      [from, to]
    )).rows[0];

    const totals = (await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(o.total),0)::numeric AS gross,
              COALESCE(SUM(o.subtotal),0)::numeric AS subtotal, COALESCE(SUM(o.delivery_fee),0)::numeric AS delivery
       FROM orders o WHERE ${WHERE}`, args
    )).rows[0];

    const byChannel = (await pool.query(
      `SELECT o.channel, COUNT(*)::int AS count, COALESCE(SUM(o.total),0)::numeric AS gross
       FROM orders o WHERE ${WHERE} GROUP BY o.channel ORDER BY gross DESC`, args
    )).rows;

    const byPayment = (await pool.query(
      `SELECT COALESCE(o.payment_method,'—') AS payment_method, COUNT(*)::int AS count, COALESCE(SUM(o.total),0)::numeric AS gross
       FROM orders o WHERE ${WHERE} GROUP BY o.payment_method ORDER BY gross DESC`, args
    )).rows;

    const topProducts = (await pool.query(
      `SELECT oi.name_snapshot AS name, SUM(oi.qty)::int AS qty, COALESCE(SUM(oi.line_total),0)::numeric AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE ${WHERE} GROUP BY oi.name_snapshot ORDER BY revenue DESC LIMIT 15`, args
    )).rows;

    // Discounts (SIAMSHOP-DISCOUNT-001): line + basket, by reason and by staff.
    const discountsByReason = (await pool.query(
      `SELECT reason, SUM(cnt)::int AS count, COALESCE(SUM(amount),0)::numeric AS amount FROM (
         SELECT o.discount_reason AS reason, 1 AS cnt, o.discount_amount - COALESCE((SELECT SUM(oi.discount_amount) FROM order_items oi WHERE oi.order_id = o.id),0) AS amount
           FROM orders o WHERE ${WHERE} AND o.discount_reason IS NOT NULL
         UNION ALL
         SELECT oi.discount_reason, 1, oi.discount_amount FROM order_items oi JOIN orders o ON o.id = oi.order_id
           WHERE ${WHERE} AND oi.discount_reason IS NOT NULL
       ) d GROUP BY reason ORDER BY amount DESC`, args
    )).rows;
    const discountsByStaff = (await pool.query(
      `SELECT COALESCE(o.staff,'—') AS staff, COUNT(*)::int AS count, COALESCE(SUM(o.discount_amount),0)::numeric AS amount
       FROM orders o WHERE ${WHERE} AND o.discount_amount > 0 GROUP BY o.staff ORDER BY amount DESC`, args
    )).rows;
    const discountTotal = (await pool.query(`SELECT COALESCE(SUM(o.discount_amount),0)::numeric AS amount FROM orders o WHERE ${WHERE}`, args)).rows[0];

    res.json({
      discounts: { total: Number(discountTotal.amount), by_reason: discountsByReason, by_staff: discountsByStaff },
      from: range.from_date,
      to: range.to_date,
      totals: {
        count: Number(totals.count), gross: Number(totals.gross),
        subtotal: Number(totals.subtotal), delivery: Number(totals.delivery),
      },
      by_channel: byChannel.map((r) => ({ channel: r.channel, count: r.count, gross: Number(r.gross) })),
      by_payment: byPayment.map((r) => ({ payment_method: r.payment_method, count: r.count, gross: Number(r.gross) })),
      top_products: topProducts.map((r) => ({ name: r.name, qty: r.qty, revenue: Number(r.revenue) })),
    });
  } catch (err) {
    console.error('[admin/report]', err.message);
    res.status(500).json({ error: 'Failed to build report' });
  }
});

// ---------------------------------------------------------------------------
// Admin CRM — customers + spending (SIAMSHOP-006)
// ---------------------------------------------------------------------------
// Shared customer query — optionally filtered to marketing opt-ins.
async function queryCustomers(shopId, consentOnly) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.email, c.phone, c.marketing_consent, c.created_at,
            COUNT(o.id)::int AS order_count,
            COALESCE(SUM(o.total) FILTER (WHERE o.payment_status = 'paid'), 0)::numeric AS total_spent,
            MAX(o.created_at) AS last_order_at
     FROM customers c
     LEFT JOIN orders o ON o.customer_id = c.id
     WHERE c.shop_id = $1 ${consentOnly ? 'AND c.marketing_consent = TRUE' : ''}
     GROUP BY c.id
     ORDER BY total_spent DESC, c.created_at DESC
     LIMIT 2000`,
    [shopId]
  );
  return rows.map((r) => ({ ...r, total_spent: Number(r.total_spent) }));
}

const consentParam = (req) => ['1', 'true', 'yes'].includes(String(req.query.consent || '').toLowerCase());

app.get('/api/admin/customers', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    res.json(await queryCustomers(shopId, consentParam(req)));
  } catch (err) {
    console.error('[admin/customers]', err.message);
    res.status(500).json({ error: 'Failed to load customers' });
  }
});

// Export customers as CSV (respects ?consent=1 for marketing opt-ins only).
app.get('/api/admin/customers.csv', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const rows = await queryCustomers(shopId, consentParam(req));
    const cols = ['id', 'name', 'email', 'phone', 'marketing_consent', 'order_count', 'total_spent', 'last_order_at', 'created_at'];
    const esc = (v) => {
      if (v == null) return '';
      const s = v instanceof Date ? v.toISOString() : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\r\n');
    const tag = consentParam(req) ? 'marketing-' : '';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="siamshop-${tag}customers-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[admin/customers.csv]', err.message);
    res.status(500).json({ error: 'Failed to export customers' });
  }
});

app.get('/api/admin/customers/:id', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.email, c.phone, c.marketing_consent, c.created_at,
              (c.password_hash IS NOT NULL) AS has_account,
              (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id)::int AS order_count,
              (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.customer_id = c.id AND o.payment_status='paid')::numeric AS total_spent
       FROM customers c WHERE c.id = $1 AND c.shop_id = $2`,
      [req.params.id, shopId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Customer not found' });
    const { rows: orders } = await pool.query(
      `SELECT id, channel, source, status, payment_status, payment_method, total, created_at
       FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.params.id]
    );
    res.json({ ...rows[0], total_spent: Number(rows[0].total_spent), orders });
  } catch (err) {
    console.error('[admin/customers/:id]', err.message);
    res.status(500).json({ error: 'Failed to load customer' });
  }
});

// Delete a customer (GDPR erasure). Their past orders are KEPT for sales/audit
// history but anonymised — orders.customer_id is set NULL automatically by the
// FK (ON DELETE SET NULL). Also clears any back-in-stock email signups for them.
app.delete('/api/admin/customers/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });

    const { rows } = await client.query(
      `SELECT id, email,
              (SELECT COUNT(*) FROM orders o WHERE o.customer_id = $1)::int AS order_count
       FROM customers WHERE id = $1 AND shop_id = $2`,
      [req.params.id, shopId]
    );
    const cust = rows[0];
    if (!cust) return res.status(404).json({ error: 'Customer not found' });

    await client.query('BEGIN');
    // Drop their back-in-stock signups (PII tied to their email).
    if (cust.email) {
      await client.query(
        `DELETE FROM stock_notifications WHERE shop_id = $1 AND LOWER(email) = LOWER($2)`,
        [shopId, cust.email]
      );
    }
    // Remove the customer; FK ON DELETE SET NULL anonymises their orders.
    await client.query(`DELETE FROM customers WHERE id = $1 AND shop_id = $2`, [req.params.id, shopId]);
    await client.query('COMMIT');

    res.json({ ok: true, anonymised_orders: cust.order_count });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin/customers DELETE]', err.message);
    res.status(500).json({ error: 'Failed to delete customer' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Stripe webhook (skeleton — full lifecycle in SIAMSHOP-009)
// ---------------------------------------------------------------------------
app.post('/api/stripe/webhook', async (req, res) => {
  let event;
  try {
    event = stripeService.constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    console.error('[stripe] webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Fulfil the order on successful payment: mark paid, decrement stock, email.
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata?.order_id;
    if (orderId && session.payment_status === 'paid') {
      const r = await fulfilOrder(Number(orderId), originFromReq(req));
      console.log('[stripe] fulfil order', orderId, r.ok ? (r.already ? '(already)' : 'OK') : 'FAILED');
    }
  }
  res.json({ received: true });
});

// ---------------------------------------------------------------------------
// Facebook Messenger bot (SIAMSHOP-011)
// ---------------------------------------------------------------------------
// Verification handshake (set the same verify token in the FB App webhook config).
app.get('/api/messenger/webhook', (req, res) => {
  const challenge = messenger.verifyChallenge(req.query);
  if (challenge) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// Incoming messages. Verify the signature, ack 200 fast (FB requires < 20s), then
// process each message asynchronously: parse -> price -> reply with checkout link.
app.post('/api/messenger/webhook', async (req, res) => {
  const raw = req.body; // Buffer, from express.raw above
  console.log('[messenger] POST received', raw && raw.length, 'bytes', {
    hasSecret: Boolean(process.env.MESSENGER_APP_SECRET),
    hasPageToken: Boolean(process.env.MESSENGER_PAGE_ACCESS_TOKEN),
    hasAnthropic: Boolean(process.env.ANTHROPIC_API_KEY),
  });
  if (!messenger.verifySignature(raw, req.headers['x-hub-signature-256'])) {
    console.warn('[messenger] signature check FAILED — rejecting (check MESSENGER_APP_SECRET)');
    return res.sendStatus(403);
  }
  res.sendStatus(200);

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    console.warn('[messenger] could not parse body', e.message);
    return;
  }
  if (payload.object !== 'page') {
    console.log('[messenger] ignoring object type:', payload.object);
    return;
  }
  const messages = messenger.extractMessages(payload);
  console.log('[messenger] extracted', messages.length, 'message(s)');
  if (messages.length === 0) return;
  const shopId = await getShopIdBySlug(process.env.DEFAULT_SHOP_SLUG || 'demo');
  if (!shopId) {
    console.warn('[messenger] no shop found for slug', process.env.DEFAULT_SHOP_SLUG || 'demo');
    return;
  }
  const baseUrl = originFromReq(req);
  for (const m of messages) {
    console.log('[messenger] handling message from', m.senderId, ':', m.text);
    handleMessengerOrder(shopId, m.senderId, m.text, baseUrl).catch((e) =>
      console.error('[messenger] handle', e.message)
    );
  }
});

// Admin-only tester for the order parser (so it can be exercised without FB).
app.post('/api/messenger/parse', requireAuth, async (req, res) => {
  if (!aiService.isConfigured()) {
    return res.status(503).json({ error: 'AI parsing not configured (ANTHROPIC_API_KEY unset).' });
  }
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows: catalogue } = await pool.query(
      `SELECT id, name, name_th FROM products WHERE shop_id = $1 AND is_active = TRUE`,
      [shopId]
    );
    const parsed = await aiService.parseOrderItems(String(req.body?.text || ''), catalogue);
    res.json(parsed);
  } catch (err) {
    console.error('[messenger/parse]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Optional: serve the built client if present (handy for a single-service demo;
// production frontend lives on Netlify).
// ---------------------------------------------------------------------------
const clientDist = path.join(__dirname, '../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3002;

initDB().finally(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log(`✅ SiamShop server running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/api/health`);
    console.log('');
  });
});
