// Sets a new password for an owner (for example when they forgot it). It also signs them out everywhere.
// Usage:  npm run reset-password -- owner@email.com
import { loadEnv, getConfig } from './env.js';
import { storeFromConfig } from './store.js';
import { hashPassword } from './auth.js';
import { prompter } from './owner-cli.js';

loadEnv();
const cfg = getConfig();
const store = await storeFromConfig(cfg);
const owners = store.c('owners');
const { ask, askHidden, close } = prompter();
const email = (process.argv[2] || (await ask('Owner email: '))).trim().toLowerCase();
const o = await owners.one({ email });
if (!o) { console.error(`No owner with the email ${email}.`); process.exit(1); }
const pw = await askHidden('New password (at least 8 characters): ');
if (pw.length < 8) { console.error('The password must be at least 8 characters.'); process.exit(1); }
const again = await askHidden('Type it again: ');
if (pw !== again) { console.error('The two passwords are not the same. Nothing was changed.'); process.exit(1); }
await owners.update({ id: o.id }, { $set: { password_hash: await hashPassword(pw) }, $inc: { session_version: 1 } });
await store.c('audit_log').insert({ owner_id: o.id, action: 'reset_password', detail: '{}' });
console.log(`Done. The password for ${o.name} (${email}) was changed.`);
close();
await store.close();
