// SiamShop — Express app entry point.
// Backend for the Thai-supermarket e-commerce platform. Postgres + Stripe +
// Brevo. Multi-tenant from day one: every data query is scoped to a shop_id.
//
// SIAMSHOP-001 scaffold: boots the DB, exposes health + a default-shop lookup,
// HMAC admin auth, product read/CRUD, order listing, and a Stripe webhook
// skeleton. Catalogue UX (002), checkout (003) and emails (004) build on this.

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const { pool, initDB, getShopIdBySlug } = require('./db/database');
const stripeService = require('./services/stripeService');
const aiService = require('./services/aiService');
const delivery = require('./services/delivery');
const messenger = require('./services/messengerService');
const emailService = require('./services/emailService');

const app = express();

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

// Route gate for admin endpoints. Every admin endpoint must use this.
function requireAuth(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  const payload = m ? verifyToken(m[1]) : null;
  if (!payload) {
    return res.status(401).json({ error: 'Not authenticated — please sign in again.' });
  }
  req.auth = payload;
  next();
}

// Small helper to throw an error that carries an HTTP status through a try/catch
// (used inside transactions so a failed line rolls the whole sale back).
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

// Create a PENDING online order from a basket. Recomputes all prices and the
// delivery fee server-side (never trusts the client), enforces the minimum
// order, and writes order + items. Stock is NOT decremented here — that happens
// on fulfilment (payment confirmed). Shared by website checkout, bank transfer,
// and (later) the Messenger bot. Returns { orderId, subtotal, deliveryFee, total }.
async function createPendingOrder(client, shopId, body, { paymentMethod, source }) {
  const items = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0) throw httpError(400, 'Your basket is empty');

  const settings = await getSettings(shopId);
  const quote = quoteDelivery(settings, body?.postcode);
  if (!quote) throw httpError(400, 'Enter a valid UK postcode for delivery');

  // Recompute subtotal from live prices + snapshot each line.
  let subtotal = 0;
  const lines = [];
  for (const it of items) {
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw httpError(400, 'Invalid quantity');
    const { rows } = await client.query(
      `SELECT id, name, price FROM products WHERE id = $1 AND shop_id = $2 AND is_active = TRUE`,
      [it.product_id, shopId]
    );
    const p = rows[0];
    if (!p) throw httpError(404, `Product ${it.product_id} is unavailable`);
    const lineTotal = Number(p.price) * qty;
    subtotal += lineTotal;
    lines.push({ product: p, qty, lineTotal });
  }

  const minOrder = Number(settings.minimum_order_amount || 0);
  if (subtotal < minOrder) {
    throw httpError(400, `Minimum order is £${minOrder.toFixed(2)} (your items total £${subtotal.toFixed(2)})`);
  }

  const deliveryFee = quote.fee;
  const total = subtotal + deliveryFee;
  const customerId = await upsertCustomer(client, shopId, body?.customer);

  const orderRes = await client.query(
    `INSERT INTO orders (shop_id, customer_id, channel, source, status, subtotal, delivery_fee, total,
                         payment_method, payment_status, delivery_address, notes)
     VALUES ($1,$2,'online',$3,'pending',$4,$5,$6,$7,'pending',$8,$9)
     RETURNING id, created_at`,
    [shopId, customerId, source, subtotal, deliveryFee, total, paymentMethod,
     body?.delivery_address || null, body?.notes || null]
  );
  const orderId = orderRes.rows[0].id;

  for (const ln of lines) {
    await client.query(
      `INSERT INTO order_items (order_id, product_id, name_snapshot, price_snapshot, qty, line_total)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [orderId, ln.product.id, ln.product.name, ln.product.price, ln.qty, ln.lineTotal]
    );
  }

  return { orderId, subtotal, deliveryFee, total, created_at: orderRes.rows[0].created_at };
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
      `SELECT product_id, name_snapshot, qty, line_total FROM order_items WHERE order_id = $1`,
      [orderId]
    );
    for (const it of items) {
      if (!it.product_id) continue;
      await client.query(
        `UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2 AND track_stock = TRUE`,
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
function buildCartLink(lines) {
  const frontend = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
  const compact = lines.map((l) => ({ id: l.product_id, qty: l.qty }));
  const b64 = Buffer.from(JSON.stringify(compact)).toString('base64url');
  return `${frontend}/cart?cart=${b64}&src=messenger`;
}

// Parse a customer's Messenger order message, price it, and reply with a summary
// + a ready-to-checkout link. This is the manual-bill-typing eliminator.
async function handleMessengerOrder(shopId, senderId, text) {
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
    buildCartLink(lines);

  await messenger.sendMessage(senderId, reply);
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
app.post('/api/admin/login', (req, res) => {
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
  res.json({ role: req.auth.role, expiresAt: req.auth.exp });
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
    res.json({
      minimum_order_amount: Number(s.minimum_order_amount || 0),
      delivery_fee_london: Number(s.delivery_fee_london || 0),
      delivery_fee_mainland: Number(s.delivery_fee_mainland || 0),
      delivery_fee_remote: Number(s.delivery_fee_remote || 0),
      restock_day: s.restock_day || null,
      currency: s.currency || 'GBP',
      shop_language_default: s.shop_language_default || 'en',
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
      `SELECT id, name, name_th, sort_order FROM categories WHERE shop_id = $1 ORDER BY sort_order, name`,
      [shopId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[categories]', err.message);
    res.status(500).json({ error: 'Failed to load categories' });
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
        `SELECT name_snapshot AS name, price_snapshot, qty FROM order_items WHERE order_id = $1`,
        [order.orderId]
      )).rows.map((r) => ({ name: r.name, amount_pence: Math.round(Number(r.price_snapshot) * 100), qty: r.qty })),
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
          `SELECT name_snapshot, qty, line_total FROM order_items WHERE order_id = $1`, [order.orderId]
        );
        await emailService.sendBankTransferInstructions(
          email,
          shopRows[0]?.name || 'SiamShop',
          { id: order.orderId, total: order.total, items, delivery_address: req.body?.delivery_address },
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
app.get('/api/orders/:id', async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const provided = String(req.query.email || '').trim().toLowerCase();
    let { rows } = await pool.query(
      `SELECT o.id, o.status, o.payment_status, o.payment_method, o.subtotal, o.delivery_fee, o.total,
              o.delivery_address, o.stripe_payment_intent_id, o.tracking_number, o.created_at,
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
                    delivery_address, tracking_number, created_at
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
      `SELECT name_snapshot, qty, line_total FROM order_items WHERE order_id = $1`,
      [order.id]
    );
    res.json({ ...order, items });
  } catch (err) {
    console.error('[orders GET]', err.message);
    res.status(500).json({ error: 'Failed to load order' });
  }
});

