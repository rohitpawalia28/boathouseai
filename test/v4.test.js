import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { openDb } from '../server/db.js';
import { addDays, todayStr } from '../server/util.js';

function scripted() {
  const queue = [];
  return { name: 'scripted', queue, lastSystem: '', async generate({ system }) { this.lastSystem = system; const n = queue.shift(); if (!n) throw new Error('script ran out'); return n; } };
}
const call = (name, args) => ({ parts: [{ functionCall: { name, args } }], functionCalls: [{ name, args }], text: '' });
const say = (text) => ({ parts: [{ text }], functionCalls: [], text });
const D = (n) => addDays(todayStr('Asia/Kolkata'), n);

let app, base, ai, T;
before(async () => {
  ai = scripted();
  app = createApp({ chatPerMinute: 100000, dbFile: ':memory:', secret: 'test-secret', provider: ai, allowSignup: true });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  const r = await api('POST', '/api/auth/register', { body: { name: 'Carol', email: 'carol@x.com', password: 'password123' } });
  T = r.data.token;
});
after(() => app.server.close());

async function api(method, path, { token = T, body } = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
async function propose(tool, args) {
  ai.queue.push(call(tool, args));
  const r = await api('POST', '/api/chat', { body: { message: 'do it' } });
  assert.equal(r.status, 200);
  return r.data;
}
const confirm = (t, approve = true) => api('POST', '/api/confirm', { body: { token: t, approve } });
const ok = async (tool, args) => { const r = await propose(tool, args); assert.ok(r.pending?.token, `expected a card for ${tool}: ${r.reply}`); const c = await confirm(r.pending.token); assert.equal(c.data.status, 'confirmed', c.data.message); return { card: r.pending, done: c.data }; };
// Runs a read tool exactly like the chat does and returns the plain-English answer.
async function ask(tool, args) {
  const { TOOL_MAP, runReadTool } = await import('../server/tools.js');
  const ctx = { db: app.db, ownerId: 1, ownerName: 'Carol', tz: 'Asia/Kolkata' };
  return TOOL_MAP.get(tool).format(runReadTool(ctx, tool, args));
}
const room = (houseboat, guests, price, meal_plan, extra = {}) => ({ houseboat, guests, price, meal_plan, ...extra });
const bookings = async () => (await api('GET', '/api/bookings')).data;

test('sender is compulsory: missing or "Not Provided" never reaches a card; "Direct" is fine', async () => {
  await api('POST', '/api/houseboats', { body: { name: 'Chinar', total_rooms: 5 } });
  await api('POST', '/api/houseboats', { body: { name: 'Sunrise', total_rooms: 4, is_own: true } });
  for (const sender of [undefined, '', 'Not Provided', 'unknown', 'N/A', 'none']) {
    ai.queue.push(call('create_booking', { client_name: 'No Sender', sender, check_in: D(5), check_out: D(6), rooms: [room('Chinar', 2, 1000, 'CP')] }));
    const r = await api('POST', '/api/chat', { body: { message: 'book' } });
    assert.equal(r.data.pending, null, `sender=${sender}`);
    assert.match(r.data.reply, /Who sent this booking/, 'the owner is asked at once, no extra AI turns');
    assert.equal(ai.queue.length, 0);
  }
  assert.equal((await bookings()).length, 0);
  const { done } = await ok('create_booking', { client_name: 'Walk In', sender: 'Direct', check_in: D(5), check_out: D(6), rooms: [room('Chinar', 2, 1000, 'CP')] });
  assert.match(done.message, /sender Direct/);
  assert.equal((await bookings())[0].sender, 'Direct');
});

test('the database itself refuses a booking without a real sender (even if the app is bypassed)', async () => {
  const ins = (sender) => app.db.prepare("INSERT INTO bookings(owner_id, client_name, sender, check_in, check_out) VALUES(1,'Raw',?,?,?)").run(sender, D(1), D(2));
  for (const s of [null, '', '   ', 'Not Provided', 'n/a']) assert.throws(() => ins(s), /sender is required/, String(s));
  assert.doesNotThrow(() => ins('Direct'));
  assert.throws(() => app.db.prepare("UPDATE bookings SET sender = '' WHERE client_name = 'Raw'").run(), /sender is required/);
  app.db.prepare("DELETE FROM bookings WHERE client_name = 'Raw'").run();
});

test('optional details: skip guests / price / meal plan -> "details pending", then fill in later', async () => {
  const r = await propose('create_booking', {
    client_name: 'Mehta Group', sender: 'Blue Lake Agency', check_in: D(20), check_out: D(22), rooms_required: 6,
    rooms: [room('Chinar', 2, 4000, 'MAPI'), { houseboat: 'Chinar', guests: 'skip', price: 'unspecified', meal_plan: 'later' }, { houseboat: 'Chinar' }],
  });
  const p = r.pending.preview;
  assert.equal(p.sender, 'Blue Lake Agency');
  const rooms = p.houseboats[0].rooms;
  assert.equal(rooms[0].meal_plan, 'MAP', 'MAPI is MAP');
  assert.equal(rooms[1].price, null);
  assert.deepEqual(p.totals.pending_rooms, ['CHI002', 'CHI003']);
  assert.equal(p.totals.client_total, 8000, 'pending price counts as 0');
  assert.equal(p.totals.required, 6);
  assert.equal(p.totals.left, 3);
  await confirm(r.pending.token);
  const b = (await bookings()).find((x) => x.client_name === 'Mehta Group');
  assert.deepEqual(b.pending_tokens, ['CHI002', 'CHI003']);
  assert.equal(b.rooms_left, 3);
  assert.equal(b.billed, 8000);
  assert.ok((await api('GET', '/api/dashboard')).data.details_pending >= 1);
  assert.equal((await api('GET', '/api/bookings?pending=1')).data.length, 1);
  // fill in CHI002: guests, plan, price -> client total grows by price x nights
  const u = await ok('update_room', { booking_id: b.id, token: 'CHI002', guests: 3, meal_plan: 'CPI', price: 4500 });
  assert.match(u.done.message, /3 guests, CP, ₹4,500/);
  const b2 = (await bookings()).find((x) => x.id === b.id);
  assert.equal(b2.billed, 8000 + 4500 * 2);
  assert.deepEqual(b2.pending_tokens, ['CHI003']);
  // houseboat payable follows (partner price defaults to the client price)
  const pay = (await api('GET', '/api/balance')).data.houseboats.find((h) => h.name === 'Chinar');
  assert.equal(pay.payable, 1000 /* Walk In, 1 night */ + 4000 * 2 + 4500 * 2);
});

test('rooms required vs allocated: cannot give more rooms than required; add rooms later', async () => {
  ai.queue.push(call('create_booking', { client_name: 'Over', sender: 'Direct', rooms_required: 1, check_in: D(30), check_out: D(31), rooms: [room('Chinar', 2, 1, 'EP'), room('Chinar', 2, 1, 'EP')] }));
  ai.queue.push(say('Check the numbers.'));
  assert.equal((await api('POST', '/api/chat', { body: { message: 'x' } })).data.pending, null);
  const b = (await bookings()).find((x) => x.client_name === 'Mehta Group');
  const add = await ok('add_rooms', { booking_id: b.id, rooms: [room('Chinar', 2, 4000, 'MAP'), room('Sunrise', 2, 3000, 'CP', { own: true })] });
  assert.match(add.done.message, /Now 5 rooms of 6 required/);
  const b2 = (await bookings()).find((x) => x.id === b.id);
  assert.equal(b2.rooms_left, 1);
  assert.equal(b2.billed, 8000 + 9000 + (4000 + 3000) * 2);
  // setting required below allocated is refused
  ai.queue.push(call('update_booking', { booking_id: b.id, rooms_required: 2 }));
  ai.queue.push(say('Too low.'));
  assert.equal((await api('POST', '/api/chat', { body: { message: 'x' } })).data.pending, null);
  await ok('update_booking', { booking_id: b.id, rooms_required: 5 });
  assert.equal((await bookings()).find((x) => x.id === b.id).rooms_left, 0);
});

test('edit booking: change dates (clash refused, money follows), sender, client', async () => {
  const mehta = (await bookings()).find((x) => x.client_name === 'Mehta Group');
  const before = mehta.billed;
  // clash: a second booking sits on CHI001 on D(24)
  await ok('create_booking', { client_name: 'Blocker', sender: 'Direct', check_in: D(24), check_out: D(25), rooms: [room('Chinar', 2, 100, 'EP', { room_no: 1 })] });
  ai.queue.push(call('update_booking', { booking_id: mehta.id, check_out: D(25) }));
  ai.queue.push(say('That room is taken.'));
  assert.equal((await api('POST', '/api/chat', { body: { message: 'extend' } })).data.pending, null);
  // a shorter stay is fine: 2 nights -> 1 night halves the client total
  const r = await ok('update_booking', { booking_id: mehta.id, check_out: D(21) });
  assert.match(r.card.summary, /2 -> 1 nights/);
  const after = (await bookings()).find((x) => x.id === mehta.id);
  assert.equal(after.nights, 1);
  assert.equal(after.billed, before / 2);
  // the freed night can now be booked by someone else
  assert.equal(app.db.prepare('SELECT COUNT(*) c FROM room_night_locks WHERE booking_id = ?').get(mehta.id).c, 5);
  // sender change, and an empty sender is refused
  await ok('update_booking', { booking_id: mehta.id, sender: 'Lake View Tours' });
  assert.equal((await bookings()).find((x) => x.id === mehta.id).sender, 'Lake View Tours');
  ai.queue.push(call('update_booking', { booking_id: mehta.id, sender: 'Not Provided' }));
  ai.queue.push(say('Need a name.'));
  assert.equal((await api('POST', '/api/chat', { body: { message: 'x' } })).data.pending, null);
});

test('move a room to another houseboat and remove a room: tokens, locks and what you owe follow', async () => {
  const b = (await bookings()).find((x) => x.client_name === 'Mehta Group');
  const owedBefore = (await api('GET', '/api/balance')).data.houseboats.find((h) => h.name === 'Chinar').pending;
  const m = await ok('move_room', { booking_id: b.id, token: 'CHI001', to_houseboat: 'Cultural Palace', partner_price: 3500 });
  assert.match(m.done.message, /CHI001 moved to Cultural Palace as CUL001/);
  const hb = (await api('GET', '/api/balance')).data.houseboats;
  assert.equal(hb.find((h) => h.name === 'Cultural Palace').payable, 3500);
  assert.equal(hb.find((h) => h.name === 'Chinar').pending, owedBefore - 4000);
  const moved = (await bookings()).find((x) => x.id === b.id).rooms.find((r) => r.token === 'CUL001');
  assert.equal(moved.houseboat, 'Cultural Palace');
  // CHI001 is free for that night again
  assert.equal(app.db.prepare("SELECT COUNT(*) c FROM room_night_locks WHERE booking_id = ? AND stay_date = ? AND room_no = 1 AND houseboat_id = (SELECT id FROM houseboats WHERE name = 'Chinar')").get(b.id, D(20)).c, 0);
  // moving to a houseboat that is own: nothing to pay for that room any more
  await ok('move_room', { booking_id: b.id, token: 'CUL001', to_houseboat: 'Sunrise' });
  assert.equal((await api('GET', '/api/balance')).data.houseboats.find((h) => h.name === 'Cultural Palace').pending, 0);
  // remove a room
  const billedBefore = (await bookings()).find((x) => x.id === b.id).billed;
  const rm = await ok('remove_room', { booking_id: b.id, token: 'CHI002' });
  assert.match(rm.done.message, /CHI002 removed/);
  const after = (await bookings()).find((x) => x.id === b.id);
  assert.equal(after.billed, billedBefore - 4500);
  assert.ok(!after.rooms.some((r) => r.token === 'CHI002'));
  // a booking cannot lose its last room
  const walk = (await bookings()).find((x) => x.client_name === 'Walk In');
  ai.queue.push(call('remove_room', { booking_id: walk.id, token: 'CHI001' }));
  ai.queue.push(say('Cancel instead.'));
  assert.equal((await api('POST', '/api/chat', { body: { message: 'x' } })).data.pending, null);
});

test('questions: counts per houseboat/date, vacant rooms, meal plan counts, sender search, revenue, people', async () => {
  // Fresh, simple picture on D(60): Chinar (5 rooms) 3 booked (2 MAP, 1 CP), Sunrise (4 rooms, own) 1 booked
  await ok('create_booking', { client_name: 'Count One', sender: 'ABC Travels', check_in: D(60), check_out: D(62), rooms: [room('Chinar', 2, 5000, 'MAP'), room('Chinar', 3, 5000, 'MAP'), room('Sunrise', 2, 3000, 'CP', { own: true })] });
  await ok('create_booking', { client_name: 'Count Two', sender: 'Direct', check_in: D(61), check_out: D(63), rooms: [room('Chinar', 2, 4000, 'CP')] });
  const c1 = await ask('count_rooms', { date: D(60), houseboat_name: 'Chinar' });
  assert.match(c1, /2 rooms, 5 guests/);
  const c2 = await ask('count_rooms', { date: D(61), houseboat_name: 'chinar' });
  assert.match(c2, /3 rooms/);
  const c3 = await ask('count_rooms', { date: D(61), meal_plan: 'MAPI' });
  assert.match(c3, /2 rooms.*MAP meal plan/);
  const c4 = await ask('count_rooms', { from_date: D(60), to_date: D(62), sender: 'ABC' });
  assert.match(c4, /3 rooms/);
  assert.match(c4, /6 room-nights/);
  const v = await ask('vacant_rooms', { date: D(61) });
  assert.match(v, /Chinar: 3 booked, 2 vacant of 5/);
  assert.match(v, /Sunrise \(own\): 1 booked, 3 vacant of 4/);
  assert.match(await ask('vacant_rooms', { date: D(61), houseboat_name: 'Chinar' }), /CHI004, CHI005|CHI00\d/);
  const bySender = await ask('list_bookings', { sender: 'abc' });
  assert.match(bySender, /Count One \(sender: ABC Travels\)/);
  assert.doesNotMatch(bySender, /Count Two/);
  const byPlan = await ask('list_bookings', { meal_plan: 'MAP', date: D(61) });
  assert.match(byPlan, /Count One/);
  // monthly revenue: rooms count for the nights inside the month, by houseboat and sender
  const month = D(60).slice(0, 7);
  const rep = (await api('GET', `/api/reports?month=${month}`)).data;
  assert.ok(rep.totals.revenue > 0);
  assert.ok(rep.by_houseboat.some((h) => h.houseboat === 'Chinar'));
  assert.ok(rep.by_sender.some((s) => s.sender === 'ABC Travels'));
  const win = (await api('GET', `/api/reports?from=${D(60)}&to=${D(60)}`)).data; // one night only
  assert.equal(win.by_sender.find((s) => s.sender === 'ABC Travels').revenue, 5000 + 5000 + 3000);
  assert.match(await ask('revenue_report', { from_date: D(60), to_date: D(63) }), /Client billing/);
  // clients and senders come from the bookings automatically
  const clients = (await api('GET', '/api/people?kind=client&q=count')).data.people;
  assert.deepEqual(clients.map((p) => p.name).sort(), ['Count One', 'Count Two']);
  const senders = (await api('GET', '/api/people?kind=sender')).data.people;
  const abc = senders.find((p) => p.name === 'ABC Travels');
  assert.equal(abc.bookings, 1);
  assert.equal(abc.rooms, 3);
  assert.equal(abc.billed, (5000 + 5000 + 3000) * 2);
  const av = (await api('GET', `/api/availability?date=${D(61)}`)).data;
  assert.equal(av.totals.booked, 4);
});

test('the bot is reminded of the sender rule and of last prices', async () => {
  ai.queue.push(say('hi'));
  await api('POST', '/api/chat', { body: { message: 'hello' } });
  assert.match(ai.lastSystem, /SENDER/);
  assert.match(ai.lastSystem, /MAPI/);
  assert.match(ai.lastSystem, /Chinar MAP ₹5,000/);
});

test('v3 database upgrades to v4: old bookings are kept (no sender), details become optional', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bh4-')), 't.db');
  const d = openDb(file);
  // make it look like a v3 file
  d.exec('PRAGMA foreign_keys = OFF; DROP TRIGGER bookings_sender_required_ins; DROP TRIGGER bookings_sender_required_upd; ALTER TABLE bookings DROP COLUMN sender; ALTER TABLE bookings DROP COLUMN rooms_required; DROP TABLE booking_rooms; ALTER TABLE owners DROP COLUMN session_version; ALTER TABLE owners DROP COLUMN role; ALTER TABLE owners DROP COLUMN plan; ALTER TABLE owners DROP COLUMN trial_ends_at; ALTER TABLE owners DROP COLUMN locked; ALTER TABLE owners DROP COLUMN gemini_key_enc; ALTER TABLE owners DROP COLUMN ai_calls; ALTER TABLE owners DROP COLUMN last_login_at; ALTER TABLE owners DROP COLUMN note;');
  d.exec(`CREATE TABLE booking_rooms(id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id), owner_id INTEGER NOT NULL, houseboat_id INTEGER NOT NULL REFERENCES houseboats(id), room_no INTEGER NOT NULL, token TEXT NOT NULL, guests INTEGER NOT NULL, meal_plan TEXT NOT NULL CHECK(meal_plan IN ('EP','CP','MAP','AP')), price INTEGER NOT NULL, cost INTEGER NOT NULL);`);
  d.exec(`INSERT INTO owners(name,email,password_hash) VALUES('O','o@x.com','h'); INSERT INTO houseboats(owner_id,name,prefix) VALUES(1,'Old Boat','OLD');
    INSERT INTO bookings(owner_id,client_name,check_in,check_out) VALUES(1,'Old Client','2026-12-01','2026-12-03');
    INSERT INTO booking_rooms(booking_id,owner_id,houseboat_id,room_no,token,guests,meal_plan,price,cost) VALUES(1,1,1,1,'OLD001',2,'CP',3000,0);
    PRAGMA user_version = 3;`);
  d.close();
  const d2 = openDb(file);
  assert.equal(d2.prepare('SELECT client_name, sender FROM bookings').get().sender, null);
  assert.equal(d2.prepare('SELECT guests, meal_plan, price FROM booking_rooms').get().price, 3000);
  assert.equal(d2.prepare('PRAGMA user_version').get().user_version, 6);
  assert.equal(d2.prepare('SELECT session_version FROM owners').get().session_version, 0, 'old owners get the new login-version column');
  const oo = d2.prepare('SELECT role, plan, locked, trial_ends_at, gemini_key_enc FROM owners').get();
  assert.deepEqual({ ...oo }, { role: 'owner', plan: 'full', locked: 0, trial_ends_at: null, gemini_key_enc: null }, 'old owners stay normal, never-expiring accounts after the v6 upgrade');
  assert.equal(d2.prepare('PRAGMA table_info(booking_rooms)').all().find((c) => c.name === 'guests').notnull, 0);
  d2.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = 1").run(); // old rows without sender can still be cancelled
  assert.throws(() => d2.prepare("INSERT INTO bookings(owner_id, client_name, check_in, check_out) VALUES(1,'New','2026-12-05','2026-12-06')").run(), /sender is required/);
  assert.doesNotThrow(() => d2.prepare("INSERT INTO booking_rooms(booking_id,owner_id,houseboat_id,room_no,token,cost) VALUES(1,1,1,2,'OLD002',0)").run());
  d2.close();
});

