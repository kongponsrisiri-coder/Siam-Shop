// Simple cart held in React context + persisted to localStorage.
// Stores minimal product snapshots so the cart survives reloads. Server-side
// re-pricing at checkout (SIAMSHOP-003) is the source of truth for money.
//
// SIAMSHOP-501: a line is a product PLUS its chosen options (size, toppings…).
// Lines are keyed by `key` = lineKey(product.id, option_ids) so two different
// builds of the same product stay separate. `price` is the unit price
// including options (display only).
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { describeSelection, lineKey, unitPrice } from './options.js';

const CartContext = createContext(null);
const KEY = 'siamshop_cart';

// Older carts stored lines without `key` / `option_ids` — normalise on load.
function normalise(list) {
  return (Array.isArray(list) ? list : [])
    .filter((i) => i && i.id)
    .map((i) => ({
      ...i,
      option_ids: Array.isArray(i.option_ids) ? i.option_ids : [],
      options: Array.isArray(i.options) ? i.options : [],
      key: i.key || lineKey(i.id, i.option_ids || []),
    }));
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(() => {
    try {
      return normalise(JSON.parse(localStorage.getItem(KEY)) || []);
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(items));
  }, [items]);

  // add(product, qty, optionIds) — optionIds may be omitted for plain products.
  function add(product, qty = 1, optionIds = []) {
    const ids = Array.isArray(optionIds) ? optionIds : [];
    const key = lineKey(product.id, ids);
    setItems((prev) => {
      const found = prev.find((i) => i.key === key);
      if (found) {
        return prev.map((i) => (i.key === key ? { ...i, qty: i.qty + qty } : i));
      }
      return [
        ...prev,
        {
          key,
          id: product.id,
          name: product.name,
          name_th: product.name_th,
          price: unitPrice(product, ids),
          image_url: product.image_url,
          option_ids: ids,
          options: describeSelection(product, ids),
          qty,
        },
      ];
    });
  }

  // setQty / remove accept a line key; a bare product id still works for
  // plain lines (their key IS the id as a string).
  function setQty(key, qty) {
    const k = String(key);
    setItems((prev) =>
      prev
        .map((i) => (i.key === k ? { ...i, qty: Math.max(0, qty) } : i))
        .filter((i) => i.qty > 0)
    );
  }

  function remove(key) {
    const k = String(key);
    setItems((prev) => prev.filter((i) => i.key !== k));
  }

  function clear() {
    setItems([]);
  }

  const count = useMemo(() => items.reduce((n, i) => n + i.qty, 0), [items]);
  const subtotal = useMemo(() => items.reduce((s, i) => s + i.price * i.qty, 0), [items]);

  return (
    <CartContext.Provider value={{ items, add, setQty, remove, clear, count, subtotal }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within CartProvider');
  return ctx;
}