// Public product listing — active products only, optional category/search.
app.get('/api/products', async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });

    const params = [shopId];
    let sql = `SELECT p.id, p.name, p.name_th, p.description, p.description_th, p.price,
                      p.stock_qty, p.track_stock, p.image_url, p.weight_grams,
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
    res.json(rows);
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
      `SELECT id, name, name_th, barcode, sku, unit, price, stock_qty
       FROM products
       WHERE shop_id = $1 AND is_active = TRUE AND (barcode = $2 OR sku = $2)
       LIMIT 1`,
      [shopId, code]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No product with that barcode' });
    res.json(rows[0]);
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
      `SELECT id, name, name_th, description, price, stock_qty, category, image_url
       FROM products
       WHERE id = $1 AND shop_id = $2 AND is_active = TRUE`,
      [req.params.id, shopId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[product]', err.message);
    res.status(500).json({ error: 'Failed to load product' });
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
              p.price, p.cost_price, p.stock_qty, p.track_stock, p.weight_grams, p.sort_order,
              p.category_id, c.name AS category, p.image_url, p.is_active, p.created_at
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.shop_id = $1 ORDER BY p.created_at DESC`,
      [shopId]
    );
    res.json(rows);
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
            stock_qty, track_stock, weight_grams, sort_order, category_id, image_url, is_active } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    const { rows } = await pool.query(
      `INSERT INTO products (shop_id, name, name_th, description, description_th, barcode, sku, unit,
                             price, cost_price, stock_qty, track_stock, weight_grams, sort_order,
                             category_id, image_url, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
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
            stock_qty, track_stock, weight_grams, sort_order, category_id, image_url, is_active } = req.body || {};
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
         is_active = COALESCE($18, is_active)
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
app.post('/api/admin/categories', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { name, name_th, sort_order } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    const { rows } = await pool.query(
      `INSERT INTO categories (shop_id, name, name_th, sort_order) VALUES ($1,$2,$3,$4) RETURNING *`,
      [shopId, String(name).trim(), name_th || null, Number(sort_order) || 0]
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
    const { rows } = await pool.query(
      `UPDATE categories SET name = COALESCE($3, name), name_th = $4, sort_order = COALESCE($5, sort_order)
       WHERE id = $1 AND shop_id = $2 RETURNING *`,
      [req.params.id, shopId, name != null ? String(name).trim() : null, name_th ?? null,
       sort_order != null ? Number(sort_order) : null]
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

  if (items.length === 0) return res.status(400).json({ error: 'Cart is empty' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock each product row, validate stock, compute the authoritative total.
    let subtotal = 0;
    const lines = [];
    for (const it of items) {
      const qty = Number(it.qty);
      if (!Number.isInteger(qty) || qty <= 0) throw httpError(400, 'Invalid quantity');
      const { rows } = await client.query(
        `SELECT id, name, price, stock_qty FROM products
         WHERE id = $1 AND shop_id = $2 AND is_active = TRUE FOR UPDATE`,
        [it.product_id, shopId]
      );
      const p = rows[0];
      if (!p) throw httpError(404, `Product ${it.product_id} not found`);
      if (p.stock_qty < qty) throw httpError(409, `Not enough stock for ${p.name} (${p.stock_qty} left)`);
      const lineTotal = Number(p.price) * qty;
      subtotal += lineTotal;
      lines.push({ product: p, qty, lineTotal });
    }

    const total = subtotal; // no delivery fee in-store
    let change = null;
    if (paymentMethod === 'cash' && tendered != null) {
      if (tendered < total) throw httpError(400, 'Amount tendered is less than the total');
      change = +(tendered - total).toFixed(2);
    }

    const orderRes = await client.query(
      `INSERT INTO orders (shop_id, channel, status, subtotal, total, payment_method,
                           amount_tendered, change_given, staff, payment_status, fulfilled_at)
       VALUES ($1,'instore','completed',$2,$3,$4,$5,$6,$7,'paid',NOW())
       RETURNING id, created_at`,
      [shopId, subtotal, total, paymentMethod, tendered, change, staff]
    );
    const orderId = orderRes.rows[0].id;

    for (const ln of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, name_snapshot, price_snapshot, qty, line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [orderId, ln.product.id, ln.product.name, ln.product.price, ln.qty, ln.lineTotal]
      );
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
      amount_tendered: tendered,
      change_given: change,
      created_at: orderRes.rows[0].created_at,
      items: lines.map((l) => ({ name: l.product.name, qty: l.qty, line_total: l.lineTotal })),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
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
      `SELECT name_snapshot, price_snapshot, qty, line_total FROM order_items WHERE order_id = $1`,
      [req.params.id]
    );
    res.json({ ...rows[0], items });
  } catch (err) {
    console.error('[admin/orders/:id]', err.message);
    res.status(500).json({ error: 'Failed to load order' });
  }
});

// Mark an order dispatched (+ optional tracking number).
app.post('/api/admin/orders/:id/dispatch', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `UPDATE orders SET status = 'dispatched', dispatch_date = COALESCE(dispatch_date, CURRENT_DATE),
              tracking_number = $3, fulfilled_at = NOW()
       WHERE id = $1 AND shop_id = $2 RETURNING *`,
      [req.params.id, shopId, req.body?.tracking_number || null]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
    const order = rows[0];
    res.json(order);

    // Notify the customer their order is on its way (best-effort).
    (async () => {
      try {
        const { shopName, customerEmail } = await orderEmailContext(order);
        if (customerEmail) {
          await emailService.sendDispatchNotification(
            customerEmail, shopName, order, orderStatusUrl(originFromReq(req), order.id, customerEmail)
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

    // If it was paid, the stock was decremented — put it back.
    if (order.payment_status === 'paid') {
      const { rows: items } = await client.query(
        `SELECT product_id, qty FROM order_items WHERE order_id = $1`, [order.id]
      );
      for (const it of items) {
        if (!it.product_id) continue;
        await client.query(
          `UPDATE products SET stock_qty = stock_qty + $1 WHERE id = $2 AND track_stock = TRUE`,
          [it.qty, it.product_id]
        );
        await client.query(
          `INSERT INTO stock_movements (shop_id, product_id, change_qty, reason, ref_order_id, staff)
           VALUES ($1,$2,$3,'refund',$4,$5)`,
          [shopId, it.product_id, it.qty, order.id, req.auth?.name || 'admin']
        );
      }
      await client.query(`UPDATE orders SET payment_status = 'refunded' WHERE id = $1`, [order.id]);
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

    res.json({
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
  if (!messenger.verifySignature(raw, req.headers['x-hub-signature-256'])) {
    return res.sendStatus(403);
  }
  res.sendStatus(200);

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return;
  }
  if (payload.object !== 'page') return;
  const messages = messenger.extractMessages(payload);
  if (messages.length === 0) return;
  const shopId = await getShopIdBySlug(process.env.DEFAULT_SHOP_SLUG || 'demo');
  if (!shopId) return;
  for (const m of messages) {
    handleMessengerOrder(shopId, m.senderId, m.text).catch((e) =>
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
