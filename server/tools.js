import { isDate, addDays, nightsBetween, inr, todayStr, prettyDate } from './util.js';
import { DuplicateError } from './store.js';

export class ToolError extends Error {
  // askOwner: the owner must answer something (like the sender) before the tool can work. The chat shows the question and stops.
  constructor(message, { askOwner = false } = {}) { super(message); this.askOwner = askOwner; }
}

const MEAL_PLANS = ['EP', 'CP', 'MAP', 'AP'];
// People say MAPI / CPI / EPI (Hindi-style "MAP-I"). They mean the same plans.
const MEAL_ALIASES = { EPI: 'EP', CPI: 'CP', MAPI: 'MAP', API: 'AP', 'MAP-I': 'MAP', 'CP-I': 'CP', 'EP-I': 'EP', 'AP-I': 'AP' };
// Words that mean "I do not want to say this now" for any optional detail.
const SKIP_WORDS = new Set(['skip', 'skipped', 'unspecified', 'unknown', 'pending', 'later', 'tbd', 'n/a', 'na', 'not provided', 'not specified', 'not decided', 'undecided', 'not sure']);
const BAD_SENDER = /^(not provided|not specified|unspecified|unknown|n\/?a|none|null|skip|pending|tbd|-+)$/i;
const MAX_NIGHTS = 60;
const MAX_ROOMS = 40;
// A houseboat has 3, 4 or at most 5 rooms. A big request (like 40 rooms) must be spread over several houseboats.
export const MAX_ROOMS_PER_BOAT = 5;
const capOf = (b) => Math.min(b.total || MAX_ROOMS_PER_BOAT, MAX_ROOMS_PER_BOAT);
const tooManyMsg = (name, cap) => `${name} can hold at most ${cap} rooms (houseboats have 3 to ${MAX_ROOMS_PER_BOAT} rooms). Please tell me which other houseboats should take the remaining rooms.`;

/* ------------------------------------------------------------------ */
/* Data access helpers (MongoDB, every query is scoped by ctx.ownerId) */
/* ------------------------------------------------------------------ */

const col = (ctx, name) => ctx.store.c(name);
const byOwner = (ctx, extra = {}) => ({ owner_id: ctx.ownerId, ...extra });
export const audit = (ctx, action, detail) => col(ctx, 'audit_log').insert({ owner_id: ctx.ownerId, action, detail: typeof detail === 'string' ? detail : JSON.stringify(detail ?? {}) });
const nowIso = () => new Date().toISOString();
// SQL "LIKE %x%" was case-insensitive: same here
const hasText = (value, part) => String(value || '').toLowerCase().includes(String(part).toLowerCase());
const upper = (s) => String(s || '').toUpperCase();

/* ------------------------------------------------------------------ */
/* Houseboats and room tokens                                          */
/* ------------------------------------------------------------------ */

const letters = (name) => String(name).toUpperCase().replace(/[^A-Z]/g, '');
const isOwnName = (name) => /^(own|my own|mine|apna|apne)\b/i.test(String(name).trim());
const pad3 = (n) => String(n).padStart(3, '0');

async function allHouseboats(ctx) {
  return col(ctx, 'houseboats').find(byOwner(ctx), { sort: { name: 1 } });
}
const boatByName = (ctx, name) => col(ctx, 'houseboats').one(byOwner(ctx, { name_lc: String(name).trim().toLowerCase() }));

// Exact name first, then a single unambiguous partial match ("Chinar" for "Chinar Houseboat").
async function matchHouseboat(ctx, name, rows = null) {
  rows = rows || await allHouseboats(ctx);
  const n = String(name).trim().toLowerCase();
  let m = rows.filter((r) => r.name.toLowerCase() === n);
  if (!m.length) m = rows.filter((r) => r.name.toLowerCase().includes(n) || n.includes(r.name.toLowerCase()));
  return m.length === 1 ? m[0] : null;
}

async function findHouseboat(ctx, name) {
  const rows = await allHouseboats(ctx);
  const h = await matchHouseboat(ctx, name, rows);
  if (!h) throw new ToolError(`I could not find a houseboat called "${name}". Known houseboats: ${rows.map((r) => r.name).join(', ') || 'none yet'}.`);
  return h;
}

// First 3 letters of the name; if another houseboat already uses them, vary the 3rd letter.
async function makePrefix(ctx, name, taken = new Set()) {
  const used = new Set([...taken, ...(await allHouseboats(ctx)).map((h) => h.prefix)]);
  const L = letters(name).padEnd(3, 'X');
  const tries = [L.slice(0, 3)];
  for (let i = 3; i < L.length; i++) tries.push(L.slice(0, 2) + L[i]);
  for (let d = 2; d <= 9; d++) tries.push(L.slice(0, 2) + d);
  const p = tries.find((t) => !used.has(t));
  if (!p) throw new ToolError(`Could not make a short code for "${name}". Try a slightly different name.`);
  return p;
}

async function insertHouseboat(ctx, { name, prefix, is_own, total_rooms = null }) {
  try {
    return await col(ctx, 'houseboats').insert({ owner_id: ctx.ownerId, name, name_lc: name.toLowerCase(), prefix, is_own: is_own ? 1 : 0, total_rooms });
  } catch (e) {
    if (e instanceof DuplicateError) throw new ToolError(`A houseboat called "${name}" (or the code ${prefix}) was just added. Please try again.`);
    throw e;
  }
}

// Used by the dashboard "Add houseboat" button. Adding an existing name just updates its room count.
export function addHouseboat(ctx, args) {
  return ctx.store.tx(() => saveHouseboat(ctx, args));
}

// Checks one houseboat name and room count.
function cleanBoat(ctx, { name, total_rooms }) {
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 60) throw new ToolError('Please enter a houseboat name (2 to 60 letters).');
  if (!/[A-Za-z]{2}/.test(name)) throw new ToolError(`"${name}": the name needs at least two English letters (they make the room tokens, like CUL001).`);
  const rooms = total_rooms === undefined || total_rooms === null || total_rooms === '' ? null : Number(total_rooms);
  if (rooms !== null && (!Number.isInteger(rooms) || rooms < 1 || rooms > MAX_ROOMS_PER_BOAT)) throw new ToolError(`${name}: a houseboat has 1 to ${MAX_ROOMS_PER_BOAT} rooms (usually 3 or 4).`);
  return { name, rooms };
}

// Saves one houseboat (no transaction of its own, so a chat tool can add several in one go).
async function saveHouseboat(ctx, { name, total_rooms, is_own }) {
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 60) throw new ToolError('Please enter a houseboat name (2 to 60 letters).');
  if (!/[A-Za-z]{2}/.test(name)) throw new ToolError('The name needs at least two English letters (they make the room tokens, like CUL001).');
  const rooms = total_rooms === undefined || total_rooms === null || total_rooms === '' ? null : Number(total_rooms);
  if (rooms !== null && (!Number.isInteger(rooms) || rooms < 1 || rooms > MAX_ROOMS_PER_BOAT)) throw new ToolError(`A houseboat has 1 to ${MAX_ROOMS_PER_BOAT} rooms (usually 3 or 4). Please enter a whole number up to ${MAX_ROOMS_PER_BOAT}.`);
  const existing = await boatByName(ctx, name);
  if (existing) {
    if (rooms !== null) {
      const today = todayStr(ctx.tz);
      const live = new Set((await col(ctx, 'bookings').find(byOwner(ctx, { status: 'confirmed', check_out: { $gte: today } }))).map((b) => b.id));
      const maxUsed = Math.max(0, ...(await col(ctx, 'booking_rooms').find(byOwner(ctx, { houseboat_id: existing.id }))).filter((r) => live.has(r.booking_id)).map((r) => r.room_no));
      if (rooms < maxUsed) throw new ToolError(`${existing.name} already has bookings up to room ${maxUsed}, so it cannot have fewer than ${maxUsed} rooms.`);
    }
    await col(ctx, 'houseboats').update({ id: existing.id, owner_id: ctx.ownerId }, { $set: { total_rooms: rooms ?? existing.total_rooms ?? null, is_own: is_own ? 1 : 0 } });
    await audit(ctx, 'update_houseboat', { name: existing.name, rooms });
    return { id: existing.id, name: existing.name, prefix: existing.prefix, total_rooms: rooms ?? existing.total_rooms, is_own: !!is_own, updated: true };
  }
  const prefix = await makePrefix(ctx, name);
  const row = await insertHouseboat(ctx, { name, prefix, is_own, total_rooms: rooms });
  await audit(ctx, 'add_houseboat', { name, rooms });
  return { id: row.id, name, prefix, total_rooms: rooms, is_own: !!is_own, updated: false };
}

/* ------------------------------------------------------------------ */
/* Money (append-only ledger)                                          */
/* ------------------------------------------------------------------ */

// What an entry counts as. A REVERSAL counts as the type of the entry it undoes.
const kindOf = (l, byId) => (l.type === 'REVERSAL' ? byId.get(l.ref_id)?.type ?? null : l.type);
// billed / received / refunded / balance over some entries (amounts: charges +, payments -, refunds +)
function moneyOf(list, byId) {
  let billed = 0; let paid = 0; let refunded = 0; let balance = 0;
  for (const l of list) {
    const k = kindOf(l, byId);
    if (k === 'CHARGE') billed += l.amount; else if (k === 'PAYMENT') paid += l.amount; else if (k === 'REFUND') refunded += l.amount;
    balance += l.amount;
  }
  return { billed, received: -paid, refunded, balance };
}
async function ownerLedger(ctx) {
  const all = await col(ctx, 'ledger').find(byOwner(ctx), { sort: { id: 1 } });
  return { all, byId: new Map(all.map((l) => [l.id, l])) };
}

async function addLedger(ctx, { booking = null, houseboat = null, side, type, amount, method = null, note = null, ref = null }) {
  const r = await col(ctx, 'ledger').insert({ owner_id: ctx.ownerId, booking_id: booking, houseboat_id: houseboat, side, type, amount, method: method ?? null, note: note ?? null, ref_id: ref });
  return r.id;
}

async function getBooking(ctx, id) {
  const b = await col(ctx, 'bookings').one(byOwner(ctx, { id: Number(id) }));
  if (!b) throw new ToolError(`Booking #${id} was not found.`);
  return b;
}

const nightsOf = (b) => nightsBetween(b.check_in, b.check_out).length;

export const isPending = (r) => r.guests == null || r.meal_plan == null || r.price == null;

// Bookings with their rooms (houseboat name, own flag), client money and what is due to each houseboat.
export async function bookingRows(ctx, f = {}) {
  const q = byOwner(ctx);
  if (f.bookingId) q.id = Number(f.bookingId);
  if (f.status) q.status = f.status;
  const dateCond = {};
  if (f.date) { q.check_in = { $lte: f.date }; dateCond.out = f.date; }
  if (f.to) q.check_in = { ...(q.check_in || {}), $lte: f.date && f.date < f.to ? f.date : f.to };
  if (f.from) dateCond.out = dateCond.out && dateCond.out > f.from ? dateCond.out : f.from;
  if (dateCond.out) q.check_out = { $gt: dateCond.out };
  let bookings = await col(ctx, 'bookings').find(q);
  if (f.client) bookings = bookings.filter((b) => hasText(b.client_name, f.client));
  if (f.sender) bookings = bookings.filter((b) => hasText(b.sender, f.sender));
  const ids = bookings.map((b) => b.id);
  const [roomRows, boats, { all: ledger, byId }] = await Promise.all([
    ids.length ? col(ctx, 'booking_rooms').find(byOwner(ctx, { booking_id: { $in: ids } })) : [],
    allHouseboats(ctx),
    ownerLedger(ctx),
  ]);
  const boat = new Map(boats.map((h) => [h.id, h]));
  const roomsOf = new Map(ids.map((id) => [id, []]));
  for (const r of roomRows) roomsOf.get(r.booking_id)?.push(r);
  const keep = (b) => {
    const rs = roomsOf.get(b.id);
    if (f.houseboatId && !rs.some((x) => x.houseboat_id === f.houseboatId)) return false;
    if (f.mealPlan && !rs.some((x) => x.meal_plan === f.mealPlan)) return false;
    if (f.pendingOnly && !rs.some(isPending)) return false;
    if (f.token && !rs.some((x) => x.token === upper(f.token))) return false;
    return true;
  };
  bookings = bookings.filter(keep).sort((a, b) => (a.check_in < b.check_in ? 1 : a.check_in > b.check_in ? -1 : b.id - a.id)).slice(0, f.limit || 200);
  const ledgerOf = new Map();
  for (const l of ledger) if (l.booking_id != null) { if (!ledgerOf.has(l.booking_id)) ledgerOf.set(l.booking_id, []); ledgerOf.get(l.booking_id).push(l); }
  return bookings.map((b) => {
    const rooms = roomsOf.get(b.id)
      .filter((r) => boat.has(r.houseboat_id))
      .map((r) => { const h = boat.get(r.houseboat_id); return { token: r.token, houseboat: h.name, is_own: h.is_own, guests: r.guests ?? null, meal_plan: r.meal_plan ?? null, price: r.price ?? null, cost: r.cost, _room_no: r.room_no }; })
      .sort((x, y) => (x.houseboat < y.houseboat ? -1 : x.houseboat > y.houseboat ? 1 : x._room_no - y._room_no))
      .map(({ _room_no, ...r }) => r);
    const entries = ledgerOf.get(b.id) || [];
    const client = moneyOf(entries.filter((l) => l.side === 'CLIENT'), byId);
    const per = new Map();
    for (const l of entries) if (l.side === 'PARTNER' && boat.has(l.houseboat_id)) { if (!per.has(l.houseboat_id)) per.set(l.houseboat_id, []); per.get(l.houseboat_id).push(l); }
    const houseboat_dues = [...per].map(([hid, list]) => { const m = moneyOf(list, byId); return { houseboat_id: hid, houseboat: boat.get(hid).name, payable: m.billed, paid: m.received, pending: m.balance }; })
      .sort((x, y) => (x.houseboat < y.houseboat ? -1 : 1));
    return {
      id: b.id, client_name: b.client_name, phone: b.phone ?? null, check_in: b.check_in, check_out: b.check_out, status: b.status, notes: b.notes ?? null, sender: b.sender ?? null, rooms_required: b.rooms_required ?? null,
      billed: client.billed, received: client.received, refunded: client.refunded, balance: client.balance,
      nights: nightsOf(b), rooms, houseboat_dues,
      rooms_allocated: rooms.length,
      rooms_left: b.rooms_required ? Math.max(b.rooms_required - rooms.length, 0) : null,
      pending_tokens: rooms.filter(isPending).map((x) => x.token),
    };
  });
}

