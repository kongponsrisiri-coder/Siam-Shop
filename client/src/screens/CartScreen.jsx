import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useCart } from '../cart.jsx';
import { useLang, useT } from '../lang.jsx';
import { api } from '../api.js';
import { defaultSelection, hasOptions, optionsLabel, selectionValid } from '../options.js';

export default function CartScreen() {
  const { items, add, setQty, remove, subtotal } = useCart();
  const navigate = useNavigate();
  const t = useT();
  const { lang } = useLang();
  const [minOrder, setMinOrder] = useState(0);
  const [collectionEnabled, setCollectionEnabled] = useState(false);
  const [params, setParams] = useSearchParams();
  // Messenger pre-fill: items that need a size/topping choice can't be added
  // blind — list them with a link to the product page instead.
  const [needChoice, setNeedChoice] = useState([]);

  useEffect(() => {
    let live = true;
    api
      .getSettings()
      .then((s) => {
        if (!live) return;
        setMinOrder(Number(s?.minimum_order_amount) || 0);
        setCollectionEnabled(!!s?.collection_enabled);
      })
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
      const pending = [];
      results.filter(Boolean).forEach(({ p, qty }) => {
        if (hasOptions(p)) {
          const ids = defaultSelection(p);
          if (!selectionValid(p, ids)) return pending.push(p);
          return add(p, qty, ids);
        }
        add(p, qty);
      });
      setNeedChoice(pending);
      // Clear the param so a refresh doesn't re-add.
      params.delete('cart');
      params.delete('src');
      setParams(params, { replace: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Confirm what a deep link just put in the basket, so arriving here is not a
  // surprise (SIAMSHOP-DEEPLINK-001).
  const justAdded = useLocation().state && useLocation().state.added;
  const addedNotice = justAdded ? (
    <div className="restock-banner" style={{ marginBottom: 12 }}>
      ✓ <strong>{justAdded}</strong> added to your basket.
    </div>
  ) : null;

  const choiceNotice = needChoice.length > 0 && (
    <div className="min-warn" style={{ marginBottom: 12 }}>
      {t('chooseOptionsFor')}:{' '}
      {needChoice.map((p, i) => (
        <span key={p.id}>
          {i > 0 && ', '}
          <Link to={`/product/${p.id}`}><strong>{lang === 'th' && p.name_th ? p.name_th : p.name}</strong></Link>
        </span>
      ))}
    </div>
  );

  if (items.length === 0) {
    return (
      <div className="container center">
        {addedNotice}
        {choiceNotice}
        <p className="muted">Your cart is empty.</p>
        <Link className="btn" to="/">{t('keepShopping')}</Link>
      </div>
    );
  }

  // The minimum is a delivery rule. When the shop also does collection the
  // basket must still reach checkout, where picking collection clears it —
  // otherwise a £9 lunch box can never be ordered at all.
  const belowMin = minOrder > 0 && subtotal < minOrder;
  const shortfall = belowMin ? minOrder - subtotal : 0;
  const blocked = belowMin && !collectionEnabled;

  return (
    <div className="container">
      <h1>{t('cart')}</h1>
      {addedNotice}
      {choiceNotice}
      <div className="panel">
        <table className="cart-table">
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
              <tr key={i.key}>
                <td data-label="Product" className="cart-name">
                  {lang === 'th' && i.name_th ? i.name_th : i.name}
                  {i.options?.length > 0 && <div className="line-opts">{optionsLabel(i.options, lang)}</div>}
                </td>
                <td data-label="Price">£{i.price.toFixed(2)}</td>
                <td data-label="Qty">
                  <input
                    type="number"
                    min="1"
                    value={i.qty}
                    onChange={(e) => setQty(i.key, Number(e.target.value))}
                    style={{ width: 70 }}
                  />
                </td>
                <td data-label="Total">£{(i.price * i.qty).toFixed(2)}</td>
                <td className="cart-remove">
                  <button className="btn ghost" onClick={() => remove(i.key)}>Remove</button>
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
            {collectionEnabled ? t('minOrderDelivery') : t('minOrder')}:{' '}
            <strong>£{minOrder.toFixed(2)}</strong> — {t('addMore')}{' '}
            <strong>£{shortfall.toFixed(2)}</strong> {t('moreToCheckout')}
            {collectionEnabled ? `, ${t('orCollect')}` : ''}.
          </div>
        )}

        <div className="row" style={{ marginTop: 16 }}>
          <Link className="btn secondary" to="/">{t('keepShopping')}</Link>
          <div className="spacer" />
          <button
            className="btn"
            disabled={blocked}
            onClick={() => navigate('/checkout')}
          >
            {t('checkout')} →
          </button>
        </div>
      </div>
    </div>
  );
}
