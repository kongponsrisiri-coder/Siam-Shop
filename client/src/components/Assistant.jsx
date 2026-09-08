import React, { useState, useRef, useEffect } from 'react';
import { api } from '../api.js';
import { useCart } from '../cart.jsx';
import { useLang } from '../lang.jsx';
import OptionPicker from './OptionPicker.jsx';
import { hasOptions } from '../options.js';

// Bilingual AI shopping assistant — floating chat widget (SIAMSHOP-THAITANA-001 #2).
export default function Assistant() {
  const { lang } = useLang();
  const th = lang === 'th';
  const { add, items } = useCart();
  // One key per browser, so the shop can follow the conversation and a person
  // can join it (SIAMSHOP-CHAT-001). Opaque — it identifies a chat, nothing else.
  const [session] = useState(() => {
    try {
      const found = localStorage.getItem('siamshop.chat');
      if (found) return found;
      const made = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, '');
      localStorage.setItem('siamshop.chat', made);
      return made;
    } catch { return String(Date.now()); }
  });
  const [humanStaff, setHumanStaff] = useState(null); // name of the person who joined
  const lastSeen = useRef(0);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]); // {role, content}
  const [suggestions, setSuggestions] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [picking, setPicking] = useState(null); // suggestion needing size/toppings
  const bodyRef = useRef(null);

  const t = {
    title: th ? 'ผู้ช่วยช้อปปิ้ง' : 'Shopping assistant',
    greeting: th
      ? 'สวัสดีค่ะ! ถามหาสินค้า วิธีจัดส่ง หรือบอกเมนูที่อยากทำ เช่น “แกงเขียวหวาน” แล้วจะจัดของให้ค่ะ'
      : "Hi! Ask about products or delivery, or tell me a dish (e.g. “green curry”) and I'll build a basket.",
    placeholder: th ? 'พิมพ์ข้อความ…' : 'Ask me anything…',
    send: th ? 'ส่ง' : 'Send',
    addAll: th ? 'ใส่ทั้งหมดลงตะกร้า' : 'Add all to basket',
    add: th ? 'ใส่ตะกร้า' : 'Add',
    thinking: th ? 'กำลังคิด…' : 'Thinking…',
    open: th ? 'ถามผู้ช่วย' : 'Ask assistant',
  };

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, suggestions, busy]);

  // While the panel is open, watch for anything a person says. Polling rather
  // than a socket: this is a shop assistant, and a few seconds is fine.
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.assistantMessages(session, lastSeen.current);
        if (!alive) return;
        setHumanStaff(r.mode === 'human' ? (r.staff || 'the shop') : null);
        const fromStaff = (r.messages || []).filter((m) => m.role === 'staff');
        if (r.messages && r.messages.length) lastSeen.current = r.messages[r.messages.length - 1].id;
        if (fromStaff.length) {
          setMessages((prev) => [...prev, ...fromStaff.map((m) => ({ role: 'assistant', content: m.body, staff: m.staff }))]);
        }
      } catch {}
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [open, session]);

  async function sendText(text) {
    const content = text.trim();
    if (!content || busy) return;
    setErr('');
    setInput('');
    const next = [...messages, { role: 'user', content }];
    setMessages(next);
    setSuggestions([]);
    setBusy(true);
    try {
      const basket = (items || []).map((i) => ({ id: i.id, name: i.name, qty: i.qty }));
      const res = await api.assistant(next, basket, session);
      if (res.handled_by === 'human') {
        // A person has this conversation; their reply arrives through the poll
        // below rather than in this response.
        setHumanStaff(res.staff || 'the shop');
      } else {
        setMessages([...next, { role: 'assistant', content: res.reply || '…' }]);
        setSuggestions(res.add || []);
      }
    } catch (e) {
      setErr(e.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  function addItem(s) {
    const product = { id: s.product_id, name: s.name, name_th: s.name_th, price: s.price, option_groups: s.option_groups };
    // Size / toppings must be chosen by the customer — open the picker.
    if (hasOptions(product)) return setPicking({ product, qty: s.qty || 1 });
    add(product, s.qty || 1);
  }
  function addAll() {
    // Plain items go straight in; items with options stay listed to choose.
    const plain = suggestions.filter((s) => !hasOptions(s));
    plain.forEach(addItem);
    setSuggestions(suggestions.filter((s) => hasOptions(s)));
  }

  if (!open) {
    return (
      <button className="assistant-fab" onClick={() => setOpen(true)} aria-label={t.open}>
        <span aria-hidden="true">💬</span>
        <span className="assistant-fab-label">{t.open}</span>
      </button>
    );
  }

  return (
    <div className="assistant-panel">
      {picking && (
        <OptionPicker
          product={picking.product}
          lang={lang}
          onClose={() => setPicking(null)}
          onConfirm={(ids) => {
            add(picking.product, picking.qty, ids);
            setSuggestions((list) => list.filter((s) => s.product_id !== picking.product.id));
            setPicking(null);
          }}
        />
      )}
      <div className="assistant-head">
        <strong>{humanStaff ? (th ? `คุยกับ ${humanStaff}` : `Chatting with ${humanStaff}`) : t.title}</strong>
        <button className="assistant-x" onClick={() => setOpen(false)} aria-label="Close">×</button>
      </div>
      <div className="assistant-body" ref={bodyRef}>
        <div className="assistant-msg bot">{t.greeting}</div>
        {messages.map((m, i) => (
          <div key={i} className={`assistant-msg ${m.role === 'user' ? 'me' : 'bot'}`}>
            {m.staff && <div className="assistant-from">{m.staff}</div>}
            {m.content}
          </div>
        ))}
        {busy && <div className="assistant-msg bot muted">{t.thinking}</div>}
        {suggestions.length > 0 && (
          <div className="assistant-suggest">
            {suggestions.map((s) => (
              <div key={s.product_id} className="assistant-sg-item">
                <span>{th && s.name_th ? s.name_th : s.name} <span className="muted">· £{Number(s.price).toFixed(2)}{s.qty > 1 ? ` ×${s.qty}` : ''}</span></span>
                <button className="btn secondary" onClick={() => addItem(s)}>{t.add}</button>
              </div>
            ))}
            <button className="btn" onClick={addAll}>{t.addAll}</button>
          </div>
        )}
        {err && <div className="assistant-msg bot" style={{ color: '#b91c1c' }}>{err}</div>}
      </div>
      <form className="assistant-input" onSubmit={(e) => { e.preventDefault(); sendText(input); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t.placeholder} />
        <button className="btn" disabled={busy || !input.trim()}>{t.send}</button>
      </form>
    </div>
  );
}