// What you owe each partner houseboat (own boats have no payable).
export async function houseboatRows(ctx, houseboatId = null) {
  const today = todayStr(ctx.tz);
  const boats = (await allHouseboats(ctx)).filter((h) => !houseboatId || h.id === houseboatId);
  const [{ all: ledger, byId }, liveBookings, rooms, locks] = await Promise.all([
    ownerLedger(ctx),
    col(ctx, 'bookings').find(byOwner(ctx, { status: 'confirmed', check_out: { $gt: today } })),
    col(ctx, 'booking_rooms').find(byOwner(ctx)),
    col(ctx, 'room_night_locks').find(byOwner(ctx, { stay_date: today })),
  ]);
  const live = new Set(liveBookings.map((b) => b.id));
  return boats.map((h) => {
    const m = moneyOf(ledger.filter((l) => l.side === 'PARTNER' && l.houseboat_id === h.id), byId);
    const up = rooms.filter((r) => r.houseboat_id === h.id && live.has(r.booking_id));
    const tonight = locks.filter((l) => l.houseboat_id === h.id).length;
    return {
      id: h.id, name: h.name, prefix: h.prefix, is_own: h.is_own, total_rooms: h.total_rooms ?? null,
      payable: m.billed, paid: m.received, pending: m.balance,
      vacant_tonight: h.total_rooms ? Math.max(h.total_rooms - tonight, 0) : null, booked_tonight: tonight,
      upcoming_rooms: up.length, upcoming_bookings: new Set(up.map((r) => r.booking_id)).size,
    };
  });
}

export async function moneyOverview(ctx) {
  const [bookings, cancelled, hb] = await Promise.all([bookingRows(ctx, { status: 'confirmed' }), bookingRows(ctx, { status: 'cancelled' }), houseboatRows(ctx)]);
  const clientBookings = [...bookings, ...cancelled].filter((b) => b.balance !== 0);
  const toReceive = clientBookings.reduce((s, b) => s + Math.max(b.balance, 0), 0);
  const toRefund = clientBookings.reduce((s, b) => s + Math.max(-b.balance, 0), 0);
  const toPay = hb.reduce((s, h) => s + Math.max(h.pending, 0), 0);
  return {
    totals: {
      billed: [...bookings, ...cancelled].reduce((s, b) => s + b.billed, 0),
      received: [...bookings, ...cancelled].reduce((s, b) => s + b.received, 0),
      to_receive: toReceive,
      to_refund: toRefund,
      payable: hb.reduce((s, h) => s + h.payable, 0),
      paid_out: hb.reduce((s, h) => s + h.paid, 0),
      to_pay: toPay,
    },
    client_dues: clientBookings,
    houseboats: hb.filter((h) => !h.is_own),
  };
}

export async function recentLedger(ctx, limit = 15) {
  const rows = await col(ctx, 'ledger').find(byOwner(ctx), { sort: { id: -1 }, limit });
  const bIds = [...new Set(rows.map((l) => l.booking_id).filter((x) => x != null))];
  const [bookings, boats] = await Promise.all([bIds.length ? col(ctx, 'bookings').find(byOwner(ctx, { id: { $in: bIds } })) : [], allHouseboats(ctx)]);
  const bn = new Map(bookings.map((b) => [b.id, b.client_name]));
  const hn = new Map(boats.map((h) => [h.id, h.name]));
  return rows.map((l) => ({ id: l.id, booking_id: l.booking_id ?? null, side: l.side, type: l.type, amount: l.amount, method: l.method ?? null, note: l.note ?? null, ref_id: l.ref_id ?? null, created_at: l.created_at, client_name: bn.get(l.booking_id) ?? null, houseboat: hn.get(l.houseboat_id) ?? null }));
}

export async function dashboardSummary(ctx) {
  const today = todayStr(ctx.tz);
  const [boats, tonight, live, m] = await Promise.all([
    col(ctx, 'houseboats').count(byOwner(ctx)),
    col(ctx, 'room_night_locks').count(byOwner(ctx, { stay_date: today })),
    col(ctx, 'bookings').find(byOwner(ctx, { status: 'confirmed' })),
    moneyOverview(ctx),
  ]);
  const upcoming = live.filter((b) => b.check_out > today);
  const roomRows = upcoming.length ? await col(ctx, 'booking_rooms').find(byOwner(ctx, { booking_id: { $in: upcoming.map((b) => b.id) } })) : [];
  const roomsOf = (id) => roomRows.filter((r) => r.booking_id === id);
  return {
    today,
    houseboats: boats,
    rooms_tonight: tonight,
    arrivals_today: live.filter((b) => b.check_in === today).length,
    departures_today: live.filter((b) => b.check_out === today).length,
    upcoming_bookings: upcoming.length,
    details_pending: upcoming.filter((b) => roomsOf(b.id).some(isPending)).length,
    rooms_left_to_allocate: upcoming.filter((b) => b.rooms_required != null).reduce((s, b) => s + Math.max(b.rooms_required - roomsOf(b.id).length, 0), 0),
    to_receive: m.totals.to_receive,
    to_pay: m.totals.to_pay,
  };
}

// Rows = houseboats, columns = dates, cell = how many rooms are booked there that night.
export async function calendarGrid(ctx, from, days = 14) {
  days = Math.min(Math.max(days, 1), 31);
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const end = addDays(from, days);
  const [hb, locks] = await Promise.all([allHouseboats(ctx), col(ctx, 'room_night_locks').find(byOwner(ctx, { stay_date: { $gte: from, $lt: end } }))]);
  const bIds = [...new Set(locks.map((l) => l.booking_id))];
  const names = new Map((bIds.length ? await col(ctx, 'bookings').find(byOwner(ctx, { id: { $in: bIds } })) : []).map((b) => [b.id, b.client_name]));
  const by = new Map();
  for (const l of locks) {
    if (!by.has(l.houseboat_id)) by.set(l.houseboat_id, {});
    const cell = by.get(l.houseboat_id)[l.stay_date] || (by.get(l.houseboat_id)[l.stay_date] = { rooms: 0, list: new Set() });
    cell.rooms++; if (names.has(l.booking_id)) cell.list.add(names.get(l.booking_id));
  }
  for (const cells of by.values()) for (const d of Object.keys(cells)) cells[d] = { rooms: cells[d].rooms, clients: [...cells[d].list].join(',') };
  return {
    from, dates,
    rows: hb.filter((h) => by.has(h.id)).map((h) => ({ houseboat: h.name, prefix: h.prefix, is_own: !!h.is_own, cells: by.get(h.id) })),
  };
}

/* ------------------------------------------------------------------ */
/* Tiny argument validator (the AI output is never trusted)            */
/* ------------------------------------------------------------------ */

export function validateArgs(schema, raw, path = '') {
  const props = schema?.properties || {};
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, def] of Object.entries(props)) {
    let v = input[key];
    const label = path + key;
    if (v === undefined || v === null || v === '') continue;
    // "skip" / "unspecified" / "unknown" for an optional detail simply means: leave it out for now.
    if (typeof v === 'string' && def.type !== 'boolean' && def.type !== 'array' && SKIP_WORDS.has(v.trim().toLowerCase())) continue;
    if (def.type === 'integer' || def.type === 'number') {
      const n = Number(String(v).replace(/,/g, ''));
      if (!Number.isFinite(n)) throw new ToolError(`"${label}" must be a number.`);
      v = def.type === 'integer' ? Math.round(n) : n;
    } else if (def.type === 'boolean') {
      v = typeof v === 'string' ? ['true', 'yes', '1'].includes(v.toLowerCase()) : Boolean(v);
    } else if (def.type === 'array') {
      if (!Array.isArray(v)) throw new ToolError(`"${label}" must be a list.`);
      if (v.length > MAX_ROOMS) throw new ToolError(`"${label}" has too many items.`);
      v = v.map((item, i) => validateArgs(def.items, item, `${label}[${i + 1}].`));
    } else {
      v = String(v).trim();
      if (v.length > 300) throw new ToolError(`"${label}" is too long.`);
      if (def.enum) {
        if (def.aliases) v = def.aliases[v.toUpperCase()] || v;
        const hit = def.enum.find((e) => e.toLowerCase() === v.toLowerCase());
        if (!hit) throw new ToolError(`"${label}" must be one of: ${def.enum.join(', ')}.`);
        v = hit;
      }
    }
    out[key] = v;
  }
  for (const key of schema?.required || []) {
    if (out[key] === undefined) {
      // The sender can only come from the owner, so a missing sender is a question for him, not something the AI may retry.
      if (key === 'sender' && !path) throw new ToolError('Who sent this booking? I need the sender name (an agent, company or person). If the guest booked directly, the sender is "Direct".', { askOwner: true });
      throw new ToolError(`Missing required field: ${path}${key}.`);
    }
  }
  return out;
}

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const I = (description) => ({ type: 'integer', description });
const DATE = (what) => S(`${what}, format YYYY-MM-DD`);
const lines = (...parts) => parts.flat().filter(Boolean).join('\n');

const gTxt = (g) => (g == null ? 'guests pending' : `${g} guest${g > 1 ? 's' : ''}`);
const mTxt = (m) => m ?? 'meal plan pending';
const pTxt = (p) => (p == null ? 'price pending' : `${inr(p)}/night`);
const roomLine = (r) => `${r.token} · ${r.houseboat} · ${gTxt(r.guests)} · ${mTxt(r.meal_plan)} · ${pTxt(r.price)}`;
const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
const MEAL = (what = 'Meal plan') => S(`${what}: EP = room only, CP = + breakfast, MAP (also said MAPI) = + breakfast and dinner, AP = all meals`, { enum: MEAL_PLANS, aliases: MEAL_ALIASES });

function cleanSender(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s || BAD_SENDER.test(s)) throw new ToolError('Who sent this booking? I need the sender name (an agent, company or person). If the guest booked directly, the sender is "Direct".', { askOwner: true });
  if (s.length > 80) throw new ToolError('The sender name is too long.');
  return s;
}
const monthRange = (m) => {
  const from = `${m}-01`;
  const [y, mo] = m.split('-').map(Number);
  return { from, to: addDays(`${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, '0')}-01`, -1) };
};
const overlapNights = (ci, co, from, toInclusive) => {
  const a = ci > from ? ci : from;
  const end = addDays(toInclusive, 1);
  const b = co < end ? co : end;
  return a < b ? nightsBetween(a, b).length : 0;
};


/* ------------------------------------------------------------------ */
/* Shared room planning (used by new bookings, add rooms, move room)   */
/* ------------------------------------------------------------------ */

const ROOM_ITEM = {
  type: 'object',
  properties: {
    houseboat: S('Houseboat name exactly as the owner says it. Use "Own" for rooms the owner holds himself without naming a boat.'),
    own: { type: 'boolean', description: 'true if this houseboat belongs to the owner himself (nothing to pay out)' },
    guests: I('Number of guests staying in this room. Leave out if the owner says skip / not known yet.'),
    price: I('Price per night for this room charged to the client, rupees. Leave out if the owner says skip / not decided yet.'),
    meal_plan: MEAL('Meal plan for this room. Leave out if the owner says skip / not decided yet.'),
    partner_price: I('What the houseboat charges the owner per night for this room, if different from the client price (optional)'),
    room_no: I('A specific room number if the owner names one (optional; otherwise assigned automatically)'),
  },
  required: ['houseboat'],
};

// One room of a booking (by token, any letter case) with its houseboat name and own flag.
async function roomWithBoat(ctx, bookingId, token) {
  const r = await col(ctx, 'booking_rooms').one(byOwner(ctx, { booking_id: bookingId, token: upper(token) }));
  if (!r) return null;
  const h = await col(ctx, 'houseboats').one(byOwner(ctx, { id: r.houseboat_id }));
  return h ? { ...r, houseboat: h.name, is_own: h.is_own } : null;
}

// Room numbers of a houseboat that are taken on any night from checkIn (inclusive) to checkOut (exclusive).
async function usedRoomNos(ctx, houseboatId, checkIn, checkOut, exceptBooking = null) {
  const q = byOwner(ctx, { houseboat_id: houseboatId, stay_date: { $gte: checkIn, $lt: checkOut } });
  if (exceptBooking) q.booking_id = { $ne: exceptBooking };
  return new Set((await col(ctx, 'room_night_locks').find(q)).map((x) => x.room_no));
}

// Resolves houseboats, assigns room numbers (explicit first, then lowest free) and prices each room.
// Details the owner skipped stay null ("details pending").
async function planRooms(ctx, rawRooms, checkIn, checkOut) {
  if (!rawRooms?.length) throw new ToolError('Add at least one room.');
  const nights = nightsBetween(checkIn, checkOut);
  const known = await allHouseboats(ctx);
  const boats = new Map();
  const newPrefixes = new Set();
  const keyOf = async (r) => { const m = await matchHouseboat(ctx, r.houseboat, known); return m ? `id:${m.id}` : `new:${r.houseboat.trim().toLowerCase()}`; };
  const planned = [];
  for (const r of rawRooms) {
    const key = await keyOf(r);
    planned.push({ ...r, key, no: r.room_no });
    if (!boats.has(key)) {
      const m = await matchHouseboat(ctx, r.houseboat, known);
      if (m) boats.set(key, { key, id: m.id, name: m.name, prefix: m.prefix, is_own: !!m.is_own || r.own === true, is_new: false, total: m.total_rooms });
      else {
        const prefix = await makePrefix(ctx, r.houseboat, newPrefixes);
        newPrefixes.add(prefix);
        boats.set(key, { key, id: null, name: r.houseboat.trim(), prefix, is_own: r.own === true || isOwnName(r.houseboat), is_new: true });
      }
    } else if (r.own === true) boats.get(key).is_own = true;
  }
  const usedBy = new Map();
  for (const b of boats.values()) usedBy.set(b.key, b.id ? await usedRoomNos(ctx, b.id, checkIn, checkOut) : new Set());
  for (const r of planned.filter((x) => x.no)) {
    if (r.no < 1 || r.no > 999) throw new ToolError('Room numbers must be between 1 and 999.');
    const b = boats.get(r.key);
    if (r.no > capOf(b)) throw new ToolError(b.total ? `${b.name} has only ${b.total} rooms, so room ${r.no} does not exist.` : tooManyMsg(b.name, capOf(b)));
    if (usedBy.get(r.key).has(r.no)) throw new ToolError(`${b.prefix}${pad3(r.no)} is already in use on those dates. Pick another room number or leave it for me to assign.`);
    usedBy.get(r.key).add(r.no);
  }
  for (const r of planned.filter((x) => !x.no)) {
    let n = 1; const used = usedBy.get(r.key);
    while (used.has(n)) n++;
    const b = boats.get(r.key);
    if (n > capOf(b)) throw new ToolError(b.total ? `${b.name} has only ${b.total} rooms and no more are free on those dates.` : tooManyMsg(b.name, capOf(b)));
    r.no = n; used.add(n);
  }
  const rooms = planned.map((r) => {
    if (r.guests !== undefined && !(r.guests >= 1 && r.guests <= 20)) throw new ToolError('Guests per room must be between 1 and 20.');
    if (r.price !== undefined && !(r.price >= 0)) throw new ToolError('Price cannot be negative.');
    if (r.partner_price !== undefined && !(r.partner_price >= 0)) throw new ToolError('Houseboat price cannot be negative.');
    const b = boats.get(r.key);
    const cost = b.is_own ? 0 : (r.partner_price ?? r.price ?? 0);
    return { key: r.key, houseboat: b.name, token: `${b.prefix}${pad3(r.no)}`, room_no: r.no, guests: r.guests ?? null, meal_plan: r.meal_plan ?? null, price: r.price ?? null, cost, own: b.is_own };
  });
  const tokens = rooms.map((r) => r.token);
  if (new Set(tokens).size !== tokens.length) throw new ToolError('Two rooms got the same room number on one houseboat. Give different room numbers.');
  return { boats, rooms, nights };
}

