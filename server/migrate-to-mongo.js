// Copies everything from the old SQLite file (data/boathouse.db) into MongoDB, keeping every id,
// so booking #12 is still #12 and old logins and passwords keep working.
// Usage:  npm run migrate-to-mongo                 (reads data/boathouse.db)
//    or:  npm run migrate-to-mongo -- path/to/file.db
// It only copies into an EMPTY MongoDB database, so it can never mix or duplicate data.
// The SQLite file is only read, never changed (an old-format file is upgraded in a temporary copy).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, getConfig } from './env.js';
import { storeFromConfig } from './store.js';

const TABLES = ['owners', 'houseboats', 'bookings', 'booking_rooms', 'room_night_locks', 'ledger', 'conversations', 'messages', 'pending_actions', 'audit_log'];
const INT_ID = new Set(['owners', 'houseboats', 'bookings', 'booking_rooms', 'ledger', 'conversations', 'messages', 'audit_log']);
const NO_SENDER = 'Old booking (no sender)'; // bookings made before the sender was compulsory

// SQLite wrote times as "2026-11-27 10:15:00" (UTC); the new data uses ISO "2026-11-27T10:15:00.000Z".
const iso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v.replace(' ', 'T')}.000Z` : v);
const plain = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));

function convert(table, row) {
  const d = plain(row);
  for (const k of ['created_at', 'updated_at', 'cancelled_at']) if (k in d) d[k] = iso(d[k]);
  if (INT_ID.has(table)) d._id = d.id;
  if (table === 'owners') d.email = String(d.email).trim().toLowerCase();
  if (table === 'houseboats') d.name_lc = String(d.name).trim().toLowerCase();
  if (table === 'bookings' && (!d.sender || !String(d.sender).trim() || /^(not provided|not specified|unspecified|unknown|n\/a|na|none|null|-)$/i.test(String(d.sender).trim()))) d.sender = NO_SENDER;
  if (table === 'booking_rooms') d.token = String(d.token).toUpperCase();
  if (table === 'room_night_locks') d._id = `${d.houseboat_id}:${d.room_no}:${d.stay_date}`;
  if (table === 'pending_actions') d._id = d.token;
  return d;
}

// sqlite: an open node:sqlite database (already upgraded to the last SQLite version). store: an open MongoDB store.
export async function copySqliteToMongo(sqlite, store, { log = () => {} } = {}) {
  const have = await store.c('owners').count({});
  if (have) throw new Error(`MongoDB already has ${have} account(s). The copy only goes into an empty database, so nothing gets mixed. Use a new database name (MONGODB_DB) or empty this one first.`);
  const tables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  const counts = {};
  try {
    for (const t of TABLES) {
      if (!tables.has(t)) { counts[t] = 0; continue; }
      const rows = sqlite.prepare(`SELECT * FROM ${t}`).all().map((r) => convert(t, r));
      for (let i = 0; i < rows.length; i += 500) {
        const part = rows.slice(i, i + 500);
        if (store.db.collection(t).insertMany) await store.db.collection(t).insertMany(part, { ordered: true });
        else for (const d of part) await store.db.collection(t).insertOne(d);
      }
      counts[t] = rows.length;
      if (INT_ID.has(t) && rows.length) await store.bumpCounter(t, Math.max(...rows.map((r) => r.id)));
      log(`  ${t}: ${rows.length}`);
    }
    // check: every row arrived
    for (const t of TABLES) {
      const n = await store.db.collection(t).countDocuments({});
      if (n !== counts[t]) throw new Error(`${t}: copied ${n} of ${counts[t]} rows`);
    }
  } catch (e) {
    // the database was empty before, so remove the half-copied data and leave it clean
    for (const t of TABLES) await store.db.collection(t).deleteMany({});
    await store.db.collection('counters').deleteMany({});
    throw e;
  }
  return counts;
}

async function main() {
  loadEnv();
  const cfg = getConfig();
  const file = process.argv[2] || 'data/boathouse.db';
  if (!fs.existsSync(file)) { console.error(`No SQLite file at ${file}. Pass the path: npm run migrate-to-mongo -- path/to/boathouse.db`); process.exit(1); }
  // work on a temporary copy, so the original file is never touched (old-format files get upgraded in the copy)
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bh-copy-')), 'copy.db');
  fs.copyFileSync(file, tmp);
  const { openDb } = await import('./sqlite-old.js');
  const sqlite = openDb(tmp);
  const store = await storeFromConfig(cfg);
  console.log(`Copying ${file} into MongoDB...`);
  try {
    const counts = await copySqliteToMongo(sqlite, store, { log: console.log });
    console.log(`Done. ${counts.owners} account(s), ${counts.bookings} booking(s) and ${counts.ledger} money entr${counts.ledger === 1 ? 'y' : 'ies'} are now in MongoDB.`);
    console.log('Keep data/boathouse.db as a backup until you have checked the app.');
  } catch (e) {
    console.error(`Nothing was copied: ${e.message}`);
    process.exitCode = 1;
  } finally {
    sqlite.close();
    await store.close();
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
