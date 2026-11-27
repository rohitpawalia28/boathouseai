// Creates an owner account (there is no sign-up on the website).
// Usage:  npm run add-owner
//    or:  npm run add-owner -- "Owner Name" owner@email.com
// The password is asked for on the screen and is never shown or saved anywhere except as a scrypt hash.
import { loadEnv, getConfig } from './env.js';
import { openDb } from './db.js';
import { hashPassword } from './auth.js';
import { prompter } from './owner-cli.js';

loadEnv();
const cfg = getConfig();
const db = openDb(cfg.dbFile);
const { ask, askHidden, close } = prompter();
const [argName, argEmail] = process.argv.slice(2);
const name = (argName || (await ask('Owner name: '))).trim();
const email = (argEmail || (await ask('Email (used to log in): '))).trim().toLowerCase();
if (name.length < 2) { console.error('The name needs at least 2 letters.'); process.exit(1); }
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('That email does not look right.'); process.exit(1); }
if (db.prepare('SELECT 1 FROM owners WHERE email = ?').get(email)) { console.error(`${email} already has an account. To change its password run: npm run reset-password -- ${email}`); process.exit(1); }
const pw = await askHidden('Password (at least 8 characters): ');
if (pw.length < 8) { console.error('The password must be at least 8 characters.'); process.exit(1); }
const again = await askHidden('Type the password again: ');
if (pw !== again) { console.error('The two passwords are not the same. Nothing was saved.'); process.exit(1); }
db.prepare('INSERT INTO owners(name, email, password_hash) VALUES(?,?,?)').run(name, email, await hashPassword(pw));
console.log(`Done. ${name} can now log in with ${email}.`);
close();
