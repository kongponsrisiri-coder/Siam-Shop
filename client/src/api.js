// SiamShop — all backend fetch calls live here (CLAUDE.md rule).
// In dev, Vite proxies /api to the Express backend. In production set
// VITE_API_BASE to the Railway URL at build time. On the desktop till
// (SIAMSHOP-ELECTRON-001) the base + shop slug come from the install's
// config.json via the Electron preload, not from the build.
import { electronConfig, isElectron } from './electron.js';

const API_BASE = (isElectron && electronConfig.cloudApiUrl ? String(electronConfig.cloudApiUrl).replace(/\/$/, '') : null)
  ?? import.meta.env.VITE_API_BASE ?? '';
const SHOP_SLUG = (isElectron && electronConfig.shopSlug) || '';

// The desktop till talks to a multi-shop cloud, so every request names its shop.
function withShop(path) {
  if (!SHOP_SLUG) return path;
  return path + (path.includes('?') ? '&' : '?') + 'shop=' + encodeURIComponent(SHOP_SLUG);
}

// Staff/admin token stored in localStorage; attached as a Bearer header.
const TOKEN_KEY = 'siamshop_admin_token';
export const auth = {
  get: () => localStorage.getItem(TOKEN_KEY) || '',
  set: (t) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};
// Who is signed in (name + role) — set by the PIN pad / owner login.
const STAFF_KEY = 'siamshop_staff';
export const staffSession = {
  get: () => { try { return JSON.parse(localStorage.getItem(STAFF_KEY)) || null; } catch { return null; } },
  set: (s) => localStorage.setItem(STAFF_KEY, JSON.stringify(s)),
  clear: () => localStorage.removeItem(STAFF_KEY),
};

// Separate token for logged-in customers (kept apart from the admin token).
const CUSTOMER_TOKEN_KEY = 'siamshop_customer_token';
export const customerAuth = {
  get: () => localStorage.getItem(CUSTOMER_TOKEN_KEY) || '',
  set: (t) => localStorage.setItem(CUSTOMER_TOKEN_KEY, t),
  clear: () => localStorage.removeItem(CUSTOMER_TOKEN_KEY),
};

async function request(path, { method = 'GET', body, authed = false, customerAuthed = false, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authed) headers.Authorization = `Bearer ${token || auth.get()}`; // token = one-off manager override (PIN modal)
  if (customerAuthed) headers.Authorization = `Bearer ${customerAuth.get()}`;

  const res = await fetch(`${API_BASE}${withShop(path)}`, {
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
  pickupSlots: () => request('/api/pickup-slots'),
  assistant: (messages, basket) =>
    request('/api/assistant', { method: 'POST', body: { messages, basket } }),
  checkoutSession: (body) =>
    request('/api/checkout/session', { method: 'POST', body }),
  createOrder: (body) => request('/api/orders', { method: 'POST', body }),
  getOrder: (id, email) => request(`/api/orders/${id}${email ? `?email=${encodeURIComponent(email)}` : ''}`),

  // Admin auth
  login: (password) => request('/api/admin/login', { method: 'POST', body: { password } }),
  me: () => request('/api/admin/me', { authed: true }),
  // Staff PIN sign-in + management (SIAMSHOP-ELECTRON-001)
  staffLogin: (pin) => request('/api/staff/login', { method: 'POST', body: { pin } }),
  staffMe: () => request('/api/staff/me', { authed: true }),
  // One-off manager approval (60 s, single use) — SIAMSHOP-DISCOUNT-001
  staffApprove: (body) => request('/api/staff/approve', { method: 'POST', body }),
  adminListStaff: () => request('/api/admin/staff', { authed: true }),
  adminCreateStaff: (s) => request('/api/admin/staff', { method: 'POST', body: s, authed: true }),
  adminUpdateStaff: (id, s) => request(`/api/admin/staff/${id}`, { method: 'PUT', body: s, authed: true }),
  adminDeleteStaff: (id) => request(`/api/admin/staff/${id}`, { method: 'DELETE', authed: true }),
  // Clock in/out + timesheets (SIAMSHOP-CLOCK-001)
  clockToggle: (pin) => request('/api/clock/toggle', { method: 'POST', body: { pin } }),
  clockStatus: () => request('/api/clock/status', { authed: true }),
  clockRecords: (from, to) => request(`/api/clock/records?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { authed: true }),

  // Admin products
  adminListProducts: () => request('/api/admin/products', { authed: true }),
  createProduct: (p) => request('/api/admin/products', { method: 'POST', body: p, authed: true }),
  updateProduct: (id, p) => request(`/api/admin/products/${id}`, { method: 'PUT', body: p, authed: true }),
  deleteProduct: (id) => request(`/api/admin/products/${id}`, { method: 'DELETE', authed: true }),
  aiDescribeProduct: (body) => request('/api/admin/products/ai-describe', { method: 'POST', body, authed: true }),
  // SIAMSHOP-501 — replace a product's option groups (size / toppings / add-ons).
  saveProductOptions: (id, groups) =>
    request(`/api/admin/products/${id}/options`, { method: 'PUT', body: { groups }, authed: true }),
  uploadProductPhoto: (id, dataUrl) =>
    request(`/api/admin/products/${id}/photo`, { method: 'POST', body: { dataUrl }, authed: true }),
  deleteProductPhoto: (id) =>
    request(`/api/admin/products/${id}/photo`, { method: 'DELETE', authed: true }),

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
    const res = await fetch(`${API_BASE}${withShop(`/api/admin/customers.csv${consentOnly ? '?consent=1' : ''}`)}`, {
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
  // SIAMSHOP-504 — Click & Collect lifecycle
  adminMarkReady: (id) => request(`/api/admin/orders/${id}/ready`, { method: 'POST', authed: true }),
  adminMarkCollected: (id) => request(`/api/admin/orders/${id}/collected`, { method: 'POST', authed: true }),
  // SIAMSHOP-POST-001 — parcel label data + printed stamp
  adminOrderLabel: (id) => request(`/api/admin/orders/${id}/label`, { authed: true }),
  adminLabelPrinted: (id) => request(`/api/admin/orders/${id}/label-printed`, { method: 'POST', authed: true }),
  // SIAMSHOP-505 — counter prep screen
  prepList: () => request('/api/prep', { authed: true }),
  prepStatus: (id, prep_status) =>
    request(`/api/prep/${id}/status`, { method: 'POST', body: { prep_status }, authed: true }),
  // CSV export — fetch with the auth header and return a Blob to download.
  exportOrdersCsv: async () => {
    const res = await fetch(`${API_BASE}${withShop('/api/admin/orders.csv')}`, {
      headers: { Authorization: `Bearer ${auth.get()}` },
    });
    if (!res.ok) throw new Error('Export failed');
    return res.blob();
  },

  // Till sessions + Z report (SIAMSHOP-TILL-001). `token` = manager PIN override for close.
  tillSession: () => request('/api/till/session', { authed: true }),
  tillOpen: (float_amount) => request('/api/till/session/open', { method: 'POST', body: { float_amount }, authed: true }),
  tillSetFloat: (float_amount) => request('/api/till/session/float', { method: 'PUT', body: { float_amount }, authed: true }),
  tillClose: (counted_cash, notes, approval_token) => request('/api/till/session/close', { method: 'POST', body: { counted_cash, notes, approval_token }, authed: true }),
  tillSessions: () => request('/api/till/sessions', { authed: true }),
  tillSessionDetail: (id) => request(`/api/till/sessions/${id}`, { authed: true }),

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
