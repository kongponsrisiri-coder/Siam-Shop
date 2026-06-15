// Tiny EN/TH bilingual context. Stores the chosen language in localStorage
// (default 'en') and exposes a toggle. pickName / pickDesc fall back to the
// English field when the Thai one is missing.
import React, { createContext, useContext, useEffect, useState } from 'react';

const LangContext = createContext(null);
const KEY = 'siamshop_lang';

export function LangProvider({ children, initial = 'en' }) {
  const [lang, setLangState] = useState(() => {
    const saved = localStorage.getItem(KEY);
    return saved === 'th' || saved === 'en' ? saved : initial;
  });

  useEffect(() => {
    localStorage.setItem(KEY, lang);
  }, [lang]);

  function setLang(next) {
    if (next === 'en' || next === 'th') setLangState(next);
  }
  function toggle() {
    setLangState((l) => (l === 'th' ? 'en' : 'th'));
  }

  return (
    <LangContext.Provider value={{ lang, setLang, toggle }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang() {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error('useLang must be used within LangProvider');
  return ctx;
}

// Field pickers: return the Thai variant when lang==='th' and it's present,
// otherwise the default English field.
export function pickName(item, lang) {
  if (!item) return '';
  if (lang === 'th' && item.name_th) return item.name_th;
  return item.name || '';
}

export function pickDesc(item, lang) {
  if (!item) return '';
  if (lang === 'th' && item.description_th) return item.description_th;
  return item.description || '';
}

export function pickCategory(item, lang) {
  if (!item) return '';
  if (lang === 'th' && item.category_th) return item.category_th;
  return item.category || '';
}

// Small UI string table for the storefront chrome.
const STRINGS = {
  en: {
    shop: 'Shop',
    cart: 'Cart',
    track: 'Track order',
    account: 'Account',
    search: 'Search products…',
    all: 'All',
    addToCart: 'Add to cart',
    outOfStock: 'OUT OF STOCK',
    notifyMe: 'Notify me when back',
    notifyPlaceholder: 'Your email',
    notifySent: "Thanks! We'll email you.",
    inCart: 'in cart',
    freshStock: 'Fresh stock refreshes every',
    noProducts: 'No products found.',
    loading: 'Loading…',
    keepShopping: 'Keep shopping',
    checkout: 'Checkout',
    subtotal: 'Subtotal',
    delivery: 'Delivery',
    total: 'Total',
    minOrder: 'Minimum order',
    addMore: 'Add',
    moreToCheckout: 'more to check out',
    deliveryAtCheckout: 'Delivery calculated at checkout',
  },
  th: {
    shop: 'ร้านค้า',
    cart: 'ตะกร้า',
    track: 'ติดตามคำสั่งซื้อ',
    account: 'บัญชีของฉัน',
    search: 'ค้นหาสินค้า…',
    all: 'ทั้งหมด',
    addToCart: 'ใส่ตะกร้า',
    outOfStock: 'สินค้าหมด',
    notifyMe: 'แจ้งเตือนเมื่อมีของ',
    notifyPlaceholder: 'อีเมลของคุณ',
    notifySent: 'ขอบคุณค่ะ เราจะแจ้งทางอีเมล',
    inCart: 'ในตะกร้า',
    freshStock: 'สินค้าใหม่เข้าทุก',
    noProducts: 'ไม่พบสินค้า',
    loading: 'กำลังโหลด…',
    keepShopping: 'เลือกซื้อต่อ',
    checkout: 'ชำระเงิน',
    subtotal: 'ยอดรวม',
    delivery: 'ค่าจัดส่ง',
    total: 'รวมทั้งสิ้น',
    minOrder: 'ยอดสั่งซื้อขั้นต่ำ',
    addMore: 'เพิ่มอีก',
    moreToCheckout: 'เพื่อชำระเงิน',
    deliveryAtCheckout: 'คำนวณค่าจัดส่งตอนชำระเงิน',
  },
};

export function useT() {
  const { lang } = useLang();
  return (key) => (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key;
}
