// SIAMSHOP-CHAT-001 — the assistant conversation is kept, and a person can take
// it over. Runs against a local server; the assistant itself needs no API key
// because these checks are about the record and the handover, not the replies.
//   BASE=http://localhost:5137 ADMIN_PASSWORD=… node scripts/test-chat.mjs
const BASE = process.env.BASE || 'http://localhost:4999';
const PASS = process.env.ADMIN_PASSWORD || 'test-pass-123';
let pass = 0, fail = 0;
const check = (n, c, e) => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, e !== undefined ? JSON.stringify(e).slice(0, 300) : ''); } };
async function req(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
for (let i = 0; i < 40; i++) { try { const h = await fetch(BASE + '/api/health').then((r) => r.json()); if (h.db === 'ok') break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

console.log('— setup');
const owner = (await req('POST', '/api/admin/login', { password: PASS })).data.token;
check('owner token', !!owner);
for (const s of (await req('GET', '/api/admin/staff', null, owner)).data || []) if (/^Chat /.test(s.name)) await req('DELETE', `/api/admin/staff/${s.id}`, null, owner);
await req('POST', '/api/admin/staff', { name: 'Chat Cashier', pin: '9191', role: 'cashier' }, owner);
const cashier = (await req('POST', '/api/staff/login', { pin: '9191' })).data.token;
const KEY = 'test-chat-' + Date.now();

console.log('— a conversation is kept even when the assistant cannot answer');
// No Anthropic key on the test rig, so /api/assistant returns 503 — but the
// customer's words must still be recorded, or the shop loses the question.
let r = await req('POST', '/api/assistant', { session: KEY, messages: [{ role: 'user', content: 'do you sell pad thai sauce?' }] });
check('assistant unavailable is reported honestly', r.status === 503 || r.status === 200, r.data);
{
  // The point of recording before the API-key check: a shop with no key still
  // keeps the question, and can answer it by hand.
  const own = (await req('GET', '/api/admin/chats', null, owner)).data.sessions.find((x) => x.session_key === KEY);
  check('the question is kept even when the assistant could not answer',
    !!own && (await req('GET', `/api/admin/chats/${own.id}`, null, owner)).data.messages.some((m) => m.role === 'customer' && /pad thai sauce/.test(m.body)), own);
}

console.log('— taking over');
let list = (await req('GET', '/api/admin/chats', null, owner)).data.sessions;
check('the shop can list conversations', Array.isArray(list), list);
// Start one deterministically through the poll endpoint, which creates the session.
await req('GET', `/api/assistant/messages?session=${KEY}&after=0`);
list = (await req('GET', '/api/admin/chats', null, owner)).data.sessions;
const mine = list.find((s) => s.session_key === KEY);
check('the conversation appears in the shop\'s list', !!mine, list.slice(0, 2));

r = await req('GET', `/api/admin/chats/${mine.id}`, null, owner);
check('the transcript reads back', r.status === 200 && Array.isArray(r.data.messages), r.data);
check('it starts on the assistant', r.data.mode === 'ai');

r = await req('POST', `/api/admin/chats/${mine.id}/mode`, { mode: 'human' }, cashier);
check('a cashier can take over — no need to find a manager', r.status === 200 && r.data.mode === 'human', r.data);
check('the transcript records who joined',
  (await req('GET', `/api/admin/chats/${mine.id}`, null, owner)).data.messages.some((m) => m.role === 'staff' && /joined the chat/.test(m.body)));

console.log('— while a person is answering, the assistant stays out of it');
r = await req('POST', '/api/assistant', { session: KEY, messages: [{ role: 'user', content: 'is it in stock?' }] });
check('the customer gets no bot reply over the top', r.status === 200 && r.data.handled_by === 'human', r.data);
const after = (await req('GET', `/api/admin/chats/${mine.id}`, null, owner)).data.messages;
check('but their question is still recorded', after.some((m) => m.role === 'customer' && /in stock/.test(m.body)), after.map((m) => m.role));

console.log('— the reply reaches the shopper');
r = await req('POST', `/api/admin/chats/${mine.id}/reply`, { body: 'Yes — two left on the shelf.' }, cashier);
check('staff reply accepted', r.status === 201 && r.data.role === 'staff', r.data);
r = await req('GET', `/api/assistant/messages?session=${KEY}&after=0`);
check('the widget can poll it', r.status === 200 && r.data.messages.some((m) => m.role === 'staff' && /two left/.test(m.body)), r.data);
check('and is told who is answering', r.data.mode === 'human' && !!r.data.staff, r.data);
const lastId = r.data.messages[r.data.messages.length - 1].id;
check('polling after the last id returns nothing new', (await req('GET', `/api/assistant/messages?session=${KEY}&after=${lastId}`)).data.messages.length === 0);

console.log('— handing back');
r = await req('POST', `/api/admin/chats/${mine.id}/mode`, { mode: 'ai' }, owner);
check('handed back to the assistant', r.status === 200 && r.data.mode === 'ai' && !r.data.staff, r.data);
r = await req('POST', `/api/admin/chats/${mine.id}/mode`, { mode: 'sideways' }, owner);
check('a nonsense mode is refused', r.status === 400, r.data);
r = await req('POST', `/api/admin/chats/${mine.id}/reply`, { body: '   ' }, owner);
check('an empty reply is refused', r.status === 400, r.data);

console.log('— one shopper cannot read another\'s chat');
r = await req('GET', '/api/assistant/messages?session=someone-elses-key&after=0');
check('an unknown key gets its own empty conversation, not somebody\'s', r.status === 200 && r.data.messages.length === 0, r.data);
r = await req('GET', `/api/admin/chats/${mine.id}`);
check('the transcript needs staff sign-in', r.status === 401, r.status);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
