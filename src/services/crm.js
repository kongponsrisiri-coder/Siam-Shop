// SiamShop CRM + campaigns + automations (SIAMSHOP-CRM-001) — port of the
// restaurant's SEPOS-033 (customers view, consent, unsubscribe, Brevo
// campaigns, hourly triggers) onto SiamShop's real `customers` table.
//
// Everything is shop-scoped. "Eligible" = marketing_consent AND not
// unsubscribed AND has an email — the ONLY set any campaign or automation may
// email. No loyalty points (Korakot's hold, 5 Sep 2026).
const crypto = require('crypto');
const emailService = require('./emailService');

const DAY = 86400000;
const DEFAULT_LAPSED_DAYS = 45;   // grocery: restaurant uses 60
const DEFAULT_DAILY_CAP = 300;    // Brevo free tier

// Email transport is injectable so the test rig can capture sends.
let transport = (to, subject, html) => emailService.sendBrevoEmail(to, subject, html);
const sentLog = []; // used only by the fake transport
function useFakeTransport() {
  transport = async (to, subject, html) => { sentLog.push({ to, subject, html, at: new Date().toISOString() }); return { ok: true, fake: true }; };
}
function emailConfigured() { return !!process.env.BREVO_API_KEY || transport.name !== 'transport' && sentLog !== null && isFake(); }
function isFake() { return transport.toString().includes('sentLog'); }

// ── Customer aggregates ───────────────────────────────────────────────────────
// One row per customer with spend, dates, channels and their top products.
// Paid orders only; every channel (instore sales attached at the till, online).
async function customerRows(pool, shopId, { lapsedDays = DEFAULT_LAPSED_DAYS, id = null } = {}) {
  const params = [shopId];
  let where = 'c.shop_id = $1';
  if (id) { params.push(id); where += ` AND c.id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.email, c.phone, c.marketing_consent, c.consent_source, c.consent_at, c.unsubscribed_at,
            c.birthday, c.notes, c.created_at, (c.password_hash IS NOT NULL) AS has_account,
            COUNT(o.id) FILTER (WHERE o.payment_status = 'paid')::int AS order_count,
            COALESCE(SUM(o.total) FILTER (WHERE o.payment_status = 'paid'), 0)::numeric AS total_spent,
            MIN(o.created_at) FILTER (WHERE o.payment_status = 'paid') AS first_order_at,
            MAX(o.created_at) FILTER (WHERE o.payment_status = 'paid') AS last_order_at,
            COUNT(o.id) FILTER (WHERE o.payment_status = 'paid' AND o.channel = 'instore')::int AS instore_count,
            COUNT(o.id) FILTER (WHERE o.payment_status = 'paid' AND o.channel <> 'instore')::int AS online_count,
            COUNT(o.id) FILTER (WHERE o.payment_status = 'paid' AND o.fulfilment = 'delivery')::int AS postal_count,
            COUNT(o.id) FILTER (WHERE o.payment_status = 'paid' AND o.fulfilment = 'collection')::int AS collection_count
     FROM customers c
     LEFT JOIN orders o ON o.customer_id = c.id AND o.shop_id = c.shop_id
     WHERE ${where}
     GROUP BY c.id
     ORDER BY total_spent DESC, c.created_at DESC
     LIMIT 5000`, params
  );
  // Top products per customer (by quantity, then order count) — the point of a grocery CRM.
  const topParams = [shopId]; let topWhere = 'o.shop_id = $1 AND o.customer_id IS NOT NULL AND o.payment_status = \'paid\'';
  if (id) { topParams.push(id); topWhere += ` AND o.customer_id = $${topParams.length}`; }
  const { rows: tops } = await pool.query(
    `SELECT o.customer_id, oi.name_snapshot AS name, oi.product_id, SUM(oi.qty)::int AS qty, COUNT(DISTINCT o.id)::int AS orders
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE ${topWhere}
     GROUP BY o.customer_id, oi.name_snapshot, oi.product_id
     ORDER BY o.customer_id, qty DESC, orders DESC`, topParams
  );
  const topBy = new Map();
  for (const t of tops) {
    const arr = topBy.get(t.customer_id) || [];
    if (arr.length < 3) arr.push({ name: t.name, product_id: t.product_id, qty: t.qty, orders: t.orders });
    topBy.set(t.customer_id, arr);
  }
  const now = Date.now();
  return rows.map((r) => {
    const spend = Number(r.total_spent);
    const days = r.last_order_at ? Math.floor((now - new Date(r.last_order_at).getTime()) / DAY) : null;
    const ageDays = Math.floor((now - new Date(r.created_at).getTime()) / DAY);
    let status;
    if (days !== null && days > lapsedDays) status = 'Lapsed';
    else if (spend >= 300 || r.order_count >= 8) status = 'VIP';
    else if (r.order_count >= 2) status = 'Regular';
    else status = 'New';
    return {
      ...r,
      total_spent: spend,
      avg_basket: r.order_count ? +(spend / r.order_count).toFixed(2) : 0,
      days_since_last: days,
      is_new: ageDays <= 30 || (r.first_order_at && (now - new Date(r.first_order_at).getTime()) / DAY <= 30),
      unsubscribed: !!r.unsubscribed_at,
      eligible: !!r.marketing_consent && !r.unsubscribed_at && !!r.email,
      status,
      top_products: topBy.get(r.id) || [],
      channels: { instore: r.instore_count, online: r.online_count, postal: r.postal_count, collection: r.collection_count },
    };
  });
}

