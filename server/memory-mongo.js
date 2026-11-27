// A tiny in-memory stand-in for the MongoDB driver, used ONLY for tests and local demos (MONGODB_URI=memory://).
// It supports just what store.js uses: find/sort/limit, findOne, countDocuments, insertOne, updateOne/Many,
// deleteMany, findOneAndUpdate (counters), unique indexes, the bookings validator, and transactions (snapshot + rollback).
// Data is lost when the process stops. Never use it for real data.

const clone = (v) => structuredClone(v);
const typeRank = (v) => (v === null || v === undefined ? 0 : typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : typeof v === 'boolean' ? 3 : 4);
function cmp(a, b) {
  const ra = typeRank(a); const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}
const same = (a, b) => ((a === null || a === undefined) && (b === null || b === undefined)) || a === b;
const comparable = (a, b) => a !== null && a !== undefined && typeRank(a) === typeRank(b);

function matchOp(val, op, arg, opts) {
  switch (op) {
    case '$eq': return same(val, arg);
    case '$ne': return !same(val, arg);
    case '$in': return arg.some((x) => same(val, x));
    case '$nin': return !arg.some((x) => same(val, x));
    case '$gt': return comparable(val, arg) && cmp(val, arg) > 0;
    case '$gte': return comparable(val, arg) && cmp(val, arg) >= 0;
    case '$lt': return comparable(val, arg) && cmp(val, arg) < 0;
    case '$lte': return comparable(val, arg) && cmp(val, arg) <= 0;
    case '$exists': return arg ? val !== undefined : val === undefined;
    case '$regex': { if (typeof val !== 'string') return false; const re = arg instanceof RegExp ? arg : new RegExp(arg, opts.$options || ''); return re.test(val); }
    case '$options': return true;
    default: throw new Error(`memory-mongo: operator ${op} is not supported`);
  }
}
export function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter || {})) {
    if (k === '$and') { if (!cond.every((f) => matches(doc, f))) return false; continue; }
    if (k === '$or') { if (!cond.some((f) => matches(doc, f))) return false; continue; }
    const val = doc[k];
    if (cond instanceof RegExp) { if (typeof val !== 'string' || !cond.test(val)) return false; continue; }
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && Object.keys(cond).some((x) => x.startsWith('$'))) {
      for (const [op, arg] of Object.entries(cond)) if (!matchOp(val, op, arg, cond)) return false;
    } else if (!same(val, cond)) return false;
  }
  return true;
}
function applyUpdate(doc, update, inserting = false) {
  for (const [op, fields] of Object.entries(update)) {
    for (const [k, v] of Object.entries(fields)) {
      if (op === '$set') { if (v !== undefined) doc[k] = clone(v); } else if (op === '$setOnInsert') { if (inserting) doc[k] = clone(v); } else if (op === '$unset') delete doc[k];
      else if (op === '$inc') doc[k] = (doc[k] || 0) + v;
      else if (op === '$max') { if (doc[k] === undefined || cmp(v, doc[k]) > 0) doc[k] = v; } else throw new Error(`memory-mongo: update ${op} is not supported`);
    }
  }
  return doc;
}
const dupError = (name, keys) => Object.assign(new Error(`E11000 duplicate key error collection: ${name} index: ${keys}`), { code: 11000 });

// minimal $jsonSchema check: required fields, bsonType string, pattern (with a leading (?i) flag), enum
function validate(doc, validator) {
  const s = validator?.$jsonSchema;
  if (!s) return;
  const fail = () => Object.assign(new Error('Document failed validation'), { code: 121 });
  for (const k of s.required || []) if (doc[k] === undefined || doc[k] === null) throw fail();
  for (const [k, p] of Object.entries(s.properties || {})) {
    const v = doc[k];
    if (v === undefined) continue;
    if (p.bsonType === 'string' && typeof v !== 'string') throw fail();
    if (p.enum && !p.enum.includes(v)) throw fail();
    if (p.pattern) {
      let src = p.pattern; let flags = '';
      if (src.includes('(?i)')) { src = src.replace('(?i)', ''); flags = 'i'; }
      if (!new RegExp(src, flags).test(v)) throw fail();
    }
  }
}

class Cursor {
  constructor(rows) { this.rows = rows; }
  sort(spec) {
    const keys = Object.entries(spec);
    this.rows.sort((a, b) => { for (const [k, dir] of keys) { const c = cmp(a[k], b[k]); if (c) return c * dir; } return 0; });
    return this;
  }
  limit(n) { if (n) this.rows = this.rows.slice(0, n); return this; }
  async toArray() { return this.rows.map(clone); }
}

