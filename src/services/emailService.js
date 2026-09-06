// SiamShop — Brevo transactional email.
// Adapted from the SiamEPOS sendBrevoEmail pattern: a thin https POST to the
// Brevo v3 API. No SDK dependency. Order-confirmation templates live here so
// SIAMSHOP-004 can call sendOrderConfirmation()/sendShopNotification() directly.

const https = require('https');

const FROM_EMAIL = process.env.FROM_EMAIL || 'orders@siamshop.co.uk';
const FROM_NAME = process.env.FROM_NAME || 'SiamShop';

// Low-level send. Resolves on 2xx, rejects otherwise.
function sendBrevoEmail(to, subject, html) {
  return new Promise((resolve, reject) => {
    if (!process.env.BREVO_API_KEY) {
      console.warn('[email] BREVO_API_KEY not set — skipping email to', to);
      return resolve({ skipped: true });
    }

    const body = JSON.stringify({
      sender: { name: FROM_NAME, email: FROM_EMAIL },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    });

    const req = https.request(
      {
        hostname: 'api.brevo.com',
        path: '/v3/smtp/email',
        method: 'POST',
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log('✅ Email sent to ' + to);
            resolve({ ok: true });
          } else {
            console.error('❌ Brevo error ' + res.statusCode + ':', data);
            reject(new Error('Brevo error: ' + data));
          }
        });
      }
    );

    req.on('error', (err) => {
      console.error('❌ Email request error:', err.message);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

// Escape user-supplied strings before dropping them into HTML emails.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(n) {
  return '£' + Number(n || 0).toFixed(2);
}

// Chosen options (size / toppings / add-ons) shown under the item name.
function optionsLine(snapshot) {
  const list = Array.isArray(snapshot) ? snapshot : [];
  if (!list.length) return '';
  return `<div style="font-size:12px;color:#6b7280;">${esc(list.map((o) => o.name).join(', '))}</div>`;
}

function itemsTable(items) {
  const rows = (items || [])
    .map(
      (it) => `
      <tr>
        <td style="padding:6px 0;">${esc(it.name_snapshot || it.name)} × ${Number(it.qty)}${optionsLine(it.options_snapshot || it.options)}</td>
        <td style="padding:6px 0;text-align:right;vertical-align:top;">${money(it.line_total)}</td>
      </tr>`
    )
    .join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}</table>`;
}

// A "Track your order" button, if a status URL is provided.
function trackButton(statusUrl) {
  if (!statusUrl) return '';
  return `<p style="margin:18px 0;">
      <a href="${esc(statusUrl)}" style="background:#c8102e;color:#fff;text-decoration:none;
         padding:11px 18px;border-radius:8px;font-weight:600;display:inline-block;">Check your order status</a>
    </p>`;
}

// Collection (Click & Collect) vs delivery line for the templates (SIAMSHOP-504).
function fulfilmentBlock(order, verb = 'Delivering to') {
  if (order.fulfilment === 'collection') {
    return `<p style="font-size:14px;">
      <strong>Collection${order.pickup_label ? ` — ${esc(order.pickup_label)}` : ''}</strong>
      ${order.collection_address ? `<br>${esc(order.collection_address)}` : ''}
    </p>`;
  }
  return order.delivery_address ? `<p style="font-size:14px;">${verb}:<br>${esc(order.delivery_address)}</p>` : '';
}

// Payment-confirmed receipt. Sent when payment is confirmed — instantly for card,
// or when the shop marks a bank transfer as received. statusUrl is optional.
function sendOrderConfirmation(customerEmail, shopName, order, statusUrl) {
  const collection = order.fulfilment === 'collection';
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;">
      <h2>Payment received — your order is confirmed ✅</h2>
      <p>${esc(shopName)} has confirmed your order <strong>#${esc(order.id)}</strong>.
        ${collection ? "We'll email you when it's ready to collect." : "We'll let you know when it's dispatched."}</p>
      ${itemsTable(order.items)}
      <hr style="border:none;border-top:1px solid #eee;margin:12px 0;">
      <p style="font-size:14px;">
        Subtotal: ${money(order.subtotal)}<br>
        ${collection ? '' : `Delivery: ${money(order.delivery_fee)}<br>`}
        <strong>Total: ${money(order.total)}</strong>
      </p>
      ${fulfilmentBlock(order)}
      ${trackButton(statusUrl)}
      <p style="color:#888;font-size:12px;">SiamShop · Thai groceries, delivered.</p>
    </div>`;
  return sendBrevoEmail(customerEmail, `Order #${order.id} confirmed — ${shopName}`, html);
}

