import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, auth, staffSession } from '../api.js';
import { Logo } from '../components/Logo.jsx';
import OptionPicker from '../components/OptionPicker.jsx';
import StaffGate, { StaffChip } from '../components/StaffGate.jsx';
import PostalOrders from '../components/PostalOrders.jsx';
import { isElectron, electronConfig, desktop } from '../electron.js';
import { describeSelection, hasOptions, lineKey, unitPrice } from '../options.js';

// In-store EPOS till (SIAMSHOP-103). Staff scan a barcode or search by name to
// build a basket, take cash or card, and complete the sale — which decrements
// the shared stock server-side. Works on a tablet, desktop, or phone.
//
// SIAMSHOP-501/502: products with option groups (size / toppings) open a picker
// before they join the basket; a basket line = product + chosen options. Made-
// to-order items (track_stock off) sell at any stock level.

function money(n) {
  return '£' + Number(n || 0).toFixed(2);
}

export default function TillScreen() {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [catalogue, setCatalogue] = useState([]);
  const [categories, setCategories] = useState([]);
  const [categoryId, setCategoryId] = useState(''); // '' = all
  // basket line: {key, id, name, price (unit incl. options), qty, stock_qty, track_stock, option_ids, options}
  const [basket, setBasket] = useState([]);
  const [picking, setPicking] = useState(null); // product awaiting option choice
  const [postOpen, setPostOpen] = useState(false); // 📦 postal orders (SIAMSHOP-POST-001)
  const [search, setSearch] = useState('');
  const [payment, setPayment] = useState('cash');
  const [fulfilment, setFulfilment] = useState('takeaway'); // takeaway | dine_in (SIAMSHOP-504)
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
    api.me().then(() => setAuthed(true)).catch((e) => { if (e.status === 401 || e.status === 403) { auth.clear(); staffSession.clear(); } }).finally(() => setChecking(false));
  }, []);

  async function loadCatalogue() {
    try {
      const [prods, cats] = await Promise.all([
        api.adminListProducts(),
        api.getCategories().catch(() => []),
      ]);
      setCatalogue(prods.filter((p) => p.is_active !== false));
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

  const tracked = (p) => p.track_stock !== false;
  const soldOut = (p) => tracked(p) && Number(p.stock_qty) <= 0;

  // Tap / scan entry point: products with options go via the picker first.
  function addProduct(p) {
    if (soldOut(p)) return showFlash('err', `${p.name} is out of stock`);
    if (hasOptions(p)) return setPicking(p);
    addLine(p, []);
  }

  function addLine(p, optionIds) {
    const key = lineKey(p.id, optionIds);
    setBasket((prev) => {
      const found = prev.find((i) => i.key === key);
      // Stock cap applies across all builds of the same tracked product.
      const already = prev.filter((i) => i.id === p.id).reduce((s, i) => s + i.qty, 0);
      if (tracked(p) && already >= Number(p.stock_qty)) {
        showFlash('err', `Only ${p.stock_qty} of ${p.name} in stock`);
        return prev;
      }
      if (found) return prev.map((i) => (i.key === key ? { ...i, qty: i.qty + 1 } : i));
      return [
        ...prev,
        {
          key,
          id: p.id,
          name: p.name,
          price: unitPrice(p, optionIds),
          qty: 1,
          stock_qty: p.stock_qty,
          track_stock: tracked(p),
          kind: p.kind,
          option_ids: optionIds,
          options: describeSelection(p, optionIds),
        },
      ];
    });
    setPicking(null);
    showFlash('ok', `Added ${p.name}`);
  }

  function setQty(key, qty) {
    setBasket((prev) => prev.map((i) => (i.key === key ? { ...i, qty: Math.max(1, qty) } : i)));
  }
  function removeLine(key) {
    setBasket((prev) => prev.filter((i) => i.key !== key));
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
        items: basket.map((i) => ({ product_id: i.id, qty: i.qty, option_ids: i.option_ids })),
        payment_method: payment,
        fulfilment,
        amount_tendered: payment === 'cash' && tendered !== '' ? Number(tendered) : undefined,
      });
      setReceipt(sale);
      setBasket([]);
      setTendered('');
      setFulfilment('takeaway');
      setSearch('');
      // Desktop till (SIAMSHOP-ELECTRON-001): print + kick the drawer on cash.
      if (isElectron) {
        const pr = electronConfig.printer || {};
        if (pr.kickDrawerOnCash !== false && sale.payment_method === 'cash') desktop.kickDrawer().catch(() => {});
        if (pr.autoPrint !== false) printReceipt(sale);
      }
      await Promise.all([loadCatalogue(), loadSummary()]);
      scanRef.current?.focus();
    } catch (err) {
      showFlash('err', err.message);
    } finally {
      setBusy(false);
    }
  }

  const [printMsg, setPrintMsg] = useState('');
  async function printReceipt(sale) {
    setPrintMsg('Printing…');
    const r = await desktop.printReceipt({
      shopName: electronConfig.shopName || 'SiamShop',
      orderId: sale.id,
      staff: staffSession.get()?.name || '',
      createdAt: sale.created_at,
      fulfilment: sale.fulfilment || fulfilment,
      items: (sale.items || []).map((it) => ({
        name: it.name, qty: it.qty, line_total: it.line_total,
        unit_price: it.qty ? Number(it.line_total) / it.qty : it.line_total,
        options: (it.options || []).map((o) => o.name),
      })),
      subtotal: sale.subtotal, total: sale.total,
      payment_method: sale.payment_method, amount_tendered: sale.amount_tendered, change_given: sale.change_given,
    });
    setPrintMsg(r?.ok ? 'Receipt printed' : `Print failed: ${r?.error || 'unknown'}`);
  }

  if (checking) return <div className="container center muted">Loading…</div>;
  if (!authed) return <StaffGate need="staff" title="Till sign in" onIn={() => setAuthed(true)} />;

  return (
    <div className="till">
      <div className="till-head">
        <Link to="/" className="brand surface-brand"><Logo size={26} light /><span className="surface-tag">Till</span></Link>
        <StaffChip onOut={() => setAuthed(false)} />
        <div className="spacer" />
        {summary && (
          <div className="till-takings">
            Today: <strong>{money(summary.totals.gross)}</strong> · {summary.totals.order_count} sales
          </div>
        )}
        <button className="btn secondary" style={{ marginLeft: 12 }} onClick={() => setPostOpen(true)}>📦 Post</button>
        <Link to="/admin" className="btn secondary" style={{ marginLeft: 8 }}>Admin</Link>
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
                disabled={soldOut(p)}
                onClick={() => addProduct(p)}
              >
                <div className="till-product-name">{p.name}</div>
                {p.name_th && <div className="muted" style={{ fontSize: 12 }}>{p.name_th}</div>}
                {p.available_now === false && (
                  <div className="avail-badge off">Menu: {p.availability_text}</div>
                )}
                <div className="till-product-foot">
                  <span className="price">{hasOptions(p) ? 'from ' : ''}{money(p.price)}</span>
                  {tracked(p) ? (
                    <span className={`muted ${soldOut(p) ? 'err' : ''}`}>{p.stock_qty} in stock</span>
                  ) : (
                    <span className="tag kind-food">{p.kind === 'food' ? 'made to order' : 'no stock count'}</span>
                  )}
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
                <div className="till-line" key={i.key}>
                  <div style={{ flex: 1 }}>
                    <div>{i.name}</div>
                    {i.options.length > 0 && (
                      <div className="line-opts">{i.options.map((o) => o.name).join(', ')}</div>
                    )}
                    <div className="muted" style={{ fontSize: 12 }}>{money(i.price)} each</div>
                  </div>
                  <div className="till-qty">
                    <button onClick={() => setQty(i.key, i.qty - 1)}>−</button>
                    <span>{i.qty}</span>
                    <button onClick={() => setQty(i.key, i.qty + 1)}>+</button>
                  </div>
                  <div style={{ width: 64, textAlign: 'right' }}>{money(i.price * i.qty)}</div>
                  <button className="till-x" onClick={() => removeLine(i.key)}>×</button>
                </div>
              ))}
            </div>
          )}

          <div className="till-total">
            <span>Total</span>
            <span>{money(subtotal)}</span>
          </div>

          {basket.some((i) => i.kind === 'food') && (
            <div className="till-fulfil">
              <button className={`btn ${fulfilment === 'takeaway' ? '' : 'secondary'}`} onClick={() => setFulfilment('takeaway')}>🥡 Take away</button>
              <button className={`btn ${fulfilment === 'dine_in' ? '' : 'secondary'}`} onClick={() => setFulfilment('dine_in')}>🍽 Eat in</button>
            </div>
          )}

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

      {/* Option picker (size / toppings / add-ons) */}
      {picking && (
        <OptionPicker
          product={picking}
          onClose={() => { setPicking(null); scanRef.current?.focus(); }}
          onConfirm={(ids) => { addLine(picking, ids); scanRef.current?.focus(); }}
          confirmLabel="Add to sale"
        />
      )}

      {postOpen && <PostalOrders onClose={() => setPostOpen(false)} />}

      {/* Receipt modal */}
      {receipt && (
        <div className="till-modal" onClick={() => setReceipt(null)}>
          <div className="till-receipt" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>✅ Sale #{receipt.id}</h2>
            {receipt.items.map((it, idx) => (
              <div className="row" key={idx} style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span>
                  {it.name} × {it.qty}
                  {it.options?.length > 0 && <div className="line-opts">{it.options.map((o) => o.name).join(', ')}</div>}
                </span>
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
            {isElectron && (
              <div className="row" style={{ gap: 8, marginTop: 12 }}>
                <button className="btn secondary" style={{ flex: 1 }} onClick={() => printReceipt(receipt)}>🖨 Print receipt</button>
                <button className="btn secondary" onClick={() => desktop.kickDrawer()}>💵 Drawer</button>
              </div>
            )}
            {printMsg && <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{printMsg}</div>}
            <button className="btn" style={{ marginTop: 12, width: '100%' }} onClick={() => { setReceipt(null); setPrintMsg(''); scanRef.current?.focus(); }}>
              Next customer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
