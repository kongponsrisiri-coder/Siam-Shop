import React, { useState, useRef, useEffect } from 'react';
import { api } from '../api.js';
import { useCart } from '../cart.jsx';
import { useLang } from '../lang.jsx';

// Bilingual AI shopping assistant — floating chat widget (SIAMSHOP-THAITANA-001 #2).
export default function Assistant() {
  const { lang } = useLang();
  const th = lang === 'th';
  const { add, items } = useCart();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]); // {role, content}
  const [suggestions, setSuggestions] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
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
      const res = await api.assistant(next, basket);
      setMessages([...next, { role: 'assistant', content: res.reply || '…' }]);
      setSuggestions(res.add || []);
    } catch (e) {
      setErr(e.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  function addItem(s) {
    add({ id: s.product_id, name: s.name, name_th: s.name_th, price: s.price }, s.qty || 1);
  }
  function addAll() {
    suggestions.forEach(addItem);
    setSuggestions([]);
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
      <div className="assistant-head">
        <strong>{t.title}</strong>
        <button className="assistant-x" onClick={() => setOpen(false)} aria-label="Close">×</button>
      </div>
      <div className="assistant-body" ref={bodyRef}>
        <div className="assistant-msg bot">{t.greeting}</div>
        {messages.map((m, i) => (
          <div key={i} className={`assistant-msg ${m.role === 'user' ? 'me' : 'bot'}`}>{m.content}</div>
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
