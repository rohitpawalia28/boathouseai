import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 6;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owners(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','admin')),   -- 'admin' = the BoatHouse admin (no houseboat data, manages the customers)
  plan TEXT NOT NULL DEFAULT 'full' CHECK(plan IN ('trial','full')),     -- 'trial' accounts lock by themselves at trial_ends_at
  trial_ends_at TEXT,                                                    -- ISO time (UTC); only used when plan = 'trial'
  locked INTEGER NOT NULL DEFAULT 0,                                     -- 1 = locked by the admin
  gemini_key_enc TEXT,                                                   -- this customer's own Gemini API key, encrypted (see secretbox.js)
  ai_calls INTEGER NOT NULL DEFAULT 0,                                   -- how many AI requests this customer has used
  last_login_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Houseboats are just names the owner books rooms with (his own or partners'). No inventory is kept.
CREATE TABLE IF NOT EXISTS houseboats(
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  is_own INTEGER NOT NULL DEFAULT 0,
  total_rooms INTEGER,   -- optional: how many rooms the houseboat has (room numbers stay within it)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner_id, name COLLATE NOCASE),
  UNIQUE(owner_id, prefix)
);
CREATE TABLE IF NOT EXISTS bookings(
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id),
  client_name TEXT NOT NULL,
  phone TEXT,
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT,
  sender TEXT,            -- who sent / brought the booking (agent, company, person or "Direct"). Compulsory for new bookings (see triggers).
  rooms_required INTEGER  -- optional: how many rooms the client asked for in total (some may not be allocated yet)
);
-- A new booking can never be saved without a real sender name, even if the application code is bypassed.
CREATE TRIGGER IF NOT EXISTS bookings_sender_required_ins BEFORE INSERT ON bookings
WHEN NEW.sender IS NULL OR TRIM(NEW.sender) = '' OR LOWER(TRIM(NEW.sender)) IN ('not provided','not specified','unspecified','unknown','n/a','na','none','null','-')
BEGIN SELECT RAISE(ABORT, 'sender is required'); END;
CREATE TRIGGER IF NOT EXISTS bookings_sender_required_upd BEFORE UPDATE OF sender ON bookings
WHEN NEW.sender IS NULL OR TRIM(NEW.sender) = '' OR LOWER(TRIM(NEW.sender)) IN ('not provided','not specified','unspecified','unknown','n/a','na','none','null','-')
BEGIN SELECT RAISE(ABORT, 'sender is required'); END;
-- One row per room of a booking. token = first 3 letters of the houseboat + 3-digit room number, e.g. CUL001.
CREATE TABLE IF NOT EXISTS booking_rooms(
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  owner_id INTEGER NOT NULL,
  houseboat_id INTEGER NOT NULL REFERENCES houseboats(id),
  room_no INTEGER NOT NULL,
  token TEXT NOT NULL,
  guests INTEGER,           -- NULL = details pending (owner said "skip")
  meal_plan TEXT CHECK(meal_plan IS NULL OR meal_plan IN ('EP','CP','MAP','AP')),
  price INTEGER,            -- charged to the client, per night. NULL = pending, counted as 0 until set
  cost INTEGER NOT NULL     -- payable to the houseboat, per night (0 for own boats)
);
-- A token can only be used once per night, so two bookings can never share CUL001 on the same night.
CREATE TABLE IF NOT EXISTS room_night_locks(
  houseboat_id INTEGER NOT NULL REFERENCES houseboats(id),
  room_no INTEGER NOT NULL,
  stay_date TEXT NOT NULL,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  owner_id INTEGER NOT NULL,
  UNIQUE(houseboat_id, room_no, stay_date)
);
-- Append-only money ledger. side CLIENT = money between you and the client, PARTNER = between you and a houseboat.
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id),
  booking_id INTEGER REFERENCES bookings(id),
  houseboat_id INTEGER REFERENCES houseboats(id),
  side TEXT NOT NULL CHECK(side IN ('CLIENT','PARTNER')),
  type TEXT NOT NULL CHECK(type IN ('CHARGE','PAYMENT','REFUND','REVERSAL')),
  amount INTEGER NOT NULL,
  method TEXT,
  note TEXT,
  ref_id INTEGER REFERENCES ledger(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
-- The only way to remove money entries is the owner's confirmed "delete all bookings": it opens a short window for that owner.
CREATE TABLE IF NOT EXISTS wipe_window(owner_id INTEGER PRIMARY KEY);
DROP TRIGGER IF EXISTS ledger_no_delete;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger WHEN NOT EXISTS (SELECT 1 FROM wipe_window WHERE owner_id = OLD.owner_id) BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TABLE IF NOT EXISTS conversations(
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id),
  title TEXT NOT NULL DEFAULT 'Chat',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  owner_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Changes proposed by the bot wait here until the owner confirms.
CREATE TABLE IF NOT EXISTS pending_actions(
  token TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  conversation_id INTEGER,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  preview_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','cancelled','expired','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_owner ON bookings(owner_id, check_in);
CREATE INDEX IF NOT EXISTS idx_broom_booking ON booking_rooms(booking_id);
CREATE INDEX IF NOT EXISTS idx_ledger_owner ON ledger(owner_id, booking_id);
CREATE INDEX IF NOT EXISTS idx_locks_owner ON room_night_locks(owner_id, stay_date);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
`;

// Version 1 (properties/rooms inventory) was replaced by houseboats + room tokens. Old test data is dropped, owner accounts are kept.
function migrate(db) {
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v >= SCHEMA_VERSION) return;
  const hasOld = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='properties'").get();
  if (hasOld || v < 2) {
    db.exec('PRAGMA foreign_keys = OFF;');
    for (const t of ['properties', 'rooms', 'booking_rooms', 'room_night_locks', 'ledger', 'bookings', 'pending_actions', 'messages', 'conversations', 'audit_log']) {
      db.exec(`DROP TABLE IF EXISTS ${t};`);
    }
    db.exec('PRAGMA foreign_keys = ON;');
  }
  // Version 5: owners.session_version (one login at a time: a new login or password change signs the other devices out).
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owners'").get() && !db.prepare('PRAGMA table_info(owners)').all().some((c) => c.name === 'session_version')) db.exec('ALTER TABLE owners ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;');
  // Version 6: admin role, trial lock and each customer's own AI key. Accounts that already exist stay normal, non-expiring owners.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owners'").get()) {
    const have = db.prepare('PRAGMA table_info(owners)').all().map((c) => c.name);
    const add = [
      ['role', "TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','admin'))"],
      ['plan', "TEXT NOT NULL DEFAULT 'full' CHECK(plan IN ('trial','full'))"],
      ['trial_ends_at', 'TEXT'], ['locked', 'INTEGER NOT NULL DEFAULT 0'], ['gemini_key_enc', 'TEXT'],
      ['ai_calls', 'INTEGER NOT NULL DEFAULT 0'], ['last_login_at', 'TEXT'], ['note', 'TEXT'],
    ];
    for (const [col, def] of add) if (!have.includes(col)) db.exec(`ALTER TABLE owners ADD COLUMN ${col} ${def};`);
  }
  // Version 3 adds houseboats.total_rooms (keeps all data).
  const hb = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='houseboats'").get();
  if (hb && !db.prepare('PRAGMA table_info(houseboats)').all().some((c) => c.name === 'total_rooms')) db.exec('ALTER TABLE houseboats ADD COLUMN total_rooms INTEGER;');
  // Version 4: bookings.sender + bookings.rooms_required; booking_rooms.guests/meal_plan/price become optional (SQLite needs a table rebuild for that).
  const bk = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bookings'").get();
  if (bk) {
    const cols = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
    if (!cols.includes('sender')) db.exec('ALTER TABLE bookings ADD COLUMN sender TEXT;');
    if (!cols.includes('rooms_required')) db.exec('ALTER TABLE bookings ADD COLUMN rooms_required INTEGER;');
  }
  const br = db.prepare('PRAGMA table_info(booking_rooms)').all();
  if (br.length && br.find((c) => c.name === 'guests')?.notnull) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`BEGIN;
      CREATE TABLE booking_rooms_v4(
        id INTEGER PRIMARY KEY,
        booking_id INTEGER NOT NULL REFERENCES bookings(id),
        owner_id INTEGER NOT NULL,
        houseboat_id INTEGER NOT NULL REFERENCES houseboats(id),
        room_no INTEGER NOT NULL,
        token TEXT NOT NULL,
        guests INTEGER,
        meal_plan TEXT CHECK(meal_plan IS NULL OR meal_plan IN ('EP','CP','MAP','AP')),
        price INTEGER,
        cost INTEGER NOT NULL
      );
      INSERT INTO booking_rooms_v4 SELECT id, booking_id, owner_id, houseboat_id, room_no, token, guests, meal_plan, price, cost FROM booking_rooms;
      DROP TABLE booking_rooms;
      ALTER TABLE booking_rooms_v4 RENAME TO booking_rooms;
      COMMIT;`);
    db.exec('PRAGMA foreign_keys = ON;');
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  db.exec(SCHEMA);
  return db;
}

// Runs fn inside one atomic transaction (write lock taken immediately).
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}
