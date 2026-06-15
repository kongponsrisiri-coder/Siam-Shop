// SiamShop — Stripe integration.
// One lazily-instantiated Stripe client shared across the app (matching the
// SiamEPOS stripeClient pattern). Provides Checkout Session creation for
// SIAMSHOP-003 and webhook signature verification for SIAMSHOP-009.
//
// GOLDEN RULE (from CLAUDE.md): always verify payment server-side before
// fulfilling an order. Never trust client-reported amounts.

let _stripe = null;

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  if (!_stripe) {
    _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

function isConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

// Create a hosted Stripe Checkout Session for an order.
// lineItems: [{ name, amount_pence, qty }]  (amount_pence is per-unit, integer)
// Returns the Session (use .url to redirect the customer, .id + .payment_intent
// later for verification).
async function createCheckoutSession({ orderId, shopSlug, lineItems, deliveryFeePence = 0, customerEmail, origin }) {
  const stripe = getStripe();
  // Prefer the actual request origin (where the shopper is) so the post-payment
  // redirect always returns to the right place; fall back to FRONTEND_URL.
  const frontend = (origin || process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

  const line_items = lineItems.map((li) => ({
    quantity: li.qty,
    price_data: {
      currency: 'gbp',
      unit_amount: li.amount_pence,
      product_data: { name: li.name },
    },
  }));

  if (deliveryFeePence > 0) {
    line_items.push({
      quantity: 1,
      price_data: {
        currency: 'gbp',
        unit_amount: deliveryFeePence,
        product_data: { name: 'Delivery' },
      },
    });
  }

  return stripe.checkout.sessions.create({
    mode: 'payment',
    line_items,
    customer_email: customerEmail || undefined,
    success_url: `${frontend}/order/success?order=${orderId}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontend}/cart`,
    metadata: {
      product: 'siamshop',
      order_id: String(orderId),
      shop_slug: String(shopSlug || ''),
    },
  });
}

// Retrieve a session to confirm payment server-side before fulfilling.
async function retrieveSession(sessionId) {
  return getStripe().checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent'],
  });
}

// Verify a webhook payload signature. `rawBody` must be the raw Buffer (see the
// express.raw() registration in server.js, before express.json()).
function constructWebhookEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  // constructEvent is pure HMAC verification — it never calls the Stripe API,
  // so any key string is fine to instantiate the SDK here.
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_webhook_verify_only');
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = {
  getStripe,
  isConfigured,
  createCheckoutSession,
  retrieveSession,
  constructWebhookEvent,
};
