import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useCart } from '../cart.jsx';

export default function ProductScreen() {
  const { id } = useParams();
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
  if (!product) return <div className="container center muted">Loading…</div>;

  return (
    <div className="container">
      <p style={{ marginTop: 16 }}><Link to="/">← Back to shop</Link></p>
      <div className="panel" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <div
          className="thumb"
          style={{
            aspectRatio: '1/1',
            borderRadius: 12,
            background: product.image_url ? `#f1f1f1 url(${product.image_url}) center/cover` : '#f1f1f1',
          }}
        />
        <div>
          <h1 style={{ marginTop: 0 }}>{product.name}</h1>
          {product.name_th && <p className="muted" style={{ marginTop: -8 }}>{product.name_th}</p>}
          <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--siam-red)' }}>
            £{Number(product.price).toFixed(2)}
          </div>
          <p>{product.description || 'No description yet.'}</p>
          <p className="muted">{product.stock_qty > 0 ? `${product.stock_qty} in stock` : 'Out of stock'}</p>
          <div className="row" style={{ marginTop: 12 }}>
            <input
              type="number"
              min="1"
              max={product.stock_qty}
              value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
              style={{ width: 80 }}
            />
            <button
              className="btn"
              disabled={product.stock_qty <= 0}
              onClick={() => {
                add(product, qty);
                navigate('/cart');
              }}
            >
              Add to cart
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
