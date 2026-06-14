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
