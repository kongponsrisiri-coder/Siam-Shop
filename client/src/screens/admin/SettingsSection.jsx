import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

// Placeholder settings panel. Editable per-shop settings (delivery fees,
// shop email, branding) land in later tickets (SIAMSHOP-007 / -010).
export default function SettingsSection() {
  const [shop, setShop] = useState(null);
  const [health, setHealth] = useState(null);

  useEffect(() => {
    api.getShop().then(setShop).catch(() => {});
    api.health().then(setHealth).catch(() => {});
  }, []);

  return (
    <div>
      <h2>Settings</h2>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Shop</h3>
        {shop ? (
          <table>
            <tbody>
              <tr><th>Name</th><td>{shop.name}</td></tr>
              <tr><th>Slug</th><td>{shop.slug}</td></tr>
              <tr><th>Shop ID</th><td>{shop.id}</td></tr>
            </tbody>
          </table>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>System status</h3>
        {health ? (
          <table>
            <tbody>
              <tr><th>Service</th><td>{health.service}</td></tr>
              <tr><th>Database</th><td>{health.db}</td></tr>
              <tr><th>Stripe</th><td>{health.stripe}</td></tr>
            </tbody>
          </table>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>

      <div className="panel" style={{ background: '#fff8e1', borderColor: '#f2a900' }}>
        <strong>Coming soon</strong>
        <ul className="muted">
          <li>Delivery zones &amp; fees (SIAMSHOP-007)</li>
          <li>AI product descriptions (SIAMSHOP-008)</li>
          <li>Shop branding &amp; email settings (SIAMSHOP-010)</li>
        </ul>
      </div>
    </div>
  );
}
