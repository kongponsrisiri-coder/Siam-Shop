import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useCart } from '../cart.jsx';

// SIAMSHOP-003 will wire this to a real Stripe Checkout Session. For the
// scaffold it shows the order summary and a placeholder pay button, and the
// /order/success route (success prop) clears the cart.
export default function CheckoutScreen({ success = false }) {
  const { items, subtotal, clear } = useCart();

  useEffect(() => {
    if (success) clear();
  }, [success]); // eslint-disable-line react-hooks/exhaustive-deps

  if (success) {
    return (
      <div className="container center">
        <h1>🎉 Thank you!</h1>
        <p className="muted">Your order has been placed. A confirmation email is on its way.</p>
        <Link className="btn" to="/">Back to shop</Link>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="container center">
        <p className="muted">Nothing to check out.</p>
        <Link className="btn" to="/">Browse products</Link>
      </div>
    );
  }

  return (
    <div className="container">
      <h1>Checkout</h1>
      <div className="panel">
        <table>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{i.name} × {i.qty}</td>
                <td style={{ textAlign: 'right' }}>£{(i.price * i.qty).toFixed(2)}</td>
              </tr>
            ))}
            <tr>
              <td><strong>Subtotal</strong></td>
              <td style={{ textAlign: 'right' }}><strong>£{subtotal.toFixed(2)}</strong></td>
            </tr>
          </tbody>
        </table>

        <div className="panel" style={{ background: '#fff8e1', borderColor: '#f2a900' }}>
          <strong>Stripe checkout coming in SIAMSHOP-003.</strong>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            This button will create a Stripe Checkout Session, verify payment server-side,
            decrement stock, and email a receipt.
          </p>
        </div>

        <button className="btn" disabled>Pay with card (coming soon)</button>
      </div>
    </div>
  );
}
