// MongoDB data layer. Every collection keeps a small integer "id" (booking #12, ledger L45) like before,
// stored as the document _id, so rows look the same to the rest of the app.
// Transactions: store.tx(fn) runs fn in one MongoDB transaction; every call inside it joins the same session
// automatically (AsyncLocalStorage), so tool code does not pass sessions around.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

// collections whose documents get an auto-increment integer id
const INT_ID = new Set(['owners', 'houseboats', 'bookings', 'booking_rooms', 'ledger', 'conversations', 'messages', 'audit_log']);

// Words that are not a real sender. Mirrors the old SQLite trigger: a booking can never be saved without a sender.
const BAD_SENDERS = ['not provided', 'not specified', 'unspecified', 'unknown', 'n/a', 'na', 'none', 'null', '-'];
export const SENDER_PATTERN = `^(?i)(?!\\s*(?:${BAD_SENDERS.map((w) => w.replace(/[/-]/g, '\\$&')).join('|')})\\s*$).*\\S.*$`;
const BOOKING_VALIDATOR = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['owner_id', 'client_name', 'sender', 'check_in', 'check_out', 'status'],
    properties: {
      sender: { bsonType: 'string', pattern: SENDER_PATTERN, description: 'sender is required' },
      status: { enum: ['confirmed', 'cancelled'] },
    },
  },
};

const INDEXES = {
  owners: [[{ email: 1 }, { unique: true }]],
  houseboats: [[{ owner_id: 1, name_lc: 1 }, { unique: true }], [{ owner_id: 1, prefix: 1 }, { unique: true }]],
  bookings: [[{ owner_id: 1, check_in: 1 }]],
  booking_rooms: [[{ owner_id: 1, booking_id: 1 }], [{ booking_id: 1 }]],
  room_night_locks: [[{ owner_id: 1, stay_date: 1 }], [{ booking_id: 1 }]],
  ledger: [[{ owner_id: 1, booking_id: 1 }], [{ ref_id: 1 }]],
  messages: [[{ conversation_id: 1, id: 1 }]],
  pending_actions: [[{ owner_id: 1, conversation_id: 1, status: 1 }]],
  audit_log: [[{ owner_id: 1 }]],
};

export class DuplicateError extends Error {}
const isDup = (e) => e && (e.code === 11000 || /E11000|duplicate key/i.test(String(e.message)));

const nowIso = () => new Date().toISOString();
const strip = (d) => { if (!d) return d; const { _id, ...rest } = d; return rest; };
const clean = (doc) => Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined));

class Col {
  constructor(store, name) { this.store = store; this.name = name; this.raw = store.db.collection(name); }
  get o() { const s = als.getStore(); return s ? { session: s } : {}; }
  async find(filter = {}, { sort, limit } = {}) {
    let cur = this.raw.find(filter, this.o);
    if (sort) cur = cur.sort(sort);
    if (limit) cur = cur.limit(limit);
    return (await cur.toArray()).map(strip);
  }
  async one(filter = {}, { sort } = {}) {
    if (!sort) return strip(await this.raw.findOne(filter, this.o));
    return (await this.find(filter, { sort, limit: 1 }))[0] || null;
  }
  count(filter = {}) { return this.raw.countDocuments(filter, this.o); }
  async insert(doc) {
    const d = clean({ ...doc });
    if (INT_ID.has(this.name) && d.id == null) d.id = await this.store.nextId(this.name);
    if (d.id != null) d._id = d.id;
    if (d.created_at === undefined && this.name !== 'room_night_locks') d.created_at = nowIso();
    try { await this.raw.insertOne(d, this.o); } catch (e) { if (isDup(e)) throw new DuplicateError(`duplicate in ${this.name}`); throw e; }
    return strip(d);
  }
  // the money ledger is append-only: entries are never edited, and only removed by a confirmed "delete" of bookings
  guard() { if (this.name === 'ledger') throw new Error('ledger is append-only'); }
  async update(filter, update) { this.guard(); return (await this.raw.updateOne(filter, update, this.o)).matchedCount; }
  async updateMany(filter, update) { this.guard(); return (await this.raw.updateMany(filter, update, this.o)).matchedCount; }
  async remove(filter, { ledgerWipe = false } = {}) {
    if (this.name === 'ledger' && !ledgerWipe) this.guard();
    return (await this.raw.deleteMany(filter, this.o)).deletedCount;
  }
}

