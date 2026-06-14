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
app.use(express.json({ limit: '5mb' }));

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

// Public product listing — active products only, optional category/search.
app.get('/api/products', async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });

    const params = [shopId];
    let sql = `SELECT id, name, name_th, description, price, stock_qty, category, image_url
               FROM products
               WHERE shop_id = $1 AND is_active = TRUE`;
    if (req.query.category) {
      params.push(req.query.category);
      sql += ` AND category = $${params.length}`;
    }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      sql += ` AND (name ILIKE $${params.length} OR name_th ILIKE $${params.length})`;
    }
    sql += ` ORDER BY category NULLS LAST, name`;
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
      `SELECT id, name, name_th, description, barcode, sku, unit, price, cost_price,
              stock_qty, category, image_url, is_active, created_at
       FROM products WHERE shop_id = $1 ORDER BY created_at DESC`,
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
    const { name, name_th, description, barcode, sku, unit, price, cost_price, stock_qty, category, image_url, is_active } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    const { rows } = await pool.query(
      `INSERT INTO products (shop_id, name, name_th, description, barcode, sku, unit, price, cost_price, stock_qty, category, image_url, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        shopId,
        String(name).trim(),
        name_th || null,
        description || null,
        barcode ? String(barcode).trim() : null,
        sku ? String(sku).trim() : null,
        unit || 'each',
        Number(price) || 0,
        Number(cost_price) || 0,
        Number.isInteger(stock_qty) ? stock_qty : Number(stock_qty) || 0,
        category || null,
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
    const { name, name_th, description, barcode, sku, unit, price, cost_price, stock_qty, category, image_url, is_active } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE products SET
         name = COALESCE($3, name),
         name_th = $4,
         description = $5,
         barcode = $6,
         sku = $7,
         unit = COALESCE($8, unit),
         price = COALESCE($9, price),
         cost_price = COALESCE($10, cost_price),
         stock_qty = COALESCE($11, stock_qty),
         category = $12,
         image_url = $13,
         is_active = COALESCE($14, is_active)
       WHERE id = $1 AND shop_id = $2
       RETURNING *`,
      [
        req.params.id,
        shopId,
        name != null ? String(name).trim() : null,
        name_th ?? null,
        description ?? null,
        barcode ? String(barcode).trim() : null,
        sku ? String(sku).trim() : null,
        unit ?? null,
        price != null ? Number(price) : null,
        cost_price != null ? Number(cost_price) : null,
        stock_qty != null ? Number(stock_qty) : null,
        category ?? null,
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
// Admin — orders (read-only in the scaffold; fulfilment is SIAMSHOP-005)
// ---------------------------------------------------------------------------
app.get('/api/admin/orders', requireAuth, async (req, res) => {
  try {
    const shopId = await resolveShopId(req);
    if (!shopId) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(
      `SELECT o.id, o.channel, o.status, o.payment_status, o.payment_method,
              o.subtotal, o.delivery_fee, o.total,
              o.created_at, o.fulfilled_at, c.name AS customer_name, c.email AS customer_email
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

  // SIAMSHOP-003/009 will fulfil orders here: on checkout.session.completed,
  // verify the amount server-side, mark the order paid, decrement stock, and
  // send confirmation emails. For now we just acknowledge receipt.
  console.log('[stripe] received event:', event.type);
  res.json({ received: true });
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
