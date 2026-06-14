import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, auth } from '../api.js';
import BarcodeScanner from '../components/BarcodeScanner.jsx';

// Phone scanner PWA (SIAMSHOP-201/202/203). Four modes over one shared stock
// core: Checkout (scan to sell), Receive (goods-in), Stocktake (count), and
// Invoice (AI photo -> goods-in). Designed for a phone held in one hand.

const MODES = [
  { key: 'checkout', label: '🛒 Checkout' },
  { key: 'receive', label: '📥 Receive' },
  { key: 'stocktake', label: '🔢 Stocktake' },
  { key: 'invoice', label: '🧾 Invoice' },
];

function money(n) {
  return '£' + Number(n || 0).toFixed(2);
}

function LoginGate({ onIn }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { token } = await api.login(password);
      auth.set(token);
      onIn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="scanner">
      <div className="scanner-head"><span className="brand">Siam<span>Shop</span> · Scanner</span></div>
      <div className="scanner-body">
        <form className="panel" onSubmit={submit}>
          <h3 style={{ marginTop: 0 }}>Staff sign in</h3>
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          {error && <p className="err">{error}</p>}
          <button className="btn" style={{ marginTop: 12, width: '100%' }} disabled={busy}>{busy ? '…' : 'Sign in'}</button>
        </form>
      </div>
    </div>
  );
}

