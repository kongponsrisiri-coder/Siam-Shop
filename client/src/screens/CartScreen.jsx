import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCart } from '../cart.jsx';

export default function CartScreen() {
  const { items, setQty, remove, subtotal } = useCart();
  const navigate = useNavigate();

  if (items.length === 0) {
    return (
      <div className="container center">
        <p className="muted">Your cart is empty.</p>
        <Link className="btn" to="/">Browse products</Link>
      </div>
    );
  }

  return (
    <div className="container">
      <h1>Your cart</h1>
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
            <div className="muted">Subtotal</div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>£{subtotal.toFixed(2)}</div>
            <div className="muted" style={{ fontSize: 12 }}>Delivery calculated at checkout</div>
          </div>
        </div>

        <div className="row" style={{ marginTop: 16 }}>
          <Link className="btn secondary" to="/">Keep shopping</Link>
          <div className="spacer" />
          <button className="btn" onClick={() => navigate('/checkout')}>Checkout →</button>
        </div>
      </div>
    </div>
  );
}
