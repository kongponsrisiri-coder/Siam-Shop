// SIAMSHOP-CHAT-001 — the record of shopping-assistant conversations, and the
// switch that lets a person take one over.
//
// Two rules shape this file. A conversation is kept whether the assistant or a
// person answered it, so the shop can read back what customers asked for. And
// while a person has the conversation, the assistant stays out of it — nothing
// is worse than a customer talking to a human and getting bot replies over the
// top (Korakot, 8 Sep).
const ROLES = ['customer', 'assistant', 'staff'];
const MODES = ['ai', 'human'];
const MAX_BODY = 8000;

const clean = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);

// One row per browser conversation. The key comes from the customer's own
// browser, so it is never trusted as anything but an opaque label.
async function ensureSession(pool, shopId, sessionKey, who = {}) {
  const key = String(sessionKey || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (!key) return null;
  const { rows } = await pool.query(
    `INSERT INTO chat_sessions (shop_id, session_key, customer_name, customer_email)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (shop_id, session_key) DO UPDATE
       SET last_message_at = NOW(),
           customer_name  = COALESCE(EXCLUDED.customer_name,  chat_sessions.customer_name),
           customer_email = COALESCE(EXCLUDED.customer_email, chat_sessions.customer_email)
     RETURNING *`,
    [shopId, key, clean(who.name, 200), clean(who.email, 200)]
  );
  return rows[0];
}

async function addMessage(pool, sessionId, role, body, staff = null) {
  if (!ROLES.includes(role)) throw new Error(`bad chat role: ${role}`);
  const text = String(body == null ? '' : body).slice(0, MAX_BODY);
  if (!text.trim()) return null;
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (session_id, role, body, staff) VALUES ($1,$2,$3,$4) RETURNING *`,
    [sessionId, role, text, clean(staff, 120)]
  );
  await pool.query(`UPDATE chat_sessions SET last_message_at = NOW() WHERE id = $1`, [sessionId]);
  return rows[0];
}

// What the customer's widget polls for: anything said since it last looked.
// Their own messages come back too, so a second tab stays in step.
async function messagesAfter(pool, sessionId, afterId = 0) {
  const { rows } = await pool.query(
    `SELECT id, role, body, staff, created_at FROM chat_messages
     WHERE session_id = $1 AND id > $2 ORDER BY id LIMIT 100`,
    [sessionId, Number(afterId) || 0]
  );
  return rows;
}

async function listSessions(pool, shopId, { limit = 50, cursor = null } = {}) {
  const { rows } = await pool.query(
    `SELECT s.*,
            (SELECT COUNT(*)::int FROM chat_messages m WHERE m.session_id = s.id) AS message_count,
            (SELECT m.body FROM chat_messages m WHERE m.session_id = s.id ORDER BY m.id DESC LIMIT 1) AS last_message,
            (SELECT m.role FROM chat_messages m WHERE m.session_id = s.id ORDER BY m.id DESC LIMIT 1) AS last_role
       FROM chat_sessions s
      WHERE s.shop_id = $1 AND ($2::timestamptz IS NULL OR s.last_message_at < $2)
      ORDER BY s.last_message_at DESC
      LIMIT $3`,
    [shopId, cursor, Math.min(200, Math.max(1, Number(limit) || 50))]
  );
  return rows;
}

async function transcript(pool, shopId, id) {
  const { rows } = await pool.query(`SELECT * FROM chat_sessions WHERE id = $1 AND shop_id = $2`, [id, shopId]);
  if (!rows[0]) return null;
  const { rows: messages } = await pool.query(
    `SELECT id, role, body, staff, created_at FROM chat_messages WHERE session_id = $1 ORDER BY id`, [id]
  );
  return { ...rows[0], messages };
}

// Taking over records who did it, so the transcript says who was answering.
async function setMode(pool, shopId, id, mode, staff) {
  if (!MODES.includes(mode)) throw new Error(`bad chat mode: ${mode}`);
  const { rows } = await pool.query(
    // $3 is both the value written and the thing compared, so it needs a cast —
    // Postgres cannot deduce one type for it otherwise.
    `UPDATE chat_sessions
        SET mode = $3::text,
            staff = CASE WHEN $3::text = 'human' THEN $4::text ELSE NULL END,
            taken_over_at = CASE WHEN $3::text = 'human' THEN NOW() ELSE NULL END
      WHERE id = $1 AND shop_id = $2
      RETURNING *`,
    [id, shopId, mode, clean(staff, 120)]
  );
  return rows[0] || null;
}

module.exports = { ROLES, MODES, ensureSession, addMessage, messagesAfter, listSessions, transcript, setMode };