export default function ScannerScreen() {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState('checkout');
  const [flash, setFlash] = useState(null);

  // checkout
  const [basket, setBasket] = useState([]);
  const [payment, setPayment] = useState('cash');
  // receive / stocktake
  const [pending, setPending] = useState(null); // {product, qty} | {product, counted}
  const [log, setLog] = useState([]);
  // invoice
  const [invoiceLines, setInvoiceLines] = useState(null);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [invoiceSupplier, setInvoiceSupplier] = useState(null);

  useEffect(() => {
    if (!auth.get()) { setChecking(false); return; }
    api.me().then(() => setAuthed(true)).catch(() => auth.clear()).finally(() => setChecking(false));
  }, []);

  function showFlash(type, text) {
    setFlash({ type, text });
    setTimeout(() => setFlash(null), 2500);
  }

  // reset mode-specific state when switching
  function switchMode(m) {
    setMode(m);
    setPending(null);
    setLog([]);
    setInvoiceLines(null);
    setInvoiceSupplier(null);
  }

  async function handleScan(code) {
    try {
      const p = await api.lookupBarcode(code);
      if (mode === 'checkout') {
        setBasket((prev) => {
          const found = prev.find((i) => i.id === p.id);
          if (found) return prev.map((i) => (i.id === p.id ? { ...i, qty: i.qty + 1 } : i));
          return [...prev, { id: p.id, name: p.name, price: Number(p.price), qty: 1 }];
        });
        showFlash('ok', `Added ${p.name}`);
      } else if (mode === 'receive') {
        setPending({ product: p, qty: 1 });
      } else if (mode === 'stocktake') {
        setPending({ product: p, counted: p.stock_qty });
      }
    } catch (err) {
      showFlash('err', err.message);
    }
  }

  // ---- checkout ----
  const subtotal = basket.reduce((s, i) => s + i.price * i.qty, 0);
  async function completeSale() {
    if (basket.length === 0) return;
    try {
      const sale = await api.createSale({
        items: basket.map((i) => ({ product_id: i.id, qty: i.qty })),
        payment_method: payment,
      });
      showFlash('ok', `Sale #${sale.id} · ${money(sale.total)}`);
      setBasket([]);
    } catch (err) {
      showFlash('err', err.message);
    }
  }

  // ---- receive / stocktake confirm ----
  async function confirmReceive() {
    try {
      const r = await api.receiveStock({ product_id: pending.product.id, qty: pending.qty });
      setLog((l) => [{ text: `+${pending.qty} ${r.name} → ${r.stock_qty}`, type: 'ok' }, ...l]);
      setPending(null);
    } catch (err) {
      showFlash('err', err.message);
    }
  }
  async function confirmStocktake() {
    try {
      const r = await api.stocktake({ product_id: pending.product.id, counted_qty: pending.counted });
      const sign = r.variance > 0 ? `+${r.variance}` : `${r.variance}`;
      setLog((l) => [{ text: `${r.name}: ${r.previous}→${r.counted} (${sign})`, type: r.variance === 0 ? 'ok' : 'warn' }, ...l]);
      setPending(null);
    } catch (err) {
      showFlash('err', err.message);
    }
  }

  // ---- invoice ----
  async function onPhoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setInvoiceBusy(true);
    setInvoiceLines(null);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await api.scanInvoice({ image_base64: reader.result, media_type: file.type });
        setInvoiceSupplier(res.supplier);
        setInvoiceLines(res.lines.map((l) => ({ ...l, include: l.matched_product_id != null })));
      } catch (err) {
        showFlash('err', err.message);
      } finally {
        setInvoiceBusy(false);
      }
    };
    reader.readAsDataURL(file);
  }
  async function applyInvoice() {
    const lines = invoiceLines
      .filter((l) => l.include && l.matched_product_id)
      .map((l) => ({ product_id: l.matched_product_id, qty: Number(l.qty), note: 'invoice' }));
    if (lines.length === 0) return showFlash('err', 'No matched lines to apply');
    try {
      const r = await api.goodsInBatch(lines);
      showFlash('ok', `Applied ${r.applied.length} line(s) to stock`);
      setInvoiceLines(null);
      setInvoiceSupplier(null);
    } catch (err) {
      showFlash('err', err.message);
    }
  }

  if (checking) return <div className="scanner"><div className="scanner-body center muted">Loading…</div></div>;
  if (!authed) return <LoginGate onIn={() => setAuthed(true)} />;

  const showScanner = mode === 'checkout' || mode === 'receive' || mode === 'stocktake';

  return (
    <div className="scanner">
      <div className="scanner-head">
        <Link to="/" className="brand">Siam<span>Shop</span> · Scanner</Link>
        <Link to="/till" className="btn ghost" style={{ marginLeft: 'auto' }}>Till</Link>
      </div>

      <div className="scanner-modes">
        {MODES.map((m) => (
          <button key={m.key} className={`scanner-mode ${mode === m.key ? 'active' : ''}`} onClick={() => switchMode(m.key)}>
            {m.label}
          </button>
        ))}
      </div>

      {flash && <div className={`till-flash ${flash.type === 'err' ? 'err' : ''}`}>{flash.text}</div>}

      <div className="scanner-body">
        {showScanner && !pending && <BarcodeScanner onScan={handleScan} />}

        {/* CHECKOUT */}
        {mode === 'checkout' && (
          <div>
            <div className="scanner-list">
              {basket.length === 0 ? <p className="muted center">Scan items to sell.</p> : basket.map((i) => (
                <div className="till-line" key={i.id}>
                  <div style={{ flex: 1 }}>{i.name}</div>
                  <div className="till-qty">
                    <button onClick={() => setBasket((b) => b.map((x) => x.id === i.id ? { ...x, qty: Math.max(1, x.qty - 1) } : x))}>−</button>
                    <span>{i.qty}</span>
                    <button onClick={() => setBasket((b) => b.map((x) => x.id === i.id ? { ...x, qty: x.qty + 1 } : x))}>+</button>
                  </div>
                  <div style={{ width: 60, textAlign: 'right' }}>{money(i.price * i.qty)}</div>
                </div>
              ))}
            </div>
            {basket.length > 0 && (
              <div className="scanner-foot">
                <div className="till-total"><span>Total</span><span>{money(subtotal)}</span></div>
                <div className="row" style={{ gap: 8 }}>
                  <button className={`btn ${payment === 'cash' ? '' : 'secondary'}`} onClick={() => setPayment('cash')}>💵 Cash</button>
                  <button className={`btn ${payment === 'card' ? '' : 'secondary'}`} onClick={() => setPayment('card')}>💳 Card</button>
                </div>
                <button className="btn till-complete" onClick={completeSale}>Complete · {money(subtotal)}</button>
              </div>
            )}
          </div>
        )}

        {/* RECEIVE pending */}
        {mode === 'receive' && pending && (
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>{pending.product.name}</h3>
            <p className="muted">In stock: {pending.product.stock_qty}</p>
            <label>Quantity received</label>
            <div className="till-qty" style={{ justifyContent: 'center', margin: '8px 0' }}>
              <button onClick={() => setPending((p) => ({ ...p, qty: Math.max(1, p.qty - 1) }))}>−</button>
              <input type="number" value={pending.qty} onChange={(e) => setPending((p) => ({ ...p, qty: Math.max(1, Number(e.target.value)) }))} style={{ width: 80, textAlign: 'center' }} />
              <button onClick={() => setPending((p) => ({ ...p, qty: p.qty + 1 }))}>+</button>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" style={{ flex: 1 }} onClick={confirmReceive}>Add to stock</button>
              <button className="btn secondary" onClick={() => setPending(null)}>Cancel</button>
            </div>
          </div>
        )}

        {/* STOCKTAKE pending */}
        {mode === 'stocktake' && pending && (
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>{pending.product.name}</h3>
            <p className="muted">System says: {pending.product.stock_qty}</p>
            <label>Counted quantity</label>
            <div className="till-qty" style={{ justifyContent: 'center', margin: '8px 0' }}>
              <button onClick={() => setPending((p) => ({ ...p, counted: Math.max(0, p.counted - 1) }))}>−</button>
              <input type="number" value={pending.counted} onChange={(e) => setPending((p) => ({ ...p, counted: Math.max(0, Number(e.target.value)) }))} style={{ width: 80, textAlign: 'center' }} />
              <button onClick={() => setPending((p) => ({ ...p, counted: p.counted + 1 }))}>+</button>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" style={{ flex: 1 }} onClick={confirmStocktake}>Save count</button>
              <button className="btn secondary" onClick={() => setPending(null)}>Cancel</button>
            </div>
          </div>
        )}

        {/* RECEIVE / STOCKTAKE log */}
        {(mode === 'receive' || mode === 'stocktake') && log.length > 0 && (
          <div className="scanner-log">
            {log.map((e, i) => <div key={i} className={`scanner-log-row ${e.type}`}>{e.text}</div>)}
          </div>
        )}

        {/* INVOICE */}
        {mode === 'invoice' && (
          <div>
            {!invoiceLines && (
              <label className="btn scanner-open" style={{ display: 'block', textAlign: 'center' }}>
                {invoiceBusy ? 'Reading invoice…' : '📸 Photograph invoice'}
                <input type="file" accept="image/*" capture="environment" onChange={onPhoto} style={{ display: 'none' }} disabled={invoiceBusy} />
              </label>
            )}
            {invoiceBusy && <p className="muted center">AI is reading the invoice…</p>}
            {invoiceLines && (
              <div>
                {invoiceSupplier && <p className="muted">Supplier: {invoiceSupplier}</p>}
                <div className="scanner-list">
                  {invoiceLines.map((l, idx) => (
                    <div className={`invoice-line ${l.matched_product_id ? '' : 'unmatched'}`} key={idx}>
                      <input type="checkbox" checked={l.include} disabled={!l.matched_product_id}
                        onChange={(e) => setInvoiceLines((ls) => ls.map((x, i) => i === idx ? { ...x, include: e.target.checked } : x))} />
                      <div style={{ flex: 1 }}>
                        <div>{l.name}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {l.matched_product_id ? `→ ${l.matched_name}` : 'no match — add product first'}
                        </div>
                      </div>
                      <input type="number" value={l.qty} min="1" style={{ width: 56 }}
                        onChange={(e) => setInvoiceLines((ls) => ls.map((x, i) => i === idx ? { ...x, qty: Number(e.target.value) } : x))} />
                    </div>
                  ))}
                </div>
                <div className="row" style={{ gap: 8, marginTop: 12 }}>
                  <button className="btn" style={{ flex: 1 }} onClick={applyInvoice}>Add matched to stock</button>
                  <button className="btn secondary" onClick={() => setInvoiceLines(null)}>Retake</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
