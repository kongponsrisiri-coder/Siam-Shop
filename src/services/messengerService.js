// SiamShop — Facebook Messenger integration (SIAMSHOP-011).
// Eliminates Raan Nuch's biggest pain: customers DM a freeform list of items and
// the owner manually types a bill. Here the bot parses the list (Claude), matches
// the catalogue, and replies with a ready-to-pay checkout link. No manual work.

const crypto = require('crypto');
const https = require('https');

const GRAPH_VERSION = 'v21.0';

function isConfigured() {
  return Boolean(process.env.MESSENGER_PAGE_ACCESS_TOKEN);
}

// Webhook verification handshake (GET). Returns the challenge to echo, or null.
function verifyChallenge(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token && token === process.env.MESSENGER_VERIFY_TOKEN) {
    return challenge;
  }
  return null;
}

// Verify the X-Hub-Signature-256 header against the raw request body using the
// app secret. If no app secret is configured (local dev), skip verification.
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.MESSENGER_APP_SECRET;
  if (!secret) return true; // dev: not configured
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(String(signatureHeader || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Extract incoming text messages from a webhook payload.
// Returns [{ senderId, text }].
function extractMessages(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const ev of entry.messaging || []) {
      if (ev.message && typeof ev.message.text === 'string' && ev.sender?.id) {
        out.push({ senderId: ev.sender.id, text: ev.message.text });
      }
    }
  }
  return out;
}

// Send a text reply via the Graph Send API.
function sendMessage(recipientId, text) {
  return new Promise((resolve, reject) => {
    const token = process.env.MESSENGER_PAGE_ACCESS_TOKEN;
    if (!token) {
      console.warn('[messenger] PAGE_ACCESS_TOKEN not set — would reply:', text);
      return resolve({ skipped: true });
    }
    const body = JSON.stringify({
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
      message: { text },
    });
    const req = https.request(
      {
        hostname: 'graph.facebook.com',
        path: `/${GRAPH_VERSION}/me/messages?access_token=${encodeURIComponent(token)}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true });
          else { console.error('[messenger] send error', res.statusCode, data); reject(new Error(data)); }
        });
      }
    );
    req.on('error', (e) => { console.error('[messenger] send req error', e.message); reject(e); });
    req.write(body);
    req.end();
  });
}

module.exports = { isConfigured, verifyChallenge, verifySignature, extractMessages, sendMessage };
