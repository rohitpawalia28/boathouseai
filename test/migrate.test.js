// The one-time copy from the old SQLite file into MongoDB: every row and id arrives, old files of any version work,
// the app runs on the copied data (same logins, bookings, money), and an already-used database is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/sqlite-old.js';
import { openStore } from '../server/store.js';
import { copySqliteToMongo } from '../server/migrate-to-mongo.js';
import { createApp } from '../server/index.js';
import { hashPassword } from '../server/auth.js';
import { TEST_URI, dbOpts, storeOpts, cleanup } from './testdb.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bh-mig-')), 't.db');

test('an old v3 SQLite file (no senders, no new owner columns) is upgraded and copied with every id', async () => {
  const file = tmpFile();
  const d = openDb(file);
  // make it look like a v3 file
  d.exec('PRAGMA foreign_keys = OFF; DROP TRIGGER bookings_sender_required_ins; DROP TRIGGER bookings_sender_required_upd; ALTER TABLE bookings DROP COLUMN sender; ALTER TABLE bookings DROP COLUMN rooms_required; DROP TABLE booking_rooms; ALTER TABLE owners DROP COLUMN session_version; ALTER TABLE owners DROP COLUMN role; ALTER TABLE owners DROP COLUMN plan; ALTER TABLE owners DROP COLUMN trial_ends_at; ALTER TABLE owners DROP COLUMN locked; ALTER TABLE owners DROP COLUMN gemini_key_enc; ALTER TABLE owners DROP COLUMN ai_calls; ALTER TABLE owners DROP COLUMN last_login_at; ALTER TABLE owners DROP COLUMN note;');
  d.exec(`CREATE TABLE booking_rooms(id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id), owner_id INTEGER NOT NULL, houseboat_id INTEGER NOT NULL REFERENCES houseboats(id), room_no INTEGER NOT NULL, token TEXT NOT NULL, guests INTEGER NOT NULL, meal_plan TEXT NOT NULL CHECK(meal_plan IN ('EP','CP','MAP','AP')), price INTEGER NOT NULL, cost INTEGER NOT NULL);`);
  d.exec(`INSERT INTO owners(name,email,password_hash) VALUES('O','O@X.com','${await hashPassword('old-pass-123')}'); INSERT INTO houseboats(owner_id,name,prefix) VALUES(1,'Old Boat','OLD');
    INSERT INTO bookings(id,owner_id,client_name,check_in,check_out) VALUES(7,1,'Old Client','2026-12-01','2026-12-03');
    INSERT INTO booking_rooms(booking_id,owner_id,houseboat_id,room_no,token,guests,meal_plan,price,cost) VALUES(7,1,1,1,'OLD001',2,'CP',3000,0);
    INSERT INTO room_night_locks(houseboat_id,room_no,stay_date,booking_id,owner_id) VALUES(1,1,'2026-12-01',7,1),(1,1,'2026-12-02',7,1);
    INSERT INTO ledger(owner_id,booking_id,side,type,amount,created_at) VALUES(1,7,'CLIENT','CHARGE',6000,'2026-11-01 10:00:00'),(1,7,'CLIENT','PAYMENT',-1000,'2026-11-01 10:05:00');
    PRAGMA user_version = 3;`);
  d.close();
  const sqlite = openDb(file); // upgrades the old file to the last SQLite version first
  const store = await openStore(TEST_URI, storeOpts());
  const counts = await copySqliteToMongo(sqlite, store);
  sqlite.close();
  assert.deepEqual([counts.owners, counts.houseboats, counts.bookings, counts.booking_rooms, counts.room_night_locks, counts.ledger], [1, 1, 1, 1, 2, 2]);
  const o = await store.c('owners').one({});
  assert.equal(o.email, 'o@x.com', 'emails are stored in lower case');
  assert.deepEqual([o.role, o.plan, o.locked, o.session_version], ['owner', 'full', 0, 0], 'old owners are normal, never-expiring accounts');
  const b = await store.c('bookings').one({ id: 7 });
  assert.equal(b.sender, 'Old booking (no sender)', 'old bookings without a sender get a clear placeholder');
  assert.equal((await store.c('ledger').one({ amount: 6000 })).created_at, '2026-11-01T10:00:00.000Z');

  // the app runs on the copied data: same password, same booking number, same money, and new ids continue after the old ones
  const app = await createApp({ store, secret: 'x', provider: null });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const api = async (m, p, body, token) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json() }; };
  const login = await api('POST', '/api/auth/login', { email: 'O@x.com', password: 'old-pass-123' });
  assert.equal(login.status, 200, 'the old password still works');
  const t = login.data.token;
  const rows = (await api('GET', '/api/bookings', null, t)).data;
  assert.equal(rows[0].id, 7);
  assert.equal(rows[0].balance, 5000);
  assert.equal(rows[0].rooms[0].token, 'OLD001');
  const hb = await api('POST', '/api/houseboats', { name: 'New Boat', total_rooms: 3 }, t);
  assert.equal(hb.status, 200);
  assert.equal(hb.data.id, 2, 'new ids continue after the copied ones');
  // an old booking can still be cancelled (its placeholder sender is valid)
  const del = await api('POST', '/api/delete-request', { kind: 'booking', id: 7 }, t);
  assert.equal((await api('POST', '/api/confirm', { token: del.data.token }, t)).data.status, 'confirmed');
  app.server.close();
  await cleanup(store);
});

test('the copy refuses a MongoDB database that already has accounts', async () => {
  const file = tmpFile();
  const d = openDb(file);
  d.exec("INSERT INTO owners(name,email,password_hash) VALUES('A','a@x.com','h')");
  const store = await openStore(TEST_URI, storeOpts());
  await copySqliteToMongo(d, store);
  await assert.rejects(copySqliteToMongo(d, store), /already has 1 account/);
  assert.equal(await store.c('owners').count({}), 1, 'nothing was duplicated');
  d.close();
  await cleanup(store);
});
