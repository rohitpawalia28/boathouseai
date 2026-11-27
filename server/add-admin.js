// Creates the BoatHouse ADMIN account: the one login that opens the Admin dashboard
// (create boat-owner accounts, 10-day trials, each customer's Gemini key, renewals).
// Usage:  npm run add-admin
//    or:  npm run add-admin -- "Your Name" you@email.com
// The password is asked for on the screen, is never shown, and is saved only as a scrypt hash.
import { loadEnv, getConfig } from './env.js';
import { openDb } from './db.js';
import { hashPassword } from './auth.js';
import { prompter } from './owner-cli.js';

loadEnv();
const cfg = getConfig();
const db = openDb(cfg.dbFile);
const { ask, askHidden, close } = prompter();
const [argName, argEmail] = process.argv.slice(2);
const name = (argName || (await ask('Admin name: '))).trim();
const email = (argEmail || (await ask('Admin email (used to log in): '))).trim().toLowerCase();
if (name.length < 2) { console.error('The name needs at least 2 letters.'); process.exit(1); }
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('That email does not look right.'); process.exit(1); }
const old = db.prepare('SELECT id, role FROM owners WHERE email = ?').get(email);
if (old?.role === 'admin') { console.error(`${email} is already an admin. To change its password run: npm run reset-password -- ${email}`); process.exit(1); }
if (old) {
  // An email that already runs a boat-owner account (maybe your own test account) cannot be both.
  console.error(`${email} already has a boat-owner account (with its own houseboats and bookings).`);
  console.error('An admin account has no houseboat data, so use another email for the admin, for example a +name address:');
  console.error(`  npm run add-admin -- "${name}" ${email.replace('@', '+admin@')}`);
  console.error('(Gmail delivers name+admin@gmail.com to the same inbox.)');
  process.exit(1);
}
const pw = await askHidden('Password (at least 8 characters): ');
if (pw.length < 8) { console.error('The password must be at least 8 characters.'); process.exit(1); }
const again = await askHidden('Type the password again: ');
if (pw !== again) { console.error('The two passwords are not the same. Nothing was saved.'); process.exit(1); }
db.prepare("INSERT INTO owners(name, email, password_hash, role, plan) VALUES(?,?,?,'admin','full')").run(name, email, await hashPassword(pw));
console.log(`Done. ${name} can log in as admin with ${email}.`);
close();