// Customer ids who bought from a category in the last N days.
async function boughtCategory(pool, shopId, categoryId, days = 90) {
  const { rows } = await pool.query(
    `SELECT DISTINCT o.customer_id FROM order_items oi
     JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
     WHERE o.shop_id = $1 AND o.customer_id IS NOT NULL AND o.payment_status = 'paid'
       AND p.category_id = $2 AND o.created_at >= NOW() - ($3 || ' days')::interval`, [shopId, categoryId, String(days)]
  );
  return new Set(rows.map((r) => r.customer_id));
}

// Segments: all | lapsed | new | vip | regular | consented | category:<id>
// Every segment is intersected with ELIGIBLE when `forSending` is true.
async function segmentCustomers(pool, shopId, segment = 'all', { lapsedDays, forSending = true } = {}) {
  const all = await customerRows(pool, shopId, { lapsedDays });
  let cat = null;
  const m = /^category:(\d+)$/.exec(String(segment || ''));
  if (m) cat = await boughtCategory(pool, shopId, Number(m[1]));
  return all.filter((c) => {
    if (forSending && !c.eligible) return false;
    switch (segment) {
      case 'all': return true;
      case 'consented': return c.eligible;
      case 'lapsed': return c.status === 'Lapsed';
      case 'new': return c.is_new;
      case 'vip': return c.status === 'VIP';
      case 'regular': return c.status === 'Regular';
      default: return cat ? cat.has(c.id) : false;
    }
  });
}

