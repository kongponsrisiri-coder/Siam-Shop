import React, { useEffect } from 'react';
import { Routes, Route, Link, Navigate } from 'react-router-dom';
import { useCart } from './cart.jsx';
import { useLang, useT } from './lang.jsx';
import { Logo } from './components/Logo.jsx';
import Assistant from './components/Assistant.jsx';

import StorefrontScreen from './screens/StorefrontScreen.jsx';
import ProductScreen from './screens/ProductScreen.jsx';
import CartScreen from './screens/CartScreen.jsx';
import CheckoutScreen from './screens/CheckoutScreen.jsx';
import AdminScreen from './screens/admin/AdminScreen.jsx';
import TillScreen from './screens/TillScreen.jsx';
import ScannerScreen from './screens/ScannerScreen.jsx';
import OrderStatusScreen from './screens/OrderStatusScreen.jsx';
import AccountScreen from './screens/AccountScreen.jsx';
import AddToBasketScreen from './screens/AddToBasketScreen.jsx';
import PrepScreen from './screens/PrepScreen.jsx';
import { isElectron } from './electron.js';
import { api } from './api.js';
import { applyBrandTheme } from './theme.js';

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
  // Desktop till (SIAMSHOP-ELECTRON-001) is a staff device: no customer nav.
  if (isElectron) {
    return (
      <div className="topbar">
        <Link to="/till" className="brand" aria-label="SiamShop"><Logo size={30} /></Link>
        <div className="navlinks">
          <Link to="/till">Till</Link>
          <Link to="/prep">Prep</Link>
          <Link to="/admin">Admin</Link>
        </div>
      </div>
    );
  }
  return (
    <div className="topbar">
      <Link to="/" className="brand" aria-label="SiamShop home"><Logo size={30} /></Link>
      <div className="navlinks">
        <Link to="/">{t('shop')}</Link>
        <Link to="/cart">{t('cart')}{count > 0 ? ` (${count})` : ''}</Link>
        <Link to="/order/status">{t('track')}</Link>
        <Link to="/account">{t('account')}</Link>
        <LangToggle />
        {/* No back-office links here: this header is what customers see, and
            Admin/Till/Prep/Scan advertised the staff doors to all of them
            (Korakot, 7 Sep). Staff reach them by URL, a bookmark, or the
            desktop till, which has its own nav above. */}
      </div>
    </div>
  );
}

export default function App() {
  // Per-shop brand (SIAMSHOP-DEVICE-001): colours + logo from shop settings.
  useEffect(() => { api.getSettings().then(applyBrandTheme).catch(() => {}); }, []);
  return (
    <Routes>
      {/* Till and scanner are focused full-screen surfaces with their own headers. */}
      <Route path="/till" element={<TillScreen />} />
      <Route path="/prep" element={<PrepScreen />} />
      <Route path="/scan" element={<ScannerScreen />} />
      <Route
        path="*"
        element={
          <>
            <TopBar />
            <Routes>
              <Route path="/" element={isElectron ? <Navigate to="/till" replace /> : <StorefrontScreen />} />
              <Route path="/product/:id" element={<ProductScreen />} />
              {/* Deep link from a marketing site: adds the item and lands on the basket. */}
              <Route path="/p/:ref" element={<AddToBasketScreen />} />
              <Route path="/cart" element={<CartScreen />} />
              <Route path="/checkout" element={<CheckoutScreen />} />
              <Route path="/order/success" element={<CheckoutScreen success />} />
              <Route path="/order/status" element={<OrderStatusScreen />} />
              <Route path="/account" element={<AccountScreen />} />
              <Route path="/admin/*" element={<AdminScreen />} />
              <Route path="*" element={<Navigate to={isElectron ? '/till' : '/'} replace />} />
            </Routes>
            {!isElectron && <Assistant />}
          </>
        }
      />
    </Routes>
  );
}
