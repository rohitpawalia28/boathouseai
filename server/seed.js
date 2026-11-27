// Creates a demo owner with sample data so you can look around without typing everything.
// Usage: npm run seed   ->  login demo@boathouse.local / demo12345
import { loadEnv, getConfig } from './env.js';
import { openDb } from './db.js';
import { hashPassword } from './auth.js';
import { prepareWriteTool, executeWrite, addHouseboat } from './tools.js';
import { addDays, todayStr } from './util.js';

loadEnv();
// The demo login has a public password, so it must never exist on the live server.
if (process.env.NODE_ENV === 'production') { console.error('npm run seed is only for your own computer (the demo password is public). Not run.'); process.exit(1); }
const cfg = getConfig();
const db = openDb(cfg.dbFile);
const email = 'demo@boathouse.local';
if (db.prepare('SELECT 1 FROM owners WHERE email = ?').get(email)) {
  console.log('Demo owner already exists. Log in with demo@boathouse.local / demo12345');
  process.exit(0);
}
const id = Number(db.prepare('INSERT INTO owners(name, email, password_hash) VALUES(?,?,?)').run('Demo Owner', email, await hashPassword('demo12345')).lastInsertRowid);
const ctx = { db, ownerId: id, ownerName: 'Demo Owner', tz: cfg.tz };
const today = todayStr(cfg.tz);
addHouseboat(ctx, { name: 'Sunrise', total_rooms: 5, is_own: true });
addHouseboat(ctx, { name: 'Chinar', total_rooms: 5 });
addHouseboat(ctx, { name: 'Cultural Palace', total_rooms: 4 });
const rooms = (boat, n, price, plan, guests, own = false) => Array.from({ length: n }, (_, i) => ({ houseboat: boat, own, guests: Array.isArray(guests) ? guests[i] : guests, price, meal_plan: plan }));
const steps = [
  ['create_booking', {
    client_name: 'Sharma Family', sender: 'Direct', phone: '9876500001', check_in: addDays(today, 1), check_out: addDays(today, 3), advance_paid: 8000,
    rooms: [...rooms('Sunrise', 4, 3000, 'CP', [2, 2, 3, 2], true), ...rooms('Chinar', 2, 5000, 'MAP', [2, 3]), ...rooms('Cultural Palace', 2, 4000, 'AP', [3, 2]), ],
  }],
  ['create_booking', {
    client_name: 'ABC Travels', sender: 'ABC Travels', check_in: addDays(today, 5), check_out: addDays(today, 6), advance_paid: 5000,
    rooms: [...rooms('Chinar', 2, 5500, 'CP', 2), ...rooms('Sunrise', 1, 3500, 'EP', 2, true)],
  }],
  ['create_booking', {
    client_name: 'Mehta Group', sender: 'Blue Lake Agency', check_in: addDays(today, 8), check_out: addDays(today, 10), rooms_required: 6, advance_paid: 0,
    rooms: [...rooms('Chinar', 2, 4800, 'MAP', 2), { houseboat: 'Cultural Palace' }, { houseboat: 'Cultural Palace' }],
  }],
];
for (const [tool, args] of steps) {
  const prep = prepareWriteTool(ctx, tool, args);
  console.log('-', executeWrite(ctx, tool, prep.args).message);
}
console.log('\nDemo ready. Log in with demo@boathouse.local / demo12345');
