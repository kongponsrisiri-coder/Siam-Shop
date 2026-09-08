// Sign a maintenance script in to a shop.
//
// There are two ways in, and for a long time these scripts only knew one:
// ADMIN_PASSWORD, the owner password set once at sign-up and never used again.
// Korakot signs in with his manager PIN, so asking him for the password meant
// asking for the one credential he does not have to hand (8 Sep: "why do we
// need admin password when we never use it").
//
// A manager PIN gives exactly the same access — requireAuth's roleAllows lets
// admin and manager through everything — so either works. STAFF_PIN is tried
// first because it is the one a shop actually knows.
export async function login(base, shop, { pin = process.env.STAFF_PIN, password = process.env.ADMIN_PASSWORD } = {}) {
  const url = (p) => `${base}${p}?shop=${encodeURIComponent(shop)}`;
  const post = async (p, body) => {
    const res = await fetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, data, error: (data && data.error) || text.slice(0, 120) };
  };

  if (pin) {
    const r = await post('/api/staff/login', { pin: String(pin).trim() });
    if (r.ok && r.data && r.data.token) {
      // A cashier's PIN would sign in but fail later with a bare 403; say so now.
      if (r.data.role && !['admin', 'manager'].includes(r.data.role)) {
        throw new Error(`That PIN belongs to a ${r.data.role} — this needs a manager's PIN.`);
      }
      return { token: r.data.token, as: `staff PIN (${r.data.name || r.data.role || 'manager'})` };
    }
    if (!password) throw new Error(`Staff PIN rejected: ${r.error}`);
    console.log(`  ! staff PIN rejected (${r.error}) — falling back to the owner password`);
  }

  if (!password) {
    throw new Error('Set STAFF_PIN (a manager PIN) or ADMIN_PASSWORD.');
  }
  const r = await post('/api/admin/login', { password });
  if (!r.ok || !r.data?.token) throw new Error(`Owner password rejected: ${r.error}`);
  return { token: r.data.token, as: 'owner password' };
}
