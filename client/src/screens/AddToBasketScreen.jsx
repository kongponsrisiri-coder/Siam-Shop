import React, { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useCart } from '../cart.jsx';
import { useT } from '../lang.jsx';

// /p/<ref>?add=1[&qty=N] — a deep link from a marketing site straight into the
// basket (SIAMSHOP-DEEPLINK-001).
//
// Their "Add to basket" buttons all pointed at the bare shop page, so a
// customer who tapped a specific product landed on the whole catalogue with an
// empty basket and had to hunt for it again (Korakot, 8 Sep).
//
// `ref` is whatever the site knows: a product id, a barcode, or the product
// name. Imported catalogues carry no barcodes, so in practice it is the name.
export default function AddToBasketScreen() {
  const { ref } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { add } = useCart();
  const t = useT();
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const qty = Math.min(99, Math.max(1, parseInt(params.get('qty'), 10) || 1));
    (async () => {
      try {
        const p = await api.resolveProduct(ref);
        if (!alive) return;
        // Size or toppings must be the customer's choice, so send them to the
        // product page rather than picking for them.
        if ((p.option_groups || []).length) return navigate(`/product/${p.id}`, { replace: true });
        if (p.available_now === false) {
          return navigate(`/product/${p.id}`, { replace: true, state: { notice: `${p.name} — ${p.availability_text || t('notNow')}` } });
        }
        if (p.track_stock && Number(p.stock_qty) <= 0) {
          return navigate(`/product/${p.id}`, { replace: true, state: { notice: `${p.name} is out of stock right now.` } });
        }
        add(p, qty);
        navigate('/cart', { replace: true, state: { added: p.name, qty } });
      } catch (e) {
        if (alive) setError(e.message || 'We could not find that product.');
      }
    })();
    return () => { alive = false; };
  }, [ref]);

  // Only ever seen if the lookup fails: a dead end with a way out beats a
  // silent redirect to a catalogue the customer did not ask for.
  if (error) {
    return (
      <div className="container" style={{ padding: '32px 16px' }}>
        <h1>We could not find that item</h1>
        <p className="muted">{error}</p>
        <button className="btn" onClick={() => navigate('/', { replace: true })}>{t('keepShopping')}</button>
      </div>
    );
  }
  return <div className="container" style={{ padding: '32px 16px' }}><p className="muted">Adding to your basket…</p></div>;
}
