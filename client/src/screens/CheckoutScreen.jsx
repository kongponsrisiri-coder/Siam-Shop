import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useCart } from '../cart.jsx';
import { useT } from '../lang.jsx';
import { api } from '../api.js';

// Chosen options under an order line (shared by the success + summary views).
function LineOptions({ list }) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return <div className="line-opts">{list.map((o) => o.name).join(', ')}</div>;
}

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

  const collection = order?.fulfilment === 'collection';

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
          {collection && (
            <p style={{ marginTop: 0 }}>
              🛍️ <strong>Collection{order.pickup_label ? ` — ${order.pickup_label}` : ''}</strong>
              {order.collection_address && <><br /><span className="muted">{order.collection_address}</span></>}
            </p>
          )}
          <table>
            <tbody>
              {(order.items || []).map((it, idx) => (
                <tr key={idx}>
                  <td>
                    {it.name_snapshot} × {it.qty}
                    <LineOptions list={it.options_snapshot} />
                  </td>
                  <td style={{ textAlign: 'right', verticalAlign: 'top' }}>£{Number(it.line_total).toFixed(2)}</td>
                </tr>
              ))}
              <tr>
                <td>Subtotal</td>
                <td style={{ textAlign: 'right' }}>£{Number(order.subtotal).toFixed(2)}</td>
              </tr>
              {!collection && (
                <tr>
                  <td>Delivery</td>
                  <td style={{ textAlign: 'right' }}>£{Number(order.delivery_fee).toFixed(2)}</td>
                </tr>
              )}
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

// Pickup slot chooser (SIAMSHOP-504): ASAP + today/tomorrow slots from the API.
function PickupSlots({ slots, value, onChange }) {
  const t = useT();
  if (!slots) return <div className="muted" style={{ fontSize: 13 }}>Loading times…</div>;
  return (
    <div>
      <label>{t('pickupTime')} *</label>
      <div className="slot-grid">
        {slots.asap && (
          <button type="button" className={value === 'asap' ? 'on' : ''} onClick={() => onChange('asap')}>
            {slots.asap_label || 'ASAP'}
          </button>
        )}
        {slots.slots.map((s) => (
          <button type="button" key={s.at} className={value === s.at ? 'on' : ''} onClick={() => onChange(s.at)}>
            {s.label}
          </button>
        ))}
      </div>
      {!slots.asap && slots.slots.length === 0 && (
        <div className="err" style={{ fontSize: 13 }}>No collection times available right now.</div>
      )}
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

  // Fulfilment (SIAMSHOP-504): 'delivery' | 'collection'
  const [fulfilment, setFulfilment] = useState('delivery');
  const [slots, setSlots] = useState(null);
  const [pickupAt, setPickupAt] = useState('');

  const [quote, setQuote] = useState(null);     // { zone, label, fee }
  const [quoteErr, setQuoteErr] = useState('');
  const [quoting, setQuoting] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [placed, setPlaced] = useState(null);   // bank-transfer result

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {});
  }, []);

  // Load pickup slots when collection is chosen (refresh every minute so ASAP
  // and the first slot stay honest).
  useEffect(() => {
    if (fulfilment !== 'collection') return;
    let live = true;
    const fetchSlots = () => api.pickupSlots().then((s) => {
      if (!live) return;
      setSlots(s);
      setPickupAt((cur) => (cur && (cur === 'asap' ? s.asap : s.slots.some((x) => x.at === cur)) ? cur : (s.asap ? 'asap' : s.slots[0]?.at || '')));
    }).catch(() => live && setSlots({ asap: false, slots: [] }));
    fetchSlots();
    const tmr = setInterval(fetchSlots, 60000);
    return () => { live = false; clearInterval(tmr); };
  }, [fulfilment]);

  // Live delivery quote as the postcode is filled in (debounced).
  useEffect(() => {
    if (fulfilment !== 'delivery') return;
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
  }, [postcode, fulfilment]);

  const collection = fulfilment === 'collection';
  const collectionEnabled = !!settings?.collection_enabled;
  const closed = settings && settings.opening_hours && !settings.open_now;
  const minOrder = Number(settings?.minimum_order_amount) || 0;
  const belowMin = minOrder > 0 && subtotal < minOrder;
  const deliveryFee = !collection && quote ? Number(quote.fee) : 0;
  const total = subtotal + deliveryFee;

  function buildBody() {
    const body = {
      items: items.map((i) => ({ product_id: i.id, qty: i.qty, option_ids: i.option_ids || [] })),
      customer: { email: email.trim(), name: name.trim(), phone: phone.trim() },
      marketing_consent: consent,
      fulfilment,
    };
    if (collection) {
      body.pickup_at = pickupAt || 'asap';
    } else {
      body.postcode = postcode.trim();
      body.delivery_address = address.trim();
    }
    return body;
  }

  function validate() {
    if (!name.trim() || !email.trim()) {
      setError('Please fill in your name and email.');
      return false;
    }
    if (collection) {
      if (!pickupAt) {
        setError('Please choose a pickup time.');
        return false;
      }
    } else {
      if (!address.trim() || !postcode.trim()) {
        setError('Please fill in your delivery address and postcode.');
        return false;
      }
      if (quoteErr) {
        setError('We cannot deliver to that postcode yet.');
        return false;
      }
    }
    if (belowMin) {
      setError(`Minimum order is £${minOrder.toFixed(2)}.`);
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
      {closed && (
        <div className="closed-banner">
          {t('closedNow')}{settings.next_open ? ` — ${t('opens')} ${settings.next_open}` : ''}.
          {collectionEnabled && <> {t('collectionOk')}.</>}
        </div>
      )}
      <div className="checkout-grid">
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Your details</h3>
          <label>Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>Email *</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <label>Phone</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} />

          {collectionEnabled && (
            <>
              <label>How would you like your order?</label>
              <div className="fulfil-toggle">
                <button type="button" className={!collection ? 'on' : ''} onClick={() => setFulfilment('delivery')}>🚚 {t('deliveryOpt')}</button>
                <button type="button" className={collection ? 'on' : ''} onClick={() => setFulfilment('collection')}>🛍️ {t('collectionOpt')}</button>
              </div>
            </>
          )}

          {collection ? (
            <>
              {settings?.collection_address && (
                <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>
                  {t('collectFrom')}: {settings.collection_address}
                </p>
              )}
              <PickupSlots slots={slots} value={pickupAt} onChange={setPickupAt} />
            </>
          ) : (
            <>
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
            </>
          )}

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
                <tr key={i.key}>
                  <td>
                    {i.name} × {i.qty}
                    <LineOptions list={i.options} />
                  </td>
                  <td style={{ textAlign: 'right', verticalAlign: 'top' }}>£{(i.price * i.qty).toFixed(2)}</td>
                </tr>
              ))}
              <tr>
                <td>{t('subtotal')}</td>
                <td style={{ textAlign: 'right' }}>£{subtotal.toFixed(2)}</td>
              </tr>
              <tr>
                <td>{collection ? t('collectionOpt') : t('delivery')}</td>
                <td style={{ textAlign: 'right' }}>
                  {collection ? 'free' : quote ? `£${deliveryFee.toFixed(2)}` : <span className="muted">enter postcode</span>}
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
