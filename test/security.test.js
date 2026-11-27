// Security checks: one owner can never read or change another owner's data, tokens cannot be forged,
// roles and the trial lock are enforced by the server (not the browser), and the web server leaks nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createApp } from '../server/index.js';
import { hashPassword, signToken } from '../server/auth.js';
import { addDays, todayStr } from '../server/util.js';

const call = (name, args) => ({ parts: [{ functionCall: { name, args } }], functionCalls: [{ name, args }], text: '' });
const say = (text) => ({ parts: [{ text }], functionCalls: [], text });
const ai = { name: 'scripted', queue: [], async generate() { return this.queue.shift() || say('ok'); } };
const SECRET = 'security-test-secret';
const D = (n) => addDays(todayStr('Asia/Kolkata'), n);
let clock = Date.now();
let app, base, A, B, C, ADMIN, bookingA, entryA;

async function api(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const login = (email, password) => api('POST', '/api/auth/login', { body: { email, password } });
async function makeUser(email, role = 'owner') {
  app.db.prepare("INSERT INTO owners(name, email, password_hash, role, plan) VALUES(?,?,?,?,'full')").run(email.split('@')[0], email, await hashPassword('password123'), role);
  const r = await login(email, 'password123');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.token;
}
async function propose(token, tool, args) {
  ai.queue.push(call(tool, args));
  const r = await api('POST', '/api/chat', { token, body: { message: 'do it' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
const confirm = (token, t) => api('POST', '/api/confirm', { token, body: { token: t, approve: true } });

before(async () => {
  app = createApp({ dbFile: ':memory:', secret: SECRET, provider: ai, now: () => clock });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  A = await makeUser('alice@x.com');
  B = await makeUser('bob@x.com');
  ADMIN = await makeUser('boss@x.com', 'admin');
  C = await makeUser('chatty@x.com');
  assert.equal((await api('POST', '/api/houseboats', { token: A, body: { name: 'Alice Boat', total_rooms: 3, is_own: true } })).status, 200);
  const p = await propose(A, 'create_booking', { client_name: 'Secret Guest', sender: 'Direct', check_in: D(3), check_out: D(4), advance_paid: 1000, rooms: [{ houseboat: 'Alice Boat', own: true, guests: 2, price: 5000, meal_plan: 'CP' }] });
  assert.equal((await confirm(A, p.pending.token)).status, 200);
  bookingA = app.db.prepare("SELECT id FROM bookings WHERE client_name = 'Secret Guest'").get().id;
  entryA = app.db.prepare("SELECT l.id FROM ledger l JOIN owners o ON o.id = l.owner_id WHERE o.email = 'alice@x.com' AND l.amount > 0 LIMIT 1").get()?.id;
});
after(() => app.server.close());

test('another owner sees none of my data', async () => {
  for (const p of ['/api/bookings', '/api/houseboats', '/api/dashboard', '/api/balance', '/api/history', `/api/people?q=Secret`, `/api/calendar?from=${D(0)}`]) {
    const r = await api('GET', p, { token: B });
    assert.equal(r.status, 200, p);
    assert.ok(!JSON.stringify(r.data).includes('Secret Guest') && !JSON.stringify(r.data).includes('Alice Boat'), `leak in ${p}`);
  }
});

test('another owner cannot delete or reverse my booking, boat or payment by id', async () => {
  const boatA = app.db.prepare("SELECT id FROM houseboats WHERE name = 'Alice Boat'").get().id;
  assert.equal((await api('POST', '/api/delete-request', { token: B, body: { kind: 'houseboat', id: boatA } })).status, 404);
  const del = await api('POST', '/api/delete-request', { token: B, body: { kind: 'booking', id: bookingA } });
  assert.notEqual(del.status, 200, 'B must not even get a delete card for A\'s booking');
  assert.ok(entryA, 'test needs a payment entry of A');
  assert.notEqual((await api('POST', '/api/delete-request', { token: B, body: { kind: 'entry', id: entryA } })).status, 200);
  // the AI route is scoped the same way
  const viaChat = await propose(B, 'delete_booking', { booking_id: bookingA });
  assert.ok(!viaChat.pending, 'no confirm card for someone else\'s booking');
  assert.equal(app.db.prepare("SELECT status FROM bookings WHERE id = ?").get(bookingA).status, 'confirmed');
});

test('another owner cannot approve my confirmation card', async () => {
  const p = await propose(A, 'delete_booking', { booking_id: bookingA });
  assert.ok(p.pending?.token);
  const r = await confirm(B, p.pending.token);
  assert.notEqual(r.status, 200);
  assert.equal(app.db.prepare("SELECT status FROM pending_actions WHERE token = ?").get(p.pending.token).status, 'pending');
  await api('POST', '/api/confirm', { token: A, body: { token: p.pending.token, approve: false } });
});

test('forged, edited or alg=none tokens are refused', async () => {
  const aliceId = app.db.prepare("SELECT id FROM owners WHERE email = 'alice@x.com'").get().id;
  const sv = app.db.prepare('SELECT session_version FROM owners WHERE id = ?').get(aliceId).session_version;
  const forged = signToken({ sub: aliceId, sv }, 'wrong-secret');
  assert.equal((await api('GET', '/api/bookings', { token: forged })).status, 401);
  // take Bob's real token and change the user id inside it
  const [h, , s] = B.split('.');
  const body = Buffer.from(JSON.stringify({ sub: aliceId, sv, exp: 9999999999 })).toString('base64url');
  assert.equal((await api('GET', '/api/bookings', { token: `${h}.${body}.${s}` })).status, 401);
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${body}.`;
  assert.equal((await api('GET', '/api/bookings', { token: none })).status, 401);
  assert.equal((await api('GET', '/api/bookings', { token: 'garbage' })).status, 401);
  assert.equal((await api('GET', '/api/bookings')).status, 401);
  const expired = signToken({ sub: aliceId, sv }, SECRET, -10);
  assert.equal((await api('GET', '/api/bookings', { token: expired })).status, 401);
});

test('roles are checked on the server: owners cannot use admin APIs, editing the page does not help', async () => {
  for (const [m, p] of [['GET', '/api/admin/owners'], ['POST', '/api/admin/owners'], ['POST', '/api/admin/owners/1/access'], ['POST', '/api/admin/owners/1/password'], ['GET', '/api/admin/owners/1/backup'], ['POST', '/api/admin/owners/1/ai-key']]) {
    const r = await api(m, p, { token: A, body: { action: 'make_full', name: 'Hacker', email: 'h@x.com' } });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  assert.equal(app.db.prepare("SELECT COUNT(*) c FROM owners WHERE email = 'h@x.com'").get().c, 0);
  // the admin has no houseboat data and cannot act as an owner
  assert.equal((await api('GET', '/api/bookings', { token: ADMIN })).status, 403);
  // the admin cannot touch another admin through the customer APIs
  const adminId = app.db.prepare("SELECT id FROM owners WHERE email = 'boss@x.com'").get().id;
  assert.equal((await api('POST', `/api/admin/owners/${adminId}/password`, { token: ADMIN, body: {} })).status, 404);
});

test('the trial lock is enforced by the server for every request, even with an old token', async () => {
  const r = await api('POST', '/api/admin/owners', { token: ADMIN, body: { name: 'Trial Tom', email: 'tom@x.com', password: 'password123', trial_days: 1 } });
  assert.equal(r.status, 200);
  const tom = (await login('tom@x.com', 'password123')).data.token;
  assert.equal((await api('GET', '/api/bookings', { token: tom })).status, 200);
  clock += 864e5 + 1000;
  for (const [m, p] of [['GET', '/api/bookings'], ['POST', '/api/chat'], ['POST', '/api/houseboats'], ['GET', '/api/me']]) {
    const x = await api(m, p, { token: tom, body: { message: 'hi', name: 'X', total_rooms: 1 } });
    assert.equal(x.status, 403, p); assert.equal(x.data.code, 'LOCKED');
  }
  assert.equal((await login('tom@x.com', 'password123')).status, 403);
  clock = Date.now();
});

test('login: same answer for unknown email and wrong password, and per-account limit', async () => {
  const a = await login('nobody@x.com', 'whatever123');
  const b = await login('alice@x.com', 'wrong-password');
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.data.error, b.data.error);
  assert.equal((await login('alice@x.com', 'x'.repeat(5000))).status, 401, 'very long passwords are refused before hashing');
  let last;
  for (let i = 0; i < 12; i++) last = await login('carol-limit@x.com', `bad-${i}-pass`);
  assert.equal(last.status, 429, 'too many tries on one account are blocked');
});

test('passwords and AI keys are never sent to the browser', async () => {
  const key = 'AIzaSy' + 'Q'.repeat(33);
  const c = await api('POST', '/api/admin/owners', { token: ADMIN, body: { name: 'Key Kim', email: 'kim@x.com', password: 'password123', gemini_key: key } });
  const all = JSON.stringify((await api('GET', '/api/admin/owners', { token: ADMIN })).data) + JSON.stringify(c.data);
  assert.ok(!all.includes(key) && !all.includes('scrypt$') && !all.includes('password_hash') && !all.includes('gemini_key_enc'));
  const row = app.db.prepare("SELECT gemini_key_enc FROM owners WHERE email = 'kim@x.com'").get();
  assert.ok(!row.gemini_key_enc.includes(key), 'the key is stored encrypted');
  const me = await api('GET', '/api/me', { token: A });
  assert.ok(!JSON.stringify(me.data).includes('scrypt'));
});

test('security headers are sent', async () => {
  for (const p of ['/', '/api/config']) {
    const { headers } = await api('GET', p);
    assert.match(headers.get('content-security-policy'), /script-src 'self'.*object-src 'none'.*frame-ancestors 'none'/);
    assert.equal(headers.get('x-frame-options'), 'DENY');
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.match(headers.get('permissions-policy'), /camera=\(\)/);
    assert.equal(headers.get('x-powered-by'), null);
  }
});

test('other websites cannot call the API from a browser (CORS)', async () => {
  const r = await api('GET', '/api/me', { token: A, headers: { origin: 'https://evil.example' } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

// raw HTTP, because fetch() cleans up "../" in the path before sending it
function rawGet(p) {
  return new Promise((resolve, reject) => {
    const s = net.connect(app.server.address().port, '127.0.0.1', () => s.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let out = ''; s.on('data', (d) => { out += d; }); s.on('end', () => resolve(out)); s.on('error', reject);
  });
}

test('the web server never hands out server files, the database or .env', async () => {
  for (const p of ['/../.env', '/..%2f.env', '/%2e%2e/%2e%2e/.env', '/../server/index.js', '/../data/boathouse.db', '/../package.json', '/.env', '/..%5c.env', '/../data/.secret']) {
    const out = await rawGet(p);
    assert.ok(!/JWT_SECRET|GEMINI_API_KEY=|createApp|SQLite format|"scripts"/.test(out), `leak for ${p}`);
  }
});

test('oversized requests and bad JSON are refused', async () => {
  const big = await fetch(base + '/api/chat', { method: 'POST', headers: { authorization: `Bearer ${A}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'x'.repeat(200_000) }) }).catch((e) => ({ status: 'closed', e }));
  assert.ok(big.status === 413 || big.status === 'closed');
  const bad = await fetch(base + '/api/houseboats', { method: 'POST', headers: { authorization: `Bearer ${A}`, 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
});

test('chat is rate limited per owner (protects their AI key)', async () => {
  let last;
  for (let i = 0; i < 45; i++) { ai.queue.push(say('ok')); last = await api('POST', '/api/chat', { token: C, body: { message: 'hi' } }); if (last.status === 429) break; }
  assert.equal(last.status, 429);
  ai.queue.length = 0;
});

test('SQL injection in search fields does nothing', async () => {
  for (const q of ["' OR 1=1 --", "x'; DROP TABLE bookings; --", '%']) {
    const r = await api('GET', `/api/people?q=${encodeURIComponent(q)}`, { token: B });
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(r.data).includes('Secret Guest'));
    assert.equal((await api('GET', `/api/bookings?client=${encodeURIComponent(q)}`, { token: B })).status, 200);
  }
  assert.ok(app.db.prepare('SELECT COUNT(*) c FROM bookings').get().c >= 1, 'bookings table still there');
});

test('random ids are not guessable for confirmation cards', () => {
  const rows = app.db.prepare('SELECT token FROM pending_actions').all();
  assert.ok(rows.length && rows.every((r) => String(r.token).length >= 16));
});
