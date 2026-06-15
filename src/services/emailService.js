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

function itemsTable(items) {
  const rows = (items || [])
    .map(
      (it) => `
      <tr>
        <td style="padding:6px 0;">${esc(it.name_snapshot || it.name)} × ${Number(it.qty)}</td>
        <td style="padding:6px 0;text-align:right;">${money(it.line_total)}</td>
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

// Payment-confirmed receipt. Sent when payment is confirmed — instantly for card,
// or when the shop marks a bank transfer as received. statusUrl is optional.
function sendOrderConfirmation(customerEmail, shopName, order, statusUrl) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;">
      <h2>Payment received — your order is confirmed ✅</h2>
      <p>${esc(shopName)} has confirmed your order <strong>#${esc(order.id)}</strong>. We'll let you know when it's dispatched.</p>
      ${itemsTable(order.items)}
      <hr style="border:none;border-top:1px solid #eee;margin:12px 0;">
      <p style="font-size:14px;">
        Subtotal: ${money(order.subtotal)}<br>
        Delivery: ${money(order.delivery_fee)}<br>
        <strong>Total: ${money(order.total)}</strong>
      </p>
      ${order.delivery_address ? `<p style="font-size:14px;">Delivering to:<br>${esc(order.delivery_address)}</p>` : ''}
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
      ${order.delivery_address ? `<p style="font-size:14px;">Delivering to:<br>${esc(order.delivery_address)}</p>` : ''}
      ${trackButton(statusUrl)}
      <p style="color:#888;font-size:12px;">SiamShop · Thai groceries, delivered.</p>
    </div>`;
  return sendBrevoEmail(customerEmail, `Order #${order.id} — please pay by bank transfer — ${shopName}`, html);
}

// Dispatch notification with tracking number. Sent when the shop marks the order
// dispatched. order = { id, tracking_number, dispatch_date, delivery_address }
function sendDispatchNotification(customerEmail, shopName, order, statusUrl) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;">
      <h2>Your order is on its way 📦</h2>
      <p>${esc(shopName)} has dispatched your order <strong>#${esc(order.id)}</strong>.</p>
      ${order.tracking_number ? `<p style="font-size:15px;">Tracking number: <strong>${esc(order.tracking_number)}</strong></p>` : ''}
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
      <h2>New order #${esc(order.id)}</h2>
      ${itemsTable(order.items)}
      <p style="font-size:14px;"><strong>Total: ${money(order.total)}</strong></p>
      ${order.delivery_address ? `<p style="font-size:14px;">Deliver to:<br>${esc(order.delivery_address)}</p>` : ''}
      ${order.notes ? `<p style="font-size:14px;">Notes: ${esc(order.notes)}</p>` : ''}
    </div>`;
  return sendBrevoEmail(shopEmail, `New order #${order.id} — ${shopName}`, html);
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
  sendDispatchNotification, sendShopNotification, getEmailConfig,
};