test('Gemini only receives standard schema keys (an unknown key makes it refuse the call)', async () => {
  const { toolDeclarations } = await import('../server/tools.js');
  const allowed = new Set(['type', 'description', 'enum', 'properties', 'required', 'items']);
  const bad = [];
  const walk = (node, path, inProps = false) => {
    if (Array.isArray(node)) return node.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (!inProps && !allowed.has(k)) bad.push(`${path}.${k}`);
      walk(v, `${path}.${k}`, k === 'properties');
    }
  };
  for (const d of toolDeclarations()) walk(d.parameters, d.name);
  assert.deepEqual(bad, []);
  const create = toolDeclarations().find((d) => d.name === 'create_booking');
  assert.ok(create.parameters.properties.rooms.items.properties.meal_plan.enum.includes('MAP'), 'enums are kept');
  assert.deepEqual(create.parameters.required, ['client_name', 'sender', 'check_in', 'check_out', 'rooms']);
});

test('when the AI call fails, the chat shows the real reason (not just "not reachable")', async () => {
  ai.queue.length = 0; // nothing scripted: the fake provider throws "script ran out"
  const r = await api('POST', '/api/chat', { body: { message: 'hello there' } });
  assert.match(r.data.reply, /simple mode/);
  assert.match(r.data.reply, /Reason: Error: script ran out/);
});

