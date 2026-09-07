import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, auth, staffSession } from '../api.js';
import { Logo } from '../components/Logo.jsx';
import OptionPicker from '../components/OptionPicker.jsx';
import StaffGate, { StaffChip } from '../components/StaffGate.jsx';
import PostalOrders from '../components/PostalOrders.jsx';
import { OpenTillModal, CloseTillModal } from '../components/TillSession.jsx';
import DiscountModal from '../components/DiscountModal.jsx';
import ManagerPin from '../components/ManagerPin.jsx';
import { isElectron, electronConfig, desktop } from '../electron.js';
import { createScanCapture, stripScanFromInput, isTextTarget, SUFFIX_KEYS } from '../scanner.js';
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
  // Till session (SIAMSHOP-TILL-001): null = unknown, {session:null} = none open
  const [till, setTill] = useState(null);
  const [tillModal, setTillModal] = useState(null); // 'open' | 'close' | null
  async function loadTill() {
    try {
      const t = await api.tillSession();
      setTill(t);
      if (!t.session) setTillModal((m) => (m === 'dismissed' ? m : 'open'));
      // Auto-opened by a sale with no float recorded yet → ask once.
      else if (t.session.auto_opened && Number(t.session.float_amount) === 0) setTillModal((m) => (m === 'dismissed' || m === 'close' ? m : 'float'));
    } catch { /* ignore */ }
  }
  const [search, setSearch] = useState('');
  const [payment, setPayment] = useState('cash');
  const [fulfilment, setFulfilment] = useState('takeaway'); // takeaway | dine_in (SIAMSHOP-504)
  const [tendered, setTendered] = useState('');
  const [flash, setFlash] = useState(null); // {type, text}
  const [receipt, setReceipt] = useState(null);
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState(false);
  // HOTFIX 0.1.2: every useState lives ABOVE the useMemo maths block. A4 put
  // basketDiscount below it → TDZ ReferenceError on first render → blank window.
  const [printMsg, setPrintMsg] = useState('');
  const [lastSale, setLastSale] = useState(null); // SIAMSHOP-RECEIPT-001: reprint last receipt
  // Discounts (SIAMSHOP-DISCOUNT-001): per line (basket[i].discount) + basket-level.
  const [basketDiscount, setBasketDiscount] = useState(null); // { type, value, reason, amount }
  const [discountModal, setDiscountModal] = useState(null); // { key } | 'basket' | null
  const [approval, setApproval] = useState(null); // pending sale awaiting manager approval
  const [shopSettings, setShopSettings] = useState(null);
  useEffect(() => { if (authed) api.getSettings().then(setShopSettings).catch(() => {}); }, [authed]);
  const [voiding, setVoiding] = useState(null); // basket line awaiting a void reason (SIAMSHOP-REFUND-001)
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
      loadTill();
    }
  }, [authed]);

  const lineGross = (i) => Number(i.price) * i.qty;
  const lineDisc = (i) => (!i.discount ? 0 : i.discount.type === 'percent' ? lineGross(i) * Math.min(100, i.discount.value) / 100 : Math.min(i.discount.value, lineGross(i)));
  const lineNet = (i) => lineGross(i) - lineDisc(i);
  const linesNet = useMemo(() => basket.reduce((s, i) => s + lineNet(i), 0), [basket]);
  const basketDiscAmount = useMemo(() => (!basketDiscount ? 0 : basketDiscount.type === 'percent' ? linesNet * Math.min(100, basketDiscount.value) / 100 : Math.min(basketDiscount.value, linesNet)), [basketDiscount, linesNet]);
  const subtotal = useMemo(() => +(linesNet - basketDiscAmount).toFixed(2), [linesNet, basketDiscAmount]);
  const totalDiscount = useMemo(() => +(basket.reduce((s, i) => s + lineDisc(i), 0) + basketDiscAmount).toFixed(2), [basket, basketDiscAmount]);
  const change = useMemo(() => {
    const t = Number(tendered);
    return payment === 'cash' && t >= subtotal ? t - subtotal : 0;
  }, [tendered, subtotal, payment]);
  function setLineDiscount(key, d) {
    setBasket((prev) => prev.map((i) => (i.key === key ? { ...i, discount: d } : i)));
  }

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
    const line = basket.find((i) => i.key === key);
    if (line) setVoiding(line); else setBasket((prev) => prev.filter((i) => i.key !== key));
  }
  async function confirmVoid(reason) {
    const line = voiding;
    setVoiding(null);
    setBasket((prev) => prev.filter((i) => i.key !== line.key));
    // Logged for the Z / day report; nothing was sold so nothing moves.
    api.tillVoid({ product_id: line.id, name: line.name, qty: line.qty, amount: +(lineNet(line)).toFixed(2), reason }).catch(() => {});
  }

  // Barcode scanner anywhere on the screen (SIAMSHOP-DEVICE-001 D2): a fast
  // keystroke burst ending in the scanner's suffix is a scan even when the
  // focus is in another box (tendered amount, a modal…) — it goes to the
  // basket and is stripped from wherever it landed. The scan input keeps its
  // own handler below; this listener skips events that come from it.
  const scannerCfg = electronConfig.scanner || { suffix: 'enter', captureAnywhere: true };
  useEffect(() => {
    if (!authed || scannerCfg.captureAnywhere === false) return undefined;
    const cap = createScanCapture({
      suffix: scannerCfg.suffix || 'enter',
      onScan: async (code, meta) => {
        if (meta.target && meta.target !== scanRef.current) stripScanFromInput(meta.target, code);
        try { const p = await api.lookupBarcode(code); addProduct(p); showFlash('ok', `Scanned ${p.name}`); }
        catch { showFlash('err', `No product with barcode ${code}`); }
      },
    });
    const onKey = (e) => {
      if (e.target === scanRef.current) return; // the scan box handles its own keys
      cap.handleKey({ key: e.key, now: performance.now(), target: isTextTarget(e.target) ? e.target : null, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, preventDefault: () => e.preventDefault() });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, scannerCfg.suffix, scannerCfg.captureAnywhere]);

  // Scan box: on the scanner's suffix key (Enter, or Tab for some scanners),
  // try an exact barcode lookup; if no match, leave the text as a name filter.
  async function onScanKey(e) {
    const suffixKey = SUFFIX_KEYS[scannerCfg.suffix] || 'Enter';
    if (e.key !== 'Enter' && e.key !== suffixKey) return;
    if (e.key === 'Tab') e.preventDefault();
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

  async function completeSale(approvalToken) {
    if (basket.length === 0) return;
    if (payment === 'cash' && tendered !== '' && Number(tendered) < subtotal) {
      return showFlash('err', 'Cash tendered is less than the total');
    }
    setBusy(true);
    try {
      const sale = await api.createSale({
        items: basket.map((i) => ({ product_id: i.id, qty: i.qty, option_ids: i.option_ids, discount: i.discount ? { type: i.discount.type, value: i.discount.value, reason: i.discount.reason } : undefined })),
        discount: basketDiscount ? { type: basketDiscount.type, value: basketDiscount.value, reason: basketDiscount.reason } : undefined,
        approval_token: approvalToken,
        payment_method: payment,
        fulfilment,
        amount_tendered: payment === 'cash' && tendered !== '' ? Number(tendered) : undefined,
      });
      setReceipt(sale);
      setLastSale(sale);
      setBasket([]);
      setBasketDiscount(null);
      setTendered('');
      setFulfilment('takeaway');
      setSearch('');
      // Desktop till (SIAMSHOP-ELECTRON-001): print + kick the drawer on cash.
      if (isElectron) {
        const pr = electronConfig.printer || {};
        if (pr.kickDrawerOnCash !== false && sale.payment_method === 'cash') desktop.kickDrawer().catch(() => {});
        if (pr.autoPrint !== false) printReceipt(sale);
      }
      await Promise.all([loadCatalogue(), loadSummary(), loadTill()]);
      scanRef.current?.focus();
    } catch (err) {
      // Over the discount threshold → a manager taps their PIN, then we retry with the one-off token.
      if (err.status === 403 && /approval/i.test(err.message)) setApproval({ message: err.message });
      else showFlash('err', err.message);
    } finally {
      setBusy(false);
    }
  }

  async function printReceipt(sale, { copies } = {}) {
    setPrintMsg('Printing…');
    const st = shopSettings || {};
    const r = await desktop.printReceipt({
      shopName: electronConfig.shopName || 'SiamShop',
      header: st.receipt_header || '',
      footer: st.receipt_footer || '',
      vatNote: st.vat_number ? `VAT No. ${st.vat_number}` : '',
      copies: copies ?? st.receipt_copies ?? 1,
      logo: st.brand_logo || '', showLogo: !!st.receipt_show_logo, // SIAMSHOP-DEVICE-001 D4
      orderId: sale.id,
      staff: sale.staff || staffSession.get()?.name || '',
      createdAt: sale.created_at,
      fulfilment: sale.fulfilment || fulfilment,
      items: (sale.items || []).map((it) => ({
        name: it.name, qty: it.qty, line_total: it.line_total, gross: it.gross ?? it.line_total,
        unit_price: it.qty ? Number(it.gross ?? it.line_total) / it.qty : it.line_total,
        options: (it.options || []).map((o) => o.name),
        discount: it.discount || null,
      })),
      discount: sale.discount || null, discount_amount: sale.discount_amount || 0,
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
        {till && (till.session ? (
          <button className="btn secondary" style={{ marginLeft: 12 }} onClick={() => setTillModal('close')} title={`Open since ${new Date(till.session.opened_at).toLocaleTimeString()} · float £${Number(till.session.float_amount).toFixed(2)}`}>
            🧮 Close till{till.session.auto_opened && Number(till.session.float_amount) === 0 ? ' · set float' : ''}
          </button>
        ) : (
          <button className="btn" style={{ marginLeft: 12 }} onClick={() => setTillModal('open')}>🔓 Open till</button>
        ))}
        {isElectron && lastSale && (
          <button className="btn secondary" style={{ marginLeft: 8 }} onClick={() => printReceipt(lastSale, { copies: 1 })} title={`Reprint receipt #${lastSale.id}`}>🖨 Reprint last</button>
        )}
        <button className="btn secondary" style={{ marginLeft: 8 }} onClick={() => setPostOpen(true)}>📦 Post</button>
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
                  <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => setDiscountModal({ key: i.key })} title="Tap for a line discount">
                    <div>{i.name}</div>
                    {i.options.length > 0 && (
                      <div className="line-opts">{i.options.map((o) => o.name).join(', ')}</div>
                    )}
                    <div className="muted" style={{ fontSize: 12 }}>{money(i.price)} each</div>
                    {i.discount && <div className="line-opts" style={{ color: '#b45309' }}>−{money(lineDisc(i))} · {i.discount.reason}</div>}
                  </div>
                  <div className="till-qty">
                    <button onClick={() => setQty(i.key, i.qty - 1)}>−</button>
                    <span>{i.qty}</span>
                    <button onClick={() => setQty(i.key, i.qty + 1)}>+</button>
                  </div>
                  <div style={{ width: 64, textAlign: 'right' }}>{money(lineNet(i))}</div>
                  <button className="till-x" onClick={() => removeLine(i.key)}>×</button>
                </div>
              ))}
            </div>
          )}

          {basket.length > 0 && (
            <div className="row" style={{ justifyContent: 'space-between', fontSize: 13, marginTop: 6 }}>
              <button className="btn mini secondary" onClick={() => setDiscountModal('basket')}>
                {basketDiscount ? `Basket discount: −${money(basketDiscAmount)} · ${basketDiscount.reason}` : '% Basket discount'}
              </button>
              {totalDiscount > 0 && <span className="muted">Discounts −{money(totalDiscount)}</span>}
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
            onClick={() => completeSale()}
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
      {voiding && (
        <div className="till-modal" onClick={() => setVoiding(null)} style={{ zIndex: 55 }}>
          <div className="till-receipt" style={{ width: 380 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Remove {voiding.name} × {voiding.qty}</h3>
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Why is it coming off the sale?</p>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {(shopSettings?.void_reasons || ['Customer changed mind', 'Wrong item', 'Damaged', 'Wastage', 'Faulty']).map((r) => (
                <button key={r} type="button" className="btn secondary" onClick={() => confirmVoid(r)}>{r}</button>
              ))}
            </div>
            <button type="button" className="btn ghost" style={{ marginTop: 10, width: '100%' }} onClick={() => setVoiding(null)}>Keep it</button>
          </div>
        </div>
      )}
      {discountModal === 'basket' && (
        <DiscountModal title="Basket discount" base={linesNet} reasons={shopSettings?.discount_reasons || ['Damaged', 'Near date', 'Staff', 'Manager goodwill', 'Price match']} initial={basketDiscount}
          onApply={(d) => { setBasketDiscount(d); setDiscountModal(null); }} onRemove={() => { setBasketDiscount(null); setDiscountModal(null); }} onClose={() => setDiscountModal(null)} />
      )}
      {discountModal && discountModal.key && (() => { const line = basket.find((i) => i.key === discountModal.key); return line ? (
        <DiscountModal title={`Discount — ${line.name}`} base={lineGross(line)} reasons={shopSettings?.discount_reasons || ['Damaged', 'Near date', 'Staff', 'Manager goodwill', 'Price match']} initial={line.discount}
          onApply={(d) => { setLineDiscount(line.key, d); setDiscountModal(null); }} onRemove={() => { setLineDiscount(line.key, null); setDiscountModal(null); }} onClose={() => setDiscountModal(null)} />
      ) : null; })()}
      {approval && (
        <ManagerPin title="Manager approval for this discount" reason={approval.message} onClose={() => setApproval(null)}
          onApproved={({ token }) => { setApproval(null); completeSale(token); }} />
      )}
      {tillModal === 'open' && <OpenTillModal onOpened={(t) => { setTill(t); setTillModal(null); showFlash('ok', 'Till open'); }} onClose={() => setTillModal('dismissed')} />}
      {tillModal === 'float' && <OpenTillModal mode="float" onOpened={(t) => { setTill(t); setTillModal(null); showFlash('ok', 'Float saved'); }} onClose={() => setTillModal('dismissed')} />}
      {tillModal === 'close' && till?.session && (
        <CloseTillModal summary={till.summary} onClose={() => setTillModal(null)} onClosed={() => { setTillModal(null); setTill({ session: null }); loadSummary(); }} />
      )}

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
                  {it.discount && <div className="line-opts" style={{ color: '#b45309' }}>Discount − {money(it.discount.amount)} · {it.discount.reason}</div>}
                </span>
                <span>{money(it.line_total)}</span>
              </div>
            ))}
            {receipt.discount && <div className="row" style={{ justifyContent: 'space-between', color: '#b45309' }}><span>Basket discount · {receipt.discount.reason}</span><span>−{money(receipt.discount.amount)}</span></div>}
            {receipt.discount_approved_by && <div className="muted" style={{ fontSize: 12 }}>Approved by {receipt.discount_approved_by}</div>}
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
                <button className="btn secondary" style={{ flex: 1 }} onClick={() => printReceipt(receipt, { copies: 1 })}>🖨 Print receipt</button>
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