// One lock per room per night. Its _id makes two bookings on the same room and night impossible (MongoDB refuses the duplicate).
async function lockNight(ctx, houseboatId, roomNo, date, bookingId, token) {
  try {
    await col(ctx, 'room_night_locks').insert({ _id: `${houseboatId}:${roomNo}:${date}`, houseboat_id: houseboatId, room_no: roomNo, stay_date: date, booking_id: bookingId, owner_id: ctx.ownerId });
  } catch (e) {
    if (e instanceof DuplicateError) throw new ToolError(`${token} was just booked by another booking for ${prettyDate(date)}. Nothing was saved. Please ask again.`);
    throw e;
  }
}

// Creates missing houseboats, inserts rooms + night locks for a booking. Returns the saved rooms.
async function saveRooms(ctx, bookingId, rooms, nights) {
  const boats = new Map();
  for (const r of rooms) {
    const k = r.houseboat.toLowerCase();
    if (boats.has(k)) { if (r.own && !boats.get(k).is_own) { await col(ctx, 'houseboats').update({ id: boats.get(k).id, owner_id: ctx.ownerId }, { $set: { is_own: 1 } }); boats.get(k).is_own = 1; } continue; }
    let row = await boatByName(ctx, r.houseboat);
    if (!row) row = await insertHouseboat(ctx, { name: r.houseboat, prefix: await makePrefix(ctx, r.houseboat), is_own: r.own });
    else if (r.own && !row.is_own) { await col(ctx, 'houseboats').update({ id: row.id, owner_id: ctx.ownerId }, { $set: { is_own: 1 } }); row.is_own = 1; }
    boats.set(k, row);
  }
  const saved = [];
  for (const r of rooms) {
    const hb = boats.get(r.houseboat.toLowerCase());
    const token = `${hb.prefix}${pad3(r.room_no)}`;
    const cost = hb.is_own ? 0 : (r.cost ?? 0);
    await col(ctx, 'booking_rooms').insert({ booking_id: bookingId, owner_id: ctx.ownerId, houseboat_id: hb.id, room_no: r.room_no, token, guests: r.guests ?? null, meal_plan: r.meal_plan ?? null, price: r.price ?? null, cost });
    for (const d of nights) await lockNight(ctx, hb.id, r.room_no, d, bookingId, token);
    saved.push({ token, houseboat: hb.name, own: !!hb.is_own, guests: r.guests ?? null, meal_plan: r.meal_plan ?? null, price: r.price ?? null, cost, houseboat_id: hb.id });
  }
  return saved;
}

// Adds the client charge and the per-houseboat charges for rooms over some nights.
async function chargeRooms(ctx, bookingId, rooms, nightCount, note) {
  const clientAmount = sum(rooms, (r) => r.price) * nightCount;
  if (clientAmount) await addLedger(ctx, { booking: bookingId, side: 'CLIENT', type: 'CHARGE', amount: clientAmount, note });
  const per = new Map();
  for (const r of rooms) if (r.cost) per.set(r.houseboat_id, (per.get(r.houseboat_id) || 0) + r.cost * nightCount);
  const payables = [];
  for (const [hid, amount] of per) if (amount) { await addLedger(ctx, { booking: bookingId, houseboat: hid, side: 'PARTNER', type: 'CHARGE', amount, note }); payables.push({ houseboat_id: hid, amount }); }
  return { clientAmount, payables };
}

// Rooms of confirmed bookings staying inside a window, joined with their booking and houseboat (for counts and reports).
async function stayingRooms(ctx, from, to, { houseboatId = null, mealPlan = null, sender = null, client = null } = {}) {
  let bookings = await col(ctx, 'bookings').find(byOwner(ctx, { status: 'confirmed', check_in: { $lte: to }, check_out: { $gt: from } }));
  if (sender) bookings = bookings.filter((b) => hasText(b.sender, sender));
  if (client) bookings = bookings.filter((b) => hasText(b.client_name, client));
  if (!bookings.length) return [];
  const bk = new Map(bookings.map((b) => [b.id, b]));
  const q = byOwner(ctx, { booking_id: { $in: [...bk.keys()] } });
  if (houseboatId) q.houseboat_id = houseboatId;
  if (mealPlan) q.meal_plan = mealPlan;
  const boats = new Map((await allHouseboats(ctx)).map((h) => [h.id, h]));
  return (await col(ctx, 'booking_rooms').find(q)).filter((r) => boats.has(r.houseboat_id)).map((r) => {
    const b = bk.get(r.booking_id); const h = boats.get(r.houseboat_id);
    return { token: r.token, guests: r.guests ?? null, meal_plan: r.meal_plan ?? null, price: r.price ?? null, cost: r.cost, hid: h.id, houseboat: h.name, is_own: h.is_own, booking_id: b.id, client_name: b.client_name, sender: b.sender ?? null, check_in: b.check_in, check_out: b.check_out };
  });
}

/* ------------------------------------------------------------------ */
/* Availability, counts, reports, people                               */
/* ------------------------------------------------------------------ */

// Which rooms of each houseboat are taken / free on one night. "Free" needs the houseboat's total rooms.
export async function availability(ctx, date, houseboatId = null) {
  const boats = (await allHouseboats(ctx)).filter((h) => !houseboatId || h.id === houseboatId);
  const taken = new Map();
  for (const x of await col(ctx, 'room_night_locks').find(byOwner(ctx, { stay_date: date }))) {
    if (!taken.has(x.houseboat_id)) taken.set(x.houseboat_id, new Set());
    taken.get(x.houseboat_id).add(x.room_no);
  }
  const guests = new Map();
  for (const r of await stayingRooms(ctx, date, date)) guests.set(r.hid, (guests.get(r.hid) || 0) + (r.guests || 0));
  const rows = boats.map((h) => {
    const t = taken.get(h.id) || new Set();
    const freeNos = h.total_rooms ? Array.from({ length: h.total_rooms }, (_, i) => i + 1).filter((n) => !t.has(n)) : null;
    return {
      houseboat: h.name, code: h.prefix, is_own: !!h.is_own, total_rooms: h.total_rooms ?? null, booked: t.size, guests: guests.get(h.id) || 0,
      vacant: freeNos ? freeNos.length : null, vacant_tokens: freeNos ? freeNos.slice(0, 40).map((n) => `${h.prefix}${pad3(n)}`) : null,
    };
  });
  const known = rows.filter((r) => r.vacant !== null);
  return { date, houseboats: rows, totals: { booked: sum(rows, (r) => r.booked), guests: sum(rows, (r) => r.guests), vacant: sum(known, (r) => r.vacant), houseboats_without_total: rows.filter((r) => r.vacant === null).map((r) => r.houseboat) } };
}

// How many rooms / guests on a date (or window), optionally for one houseboat, meal plan, sender or client.
export async function countRooms(ctx, a) {
  const from = a.date || a.from_date;
  const to = a.date || a.to_date || from;
  if (!from) throw new ToolError('Tell me the date (or the first and last date) to count.');
  if (!isDate(from) || !isDate(to) || to < from) throw new ToolError('Dates must look like YYYY-MM-DD and the end cannot be before the start.');
  if (nightsBetween(from, addDays(to, 1)).length > 92) throw new ToolError('Please ask for 3 months or less at a time.');
  const hb = a.houseboat_name ? await findHouseboat(ctx, a.houseboat_name) : null;
  const rows = await stayingRooms(ctx, from, to, { houseboatId: hb?.id, mealPlan: a.meal_plan, sender: a.sender, client: a.client_name });
  const by = (key) => { const m = new Map(); for (const r of rows) { const k = r[key] ?? 'Pending'; const e = m.get(k) || { rooms: 0, guests: 0 }; e.rooms++; e.guests += r.guests || 0; m.set(k, e); } return m; };
  const out = {
    from, to, single_night: from === to, filters: { houseboat: hb?.name || null, meal_plan: a.meal_plan || null, sender: a.sender || null, client: a.client_name || null },
    rooms: rows.length, guests: sum(rows, (r) => r.guests), room_nights: sum(rows, (r) => overlapNights(r.check_in, r.check_out, from, to)),
    bookings: new Set(rows.map((r) => r.booking_id)).size,
    by_houseboat: [...by('houseboat')].map(([houseboat, v]) => ({ houseboat, ...v })).sort((x, y) => y.rooms - x.rooms),
    by_meal_plan: [...by('meal_plan')].map(([meal_plan, v]) => ({ meal_plan, ...v })),
  };
  if (from !== to && nightsBetween(from, addDays(to, 1)).length <= 31) {
    out.by_date = nightsBetween(from, addDays(to, 1)).map((d) => ({ date: d, rooms: rows.filter((r) => r.check_in <= d && r.check_out > d).length }));
  }
  return out;
}

// Revenue for a period: each room counts for the nights it stays inside the period, at the client price.
export async function reportData(ctx, a) {
  let from = a.from_date; let to = a.to_date;
  if (a.month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(a.month)) throw new ToolError('Month must look like 2026-12.');
    ({ from, to } = monthRange(a.month));
  }
  if (!from || !to || !isDate(from) || !isDate(to) || to < from) throw new ToolError('Tell me a month (like 2026-12) or a start and end date.');
  if (nightsBetween(from, addDays(to, 1)).length > 400) throw new ToolError('Please ask for one year or less.');
  const hb = a.houseboat_name ? await findHouseboat(ctx, a.houseboat_name) : null;
  const rows = (await stayingRooms(ctx, from, to, { houseboatId: hb?.id, sender: a.sender })).map((r) => ({ ...r, sender: r.sender ?? '(no sender)' }));
  const group = (keyFn, shape) => {
    const m = new Map();
    for (const r of rows) {
      const n = overlapNights(r.check_in, r.check_out, from, to);
      const k = keyFn(r);
      const e = m.get(k) || { ...shape(r), room_nights: 0, revenue: 0, payable: 0, bookings: new Set() };
      e.room_nights += n; e.revenue += (r.price || 0) * n; e.payable += (r.cost || 0) * n; e.bookings.add(r.booking_id);
      m.set(k, e);
    }
    return [...m.values()].map((e) => ({ ...e, bookings: e.bookings.size, margin: e.revenue - e.payable })).sort((x, y) => y.revenue - x.revenue);
  };
  const byBoat = group((r) => r.hid, (r) => ({ houseboat: r.houseboat, own: !!r.is_own }));
  const bySender = group((r) => r.sender.toLowerCase(), (r) => ({ sender: r.sender }));
  return {
    from, to, month: a.month || null,
    totals: { room_nights: sum(byBoat, (x) => x.room_nights), revenue: sum(byBoat, (x) => x.revenue), payable: sum(byBoat, (x) => x.payable), margin: sum(byBoat, (x) => x.margin), bookings: new Set(rows.map((r) => r.booking_id)).size },
    by_houseboat: byBoat, by_sender: bySender,
    pending_price_rooms: rows.filter((r) => r.price == null).length,
  };
}

// Clients and senders built automatically from the bookings (nothing to type in).
export async function peopleSummary(ctx, kind = 'client', search = '') {
  const rows = await bookingRows(ctx, { limit: 5000 });
  const field = kind === 'sender' ? 'sender' : 'client_name';
  const m = new Map();
  for (const b of rows) {
    const name = (b[field] || '').trim();
    if (!name) continue;
    const k = name.toLowerCase();
    const e = m.get(k) || { name, phone: null, bookings: 0, cancelled: 0, rooms: 0, billed: 0, received: 0, due: 0, first_stay: null, last_stay: null, pending_rooms: 0 };
    if (b.status === 'cancelled') e.cancelled++;
    else {
      e.bookings++; e.rooms += b.rooms.length; e.pending_rooms += b.pending_tokens.length;
      e.first_stay = !e.first_stay || b.check_in < e.first_stay ? b.check_in : e.first_stay;
      e.last_stay = !e.last_stay || b.check_in > e.last_stay ? b.check_in : e.last_stay;
    }
    e.billed += b.billed; e.received += b.received; e.due += b.balance;
    if (!e.phone && b.phone) e.phone = b.phone;
    m.set(k, e);
  }
  const q = String(search || '').trim().toLowerCase();
  return [...m.values()].filter((e) => !q || e.name.toLowerCase().includes(q) || (e.phone || '').includes(q)).sort((x, y) => y.billed - x.billed).slice(0, 100);
}

/* ------------------------------------------------------------------ */
/* Tool registry                                                       */
/* ------------------------------------------------------------------ */

