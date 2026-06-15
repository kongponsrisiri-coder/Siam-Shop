import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useCart } from '../cart.jsx';
import { useLang, useT, pickName } from '../lang.jsx';

// Deterministic, on-brand gradient for products without a photo, so the
// placeholder tiles look intentional and vary by category.
function tint(seed) {
  const h = (Number(seed) * 47) % 360;
  return `linear-gradient(135deg, hsl(${h} 55% 92%), hsl(${(h + 28) % 360} 60% 84%))`;
}

// Inline back-in-stock signup shown on out-of-stock cards.
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
    <form className="notify-form" onSubmit={submit}>
      <input
        type="email"
        required
        placeholder={t('notifyPlaceholder')}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button className="btn ghost" disabled={busy}>{t('notifyMe')}</button>
      {err && <div className="err" style={{ fontSize: 11 }}>{err}</div>}
    </form>
  );
}

// Inline quantity stepper that adds directly to the cart from the card.
function QtyStepper({ product }) {
  const t = useT();
  const { items, add, setQty } = useCart();
  const inCart = items.find((i) => i.id === product.id);
  const qty = inCart ? inCart.qty : 0;

  if (qty <= 0) {
    return (
      <button className="btn add-btn" onClick={() => add(product, 1)}>
        {t('addToCart')}
      </button>
    );
  }

  return (
    <div className="qty-stepper">
      <button type="button" onClick={() => setQty(product.id, qty - 1)} aria-label="decrease">−</button>
      <span className="qty-val">
        {qty} <small>{t('inCart')}</small>
      </span>
      <button type="button" onClick={() => add(product, 1)} aria-label="increase">+</button>
    </div>
  );
}

export default function StorefrontScreen() {
  const { lang } = useLang();
  const t = useT();
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [settings, setSettings] = useState(null);
  const [shop, setShop] = useState(null);
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState(''); // '' = all
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([
      api.listProducts(),
      api.getCategories().catch(() => []),
      api.getSettings().catch(() => null),
      api.getShop().catch(() => null),
    ])
      .then(([prods, cats, s, sh]) => {
        if (!live) return;
        setProducts(prods || []);
        setCategories(cats || []);
        setSettings(s);
        setShop(sh);
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return products.filter((p) => {
      if (categoryId && String(p.category_id) !== String(categoryId)) return false;
      if (needle) {
        const hay = `${p.name || ''} ${p.name_th || ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [products, q, categoryId]);

  function isOut(p) {
    return p.track_stock && Number(p.stock_qty) <= 0;
  }

  return (
    <div className="container">
      <div
        className="panel hero"
        style={{ background: 'linear-gradient(135deg,#0D1B3E 0%,#15275a 100%)', color: '#fff', border: 'none', borderBottom: '3px solid #C9A84C' }}
      >
        <h1 style={{ margin: 0, color: '#fff' }}>{shop?.name || 'SiamShop'}</h1>
        <p style={{ margin: '6px 0 0', opacity: 0.92, color: '#C9A84C' }}>
          {lang === 'th' ? 'ของชำไทย ส่งถึงบ้านคุณ' : 'Thai groceries, delivered to your door.'}
        </p>
      </div>

      {settings?.restock_day && (
        <div className="restock-banner">
          🛒 {t('freshStock')} <strong>{settings.restock_day}</strong>
        </div>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <input
          placeholder={t('search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="cat-tabs">
        <button
          className={`cat-tab ${categoryId === '' ? 'active' : ''}`}
          onClick={() => setCategoryId('')}
        >
          {t('all')}
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            className={`cat-tab ${String(categoryId) === String(c.id) ? 'active' : ''}`}
            onClick={() => setCategoryId(c.id)}
          >
            {pickName(c, lang)}
          </button>
        ))}
      </div>

      {loading && <div className="center muted">{t('loading')}</div>}
      {error && <div className="center err">{error}</div>}
      {!loading && !error && visible.length === 0 && (
        <div className="center muted">{t('noProducts')}</div>
      )}

      <div className="grid">
        {visible.map((p) => {
          const out = isOut(p);
          return (
            <div className={`card ${out ? 'is-out' : ''}`} key={p.id}>
              <Link
                to={`/product/${p.id}`}
                className="thumb"
                style={p.image_url ? { backgroundImage: `url(${p.image_url})` } : {}}
              >
                {!p.image_url && (
                  <span className="ph" style={{ background: tint(p.category_id || p.id) }}>
                    {pickName(p, lang)}
                  </span>
                )}
                {out && <span className="oos-badge">{t('outOfStock')}</span>}
              </Link>
              <div className="body">
                <Link to={`/product/${p.id}`} className="name" style={{ color: 'inherit' }}>
                  {pickName(p, lang)}
                </Link>
                {lang !== 'th' && p.name_th && <div className="name-th">{p.name_th}</div>}
                <div className="price">£{Number(p.price).toFixed(2)}</div>
                {out ? (
                  <NotifyMe productId={p.id} />
                ) : (
                  <QtyStepper product={p} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