class MemoryCollection {
  constructor(name) { this.name = name; this.docs = []; this.unique = []; this.validator = null; this.seq = 0; }
  checkUnique(doc, except = null) {
    if (this.docs.some((d) => d !== except && same(d._id, doc._id))) throw dupError(this.name, '_id_');
    for (const keys of this.unique) {
      if (this.docs.some((d) => d !== except && keys.every((k) => same(d[k], doc[k])))) throw dupError(this.name, keys.join('_'));
    }
  }
  async createIndex(keys, opts = {}) { if (opts.unique) this.unique.push(Object.keys(keys)); return 'ok'; }
  async insertOne(doc) {
    const d = clone(Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined)));
    if (d._id === undefined) d._id = `m${++this.seq}`;
    validate(d, this.validator);
    this.checkUnique(d);
    this.docs.push(d);
    return { insertedId: d._id };
  }
  find(filter = {}) { return new Cursor(this.docs.filter((d) => matches(d, filter))); }
  async findOne(filter = {}) { const d = this.docs.find((x) => matches(x, filter)); return d ? clone(d) : null; }
  async countDocuments(filter = {}) { return this.docs.filter((d) => matches(d, filter)).length; }
  updateDoc(d, update) {
    const next = applyUpdate(clone(d), update);
    validate(next, this.validator);
    this.checkUnique(next, d);
    Object.keys(d).forEach((k) => delete d[k]);
    Object.assign(d, next);
  }
  async updateOne(filter, update, opts = {}) {
    const d = this.docs.find((x) => matches(x, filter));
    if (d) { this.updateDoc(d, update); return { matchedCount: 1, modifiedCount: 1 }; }
    if (opts.upsert) { await this.insertOne(applyUpdate({ ...Object.fromEntries(Object.entries(filter).filter(([, v]) => typeof v !== 'object' || v === null)) }, update, true)); return { matchedCount: 0, upsertedCount: 1 }; }
    return { matchedCount: 0, modifiedCount: 0 };
  }
  async updateMany(filter, update) {
    const list = this.docs.filter((x) => matches(x, filter));
    for (const d of list) this.updateDoc(d, update);
    return { matchedCount: list.length, modifiedCount: list.length };
  }
  async deleteMany(filter = {}) { const before = this.docs.length; this.docs = this.docs.filter((d) => !matches(d, filter)); return { deletedCount: before - this.docs.length }; }
  async deleteOne(filter = {}) { const i = this.docs.findIndex((d) => matches(d, filter)); if (i >= 0) this.docs.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; }
  async findOneAndUpdate(filter, update, opts = {}) {
    await this.updateOne(filter, update, opts);
    return this.findOne(filter);
  }
}

class MemoryDb {
  constructor() { this.cols = new Map(); }
  collection(name) { if (!this.cols.has(name)) this.cols.set(name, new MemoryCollection(name)); return this.cols.get(name); }
  async createCollection(name, opts = {}) {
    if (this.cols.has(name) && this.cols.get(name).created) throw Object.assign(new Error('collection already exists'), { code: 48 });
    const c = this.collection(name); c.created = true; if (opts.validator) c.validator = opts.validator;
    return c;
  }
  async command(cmd) {
    if (cmd.collMod) { this.collection(cmd.collMod).validator = cmd.validator; return { ok: 1 }; }
    if (cmd.hello) return { ok: 1, setName: 'memory' };
    return { ok: 1 };
  }
  snapshot() { return new Map([...this.cols].map(([n, c]) => [n, { docs: clone(c.docs), seq: c.seq }])); }
  restore(s) { for (const [n, c] of this.cols) { const x = s.get(n); c.docs = x ? x.docs : []; c.seq = x ? x.seq : 0; } }
}

export class MemoryClient {
  constructor() { this.dbs = new Map(); }
  db(name = 'test') { if (!this.dbs.has(name)) this.dbs.set(name, new MemoryDb()); return this.dbs.get(name); }
  async connect() { return this; }
  async close() {}
  startSession() {
    const client = this;
    return {
      // all-or-nothing like a real transaction: on any error every collection goes back to how it was
      async withTransaction(fn) {
        const snaps = new Map([...client.dbs].map(([n, d]) => [n, d.snapshot()]));
        try { return await fn(this); } catch (e) { for (const [n, d] of client.dbs) d.restore(snaps.get(n)); throw e; }
      },
      async endSession() {},
    };
  }
}
