import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

// Friendly status wording — mirrors OrdersSection.orderState so customers see
// the same labels staff do.
function orderState(o) {
  if (o.status === 'cancelled') return { label: 'Cancelled', cls: 'off' };
  if (o.payment_status === 'refunded') return { label: 'Refunded', cls: 'off' };
  if (o.payment_status !== 'paid') return { label: 'Awaiting payment', cls: 'off' };
  if (o.status === 'dispatched') return { label: 'Dispatched', cls: 'ok' };
  return { label: 'Paid', cls: 'ok' };
}

function money(n) {
  return `£${Number(n || 0).toFixed(2)}`;
}

// ----- Auth view (login / register toggle) -----------------------------------
function AuthView({ onAuthed }) {
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      let res;
      if (mode === 'login') {
        res = await api.accountLogin({ email: email.trim(), password });
      } else {
        res = await api.accountRegister({
          email: email.trim(),
          name: name.trim(),
          phone: phone.trim(),
          password,
          marketing_consent: consent,
        });
      }
      api.customerAuth.set(res.token);
      onAuthed();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 420 }}>
      <div className="panel">
        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          <button
            type="button"
            className={`btn ${mode === 'login' ? '' : 'secondary'}`}
            onClick={() => { setMode('login'); setError(''); }}
          >
            Log in
          </button>
          <button
            type="button"
            className={`btn ${mode === 'register' ? '' : 'secondary'}`}
            onClick={() => { setMode('register'); setError(''); }}
          >
            Create account
          </button>
        </div>

        <form onSubmit={submit}>
          {mode === 'register' && (
            <>
              <label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </>
          )}

          <label>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus={mode === 'login'}
          />

          {mode === 'register' && (
            <>
              <label>Phone</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </>
          )}

          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {mode === 'register' && (
            <label className="row" style={{ marginTop: 12, gap: 8 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>Email me offers &amp; news</span>
            </label>
          )}

          {error && <p className="err">{error}</p>}

          <button className="btn" style={{ width: '100%', marginTop: 12 }} disabled={busy}>
            {busy
              ? 'Please wait…'
              : mode === 'login'
              ? 'Log in'
              : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ----- Logged-in view --------------------------------------------------------
function AccountView({ profile, onProfile, onSignOut }) {
  const [name, setName] = useState(profile.name || '');
  const [phone, setPhone] = useState(profile.phone || '');
  const [consent, setConsent] = useState(!!profile.marketing_consent);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const [orders, setOrders] = useState(null);
  const [ordersErr, setOrdersErr] = useState('');

  useEffect(() => {
    api
      .accountOrders()
      .then(setOrders)
      .catch((e) => setOrdersErr(e.message));
  }, []);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const updated = await api.accountUpdate({
        name: name.trim(),
        phone: phone.trim(),
        marketing_consent: consent,
      });
      onProfile(updated);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container">
      <div className="row" style={{ marginTop: 16 }}>
        <h1 style={{ margin: 0 }}>Hi {profile.name || 'there'} 👋</h1>
        <div className="spacer" />
        <button className="btn secondary" onClick={onSignOut}>Sign out</button>
      </div>

      <div className="account-grid">
        <form className="panel" onSubmit={save}>
          <h3 style={{ marginTop: 0 }}>Your details</h3>
          <label>Email</label>
          <input value={profile.email || ''} readOnly disabled />
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>Phone</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} />
          <label className="row" style={{ marginTop: 12, gap: 8 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>Email me offers &amp; news</span>
          </label>
          {error && <p className="err">{error}</p>}
          {saved && <p style={{ color: '#16a34a', fontSize: 13 }}>Saved ✓</p>}
          <button className="btn" style={{ marginTop: 12 }} disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </form>

        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Account summary</h3>
          <div className="kpi-grid account-kpis">
            <div className="kpi">
              <div className="kpi-label">Orders</div>
              <div className="kpi-value">{profile.order_count ?? 0}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Total spent</div>
              <div className="kpi-value">{money(profile.total_spent)}</div>
            </div>
          </div>
          {profile.created_at && (
            <p className="muted" style={{ fontSize: 13 }}>
              Member since {new Date(profile.created_at).toLocaleDateString()}
            </p>
          )}
        </div>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Order history</h3>
        {ordersErr && <p className="err">{ordersErr}</p>}
        {!orders && !ordersErr && <p className="muted">Loading…</p>}
        {orders && orders.length === 0 && <p className="muted">No orders yet.</p>}
        {orders && orders.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Date</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const st = orderState(o);
                return (
                  <tr key={o.id}>
                    <td>
                      <Link to={`/order/status?order=${o.id}&email=${encodeURIComponent(profile.email || '')}`}>
                        #{o.id}
                      </Link>
                    </td>
                    <td className="muted">{new Date(o.created_at).toLocaleDateString()}</td>
                    <td><span className={`tag ${st.cls}`}>{st.label}</span></td>
                    <td style={{ textAlign: 'right' }}>{money(o.total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function AccountScreen() {
  const [checking, setChecking] = useState(true);
  const [profile, setProfile] = useState(null);

  async function loadProfile() {
    try {
      const p = await api.accountMe();
      setProfile(p);
    } catch (e) {
      if (e.status === 401) api.customerAuth.clear();
      setProfile(null);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (!api.customerAuth.get()) {
      setChecking(false);
      return;
    }
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onAuthed() {
    setChecking(true);
    loadProfile();
  }

  function signOut() {
    api.customerAuth.clear();
    setProfile(null);
  }

  if (checking) return <div className="container center muted">Loading…</div>;
  if (!profile) return <AuthView onAuthed={onAuthed} />;
  return (
    <AccountView
      profile={profile}
      onProfile={setProfile}
      onSignOut={signOut}
    />
  );
}