test('"delete all" wipes every booking and money entry after confirmation; houseboats stay; other owners untouched', async () => {
  const r2 = await api('POST', '/api/auth/register', { token: null, body: { name: 'Dave', email: 'dave@x.com', password: 'password123' } });
  const D2 = r2.data.token;
  app.db.exec("INSERT INTO houseboats(owner_id,name,prefix) VALUES(2,'Dave Boat','DAV'); INSERT INTO bookings(owner_id,client_name,sender,check_in,check_out) VALUES(2,'Dave Client','Direct','2030-01-01','2030-01-02'); INSERT INTO ledger(owner_id,booking_id,side,type,amount) VALUES(2,(SELECT MAX(id) FROM bookings),'CLIENT','CHARGE',500);");
  const count = (t, o = 1) => app.db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE owner_id = ?`).get(o).c;
  assert.ok(count('bookings') > 3 && count('ledger') > 3);
  // typed phrase opens a confirm card straight away (no AI call is scripted)
  ai.queue.length = 0;
  const r = await api('POST', '/api/chat', { body: { message: 'Delete all' } });
  assert.equal(r.data.pending.tool, 'delete_all_bookings');
  assert.match(r.data.pending.preview.lines.join(' '), /deleted for good/);
  assert.match(r.data.pending.preview.lines.join(' '), /cannot be undone/);
  assert.equal(count('bookings') > 3, true, 'nothing deleted before confirming');
  // cancelling keeps everything
  assert.equal((await confirm(r.data.pending.token, false)).data.status, 'cancelled');
  assert.ok(count('bookings') > 3);
  // Hinglish phrase and a typed "haan" confirm
  const again = await api('POST', '/api/chat', { body: { message: 'sab booking delete kar do' } });
  assert.equal(again.data.pending.tool, 'delete_all_bookings');
  const yes = await api('POST', '/api/chat', { body: { message: 'haan' } });
  assert.match(yes.data.reply, /were deleted/);
  assert.equal(count('bookings'), 0);
  assert.equal(count('booking_rooms'), 0);
  assert.equal(count('room_night_locks'), 0);
  assert.equal(count('ledger'), 0);
  assert.ok(count('houseboats') >= 3, 'houseboats are kept');
  assert.equal(count('bookings', 2), 1, 'another owner keeps their booking');
  assert.equal(count('ledger', 2), 1);
  const bal = (await api('GET', '/api/balance')).data;
  assert.equal(bal.totals.to_receive, 0);
  assert.equal(bal.totals.to_pay, 0);
  // nothing left to delete
  const none = await api('POST', '/api/chat', { body: { message: 'delete all' } });
  assert.equal(none.data.pending, null);
  assert.match(none.data.reply, /no bookings/);
  // rooms are free again, and the ledger is still append-only for everyone else
  const fresh = await ok('create_booking', { client_name: 'Fresh Start', sender: 'Direct', check_in: D(20), check_out: D(21), rooms: [room('Chinar', 2, 1000, 'CP')] });
  assert.match(fresh.done.message, /CHI001/);
  assert.throws(() => app.db.prepare('DELETE FROM ledger WHERE owner_id = 1').run(), /append-only/);
  assert.equal(D2.length > 10, true);
});

test('a houseboat has at most 5 rooms: a big request must be spread over several houseboats', async () => {
  // 6 rooms on one houseboat with no total set is refused (the bot is told to ask for the split)
  ai.queue.push(call('create_booking', { client_name: 'Big Group', sender: 'Direct', rooms_required: 40, check_in: D(100), check_out: D(101), rooms: Array.from({ length: 6 }, () => room('Gulmarg', 2, 3000, 'CP')) }));
  ai.queue.push(say('Gulmarg can hold only 5. Which other houseboats?'));
  const refused = await api('POST', '/api/chat', { body: { message: '40 rooms Gulmarg' } });
  assert.equal(refused.data.pending, null);
  assert.match(ai.lastSystem, /at most 5 rooms/);
  // 5 on one houseboat + the rest on others is fine, and 40 required / 12 allocated is tracked
  const r = await propose('create_booking', { client_name: 'Big Group', sender: 'Direct', rooms_required: 40, check_in: D(100), check_out: D(101),
    rooms: [...Array.from({ length: 5 }, () => room('Gulmarg', 2, 3000, 'CP')), ...Array.from({ length: 4 }, () => room('Dal View', 2, 3000, 'CP')), ...Array.from({ length: 3 }, () => room('Nigeen', 2, 3000, 'CP'))] });
  assert.equal(r.pending.preview.totals.rooms, 12);
  assert.equal(r.pending.preview.totals.left, 28);
  assert.deepEqual(r.pending.preview.houseboats.find((h) => h.name === 'Gulmarg').rooms.map((x) => x.token), ['GUL001', 'GUL002', 'GUL003', 'GUL004', 'GUL005']);
  await confirm(r.pending.token);
  // explicit room 6, adding a 6th room later, and a total above 5 are all refused
  ai.queue.push(call('create_booking', { client_name: 'X', sender: 'Direct', check_in: D(110), check_out: D(111), rooms: [room('Dal View', 2, 1, 'EP', { room_no: 6 })] }));
  ai.queue.push(say('No such room.'));
  assert.equal((await api('POST', '/api/chat', { body: { message: 'room 6' } })).data.pending, null);
  const big = (await bookings()).find((b) => b.client_name === 'Big Group');
  ai.queue.push(call('add_rooms', { booking_id: big.id, rooms: [room('Gulmarg', 2, 3000, 'CP')] }));
  ai.queue.push(say('Gulmarg is full.'));
  assert.equal((await api('POST', '/api/chat', { body: { message: 'one more in Gulmarg' } })).data.pending, null);
  assert.equal((await api('POST', '/api/houseboats', { body: { name: 'Huge Boat', total_rooms: 6 } })).status, 400);
  assert.equal((await api('POST', '/api/houseboats', { body: { name: 'Huge Boat', total_rooms: 5 } })).status, 200);
});

test('delete one booking and delete a houseboat (chat tools and dashboard request), with confirmation', async () => {
  const count = (t, o = 1) => app.db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE owner_id = ?`).get(o).c;
  await ok('create_booking', { client_name: 'Keep Me', sender: 'Direct', check_in: D(40), check_out: D(41), rooms: [room('Chinar', 2, 1000, 'CP')] });
  const made = await ok('create_booking', { client_name: 'Delete Me', sender: 'Direct', check_in: D(40), check_out: D(42), advance: 500, rooms: [room('Chinar', 2, 2000, 'CP')] });
  const id = Number(/#(\d+)/.exec(made.done.message)[1]);
  await ok('record_client_payment', { booking_id: id, amount: 300, method: 'UPI' });
  const before = { b: count('bookings'), l: count('ledger') };

  // the dashboard button builds the card; nothing is deleted until it is approved
  const card = await api('POST', '/api/delete-request', { body: { kind: 'booking', id } });
  assert.equal(card.status, 200);
  assert.equal(card.data.tool, 'delete_booking');
  assert.match(card.data.preview.lines.join(' '), /deleted for good/);
  assert.equal(count('bookings'), before.b);
  assert.equal((await confirm(card.data.token, false)).data.status, 'cancelled');
  assert.equal(count('bookings'), before.b);

  // approve: only that booking, its rooms, locks and money go; the other booking stays
  const again = await api('POST', '/api/delete-request', { body: { kind: 'booking', id } });
  const done = await confirm(again.data.token);
  assert.equal(done.data.status, 'confirmed');
  assert.match(done.data.message, /deleted/);
  assert.equal(count('bookings'), before.b - 1);
  assert.ok(count('ledger') < before.l);
  assert.equal(app.db.prepare('SELECT COUNT(*) c FROM ledger WHERE booking_id = ?').get(id).c, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) c FROM booking_rooms WHERE booking_id = ?').get(id).c, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) c FROM room_night_locks WHERE booking_id = ?').get(id).c, 0);
  assert.equal((await api('POST', '/api/delete-request', { body: { kind: 'booking', id } })).status, 400, 'already gone');
  // the ledger stays append-only otherwise
  assert.throws(() => app.db.prepare('DELETE FROM ledger WHERE owner_id = 1').run(), /append-only/);

  // another owner cannot delete my booking
  const r2 = await api('POST', '/api/auth/login', { token: null, body: { email: 'dave@x.com', password: 'password123' } });
  const keep = app.db.prepare("SELECT id FROM bookings WHERE client_name = 'Keep Me'").get().id;
  assert.equal((await api('POST', '/api/delete-request', { token: r2.data.token, body: { kind: 'booking', id: keep } })).status, 400);

  // houseboat: refused while it has bookings, allowed when it has none
  const used = await api('POST', '/api/delete-request', { body: { kind: 'houseboat', id: app.db.prepare("SELECT id FROM houseboats WHERE owner_id = 1 AND name = 'Chinar'").get().id } });
  assert.equal(used.status, 400);
  assert.match(used.data.error, /cannot be deleted/);
  await api('POST', '/api/houseboats', { body: { name: 'Test Boat', total_rooms: 3 } });
  ai.queue.push(call('delete_houseboat', { houseboat: 'Test Boat' }));
  const viaChat = await api('POST', '/api/chat', { body: { message: 'delete Test Boat' } });
  assert.equal(viaChat.data.pending.tool, 'delete_houseboat');
  const gone = await confirm(viaChat.data.pending.token);
  assert.match(gone.data.message, /Test Boat was deleted/);
  assert.equal(app.db.prepare("SELECT COUNT(*) c FROM houseboats WHERE owner_id = 1 AND name = 'Test Boat'").get().c, 0);
  // deleting from the dashboard works too, and the name can be added again
  const hb = (await api('POST', '/api/houseboats', { body: { name: 'Test Boat', total_rooms: 3 } })).data;
  const dc = await api('POST', '/api/delete-request', { body: { kind: 'houseboat', id: hb.id } });
  assert.equal((await confirm(dc.data.token)).data.status, 'confirmed');
});

