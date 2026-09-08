import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';

// Admin → Chats (SIAMSHOP-CHAT-001).
//
// Every shopping-assistant conversation is kept, and a person can take one
// over. A shop wants the record for the same reasons it keeps orders — what
// customers asked for, and what they were told — and wants to step in when the
// assistant is not helping (Korakot, 8 Sep).
//
// Polling, not sockets: a shop assistant does not need sub-second delivery, and
// polling survives a flaky shop connection without a reconnect dance.
const WHO = { customer: 'Customer', assistant: 'Assistant', staff: 'Shop' };
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export default function ChatsSection() {
  const [sessions, setSessions] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [chat, setChat] = useState(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bodyRef = useRef(null);

  async function loadList() {
    try { setSessions((await api.adminChats()).sessions || []); }
    catch (e) { setError(e.message); }
  }
  async function loadChat(id) {
    try { setChat(await api.adminChat(id)); }
    catch (e) { setError(e.message); }
  }

  useEffect(() => { loadList(); const t = setInterval(loadList, 10000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!openId) { setChat(null); return undefined; }
    loadChat(openId);
    const t = setInterval(() => loadChat(openId), 5000);
    return () => clearInterval(t);
  }, [openId]);
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [chat]);

  async function setMode(mode) {
    setBusy(true); setError('');
    try { await api.adminChatMode(openId, mode); await loadChat(openId); await loadList(); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }
  async function send(e) {
    e.preventDefault();
    const body = reply.trim();
    if (!body) return;
    setBusy(true); setError('');
    try { await api.adminChatReply(openId, body); setReply(''); await loadChat(openId); await loadList(); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }

  return (
    <div>
      <h2>Chats</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Every conversation with the shopping assistant, kept in full. Take one over to answer it yourself — the
        assistant stops replying until you hand it back.
      </p>
      {error && <p className="err">{error}</p>}

      <div className="row" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div className="panel" style={{ flex: '1 1 320px', maxWidth: 460 }}>
          <h3 style={{ marginTop: 0 }}>Conversations</h3>
          {sessions.length === 0 && <p className="muted">No one has used the assistant yet.</p>}
          {sessions.map((s) => (
            <button
              type="button"
              key={s.id}
              className={`chat-row ${String(openId) === String(s.id) ? 'on' : ''}`}
              onClick={() => setOpenId(s.id)}
            >
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <strong>{s.customer_name || s.customer_email || `Shopper #${s.id}`}</strong>
                <span className="muted" style={{ fontSize: 12 }}>{when(s.last_message_at)}</span>
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                {s.last_role === 'customer' ? '→ ' : ''}{(s.last_message || '').slice(0, 80)}
              </div>
              <div style={{ fontSize: 12, marginTop: 2 }}>
                {s.mode === 'human'
                  ? <span className="tag">{s.staff ? `${s.staff} is answering` : 'A person is answering'}</span>
                  : <span className="muted">Assistant · {s.message_count} messages</span>}
              </div>
            </button>
          ))}
        </div>

        <div className="panel" style={{ flex: '1 1 380px' }}>
          {!chat && <p className="muted">Pick a conversation to read it.</p>}
          {chat && (
            <>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0 }}>{chat.customer_name || chat.customer_email || `Shopper #${chat.id}`}</h3>
                {chat.mode === 'human'
                  ? <button className="btn secondary" disabled={busy} onClick={() => setMode('ai')}>Hand back to the assistant</button>
                  : <button className="btn" disabled={busy} onClick={() => setMode('human')}>Take over</button>}
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Started {when(chat.created_at)} · {chat.messages.length} messages
                {chat.mode === 'human' && chat.staff ? ` · ${chat.staff} took over ${when(chat.taken_over_at)}` : ''}
              </p>
              <div className="chat-log" ref={bodyRef}>
                {chat.messages.map((m) => (
                  <div key={m.id} className={`chat-msg ${m.role}`}>
                    <div className="chat-who">{m.staff || WHO[m.role] || m.role} · {when(m.created_at)}</div>
                    {m.body}
                  </div>
                ))}
              </div>
              <form onSubmit={send} className="row" style={{ gap: 8, marginTop: 10 }}>
                <input
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder={chat.mode === 'human' ? 'Reply to the customer…' : 'Reply — this takes the chat over'}
                  style={{ flex: 1, margin: 0 }}
                />
                <button className="btn" disabled={busy || !reply.trim()}>Send</button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
