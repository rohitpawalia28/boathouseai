// Sets a new password for an owner (for example when they forgot it). It also signs them out everywhere.
// Usage:  npm run reset-password -- owner@email.com
import { loadEnv, getConfig } from './env.js';
import { openDb } from './db.js';
import { hashPassword } from './auth.js';
import { prompter } from './owner-cli.js';

loadEnv();
const cfg = getConfig();
const db = openDb(cfg.dbFile);
const { ask, askHidden, close } = prompter();
const email = (process.argv[2] || (await ask('Owner email: '))).trim().toLowerCase();
const o = db.prepare('SELECT id, name FROM owners WHERE email = ?').get(email);
if (!o) { console.error(`No owner with the email ${email}.`); process.exit(1); }
const pw = await askHidden('New password (at least 8 characters): ');
if (pw.length < 8) { console.error('The password must be at least 8 characters.'); process.exit(1); }
const again = await askHidden('Type it again: ');
if (pw !== again) { console.error('The two passwords are not the same. Nothing was changed.'); process.exit(1); }
db.prepare('UPDATE owners SET password_hash = ?, session_version = session_version + 1 WHERE id = ?').run(await hashPassword(pw), o.id);
db.prepare('INSERT INTO audit_log(owner_id, action, detail) VALUES(?,?,?)').run(o.id, 'reset_password', '{}');
console.log(`Done. The password for ${o.name} (${email}) was changed.`);
close();
