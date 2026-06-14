import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useCart } from '../cart.jsx';
import { useLang, useT, pickName, pickDesc } from '../lang.jsx';

function NotifyMe({ productId }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    setErr('');
    try {
      await api.notifyMe(productId, email);
      setSent(true);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) return <div className="notify-sent">{t('notifySent')}</div>;

  return (
    <form className="notify-form" onSubmit={submit} style={{ marginTop: 12 }}>
      <input
        type="email"
        required
        placeholder={t('notifyPlaceholder')}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{ maxWidth: 260 }}
      />
      <button className="btn" disabled={busy}>{t('notifyMe')}</button>
      {err && <div className="err">{err}</div>}
    </form>
  );
}

export default function ProductScreen() {
  const { id } = useParams();
  const { lang } = useLang();
  const t = useT();
  const [product, setProduct] = useState(null);
  const [error, setError] = useState('');
  const [qty, setQty] = useState(1);
  const { add } = useCart();
  const navigate = useNavigate();

  useEffect(() => {
    let live = true;
    api
      .getProduct(id)
      .then((p) => live && setProduct(p))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id]);

  if (error) return <div className="container center err">{error} — <Link to="/">back to shop</Link></div>;
  if (!product) return <div className="container center muted">{t('loading')}</div>;

  const out = product.track_stock && Number(product.stock_qty) <= 0;
  const name = pickName(product, lang);
  const desc = pickDesc(product, lang);

  return (
    <div className="container">
      <p style={{ marginTop: 16 }}><Link to="/">← {t('keepShopping')}</Link></p>
      <div className="panel product-detail">
        <div
          className="thumb"
          style={{
            aspectRatio: '1/1',
            borderRadius: 12,
            background: product.image_url ? `#f1f1f1 url(${product.image_url}) center/cover` : '#f1f1f1',
          }}
        />
        <div>
          <h1 style={{ marginTop: 0 }}>{name}</h1>
          {lang !== 'th' && product.name_th && (
            <p className="muted" style={{ marginTop: -8 }}>{product.name_th}</p>
          )}
          <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--siam-red)' }}>
            £{Number(product.price).toFixed(2)}
          </div>
          <p>{desc || (lang === 'th' ? 'ยังไม่มีรายละเอียด' : 'No description yet.')}</p>
          <p className="muted">
            {out
              ? t('outOfStock')
              : product.track_stock
                ? `${product.stock_qty} ${lang === 'th' ? 'ชิ้นในสต็อก' : 'in stock'}`
                : ''}
          </p>

          {out ? (
            <NotifyMe productId={product.id} />
          ) : (
            <div className="row" style={{ marginTop: 12 }}>
              <input
                type="number"
                min="1"
                value={qty}
                onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
                style={{ width: 80 }}
              />
              <button
                className="btn"
                onClick={() => {
                  add(product, qty);
                  navigate('/cart');
                }}
              >
                {t('addToCart')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
