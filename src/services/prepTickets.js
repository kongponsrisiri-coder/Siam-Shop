// Prep tickets (SIAMSHOP-PRINTERS-001): one row per (order, prep printer),
// cloud-authoritative, printed exactly once by whichever till claims it.
// Port of the restaurant's till_send_lock idea onto a plain table.
//
// Routing: a prep printer with prep_categories = {} takes every made-to-order
// item (products.kind = 'food'); one scoped to categories takes items in those
// categories (any kind). A ticket is only created when the printer has ≥ 1 item.
const TAKEOVER_MS = 2 * 60 * 1000;   // an unprinted ticket from an offline till is taken over by the designated till
const RECLAIM_MS = 90 * 1000;        // a 'printing' claim older than this can be claimed again

async function enqueue(pool, shopId, orderId, { originDeviceId = null, seq = 0, printerId = null } = {}) {
  const { rows: printers } = await pool.query(
    `SELECT id, prep_categories FROM printers WHERE shop_id = $1 AND job = 'prep' AND active = TRUE ${printerId ? 'AND id = $2' : ''} ORDER BY id`,
    printerId ? [shopId, printerId] : [shopId]
  );
  if (!printers.length) return [];
  const { rows: items } = await pool.query(
    `SELECT oi.id, oi.qty, p.kind, p.category_id FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1`, [orderId]
  );
  const out = [];
  for (const pr of printers) {
    const cats = pr.prep_categories || [];
    const mine = items.filter((it) => (cats.length ? cats.includes(it.category_id) : it.kind === 'food'));
    if (!mine.length) continue;
    let s = seq;
    if (s > 0) {
      const { rows: mx } = await pool.query(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM prep_tickets WHERE shop_id = $1 AND order_id = $2 AND printer_id = $3`, [shopId, orderId, pr.id]);
      s = mx[0].next;
    }
    const { rows } = await pool.query(
      `INSERT INTO prep_tickets (shop_id, order_id, printer_id, seq, origin_device_id) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (shop_id, order_id, printer_id, seq) DO NOTHING RETURNING id, printer_id, seq`,
      [shopId, orderId, pr.id, s, originDeviceId]
    );
    if (rows[0]) out.push(rows[0]);
  }
  return out;
}

// Everything the printer needs — header + only the items this printer is scoped to.
async function payload(pool, shopId, ticketId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.seq, t.status, t.printer_id, t.order_id, pr.name AS printer_name, pr.prep_categories,
            o.channel, o.source, o.fulfilment, o.pickup_at, o.notes, o.created_at, o.staff, c.name AS customer_name, c.phone AS customer_phone,
            s.name AS shop_name
     FROM prep_tickets t JOIN printers pr ON pr.id = t.printer_id JOIN orders o ON o.id = t.order_id
     JOIN shops s ON s.id = t.shop_id LEFT JOIN customers c ON c.id = o.customer_id
     WHERE t.id = $1 AND t.shop_id = $2`, [ticketId, shopId]
  );
  const t = rows[0];
  if (!t) return null;
  const { rows: items } = await pool.query(
    `SELECT oi.name_snapshot AS name, oi.qty, oi.options_snapshot, p.kind, p.category_id, cat.name AS category
     FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id LEFT JOIN categories cat ON cat.id = p.category_id
     WHERE oi.order_id = $1 ORDER BY oi.id`, [t.order_id]
  );
  const cats = t.prep_categories || [];
  const mine = items.filter((it) => (cats.length ? cats.includes(it.category_id) : it.kind === 'food'));
  const others = items.length - mine.length;
  return {
    ticket_id: t.id, seq: t.seq, reprint: t.seq > 0, printer_id: t.printer_id, printer_name: t.printer_name,
    order_id: t.order_id, shop_name: t.shop_name, channel: t.channel, source: t.source, fulfilment: t.fulfilment,
    pickup_at: t.pickup_at, created_at: t.created_at, staff: t.staff, notes: t.notes,
    customer_name: t.customer_name, customer_phone: t.customer_phone,
    items: mine.map((it) => ({ name: it.name, qty: it.qty, options: (Array.isArray(it.options_snapshot) ? it.options_snapshot : []).map((o) => (typeof o === 'string' ? o : o.name)).filter(Boolean), category: it.category })),
    other_items: others,
  };
}

// Atomic claim: only ONE device wins a queued ticket (or a stale 'printing' one).
async function claim(pool, shopId, ticketId, deviceId) {
  const { rows } = await pool.query(
    `UPDATE prep_tickets SET status = 'printing', device_id = $3, claimed_at = NOW(), attempts = attempts + 1
     WHERE id = $1 AND shop_id = $2 AND (status = 'queued' OR status = 'failed' OR (status = 'printing' AND claimed_at < NOW() - ($4 || ' milliseconds')::interval))
     RETURNING id, attempts`, [ticketId, shopId, deviceId, String(RECLAIM_MS)]
  );
  return rows[0] || null;
}
async function ack(pool, shopId, ticketId, deviceId, ok, error) {
  const { rows } = await pool.query(
    `UPDATE prep_tickets SET status = CASE WHEN $4::boolean THEN 'printed' ELSE 'failed' END,
            printed_at = CASE WHEN $4::boolean THEN NOW() ELSE printed_at END, last_error = $5
     WHERE id = $1 AND shop_id = $2 AND device_id = $3 RETURNING id, status, attempts`,
    [ticketId, shopId, deviceId, !!ok, ok ? null : String(error || 'print failed').slice(0, 500)]
  );
  return rows[0] || null;
}

// What THIS device should print now: its own tills' tickets, plus — when it is
// the shop's designated printing till — online orders' tickets (no origin) and
// anything another till has left unprinted for > 2 minutes.
async function queueFor(pool, shopId, deviceId, { designated = false } = {}) {
  const { rows } = await pool.query(
    `SELECT t.id, t.order_id, t.printer_id, t.seq, t.status, t.attempts, t.origin_device_id, t.created_at
     FROM prep_tickets t WHERE t.shop_id = $1 AND t.status IN ('queued', 'failed')
       AND (t.origin_device_id = $2
            OR ($3 AND (t.origin_device_id IS NULL OR t.created_at < NOW() - ($4 || ' milliseconds')::interval)))
     ORDER BY t.created_at, t.id LIMIT 20`, [shopId, deviceId, designated, String(TAKEOVER_MS)]
  );
  return rows;
}

// Failed or long-queued tickets, for the "prep printer offline — tickets held" badge.
async function heldCount(pool, shopId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS held, MIN(created_at) AS oldest FROM prep_tickets WHERE shop_id = $1 AND status <> 'printed' AND created_at < NOW() - interval '45 seconds'`, [shopId]
  );
  return rows[0];
}

module.exports = { enqueue, payload, claim, ack, queueFor, heldCount, TAKEOVER_MS, RECLAIM_MS };
