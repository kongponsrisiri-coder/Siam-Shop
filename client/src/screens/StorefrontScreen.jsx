import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useCart } from '../cart.jsx';

export default function StorefrontScreen() {
  const [products, setProducts] = useState([]);
  const [shop, setShop] = useState(null);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { add } = useCart();

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([api.listProducts(), api.getShop().catch(() => null)])
      .then(([prods, s]) => {
        if (!live) return;
        setProducts(prods || []);
        setShop(s);
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const categories = useMemo(
    () => [...new Set(products.map((p) => p.category).filter(Boolean))].sort(),
    [products]
  );

  const visible = products.filter((p) => {
    if (category && p.category !== category) return false;
    if (q && !`${p.name} ${p.name_th || ''}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="container">
      <div className="panel" style={{ background: 'linear-gradient(135deg,#c8102e,#f2a900)', color: '#fff', border: 'none' }}>
        <h1 style={{ margin: 0 }}>{shop?.name || 'SiamShop'}</h1>
        <p style={{ margin: '6px 0 0', opacity: 0.95 }}>Thai groceries, delivered to your door.</p>
      </div>

      <div className="row" style={{ marginTop: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 240px' }}>
          <input
            placeholder="Search products…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select
          style={{ width: 200 }}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {loading && <div className="center muted">Loading products…</div>}
      {error && <div className="center err">{error}</div>}
      {!loading && !error && visible.length === 0 && (
        <div className="center muted">No products yet. Add some in the Admin area.</div>
      )}

      <div className="grid">
        {visible.map((p) => (
          <div className="card" key={p.id}>
            <Link to={`/product/${p.id}`} className="thumb" style={p.image_url ? { backgroundImage: `url(${p.image_url})` } : {}}>
              {!p.image_url && 'No image'}
            </Link>
            <div className="body">
              <Link to={`/product/${p.id}`} className="name" style={{ color: 'inherit' }}>{p.name}</Link>
              {p.name_th && <div className="name-th">{p.name_th}</div>}
              <div className="price">£{Number(p.price).toFixed(2)}</div>
              <button
                className="btn"
                style={{ marginTop: 8 }}
                disabled={p.stock_qty <= 0}
                onClick={() => add(p)}
              >
                {p.stock_qty > 0 ? 'Add to cart' : 'Out of stock'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
