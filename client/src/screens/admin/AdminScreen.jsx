import React, { useEffect, useState } from 'react';
import { api, auth, staffSession } from '../../api.js';
import { isDemo, setDemo } from '../../demo.js';
import StaffGate, { roleAllowed } from '../../components/StaffGate.jsx';
import { isElectron } from '../../electron.js';
import DashboardSection from './DashboardSection.jsx';
import ReportsSection from './ReportsSection.jsx';
import ProductsSection from './ProductsSection.jsx';
import CategoriesSection from './CategoriesSection.jsx';
import OrdersSection from './OrdersSection.jsx';
import CustomersSection from './CustomersSection.jsx';
import SettingsSection from './SettingsSection.jsx';
import StaffSection from './StaffSection.jsx';
import DeviceSection from './DeviceSection.jsx';

const TABS = [
  { key: 'dashboard', label: 'Dashboard', Comp: DashboardSection },
  { key: 'reports', label: 'Reports', Comp: ReportsSection },
  { key: 'products', label: 'Products', Comp: ProductsSection },
  { key: 'categories', label: 'Categories', Comp: CategoriesSection },
  { key: 'orders', label: 'Orders', Comp: OrdersSection },
  { key: 'customers', label: 'Customers', Comp: CustomersSection },
  { key: 'staff', label: 'Staff', Comp: StaffSection },
  { key: 'settings', label: 'Settings', Comp: SettingsSection },
  ...(isElectron ? [{ key: 'device', label: 'This device', Comp: DeviceSection }] : []),
];

export default function AdminScreen() {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState('dashboard');
  const [demo, setDemoState] = useState(isDemo());

  function toggleDemo() {
    const next = !demo;
    setDemo(next);
    setDemoState(next);
  }

  useEffect(() => {
    if (!auth.get()) {
      setChecking(false);
      return;
    }
    // Admin needs a manager or the owner — a cashier's till token is not enough.
    api
      .me()
      .then((me) => { if (roleAllowed(me.role, 'manager')) setAuthed(true); })
      .catch((e) => { if (e.status === 401 || e.status === 403) { auth.clear(); staffSession.clear(); } }) // a network blip must not sign staff out
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <div className="container center muted">Loading…</div>;
  if (!authed) return <StaffGate need="manager" title="Admin sign in" onIn={() => setAuthed(true)} />;

  const Active = TABS.find((t) => t.key === tab)?.Comp || DashboardSection;

  return (
    <div className="container">
      <div className="row" style={{ marginTop: 16 }}>
        <h1 style={{ margin: 0 }}>Admin</h1>
        <div className="spacer" />
        <button
          className={`btn ${demo ? '' : 'secondary'}`}
          onClick={toggleDemo}
          title="Hide real customer names/emails for screenshots (display only — no data changed)"
        >
          {demo ? '🟢 Demo mode ON' : 'Demo mode'}
        </button>
        <button
          className="btn secondary"
          onClick={() => {
            auth.clear();
            staffSession.clear();
            setAuthed(false);
          }}
        >
          Sign out
        </button>
      </div>
      {demo && (
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
          Demo mode is on — customer names &amp; emails are replaced with fake data for screenshots. Real data is unchanged. Turn off when done.
        </p>
      )}

      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`btn ${tab === t.key ? '' : 'secondary'}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Active onGoToOrders={() => setTab('orders')} />
    </div>
  );
}
