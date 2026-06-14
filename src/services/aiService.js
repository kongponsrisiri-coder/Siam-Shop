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

// SIAMSHOP-011: parse a freeform customer order message (Thai or English) and
// match each requested item to the shop's catalogue. The model only does the
// hard NLP/matching; the reply text + pricing are built deterministically by the
// caller. catalogue = [{ id, name, name_th }].
const ORDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    language: { type: 'string', description: "'th' or 'en' — the customer's language" },
    items: {
      type: 'array',
      description: 'Requested items matched to a catalogue product id',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          product_id: { type: 'integer', description: 'Matching catalogue product id' },
          qty: { type: 'integer', description: 'Quantity requested (default 1)' },
        },
        required: ['product_id', 'qty'],
      },
    },
    unmatched: {
      type: 'array',
      description: 'Requested item names that did not match any catalogue product',
      items: { type: 'string' },
    },
  },
  required: ['language', 'items', 'unmatched'],
};

async function parseOrderItems(text, catalogue) {
  const client = getClient();
  const list = catalogue.map((c) => `${c.id}: ${c.name}${c.name_th ? ` / ${c.name_th}` : ''}`).join('\n');
  const message = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 2048,
    output_config: { format: { type: 'json_schema', schema: ORDER_SCHEMA } },
    messages: [
      {
        role: 'user',
        content:
          `A customer of a Thai grocery shop sent this order message (Thai or English):\n\n"""${text}"""\n\n` +
          `Match each requested item to one product from this catalogue (id: English / Thai name):\n${list}\n\n` +
          `Return matched items as {product_id, qty} (qty defaults to 1 if unspecified). Put any requested ` +
          `item you cannot confidently match into "unmatched" (as the customer's wording). Detect the language.`,
      },
    ],
  });
  if (message.stop_reason === 'refusal') throw new Error('Message could not be processed.');
  const out = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error('Could not parse the order message.');
  }
  return {
    language: parsed.language === 'th' ? 'th' : 'en',
    items: Array.isArray(parsed.items) ? parsed.items : [],
    unmatched: Array.isArray(parsed.unmatched) ? parsed.unmatched : [],
  };
}

// SIAMSHOP-008: generate product copy for the self-service admin. Given a name
// (English and/or Thai) + category, write a concise appealing English + Thai
// description, and suggest an English name when only a Thai one was entered.
const DESCRIBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'Suggested English name (echo the given one if already English)' },
    description: { type: 'string', description: 'Appealing English description, 1–2 sentences' },
    description_th: { type: 'string', description: 'Thai description, 1–2 sentences' },
  },
  required: ['name', 'description', 'description_th'],
};

async function generateProductContent({ name, name_th, category }) {
  const client = getClient();
  const message = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    output_config: { format: { type: 'json_schema', schema: DESCRIBE_SCHEMA } },
    messages: [
      {
        role: 'user',
        content:
          `Write shop copy for a Thai grocery product sold online in the UK.\n` +
          `English name: ${name || '(none — suggest one from the Thai name)'}\n` +
          `Thai name: ${name_th || '(none)'}\n` +
          `Category: ${category || '(uncategorised)'}\n\n` +
          `Return a concise, appetising English description and a Thai description ` +
          `(1–2 sentences each), and an English name (suggest one if only Thai was given, ` +
          `otherwise echo the English name). Do not invent specific prices, weights, or claims.`,
      },
    ],
  });
  if (message.stop_reason === 'refusal') throw new Error('Could not generate a description.');
  const out = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(out);
}

module.exports = { isConfigured, extractInvoice, parseOrderItems, generateProductContent };
