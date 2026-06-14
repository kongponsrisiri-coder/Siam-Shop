import React, { useEffect, useState } from 'react';
import { api, auth } from '../../api.js';
import ProductsSection from './ProductsSection.jsx';
import OrdersSection from './OrdersSection.jsx';
import SettingsSection from './SettingsSection.jsx';

function LoginForm({ onLoggedIn }) {
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
      onLoggedIn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 380 }}>
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>Admin sign in</h1>
        <form onSubmit={submit}>
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          {error && <p className="err">{error}</p>}
          <button className="btn" style={{ marginTop: 12 }} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

const TABS = [
  { key: 'products', label: 'Products', Comp: ProductsSection },
  { key: 'orders', label: 'Orders', Comp: OrdersSection },
  { key: 'settings', label: 'Settings', Comp: SettingsSection },
];

export default function AdminScreen() {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState('products');

  useEffect(() => {
    if (!auth.get()) {
      setChecking(false);
      return;
    }
    api
      .me()
      .then(() => setAuthed(true))
      .catch(() => auth.clear())
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <div className="container center muted">Loading…</div>;
  if (!authed) return <LoginForm onLoggedIn={() => setAuthed(true)} />;

  const Active = TABS.find((t) => t.key === tab)?.Comp || ProductsSection;

  return (
    <div className="container">
      <div className="row" style={{ marginTop: 16 }}>
        <h1 style={{ margin: 0 }}>Admin</h1>
        <div className="spacer" />
        <button
          className="btn secondary"
          onClick={() => {
            auth.clear();
            setAuthed(false);
          }}
        >
          Sign out
        </button>
      </div>

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

      <Active />
    </div>
  );
}
