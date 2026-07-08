// Thai Tana — AI shopping assistant (SIAMSHOP-THAITANA-001 #2).
// Cloud-only, Haiku-class per the ticket. Answers product / delivery / allergen
// questions and turns a dish or recipe into a basket ("green curry" → the
// ingredients we stock). The live catalogue is passed as context each call, and
// an `add_to_basket` tool lets Claude propose products to add to the cart.

const MODEL = 'claude-haiku-4-5'; // ticket: "Cloud API only (Haiku-class)"

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

let _client = null;
function getClient() {
  if (!_client) {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  }
  return _client;
}

// Compact, model-friendly catalogue. Only in-scope fields, one line per product.
function catalogueText(products) {
  return products
    .map((p) => {
      const bits = [`#${p.id}`, p.name];
      if (p.name_th) bits.push(`(TH: ${p.name_th})`);
      bits.push(`£${Number(p.price).toFixed(2)}`);
      if (p.category) bits.push(`· ${p.category}`);
      if (p.track_stock && Number(p.stock_qty) <= 0) bits.push('· OUT OF STOCK');
      if (p.allergens) bits.push(`· allergens: ${p.allergens}`);
      return bits.join(' ');
    })
    .join('\n');
}

function basketText(basket, products) {
  const items = Array.isArray(basket) ? basket : [];
  if (items.length === 0) return 'The basket is currently EMPTY.';
  const byId = new Map(products.map((p) => [p.id, p]));
  return items
    .map((it) => {
      const p = byId.get(Number(it.id ?? it.product_id));
      const name = p ? p.name : (it.name || `#${it.id}`);
      const id = p ? p.id : (it.id ?? it.product_id);
      return `- #${id} ${name} ×${Math.max(1, Number(it.qty) || 1)}`;
    })
    .join('\n');
}

function systemPrompt(products, settings, shopName = 'SiamShop', basket = []) {
  const minOrder = Number(settings?.minimum_order_amount || 0);
  const freeOver = Number(settings?.free_delivery_over || 0);
  const restock = settings?.restock_day;
  const policy = [
    minOrder ? `Minimum order is £${minOrder.toFixed(2)}.` : '',
    freeOver ? `Delivery is free over £${freeOver.toFixed(0)}; otherwise it is a flat/zone fee shown at checkout.` : '',
    restock ? `Fresh stock refreshes every ${restock}.` : '',
    'Delivery is UK-wide by courier (Evri / Royal Mail / DPD), priced by weight at checkout.',
  ].filter(Boolean).join(' ');

  return [
    `You are the shopping assistant for ${shopName}, a Thai grocery shop. You help customers find products and build a basket, like a warm, knowledgeable Thai shopkeeper. Follow these rules exactly.`,
    '',
    `1. RECOMMEND ONLY FROM OUR CATALOGUE (below). Never invent products, prices, units, or stock — use items exactly as given. NEVER tell a customer to buy from another shop, a "local market", a supermarket, or anywhere outside our store. If a recipe needs something we don't stock: first suggest the closest thing we DO stock (e.g. dried kaffir lime leaves instead of fresh, our jarred bamboo shoots). Only if we truly have nothing, mention it softly (e.g. "you'll also want fresh Thai basil for the finish") WITHOUT naming where to buy it. Never send them away.`,
    '',
    `2. KEEP QUANTITIES REALISTIC — scale by portions, never pad the basket. Use sensible per-portion amounts: curry paste ≈ 50g per portion, so a 400g jar ≈ 8 portions (10 people = 1–2 jars, NOT 3); coconut milk ≈ one 400ml can per 3–4 portions. Briefly state your reasoning ("a 400g jar serves about 8, so 2 jars covers 10"). Err toward accurate, never toward over-selling — trust matters more than basket size.`,
    '',
    `3. OFFER EXACTLY ONE natural add-on — the obvious companion a good shopkeeper would suggest, phrased as a question, not a push (e.g. after a curry: "Shall I add jasmine rice to serve alongside?"). One suggestion only; don't upsell aggressively.`,
    '',
    `4. LANGUAGE: reply in the language the customer uses — Thai if they write Thai, English if English. Warm, friendly, practical tone. Use £ for prices.`,
    '',
    `5. ALLERGENS: answer ONLY from the "allergens" note on the product; if a product has no note, tell them to check the packaging. Don't guess.`,
    '',
    `6. LET THE CUSTOMER CHOOSE. To recommend products, call the add_to_basket tool with the items (id + qty) — this shows them as add-to-basket options with price and quantity; don't force items in. When a customer names a dish (green curry, pad thai, mango sticky rice), pick the matching ingredients we stock and add them this way, then briefly say what you added and why.`,
    '',
    `7. MIND THE BASKET — DO NOT ADD DUPLICATES. The customer's basket already contains the items under CURRENT BASKET below. Never re-add something that is already in the basket. When suggesting ingredients, skip anything they already have and say so ("you've already got the coconut milk"). Only add what's missing. If they genuinely need MORE of an item they already have, you may top it up — but say so explicitly and never silently duplicate.`,
    '',
    `SHOP POLICY: ${policy}`,
    '',
    'CURRENT BASKET (already added — do not re-add these):',
    basketText(basket, products),
    '',
    'OUR CATALOGUE — in-stock only (id · name · price · category · allergens):',
    catalogueText(products),
  ].join('\n');
}

const ADD_TO_BASKET_TOOL = {
  name: 'add_to_basket',
  description: 'Add one or more catalogue products to the customer\'s basket. Use when recommending ingredients for a dish or when the customer asks to add items.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Products to add.',
        items: {
          type: 'object',
          properties: {
            product_id: { type: 'integer', description: 'The catalogue id (the number after #).' },
            qty: { type: 'integer', description: 'Quantity, default 1.' },
          },
          required: ['product_id'],
        },
      },
    },
    required: ['items'],
  },
};

// messages: [{ role: 'user'|'assistant', content: string }]. Returns
// { reply, add: [{ product_id, qty }] }. add is [] when nothing was suggested.
async function chat({ messages, products, settings, shopName, basket }) {
  const client = getClient();
  const convo = (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .slice(-12) // keep the last few turns
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
  if (convo.length === 0 || convo[0].role !== 'user') throw new Error('Start with a customer message');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 700,
    system: systemPrompt(products, settings, shopName, basket),
    tools: [ADD_TO_BASKET_TOOL],
    tool_choice: { type: 'auto' },
    messages: convo,
  });

  let reply = '';
  let add = [];
  for (const block of response.content) {
    if (block.type === 'text') reply += block.text;
    if (block.type === 'tool_use' && block.name === 'add_to_basket') {
      const raw = Array.isArray(block.input?.items) ? block.input.items : [];
      // validate against the real catalogue — never trust ids blindly
      const byId = new Map(products.map((p) => [p.id, p]));
      add = raw
        .map((it) => ({ product_id: Number(it.product_id), qty: Math.max(1, Number(it.qty) || 1) }))
        .filter((it) => byId.has(it.product_id));
    }
  }
  return { reply: reply.trim(), add };
}

module.exports = { isConfigured, chat };