test('set_meal_plans changes many houseboats in one confirmation (CPI/API aliases, by date)', async () => {
  const plan = (n) => app.db.prepare("SELECT meal_plan FROM booking_rooms WHERE token = ?").all(n).map((r) => r.meal_plan);
  const a = await ok('create_booking', { client_name: 'Meal One', sender: 'Direct', check_in: D(200), check_out: D(202), rooms: [room('Flower Garden', 2, 3000, 'MAP'), room('Flower Garden', 2, 3000, 'MAP'), room('Chinar', 2, 4000, 'EP'), room('Helen of Troy', 2, 5000, 'CP')] });
  const b = await ok('create_booking', { client_name: 'Meal Two', sender: 'Direct', check_in: D(201), check_out: D(203), rooms: [room('Helen of Troy', 3, 5000, 'EP'), room('Chinar', 2, 4000, 'AP')] });
  assert.ok(a.done && b.done);
  const flRooms = app.db.prepare("SELECT token FROM booking_rooms WHERE token LIKE 'FLO%'").all();
  assert.equal(flRooms.length, 2);
  // owner says plans for three houseboats on one night (D(201): both bookings are staying)
  const r = await propose('set_meal_plans', { date: D(201), changes: [{ houseboat: 'Flower Garden', meal_plan: 'EP' }, { houseboat: 'Chinar', meal_plan: 'CPI' }, { houseboat: 'Helen of Troy', meal_plan: 'API' }] });
  assert.equal(r.pending.tool, 'set_meal_plans');
  const lines = r.pending.preview.lines.join('\n');
  assert.match(lines, /Flower Garden -> EP/);
  assert.match(lines, /Chinar -> CP/);
  assert.match(lines, /Helen of Troy -> AP/);
  assert.equal(plan(flRooms[0].token)[0], 'MAP', 'nothing changes before confirming');
  const done = await confirm(r.pending.token);
  assert.equal(done.data.status, 'confirmed', done.data.message);
  assert.match(done.data.message, /Meal plan changed for 6 rooms/);
  const all = app.db.prepare("SELECT h.name n, br.meal_plan p FROM booking_rooms br JOIN houseboats h ON h.id = br.houseboat_id JOIN bookings b ON b.id = br.booking_id WHERE b.client_name LIKE 'Meal %'").all();
  for (const x of all) assert.equal(x.p, { 'Flower Garden': 'EP', Chinar: 'CP', 'Helen of Troy': 'AP' }[x.n], x.n);
  // money is untouched by a meal-plan change, and a repeat reports nothing to change
  ai.queue.push(call('set_meal_plans', { date: D(201), changes: [{ houseboat: 'Chinar', meal_plan: 'CP' }] }));
  ai.queue.push(say('They already have CP.'));
  const same = await api('POST', '/api/chat', { body: { message: 'Chinar CP on that day' } });
  assert.equal(same.data.pending, null);
  // an unknown houseboat is mentioned in the card but the known one still changes; one booking only
  const oneId = app.db.prepare("SELECT id FROM bookings WHERE client_name = 'Meal One'").get().id;
  const part = await propose('set_meal_plans', { booking_id: oneId, meal_plan: 'MAP' });
  assert.equal(part.pending.tool, 'set_meal_plans');
  await confirm(part.pending.token, false);
  const mix = await propose('set_meal_plans', { date: D(200), changes: [{ houseboat: 'Chinar', meal_plan: 'MAP' }, { houseboat: 'Nowhere Boat', meal_plan: 'EP' }] });
  assert.match(mix.pending.preview.lines.join(' '), /Nowhere Boat/);
  assert.equal((await confirm(mix.pending.token)).data.status, 'confirmed');
  assert.equal(app.db.prepare("SELECT br.meal_plan p FROM booking_rooms br JOIN bookings b ON b.id = br.booking_id WHERE b.client_name = 'Meal One' AND br.token LIKE 'CHI%'").get().p, 'MAP');
  // needs a date or booking
  ai.queue.push(call('set_meal_plans', { changes: [{ houseboat: 'Chinar', meal_plan: 'CP' }] }));
  ai.queue.push(say('Which date?'));
  assert.equal((await api('POST', '/api/chat', { body: { message: 'Chinar CP' } })).data.pending, null);
});

