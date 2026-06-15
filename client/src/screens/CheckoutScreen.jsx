import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useCart } from '../cart.jsx';
import { useT } from '../lang.jsx';
import { api } from '../api.js';

// Order summary shown after a successful card payment / on the /order/success
// route. Reads ?order= or ?session_id= and fetches the order, then clears cart.
function SuccessView() {
  const { clear } = useCart();
  const [params] = useSearchParams();
  const orderId = params.get('order') || params.get('order_id');
  const emailParam = params.get('email') || '';
  const sessionId = params.get('session_id');
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    clear();
    if (orderId) {
      api
        .getOrder(orderId, emailParam)
        .then(setOrder)
        .catch((e) => setError(e.message));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="container center">
      <h1>🎉 Thank you!</h1>
      {orderId && <div className="order-number">Order #{orderId}</div>}
      <p className="muted">Your order has been placed — please keep your order number for tracking.
        A confirmation email is on its way.</p>

      {error && <p className="err">{error}</p>}

      {order && (
        <div className="panel" style={{ maxWidth: 480, margin: '20px auto', textAlign: 'left' }}>
          <h3 style={{ marginTop: 0 }}>Order #{order.id}</h3>
          <table>
            <tbody>
              {(order.items || []).map((it, idx) => (
                <tr key={idx}>
                  <td>{it.name_snapshot} × {it.qty}</td>
                  <td style={{ textAlign: 'right' }}>£{Number(it.line_total).toFixed(2)}</td>
                </tr>
              ))}
              <tr>
                <td>Subtotal</td>
                <td style={{ textAlign: 'right' }}>£{Number(order.subtotal).toFixed(2)}</td>
              </tr>
              <tr>
                <td>Delivery</td>
                <td style={{ textAlign: 'right' }}>£{Number(order.delivery_fee).toFixed(2)}</td>
              </tr>
              <tr>
                <td><strong>Total</strong></td>
                <td style={{ textAlign: 'right' }}><strong>£{Number(order.total).toFixed(2)}</strong></td>
              </tr>
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 13 }}>
            Status: {order.status} · Payment: {order.payment_status} ({order.payment_method})
          </p>
        </div>
      )}

      {!order && sessionId && (
        <p className="muted">Payment reference: {sessionId}</p>
      )}

      <Link className="btn" to="/">Back to shop</Link>
    </div>
  );
}