// Bank-transfer instructions. Sent when a bank-transfer order is placed, so the
// customer knows the amount + where to pay + the reference (order #).
function sendBankTransferInstructions(customerEmail, shopName, order, bankDetails, statusUrl) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;">
      <h2>Order received — please pay by bank transfer</h2>
      <p>${esc(shopName)} has received your order <strong>#${esc(order.id)}</strong>. To complete it,
        please transfer the total below and we'll confirm once payment arrives.</p>
      ${itemsTable(order.items)}
      <p style="font-size:15px;margin-top:10px;"><strong>Total to pay: ${money(order.total)}</strong></p>
      <div style="background:#fff8e1;border:1px solid #f2a900;border-radius:8px;padding:12px 14px;margin:14px 0;">
        <strong>Bank details</strong>
        <pre style="white-space:pre-wrap;font-family:inherit;margin:8px 0;font-size:14px;">${esc(bankDetails || 'Please contact the shop for bank details.')}</pre>
        Please use <strong>order #${esc(order.id)}</strong> as the payment reference.
      </div>
      ${fulfilmentBlock(order)}
      ${trackButton(statusUrl)}
      <p style="color:#888;font-size:12px;">SiamShop · Thai groceries, delivered.</p>
    </div>`;
  return sendBrevoEmail(customerEmail, `Order #${order.id} — please pay by bank transfer — ${shopName}`, html);
}

// Dispatch notification with tracking number. Sent when the shop marks the order
// dispatched. order = { id, tracking_number, dispatch_date, delivery_address }
function sendDispatchNotification(customerEmail, shopName, order, statusUrl, carrierUrl, carrierName) {
  const carrierBtn = carrierUrl
    ? `<p style="margin:14px 0;">
         <a href="${esc(carrierUrl)}" style="background:#1f2328;color:#fff;text-decoration:none;
            padding:11px 18px;border-radius:8px;font-weight:600;display:inline-block;">
            Track with ${esc(carrierName || 'the courier')} →</a>
       </p>`
    : '';
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;">
      <h2>Your order is on its way 📦</h2>
      <p>${esc(shopName)} has dispatched your order <strong>#${esc(order.id)}</strong>${carrierName ? ` via ${esc(carrierName)}` : ''}.</p>
      ${order.tracking_number ? `<p style="font-size:15px;">Tracking number: <strong>${esc(order.tracking_number)}</strong></p>` : ''}
      ${carrierBtn}
      ${order.delivery_address ? `<p style="font-size:14px;">Delivering to:<br>${esc(order.delivery_address)}</p>` : ''}
      ${trackButton(statusUrl)}
      <p style="color:#888;font-size:12px;">SiamShop · Thai groceries, delivered.</p>
    </div>`;
  return sendBrevoEmail(customerEmail, `Order #${order.id} dispatched — ${shopName}`, html);
}

// Shop owner notification of a new paid order.
function sendShopNotification(shopEmail, shopName, order) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;">
      <h2>New order #${esc(order.id)}${order.fulfilment === 'collection' ? ' — COLLECTION' : ''}</h2>
      ${itemsTable(order.items)}
      <p style="font-size:14px;"><strong>Total: ${money(order.total)}</strong></p>
      ${fulfilmentBlock(order, 'Deliver to')}
      ${order.notes ? `<p style="font-size:14px;">Notes: ${esc(order.notes)}</p>` : ''}
    </div>`;
  return sendBrevoEmail(shopEmail, `New order #${order.id} — ${shopName}`, html);
}

// "Ready to collect" (SIAMSHOP-504). order = { id, collection_address, pickup_label }
function sendOrderReady(customerEmail, shopName, order, statusUrl) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;">
      <h2>Your order is ready to collect 🛍️</h2>
      <p>${esc(shopName)} has your order <strong>#${esc(order.id)}</strong> ready${order.pickup_label ? ` for your ${esc(order.pickup_label)} pickup` : ''}.</p>
      ${order.collection_address ? `<p style="font-size:14px;">Collect from:<br>${esc(order.collection_address)}</p>` : ''}
      <p style="font-size:14px;">Please quote your order number at the counter.</p>
      ${trackButton(statusUrl)}
      <p style="color:#888;font-size:12px;">SiamShop</p>
    </div>`;
  return sendBrevoEmail(customerEmail, `Order #${order.id} is ready to collect — ${shopName}`, html);
}

// Report the current email configuration (for the admin diagnostics tool).
function getEmailConfig() {
  return {
    has_key: Boolean(process.env.BREVO_API_KEY),
    from_email: FROM_EMAIL,
    from_name: FROM_NAME,
  };
}

module.exports = {
  sendBrevoEmail, sendOrderConfirmation, sendBankTransferInstructions,
  sendDispatchNotification, sendShopNotification, sendOrderReady, getEmailConfig,
};