export class Store {
  constructor(client, db, { transactions }) { this.client = client; this.db = db; this.transactions = transactions; this.cols = new Map(); }
  c(name) { if (!this.cols.has(name)) this.cols.set(name, new Col(this, name)); return this.cols.get(name); }
  async nextId(name) {
    const r = await this.db.collection('counters').findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', ...this.c(name).o });
    const doc = r && r.value !== undefined && r.ok !== undefined ? r.value : r; // driver v5 returns {value}, v6+ the document
    return doc.seq;
  }
  // Raise a counter so new ids continue after copied data (used by the SQLite -> MongoDB copy).
  async bumpCounter(name, atLeast) {
    await this.db.collection('counters').updateOne({ _id: name }, { $max: { seq: atLeast } }, { upsert: true });
  }
  // Runs fn atomically. Nested calls simply join the running transaction.
  async tx(fn) {
    if (als.getStore()) return fn();
    if (!this.transactions) return fn();
    const session = this.client.startSession();
    try {
      let out;
      await session.withTransaction(async () => { out = await als.run(session, fn); });
      return out;
    } finally { await session.endSession(); }
  }
  async close() { await this.client.close(); }
}

const ALL = ['owners', 'houseboats', 'bookings', 'booking_rooms', 'room_night_locks', 'ledger', 'conversations', 'messages', 'pending_actions', 'audit_log', 'counters'];

async function setup(db) {
  // create every collection up front (older MongoDB versions cannot create one inside a transaction)
  for (const name of ALL) {
    if (name === 'bookings') continue;
    try { await db.createCollection(name); } catch (e) { if (!(e.code === 48 || /already exists/i.test(String(e.message)))) throw e; }
  }
  try { await db.createCollection('bookings', { validator: BOOKING_VALIDATOR }); } catch (e) {
    if (e.code === 48 || /already exists/i.test(String(e.message))) await db.command({ collMod: 'bookings', validator: BOOKING_VALIDATOR });
    else throw e;
  }
  for (const [name, list] of Object.entries(INDEXES)) for (const [keys, opts] of list) await db.collection(name).createIndex(keys, opts || {});
}

const dbNameOf = (uri) => { try { const p = new URL(uri).pathname.replace(/^\//, ''); return p || null; } catch { return null; } };

// uri: a MongoDB connection string (mongodb+srv://... from Atlas), or memory:// for tests (data is lost on exit).
export async function openStore(uri, { dbName } = {}) {
  if (!uri) throw new Error('MONGODB_URI is missing. Put your MongoDB Atlas connection string in .env (see README).');
  let client; let memory = false;
  if (uri.startsWith('memory:')) {
    const { MemoryClient } = await import('./memory-mongo.js');
    client = new MemoryClient(); memory = true;
  } else {
    let mod;
    try { mod = await import('mongodb'); } catch { throw new Error('The "mongodb" package is not installed. Run: npm install'); }
    client = new mod.MongoClient(uri, { ignoreUndefined: true });
    await client.connect();
  }
  const db = client.db(dbName || (memory ? 'boathouse' : dbNameOf(uri)) || 'boathouse');
  await setup(db);
  // Transactions need a replica set (MongoDB Atlas always is). A plain local mongod is not, so it runs without them.
  let transactions = memory;
  if (!memory) {
    const hello = await db.command({ hello: 1 }).catch(() => ({}));
    transactions = Boolean(hello.setName || hello.msg === 'isdbgrid');
    if (!transactions) console.warn('[db] This MongoDB is not a replica set, so changes run without transactions. Use MongoDB Atlas (or a replica set) for real use.');
  }
  return new Store(client, db, { transactions });
}

// A new account with every field set (MongoDB has no column defaults).
export const ownerDoc = (o) => ({ phone: null, note: null, session_version: 0, role: 'owner', plan: 'full', trial_ends_at: null, locked: 0, gemini_key_enc: null, ai_calls: 0, last_login_at: null, ...o });

// For the small command-line scripts: open the database from .env.
export async function storeFromConfig(cfg) { return openStore(cfg.mongoUri, { dbName: cfg.mongoDb }); }

export { isDup };
