import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, auth } from '../api.js';
import { Logo } from '../components/Logo.jsx';

// In-store EPOS till (SIAMSHOP-103). Staff scan a barcode or search by name to
// build a basket, take cash or card, and complete the sale — which decrements
// the shared stock server-side. Works on a tablet, desktop, or phone.

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
    <div className="container" style={{ maxWidth: 380 }}>
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>Till sign in</h1>
        <form onSubmit={submit}>
          <label>Staff password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          {error && <p className="err">{error}</p>}
          <button className="btn" style={{ marginTop: 12 }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </div>
    </div>
  );
}

export default function TillScreen() {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [catalogue, setCatalogue] = useState([]);
  const [categories, setCategories] = useState([]);
  const [categoryId, setCategoryId] = useState(''); // '' = all
  const [basket, setBasket] = useState([]); // {id, name, price, qty, stock_qty}
  const [search, setSearch] = useState('');
  const [payment, setPayment] = useState('cash');
  const [tendered, setTendered] = useState('');
  const [flash, setFlash] = useState(null); // {type, text}
  const [receipt, setReceipt] = useState(null);
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState(false);
  const scanRef = useRef(null);

  // Auth check on mount
  useEffect(() => {
    if (!auth.get()) {
      setChecking(false);
      return;
    }
    api.me().then(() => setAuthed(true)).catch(() => auth.clear()).finally(() => setChecking(false));
  }, []);

  async function loadCatalogue() {
    try {
      const [prods, cats] = await Promise.all([
        api.adminListProducts(),
        api.getCategories().catch(() => []),
      ]);
      setCatalogue(prods);
      setCategories(cats || []);
    } catch {
      /* ignore */
    }
  }
  async function loadSummary() {
    try {
      setSummary(await api.salesSummary());
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    if (authed) {
      loadCatalogue();
      loadSummary();
    }
  }, [authed]);

  const subtotal = useMemo(() => basket.reduce((s, i) => s + Number(i.price) * i.qty, 0), [basket]);
  const change = useMemo(() => {
    const t = Number(tendered);
    return payment === 'cash' && t >= subtotal ? t - subtotal : 0;
  }, [tendered, subtotal, payment]);

  function showFlash(type, text) {
    setFlash({ type, text });
    setTimeout(() => setFlash(null), 2500);
  }

  function addProduct(p) {
    if (p.stock_qty <= 0) return showFlash('err', `${p.name} is out of stock`);
    setBasket((prev) => {
      const found = prev.find((i) => i.id === p.id);
      if (found) {
        if (found.qty >= p.stock_qty) {
          showFlash('err', `Only ${p.stock_qty} of ${p.name} in stock`);
          return prev;
        }
        return prev.map((i) => (i.id === p.id ? { ...i, qty: i.qty + 1 } : i));
      }
      return [...prev, { id: p.id, name: p.name, price: Number(p.price), qty: 1, stock_qty: p.stock_qty }];
    });
  }

  function setQty(id, qty) {
    setBasket((prev) => prev.map((i) => (i.id === id ? { ...i, qty: Math.max(1, qty) } : i)));
  }
  function removeLine(id) {
    setBasket((prev) => prev.filter((i) => i.id !== id));
  }

  // Scan box: on Enter, try an exact barcode lookup; if no match, leave the text
  // as a name filter for the catalogue list below.
  async function onScanKey(e) {
    if (e.key !== 'Enter') return;
    const code = search.trim();
    if (!code) return;
    try {
      const p = await api.lookupBarcode(code);
      addProduct(p);
      setSearch('');
      showFlash('ok', `Added ${p.name}`);
    } catch {
      // not a barcode — keep as a search term; if exactly one match, add it
      const matches = filtered;
      if (matches.length === 1) {
        addProduct(matches[0]);
        setSearch('');
      } else {
        showFlash('err', 'No barcode match — pick from the list');
      }
    }
    scanRef.current?.focus();
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalogue.filter((p) => {
      if (categoryId && String(p.category_id) !== String(categoryId)) return false;
      if (q && !`${p.name} ${p.name_th || ''} ${p.barcode || ''} ${p.sku || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [catalogue, search, categoryId]);

  async function completeSale() {
    if (basket.length === 0) return;
    if (payment === 'cash' && tendered !== '' && Number(tendered) < subtotal) {
      return showFlash('err', 'Cash tendered is less than the total');
    }
    setBusy(true);
    try {
      const sale = await api.createSale({
        items: basket.map((i) => ({ product_id: i.id, qty: i.qty })),
        payment_method: payment,
        amount_tendered: payment === 'cash' && tendered !== '' ? Number(tendered) : undefined,
      });
      setReceipt(sale);
      setBasket([]);
      setTendered('');
      setSearch('');
      await Promise.all([loadCatalogue(), loadSummary()]);
      scanRef.current?.focus();
    } catch (err) {
      showFlash('err', err.message);
    } finally {
      setBusy(false);
    }
  }

  if (checking) return <div className="container center muted">Loading…</div>;
  if (!authed) return <LoginGate onIn={() => setAuthed(true)} />;

  return (
    <div className="till">
      <div className="till-head">
        <Link to="/" className="brand surface-brand"><Logo size={26} light /><span className="surface-tag">Till</span></Link>
        <div className="spacer" />
        {summary && (
          <div className="till-takings">
            Today: <strong>{money(summary.totals.gross)}</strong> · {summary.totals.order_count} sales
          </div>
        )}
        <Link to="/admin" className="btn secondary" style={{ marginLeft: 12 }}>Admin</Link>
      </div>

      {flash && <div className={`till-flash ${flash.type}`}>{flash.text}</div>}

      <div className="till-grid">
        {/* LEFT: scan + catalogue */}
        <div className="till-catalogue">
          <input
            ref={scanRef}
            className="till-scan"
            placeholder="Scan barcode or type to search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onScanKey}
            autoFocus
          />
          {categories.length > 0 && (
            <div className="till-cats">
              <button className={`till-cat ${categoryId === '' ? 'active' : ''}`} onClick={() => setCategoryId('')}>All</button>
              {categories.map((c) => (
                <button
                  key={c.id}
                  className={`till-cat ${String(categoryId) === String(c.id) ? 'active' : ''}`}
                  onClick={() => setCategoryId(c.id)}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          <div className="till-products">
            {filtered.map((p) => (
              <button
                key={p.id}
                className="till-product"
                disabled={p.stock_qty <= 0}
                onClick={() => addProduct(p)}
              >
                <div className="till-product-name">{p.name}</div>
                {p.name_th && <div className="muted" style={{ fontSize: 12 }}>{p.name_th}</div>}
                <div className="till-product-foot">
                  <span className="price">{money(p.price)}</span>
                  <span className={`muted ${p.stock_qty <= 0 ? 'err' : ''}`}>{p.stock_qty} in stock</span>
                </div>
              </button>
            ))}
            {filtered.length === 0 && <p className="muted center">No products match.</p>}
          </div>
        </div>

        {/* RIGHT: basket + payment */}
        <div className="till-basket">
          <h3 style={{ marginTop: 0 }}>Current sale</h3>
          {basket.length === 0 ? (
            <p className="muted">Scan or tap a product to start.</p>
          ) : (
            <div className="till-lines">
              {basket.map((i) => (
                <div className="till-line" key={i.id}>
                  <div style={{ flex: 1 }}>
                    <div>{i.name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{money(i.price)} each</div>
                  </div>
                  <div className="till-qty">
                    <button onClick={() => setQty(i.id, i.qty - 1)}>−</button>
                    <span>{i.qty}</span>
                    <button onClick={() => setQty(i.id, i.qty + 1)}>+</button>
                  </div>
                  <div style={{ width: 64, textAlign: 'right' }}>{money(i.price * i.qty)}</div>
                  <button className="till-x" onClick={() => removeLine(i.id)}>×</button>
                </div>
              ))}
            </div>
          )}

          <div className="till-total">
            <span>Total</span>
            <span>{money(subtotal)}</span>
          </div>

          <div className="till-pay">
            <div className="row" style={{ gap: 8 }}>
              <button className={`btn ${payment === 'cash' ? '' : 'secondary'}`} onClick={() => setPayment('cash')}>💵 Cash</button>
              <button className={`btn ${payment === 'card' ? '' : 'secondary'}`} onClick={() => setPayment('card')}>💳 Card</button>
            </div>
            {payment === 'cash' && (
              <div style={{ marginTop: 10 }}>
                <label>Cash received</label>
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder={subtotal.toFixed(2)}
                  value={tendered}
                  onChange={(e) => setTendered(e.target.value)}
                />
                {tendered !== '' && Number(tendered) >= subtotal && (
                  <div className="till-change">Change: <strong>{money(change)}</strong></div>
                )}
              </div>
            )}
          </div>

          <button
            className="btn till-complete"
            disabled={basket.length === 0 || busy}
            onClick={completeSale}
          >
            {busy ? 'Saving…' : `Complete sale · ${money(subtotal)}`}
          </button>
        </div>
      </div>

      {/* Receipt modal */}
      {receipt && (
        <div className="till-modal" onClick={() => setReceipt(null)}>
          <div className="till-receipt" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>✅ Sale #{receipt.id}</h2>
            {receipt.items.map((it, idx) => (
              <div className="row" key={idx} style={{ justifyContent: 'space-between' }}>
                <span>{it.name} × {it.qty}</span>
                <span>{money(it.line_total)}</span>
              </div>
            ))}
            <hr />
            <div className="row" style={{ justifyContent: 'space-between', fontWeight: 800 }}>
              <span>Total</span><span>{money(receipt.total)}</span>
            </div>
            <div className="muted" style={{ marginTop: 4 }}>Paid by {receipt.payment_method}</div>
            {receipt.change_given != null && (
              <div className="till-change" style={{ fontSize: 20 }}>Change due: <strong>{money(receipt.change_given)}</strong></div>
            )}
            <button className="btn" style={{ marginTop: 16, width: '100%' }} onClick={() => { setReceipt(null); scanRef.current?.focus(); }}>
              Next customer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