function CheckoutForm() {
  const { items, subtotal, clear } = useCart();
  const t = useT();

  const [settings, setSettings] = useState(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [postcode, setPostcode] = useState('');
  const [consent, setConsent] = useState(false);

  const [quote, setQuote] = useState(null);     // { zone, label, fee }
  const [quoteErr, setQuoteErr] = useState('');
  const [quoting, setQuoting] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [placed, setPlaced] = useState(null);   // bank-transfer result

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {});
  }, []);

  // Live delivery quote as the postcode is filled in (debounced).
  useEffect(() => {
    const code = postcode.trim();
    if (code.length < 5) {
      setQuote(null);
      setQuoteErr('');
      return;
    }
    let live = true;
    setQuoting(true);
    setQuoteErr('');
    const tmr = setTimeout(() => {
      api
        .deliveryQuote(code)
        .then((q) => {
          if (!live) return;
          setQuote(q);
        })
        .catch((e) => {
          if (!live) return;
          setQuote(null);
          setQuoteErr(e.message);
        })
        .finally(() => live && setQuoting(false));
    }, 450);
    return () => {
      live = false;
      clearTimeout(tmr);
    };
  }, [postcode]);

  const minOrder = Number(settings?.minimum_order_amount) || 0;
  const belowMin = minOrder > 0 && subtotal < minOrder;
  const deliveryFee = quote ? Number(quote.fee) : 0;
  const total = subtotal + deliveryFee;

  function buildBody() {
    return {
      items: items.map((i) => ({ product_id: i.id, qty: i.qty })),
      postcode: postcode.trim(),
      delivery_address: address.trim(),
      customer: { email: email.trim(), name: name.trim(), phone: phone.trim() },
      marketing_consent: consent,
    };
  }

  function validate() {
    if (!name.trim() || !email.trim() || !address.trim() || !postcode.trim()) {
      setError('Please fill in name, email, delivery address and postcode.');
      return false;
    }
    if (belowMin) {
      setError(`Minimum order is £${minOrder.toFixed(2)}.`);
      return false;
    }
    if (quoteErr) {
      setError('We cannot deliver to that postcode yet.');
      return false;
    }
    setError('');
    return true;
  }

  async function payCard() {
    if (!validate()) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.checkoutSession(buildBody());
      if (res.url) {
        window.location.href = res.url;
      } else {
        // Stripe not configured — order created, show success in-app.
        clear();
        setPlaced({ order_id: res.order_id, card: true });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function payBank() {
    if (!validate()) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.createOrder({ ...buildBody(), payment_method: 'bank_transfer' });
      clear();
      setPlaced({ order_id: res.order_id, bank_instructions: res.bank_instructions });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (placed) {
    return (
      <div className="container">
        <div className="panel center" style={{ maxWidth: 540, margin: '24px auto' }}>
          <h1>🎉 Order placed!</h1>
          <p>Your order number is <strong>#{placed.order_id}</strong>.</p>
          {placed.bank_instructions ? (
            <>
              <p className="muted">Please complete your payment by bank transfer:</p>
              <pre className="bank-instructions">{placed.bank_instructions}</pre>
            </>
          ) : (
            <p className="muted">A confirmation email is on its way.</p>
          )}
          <Link className="btn" to="/">Back to shop</Link>
        </div>
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
      <h1>{t('checkout')}</h1>
      <div className="checkout-grid">
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Your details</h3>
          <label>Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>Email *</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <label>Phone</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} />
          <label>Delivery address *</label>
          <textarea rows="3" value={address} onChange={(e) => setAddress(e.target.value)} />
          <label>Postcode *</label>
          <input
            value={postcode}
            onChange={(e) => setPostcode(e.target.value.toUpperCase())}
            placeholder="e.g. SW1A 1AA"
          />
          {quoting && <div className="muted" style={{ fontSize: 13 }}>Checking delivery…</div>}
          {quote && (
            <div className="quote-ok">
              {quote.label} — £{Number(quote.fee).toFixed(2)} <span className="muted">({quote.zone})</span>
            </div>
          )}
          {quoteErr && <div className="err">{quoteErr}</div>}

          <label className="row" style={{ marginTop: 12, gap: 8 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>Email me offers & news</span>
          </label>
        </div>

        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Order summary</h3>
          <table>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{i.name} × {i.qty}</td>
                  <td style={{ textAlign: 'right' }}>£{(i.price * i.qty).toFixed(2)}</td>
                </tr>
              ))}
              <tr>
                <td>{t('subtotal')}</td>
                <td style={{ textAlign: 'right' }}>£{subtotal.toFixed(2)}</td>
              </tr>
              <tr>
                <td>{t('delivery')}</td>
                <td style={{ textAlign: 'right' }}>
                  {quote ? `£${deliveryFee.toFixed(2)}` : <span className="muted">enter postcode</span>}
                </td>
              </tr>
              <tr>
                <td><strong>{t('total')}</strong></td>
                <td style={{ textAlign: 'right' }}><strong>£{total.toFixed(2)}</strong></td>
              </tr>
            </tbody>
          </table>

          {belowMin && (
            <div className="min-warn">
              {t('minOrder')}: £{minOrder.toFixed(2)} — {t('addMore')} £{(minOrder - subtotal).toFixed(2)} {t('moreToCheckout')}.
            </div>
          )}

          {error && <p className="err">{error}</p>}

          <button className="btn" style={{ width: '100%', marginTop: 12 }} disabled={busy} onClick={payCard}>
            {busy ? 'Please wait…' : 'Pay with card'}
          </button>
          <button
            className="btn secondary"
            style={{ width: '100%', marginTop: 8 }}
            disabled={busy}
            onClick={payBank}
          >
            Pay by bank transfer
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CheckoutScreen({ success = false }) {
  if (success) return <SuccessView />;
  return <CheckoutForm />;
}