test('stuck AI loops never end in "too many steps": the owner gets the real question or error', async () => {
  // 1) the AI keeps trying to book without a sender -> the owner is asked ONCE, straight away (only 1 AI call used)
  ai.queue.length = 0;
  for (let i = 0; i < 5; i++) ai.queue.push(call('create_booking', { client_name: 'Rohit Kumar', check_in: D(1), check_out: D(3), rooms: [room('Sunrise', undefined, 5500, 'CP'), room('Chinar', undefined, 5500, 'CP')] }));
  let r = await api('POST', '/api/chat', { body: { message: 'kal ki booking Rohit Kumar, 2 din, ek room mera ek Chinar, CP, 5500 per room' } });
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.data.reply, /too many steps/);
  assert.match(r.data.reply, /Who sent this booking/);
  assert.match(r.data.reply, /Rohit Kumar/);
  assert.equal(ai.queue.length, 4, 'stopped after the first call');
  assert.equal(r.data.pending, null);

  // 2) the same non-sender mistake twice -> stop and show that mistake
  ai.queue.length = 0;
  for (let i = 0; i < 5; i++) ai.queue.push(call('create_booking', { client_name: 'X', sender: 'Direct', check_in: D(3), check_out: D(3), rooms: [room('Chinar', 2, 1000, 'CP')] }));
  r = await api('POST', '/api/chat', { body: { message: 'book x' } });
  assert.match(r.data.reply, /Check-out must be after check-in/);
  assert.equal(ai.queue.length, 3, 'stopped after the second identical failure');

  // 3) different mistakes each time, never finishing -> the last real error is shown, not a vague apology
  ai.queue.length = 0;
  const bad = [
    { check_out: D(1), check_in: D(2) },
    { check_in: 'tomorrow', check_out: D(3) },
    { check_in: D(1), check_out: D(1) },
    { check_in: D(2), check_out: D(1) },
    { check_in: 'kal', check_out: 'parso' },
  ];
  for (const d of bad) ai.queue.push(call('create_booking', { client_name: 'Y', sender: 'Direct', rooms: [room('Chinar', 2, 1000, 'CP')], ...d }));
  r = await api('POST', '/api/chat', { body: { message: 'book y' } });
  assert.doesNotMatch(r.data.reply, /too many steps/);
  assert.match(r.data.reply, /Dates must look like|Check-out must be after/);
  ai.queue.length = 0;

  // 4) the normal route still works: after the owner answers "Direct", the booking card appears
  const ok1 = await propose('create_booking', { client_name: 'Rohit Kumar', sender: 'Direct', check_in: D(1), check_out: D(3), rooms: [room('Sunrise', 2, 5500, 'CP'), room('Chinar', 2, 5500, 'CP')] });
  assert.ok(ok1.pending?.token);
  assert.match(ok1.pending.summary, /Client total .*22,000/);
  await confirm(ok1.pending.token, false);
});