export const TOOLS = [
  /* ---------- READ tools ---------- */
  {
    name: 'dashboard_summary',
    description: "Today's snapshot: rooms booked tonight, arrivals, departures, upcoming bookings, money to receive from clients and money to pay houseboats.",
    write: false,
    parameters: { type: 'object', properties: {} },
    run: (ctx) => dashboardSummary(ctx),
    format: (r) =>
      lines(
        `Today (${prettyDate(r.today)}):`,
        `- Rooms booked tonight: ${r.rooms_tonight}`,
        `- Arrivals today: ${r.arrivals_today}, departures today: ${r.departures_today}`,
        `- Upcoming bookings: ${r.upcoming_bookings}`,
        `- To receive from clients: ${inr(r.to_receive)}`,
        `- To pay houseboats: ${inr(r.to_pay)}`,
        r.details_pending ? `- Bookings with details pending: ${r.details_pending}` : '',
        r.rooms_left_to_allocate ? `- Rooms still to allocate: ${r.rooms_left_to_allocate}` : ''
      ),
  },
  {
    name: 'list_bookings',
    description:
      'Find bookings with every room token (houseboat, guests per room, meal plan, price), the sender, rooms required vs allocated, details still pending, and money status. Filters: date (bookings that hold rooms on that night), from_date/to_date window, client_name, sender, houseboat_name, meal_plan, token (like CUL001), booking_id, status, details_pending (only bookings with skipped details). Use this for "where did I give rooms on 2 Dec", "show Sharma booking", "who is in CUL001", "bookings sent by ABC Travels", "which bookings have pending details".',
    write: false,
    parameters: {
      type: 'object',
      properties: {
        date: DATE('A single night to look at (optional)'),
        from_date: DATE('Window start (optional)'),
        to_date: DATE('Window end (optional)'),
        client_name: S('Part of the client name (optional)'),
        sender: S('Part of the sender name (optional)'),
        houseboat_name: S('Only bookings that use this houseboat (optional)'),
        meal_plan: MEAL('Only bookings that have a room with this meal plan (optional)'),
        token: S('A room token like CUL001 (optional)'),
        booking_id: I('Booking number (optional)'),
        status: S('confirmed or cancelled (optional)', { enum: ['confirmed', 'cancelled'] }),
        details_pending: { type: 'boolean', description: 'true = only bookings where guests, price or meal plan was skipped' },
        limit: I('Max rows, default 15'),
      },
    },
    async run(ctx, a) {
      const hb = a.houseboat_name ? await findHouseboat(ctx, a.houseboat_name) : null;
      const rows = await bookingRows(ctx, { date: a.date, from: a.from_date, to: a.to_date, client: a.client_name, sender: a.sender, houseboatId: hb?.id, mealPlan: a.meal_plan, token: a.token, bookingId: a.booking_id, status: a.status, pendingOnly: a.details_pending, limit: Math.min(a.limit || 15, 40) });
      return rows.map((b) => ({
        booking_id: b.id, client: b.client_name, sender: b.sender || null, phone: b.phone, check_in: b.check_in, check_out: b.check_out, nights: b.nights, status: b.status,
        rooms_required: b.rooms_required, rooms_allocated: b.rooms_allocated, rooms_left_to_allocate: b.rooms_left,
        details_pending_tokens: b.pending_tokens,
        rooms: b.rooms.map((r) => ({ token: r.token, houseboat: r.houseboat, own: !!r.is_own, guests: r.guests, meal_plan: r.meal_plan, price_per_night: r.price, pay_houseboat_per_night: r.cost })),
        total_guests: sum(b.rooms, (r) => r.guests),
        client_total: b.billed, client_paid: b.received, client_due: b.balance,
        houseboat_dues: b.houseboat_dues.map((d) => ({ houseboat: d.houseboat, to_pay: d.payable, paid: d.paid, pending: d.pending })),
      }));
    },
    format: (r) =>
      r.length
        ? r.map((b) => lines(
            `#${b.booking_id} ${b.client}${b.sender ? ` (sender: ${b.sender})` : ''} - ${prettyDate(b.check_in)} to ${prettyDate(b.check_out)} (${b.nights} night${b.nights > 1 ? 's' : ''}) [${b.status}]`,
            b.rooms_required ? `Rooms: ${b.rooms_required} required, ${b.rooms_allocated} allocated${b.rooms_left_to_allocate ? `, ${b.rooms_left_to_allocate} left to allocate` : ''}` : '',
            b.rooms.map((x) => `- ${roomLine({ ...x, guests: x.guests, price: x.price_per_night })}`),
            b.details_pending_tokens.length ? `Details pending for: ${b.details_pending_tokens.join(', ')}` : '',
            `Client total ${inr(b.client_total)}, paid ${inr(b.client_paid)}, due ${inr(b.client_due)}`
          )).join('\n\n')
        : 'No bookings found.',
  },
  {
    name: 'count_rooms',
    description:
      'Count rooms and guests on a night (date) or over a window (from_date/to_date), optionally for one houseboat, meal plan, sender or client. Gives the split by houseboat and by meal plan. Use for "how many rooms in Chinar on 28 Dec", "how many MAP rooms on 3 Jan", "how many rooms did ABC Travels send in January", "how many guests on 25 Dec".',
    write: false,
    parameters: {
      type: 'object',
      properties: {
        date: DATE('A single night (use this OR from_date/to_date)'),
        from_date: DATE('Window start'),
        to_date: DATE('Window end'),
        houseboat_name: S('Only this houseboat (optional)'),
        meal_plan: MEAL('Only this meal plan (optional)'),
        sender: S('Only bookings from this sender (optional)'),
        client_name: S('Only this client (optional)'),
      },
    },
    run: (ctx, a) => countRooms(ctx, a),
    format: (r) => {
      const what = [r.filters.houseboat, r.filters.meal_plan && `${r.filters.meal_plan} meal plan`, r.filters.sender && `sender ${r.filters.sender}`, r.filters.client && `client ${r.filters.client}`].filter(Boolean).join(', ');
      const when = r.single_night ? `on ${prettyDate(r.from)}` : `from ${prettyDate(r.from)} to ${prettyDate(r.to)}`;
      return lines(
        `${r.rooms} room${r.rooms === 1 ? '' : 's'}, ${r.guests} guest${r.guests === 1 ? '' : 's'} ${when}${what ? ` (${what})` : ''}${r.single_night ? '' : `, ${r.room_nights} room-nights in ${r.bookings} booking${r.bookings === 1 ? '' : 's'}`}.`,
        r.by_houseboat.length > 1 || !r.filters.houseboat ? r.by_houseboat.map((x) => `- ${x.houseboat}: ${x.rooms} room${x.rooms === 1 ? '' : 's'}, ${x.guests} guests`) : '',
        !r.filters.meal_plan && r.by_meal_plan.length ? `Meal plans: ${r.by_meal_plan.map((x) => `${x.meal_plan} ${x.rooms}`).join(', ')}` : ''
      );
    },
  },
  {
    name: 'vacant_rooms',
    description: 'Which rooms are free on a night, per houseboat (needs the houseboat total rooms; otherwise only booked rooms are known). Use for "how many rooms are vacant on 28 Dec", "is Chinar full on 25 Dec", "which rooms are free in Cultural Palace on 1 Jan".',
    write: false,
    parameters: { type: 'object', properties: { date: DATE('The night to check'), houseboat_name: S('Only this houseboat (optional)') }, required: ['date'] },
    async run(ctx, a) {
      if (!isDate(a.date)) throw new ToolError('Date must look like YYYY-MM-DD.');
      const hb = a.houseboat_name ? await findHouseboat(ctx, a.houseboat_name) : null;
      return availability(ctx, a.date, hb?.id ?? null);
    },
    format: (r) =>
      lines(
        `${prettyDate(r.date)}: ${r.totals.booked} room${r.totals.booked === 1 ? '' : 's'} booked${r.totals.houseboats_without_total.length < r.houseboats.length ? `, ${r.totals.vacant} vacant` : ''}.`,
        r.houseboats.map((h) => `- ${h.houseboat}${h.is_own ? ' (own)' : ''}: ${h.booked} booked${h.vacant === null ? ' (total rooms not set, so vacant rooms are unknown)' : `, ${h.vacant} vacant of ${h.total_rooms}${h.vacant && h.vacant <= 12 ? ` (${h.vacant_tokens.join(', ')})` : ''}`}`)
      ),
  },
  {
    name: 'revenue_report',
    description: 'Revenue report for a month (month = YYYY-MM) or a date window: room-nights, client billing and amount payable to each houseboat, margin, split by houseboat and by sender. Optional filters houseboat_name or sender. Use for "December revenue", "how much did Chinar rooms bill in January", "billing by sender this month".',
    write: false,
    parameters: {
      type: 'object',
      properties: { month: S('Month as YYYY-MM, e.g. 2026-12'), from_date: DATE('Window start (if no month)'), to_date: DATE('Window end (if no month)'), houseboat_name: S('Only this houseboat (optional)'), sender: S('Only this sender (optional)') },
    },
    run: (ctx, a) => reportData(ctx, a),
    format: (r) =>
      lines(
        `Report ${r.month || `${prettyDate(r.from)} to ${prettyDate(r.to)}`}: ${r.totals.bookings} booking${r.totals.bookings === 1 ? '' : 's'}, ${r.totals.room_nights} room-nights.`,
        `Client billing ${inr(r.totals.revenue)}, payable to houseboats ${inr(r.totals.payable)}, your margin ${inr(r.totals.margin)}.`,
        r.by_houseboat.map((x) => `- ${x.houseboat}${x.own ? ' (own)' : ''}: ${x.room_nights} room-nights, billing ${inr(x.revenue)}${x.own ? '' : `, payable ${inr(x.payable)}`}`),
        r.by_sender.length > 1 ? ['By sender:', r.by_sender.map((x) => `- ${x.sender}: ${x.bookings} booking${x.bookings === 1 ? '' : 's'}, ${inr(x.revenue)}`)] : '',
        r.pending_price_rooms ? `Note: ${r.pending_price_rooms} room(s) have no price yet and count as ₹0.` : ''
      ),
  },
  {
    name: 'people_summary',
    description: 'Auto-built list of CLIENTS or SENDERS from past bookings with number of bookings, rooms, total billed and amount due. kind = client or sender; search by part of a name or phone. Use for "which clients owe me money", "how much business did ABC Travels give me", "find client Sharma".',
    write: false,
    parameters: { type: 'object', properties: { kind: S('client or sender', { enum: ['client', 'sender'] }), search: S('Part of a name or phone (optional)') } },
    run: async (ctx, a) => ({ kind: a.kind || 'client', people: (await peopleSummary(ctx, a.kind || 'client', a.search)).slice(0, 25) }),
    format: (r) =>
      r.people.length
        ? lines(`${r.kind === 'sender' ? 'Senders' : 'Clients'}:`, r.people.map((p) => `- ${p.name}: ${p.bookings} booking${p.bookings === 1 ? '' : 's'}, ${p.rooms} rooms, billed ${inr(p.billed)}, due ${inr(p.due)}`))
        : 'Nobody found.',
  },
  {
    name: 'get_balance',
    description: 'Money between you and CLIENTS: billed, received, and what is still due from each client booking. Pass client_name or booking_id to see one client.',
    write: false,
    parameters: { type: 'object', properties: { client_name: S('Part of client name (optional)'), booking_id: I('Booking number (optional)') } },
    async run(ctx, a) {
      const rows = a.client_name || a.booking_id ? await bookingRows(ctx, { client: a.client_name, bookingId: a.booking_id }) : (await moneyOverview(ctx)).client_dues;
      if ((a.client_name || a.booking_id) && !rows.length) throw new ToolError('No matching client booking found.');
      const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
      return {
        total_billed: sum('billed'), total_received: sum('received'), total_due: sum('balance'),
        bookings: rows.slice(0, 25).map((r) => ({ booking_id: r.id, client: r.client_name, check_in: r.check_in, check_out: r.check_out, status: r.status, billed: r.billed, received: r.received, due: r.balance })),
      };
    },
    format: (r) =>
      lines(`Clients: billed ${inr(r.total_billed)}, received ${inr(r.total_received)}, still due ${inr(r.total_due)}${r.total_due < 0 ? ' (you owe clients a refund)' : ''}.`,
        r.bookings.map((b) => `- #${b.booking_id} ${b.client}: due ${inr(b.due)}`)),
  },
  {
    name: 'get_payables',
    description: 'Money between you and HOUSEBOATS: how much you must pay each partner houseboat, what is already paid and what is pending. Pass houseboat_name for the per-booking breakdown of one houseboat.',
    write: false,
    parameters: { type: 'object', properties: { houseboat_name: S('Houseboat name (optional)') } },
    async run(ctx, a) {
      const hb = a.houseboat_name ? await findHouseboat(ctx, a.houseboat_name) : null;
      const rows = (await houseboatRows(ctx, hb?.id ?? null)).filter((h) => !h.is_own);
      const out = { houseboats: rows.map((h) => ({ houseboat: h.name, code: h.prefix, to_pay_total: h.payable, paid: h.paid, pending: h.pending, upcoming_rooms: h.upcoming_rooms })) };
      out.total_pending = rows.reduce((s, h) => s + h.pending, 0);
      if (hb && !hb.is_own) {
        const { all, byId } = await ownerLedger(ctx);
        const groups = new Map();
        for (const l of all) if (l.side === 'PARTNER' && l.houseboat_id === hb.id) { const k = l.booking_id ?? null; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
        const bIds = [...groups.keys()].filter((k) => k != null);
        const bk = new Map((bIds.length ? await col(ctx, 'bookings').find(byOwner(ctx, { id: { $in: bIds } })) : []).map((b) => [b.id, b]));
        out.by_booking = [...groups].map(([bid, list]) => { const m = moneyOf(list, byId); const b = bk.get(bid); return { booking_id: bid, client: b?.client_name ?? null, check_in: b?.check_in ?? null, check_out: b?.check_out ?? null, to_pay: m.billed, paid: m.received, pending: m.balance }; })
          .sort((x, y) => (x.check_in ?? '') < (y.check_in ?? '') ? -1 : (x.check_in ?? '') > (y.check_in ?? '') ? 1 : 0);
      }
      return out;
    },
    format: (r) =>
      lines(r.houseboats.length ? `To pay houseboats: ${inr(r.total_pending)} pending in total.` : 'No partner houseboats yet.',
        r.houseboats.map((h) => `- ${h.houseboat} (${h.code}): to pay ${inr(h.to_pay_total)}, paid ${inr(h.paid)}, pending ${inr(h.pending)}`),
        (r.by_booking || []).map((b) => `  · ${b.booking_id ? `#${b.booking_id} ${b.client}` : 'General payment'}: pending ${inr(b.pending)}`)),
  },
  {
    name: 'get_ledger',
    description: 'Most recent money entries (both client and houseboat side) with their ids, for corrections.',
    write: false,
    parameters: { type: 'object', properties: { limit: I('How many entries, default 10') } },
    run: (ctx, a) => recentLedger(ctx, Math.min(a.limit || 10, 30)),
    format: (r) => (r.length ? r.map((l) => `L${l.id} ${l.side === 'CLIENT' ? 'client' : 'houseboat'} ${l.type.toLowerCase()} ${inr(Math.abs(l.amount))} - ${l.client_name || l.houseboat || ''}`).join('\n') : 'No money entries yet.'),
  },

  /* ---------- WRITE tools (the owner must confirm each one) ---------- */
  {
    name: 'create_booking',
    description:
      'Create a client booking made of several rooms spread over houseboats. Needed: client_name, SENDER (who sent / brought the booking: an agent, company or person, or "Direct" if the guest booked directly - ALWAYS ask if the owner did not say it, never guess), check_in, check_out, and for every room the houseboat. Guests, price per night and meal plan per room are optional: if the owner says "skip" or does not know yet, leave them out and the room is saved with "details pending". Pass one item in "rooms" per room (8 rooms = 8 items). If the client asked for more rooms than are allocated now, pass rooms_required (e.g. 39 required, 31 given now). The system assigns each room a token (first 3 letters of the houseboat + number, like CUL001) and shows the owner a review popup. Calling it again replaces a booking that is still waiting for confirmation.',
    write: true,
    parameters: {
      type: 'object',
      properties: {
        client_name: S('Client or group name'),
        sender: S('Who sent / brought this booking (agent, company, person) or "Direct". Compulsory.'),
        phone: S('Client phone number (optional)'),
        check_in: DATE('Arrival date'),
        check_out: DATE('Departure date'),
        rooms: { type: 'array', description: 'One entry per room allocated now', items: ROOM_ITEM },
        rooms_required: I('Total rooms the client asked for, only if more rooms are still to be allocated later (optional)'),
        advance_paid: I('Advance received from the client now, rupees (optional)'),
        notes: S('Any note (optional)'),
      },
      required: ['client_name', 'sender', 'check_in', 'check_out', 'rooms'],
    },
    async prepare(ctx, a) {
      const sender = cleanSender(a.sender);
      if (!isDate(a.check_in) || !isDate(a.check_out)) throw new ToolError('Dates must look like YYYY-MM-DD.');
      if (a.check_out <= a.check_in) throw new ToolError('Check-out must be after check-in. Ask the owner for the check-out date or the number of nights.');
      const nightsList = nightsBetween(a.check_in, a.check_out);
      if (nightsList.length > MAX_NIGHTS) throw new ToolError(`Stays longer than ${MAX_NIGHTS} nights are not supported.`);
      const { boats, rooms, nights } = await planRooms(ctx, a.rooms, a.check_in, a.check_out);
      if (a.rooms_required !== undefined) {
        if (a.rooms_required < rooms.length) throw new ToolError(`You gave ${rooms.length} rooms but the client needs only ${a.rooms_required}. Please check the numbers.`);
        if (a.rooms_required > 500) throw new ToolError('Rooms required looks too high.');
      }
      const clientTotal = sum(rooms, (r) => r.price) * nights.length;
      const advance = a.advance_paid || 0;
      const pendingRooms = rooms.filter(isPending);
      if (advance < 0) throw new ToolError('Advance cannot be negative.');
      if (advance > clientTotal && !rooms.some((r) => r.price == null)) throw new ToolError(`Advance ${inr(advance)} is more than the client total ${inr(clientTotal)}.`);

      const left = a.rooms_required ? a.rooms_required - rooms.length : 0;
      const preview = {
        kind: 'booking',
        client: a.client_name, sender, phone: a.phone || null, check_in: a.check_in, check_out: a.check_out, nights: nights.length, notes: a.notes || null,
        houseboats: [...boats.values()].map((b) => {
          const rs = rooms.filter((r) => r.key === b.key);
          return { name: b.name, prefix: b.prefix, is_own: b.is_own, is_new: b.is_new, payable: sum(rs, (r) => r.cost) * nights.length, rooms: rs.map((r) => ({ token: r.token, guests: r.guests, meal_plan: r.meal_plan, price: r.price, cost: r.cost })) };
        }),
        totals: {
          rooms: rooms.length, guests: sum(rooms, (r) => r.guests), client_total: clientTotal, advance, client_due: clientTotal - advance, payable: sum(rooms, (r) => r.cost) * nights.length,
          required: a.rooms_required || null, left, pending_rooms: pendingRooms.map((r) => r.token),
        },
      };
      const summary = lines(
        `Book ${a.client_name} (sender: ${sender})${a.phone ? ` (${a.phone})` : ''}: ${prettyDate(a.check_in)} to ${prettyDate(a.check_out)} (${nights.length} night${nights.length > 1 ? 's' : ''})`,
        a.rooms_required ? `${a.rooms_required} rooms required, ${rooms.length} allocated now, ${left} left to allocate` : '',
        rooms.map((r) => roomLine(r)),
        `Client total ${inr(clientTotal)}${advance ? `, advance ${inr(advance)}, due ${inr(clientTotal - advance)}` : ''}`,
        pendingRooms.length ? `Details pending for: ${pendingRooms.map((r) => r.token).join(', ')}` : ''
      );
      return {
        args: { client_name: a.client_name, sender, phone: a.phone || null, check_in: a.check_in, check_out: a.check_out, notes: a.notes || null, advance, rooms_required: a.rooms_required || null, rooms: rooms.map((r) => ({ houseboat: r.houseboat, own: r.own, room_no: r.room_no, guests: r.guests, meal_plan: r.meal_plan, price: r.price, cost: r.cost })) },
        summary, preview,
      };
    },
    async run(ctx, a) {
      const sender = cleanSender(a.sender);
      const nights = nightsBetween(a.check_in, a.check_out);
      const bookingId = (await col(ctx, 'bookings').insert({ owner_id: ctx.ownerId, client_name: a.client_name, sender, phone: a.phone ?? null, check_in: a.check_in, check_out: a.check_out, notes: a.notes ?? null, rooms_required: a.rooms_required ?? null, status: 'confirmed', cancelled_at: null })).id;
      const saved = await saveRooms(ctx, bookingId, a.rooms, nights);
      const { clientAmount, payables } = await chargeRooms(ctx, bookingId, saved, nights.length, `Booking #${bookingId}`);
      if (a.advance) await addLedger(ctx, { booking: bookingId, side: 'CLIENT', type: 'PAYMENT', amount: -a.advance, method: 'advance', note: `Advance for booking #${bookingId}` });
      const nameOf = new Map(saved.map((r) => [r.houseboat_id, r.houseboat]));
      return {
        booking_id: bookingId, client: a.client_name, sender, phone: a.phone, check_in: a.check_in, check_out: a.check_out, nights: nights.length, rooms: saved,
        client_total: clientAmount, advance: a.advance, rooms_required: a.rooms_required ?? null, pending: saved.filter(isPending).map((r) => r.token),
        payables: payables.map((p) => ({ houseboat: nameOf.get(p.houseboat_id), amount: p.amount })),
      };
    },
    confirmText: (r) =>
      lines(
        `Done. Booking #${r.booking_id} saved for ${r.client}${r.phone ? ` (${r.phone})` : ''}, sender ${r.sender}, ${prettyDate(r.check_in)} to ${prettyDate(r.check_out)} (${r.nights} night${r.nights > 1 ? 's' : ''}).`,
        r.rooms_required ? `Rooms: ${r.rooms_required} required, ${r.rooms.length} allocated${r.rooms_required > r.rooms.length ? `, ${r.rooms_required - r.rooms.length} left to allocate` : ''}.` : '',
        'Room tokens:',
        r.rooms.map((x) => `- ${roomLine(x)}`),
        `Client total ${inr(r.client_total)}${r.advance ? `, advance ${inr(r.advance)} received, due ${inr(r.client_total - r.advance)}` : ''}.`,
        r.payables.length ? `To pay houseboats: ${r.payables.map((p) => `${p.houseboat} ${inr(p.amount)}`).join(', ')}.` : '',
        r.pending.length ? `Details pending for ${r.pending.join(', ')} - tell me when you have them.` : ''
      ),
  },
  {
    name: 'update_room',
    description: 'Change one room of an existing booking, found by booking_id and token (like CUL001): number of guests, meal plan, price per night for the client, or what the houseboat charges. Also used to fill in details that were skipped earlier. Money entries are adjusted automatically.',
    write: true,
    parameters: {
      type: 'object',
      properties: {
        booking_id: I('Booking number'),
        token: S('Room token, e.g. CUL001'),
        guests: I('New number of guests in this room'),
        meal_plan: MEAL('New meal plan'),
        price: I('New price per night charged to the client'),
        partner_price: I('New price per night the houseboat charges you'),
      },
      required: ['booking_id', 'token'],
    },
    async prepare(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      if (b.status === 'cancelled') throw new ToolError(`Booking #${b.id} is cancelled.`);
      const r = await roomWithBoat(ctx, b.id, a.token);
      if (!r) throw new ToolError(`Booking #${b.id} has no room ${a.token}.`);
      const n = nightsOf(b);
      const ch = [];
      if (a.guests !== undefined) { if (!(a.guests >= 1 && a.guests <= 20)) throw new ToolError('Guests must be 1 to 20.'); ch.push(`guests ${r.guests ?? 'pending'} -> ${a.guests}`); }
      if (a.meal_plan) ch.push(`meal plan ${r.meal_plan ?? 'pending'} -> ${a.meal_plan}`);
      if (a.price !== undefined) { if (a.price < 0) throw new ToolError('Price cannot be negative.'); const d = (a.price - (r.price ?? 0)) * n; ch.push(`client price ${r.price == null ? 'pending' : inr(r.price)} -> ${inr(a.price)}/night (client total ${d >= 0 ? '+' : '-'}${inr(Math.abs(d))})`); }
      if (a.partner_price !== undefined) {
        if (r.is_own) throw new ToolError(`${r.houseboat} is your own houseboat, so there is nothing to pay it.`);
        ch.push(`houseboat price ${inr(r.cost)} -> ${inr(a.partner_price)}/night`);
      }
      if (!ch.length) throw new ToolError('Nothing to change. Tell me the new guests, meal plan or price.');
      return { args: { ...a, booking_id: b.id, token: r.token }, summary: `Update ${r.token} (${r.houseboat}) in booking #${b.id} - ${b.client_name}: ${ch.join('; ')}`, preview: { kind: 'simple', title: `Update ${r.token}`, lines: ch } };
    },
    async run(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      const r = await col(ctx, 'booking_rooms').one(byOwner(ctx, { booking_id: b.id, token: upper(a.token) }));
      if (!r) throw new ToolError(`Room ${a.token} was not found.`);
      const hb = await col(ctx, 'houseboats').one(byOwner(ctx, { id: r.houseboat_id }));
      const n = nightsOf(b);
      const guests = a.guests ?? r.guests; const plan = a.meal_plan ?? r.meal_plan; const price = a.price ?? r.price;
      const cost = hb.is_own ? 0 : (a.partner_price ?? (a.price !== undefined && r.cost === (r.price ?? 0) ? a.price : r.cost));
      await col(ctx, 'booking_rooms').update(byOwner(ctx, { id: r.id }), { $set: { guests: guests ?? null, meal_plan: plan ?? null, price: price ?? null, cost } });
      if ((price ?? 0) !== (r.price ?? 0)) await addLedger(ctx, { booking: b.id, side: 'CLIENT', type: 'CHARGE', amount: ((price ?? 0) - (r.price ?? 0)) * n, note: `Price change ${r.token}: ${r.price ?? 'pending'} to ${price} per night` });
      if (cost !== r.cost) await addLedger(ctx, { booking: b.id, houseboat: hb.id, side: 'PARTNER', type: 'CHARGE', amount: (cost - r.cost) * n, note: `Houseboat price change ${r.token}` });
      return { booking_id: b.id, token: r.token, guests, meal_plan: plan, price, pending: isPending({ guests, meal_plan: plan, price }) };
    },
    confirmText: (r) => `Done. ${r.token} in booking #${r.booking_id} updated: ${gTxt(r.guests)}, ${mTxt(r.meal_plan)}, ${pTxt(r.price)}.${r.pending ? ' Some details are still pending.' : ''}`,
  },
  {
    name: 'set_meal_plans',
    description: 'Change the MEAL PLAN of MANY rooms in one go. Use this whenever the owner gives meal plans for several houseboats at once (e.g. "on 28 December Flower Garden EP, Chinar CP, Helen of Troy AP") or says one plan for all rooms. Rooms are found by date (every confirmed booking that has a guest staying that night) and/or booking number, then by houseboat. Put EVERY houseboat the owner mentioned in "changes", all in ONE call. For a single room use update_room.',
    write: true,
    parameters: {
      type: 'object',
      properties: {
        date: DATE('The night the rooms are booked for (e.g. "on 28 December"). Every confirmed booking staying that night is included.'),
        booking_id: I('Only rooms of this booking number (optional)'),
        meal_plan: MEAL('One meal plan for ALL rooms in scope, when the owner does not name houseboats (optional)'),
        changes: {
          type: 'array',
          description: 'One item per houseboat the owner named, each with its meal plan',
          items: { type: 'object', properties: { houseboat: S('Houseboat name as the owner says it'), meal_plan: MEAL('Meal plan for this houseboat\'s rooms') }, required: ['houseboat', 'meal_plan'] },
        },
      },
    },
    async prepare(ctx, a) {
      if (!a.date && !a.booking_id) throw new ToolError('For which date or booking number should I change the meal plans?');
      if (!a.changes?.length && !a.meal_plan) throw new ToolError('Tell me the meal plan for each houseboat, for example "Chinar CP, Sunrise EP".');
      const bq = byOwner(ctx, { status: 'confirmed' });
      if (a.booking_id) bq.id = (await getBooking(ctx, a.booking_id)).id;
      if (a.date) { bq.check_in = { $lte: a.date }; bq.check_out = { $gt: a.date }; }
      const bk = new Map((await col(ctx, 'bookings').find(bq)).map((b) => [b.id, b]));
      const known = await allHouseboats(ctx);
      const boatOf = new Map(known.map((h) => [h.id, h]));
      const rooms = (bk.size ? await col(ctx, 'booking_rooms').find(byOwner(ctx, { booking_id: { $in: [...bk.keys()] } })) : [])
        .filter((r) => boatOf.has(r.houseboat_id))
        .map((r) => ({ booking_id: r.booking_id, token: r.token, meal_plan: r.meal_plan ?? null, houseboat_id: r.houseboat_id, houseboat: boatOf.get(r.houseboat_id).name, client_name: bk.get(r.booking_id).client_name }))
        .sort((x, y) => (x.houseboat < y.houseboat ? -1 : x.houseboat > y.houseboat ? 1 : x.token < y.token ? -1 : x.token > y.token ? 1 : 0));
      const scope = a.date ? `on ${prettyDate(a.date)}` : `in booking #${a.booking_id}`;
      if (!rooms.length) throw new ToolError(`I found no booked rooms ${scope}.`);
      const plans = new Map(); const notes = [];
      if (a.meal_plan) for (const r of rooms) plans.set(`${r.booking_id}|${r.token}`, a.meal_plan);
      for (const c of a.changes || []) {
        const hb = await matchHouseboat(ctx, c.houseboat, known);
        if (!hb) { notes.push(`I do not know a houseboat called "${c.houseboat}", so it was left out. Known: ${known.map((x) => x.name).join(', ') || 'none'}.`); continue; }
        const mine = rooms.filter((r) => r.houseboat_id === hb.id);
        if (!mine.length) { notes.push(`${hb.name} has no booked rooms ${scope}.`); continue; }
        for (const r of mine) plans.set(`${r.booking_id}|${r.token}`, c.meal_plan);
      }
      const updates = []; const same = []; const byBoat = new Map();
      for (const r of rooms) {
        const plan = plans.get(`${r.booking_id}|${r.token}`);
        if (!plan) continue;
        if (r.meal_plan === plan) { same.push(r.token); continue; }
        updates.push({ booking_id: r.booking_id, token: r.token, meal_plan: plan });
        const key = `${r.houseboat}|${plan}`;
        if (!byBoat.has(key)) byBoat.set(key, { houseboat: r.houseboat, plan, items: [] });
        byBoat.get(key).items.push(`${r.token} (#${r.booking_id} ${r.client_name}${r.meal_plan ? `, was ${r.meal_plan}` : ''})`);
      }
      if (!updates.length) throw new ToolError(same.length ? `Those rooms already have that meal plan (${same.join(', ')}). Nothing to change.` : `No rooms matched. ${notes.join(' ')}`.trim());
      const lns = [...byBoat.values()].map((g) => `${g.houseboat} -> ${g.plan}: ${g.items.join(', ')}`);
      if (same.length) lns.push(`Already correct, not changed: ${same.join(', ')}.`);
      lns.push(...notes);
      const title = `Change meal plan of ${updates.length} room${updates.length === 1 ? '' : 's'} ${scope}`;
      return { args: { updates }, summary: lines(title, lns), preview: { kind: 'simple', title, lines: lns } };
    },
    async run(ctx, a) {
      let count = 0; const tally = new Map();
      for (const u of a.updates || []) {
        const b = await col(ctx, 'bookings').one(byOwner(ctx, { id: u.booking_id, status: 'confirmed' }));
        const r = b ? await roomWithBoat(ctx, b.id, u.token) : null;
        if (!r) throw new ToolError(`Room ${u.token} of booking #${u.booking_id} was not found.`);
        await col(ctx, 'booking_rooms').update(byOwner(ctx, { id: r.id }), { $set: { meal_plan: u.meal_plan } });
        count++;
        const k = `${r.houseboat} ${u.meal_plan}`; tally.set(k, (tally.get(k) || 0) + 1);
      }
      return { count, summary: [...tally].map(([k, n]) => `${k} (${n})`).join(', ') };
    },
    confirmText: (r) => `Done. Meal plan changed for ${r.count} room${r.count === 1 ? '' : 's'}: ${r.summary}.`,
  },
  {
    name: 'update_booking',
    description: 'Change the booking itself: check-in and/or check-out dates (every room keeps its token and is re-checked for clashes; money is adjusted for the new number of nights), sender, client name, phone, notes, or rooms_required (how many rooms the client needs in total). Found by booking_id.',
    write: true,
    parameters: {
      type: 'object',
      properties: {
        booking_id: I('Booking number'),
        check_in: DATE('New arrival date (optional)'),
        check_out: DATE('New departure date (optional)'),
        sender: S('New sender name (optional)'),
        client_name: S('New client name (optional)'),
        phone: S('New phone (optional)'),
        rooms_required: I('Total rooms the client needs (optional)'),
        notes: S('New note (optional)'),
      },
      required: ['booking_id'],
    },
    async prepare(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      if (b.status === 'cancelled') throw new ToolError(`Booking #${b.id} is cancelled.`);
      const ci = a.check_in || b.check_in; const co = a.check_out || b.check_out;
      if (!isDate(ci) || !isDate(co)) throw new ToolError('Dates must look like YYYY-MM-DD.');
      if (co <= ci) throw new ToolError('Check-out must be after check-in.');
      const nNew = nightsBetween(ci, co).length;
      if (nNew > MAX_NIGHTS) throw new ToolError(`Stays longer than ${MAX_NIGHTS} nights are not supported.`);
      const rooms = (await bookingRows(ctx, { bookingId: b.id }))[0].rooms;
      const ch = [];
      const patch = {};
      const datesChanged = ci !== b.check_in || co !== b.check_out;
      if (datesChanged) {
        const rr = await col(ctx, 'booking_rooms').find(byOwner(ctx, { booking_id: b.id }));
        for (const x of rr) {
          const taken = await col(ctx, 'room_night_locks').find({ houseboat_id: x.houseboat_id, room_no: x.room_no, stay_date: { $gte: ci, $lt: co }, booking_id: { $ne: b.id } }, { sort: { stay_date: 1 }, limit: 1 });
          if (taken.length) throw new ToolError(`${x.token} is already booked by another booking on ${prettyDate(taken[0].stay_date)}. Choose other dates, or move that room first.`);
        }
        const nOld = nightsOf(b);
        const dClient = sum(rooms, (r) => r.price) * (nNew - nOld);
        ch.push(`dates ${prettyDate(b.check_in)} - ${prettyDate(b.check_out)} -> ${prettyDate(ci)} - ${prettyDate(co)} (${nOld} -> ${nNew} nights)`);
        if (dClient) ch.push(`client total ${dClient > 0 ? '+' : '-'}${inr(Math.abs(dClient))}`);
        const per = new Map();
        for (const r of rooms) if (r.cost) per.set(r.houseboat, (per.get(r.houseboat) || 0) + r.cost * (nNew - nOld));
        for (const [name, d] of per) if (d) ch.push(`you owe ${name} ${d > 0 ? '+' : '-'}${inr(Math.abs(d))}`);
        patch.check_in = ci; patch.check_out = co;
      }
      if (a.sender !== undefined) { const s = cleanSender(a.sender); ch.push(`sender ${b.sender || 'none'} -> ${s}`); patch.sender = s; }
      if (a.client_name) { ch.push(`client ${b.client_name} -> ${a.client_name}`); patch.client_name = a.client_name; }
      if (a.phone) { ch.push(`phone -> ${a.phone}`); patch.phone = a.phone; }
      if (a.notes) { ch.push('note updated'); patch.notes = a.notes; }
      if (a.rooms_required !== undefined) {
        if (a.rooms_required < rooms.length) throw new ToolError(`${rooms.length} rooms are already allocated, so rooms required cannot be less than that.`);
        ch.push(`rooms required ${b.rooms_required ?? 'not set'} -> ${a.rooms_required} (${rooms.length} allocated, ${a.rooms_required - rooms.length} left)`);
        patch.rooms_required = a.rooms_required;
      }
      if (!ch.length) throw new ToolError('Nothing to change. Tell me the new dates, sender, name or phone.');
      return { args: { booking_id: b.id, ...patch }, summary: lines(`Change booking #${b.id} - ${b.client_name}:`, ch), preview: { kind: 'simple', title: `Change booking #${b.id} - ${b.client_name}`, lines: ch } };
    },
    async run(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      const { booking_id: _id, ...patch } = a;
      const cols = Object.keys(patch).filter((k) => ['check_in', 'check_out', 'sender', 'client_name', 'phone', 'notes', 'rooms_required'].includes(k));
      if (patch.sender !== undefined) patch.sender = cleanSender(patch.sender);
      if (cols.length) await col(ctx, 'bookings').update(byOwner(ctx, { id: b.id }), { $set: Object.fromEntries(cols.map((c) => [c, patch[c]])) });
      if (patch.check_in || patch.check_out) {
        const nOld = nightsOf(b);
        const nights = nightsBetween(patch.check_in || b.check_in, patch.check_out || b.check_out);
        const rooms = await col(ctx, 'booking_rooms').find(byOwner(ctx, { booking_id: b.id }));
        await col(ctx, 'room_night_locks').remove(byOwner(ctx, { booking_id: b.id }));
        for (const r of rooms) for (const d of nights) await lockNight(ctx, r.houseboat_id, r.room_no, d, b.id, r.token);
        const diff = nights.length - nOld;
        if (diff) {
          await chargeRooms(ctx, b.id, rooms, diff, `Dates changed to ${patch.check_in || b.check_in} - ${patch.check_out || b.check_out}`);
        }
      }
      await audit(ctx, 'booking_edit_detail', JSON.stringify(patch).slice(0, 300));
      const row = (await bookingRows(ctx, { bookingId: b.id }))[0];
      return { booking_id: b.id, client: row.client_name, check_in: row.check_in, check_out: row.check_out, nights: row.nights, sender: row.sender, client_total: row.billed, client_due: row.balance, rooms_required: row.rooms_required };
    },
    confirmText: (r) => `Done. Booking #${r.booking_id} (${r.client}) updated: ${prettyDate(r.check_in)} to ${prettyDate(r.check_out)} (${r.nights} night${r.nights > 1 ? 's' : ''}), sender ${r.sender || 'not set'}. Client total ${inr(r.client_total)}, due ${inr(r.client_due)}.`,
  },
  {
    name: 'add_rooms',
    description: 'Add more rooms to an existing booking (same dates). Pass booking_id and one item in "rooms" per new room (houseboat, and optionally guests, price, meal plan; skipped details stay pending). Tokens are assigned automatically.',
    write: true,
    parameters: {
      type: 'object',
      properties: { booking_id: I('Booking number'), rooms: { type: 'array', description: 'The new rooms', items: ROOM_ITEM } },
      required: ['booking_id', 'rooms'],
    },
    async prepare(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      if (b.status === 'cancelled') throw new ToolError(`Booking #${b.id} is cancelled.`);
      const { rooms, nights } = await planRooms(ctx, a.rooms, b.check_in, b.check_out);
      const have = await col(ctx, 'booking_rooms').count(byOwner(ctx, { booking_id: b.id }));
      const total = have + rooms.length;
      if (total > MAX_ROOMS * 5) throw new ToolError('Too many rooms in one booking.');
      const dClient = sum(rooms, (r) => r.price) * nights.length;
      const lns = [
        ...rooms.map((r) => roomLine(r)),
        dClient ? `Client total +${inr(dClient)}.` : '',
        b.rooms_required ? `Rooms: ${total} allocated of ${b.rooms_required} required${total > b.rooms_required ? ' (more than required)' : `, ${b.rooms_required - total} left`}.` : `Booking will have ${total} rooms.`,
      ].filter(Boolean);
      return {
        args: { booking_id: b.id, rooms: rooms.map((r) => ({ houseboat: r.houseboat, own: r.own, room_no: r.room_no, guests: r.guests, meal_plan: r.meal_plan, price: r.price, cost: r.cost })) },
        summary: lines(`Add ${rooms.length} room${rooms.length > 1 ? 's' : ''} to booking #${b.id} - ${b.client_name}:`, lns), preview: { kind: 'simple', title: `Add rooms to booking #${b.id} - ${b.client_name}`, lines: lns },
      };
    },
    async run(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      const nights = nightsBetween(b.check_in, b.check_out);
      const saved = await saveRooms(ctx, b.id, a.rooms, nights);
      await chargeRooms(ctx, b.id, saved, nights.length, `Rooms added to booking #${b.id}`);
      const row = (await bookingRows(ctx, { bookingId: b.id }))[0];
      return { booking_id: b.id, added: saved, allocated: row.rooms_allocated, required: row.rooms_required, client_total: row.billed, client_due: row.balance };
    },
    confirmText: (r) =>
      lines(`Done. ${r.added.length} room${r.added.length > 1 ? 's' : ''} added to booking #${r.booking_id}:`, r.added.map((x) => `- ${roomLine(x)}`),
        `Now ${r.allocated} rooms${r.required ? ` of ${r.required} required` : ''}. Client total ${inr(r.client_total)}, due ${inr(r.client_due)}.`),
  },
  {
    name: 'remove_room',
    description: 'Remove one room (by token like CUL003) from a booking. The room becomes free and the client and houseboat charges for it are taken back. A booking must keep at least one room (cancel the booking instead).',
    write: true,
    parameters: { type: 'object', properties: { booking_id: I('Booking number'), token: S('Room token, e.g. CUL003') }, required: ['booking_id', 'token'] },
    async prepare(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      if (b.status === 'cancelled') throw new ToolError(`Booking #${b.id} is cancelled.`);
      const row = (await bookingRows(ctx, { bookingId: b.id }))[0];
      const r = row.rooms.find((x) => x.token.toLowerCase() === String(a.token).toLowerCase());
      if (!r) throw new ToolError(`Booking #${b.id} has no room ${a.token}.`);
      if (row.rooms.length === 1) throw new ToolError(`${r.token} is the only room in booking #${b.id}. Cancel the booking instead.`);
      const n = row.nights;
      const lns = [`${r.token} (${r.houseboat}) becomes free.`, r.price ? `Client total -${inr(r.price * n)}.` : '', r.cost ? `You owe ${r.houseboat} ${inr(r.cost * n)} less.` : ''].filter(Boolean);
      return { args: { booking_id: b.id, token: r.token }, summary: lines(`Remove ${r.token} from booking #${b.id} - ${b.client_name}`, lns), preview: { kind: 'simple', title: `Remove ${r.token} from booking #${b.id}`, lines: lns } };
    },
    async run(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      const r = await col(ctx, 'booking_rooms').one(byOwner(ctx, { booking_id: b.id, token: upper(a.token) }));
      if (!r) throw new ToolError(`Room ${a.token} was not found.`);
      const n = nightsOf(b);
      await col(ctx, 'room_night_locks').remove(byOwner(ctx, { booking_id: b.id, houseboat_id: r.houseboat_id, room_no: r.room_no }));
      await col(ctx, 'booking_rooms').remove(byOwner(ctx, { id: r.id }));
      if (r.price) await addLedger(ctx, { booking: b.id, side: 'CLIENT', type: 'CHARGE', amount: -r.price * n, note: `Room ${r.token} removed` });
      if (r.cost) await addLedger(ctx, { booking: b.id, houseboat: r.houseboat_id, side: 'PARTNER', type: 'CHARGE', amount: -r.cost * n, note: `Room ${r.token} removed` });
      const row = (await bookingRows(ctx, { bookingId: b.id }))[0];
      return { booking_id: b.id, token: r.token, rooms_left: row.rooms_allocated, client_total: row.billed, client_due: row.balance };
    },
    confirmText: (r) => `Done. ${r.token} removed from booking #${r.booking_id} and is free again. ${r.rooms_left} room${r.rooms_left > 1 ? 's' : ''} left. Client total ${inr(r.client_total)}, due ${inr(r.client_due)}.`,
  },
  {
    name: 'move_room',
    description: 'Move one room of a booking to another houseboat (or another room number on the same houseboat). The room gets a new token (first 3 letters of the new houseboat + number), the old room becomes free, and what you owe each houseboat is adjusted. Client price stays the same unless changed with update_room.',
    write: true,
    parameters: {
      type: 'object',
      properties: {
        booking_id: I('Booking number'),
        token: S('Current room token, e.g. CUL002'),
        to_houseboat: S('Houseboat to move the room to'),
        own: { type: 'boolean', description: 'true if the new houseboat is the owner\'s own (nothing to pay out)' },
        room_no: I('Room number on the new houseboat (optional, otherwise the lowest free)'),
        partner_price: I('What the new houseboat charges you per night (optional)'),
      },
      required: ['booking_id', 'token', 'to_houseboat'],
    },
    async prepare(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      if (b.status === 'cancelled') throw new ToolError(`Booking #${b.id} is cancelled.`);
      const r = await roomWithBoat(ctx, b.id, a.token);
      if (!r) throw new ToolError(`Booking #${b.id} has no room ${a.token}.`);
      const n = nightsOf(b);
      const nights = nightsBetween(b.check_in, b.check_out);
      const dest = await matchHouseboat(ctx, a.to_houseboat);
      const destName = dest ? dest.name : String(a.to_houseboat).trim();
      const destIsNew = !dest;
      const destPrefix = dest ? dest.prefix : await makePrefix(ctx, destName);
      const destOwn = dest ? !!dest.is_own || a.own === true : a.own === true || isOwnName(destName);
      const same = dest && dest.id === r.houseboat_id;
      if (same && !a.room_no) throw new ToolError(`${r.token} is already in ${r.houseboat}. Tell me the new room number, or another houseboat.`);
      const used = dest ? await usedRoomNos(ctx, dest.id, b.check_in, b.check_out) : new Set();
      let no = a.room_no;
      if (no) {
        if (no < 1 || no > 999) throw new ToolError('Room numbers must be between 1 and 999.');
        if (no > Math.min(dest?.total_rooms || MAX_ROOMS_PER_BOAT, MAX_ROOMS_PER_BOAT)) throw new ToolError(dest?.total_rooms ? `${destName} has only ${dest.total_rooms} rooms.` : tooManyMsg(destName, MAX_ROOMS_PER_BOAT));
        if (used.has(no)) throw new ToolError(`${destPrefix}${pad3(no)} is already in use on those dates.`);
      } else {
        no = 1; while (used.has(no)) no++;
        if (no > Math.min(dest?.total_rooms || MAX_ROOMS_PER_BOAT, MAX_ROOMS_PER_BOAT)) throw new ToolError(`${destName} has no free room on those dates. ${tooManyMsg(destName, Math.min(dest?.total_rooms || MAX_ROOMS_PER_BOAT, MAX_ROOMS_PER_BOAT))}`);
      }
      if (a.partner_price !== undefined && destOwn) throw new ToolError(`${destName} is your own houseboat, so there is nothing to pay it.`);
      const newCost = destOwn ? 0 : (a.partner_price ?? (r.is_own ? (r.price ?? 0) : r.cost));
      const newToken = `${destPrefix}${pad3(no)}`;
      const lns = [`${r.token} (${r.houseboat}) -> ${newToken} (${destName}${destIsNew ? ', new houseboat' : ''}). ${r.token} becomes free.`];
      if (r.cost) lns.push(`You owe ${r.houseboat} ${inr(r.cost * n)} less.`);
      if (newCost) lns.push(`You owe ${destName} ${inr(newCost * n)} more.`);
      if (destOwn && !r.is_own) lns.push(`${destName} is your own houseboat, so nothing is payable for this room.`);
      void nights;
      return { args: { booking_id: b.id, token: r.token, to_houseboat: destName, own: destOwn, room_no: no, cost: newCost }, summary: lines(`Move room in booking #${b.id} - ${b.client_name}:`, lns), preview: { kind: 'simple', title: `Move ${r.token} to ${destName}`, lines: lns } };
    },
    async run(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      const r = await col(ctx, 'booking_rooms').one(byOwner(ctx, { booking_id: b.id, token: upper(a.token) }));
      if (!r) throw new ToolError(`Room ${a.token} was not found.`);
      const n = nightsOf(b);
      const nights = nightsBetween(b.check_in, b.check_out);
      let dest = await boatByName(ctx, a.to_houseboat);
      if (!dest) dest = await insertHouseboat(ctx, { name: a.to_houseboat, prefix: await makePrefix(ctx, a.to_houseboat), is_own: a.own });
      else if (a.own && !dest.is_own) { await col(ctx, 'houseboats').update(byOwner(ctx, { id: dest.id }), { $set: { is_own: 1 } }); dest.is_own = 1; }
      const cost = dest.is_own ? 0 : (a.cost ?? 0);
      const token = `${dest.prefix}${pad3(a.room_no)}`;
      await col(ctx, 'room_night_locks').remove(byOwner(ctx, { booking_id: b.id, houseboat_id: r.houseboat_id, room_no: r.room_no }));
      for (const d of nights) await lockNight(ctx, dest.id, a.room_no, d, b.id, token);
      await col(ctx, 'booking_rooms').update(byOwner(ctx, { id: r.id }), { $set: { houseboat_id: dest.id, room_no: a.room_no, token, cost } });
      if (r.cost) await addLedger(ctx, { booking: b.id, houseboat: r.houseboat_id, side: 'PARTNER', type: 'CHARGE', amount: -r.cost * n, note: `Room ${r.token} moved to ${dest.name}` });
      if (cost) await addLedger(ctx, { booking: b.id, houseboat: dest.id, side: 'PARTNER', type: 'CHARGE', amount: cost * n, note: `Room ${r.token} moved here as ${token}` });
      return { booking_id: b.id, old_token: r.token, token, houseboat: dest.name };
    },
    confirmText: (r) => `Done. ${r.old_token} moved to ${r.houseboat} as ${r.token} (booking #${r.booking_id}). The old room is free.`,
  },
  {
    name: 'delete_all_bookings',
    description: 'DELETE EVERY booking of this owner (all rooms, night locks and all money entries) and start fresh. Houseboat names and total rooms stay. Use ONLY when the owner clearly asks to delete / clear all bookings or everything. To remove one booking use cancel_booking instead.',
    write: true,
    parameters: { type: 'object', properties: {} },
    async prepare(ctx) {
      const n = await col(ctx, 'bookings').count(byOwner(ctx));
      if (!n) throw new ToolError('There are no bookings to delete.');
      const rooms = await col(ctx, 'booking_rooms').count(byOwner(ctx));
      const entries = await col(ctx, 'ledger').count(byOwner(ctx));
      const m = (await moneyOverview(ctx)).totals;
      const lns = [
        `${n} booking${n === 1 ? '' : 's'}, ${rooms} room${rooms === 1 ? '' : 's'} and ${entries} money entr${entries === 1 ? 'y' : 'ies'} will be deleted for good.`,
        `This includes ${inr(m.received)} of client payments and ${inr(m.paid_out)} of houseboat payments recorded so far.`,
        'Your houseboats (names and total rooms) and your chat stay.',
        'This cannot be undone.',
      ];
      return { args: {}, summary: lines(`DELETE ALL bookings (${n})`, lns), preview: { kind: 'simple', title: 'Delete ALL bookings?', headline: `${n} booking${n === 1 ? '' : 's'}`, lines: lns } };
    },
    async run(ctx) {
      const count = (t) => col(ctx, t).count(byOwner(ctx));
      const out = { bookings: await count('bookings'), rooms: await count('booking_rooms'), entries: await count('ledger') };
      // the only place (with delete_booking) where money entries may be removed: the owner confirmed it
      await col(ctx, 'ledger').remove(byOwner(ctx), { ledgerWipe: true });
      await col(ctx, 'room_night_locks').remove(byOwner(ctx));
      await col(ctx, 'booking_rooms').remove(byOwner(ctx));
      await col(ctx, 'bookings').remove(byOwner(ctx));
      return out;
    },
    confirmText: (r) => `Done. All ${r.bookings} booking${r.bookings === 1 ? '' : 's'} (${r.rooms} rooms, ${r.entries} money entries) were deleted. You can start fresh.`,
  },
  {
    name: 'delete_booking',
    description: 'PERMANENTLY delete ONE booking with its rooms, night locks and all its money entries (use when the owner says delete / remove / hata booking N, e.g. a wrong or test booking). The booking disappears completely. If the owner only wants to cancel it but keep the record and the money history, use cancel_booking instead.',
    write: true,
    parameters: { type: 'object', properties: { booking_id: I('Booking number') }, required: ['booking_id'] },
    async prepare(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      const row = (await bookingRows(ctx, { bookingId: b.id }))[0];
      const entries = await col(ctx, 'ledger').count(byOwner(ctx, { booking_id: b.id }));
      const lns = [
        `${b.client_name}, ${prettyDate(b.check_in)} to ${prettyDate(b.check_out)}${row.rooms.length ? `, rooms ${row.rooms.map((r) => r.token).join(', ')}` : ''}.`,
        `The booking, its rooms and ${entries} money entr${entries === 1 ? 'y' : 'ies'} will be deleted for good.`,
      ];
      if (row.received > 0 || row.refunded > 0) lns.push(`This includes ${inr(row.received)} received from the client and ${inr(row.refunded)} refunded.`);
      const hp = row.houseboat_dues.filter((d) => d.paid > 0);
      if (hp.length) lns.push(`This includes payments to houseboats: ${hp.map((d) => `${d.houseboat} ${inr(d.paid)}`).join(', ')}.`);
      lns.push('The room tokens become free. This cannot be undone.');
      return { args: { booking_id: b.id }, summary: lines(`DELETE booking #${b.id} - ${b.client_name}`, lns), preview: { kind: 'simple', title: `Delete booking #${b.id}?`, headline: b.client_name, lines: lns } };
    },
    async run(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      const out = {
        booking_id: b.id, client: b.client_name,
        rooms: await col(ctx, 'booking_rooms').count(byOwner(ctx, { booking_id: b.id })),
        entries: await col(ctx, 'ledger').count(byOwner(ctx, { booking_id: b.id })),
      };
      await col(ctx, 'ledger').remove(byOwner(ctx, { booking_id: b.id }), { ledgerWipe: true });
      await col(ctx, 'room_night_locks').remove(byOwner(ctx, { booking_id: b.id }));
      await col(ctx, 'booking_rooms').remove(byOwner(ctx, { booking_id: b.id }));
      await col(ctx, 'bookings').remove(byOwner(ctx, { id: b.id }));
      return out;
    },
    confirmText: (r) => `Done. Booking #${r.booking_id} (${r.client}) was deleted with its ${r.rooms} room${r.rooms === 1 ? '' : 's'} and ${r.entries} money entr${r.entries === 1 ? 'y' : 'ies'}. Its room tokens are free.`,
  },
  {
    name: 'add_houseboats',
    description: 'Add one or MANY houseboats to the owner\'s list in ONE call (e.g. "add Chinar, Blue Sky (mine), Purple Sky and Red Sky"). Also use it to change the room count of a houseboat or mark it as the owner\'s own. Ask how many rooms each has (3 to 5) if the owner did not say; if he says skip, leave total_rooms out. A booking can also use a new houseboat name directly, so this is not needed before create_booking.',
    write: true,
    parameters: {
      type: 'object',
      properties: {
        houseboats: {
          type: 'array',
          description: 'One item per houseboat the owner named',
          items: { type: 'object', properties: { name: S('Houseboat name as the owner says it'), total_rooms: I('Number of rooms (1 to 5), if known'), own: { type: 'boolean', description: 'true if it belongs to the owner himself ("mine", "apna", "own")' } }, required: ['name'] },
        },
      },
      required: ['houseboats'],
    },
    async prepare(ctx, a) {
      const list = (a.houseboats || []).filter(Boolean);
      if (!list.length) throw new ToolError('Which houseboats should I add?');
      if (list.length > 30) throw new ToolError('Please add at most 30 houseboats at a time.');
      const seen = new Set(); const items = []; const lns = [];
      for (const b of list) {
        const { name, rooms } = cleanBoat(ctx, { name: b.name, total_rooms: b.total_rooms });
        if (seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        const old = await boatByName(ctx, name);
        const own = b.own === undefined || b.own === null ? Boolean(old?.is_own) : b.own === true; // an existing boat keeps its own/partner setting unless told
        const size = rooms ? `${rooms} room${rooms === 1 ? '' : 's'}` : (old?.total_rooms ? `${old.total_rooms} rooms` : 'rooms not set');
        lns.push(old ? `${old.name}: already in your list, will be updated (${size}${own ? ', your own' : ''}).` : `${name}: ${size}, ${own ? 'your own houseboat' : 'partner houseboat'}.`);
        items.push({ name: old ? old.name : name, total_rooms: rooms ?? undefined, own });
      }
      let fresh = 0; for (const i of items) if (!(await boatByName(ctx, i.name))) fresh++;
      const title = fresh === items.length ? `Add ${items.length} houseboat${items.length === 1 ? '' : 's'}?` : `Save ${items.length} houseboat${items.length === 1 ? '' : 's'}?`;
      return { args: { houseboats: items }, summary: lines(title, lns), preview: { kind: 'simple', title, headline: items.map((i) => i.name).join(', '), lines: lns } };
    },
    async run(ctx, a) {
      const out = [];
      for (const b of a.houseboats) out.push(await saveHouseboat(ctx, { name: b.name, total_rooms: b.total_rooms, is_own: b.own }));
      return { added: out.filter((r) => !r.updated).map((r) => `${r.name} (${r.prefix})`), updated: out.filter((r) => r.updated).map((r) => r.name) };
    },
    confirmText: (r) => `Done. ${[r.added.length ? `Added ${r.added.join(', ')}.` : '', r.updated.length ? `Updated ${r.updated.join(', ')}.` : ''].filter(Boolean).join(' ')} Room tokens use the 3 letters in brackets.`,
  },
  {
    name: 'delete_houseboat',
    description: 'Delete a houseboat NAME from the owner\'s list (use when the owner says delete / remove / hata a houseboat, e.g. one added by mistake). Only possible when the houseboat has no bookings at all; otherwise tell the owner to delete or move those bookings first.',
    write: true,
    parameters: { type: 'object', properties: { houseboat: S('Houseboat name') }, required: ['houseboat'] },
    async prepare(ctx, a) {
      const hb = await findHouseboat(ctx, a.houseboat);
      const used = new Set((await col(ctx, 'booking_rooms').find(byOwner(ctx, { houseboat_id: hb.id }))).map((r) => r.booking_id)).size;
      const led = await col(ctx, 'ledger').count(byOwner(ctx, { houseboat_id: hb.id }));
      if (used) throw new ToolError(`${hb.name} is used in ${used} booking${used === 1 ? '' : 's'}, so it cannot be deleted. Delete or move those bookings first (for example "delete booking 3"), then delete ${hb.name}.`);
      if (led) throw new ToolError(`${hb.name} still has ${led} money entr${led === 1 ? 'y' : 'ies'}, so it cannot be deleted.`);
      const lns = [`${hb.name} (${hb.prefix}) will be removed from your houseboat list.`, 'It has no bookings, so no booking or money is affected.', 'You can add it again any time.'];
      return { args: { houseboat: hb.name }, summary: lines(`Delete houseboat ${hb.name}`, lns), preview: { kind: 'simple', title: `Delete ${hb.name}?`, headline: hb.name, lines: lns } };
    },
    async run(ctx, a) {
      const hb = await findHouseboat(ctx, a.houseboat);
      const used = await col(ctx, 'booking_rooms').count(byOwner(ctx, { houseboat_id: hb.id }));
      const led = await col(ctx, 'ledger').count(byOwner(ctx, { houseboat_id: hb.id }));
      if (used || led) throw new ToolError(`${hb.name} now has bookings or money entries, so it cannot be deleted.`);
      await col(ctx, 'houseboats').remove(byOwner(ctx, { id: hb.id }));
      return { name: hb.name };
    },
    confirmText: (r) => `Done. ${r.name} was deleted from your houseboats.`,
  },
  {
    name: 'cancel_booking',
    description: 'Cancel a booking: frees all its room tokens and reverses what the client and the houseboats were charged. Money already received or paid stays in the ledger.',
    write: true,
    parameters: { type: 'object', properties: { booking_id: I('Booking number'), reason: S('Reason (optional)') }, required: ['booking_id'] },
    async prepare(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      if (b.status === 'cancelled') throw new ToolError(`Booking #${b.id} is already cancelled.`);
      const row = (await bookingRows(ctx, { bookingId: b.id }))[0];
      const lns = [`Rooms ${row.rooms.map((r) => r.token).join(', ')} are freed.`, `The client charge of ${inr(row.billed)} is reversed.`];
      if (row.received - row.refunded > 0) lns.push(`The client has paid ${inr(row.received - row.refunded)}, which becomes a refund due.`);
      const hp = row.houseboat_dues.filter((d) => d.paid > 0);
      if (hp.length) lns.push(`You already paid ${hp.map((d) => `${d.houseboat} ${inr(d.paid)}`).join(', ')}; this will show as money to get back.`);
      return { args: a, summary: lines(`Cancel booking #${b.id} - ${b.client_name}, ${prettyDate(b.check_in)} to ${prettyDate(b.check_out)}`, lns), preview: { kind: 'simple', title: `Cancel booking #${b.id} - ${b.client_name}`, lines: lns } };
    },
    async run(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      if (b.status === 'cancelled') throw new ToolError(`Booking #${b.id} is already cancelled.`);
      await col(ctx, 'room_night_locks').remove(byOwner(ctx, { booking_id: b.id }));
      await col(ctx, 'bookings').update(byOwner(ctx, { id: b.id }), { $set: { status: 'cancelled', cancelled_at: nowIso() } });
      const entries = await col(ctx, 'ledger').find(byOwner(ctx, { booking_id: b.id }), { sort: { id: 1 } });
      const reversed = new Set(entries.map((l) => l.ref_id).filter((x) => x != null));
      for (const c of entries.filter((l) => l.type === 'CHARGE' && !reversed.has(l.id))) await addLedger(ctx, { booking: b.id, houseboat: c.houseboat_id ?? null, side: c.side, type: 'REVERSAL', amount: -c.amount, ref: c.id, note: a.reason ? `Cancelled: ${a.reason}` : 'Booking cancelled' });
      const row = (await bookingRows(ctx, { bookingId: b.id }))[0];
      return { booking_id: b.id, client: b.client_name, refund_due: Math.max(-row.balance, 0) };
    },
    confirmText: (r) => `Done. Booking #${r.booking_id} (${r.client}) is cancelled and its room tokens are free.${r.refund_due ? ` Refund due to client: ${inr(r.refund_due)}.` : ''}`,
  },
  {
    name: 'record_client_payment',
    description: 'Record money RECEIVED from a client for a booking.',
    write: true,
    parameters: {
      type: 'object',
      properties: { booking_id: I('Booking number'), amount: I('Amount received in rupees'), method: S('cash, upi, bank, card (optional)'), note: S('Note (optional)') },
      required: ['booking_id', 'amount'],
    },
    async prepare(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      if (!(a.amount > 0)) throw new ToolError('Amount must be more than zero.');
      if (b.status === 'cancelled') throw new ToolError(`Booking #${b.id} is cancelled. Use a refund instead.`);
      const row = (await bookingRows(ctx, { bookingId: b.id }))[0];
      const after = row.balance - a.amount;
      const lns = [`Client due goes from ${inr(row.balance)} to ${inr(after)}.`, after < 0 ? `Warning: this is ${inr(-after)} more than what is due.` : ''].filter(Boolean);
      return { args: a, summary: lines(`Received ${inr(a.amount)}${a.method ? ` (${a.method})` : ''} from ${b.client_name} for booking #${b.id}`, lns), preview: { kind: 'simple', title: `Payment received from ${b.client_name}`, headline: inr(a.amount), lines: lns } };
    },
    async run(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      const lid = await addLedger(ctx, { booking: b.id, side: 'CLIENT', type: 'PAYMENT', amount: -a.amount, method: a.method, note: a.note });
      const row = (await bookingRows(ctx, { bookingId: b.id }))[0];
      return { ledger_id: lid, booking_id: b.id, client: b.client_name, amount: a.amount, due: row.balance };
    },
    confirmText: (r) => `Done. Received ${inr(r.amount)} from ${r.client} (booking #${r.booking_id}). Client due now ${inr(r.due)}.`,
  },
  {
    name: 'record_client_refund',
    description: 'Record money paid BACK to a client (for example after a cancellation).',
    write: true,
    parameters: {
      type: 'object',
      properties: { booking_id: I('Booking number'), amount: I('Amount refunded in rupees'), method: S('cash, upi, bank (optional)'), note: S('Note (optional)') },
      required: ['booking_id', 'amount'],
    },
    async prepare(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      if (!(a.amount > 0)) throw new ToolError('Amount must be more than zero.');
      const row = (await bookingRows(ctx, { bookingId: b.id }))[0];
      const held = row.received - row.refunded;
      if (a.amount > held) throw new ToolError(`Only ${inr(held)} was received and not yet refunded for booking #${b.id}.`);
      const lns = [`Client due goes from ${inr(row.balance)} to ${inr(row.balance + a.amount)}.`];
      return { args: a, summary: lines(`Refund ${inr(a.amount)} to ${b.client_name} for booking #${b.id}`, lns), preview: { kind: 'simple', title: `Refund to ${b.client_name}`, headline: inr(a.amount), lines: lns } };
    },
    async run(ctx, a) {
      const b = await getBooking(ctx, a.booking_id);
      await addLedger(ctx, { booking: b.id, side: 'CLIENT', type: 'REFUND', amount: a.amount, method: a.method, note: a.note });
      const row = (await bookingRows(ctx, { bookingId: b.id }))[0];
      return { booking_id: b.id, client: b.client_name, amount: a.amount, due: row.balance };
    },
    confirmText: (r) => `Done. Refund of ${inr(r.amount)} recorded for ${r.client} (booking #${r.booking_id}). Client due now ${inr(r.due)}.`,
  },
  {
    name: 'record_houseboat_payment',
    description: 'Record money you PAID to a partner houseboat. booking_id is optional (leave it out for a general payment).',
    write: true,
    parameters: {
      type: 'object',
      properties: { houseboat_name: S('Houseboat paid'), amount: I('Amount paid in rupees'), booking_id: I('Booking it is for (optional)'), method: S('cash, upi, bank (optional)'), note: S('Note (optional)') },
      required: ['houseboat_name', 'amount'],
    },
    async prepare(ctx, a) {
      const hb = await findHouseboat(ctx, a.houseboat_name);
      if (hb.is_own) throw new ToolError(`${hb.name} is your own houseboat; there is nothing to pay.`);
      if (!(a.amount > 0)) throw new ToolError('Amount must be more than zero.');
      if (a.booking_id) await getBooking(ctx, a.booking_id);
      const row = (await houseboatRows(ctx, hb.id))[0];
      const after = row.pending - a.amount;
      const lns = [`You owe ${hb.name}: ${inr(row.pending)} now, ${inr(after)} after this payment.`, after < 0 ? `Warning: this is ${inr(-after)} more than what you owe.` : ''].filter(Boolean);
      return { args: { ...a, houseboat_name: hb.name }, summary: lines(`Paid ${inr(a.amount)} to ${hb.name}${a.booking_id ? ` for booking #${a.booking_id}` : ''}`, lns), preview: { kind: 'simple', title: `Payment to ${hb.name}`, headline: inr(a.amount), lines: lns } };
    },
    async run(ctx, a) {
      const hb = await findHouseboat(ctx, a.houseboat_name);
      if (a.booking_id) await getBooking(ctx, a.booking_id);
      await addLedger(ctx, { booking: a.booking_id || null, houseboat: hb.id, side: 'PARTNER', type: 'PAYMENT', amount: -a.amount, method: a.method, note: a.note });
      return { houseboat: hb.name, amount: a.amount, pending: (await houseboatRows(ctx, hb.id))[0].pending };
    },
    confirmText: (r) => `Done. Paid ${inr(r.amount)} to ${r.houseboat}. You still owe them ${inr(r.pending)}.`,
  },
  {
    name: 'reverse_ledger_entry',
    description: 'Undo a wrongly entered payment or refund by adding an offsetting reversal entry (entries are never edited or deleted). Needs the ledger id from get_ledger.',
    write: true,
    parameters: { type: 'object', properties: { ledger_id: I('Ledger entry id'), reason: S('Why (optional)') }, required: ['ledger_id'] },
    async prepare(ctx, a) {
      const e = await col(ctx, 'ledger').one(byOwner(ctx, { id: a.ledger_id }));
      if (!e) throw new ToolError(`Ledger entry L${a.ledger_id} was not found.`);
      if (e.type === 'REVERSAL') throw new ToolError('A reversal cannot be reversed.');
      if (e.type === 'CHARGE') throw new ToolError('To remove a charge, cancel the booking instead.');
      if (await col(ctx, 'ledger').one(byOwner(ctx, { ref_id: e.id }))) throw new ToolError(`L${e.id} was already reversed.`);
      const lns = ['A new offsetting entry is added. The original stays visible in the ledger.'];
      return { args: a, summary: `Reverse ${e.side === 'CLIENT' ? 'client' : 'houseboat'} ${e.type.toLowerCase()} L${e.id} of ${inr(Math.abs(e.amount))}`, preview: { kind: 'simple', title: `Reverse entry L${e.id}`, headline: inr(Math.abs(e.amount)), lines: lns } };
    },
    async run(ctx, a) {
      const e = await col(ctx, 'ledger').one(byOwner(ctx, { id: a.ledger_id }));
      if (!e || await col(ctx, 'ledger').one(byOwner(ctx, { ref_id: e.id }))) throw new ToolError('That entry cannot be reversed.');
      await addLedger(ctx, { booking: e.booking_id ?? null, houseboat: e.houseboat_id ?? null, side: e.side, type: 'REVERSAL', amount: -e.amount, ref: e.id, note: a.reason || 'Corrected entry' });
      return { ledger_id: e.id, amount: Math.abs(e.amount) };
    },
    confirmText: (r) => `Done. Entry L${r.ledger_id} (${inr(r.amount)}) has been reversed.`,
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// What Gemini sees (function declarations).
// Gemini rejects schema keys it does not know (our own "aliases" helper, for example), so only standard keys are sent.
const GEMINI_KEYS = new Set(['type', 'description', 'enum', 'properties', 'required', 'items']);
function cleanSchema(node) {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (!GEMINI_KEYS.has(k)) continue;
    // inside "properties" the keys are field names, not schema keywords
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([n, def]) => [n, cleanSchema(def)])) : cleanSchema(v);
  }
  return out;
}
export function toolDeclarations() {
  return TOOLS.map((t) => {
    const d = { name: t.name, description: t.description + (t.write ? ' (Changes data: the owner must confirm first.)' : '') };
    if (Object.keys(t.parameters.properties).length) d.parameters = cleanSchema(t.parameters);
    return d;
  });
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export async function runReadTool(ctx, name, rawArgs) {
  const tool = TOOL_MAP.get(name);
  if (!tool || tool.write) throw new ToolError(`Unknown tool: ${name}`);
  return tool.run(ctx, validateArgs(tool.parameters, rawArgs));
}

export async function prepareWriteTool(ctx, name, rawArgs) {
  const tool = TOOL_MAP.get(name);
  if (!tool || !tool.write) throw new ToolError(`Unknown tool: ${name}`);
  return tool.prepare(ctx, validateArgs(tool.parameters, rawArgs));
}

// Runs an already-confirmed write atomically and logs it.
export async function executeWrite(ctx, name, args) {
  const tool = TOOL_MAP.get(name);
  if (!tool || !tool.write) throw new ToolError(`Unknown tool: ${name}`);
  const result = await ctx.store.tx(async () => {
    const r = await tool.run(ctx, args);
    await audit(ctx, name, JSON.stringify(r).slice(0, 500));
    return r;
  });
  return { result, message: tool.confirmText(result) };
}
