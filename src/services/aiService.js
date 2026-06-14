// SiamShop — AI features via the Anthropic API.
// SIAMSHOP-203: invoice scanner. A photo of a supplier invoice goes to Claude
// with a strict JSON schema; we get back structured line items (name, qty, unit
// cost, barcode) which the caller matches against the catalogue and applies as
// goods-in. Vision + structured outputs on the Messages API (single call).

let _client = null;

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  if (!_client) {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  }
  return _client;
}

// Strict schema for structured outputs. additionalProperties:false is required
// on every object; optional fields are simply left out of `required`.
const INVOICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    supplier: { type: 'string', description: 'Supplier / vendor name if visible' },
    lines: {
      type: 'array',
      description: 'One entry per product line on the invoice',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'Product description as printed' },
          qty: { type: 'integer', description: 'Quantity received (units)' },
          unit_cost: { type: 'number', description: 'Cost per unit in GBP if shown' },
          barcode: { type: 'string', description: 'EAN/UPC barcode if printed' },
        },
        required: ['name', 'qty'],
      },
    },
  },
  required: ['lines'],
};

const PROMPT = `You are reading a supplier delivery invoice for a Thai grocery shop.
Extract every product line item. For each line give the product name exactly as
printed, the quantity received as a whole number of units, the unit cost in GBP
if shown, and the barcode (EAN/UPC) if printed. Ignore totals, tax, delivery
charges, and non-product rows. If a value is not present, omit that field.`;

// Send an invoice image (base64, no data: prefix) and return { supplier, lines }.
async function extractInvoice(imageBase64, mediaType = 'image/jpeg') {
  const client = getClient();
  const message = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4096,
    output_config: { format: { type: 'json_schema', schema: INVOICE_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });

  if (message.stop_reason === 'refusal') {
    throw new Error('The image could not be processed.');
  }
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Could not read the invoice — try a clearer photo.');
  }
  return { supplier: parsed.supplier || null, lines: Array.isArray(parsed.lines) ? parsed.lines : [] };
}

module.exports = { isConfigured, extractInvoice };