test('overpaid houseboat: dashboard can reverse the wrong payment and the balance returns to zero', async () => {
  // a general payment with nothing owed = "paid extra"
  await api('POST', '/api/houseboats', { body: { name: 'Zero Test Boat', total_rooms: 4 } });
  await ok('record_houseboat_payment', { houseboat_name: 'Zero Test Boat', amount: 15000 });
  let bal = (await api('GET', '/api/balance')).data;
  const chinar = bal.houseboats.find((h) => h.name === 'Zero Test Boat');
  assert.equal(chinar.pending, -15000, 'paid with nothing owed = paid extra (shown as a negative pending)');
  const entry = bal.ledger.find((l) => l.type === 'PAYMENT' && l.side === 'PARTNER' && l.amount === -15000);
  assert.ok(entry);
  const req = await api('POST', '/api/delete-request', { body: { kind: 'entry', id: entry.id } });
  assert.equal(req.status, 200);
  assert.match(req.data.summary, /Reverse houseboat payment/);
  const done = await confirm(req.data.token);
  assert.equal(done.data.status, 'confirmed');
  bal = (await api('GET', '/api/balance')).data;
  assert.equal(bal.houseboats.find((h) => h.name === 'Zero Test Boat').pending, 0);
  assert.equal(bal.houseboats.find((h) => h.name === 'Zero Test Boat').paid, 0, 'the reversed payment no longer counts as paid');
  // a charge or someone else's entry cannot be reversed this way
  const bad = await api('POST', '/api/delete-request', { body: { kind: 'entry', id: 99999 } });
  assert.equal(bad.status >= 400, true);
});

