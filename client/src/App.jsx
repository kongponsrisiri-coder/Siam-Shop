import React from 'react';
import { Routes, Route, Link, Navigate } from 'react-router-dom';
import { useCart } from './cart.jsx';

import StorefrontScreen from './screens/StorefrontScreen.jsx';
import ProductScreen from './screens/ProductScreen.jsx';
import CartScreen from './screens/CartScreen.jsx';
import CheckoutScreen from './screens/CheckoutScreen.jsx';
import AdminScreen from './screens/admin/AdminScreen.jsx';

function TopBar() {
  const { count } = useCart();
  return (
    <div className="topbar">
      <Link to="/" className="brand">Siam<span>Shop</span></Link>
      <div className="navlinks">
        <Link to="/">Shop</Link>
        <Link to="/cart">Cart{count > 0 ? ` (${count})` : ''}</Link>
        <Link to="/admin">Admin</Link>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <>
      <TopBar />
      <Routes>
        <Route path="/" element={<StorefrontScreen />} />
        <Route path="/product/:id" element={<ProductScreen />} />
        <Route path="/cart" element={<CartScreen />} />
        <Route path="/checkout" element={<CheckoutScreen />} />
        <Route path="/order/success" element={<CheckoutScreen success />} />
        <Route path="/admin/*" element={<AdminScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
