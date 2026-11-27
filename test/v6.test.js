import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { hashPassword } from '../server/auth.js';
import { seal, open } from '../server/secretbox.js';

const DAY = 86_400_000;
const say = (text) => ({ parts: [{ text }], functionCalls: [], text });
let clock = Date.parse('2026-12-01T10:00:00.000Z');
const used = []; // which Gemini key answered each AI request
const keyed = (key) => ({ name: `own:${key.slice(-4)}`, async generate() { used.push(key); if (key.endsWith('FAIL')) { const e = new Error('x'); e.status = 400; e.detail = 'API key not valid'; throw e; } return say(`answer from ...${key.slice(-4)}`); }, async transcribe() { used.push(key); return 'voice text'; } });
const sharedAi = { name: 'shared', async generate() { used.push('SHARED'); return say('answer from the shared key'); } };

let app, base, ADMIN;
const KEY_A = 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1AAA';
const KEY_B = 'AIzaSyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2BBB';
const KEY_C = 'AIzaSyCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3CCC';

async function api(method, p, { token, body } = {}) {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const login = async (email, password) => api('POST', '/api/auth/login', { body: { email, password } });
async function makeCustomer(over = {}) {
  const r = await api('POST', '/api/admin/owners', { token: ADMIN, body: { name: 'Boat Owner', email: `o${Math.random().toString(36).slice(2, 8)}@x.com`, ...over } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

before(async () => {
  app = createApp({ chatPerMinute: 100000, loginsPerWindow: 100000, dbFile: ':memory:', secret: 'test-secret', provider: sharedAi, providerFactory: keyed, now: () => clock });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  app.db.prepare("INSERT INTO owners(name, email, password_hash, role, plan) VALUES('Admin','admin@x.com',?,'admin','full')").run(await hashPassword('AdminPass#123'));
  const r = await login('admin@x.com', 'AdminPass#123');
  assert.equal(r.status, 200);
  assert.equal(r.data.owner.role, 'admin');
  ADMIN = r.data.token;
});
after(() => app.server.close());

test('admin and owners are kept apart: owners cannot open admin pages, admin has no houseboat data', async () => {
  const c = await makeCustomer({ password: 'owner-pass-1' });
  const o = (await login(c.owner.email, 'owner-pass-1')).data.token;
  assert.equal((await api('GET', '/api/admin/owners', { token: o })).status, 403);
  assert.equal((await api('POST', '/api/admin/owners', { token: o, body: { name: 'Eve', email: 'eve@x.com' } })).status, 403);
  assert.equal((await api('GET', '/api/admin/owners')).status, 401, 'not logged in');
  for (const [m, p] of [['GET', '/api/dashboard'], ['GET', '/api/houseboats'], ['POST', '/api/chat']]) assert.equal((await api(m, p, { token: ADMIN, body: m === 'POST' ? { message: 'hi' } : undefined })).status, 403, `${p} for admin`);
  const me = (await api('GET', '/api/me', { token: ADMIN })).data;
  assert.equal(me.role, 'admin');
  assert.equal(me.trial, null);
  // the admin account itself can never be changed through the customer routes
  assert.equal((await api('POST', `/api/admin/owners/${me.id}/access`, { token: ADMIN, body: { action: 'lock' } })).status, 404);
});

test('a new customer gets a 10-day trial that locks at exactly 10 x 24 hours', async () => {
  const created = await makeCustomer({ name: 'Trial Boats', phone: '9999900000', note: 'Kerala, 4 boats' });
  assert.equal(created.owner.status, 'trial');
  assert.equal(created.owner.days_left, 10);
  assert.equal(created.owner.trial_ends_at, new Date(clock + 10 * DAY).toISOString());
  assert.match(created.password, /^[A-Za-z0-9]{12}$/, 'a password is made when none is typed');
  const email = created.owner.email;
  const t = (await login(email, created.password)).data.token;
  assert.equal((await api('GET', '/api/me', { token: t })).data.trial.days_left, 10);

  const start = clock;
  clock = start + 10 * DAY - 1000; // one second before the end
  const t2 = (await login(email, created.password));
  assert.equal(t2.status, 200);
  assert.equal((await api('GET', '/api/me', { token: t2.data.token })).data.trial.days_left, 1);

  clock = start + 10 * DAY; // the trial ends right now
  const blocked = await login(email, created.password);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'LOCKED');
  assert.match(blocked.data.error, /trial has ended/i);
  assert.match(blocked.data.error, /contact the owner for renewal/i);
  const wrong = await login(email, 'wrong-password');
  assert.equal(wrong.status, 401, 'a wrong password still says wrong password, it does not reveal the lock');
  // someone already logged in is stopped too
  const live = await api('GET', '/api/dashboard', { token: t2.data.token });
  assert.equal(live.status, 403);
  assert.equal(live.data.code, 'LOCKED');
  assert.equal((await api('POST', '/api/chat', { token: t2.data.token, body: { message: 'hi' } })).status, 403);

  // the admin sees it as expired and renews it for 7 more days (counted from now, not from the old end)
  const id = created.owner.id;
  assert.equal((await api('GET', '/api/admin/owners', { token: ADMIN })).data.owners.find((x) => x.id === id).status, 'expired');
  const ext = await api('POST', `/api/admin/owners/${id}/access`, { token: ADMIN, body: { action: 'extend', days: 7 } });
  assert.equal(ext.data.owner.status, 'trial');
  assert.equal(ext.data.owner.trial_ends_at, new Date(clock + 7 * DAY).toISOString());
  assert.equal((await login(email, created.password)).status, 200);

  // extending an unfinished trial adds to what is left
  clock += 2 * DAY;
  const more = await api('POST', `/api/admin/owners/${id}/access`, { token: ADMIN, body: { action: 'extend', days: 3 } });
  assert.equal(more.data.owner.trial_ends_at, new Date(start + 10 * DAY + 7 * DAY + 3 * DAY).toISOString());
  clock = Date.parse('2026-12-01T10:00:00.000Z');
});

test('renewal (make full) removes the end date; lock and unlock work at any time', async () => {
  const c = await makeCustomer({ password: 'paid-owner-1' });
  const id = c.owner.id;
  clock += 400 * DAY;
  assert.equal((await login(c.owner.email, 'paid-owner-1')).status, 403, 'trial over');
  const full = await api('POST', `/api/admin/owners/${id}/access`, { token: ADMIN, body: { action: 'make_full' } });
  assert.equal(full.data.owner.status, 'full');
  assert.equal(full.data.owner.trial_ends_at, null);
  const t = (await login(c.owner.email, 'paid-owner-1')).data.token;
  clock += 3000 * DAY;
  assert.equal((await api('GET', '/api/dashboard', { token: t })).status, 200, 'a renewed account never expires');
  assert.equal((await api('POST', `/api/admin/owners/${id}/access`, { token: ADMIN, body: { action: 'lock' } })).data.owner.status, 'locked');
  const locked = await api('GET', '/api/dashboard', { token: t });
  assert.equal(locked.status, 403);
  assert.match(locked.data.error, /locked/i);
  assert.equal((await login(c.owner.email, 'paid-owner-1')).status, 403);
  assert.equal((await api('POST', `/api/admin/owners/${id}/access`, { token: ADMIN, body: { action: 'unlock' } })).data.owner.status, 'full');
  assert.equal((await api('GET', '/api/dashboard', { token: t })).status, 200);
  assert.equal((await api('POST', `/api/admin/owners/${id}/access`, { token: ADMIN, body: { action: 'dance' } })).status, 400);
  clock = Date.parse('2026-12-01T10:00:00.000Z');
});

test('a customer can change the sample password; the admin can reset it and old logins stop', async () => {
  const c = await makeCustomer({ password: 'sample-pass-1' });
  const t1 = (await login(c.owner.email, 'sample-pass-1')).data.token;
  const ch = await api('POST', '/api/auth/change-password', { token: t1, body: { current_password: 'sample-pass-1', new_password: 'my-own-pass-9' } });
  assert.equal(ch.status, 200);
  assert.equal((await login(c.owner.email, 'sample-pass-1')).status, 401);
  assert.equal((await login(c.owner.email, 'my-own-pass-9')).status, 200);
  // forgot it: the admin sets a new one (typed or made up) and the old session ends
  const t2 = (await login(c.owner.email, 'my-own-pass-9')).data.token;
  const rs = await api('POST', `/api/admin/owners/${c.owner.id}/password`, { token: ADMIN, body: {} });
  assert.match(rs.data.password, /^[A-Za-z0-9]{12}$/);
  assert.equal((await api('GET', '/api/me', { token: t2 })).status, 401);
  assert.equal((await login(c.owner.email, 'my-own-pass-9')).status, 401);
  assert.equal((await login(c.owner.email, rs.data.password)).status, 200);
  assert.equal((await api('POST', `/api/admin/owners/${c.owner.id}/password`, { token: ADMIN, body: { password: 'short' } })).status, 400);
});

test('each customer uses their OWN Gemini key; the key is stored encrypted and never shown', async () => {
  const a = await makeCustomer({ password: 'pass-owner-a', gemini_key: KEY_A });
  const b = await makeCustomer({ password: 'pass-owner-b', gemini_key: KEY_B });
  const c = await makeCustomer({ password: 'pass-owner-c' }); // no key of their own
  assert.equal(a.owner.ai, 'own');
  assert.equal(a.owner.ai_hint, '...A1AAA'.replace('A1AAA', KEY_A.slice(-4)));
  assert.equal(c.owner.ai, 'shared');
  const ta = (await login(a.owner.email, 'pass-owner-a')).data.token;
  const tb = (await login(b.owner.email, 'pass-owner-b')).data.token;
  const tc = (await login(c.owner.email, 'pass-owner-c')).data.token;
  used.length = 0;
  const ra = await api('POST', '/api/chat', { token: ta, body: { message: 'hello' } });
  const rb = await api('POST', '/api/chat', { token: tb, body: { message: 'hello' } });
  const rc = await api('POST', '/api/chat', { token: tc, body: { message: 'hello' } });
  assert.equal(ra.data.reply, `answer from ...${KEY_A.slice(-4)}`);
  assert.equal(rb.data.reply, `answer from ...${KEY_B.slice(-4)}`);
  assert.equal(rc.data.reply, 'answer from the shared key');
  assert.deepEqual(used, [KEY_A, KEY_B, 'SHARED'], 'every customer hit their own key, nobody else\'s');
  // voice goes through the same key
  used.length = 0;
  const audio = Buffer.alloc(3000, 1).toString('base64');
  assert.equal((await api('POST', '/api/transcribe', { token: tb, body: { audio, mime: 'audio/wav' } })).data.text, 'voice text');
  assert.deepEqual(used, [KEY_B]);
  // usage is counted per customer
  const list = (await api('GET', '/api/admin/owners', { token: ADMIN })).data.owners;
  assert.equal(list.find((x) => x.id === a.owner.id).ai_calls, 1);
  assert.equal(list.find((x) => x.id === b.owner.id).ai_calls, 2);
  // the plain key is nowhere: not in the database row, not in any admin answer
  const row = app.db.prepare('SELECT gemini_key_enc FROM owners WHERE id = ?').get(a.owner.id);
  assert.ok(row.gemini_key_enc.startsWith('v1.'));
  assert.ok(!row.gemini_key_enc.includes(KEY_A));
  assert.equal(open(row.gemini_key_enc, 'test-secret'), KEY_A);
  assert.equal(open(row.gemini_key_enc, 'another-secret'), null, 'unreadable without the server secret');
  assert.ok(!JSON.stringify(list).includes(KEY_A) && !JSON.stringify(a).includes(KEY_A));
  // change the key: the next request already uses the new one; remove it: back to the shared key
  assert.equal((await api('POST', `/api/admin/owners/${a.owner.id}/ai-key`, { token: ADMIN, body: { key: KEY_C } })).data.owner.ai_hint, `...${KEY_C.slice(-4)}`);
  used.length = 0;
  await api('POST', '/api/chat', { token: ta, body: { message: 'again' } });
  assert.deepEqual(used, [KEY_C]);
  assert.equal((await api('POST', `/api/admin/owners/${a.owner.id}/ai-key`, { token: ADMIN, body: { key: '' } })).data.owner.ai, 'shared');
  used.length = 0;
  await api('POST', '/api/chat', { token: ta, body: { message: 'again' } });
  assert.deepEqual(used, ['SHARED']);
  assert.equal((await api('POST', `/api/admin/owners/${a.owner.id}/ai-key`, { token: ADMIN, body: { key: 'not a key!' } })).status, 400);
  // newer Google keys do not start with AIza (for example "AQ.Ab..."): any one-line key is accepted
  for (const k of ['AQ.Ab8RN6Lx-example_key.value', 'short1']) {
    const ok = await api('POST', `/api/admin/owners/${a.owner.id}/ai-key`, { token: ADMIN, body: { key: k } });
    assert.equal(ok.status, 200, k);
  }
  assert.equal((await api('GET', '/api/me', { token: tb })).data.ai, true);
});

test('"Test key" tells the admin if a customer key works', async () => {
  const good = await makeCustomer({ gemini_key: KEY_A });
  const bad = await makeCustomer({ gemini_key: 'AIzaSyBADBADBADBADBADBADBADBADBADBADFAIL' });
  const r1 = await api('POST', `/api/admin/owners/${good.owner.id}/ai-test`, { token: ADMIN });
  assert.equal(r1.data.ok, true);
  assert.equal(r1.data.source, 'own');
  const r2 = await api('POST', `/api/admin/owners/${bad.owner.id}/ai-test`, { token: ADMIN });
  assert.equal(r2.data.ok, false);
  assert.match(r2.data.error, /HTTP 400.*API key not valid/);
  assert.ok(!JSON.stringify(r2.data).includes('BADBADBAD'), 'the key is never echoed');
});

test('backup contains only that customer\'s data', async () => {
  const x = await makeCustomer({ password: 'backup-pass-x' });
  const y = await makeCustomer({ password: 'backup-pass-y' });
  const tx = (await login(x.owner.email, 'backup-pass-x')).data.token;
  const ty = (await login(y.owner.email, 'backup-pass-y')).data.token;
  await api('POST', '/api/houseboats', { token: tx, body: { name: 'Xray Boat', total_rooms: 4 } });
  await api('POST', '/api/houseboats', { token: ty, body: { name: 'Yankee Boat', total_rooms: 3 } });
  const bk = await api('GET', `/api/admin/owners/${x.owner.id}/backup`, { token: ADMIN });
  assert.equal(bk.status, 200);
  assert.equal(bk.data.owner.email, x.owner.email);
  assert.deepEqual(bk.data.houseboats.map((h) => h.name), ['Xray Boat']);
  for (const k of ['bookings', 'booking_rooms', 'room_night_locks', 'ledger']) assert.ok(Array.isArray(bk.data[k]), k);
  assert.ok(!JSON.stringify(bk.data).includes('password_hash') && !JSON.stringify(bk.data).includes('Yankee'));
  const view = (await api('GET', '/api/admin/owners', { token: ADMIN })).data.owners.find((o) => o.id === x.owner.id);
  assert.equal(view.houseboats, 1);
  assert.equal((await api('GET', `/api/admin/owners/${x.owner.id}/backup`, { token: tx })).status, 403);
});

test('creating a customer is checked: email, duplicates, days, key shape; paid customers have no trial', async () => {
  const bad = (body) => api('POST', '/api/admin/owners', { token: ADMIN, body });
  assert.equal((await bad({ name: 'A', email: 'a@x.com' })).status, 400, 'name too short');
  assert.equal((await bad({ name: 'Abc', email: 'nope' })).status, 400);
  assert.equal((await bad({ name: 'Abc', email: 'dup@x.com', trial_days: 0 })).status, 400);
  assert.equal((await bad({ name: 'Abc', email: 'dup@x.com', trial_days: 500 })).status, 400);
  assert.equal((await bad({ name: 'Abc', email: 'dup@x.com', password: 'short' })).status, 400);
  assert.equal((await bad({ name: 'Abc', email: 'dup@x.com', gemini_key: 'short key' })).status, 400);
  assert.equal((await bad({ name: 'Abc', email: 'dup@x.com' })).status, 200);
  assert.equal((await bad({ name: 'Abc', email: 'DUP@x.com' })).status, 409, 'same email in other letters');
  const f = await bad({ name: 'Paid Boats', email: 'paid@x.com', plan: 'full' });
  assert.equal(f.data.owner.status, 'full');
  assert.equal(f.data.owner.trial_ends_at, null);
  const t14 = await bad({ name: 'Long Trial', email: 'long@x.com', trial_days: 14 });
  assert.equal(t14.data.owner.days_left, 14);
});

test('an unreadable key (server secret changed) never falls back to the shared key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh6-'));
  const file = path.join(dir, 't.db');
  const a1 = createApp({ dbFile: file, secret: 'secret-one', provider: sharedAi, providerFactory: keyed, now: () => clock });
  await new Promise((r) => a1.server.listen(0, r));
  const b1 = `http://localhost:${a1.server.address().port}`;
  a1.db.prepare("INSERT INTO owners(name, email, password_hash, role, plan, gemini_key_enc) VALUES('Boat','boat@x.com',?,'owner','full',?)").run(await hashPassword('boat-pass-12'), seal(KEY_A, 'secret-one'));
  a1.server.close(); a1.db.close();
  const a2 = createApp({ dbFile: file, secret: 'secret-two', provider: sharedAi, providerFactory: keyed, now: () => clock });
  await new Promise((r) => a2.server.listen(0, r));
  const b2 = `http://localhost:${a2.server.address().port}`;
  const l = await (await fetch(b2 + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'boat@x.com', password: 'boat-pass-12' }) })).json();
  used.length = 0;
  const r = await (await fetch(b2 + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${l.token}` }, body: JSON.stringify({ message: 'summary' }) })).json();
  assert.equal(r.simple, true, 'simple mode instead of silently spending the shared key');
  assert.deepEqual(used, []);
  a2.server.close(); a2.db.close();
  void b1;
});

test('an owner can update their own API key: it is checked with Google first, a bad key keeps the old one', async () => {
  const c = await makeCustomer({ password: 'password123' });
  const t = (await login(c.owner.email, 'password123')).data.token;
  let info = await api('GET', '/api/my-ai-key', { token: t });
  assert.equal(info.status, 200); assert.equal(info.data.own, false);
  const good = 'AQ.Ab8RN6-new-owner-key-GOOD';
  const ok = await api('POST', '/api/my-ai-key', { token: t, body: { key: good } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  info = await api('GET', '/api/my-ai-key', { token: t });
  assert.equal(info.data.own, true); assert.equal(info.data.hint, '...GOOD');
  assert.ok(!JSON.stringify(info.data).includes(good), 'the full key is never sent back');
  // a key Google refuses is not saved
  const bad = await api('POST', '/api/my-ai-key', { token: t, body: { key: 'AQ.Ab-broken-key-FAIL' } });
  assert.equal(bad.status, 400); assert.match(bad.data.error, /old key is kept/);
  assert.equal((await api('GET', '/api/my-ai-key', { token: t })).data.hint, '...GOOD');
  // chat now runs on the owner's new key
  used.length = 0;
  await api('POST', '/api/chat', { token: t, body: { message: 'hello' } });
  assert.deepEqual(used, [good]);
  // empty or spaced keys, the admin account, and no login are refused
  assert.equal((await api('POST', '/api/my-ai-key', { token: t, body: { key: '' } })).status, 400);
  assert.equal((await api('POST', '/api/my-ai-key', { token: t, body: { key: 'two words' } })).status, 400);
  assert.equal((await api('POST', '/api/my-ai-key', { token: ADMIN, body: { key: good } })).status, 403);
  assert.equal((await api('POST', '/api/my-ai-key', { body: { key: good } })).status, 401);
});
