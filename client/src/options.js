// Product options (SIAMSHOP-501) — shared client helpers for size / toppings /
// add-ons. A product carries option_groups[] (each with options[]); a basket
// line carries the chosen option ids. Money here is for DISPLAY only — the
// server re-prices every line from its own tables at sale/checkout time.

export function hasOptions(product) {
  return Array.isArray(product?.option_groups) && product.option_groups.length > 0;
}

// Default selection: every option flagged is_default. Groups that require a
// choice but have no default stay empty (the picker highlights them).
export function defaultSelection(product) {
  const ids = [];
  for (const g of product?.option_groups || []) {
    for (const o of g.options || []) if (o.is_default) ids.push(o.id);
  }
  return ids;
}

// Does this selection satisfy every group's min/max?
export function selectionValid(product, ids) {
  const set = new Set(ids || []);
  for (const g of product?.option_groups || []) {
    const n = (g.options || []).filter((o) => set.has(o.id)).length;
    if (n < Number(g.min_select || 0) || n > Number(g.max_select || 1)) return false;
  }
  return true;
}

// Chosen options as display rows: [{ group, name, name_th, price_delta }].
export function describeSelection(product, ids) {
  const set = new Set(ids || []);
  const out = [];
  for (const g of product?.option_groups || []) {
    for (const o of g.options || []) {
      if (set.has(o.id)) out.push({ group: g.name, name: o.name, name_th: o.name_th, price_delta: Number(o.price_delta) || 0 });
    }
  }
  return out;
}

// Per-unit add-on total for a selection.
export function optionsTotal(product, ids) {
  return +describeSelection(product, ids).reduce((s, o) => s + o.price_delta, 0).toFixed(2);
}

// Unit price = base price + chosen options.
export function unitPrice(product, ids) {
  return +(Number(product?.price || 0) + optionsTotal(product, ids)).toFixed(2);
}

// Basket line key: same product with a different build is a different line.
export function lineKey(productId, ids) {
  const sorted = [...(ids || [])].map(Number).sort((a, b) => a - b);
  return sorted.length ? `${productId}:${sorted.join('.')}` : String(productId);
}

// "Large, Chilli Basil Pork" from a snapshot or describeSelection() output.
export function optionsLabel(list, lang) {
  return (Array.isArray(list) ? list : [])
    .map((o) => (lang === 'th' && o.name_th ? o.name_th : o.name))
    .join(', ');
}
