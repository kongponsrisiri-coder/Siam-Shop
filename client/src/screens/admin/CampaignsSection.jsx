import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { getBrand } from '../../theme.js';

// Campaigns (SIAMSHOP-CRM-001 C3/C4, port of the restaurant's SEPOS-033):
// audience from the CRM filters → subject + body → preview → test to me → send
// via Brevo. The unsubscribe footer and GDPR line are added by the SERVER —
// never optional. Plus Automations: lapsed / after dispatch / birthday.
const PLACEHOLDER_BODY = `<p>Hi {{name}},</p>

<p>Fresh this week at {{shop}}: Thai basil, kaffir lime leaves and new-season mangoes are in.</p>

<p>Show this email at the counter or order online for delivery.</p>

<p>See you soon,<br>The {{shop}} team</p>`;

function PreviewModal({ subject, body, onClose }) {
  const brand = getBrand();
  const personalised = body.replace(/\{\{\s*name\s*\}\}/gi, 'Nok').replace(/\{\{\s*shop\s*\}\}/gi, 'Your shop');
  return (
    <div className="till-modal" onClick={onClose} style={{ zIndex: 55 }}>
      <div className="till-receipt" style={{ width: 640, maxHeight: '90vh', overflowY: 'auto', background: '#f5f5f5' }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ alignItems: 'center' }}><div><div className="muted" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>Subject</div><strong>{subject || '(empty)'}</strong></div><div className="spacer" /><button className="btn secondary" onClick={onClose}>Close</button></div>
        <div style={{ background: '#fff', borderRadius: 12, marginTop: 12, overflow: 'hidden' }}>
          <div style={{ background: brand.primary, padding: '22px 30px' }}>
            {brand.logo ? <img src={brand.logo} alt="logo" style={{ maxHeight: 56, maxWidth: 260, display: 'block' }} /> : <span style={{ fontFamily: 'var(--serif)', fontSize: 24, fontWeight: 700, color: brand.accent }}>Your shop</span>}
          </div>
          <div style={{ padding: 30, lineHeight: 1.6, fontSize: 15 }} dangerouslySetInnerHTML={{ __html: personalised }} />
          <div style={{ padding: '18px 30px', background: '#fafafa', borderTop: '1px solid #eee', fontSize: 11, color: '#888', lineHeight: 1.5 }}>
            <div><strong>Your shop</strong> · address from your receipt header</div>
            <div>You're receiving this because you shop with us and agreed to hear from us. <u>Unsubscribe</u> at any time.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({ text, onYes, onNo, busy }) {
  return (
    <div className="till-modal" onClick={onNo} style={{ zIndex: 55 }}>
      <div className="till-receipt" style={{ width: 400 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Send this campaign?</h3>
        <p className="muted" style={{ fontSize: 13 }}>{text}</p>
        <div className="row" style={{ gap: 8 }}><button className="btn secondary" onClick={onNo} disabled={busy}>Not yet</button><div className="spacer" /><button className="btn" onClick={onYes} disabled={busy}>{busy ? 'Sending…' : 'Send now'}</button></div>
      </div>
    </div>
  );
}

function Automations() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null); // which template is expanded
  const load = () => api.automations().then((d) => { setData(d); setForm({ lapsed_days: d.lapsed_days, brevo_daily_cap: d.brevo_daily_cap, automations: d.automations }); }).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);
  if (!form) return <div className="panel"><h3 style={{ marginTop: 0 }}>Automations</h3><p className="muted">{msg || 'Loading…'}</p></div>;
  const setA = (k, patch) => setForm((f) => ({ ...f, automations: { ...f.automations, [k]: { ...f.automations[k], ...patch } } }));
  async function save() {
    setBusy(true); setMsg('');
    try { await api.automationsSave(form); setMsg('Saved.'); await load(); } catch (e) { setMsg(e.message); }
    setBusy(false);
  }
  async function runNow() {
    setBusy(true); setMsg('');
    try { const r = await api.automationsRun(); setMsg(`Ran now — lapsed ${r.lapsed}, after-dispatch ${r.review}, birthday ${r.birthday}${r.skipped?.length ? ` · ${r.skipped.length} held back by the daily cap` : ''}.`); await load(); }
    catch (e) { setMsg(e.message); }
    setBusy(false);
  }
  const LABEL = { lapsed: { title: 'We miss you', sub: `Once, when a customer passes ${form.lapsed_days} days without an order` }, review: { title: 'How was your order?', sub: 'The day after a postal order is dispatched' }, birthday: { title: 'Happy birthday', sub: 'On their birthday — only for customers with a birthday recorded' } };
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Automations</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Sent automatically every hour to customers who have opted in and not unsubscribed. Each one fires once per customer (or per order). {'{{name}}'} and {'{{shop}}'} are filled in.</p>
      {['lapsed', 'review', 'birthday'].map((k) => (
        <div key={k} className="auto-row">
          <label className="row" style={{ gap: 10, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!form.automations[k].enabled} onChange={(e) => setA(k, { enabled: e.target.checked })} />
            <span><strong>{LABEL[k].title}</strong><div className="muted" style={{ fontSize: 12 }}>{LABEL[k].sub}</div></span>
          </label>
          <button type="button" className="btn mini secondary" onClick={() => setOpen(open === k ? null : k)}>{open === k ? 'Hide' : 'Edit email'}</button>
          {open === k && (
            <div style={{ flex: '1 1 100%' }}>
              <label>Subject</label><input value={form.automations[k].subject} onChange={(e) => setA(k, { subject: e.target.value })} />
              <label>Body (HTML)</label><textarea rows="6" value={form.automations[k].body} onChange={(e) => setA(k, { body: e.target.value })} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }} />
              <button type="button" className="btn ghost" onClick={() => setA(k, data.defaults[k])}>Reset to default text</button>
            </div>
          )}
        </div>
      ))}
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
        <div><label>Lapsed after (days)</label><input type="number" min="7" max="365" value={form.lapsed_days} onChange={(e) => setForm({ ...form, lapsed_days: e.target.value })} style={{ width: 120 }} /></div>
        <div><label>Daily email cap (your Brevo plan)</label><input type="number" min="1" value={form.brevo_daily_cap} onChange={(e) => setForm({ ...form, brevo_daily_cap: e.target.value })} style={{ width: 140 }} /></div>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button className="btn" disabled={busy} onClick={save}>Save automations</button>
        <button className="btn secondary" disabled={busy} onClick={runNow}>▶ Run now</button>
        {msg && <span className="muted" style={{ fontSize: 13, alignSelf: 'center' }}>{msg}</span>}
      </div>
      {data?.recent?.length > 0 && (
        <details style={{ marginTop: 10 }}><summary className="muted" style={{ cursor: 'pointer', fontSize: 13 }}>Recent automatic emails ({data.recent.length})</summary>
          <table style={{ marginTop: 6 }}><tbody>{data.recent.map((r, i) => <tr key={i}><td>{r.event_type}</td><td>{r.customer_name || r.customer_email || r.entity_key}</td><td className="muted">{new Date(r.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td><td><span className={`tag ${r.sent ? 'ok' : 'off'}`}>{r.sent ? 'sent' : r.error ? 'failed' : 'held'}</span></td></tr>)}</tbody></table>
        </details>
      )}
    </div>
  );
}

