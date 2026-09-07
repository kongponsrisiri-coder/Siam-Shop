import { api } from './api.js';
import { electronConfig } from './electron.js';

// The name printed on receipts, Z reports and the printer test page.
//
// The till used to print electronConfig.shopName — a copy written into the
// device's own config when the desktop app was first set up. Renaming the shop
// in Admin changed the shop record and the receipt preview, but every till kept
// printing the name it was installed with (Korakot, 8 Sep).
//
// The shop record is the truth. This asks for it, keeps the answer, and falls
// back to the device's copy so a till with no connection still prints something
// sensible rather than "SiamShop".
let cached = '';
const FALLBACK = 'SiamShop';
const TIMEOUT_MS = 1500;

export function cachedShopName() {
  return cached || electronConfig.shopName || FALLBACK;
}

// Never blocks a print for long: if the shop record is slow or unreachable, the
// last known name goes on the paper.
export async function shopName() {
  try {
    const shop = await Promise.race([
      api.getShop(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS)),
    ]);
    if (shop && shop.name) { cached = shop.name; return shop.name; }
  } catch {}
  return cachedShopName();
}
