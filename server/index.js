import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { loadEnv, getConfig } from './env.js';
import { openDb } from './db.js';
import { hashPassword, verifyPassword, signToken, verifyToken, makeLimiter } from './auth.js';
import { geminiProvider } from './ai.js';
import { seal, open as openSecret } from './secretbox.js';
import { handleChat, createPending, resolvePending, loadHistory, clearHistory, saveMessage, mainConversation } from './chat.js';
import { ToolError, addHouseboat, prepareWriteTool, dashboardSummary, calendarGrid, moneyOverview, bookingRows, houseboatRows, recentLedger, reportData, peopleSummary, availability } from './tools.js';
import { todayStr, isDate } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

export function createApp(overrides = {}) {
  const cfg = getConfig(overrides);
  const db = openDb(cfg.dbFile);
  const provider = overrides.provider !== undefined ? overrides.provider : cfg.geminiKey ? geminiProvider({ apiKey: cfg.geminiKey, model: cfg.geminiModel }) : null;
  const authLimiter = makeLimiter(20, 10 * 60 * 1000);
  const emailLimiter = makeLimiter(10, 15 * 60 * 1000); // per account, so many IPs together cannot guess one password
  const chatLimiter = makeLimiter(overrides.chatPerMinute || 40, 60 * 1000); // per owner: protects their Gemini key from being burned
  const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex')); // makes "unknown email" take as long as "wrong password"
  const routes = [];
  // role: 'owner' (a boat owner, default), 'admin' (the BoatHouse admin) or 'any'
  const route = (method, pattern, handler, { auth = true, maxBody = 100_000, role = 'owner' } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth, maxBody, role });
  };

  const ctxFor = (owner) => ({ db, ownerId: owner.id, ownerName: owner.name, tz: cfg.tz });
  const tokenFor = (o) => signToken({ sub: o.id, sv: o.session_version ?? 0 }, cfg.secret);
  /* ---------------- trial lock, admin and each customer's own AI key ---------------- */
  const nowMs = () => (overrides.now ? overrides.now() : Date.now()); // tests can move the clock
  const makeProvider = overrides.providerFactory || ((key) => geminiProvider({ apiKey: key, model: cfg.geminiModel }));
  const providerCache = new Map(); // owner id -> { enc, provider }
  const bumpAi = db.prepare('UPDATE owners SET ai_calls = ai_calls + 1 WHERE id = ?');
  const counted = (p, id) => p && { name: p.name, generate: (a) => { bumpAi.run(id); return p.generate(a); }, ...(p.transcribe ? { transcribe: (a) => { bumpAi.run(id); return p.transcribe(a); } } : {}) };
  // Every customer's AI work goes through THEIR OWN Gemini key, so no single key carries everybody.
  // With no key of their own they use the shared server key (GEMINI_API_KEY), if there is one.
  const rawProviderFor = (o) => {
    if (o.gemini_key_enc) {
      const hit = providerCache.get(o.id);
      if (hit && hit.enc === o.gemini_key_enc) return hit.provider;
      const key = openSecret(o.gemini_key_enc, cfg.secret);
      if (!key) return null; // unreadable (the server secret changed): never quietly fall back to the shared key
      const p = makeProvider(key);
      providerCache.set(o.id, { enc: o.gemini_key_enc, provider: p });
      return p;
    }
    providerCache.delete(o.id);
    return provider;
  };
  const providerFor = (o) => counted(rawProviderFor(o), o.id);

  // Can this account use the app right now? The admin always can. A trial account stops exactly when its trial time is over.
  const accessOf = (o) => {
    if (o.role === 'admin') return { state: 'ok' };
    if (o.locked) return { state: 'locked' };
    if (o.plan === 'trial') {
      const left = (o.trial_ends_at ? Date.parse(o.trial_ends_at) : 0) - nowMs();
      if (!(left > 0)) return { state: 'expired' };
      return { state: 'ok', trial: { ends_at: o.trial_ends_at, days_left: Math.ceil(left / 86_400_000) } };
    }
    return { state: 'ok' };
  };
  const lockMessage = (a) => `${a.state === 'expired' ? 'Your free trial has ended. Please contact the owner for renewal of this service.' : 'This account is locked. Please contact the owner.'}${cfg.contactInfo ? ` (${cfg.contactInfo})` : ''}`;

  const intParam = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Bad id'); return n; };

  /* ---------------- auth ---------------- */
  route('GET', '/api/config', () => ({ ai: Boolean(provider) }), { auth: false });

  route('POST', '/api/auth/register', async ({ body, ip }) => {
    if (!cfg.allowSignup) throw new HttpError(403, 'Sign-up is closed.');
    if (!authLimiter(ip)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const phone = String(body.phone || '').trim().slice(0, 20) || null;
    if (name.length < 2 || name.length > 80) throw new HttpError(400, 'Please enter your name.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Please enter a valid email.');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (db.prepare('SELECT 1 FROM owners WHERE email = ?').get(email)) throw new HttpError(409, 'This email is already registered.');
    const id = Number(db.prepare('INSERT INTO owners(name, email, phone, password_hash) VALUES(?,?,?,?)').run(name, email, phone, await hashPassword(password)).lastInsertRowid);
    return { token: tokenFor({ id, session_version: 0 }), owner: { id, name, email } };
  }, { auth: false });

  route('POST', '/api/auth/login', async ({ body, ip }) => {
    if (!authLimiter(ip)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
    const password = String(body.password || '');
    if (!email || !password || password.length > 200) throw new HttpError(401, 'Wrong email or password.');
    if (!emailLimiter(email)) throw new HttpError(429, 'Too many attempts for this account. Try again in 15 minutes.');
    const o = db.prepare('SELECT * FROM owners WHERE email = ?').get(email);
    // always run one scrypt check, so the answer time does not tell an attacker which emails exist
    const ok = await verifyPassword(password, o ? o.password_hash : await DUMMY_HASH);
    if (!o || !ok) throw new HttpError(401, 'Wrong email or password.');
    const acc = accessOf(o);
    if (acc.state !== 'ok') throw new HttpError(403, lockMessage(acc), 'LOCKED'); // right password, but the trial is over (or the admin locked it)
    // One login at a time: every earlier login (other phone or browser) stops working now.
    db.prepare('UPDATE owners SET session_version = session_version + 1, last_login_at = ? WHERE id = ?').run(new Date(nowMs()).toISOString(), o.id);
    const fresh = db.prepare('SELECT * FROM owners WHERE id = ?').get(o.id);
    return { token: tokenFor(fresh), owner: { id: fresh.id, name: fresh.name, email: fresh.email, role: fresh.role } };
  }, { auth: false });

  // Change password: checks the current one, stores the new scrypt hash in the database, and signs every other device out.
  route('POST', '/api/auth/change-password', async ({ body, owner, ip }) => {
    if (!authLimiter(`pw:${owner.id}:${ip}`)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const current = String(body.current_password || '');
    const next = String(body.new_password || '');
    const row = db.prepare('SELECT * FROM owners WHERE id = ?').get(owner.id);
    if (!(await verifyPassword(current, row.password_hash))) throw new HttpError(400, 'Your current password is not correct.');
    if (next.length < 8) throw new HttpError(400, 'The new password must be at least 8 characters.');
    if (next.length > 200) throw new HttpError(400, 'The new password is too long.');
    if (next === current) throw new HttpError(400, 'The new password must be different from the current one.');
    db.prepare('UPDATE owners SET password_hash = ?, session_version = session_version + 1 WHERE id = ?').run(await hashPassword(next), owner.id);
    db.prepare('INSERT INTO audit_log(owner_id, action, detail) VALUES(?,?,?)').run(owner.id, 'change_password', '{}');
    const fresh = db.prepare('SELECT * FROM owners WHERE id = ?').get(owner.id);
    return { ok: true, token: tokenFor(fresh) };
  }, { role: 'any' });

  route('GET', '/api/me', ({ owner }) => ({ id: owner.id, name: owner.name, email: owner.email, role: owner.role, ai: owner.role === 'owner' && Boolean(rawProviderFor(owner)), trial: owner.access.trial || null }), { role: 'any' });

  /* ---------------- dashboard (read-only; all changes happen through chat) ---------------- */
  route('GET', '/api/dashboard', ({ ctx }) => dashboardSummary(ctx));

  route('GET', '/api/houseboats', ({ ctx }) => houseboatRows(ctx));

  // The dashboard's "Add houseboat" button. The form itself is the confirmation, so no chat card is needed.
  route('POST', '/api/houseboats', ({ ctx, body }) => addHouseboat(ctx, { name: body.name, total_rooms: body.total_rooms, is_own: body.is_own === true }));

  // Dashboard Delete buttons: build the same confirmation card the chat uses. Nothing is deleted until /api/confirm approves it.
  route('POST', '/api/delete-request', ({ ctx, body }) => {
    const kind = String(body.kind || '');
    let tool; let args;
    if (kind === 'booking') { tool = 'delete_booking'; args = { booking_id: intParam(body.id) }; }
    else if (kind === 'houseboat') {
      const hb = db.prepare('SELECT name FROM houseboats WHERE id = ? AND owner_id = ?').get(intParam(body.id), ctx.ownerId);
      if (!hb) throw new HttpError(404, 'That houseboat was not found.');
      tool = 'delete_houseboat'; args = { houseboat: hb.name };
    } else if (kind === 'all') { tool = 'delete_all_bookings'; args = {}; }
    else if (kind === 'entry') { tool = 'reverse_ledger_entry'; args = { ledger_id: intParam(body.id) }; } // undo a wrong payment / refund
    else throw new HttpError(400, 'Unknown delete request.');
    const prep = prepareWriteTool(ctx, tool, args);
    return createPending(ctx, mainConversation(ctx), tool, prep.args, prep.summary, prep.preview);
  });

  route('GET', '/api/bookings', ({ ctx, query }) => {
    const status = ['confirmed', 'cancelled'].includes(query.status) ? query.status : undefined;
    const f = { status, limit: 100 };
    if (isDate(query.date)) f.date = query.date;
    if (query.client) f.client = String(query.client).slice(0, 80);
    if (query.sender) f.sender = String(query.sender).slice(0, 80);
    if (query.pending === '1') f.pendingOnly = true;
    return bookingRows(ctx, f);
  });

  // Reports tab: revenue for a month (or a date window), split by houseboat and by sender.
  route('GET', '/api/reports', ({ ctx, query }) => {
    const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : (query.from || query.to ? undefined : todayStr(ctx.tz).slice(0, 7));
    return reportData(ctx, { month, from_date: query.from, to_date: query.to });
  });

  // Clients / Senders tab: built automatically from the bookings.
  route('GET', '/api/people', ({ ctx, query }) => ({ kind: query.kind === 'sender' ? 'sender' : 'client', people: peopleSummary(ctx, query.kind === 'sender' ? 'sender' : 'client', String(query.q || '').slice(0, 60)) }));

  route('GET', '/api/availability', ({ ctx, query }) => availability(ctx, isDate(query.date) ? query.date : todayStr(ctx.tz)));

  route('GET', '/api/calendar', ({ ctx, query }) => {
    const from = isDate(query.from) ? query.from : todayStr(ctx.tz);
    return calendarGrid(ctx, from, Number(query.days) || 14);
  });

  route('GET', '/api/balance', ({ ctx }) => ({ ...moneyOverview(ctx), ledger: recentLedger(ctx, 15) }));

  /* ---------------- chat (one running chat per owner) ---------------- */
  route('GET', '/api/history', ({ ctx }) => ({ messages: loadHistory(ctx) }));

  route('DELETE', '/api/history', ({ ctx }) => { clearHistory(ctx); return { ok: true }; });

  route('POST', '/api/chat', async ({ ctx, owner, body }) => {
    if (!chatLimiter(`o${ctx.ownerId}`)) throw new HttpError(429, 'Too many messages in one minute. Please wait a little.');
    return handleChat(ctx, providerFor(owner), body.message);
  });

  // AI voice clean-up: the browser sends the recorded voice (16 kHz WAV) and gets Hinglish text back.
  const voiceLimiter = makeLimiter(30, 60 * 1000);
  route('POST', '/api/transcribe', async ({ ctx, owner, body }) => {
    const provider = providerFor(owner);
    if (!provider?.transcribe) throw new HttpError(503, 'AI voice is not available for this account yet. Please contact the owner.');
    if (!voiceLimiter(`o${ctx.ownerId}`)) throw new HttpError(429, 'Too many voice requests. Wait a minute.');
    const data = String(body.audio || '');
    if (body.mime !== 'audio/wav' || !/^[A-Za-z0-9+/=]+$/.test(data) || data.length < 200) throw new HttpError(400, 'Bad audio.');
    const hints = db.prepare('SELECT name FROM houseboats WHERE owner_id = ? ORDER BY name LIMIT 40').all(ctx.ownerId).map((r) => r.name);
    try {
      const text = await provider.transcribe({ audioBase64: data, mime: 'audio/wav', hints });
      return { text: String(text || '').slice(0, 2000) };
    } catch (e) {
      console.error('[ai voice]', e.status || '', e.detail || e.message);
      throw new HttpError(e.status === 429 ? 429 : 502, e.status === 429 ? 'The free AI limit is reached for now.' : 'Could not improve the voice text right now.');
    }
  }, { maxBody: 8_000_000 });

  route('POST', '/api/confirm', ({ ctx, body }) => {
    const token = String(body.token || '');
    const r = resolvePending(ctx, token, body.approve !== false);
    if (r.conversationId) saveMessage(ctx, mainConversation(ctx), 'assistant', r.message, { resolved: token, status: r.status });
    return { status: r.status, message: r.message, changed: r.changed };
  });

  /* ---------------- admin dashboard: the BoatHouse admin manages the customers (boat owners) ---------------- */
  const adminOnly = { role: 'admin' };
  const customer = (id) => {
    const o = db.prepare("SELECT * FROM owners WHERE id = ? AND role = 'owner'").get(id);
    if (!o) throw new HttpError(404, 'That customer was not found.');
    return o;
  };
  const audit = (adminId, customerId, action, extra = {}) => db.prepare('INSERT INTO audit_log(owner_id, action, detail) VALUES(?,?,?)').run(customerId, action, JSON.stringify({ by: adminId, ...extra }));
  const countOf = (table, id) => db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE owner_id = ?`).get(id).c;
  // What the admin screen may see. Passwords and API keys never leave the server (only the last 4 characters of a key).
  const adminView = (o) => {
    const acc = accessOf(o);
    let ai = provider ? 'shared' : 'none'; let hint = null;
    if (o.gemini_key_enc) { const k = openSecret(o.gemini_key_enc, cfg.secret); ai = k ? 'own' : 'unreadable'; hint = k ? `...${k.slice(-4)}` : null; }
    return {
      id: o.id, name: o.name, email: o.email, phone: o.phone, note: o.note, plan: o.plan, locked: Boolean(o.locked),
      status: o.locked ? 'locked' : o.plan === 'trial' ? (acc.state === 'ok' ? 'trial' : 'expired') : 'full',
      trial_ends_at: o.plan === 'trial' ? o.trial_ends_at : null, days_left: acc.trial ? acc.trial.days_left : o.plan === 'trial' ? 0 : null,
      created_at: o.created_at, last_login_at: o.last_login_at, ai, ai_hint: hint, ai_calls: o.ai_calls,
      houseboats: countOf('houseboats', o.id), bookings: countOf('bookings', o.id),
    };
  };
  const PASS_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike letters (l, I, 1, O, 0)
  const newPassword = () => Array.from({ length: 12 }, () => PASS_CHARS[crypto.randomInt(PASS_CHARS.length)]).join('');
  // Typed password (8+ characters) or, when left empty, a fresh one the admin can hand over.
  const passwordFrom = (typed) => {
    const t = String(typed ?? '');
    if (!t) return { password: newPassword(), generated: true };
    if (t.length < 8 || t.length > 200) throw new HttpError(400, 'The password must be 8 to 200 characters. Leave it empty to make one automatically.');
    return { password: t, generated: false };
  };
  const keyFrom = (k) => {
    const t = String(k ?? '').trim();
    if (t && !/^[A-Za-z0-9_-]{20,120}$/.test(t)) throw new HttpError(400, 'That does not look like a Gemini API key. It is one long line of letters and numbers (it usually starts with AIza).');
    return t;
  };
  const daysFrom = (v, fallback) => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 365) throw new HttpError(400, 'Days must be a whole number from 1 to 365.');
    return n;
  };

  route('GET', '/api/admin/owners', () => {
    const list = db.prepare("SELECT * FROM owners WHERE role = 'owner' ORDER BY id DESC").all().map(adminView);
    return { owners: list, shared_ai: Boolean(provider), contact_info: cfg.contactInfo };
  }, adminOnly);

  route('POST', '/api/admin/owners', async ({ owner, body }) => {
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim().slice(0, 20) || null;
    const note = String(body.note || '').trim().slice(0, 200) || null;
    if (name.length < 2 || name.length > 80) throw new HttpError(400, 'Please enter the name (at least 2 letters).');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Please enter a valid email.');
    if (db.prepare('SELECT 1 FROM owners WHERE email = ?').get(email)) throw new HttpError(409, 'This email already has an account.');
    const pw = passwordFrom(body.password);
    const key = keyFrom(body.gemini_key);
    const full = body.plan === 'full';
    const days = daysFrom(body.trial_days, 10);
    const ends = full ? null : new Date(nowMs() + days * 86_400_000).toISOString(); // exactly N x 24 hours from this moment
    const id = Number(db.prepare('INSERT INTO owners(name, email, phone, note, password_hash, plan, trial_ends_at, gemini_key_enc) VALUES(?,?,?,?,?,?,?,?)')
      .run(name, email, phone, note, await hashPassword(pw.password), full ? 'full' : 'trial', ends, key ? seal(key, cfg.secret) : null).lastInsertRowid);
    audit(owner.id, id, 'admin_create_owner', { plan: full ? 'full' : 'trial', days: full ? null : days, own_ai_key: Boolean(key) });
    return { owner: adminView(customer(id)), password: pw.generated ? pw.password : null };
  }, adminOnly);

  // extend = more trial days (also brings back an ended trial) | make_full = renewed / paid, no end date | lock | unlock
  route('POST', '/api/admin/owners/:id/access', ({ owner, params, body }) => {
    const o = customer(intParam(params.id));
    const action = String(body.action || '');
    if (action === 'extend') {
      const days = daysFrom(body.days, 10);
      const base = Math.max(nowMs(), o.plan === 'trial' && o.trial_ends_at ? Date.parse(o.trial_ends_at) : 0);
      db.prepare("UPDATE owners SET plan = 'trial', trial_ends_at = ?, locked = 0 WHERE id = ?").run(new Date(base + days * 86_400_000).toISOString(), o.id);
      audit(owner.id, o.id, 'admin_extend', { days });
    } else if (action === 'make_full') {
      db.prepare("UPDATE owners SET plan = 'full', trial_ends_at = NULL, locked = 0 WHERE id = ?").run(o.id);
      audit(owner.id, o.id, 'admin_make_full');
    } else if (action === 'lock' || action === 'unlock') {
      db.prepare('UPDATE owners SET locked = ? WHERE id = ?').run(action === 'lock' ? 1 : 0, o.id);
      audit(owner.id, o.id, `admin_${action}`);
    } else throw new HttpError(400, 'Unknown action.');
    return { owner: adminView(customer(o.id)) };
  }, adminOnly);

  route('POST', '/api/admin/owners/:id/password', async ({ owner, params, body }) => {
    const o = customer(intParam(params.id));
    const pw = passwordFrom(body.password);
    // a new password also signs the customer out everywhere
    db.prepare('UPDATE owners SET password_hash = ?, session_version = session_version + 1 WHERE id = ?').run(await hashPassword(pw.password), o.id);
    audit(owner.id, o.id, 'admin_reset_password');
    return { owner: adminView(customer(o.id)), password: pw.generated ? pw.password : null };
  }, adminOnly);

  // The customer's own Gemini key (empty = remove it). It is stored encrypted and is never shown again.
  route('POST', '/api/admin/owners/:id/ai-key', ({ owner, params, body }) => {
    const o = customer(intParam(params.id));
    const key = keyFrom(body.key);
    db.prepare('UPDATE owners SET gemini_key_enc = ? WHERE id = ?').run(key ? seal(key, cfg.secret) : null, o.id);
    providerCache.delete(o.id);
    audit(owner.id, o.id, key ? 'admin_set_ai_key' : 'admin_remove_ai_key');
    return { owner: adminView(customer(o.id)) };
  }, adminOnly);

  // Sends one tiny message to Gemini with this customer's key, to prove the key works.
  route('POST', '/api/admin/owners/:id/ai-test', async ({ params }) => {
    const o = customer(intParam(params.id));
    const p = rawProviderFor(o);
    if (!p) return { ok: false, error: o.gemini_key_enc ? 'The saved key cannot be read any more. Save it again.' : 'No AI key is set for this customer, and there is no shared server key.' };
    try {
      const out = await p.generate({ system: 'Reply with the single word OK.', contents: [{ role: 'user', parts: [{ text: 'ping' }] }], tools: [] });
      return { ok: true, source: o.gemini_key_enc ? 'own' : 'shared', answer: String(out.text || '').slice(0, 40) };
    } catch (e) {
      return { ok: false, error: e.status ? `Gemini said HTTP ${e.status}: ${String(e.detail || e.message).replace(/\s+/g, ' ').slice(0, 200)}` : `Could not reach Gemini: ${String(e.message || e).slice(0, 150)}` };
    }
  }, adminOnly);

  // A full copy of one customer's data (plain JSON). Use it before renewal / moving them to their own database.
  route('GET', '/api/admin/owners/:id/backup', ({ owner, params }) => {
    const o = customer(intParam(params.id));
    const rows = (t) => db.prepare(`SELECT * FROM ${t} WHERE owner_id = ?`).all(o.id);
    audit(owner.id, o.id, 'admin_backup');
    return {
      app: 'BoatHouse AI', format: 1, exported_at: new Date(nowMs()).toISOString(),
      owner: { id: o.id, name: o.name, email: o.email, phone: o.phone },
      houseboats: rows('houseboats'), bookings: rows('bookings'), booking_rooms: rows('booking_rooms'), room_night_locks: rows('room_night_locks'), ledger: rows('ledger'),
    };
  }, adminOnly);

  /* ---------------- http plumbing ---------------- */
  const corsHeaders = (req) => {
    const origin = req.headers.origin;
    if (origin && cfg.corsOrigins.includes(origin)) {
      return { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', vary: 'Origin' };
    }
    return {};
  };
  const baseHeaders = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'content-security-policy': `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' ${cfg.corsOrigins.join(' ')}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.replace(/\s+/g, ' '),
    'permissions-policy': 'microphone=(self), camera=(), geolocation=(), payment=(), usb=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  };
  // Browsers must keep using HTTPS for a year once they saw the site over HTTPS (not sent on plain http://localhost).
  const isHttps = (req) => req.socket.encrypted || (cfg.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
  const secHeaders = (req) => (isHttps(req) ? { ...baseHeaders, 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : baseHeaders);
  // Real visitor IP. Behind a proxy every visitor looks like the proxy, so login limits would hit everyone together.
  const clientIp = (req) => {
    if (cfg.trustProxy) {
      const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1]; // the hop added by our own proxy; earlier ones can be faked
    }
    return req.socket.remoteAddress || 'x';
  };

  const sendJson = (req, res, status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...secHeaders(req), ...corsHeaders(req) });
    res.end(JSON.stringify(obj));
  };

  const readBody = (req, limit = 100_000) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });

  const serveStatic = (req, res, pathname) => {
    let rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    let file = path.normalize(path.join(PUBLIC_DIR, rel));
    // stay inside public/ (path.sep stops "public-other/") and never serve hidden files like .env
    if (!file.startsWith(PUBLIC_DIR + path.sep) || rel.split(/[\\/]/).some((part) => part.startsWith('.'))) { res.writeHead(404, baseHeaders); return res.end(); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', ...secHeaders(req) });
    fs.createReadStream(file).pipe(res);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'OPTIONS') { res.writeHead(204, { ...corsHeaders(req), ...secHeaders(req) }); return res.end(); }
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, baseHeaders); return res.end(); }
        return serveStatic(req, res, url.pathname);
      }
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw new HttpError(404, 'Not found');
      const m = url.pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let owner = null; let ctx = null;
      if (r.auth) {
        const auth = req.headers.authorization || '';
        const claims = auth.startsWith('Bearer ') ? verifyToken(auth.slice(7), cfg.secret) : null;
        owner = claims ? db.prepare('SELECT id, name, email, session_version, role, plan, trial_ends_at, locked, gemini_key_enc FROM owners WHERE id = ?').get(claims.sub) : null;
        if (!owner) throw new HttpError(401, 'Please log in again.');
        if ((claims.sv ?? 0) !== owner.session_version) throw new HttpError(401, 'You were signed out because this account was opened on another device. Please log in again.');
        owner.access = accessOf(owner);
        if (owner.access.state !== 'ok') throw new HttpError(403, lockMessage(owner.access), 'LOCKED'); // trial over: nothing works until the admin renews it
        if (r.role === 'admin' && owner.role !== 'admin') throw new HttpError(403, 'This page is for the BoatHouse admin only.');
        if (r.role === 'owner' && owner.role === 'admin') throw new HttpError(403, 'The admin account has no houseboat data. Use the Admin dashboard.');
        ctx = ctxFor(owner);
      }
      const body = req.method === 'POST' ? await readBody(req, r.maxBody) : {};
      const out = await r.handler({ req, params, query: Object.fromEntries(url.searchParams), body, owner, ctx, ip: clientIp(req) });
      sendJson(req, res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(req, res, e.status, { error: e.message, ...(e.code ? { code: e.code } : {}) });
      if (e instanceof ToolError) return sendJson(req, res, 400, { error: e.message });
      console.error(e);
      sendJson(req, res, 500, { error: 'Something went wrong on the server.' });
    }
  });

  return { server, db, cfg, provider };
}

// Start when run directly: `npm start`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv();
  const { server, cfg, provider } = createApp();
  server.listen(cfg.port, () => {
    console.log(`BoatHouse AI running at http://localhost:${cfg.port}`);
    console.log(provider ? `AI: Gemini (${cfg.geminiModel})` : 'AI: not connected (simple mode). Add GEMINI_API_KEY to .env to enable the chatbot.');
  });
}