export default function CampaignsSection() {
  const [seg, setSeg] = useState(null); // segments payload
  const [segment, setSegment] = useState('all');
  const [category, setCategory] = useState('');
  const [count, setCount] = useState(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState(PLACEHOLDER_BODY);
  const [testTo, setTestTo] = useState('');
  const [preview, setPreview] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const segId = segment === 'category' ? (category ? `category:${category}` : '') : segment;

  const loadSeg = () => api.campaignSegments().then(setSeg).catch((e) => setResult({ error: e.message }));
  const loadHistory = () => api.campaigns().then((h) => setHistory(Array.isArray(h) ? h : [])).catch(() => {});
  useEffect(() => { loadSeg(); loadHistory(); }, []);
  useEffect(() => {
    if (!segId) { setCount(null); return; }
    setCount(null);
    api.campaignRecipientCount(segId).then((r) => setCount(r)).catch(() => setCount({ count: 0 }));
  }, [segId]);

  async function send(test) {
    setSending(true); setResult(null);
    try {
      const r = await api.campaignSend({ subject: subject.trim(), body, segment: segId, test_to: test ? testTo.trim() : undefined });
      setResult({ success: true, ...r });
      if (!test) { setSubject(''); setBody(PLACEHOLDER_BODY); }
      loadHistory(); loadSeg();
    } catch (e) { setResult({ error: e.message }); }
    setSending(false); setConfirm(false);
  }
  const cap = seg?.cap;
  const overCap = cap && count && count.count > cap.remaining;

  return (
    <div>
      <h2>Campaigns</h2>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Audience</h3>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {(seg?.segments || []).map((s) => (
            <button type="button" key={s.id} className={`btn ${segment === s.id ? '' : 'secondary'}`} onClick={() => setSegment(s.id)}>{s.label} <span style={{ opacity: 0.8 }}>· {s.count}</span></button>
          ))}
          <button type="button" className={`btn ${segment === 'category' ? '' : 'secondary'}`} onClick={() => setSegment('category')}>Bought from a category (90 days)</button>
        </div>
        {segment === 'category' && (
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ marginTop: 8, width: 'auto' }}>
            <option value="">— choose a category —</option>
            {(seg?.categories || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <p style={{ fontSize: 13, margin: '10px 0 0' }}>
          {segId ? (count === null ? <span className="muted">Counting…</span> : <>Sending to <strong>{count.count}</strong> opted-in customer{count.count === 1 ? '' : 's'}.</>) : <span className="muted">Choose a category.</span>}
          {cap && <span className="muted"> · Email allowance today: <strong>{cap.remaining}</strong> of {cap.daily} left{cap.sent_today ? ` (${cap.sent_today} sent)` : ''}.</span>}
        </p>
        {overCap && <p className="err" style={{ fontSize: 13 }}>⚠ This audience is bigger than today's remaining allowance — the send will be refused rather than half-fail. Split the audience or raise the cap under Automations.</p>}
        {seg && seg.eligible < seg.total && <p className="muted" style={{ fontSize: 12 }}>{seg.total - seg.eligible} of your {seg.total} customers cannot be emailed (no consent, unsubscribed, or no email) and are excluded from every send.</p>}
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Email</h3>
        <label>Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Fresh Thai vegetables in this Thursday" />
        <label>Body (HTML allowed · {'{{name}}'} = first name · {'{{shop}}'} = shop name)</label>
        <textarea rows="12" value={body} onChange={(e) => setBody(e.target.value)} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13 }} />
        <p className="muted" style={{ fontSize: 12 }}>Your logo and colours from Settings → Brand go on top; the unsubscribe link and legal footer are added automatically to every email.</p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn secondary" onClick={() => setPreview(true)} disabled={!subject.trim() && !body.trim()}>👁 Preview</button>
          <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="your@email.com" style={{ width: 220, margin: 0 }} inputMode="email" />
          <button className="btn secondary" disabled={sending || !testTo.trim() || !subject.trim() || !body.trim()} onClick={() => send(true)}>Send test to me</button>
          <div className="spacer" />
          <button className="btn" disabled={sending || !segId || !count?.count || overCap || !subject.trim() || !body.trim()} onClick={() => setConfirm(true)}>📤 Send to {count?.count ?? '…'}</button>
        </div>
        {result?.error && <p className="err" style={{ marginTop: 10 }}>❌ {result.error}</p>}
        {result?.success && <p style={{ marginTop: 10, color: '#166534', fontSize: 13 }}>✓ {result.test ? `Test sent to ${testTo}` : `Sent to ${result.sent} customer${result.sent === 1 ? '' : 's'}`}{result.failed > 0 ? ` · ${result.failed} failed${result.errors?.[0] ? ` (${result.errors[0]})` : ''}` : ''}.</p>}
      </div>

      <Automations />

      {history.length > 0 && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>History</h3>
          <table>
            <thead><tr><th>Sent</th><th>Audience</th><th>Subject</th><th>By</th><th style={{ textAlign: 'right' }}>Recipients</th><th style={{ textAlign: 'right' }}>Sent</th><th style={{ textAlign: 'right' }}>Failed</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td className="muted">{new Date(h.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>{h.is_test ? <span className="tag">test</span> : h.segment}</td>
                  <td>{h.subject}</td>
                  <td className="muted">{h.created_by}</td>
                  <td style={{ textAlign: 'right' }}>{h.recipient_count}</td>
                  <td style={{ textAlign: 'right', color: '#166534', fontWeight: 700 }}>{h.sent_count}</td>
                  <td style={{ textAlign: 'right', color: h.failed_count > 0 ? '#991b1b' : undefined }}>{h.failed_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview && <PreviewModal subject={subject} body={body} onClose={() => setPreview(false)} />}
      {confirm && <ConfirmModal busy={sending} text={`Send "${subject.trim()}" to ${count?.count} opted-in customer${count?.count === 1 ? '' : 's'}? Each gets their own unsubscribe link. This cannot be undone.`} onYes={() => send(false)} onNo={() => setConfirm(false)} />}
    </div>
  );
}