// ── Unsubscribe tokens (HMAC, shop-bound, no login) ───────────────────────────
function unsubSecret() { return process.env.UNSUB_SECRET || process.env.AUTH_SECRET || 'siamshop-dev-unsub-secret'; }
function unsubscribeToken(shopId, email) {
  const payload = `${shopId}:${String(email || '').trim().toLowerCase()}`;
  const mac = crypto.createHmac('sha256', unsubSecret()).update(payload).digest('base64url').slice(0, 22);
  return Buffer.from(payload).toString('base64url') + '.' + mac;
}
function parseUnsubscribeToken(token) {
  try {
    const [b64, mac] = String(token || '').split('.');
    if (!b64 || !mac) return null;
    const payload = Buffer.from(b64, 'base64url').toString('utf8');
    const expected = crypto.createHmac('sha256', unsubSecret()).update(payload).digest('base64url').slice(0, 22);
    if (expected.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
    const i = payload.indexOf(':');
    return { shopId: Number(payload.slice(0, i)), email: payload.slice(i + 1) };
  } catch { return null; }
}

// ── Email HTML ────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

// brand = { name, address, logoUrl, primary, accent, publicBase }
function buildCampaignEmail({ subject, body, customer, brand, unsubUrl }) {
  const primary = HEX.test(brand.primary || '') ? brand.primary : '#0D1B3E';
  const accent = HEX.test(brand.accent || '') ? brand.accent : '#C9A84C';
  const first = String(customer.name || '').trim().split(/\s+/)[0] || 'there';
  const personalised = String(body || '')
    .replace(/\{\{\s*name\s*\}\}/gi, esc(first))
    .replace(/\{\{\s*shop\s*\}\}/gi, esc(brand.name));
  const header = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" style="max-height:56px;max-width:260px;display:block;">`
    : `<span style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${accent};">${esc(brand.name)}</span>`;
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2328;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f5f5f5;padding:24px 0;"><tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;">
      <tr><td style="background:${primary};padding:22px 30px;">${header}</td></tr>
      <tr><td style="padding:30px;line-height:1.6;font-size:15px;">${personalised}</td></tr>
      <tr><td style="padding:18px 30px;background:#fafafa;border-top:1px solid #eee;font-size:11px;color:#888;line-height:1.5;">
        <div style="margin-bottom:6px;"><strong>${esc(brand.name)}</strong>${brand.address ? ' · ' + esc(brand.address) : ''}</div>
        <div>You're receiving this because you shop with us and agreed to hear from us.
          <a href="${esc(unsubUrl)}" style="color:#888;text-decoration:underline;">Unsubscribe</a> at any time.</div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

// ── Daily cap (Brevo) ─────────────────────────────────────────────────────────
async function sentToday(pool, shopId) {
  const { rows } = await pool.query(
    `SELECT COALESCE((SELECT SUM(sent_count) FROM campaigns WHERE shop_id = $1 AND created_at >= date_trunc('day', NOW())), 0)::int
          + COALESCE((SELECT COUNT(*) FROM automation_fires WHERE shop_id = $1 AND sent = TRUE AND created_at >= date_trunc('day', NOW())), 0)::int AS n`, [shopId]
  );
  return rows[0].n;
}
function dailyCap(settings) { const n = parseInt(settings.brevo_daily_cap, 10); return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CAP; }
function lapsedDaysOf(settings) { const n = parseInt(settings.crm_lapsed_days, 10); return Number.isFinite(n) && n > 0 ? n : DEFAULT_LAPSED_DAYS; }

// ── Sending ───────────────────────────────────────────────────────────────────
// Resolve the brand block once per send. `publicBase` = where unsubscribe/logo live.
function brandFor(shop, settings, publicBase) {
  return {
    name: settings.shop_display_name || shop.name || 'SiamShop',
    address: (settings.receipt_header || '').split(/\r?\n/)[0] || settings.collection_address || '',
    logoUrl: settings.brand_logo ? `${publicBase}/api/brand-logo?shop=${encodeURIComponent(shop.slug)}&v=${String(settings.brand_logo.length)}` : '',
    primary: settings.brand_primary, accent: settings.brand_accent,
    publicBase,
  };
}
function unsubUrlFor(publicBase, shopId, email) {
  return `${publicBase}/api/unsubscribe?token=${encodeURIComponent(unsubscribeToken(shopId, email))}`;
}

async function sendToCustomers(pool, { shop, settings, publicBase, recipients, subject, body }) {
  const brand = brandFor(shop, settings, publicBase);
  let sent = 0, failed = 0; const errors = [];
  for (const c of recipients) {
    const html = buildCampaignEmail({ subject, body, customer: c, brand, unsubUrl: unsubUrlFor(publicBase, shop.id, c.email) });
    try { await transport(c.email, subject, html); sent++; }
    catch (e) { failed++; if (errors.length < 5) errors.push(`${c.email}: ${e.message}`); }
  }
  return { sent, failed, errors };
}

// ── Automations (hourly) ──────────────────────────────────────────────────────
// Each trigger fires ONCE per entity (UNIQUE (shop, type, key)) and only for
// eligible customers. Templates + on/off live in shop_settings:
//   auto_lapsed_enabled / auto_lapsed_subject / auto_lapsed_body
//   auto_review_enabled / auto_review_subject / auto_review_body
//   auto_birthday_enabled / auto_birthday_subject / auto_birthday_body
const AUTOMATIONS = ['lapsed', 'review', 'birthday'];
const DEFAULT_TEMPLATES = {
  lapsed: { subject: 'We miss you at {{shop}}', body: '<p>Hi {{name}},</p><p>It has been a while since your last visit to {{shop}}. Fresh Thai vegetables, herbs and your favourites are in stock — come and see us, or order online.</p><p>See you soon,<br>The {{shop}} team</p>' },
  review: { subject: 'How was your order from {{shop}}?', body: '<p>Hi {{name}},</p><p>Your parcel from {{shop}} should have arrived. Did everything reach you in good shape? Reply to this email and let us know — and if you have a minute, a review helps other Thai food lovers find us.</p><p>Thank you,<br>The {{shop}} team</p>' },
  birthday: { subject: 'Happy birthday from {{shop}}! 🎂', body: '<p>Hi {{name}},</p><p>Happy birthday from all of us at {{shop}}! Show this email at the counter this month for a little something with your next shop.</p><p>Have a lovely day,<br>The {{shop}} team</p>' },
};
const enabled = (settings, k) => settings[`auto_${k}_enabled`] === '1' || settings[`auto_${k}_enabled`] === 'true';
const tpl = (settings, k) => ({ subject: settings[`auto_${k}_subject`] || DEFAULT_TEMPLATES[k].subject, body: settings[`auto_${k}_body`] || DEFAULT_TEMPLATES[k].body });

async function claimFire(pool, shopId, type, key, customerId) {
  // INSERT … ON CONFLICT DO NOTHING = atomic "have we done this?" (restaurant webhook_fires pattern)
  const { rows } = await pool.query(
    `INSERT INTO automation_fires (shop_id, event_type, entity_key, customer_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (shop_id, event_type, entity_key) DO NOTHING RETURNING id`, [shopId, type, key, customerId]
  );
  return rows[0]?.id || null;
}
async function finishFire(pool, id, ok, error) {
  await pool.query(`UPDATE automation_fires SET sent = $2, error = $3 WHERE id = $1`, [id, ok, error || null]);
}

// Run every automation for one shop. Returns { lapsed, review, birthday } counts.
async function runAutomationsForShop(pool, { shop, settings, publicBase, now = new Date() }) {
  const out = { lapsed: 0, review: 0, birthday: 0, skipped: [] };
  const brand = brandFor(shop, settings, publicBase);
  const lapsedDays = lapsedDaysOf(settings);
  const customers = await customerRows(pool, shop.id, { lapsedDays });
  const byId = new Map(customers.map((c) => [c.id, c]));
  const cap = dailyCap(settings);
  let used = await sentToday(pool, shop.id);
  const fire = async (type, key, c, subject, body) => {
    if (used >= cap) { out.skipped.push(`${type}:${key}:cap`); return; }
    const id = await claimFire(pool, shop.id, type, key, c.id);
    if (!id) return; // already fired
    const html = buildCampaignEmail({ subject, body, customer: c, brand, unsubUrl: unsubUrlFor(publicBase, shop.id, c.email) });
    const subj = subject.replace(/\{\{\s*shop\s*\}\}/gi, brand.name).replace(/\{\{\s*name\s*\}\}/gi, String(c.name || '').split(/\s+/)[0] || 'there');
    try { await transport(c.email, subj, html); await finishFire(pool, id, true); out[type]++; used++; }
    catch (e) { await finishFire(pool, id, false, e.message); }
  };
  if (enabled(settings, 'lapsed')) {
    const t = tpl(settings, 'lapsed');
    for (const c of customers) if (c.eligible && c.status === 'Lapsed') await fire('lapsed', `customer:${c.id}`, c, t.subject, t.body);
  }
  if (enabled(settings, 'review')) {
    const t = tpl(settings, 'review');
    // Postal orders dispatched at least a day ago (dispatch_date <= yesterday).
    const { rows } = await pool.query(
      `SELECT id, customer_id FROM orders WHERE shop_id = $1 AND status = 'dispatched' AND customer_id IS NOT NULL
         AND dispatch_date IS NOT NULL AND dispatch_date <= (($2::timestamptz AT TIME ZONE 'Europe/London')::date - 1)
         AND dispatch_date >= (($2::timestamptz AT TIME ZONE 'Europe/London')::date - 30)`, [shop.id, now.toISOString()]
    );
    for (const o of rows) { const c = byId.get(o.customer_id); if (c && c.eligible) await fire('review', `order:${o.id}`, c, t.subject, t.body); }
  }
  if (enabled(settings, 'birthday')) {
    const t = tpl(settings, 'birthday');
    const london = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
    const mmdd = `${String(london.getMonth() + 1).padStart(2, '0')}-${String(london.getDate()).padStart(2, '0')}`;
    for (const c of customers) if (c.eligible && c.birthday === mmdd) await fire('birthday', `customer:${c.id}:${london.getFullYear()}`, c, t.subject, t.body);
  }
  return out;
}

module.exports = {
  DEFAULT_LAPSED_DAYS, DEFAULT_DAILY_CAP, AUTOMATIONS, DEFAULT_TEMPLATES,
  customerRows, segmentCustomers, boughtCategory,
  unsubscribeToken, parseUnsubscribeToken,
  buildCampaignEmail, brandFor, unsubUrlFor, sendToCustomers,
  sentToday, dailyCap, lapsedDaysOf,
  runAutomationsForShop, useFakeTransport, sentLog, isFake,
};
