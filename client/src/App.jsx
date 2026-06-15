import React from 'react';
import { Routes, Route, Link, Navigate } from 'react-router-dom';
import { useCart } from './cart.jsx';
import { useLang, useT } from './lang.jsx';

import StorefrontScreen from './screens/StorefrontScreen.jsx';
import ProductScreen from './screens/ProductScreen.jsx';
import CartScreen from './screens/CartScreen.jsx';
import CheckoutScreen from './screens/CheckoutScreen.jsx';
import AdminScreen from './screens/admin/AdminScreen.jsx';
import TillScreen from './screens/TillScreen.jsx';
import ScannerScreen from './screens/ScannerScreen.jsx';
import OrderStatusScreen from './screens/OrderStatusScreen.jsx';
import AccountScreen from './screens/AccountScreen.jsx';

function LangToggle() {
  const { lang, toggle } = useLang();
  return (
    <button
      type="button"
      className="lang-toggle"
      onClick={toggle}
      title="Switch language / เปลี่ยนภาษา"
    >
      {lang === 'th' ? 'TH ไทย' : 'EN'}
    </button>
  );
}

function TopBar() {
  const { count } = useCart();
  const t = useT();
  return (
    <div className="topbar">
      <Link to="/" className="brand">Siam<span>Shop</span></Link>
      <div className="navlinks">
        <Link to="/">{t('shop')}</Link>
        <Link to="/cart">{t('cart')}{count > 0 ? ` (${count})` : ''}</Link>
        <Link to="/order/status">{t('track')}</Link>
        <Link to="/account">{t('account')}</Link>
        <LangToggle />
        {/* Staff shortcuts (login-gated). Shown for the owner's convenience. */}
        <span className="staff-links">
          <Link to="/admin" className="staff-link">Admin</Link>
          <Link to="/till" className="staff-link">Till</Link>
          <Link to="/scan" className="staff-link">Scan</Link>
        </span>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      {/* Till and scanner are focused full-screen surfaces with their own headers. */}
      <Route path="/till" element={<TillScreen />} />
      <Route path="/scan" element={<ScannerScreen />} />
      <Route
        path="*"
        element={
          <>
            <TopBar />
            <Routes>
              <Route path="/" element={<StorefrontScreen />} />
              <Route path="/product/:id" element={<ProductScreen />} />
              <Route path="/cart" element={<CartScreen />} />
              <Route path="/checkout" element={<CheckoutScreen />} />
              <Route path="/order/success" element={<CheckoutScreen success />} />
              <Route path="/order/status" element={<OrderStatusScreen />} />
              <Route path="/account" element={<AccountScreen />} />
              <Route path="/admin/*" element={<AdminScreen />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </>
        }
      />
    </Routes>
  );
}
