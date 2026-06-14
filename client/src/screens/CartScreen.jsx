import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useCart } from '../cart.jsx';
import { useT } from '../lang.jsx';
import { api } from '../api.js';

export default function CartScreen() {
  const { items, add, setQty, remove, subtotal } = useCart();
  const navigate = useNavigate();
  const t = useT();
  const [minOrder, setMinOrder] = useState(0);
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    let live = true;
    api
      .getSettings()
      .then((s) => live && setMinOrder(Number(s?.minimum_order_amount) || 0))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Pre-fill the cart from a Messenger checkout link: /cart?cart=<base64url [{id,qty}]>.
  useEffect(() => {
    const raw = params.get('cart');
    if (!raw) return;
    let wanted;
    try {
      wanted = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
      return;
    }
    Promise.all(
      (wanted || []).map((w) =>
        api.getProduct(w.id).then((p) => ({ p, qty: Math.max(1, Number(w.qty) || 1) })).catch(() => null)
      )
    ).then((results) => {
      results.filter(Boolean).forEach(({ p, qty }) => add(p, qty));
      // Clear the param so a refresh doesn't re-add.
      params.delete('cart');
      params.delete('src');
      setParams(params, { replace: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (items.length === 0) {
    return (
      <div className="container center">
        <p className="muted">Your cart is empty.</p>
        <Link className="btn" to="/">{t('keepShopping')}</Link>
      </div>
    );
  }

  const belowMin = minOrder > 0 && subtotal < minOrder;
  const shortfall = belowMin ? minOrder - subtotal : 0;

  return (
    <div className="container">
      <h1>{t('cart')}</h1>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Price</th>
              <th>Qty</th>
              <th>Total</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{i.name}</td>
                <td>£{i.price.toFixed(2)}</td>
                <td>
                  <input
                    type="number"
                    min="1"
                    value={i.qty}
                    onChange={(e) => setQty(i.id, Number(e.target.value))}
                    style={{ width: 70 }}
                  />
                </td>
                <td>£{(i.price * i.qty).toFixed(2)}</td>
                <td>
                  <button className="btn ghost" onClick={() => remove(i.id)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="row" style={{ marginTop: 16 }}>
          <div className="spacer" />
          <div style={{ textAlign: 'right' }}>
            <div className="muted">{t('subtotal')}</div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>£{subtotal.toFixed(2)}</div>
            <div className="muted" style={{ fontSize: 12 }}>{t('deliveryAtCheckout')}</div>
          </div>
        </div>

        {belowMin && (
          <div className="min-warn">
            {t('minOrder')}: <strong>£{minOrder.toFixed(2)}</strong> — {t('addMore')}{' '}
            <strong>£{shortfall.toFixed(2)}</strong> {t('moreToCheckout')}.
          </div>
        )}

        <div className="row" style={{ marginTop: 16 }}>
          <Link className="btn secondary" to="/">{t('keepShopping')}</Link>
          <div className="spacer" />
          <button
            className="btn"
            disabled={belowMin}
            onClick={() => navigate('/checkout')}
          >
            {t('checkout')} →
          </button>
        </div>
      </div>
    </div>
  );
}
