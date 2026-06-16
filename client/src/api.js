// SiamShop — all backend fetch calls live here (CLAUDE.md rule).
// In dev, Vite proxies /api to the Express backend. In production set
// VITE_API_BASE to the Railway URL at build time.

const API_BASE = import.meta.env.VITE_API_BASE || '';

// Admin token stored in localStorage; attached as a Bearer header.
const TOKEN_KEY = 'siamshop_admin_token';
export const auth = {
  get: () => localStorage.getItem(TOKEN_KEY) || '',
  set: (t) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

// Separate token for logged-in customers (kept apart from the admin token).
const CUSTOMER_TOKEN_KEY = 'siamshop_customer_token';
export const customerAuth = {
  get: () => localStorage.getItem(CUSTOMER_TOKEN_KEY) || '',
  set: (t) => localStorage.setItem(CUSTOMER_TOKEN_KEY, t),
  clear: () => localStorage.removeItem(CUSTOMER_TOKEN_KEY),
};

async function request(path, { method = 'GET', body, authed = false, customerAuthed = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authed) headers.Authorization = `Bearer ${auth.get()}`;
  if (customerAuthed) headers.Authorization = `Bearer ${customerAuth.get()}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no JSON body */
  }
  if (!res.ok) {
    const msg = (data && data.error) || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  // Health / shop
  health: () => request('/api/health'),
  getShop: () => request('/api/shop'),

  // Public storefront
  listProducts: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/api/products${qs ? `?${qs}` : ''}`);
  },
  getProduct: (id) => request(`/api/products/${id}`),

  // Public — settings, categories, stock notify, delivery, checkout, orders
  getSettings: () => request('/api/settings'),
  getCategories: () => request('/api/categories'),
  notifyMe: (id, email) =>
    request(`/api/products/${id}/notify`, { method: 'POST', body: { email } }),
  deliveryQuote: (postcode) =>
    request('/api/delivery-quote', { method: 'POST', body: { postcode } }),
  checkoutSession: (body) =>
    request('/api/checkout/session', { method: 'POST', body }),
  createOrder: (body) => request('/api/orders', { method: 'POST', body }),
  getOrder: (id, email) => request(`/api/orders/${id}${email ? `?email=${encodeURIComponent(email)}` : ''}`),

  // Admin auth
  login: (password) => request('/api/admin/login', { method: 'POST', body: { password } }),
  me: () => request('/api/admin/me', { authed: true }),

  // Admin products
  adminListProducts: () => request('/api/admin/products', { authed: true }),
  createProduct: (p) => request('/api/admin/products', { method: 'POST', body: p, authed: true }),
  updateProduct: (id, p) => request(`/api/admin/products/${id}`, { method: 'PUT', body: p, authed: true }),
  deleteProduct: (id) => request(`/api/admin/products/${id}`, { method: 'DELETE', authed: true }),
  aiDescribeProduct: (body) => request('/api/admin/products/ai-describe', { method: 'POST', body, authed: true }),

  // Admin settings
  adminGetSettings: () => request('/api/admin/settings', { authed: true }),
  adminUpdateSettings: (patch) =>
    request('/api/admin/settings', { method: 'PUT', body: patch, authed: true }),
  adminTestEmail: (to) => request('/api/admin/test-email', { method: 'POST', body: { to }, authed: true }),

  // Admin categories
  adminCreateCategory: (c) =>
    request('/api/admin/categories', { method: 'POST', body: c, authed: true }),
  adminUpdateCategory: (id, c) =>
    request(`/api/admin/categories/${id}`, { method: 'PUT', body: c, authed: true }),
  adminDeleteCategory: (id) =>
    request(`/api/admin/categories/${id}`, { method: 'DELETE', authed: true }),

  // Admin dashboard + reports
  adminDashboard: () => request('/api/admin/dashboard', { authed: true }),
  adminReport: (from, to) => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const s = qs.toString();
    return request(`/api/admin/report${s ? `?${s}` : ''}`, { authed: true });
  },

  // Customer accounts (SIAMSHOP-006)
  customerAuth, // { get, set, clear } for the customer token
  accountRegister: (body) => request('/api/account/register', { method: 'POST', body }),
  accountLogin: (body) => request('/api/account/login', { method: 'POST', body }),
  accountMe: () => request('/api/account', { customerAuthed: true }),
  accountUpdate: (body) => request('/api/account', { method: 'PUT', body, customerAuthed: true }),
  accountOrders: () => request('/api/account/orders', { customerAuthed: true }),

  // Admin CRM
  adminListCustomers: (consentOnly) => request(`/api/admin/customers${consentOnly ? '?consent=1' : ''}`, { authed: true }),
  adminGetCustomer: (id) => request(`/api/admin/customers/${id}`, { authed: true }),
  adminDeleteCustomer: (id) => request(`/api/admin/customers/${id}`, { method: 'DELETE', authed: true }),
  exportCustomersCsv: async (consentOnly) => {
    const res = await fetch(`${API_BASE}/api/admin/customers.csv${consentOnly ? '?consent=1' : ''}`, {
      headers: { Authorization: `Bearer ${auth.get()}` },
    });
    if (!res.ok) throw new Error('Export failed');
    return res.blob();
  },

  // Admin orders
  adminListOrders: () => request('/api/admin/orders', { authed: true }),
  adminGetOrder: (id) => request(`/api/admin/orders/${id}`, { authed: true }),
  adminCarriers: () => request('/api/admin/carriers', { authed: true }),
  adminDispatchOrder: (id, tracking_number, carrier) =>
    request(`/api/admin/orders/${id}/dispatch`, {
      method: 'POST',
      body: { tracking_number, carrier },
      authed: true,
    }),
  adminMarkPaid: (id) =>
    request(`/api/admin/orders/${id}/mark-paid`, { method: 'POST', authed: true }),
  adminCancelOrder: (id) =>
    request(`/api/admin/orders/${id}/cancel`, { method: 'POST', authed: true }),
  // CSV export — fetch with the auth header and return a Blob to download.
  exportOrdersCsv: async () => {
    const res = await fetch(`${API_BASE}/api/admin/orders.csv`, {
      headers: { Authorization: `Bearer ${auth.get()}` },
    });
    if (!res.ok) throw new Error('Export failed');
    return res.blob();
  },

  // In-store till (staff)
  lookupBarcode: (code) => request(`/api/products/lookup?barcode=${encodeURIComponent(code)}`, { authed: true }),
  createSale: (sale) => request('/api/sales', { method: 'POST', body: sale, authed: true }),
  salesSummary: () => request('/api/sales/summary', { authed: true }),

  // Phone scanner — stock operations
  receiveStock: (body) => request('/api/stock/receive', { method: 'POST', body, authed: true }),
  stocktake: (body) => request('/api/stock/stocktake', { method: 'POST', body, authed: true }),
  goodsInBatch: (lines) => request('/api/stock/goods-in-batch', { method: 'POST', body: { lines }, authed: true }),
  scanInvoice: (body) => request('/api/stock/scan-invoice', { method: 'POST', body, authed: true }),
};