test('add_houseboats: the AI adds many houseboats in one confirmation (own + partner, rooms optional)', async () => {
  const reg = await api('POST', '/api/auth/register', { token: null, body: { name: 'Boat Adder', email: 'adder@x.com', password: 'password123' } });
  const t = reg.data.token;
  const prop = async (args) => { ai.queue.push(call('add_houseboats', args)); return (await api('POST', '/api/chat', { token: t, body: { message: 'add boats' } })).data; };
  const conf = (tok) => api('POST', '/api/confirm', { token: t, body: { token: tok, approve: true } });
  const boatsNow = async () => Object.fromEntries((await api('GET', '/api/houseboats', { token: t })).data.map((b) => [b.name, b]));
  const p = await prop({ houseboats: [{ name: 'Chinar' }, { name: 'Blue Sky', own: true, total_rooms: 4 }, { name: 'Purple Sky', total_rooms: 3 }, { name: 'Red Sky', total_rooms: 5 }, { name: 'red  sky' }] });
  assert.ok(p.pending?.token, JSON.stringify(p));
  assert.equal(Object.keys(await boatsNow()).length, 0, 'nothing is saved before confirming');
  const r = await conf(p.pending.token);
  assert.equal(r.data.status, 'confirmed', r.data.message);
  assert.match(r.data.message, /Added Chinar .*Blue Sky .*Purple Sky .*Red Sky/);
  const by = await boatsNow();
  assert.equal(Object.keys(by).length, 4, 'duplicate "red  sky" is added once');
  assert.equal(by['Blue Sky'].total_rooms, 4); assert.ok(by['Blue Sky'].is_own);
  assert.ok(!by.Chinar.is_own); assert.equal(by.Chinar.total_rooms, null);
  // later: set room counts; Blue Sky stays "own" when not mentioned again
  const p2 = await prop({ houseboats: [{ name: 'chinar', total_rooms: 5 }, { name: 'Blue Sky', total_rooms: 5 }] });
  assert.equal((await conf(p2.pending.token)).data.status, 'confirmed');
  const by2 = await boatsNow();
  assert.equal(by2.Chinar.total_rooms, 5); assert.equal(by2['Blue Sky'].total_rooms, 5); assert.ok(by2['Blue Sky'].is_own);
  // a 9-room houseboat gets no card
  ai.queue.length = 0;
  ai.queue.push(call('add_houseboats', { houseboats: [{ name: 'Huge Boat', total_rooms: 9 }] }), say('A houseboat has at most 5 rooms.'));
  const bad = await api('POST', '/api/chat', { token: t, body: { message: 'add Huge Boat 9 rooms' } });
  assert.ok(!bad.data.pending);
  assert.ok(!(await boatsNow())['Huge Boat']);
  ai.queue.length = 0;
});
