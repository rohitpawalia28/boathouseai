import { devanagariToRoman } from './translit.js';
const API = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || '';
const $ = (id) => document.getElementById(id);

/* ---------- small helpers ---------- */
function store(key, val) {
  try { if (val === undefined) return localStorage.getItem(key); val === null ? localStorage.removeItem(key) : localStorage.setItem(key, val); } catch { /* storage blocked */ }
  return null;
}
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dshort = (s) => { const [, m, d] = s.split('-').map(Number); return `${d} ${MON[m - 1]}`; };
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

async function api(method, path, body) {
  const token = store('token');
  let res;
  try {
    res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error('Cannot reach the server. Check your internet and try again.'); }
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  // 401 = signed out (another device); 403 LOCKED = the free trial ended or the admin locked the account
  const locked = res.status === 403 && data.code === 'LOCKED';
  if ((res.status === 401 || locked) && token && !path.startsWith('/api/auth/login')) { const why = data.error || 'Please log in again.'; logout(why); throw new Error(why); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

const MEAL = { EP: 'Room only', CP: 'Breakfast', MAP: 'Breakfast + dinner', AP: 'All meals' };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
// A stable colour per houseboat name (set through CSSOM, which the page's CSP allows).
function hue(name) { let x = 0; for (const c of String(name)) x = (x * 31 + c.charCodeAt(0)) % 360; return x; }
function colored(el, name) { el.style.setProperty('--h', String(hue(name))); return el; }
const dot = (name) => colored(h('span', { class: 'dot' }), name);
// Details the owner skipped are saved as empty; show them as "?" instead of 0.
const gShow = (g) => (g == null ? '?' : g);
const mShow = (m) => m ?? '?';
const pShow = (p) => (p == null ? '?' : inr(p));
// Shikara ride of one room: ✓ (with its one-time price), ✗, or ? while the owner has not said.
const skState = (r) => (r.shikara == null ? 'pend' : r.shikara ? (r.shikara_price == null ? 'yes nop' : 'yes') : 'no');
const skText = (r) => (r.shikara == null ? 'Shikara ?' : r.shikara ? `Shikara ✓ ${r.shikara_price == null ? '₹?' : inr(r.shikara_price)}` : 'Shikara ✗');
const skTitle = (r) => (r.shikara == null ? 'Shikara ride: not told yet' : r.shikara ? `Shikara ride included${r.shikara_price == null ? ', price not told yet' : `, ${inr(r.shikara_price)} (once for this room)`}` : 'No shikara ride');
const roomPending = (r) => r.guests == null || r.meal_plan == null || r.price == null || r.shikara == null || (r.shikara === true && r.shikara_price == null);
const sumGuests = (rooms) => rooms.reduce((s, r) => s + (r.guests || 0), 0);
/* ---------- shared popup helper ---------- */
function showModal(bodyNodes, actionNodes) {
  modalPending = null;
  $('modal-body').replaceChildren(...[].concat(bodyNodes).filter(Boolean));
  $('modal-actions').replaceChildren(...[].concat(actionNodes).filter(Boolean));
  $('modal').hidden = false; document.body.classList.add('no-scroll');
}

/* ---------- login (there is no sign-up: owners are created by the admin) ---------- */
$('pw-toggle').onclick = () => {
  const show = $('f-pass').type === 'password';
  $('f-pass').type = show ? 'text' : 'password';
  $('pw-toggle').textContent = show ? 'Hide' : 'Show';
  $('pw-toggle').setAttribute('aria-pressed', String(show));
  $('pw-toggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
};
$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('auth-submit'); btn.disabled = true; $('auth-error').hidden = true; $('auth-notice').hidden = true;
  try {
    const r = await api('POST', '/api/auth/login', { email: $('f-email').value, password: $('f-pass').value });
    store('token', r.token);
    await enterApp();
  } catch (err) { $('auth-error').textContent = err.message; $('auth-error').hidden = false; }
  btn.disabled = false;
};

function logout(why) {
  store('token', null);
  stopVoice({ discard: true });
  closeModal(); setMenu(false);
  $('app').hidden = true; $('auth').hidden = false; $('admin-view').hidden = true; $('app').dataset.role = 'owner'; adminData = null;
  $('f-pass').value = '';
  $('auth-notice').textContent = typeof why === 'string' ? why : '';
  $('auth-notice').hidden = typeof why !== 'string';
  $('auth-error').hidden = true;
}

/* ---------- account menu: change password, install, clear chat, log out ---------- */
function setMenu(open) { $('account-menu').hidden = !open; $('account-btn').setAttribute('aria-expanded', String(open)); }
function syncThemeBtn() {
  const dark = window.BHTheme && window.BHTheme.get() === 'dark';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  $('theme-btn').setAttribute('aria-label', label); $('theme-btn').title = label;
}
$('theme-btn').onclick = () => { if (window.BHTheme) { window.BHTheme.toggle(); syncThemeBtn(); } };
syncThemeBtn();
$('account-btn').onclick = (e) => { e.stopPropagation(); setMenu($('account-menu').hidden); };
document.addEventListener('click', (e) => { if (!$('account-menu').hidden && !$('account-menu').contains(e.target)) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
$('account-menu').addEventListener('click', (e) => { if (e.target.closest('button')) setMenu(false); });
$('logout').onclick = () => logout();

function pwField(label, id, autocomplete) {
  const input = h('input', { id, type: 'password', autocomplete, minlength: '8', required: true });
  const toggle = h('button', { type: 'button', class: 'pw-toggle', 'aria-label': 'Show password', onclick: () => { const show = input.type === 'password'; input.type = show ? 'text' : 'password'; toggle.textContent = show ? 'Hide' : 'Show'; toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); } }, 'Show');
  return { input, row: h('label', {}, label, h('span', { class: 'pw' }, input, toggle)) };
}
function openChangePassword() {
  const cur = pwField('Current password', 'pw-current', 'current-password');
  const nw = pwField('New password (at least 8 characters)', 'pw-new', 'new-password');
  const again = pwField('New password again', 'pw-again', 'new-password');
  const err = h('p', { class: 'error', role: 'alert', hidden: true });
  const save = h('button', { class: 'yes', type: 'submit' }, 'Update password');
  const form = h('form', { class: 'hb-form', id: 'pw-form' },
    h('h2', { id: 'modal-title' }, 'Change password'),
    // an (invisible) username lets password managers save the new password for the right account
    h('input', { type: 'text', name: 'username', autocomplete: 'username', value: me?.email || '', hidden: true, 'aria-hidden': 'true', tabindex: '-1' }),
    cur.row, nw.row, again.row,
    h('p', { class: 'sub' }, 'Your other phones and browsers will be logged out. This one stays logged in.'), err);
  form.onsubmit = async (e) => {
    e.preventDefault(); err.hidden = true;
    if (nw.input.value !== again.input.value) { err.textContent = 'The two new passwords are not the same.'; err.hidden = false; return; }
    save.disabled = true;
    try {
      const r = await api('POST', '/api/auth/change-password', { current_password: cur.input.value, new_password: nw.input.value });
      store('token', r.token); closeModal(); toast('Password updated. Your other devices were logged out.');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; save.disabled = false; }
  };
  const cancel = h('button', { type: 'button', onclick: closeModal }, 'Cancel');
  save.setAttribute('form', 'pw-form');
  showModal(form, [cancel, save]);
  cur.input.focus();
}
$('menu-password').onclick = openChangePassword;

// The owner pastes their own new Gemini key. The server tries it with Google first and keeps the old key if it fails.
async function openMyAiKey() {
  let info = { own: false };
  try { info = await api('GET', '/api/my-ai-key'); } catch { /* still show the form */ }
  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Paste the key', spellcheck: 'false' });
  const err = h('p', { class: 'error', role: 'alert', hidden: true });
  const save = h('button', { class: 'yes', type: 'submit' }, 'Check and save key');
  const form = h('form', { class: 'hb-form', id: 'mk-form' },
    h('h2', { id: 'modal-title' }, 'Update API key'),
    h('p', { class: 'sub' }, info.own ? `Your saved key ends with ${info.hint}. Paste a new key to replace it.` : 'Paste your Gemini API key. The AI chat and voice will use it.'),
    h('label', {}, 'Gemini API key', key),
    h('p', { class: 'sub' }, ['Make a key at ', h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' }, 'aistudio.google.com/apikey'), '. It is checked with Google before saving, stored encrypted, and never shown again.']),
    err);
  form.onsubmit = async (e) => {
    e.preventDefault(); err.hidden = true;
    if (!key.value.trim()) { err.textContent = 'Paste the key first.'; err.hidden = false; return; }
    save.disabled = true; save.textContent = 'Checking with Google...';
    try {
      await api('POST', '/api/my-ai-key', { key: key.value });
      closeModal(); toast('API key updated. The AI now uses your new key.');
      me = await api('GET', '/api/me'); $('mode-badge').hidden = me.ai;
    } catch (ex) { err.textContent = ex.message; err.hidden = false; save.disabled = false; save.textContent = 'Check and save key'; }
  };
  save.setAttribute('form', 'mk-form');
  showModal(form, [h('button', { type: 'button', onclick: closeModal }, 'Cancel'), save]);
  key.focus();
}
$('menu-aikey').onclick = openMyAiKey;

/* ---------- install as an app (PWA) ---------- */
let installEvent = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function updateInstallUI() { const show = !isStandalone(); $('menu-install').hidden = !show; $('install-login').hidden = !show; }
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; updateInstallUI(); });
window.addEventListener('appinstalled', () => { installEvent = null; updateInstallUI(); toast('BoatHouse is installed.'); });
function openInstallHelp() {
  const steps = isIOS()
    ? ['Open this page in Safari.', 'Tap the Share button (the square with an arrow).', 'Choose "Add to Home Screen", then tap Add.']
    : /android/i.test(navigator.userAgent)
      ? ['Open this page in Chrome.', 'Tap the menu (three dots) at the top right.', 'Tap "Install app" or "Add to Home screen".']
      : ['Open this page in Chrome or Edge.', 'Click the install icon at the right end of the address bar.', 'Click Install.'];
  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  showModal([h('h2', { id: 'modal-title' }, 'Install BoatHouse'),
    h('p', {}, 'BoatHouse opens like a normal app from your home screen, full screen, with no browser bar.'),
    h('ol', { class: 'steps' }, steps.map((t) => h('li', {}, t))),
    !secure && h('div', { class: 'm-note warn' }, 'This address is not https, so the phone may not offer Install. Open the hosted https link instead.')],
  h('button', { class: 'yes', type: 'button', onclick: closeModal }, 'Got it'));
}
async function installApp() {
  if (!installEvent) return openInstallHelp();
  const ev = installEvent; installEvent = null;
  ev.prompt();
  try { await ev.userChoice; } catch { /* closed */ }
  updateInstallUI();
}
$('menu-install').onclick = installApp;
$('install-login').onclick = installApp;
updateInstallUI();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* app still works without it */ });
// If this login was replaced on another device, find out as soon as the app comes back to the front.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && store('token') && !$('app').hidden) api('GET', '/api/me').catch(() => {}); });

/* ---------- chat (one chat for everything) ---------- */
let busy = false;
let me = null;

const CHIPS = [
  { label: 'New booking', fill: 'New booking: ' },
  { label: "Today's summary", send: "Give me today's summary" },
  { label: 'Rooms on a date', fill: 'Where did I give rooms on ' },
  { label: 'Vacant rooms', fill: 'How many rooms are vacant on ' },
  { label: 'Monthly report', fill: 'Revenue report for ' },
  { label: 'I owe houseboats', send: 'How much do I have to pay each houseboat?' },
  { label: 'Clients balance', send: 'Show my clients balance' },
];

function renderChips() {
  const box = $('chips'); box.replaceChildren();
  for (const c of CHIPS) box.append(h('button', { class: 'chip', type: 'button', onclick: () => { showView('chat'); if (c.send) send(c.send); else { $('input').value = c.fill; $('input').focus(); autosize(); } } }, c.label));
}

function inline(parent, s) {
  s.split(/\*\*(.+?)\*\*/g).forEach((part, i) => parent.append(i % 2 ? h('strong', {}, part) : document.createTextNode(part)));
}
function renderText(container, text) {
  let ul = null;
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*[-*•]\s+(.*)$/);
    if (m) { if (!ul) { ul = h('ul'); container.append(ul); } const li = h('li'); inline(li, m[1]); ul.append(li); continue; }
    ul = null;
    if (!line.trim()) continue;
    const p = h('p'); inline(p, line); container.append(p);
  }
}

function messagesBox() {
  let inner = $('messages').querySelector('.msgs-inner');
  if (!inner) { $('messages').replaceChildren(); inner = h('div', { class: 'msgs-inner' }); $('messages').append(inner); }
  return inner;
}

function showHello() {
  $('messages').replaceChildren(h('div', { class: 'hello' },
    h('h2', {}, `Hello${me ? ', ' + me.name.split(' ')[0] : ''}`),
    h('p', {}, 'Tell me about a booking, or ask about any day, client or room. Type or use the mic, in English or Hindi.'),
    h('ul', {},
      h('li', {}, h('b', {}, 'Book: '), '"2 Dec, 8 rooms, 4 mine, 2 Chinar, 2 Cultural Palace" – I will ask the client, who sent the booking, guests, prices and meal plan. You can say "skip" for guests, price or meal plan and fill them in later.'),
      h('li', {}, h('b', {}, 'Counts: '), '"How many rooms in Chinar on 28 Dec?", "How many MAP rooms?", "Vacant rooms on 25 Dec?"'),
      h('li', {}, h('b', {}, 'Change: '), '"Move CUL002 to Chinar", "Add 2 rooms to booking 5", "Change booking 5 to 3 Jan".'),
      h('li', {}, h('b', {}, 'Find: '), '"Where did I give rooms on 2 Dec for Sharma?" or "Who is in CUL001?"'),
      h('li', {}, h('b', {}, 'Money: '), '"What do I owe Chinar?" or "Sharma ne 20 hazaar diye".')),
    h('p', {}, 'Before anything is saved you see a review popup and confirm it.')));
}

/* ---------- review popup ---------- */
let modalPending = null;
function closeModal() { $('modal').hidden = true; modalPending = null; document.body.classList.remove('no-scroll'); }
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });

function field(label, value) { return h('div', {}, h('span', {}, label), value || '–'); }

function bookingPreview(p) {
  const out = [h('h2', { id: 'modal-title' }, 'Check the booking'),
    h('div', { class: 'm-meta' }, field('Client', p.client), field('Sender', p.sender), field('Phone', p.phone), field('Check-in', dshort(p.check_in)), field('Check-out', `${dshort(p.check_out)} · ${plural(p.nights, 'night')}`))];
  for (const b of p.houseboats) {
    out.push(h('div', { class: 'm-boat' },
      h('div', { class: 'm-boat-h' }, dot(b.name), b.name, h('span', { class: 'pill own' }, b.prefix),
        b.is_own && h('span', { class: 'pill own' }, 'Your own'), b.is_new && h('span', { class: 'pill new' }, 'New name'),
        h('span', { class: 'grow' }), !b.is_own && h('span', { class: 'pay' }, `You pay ${inr(b.payable)}`)),
      h('table', { class: 'm-rooms' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Room'), h('th', { class: 'num' }, 'Guests'), h('th', {}, 'Meal'), h('th', { class: 'num' }, 'Per night'), h('th', {}, 'Shikara'))),
        h('tbody', {}, b.rooms.map((r) => h('tr', {}, h('td', { class: 'tokc' }, r.token), h('td', { class: 'num' + (r.guests == null ? ' pend' : '') }, gShow(r.guests)), h('td', { title: MEAL[r.meal_plan], class: r.meal_plan == null ? 'pend' : '' }, mShow(r.meal_plan)), h('td', { class: 'num' + (r.price == null ? ' pend' : '') }, pShow(r.price)), h('td', {}, h('span', { class: `sk ${skState(r)}`, title: skTitle(r) }, skText(r)))))))));
  }
  const t = p.totals;
  if (t.required) out.push(h('div', { class: 'm-note' }, `${t.required} rooms required · ${t.rooms} allocated now` + (t.left > 0 ? ` · ${t.left} left to allocate` : ' · all allocated')));
  if (t.pending_rooms?.length) out.push(h('div', { class: 'm-note warn' }, `Details pending (shown as ?) for ${t.pending_rooms.join(', ')}. Tell me later and I will fill them in. Pending prices count as ₹0 for now.`));
  if (t.shikara_pending?.length) out.push(h('div', { class: 'm-note warn' }, `Shikara ride pending for ${t.shikara_pending.join(', ')}: is it included, and at what price per room?`));
  out.push(h('div', { class: 'm-totals' },
    h('div', { class: 'line' }, h('span', {}, `${plural(t.rooms, 'room')} · ${plural(t.guests, 'guest')}`), h('span', {}, `${p.nights} night${p.nights === 1 ? '' : 's'}`)),
    t.shikara > 0 && h('div', { class: 'line' }, h('span', {}, 'Shikara rides (once per room)'), h('span', {}, inr(t.shikara))),
    h('div', { class: 'line big' }, h('span', {}, 'Client total'), h('span', {}, inr(t.client_total))),
    t.advance > 0 && h('div', { class: 'line' }, h('span', {}, 'Advance received'), h('span', {}, inr(t.advance))),
    t.advance > 0 && h('div', { class: 'line' }, h('span', {}, 'Client still to pay'), h('span', {}, inr(t.client_due))),
    t.payable > 0 && h('div', { class: 'line' }, h('span', {}, 'You will owe houseboats'), h('span', {}, inr(t.payable)))));
  out.push(h('div', { class: 'm-ask' }, 'Any change in pricing, guests, meal plan or shikara ride? Tell me in the chat, or confirm to save.'));
  return out;
}

function simplePreview(p) {
  return [h('h2', { id: 'modal-title' }, p.title || 'Please confirm'), p.headline && h('div', { class: 'm-head' }, p.headline),
    h('ul', { class: 'm-lines' }, (p.lines || []).map((l) => h('li', {}, l)))];
}

function openModal(pending) {
  if (!pending?.preview || (pending.status && pending.status !== 'pending')) return;
  modalPending = pending;
  const body = pending.preview.kind === 'booking' ? bookingPreview(pending.preview) : simplePreview(pending.preview);
  $('modal-body').replaceChildren(...body.filter(Boolean));
  const yes = h('button', { class: 'yes', type: 'button' }, pending.preview.kind === 'booking' ? 'Confirm & save booking' : 'Confirm');
  const change = pending.preview.kind === 'booking' && h('button', { type: 'button', onclick: () => { closeModal(); showView('chat'); $('input').placeholder = 'Tell me what to change, e.g. "make Chinar 4500"'; $('input').focus(); } }, 'Change something');
  const no = h('button', { class: 'no', type: 'button' }, 'Cancel');
  yes.onclick = () => resolve(pending, true, [yes, no]);
  no.onclick = () => resolve(pending, false, [yes, no]);
  $('modal-actions').replaceChildren(...[no, change, yes].filter(Boolean));
  $('modal').hidden = false; document.body.classList.add('no-scroll');
  yes.focus();
}

async function resolve(p, approve, btns = []) {
  btns.forEach((b) => (b.disabled = true));
  try {
    const r = await api('POST', '/api/confirm', { token: p.token, approve });
    closeModal();
    markPending(p.token, r.status);
    addMessage({ role: 'assistant', content: r.message });
    if (r.changed) refreshPanel(true);
    speak(r.message);
  } catch (e) { toast(e.message); btns.forEach((b) => (b.disabled = false)); }
}

const STATE_TEXT = { confirmed: 'Saved', cancelled: 'Cancelled', failed: 'Not saved', expired: 'Expired' };
function markPending(token, status) {
  document.querySelectorAll(`.confirm[data-token="${token}"]`).forEach((card) => {
    card.classList.add('done');
    card.querySelector('.btns')?.replaceWith(h('div', { class: `state ${status}` }, STATE_TEXT[status] || status));
  });
}

function confirmCard(p) {
  const waiting = !p.status || p.status === 'pending';
  const card = h('div', { class: 'confirm' + (waiting ? '' : ' done'), 'data-token': p.token });
  const short = p.preview?.kind === 'booking'
    ? `${p.preview.client} (${p.preview.sender}) · ${plural(p.preview.totals.rooms, 'room')} · ${plural(p.preview.totals.guests, 'guest')} · ${inr(p.preview.totals.client_total)}`
    : p.summary;
  card.append(h('div', { class: 'sum' }, short));
  if (waiting) {
    const yes = h('button', { class: 'yes', type: 'button' }, 'Confirm');
    const no = h('button', { type: 'button' }, 'Cancel');
    yes.onclick = () => resolve(p, true, [yes, no]); no.onclick = () => resolve(p, false, [yes, no]);
    card.append(h('div', { class: 'btns' }, p.preview && h('button', { class: 'review', type: 'button', onclick: () => openModal(p) }, 'Review'), yes, no));
  } else card.append(h('div', { class: `state ${p.status}` }, STATE_TEXT[p.status] || p.status));
  return card;
}

function addMessage({ role, content, meta }) {
  const bubble = h('div', { class: 'bubble' });
  renderText(bubble, content);
  if (meta?.pending) bubble.append(confirmCard(meta.pending));
  messagesBox().append(h('div', { class: `msg ${role}` }, bubble));
  scrollDown();
}
function scrollDown() { const m = $('messages'); m.scrollTop = m.scrollHeight; }

// Send stays locked from the moment the mic starts until the AI has finished checking the voice text.
let holdSend = false;
const HOLD_MSG = 'Wait, the AI is still checking your words...';
function updateSendBtn() {
  $('send-btn').disabled = busy || holdSend;
  $('send-btn').title = holdSend ? HOLD_MSG : 'Send';
}
function setHold(on) { holdSend = on; updateSendBtn(); if (typeof paintMic === 'function') paintMic(); }

function setBusy(on) {
  busy = on; updateSendBtn();
  const inner = messagesBox();
  inner.querySelector('.typing-row')?.remove();
  if (on) { inner.append(h('div', { class: 'msg assistant typing-row' }, h('div', { class: 'bubble' }, h('span', { class: 'typing' }, h('i'), h('i'), h('i'))))); scrollDown(); }
}

async function send(text) {
  text = (text ?? $('input').value).trim();
  if (!text || busy || refining) return;
  if (holdSend) return toast(HOLD_MSG); // Enter key / auto-send paths: never send before the AI is done
  stopVoice({ discard: true });
  $('input').value = ''; autosize(); $('input').placeholder = IDLE_PLACEHOLDER;
  if ($('messages').querySelector('.hello')) $('messages').replaceChildren();
  addMessage({ role: 'user', content: text });
  setBusy(true);
  try {
    const r = await api('POST', '/api/chat', { message: text });
    setBusy(false);
    if (r.resolved) markPending(r.resolved.token, r.resolved.status);
    if (r.pending) document.querySelectorAll('.confirm:not(.done)').forEach((c) => { if (c.dataset.token !== r.pending.token) markPending(c.dataset.token, 'cancelled'); }); // a changed booking replaces the old one
    addMessage({ role: 'assistant', content: r.reply, meta: r.pending ? { pending: r.pending } : null });
    $('mode-badge').hidden = !(r.simple || !me.ai);
    if (r.changed) refreshPanel(true);
    if (r.pending) openModal(r.pending); else speak(r.reply);
  } catch (e) {
    setBusy(false);
    addMessage({ role: 'assistant', content: e.message });
  }
}

async function loadHistory() {
  const { messages } = await api('GET', '/api/history');
  $('messages').replaceChildren();
  if (!messages.length) { showHello(); $('messages').scrollTop = 0; return; }
  messages.forEach(addMessage);
  scrollDown();
}

$('clear-chat').onclick = async () => {
  if (!window.confirm('Clear all chat messages? Your bookings and money records are not touched.')) return;
  try { await api('DELETE', '/api/history'); showHello(); closeModal(); toast('Chat cleared.'); } catch (e) { toast(e.message); }
};

/* composer */
function autosize() { const t = $('input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; }
$('input').addEventListener('input', autosize);
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
$('composer').onsubmit = (e) => { e.preventDefault(); send(); };

/* ---------- voice: speech to text (hi-IN / en-IN) ----------
   Stays on until YOU tap the mic again (Chrome stops by itself after silence, so we restart it). */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let wantListening = false;   // true from "mic on" until the user turns it off
let sendWhenStopped = false;
let baseText = '';
let finalText = '';
let restartTimer = null;
// One mic for everything. The browser listens in Hindi mode (it copes with Hindi, English and mixed talk) and shows the words in English letters.
const VOICE_LANG = 'hi-IN';
const IDLE_PLACEHOLDER = 'Type or speak...';

function paintMic() {
  $('mic-btn').classList.toggle('on', wantListening);
  $('mic-btn').setAttribute('aria-label', wantListening ? 'Turn microphone off' : 'Speak');
  $('mic-btn').title = wantListening ? 'Tap to turn the microphone off' : 'Speak';
  $('input').placeholder = wantListening ? 'Listening... tap mic to stop' : (holdSend ? 'Improving your words with AI...' : IDLE_PLACEHOLDER);
}

function joinText(base, extra) { return (base + extra).replace(/\s+/g, ' ').replace(/^\s/, ''); }

function beginRecognition() {
  rec = new SR();
  rec.lang = VOICE_LANG; rec.continuous = true; rec.interimResults = true;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      // Hindi speech arrives in Devanagari; show it as Hinglish in English letters.
      const said = devanagariToRoman(r[0].transcript);
      if (r.isFinal) finalText += said + ' '; else interim += said;
    }
    $('input').value = joinText(baseText, finalText + interim); autosize();
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return; // just silence: keep listening
    wantListening = false; paintMic();
    toast({ 'not-allowed': 'Microphone is blocked. Allow it in the browser address bar.', 'service-not-allowed': 'Microphone is blocked. Allow it in the browser address bar.', network: 'Voice needs an internet connection.', 'language-not-supported': 'This language is not supported on this device.' }[e.error] || 'Voice input stopped.');
  };
  rec.onend = () => {
    if (wantListening) { // the browser ended it (silence / time limit) but the user did not: continue
      baseText = $('input').value ? $('input').value.trimEnd() + ' ' : ''; finalText = '';
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => { if (wantListening) { try { beginRecognition(); } catch { wantListening = false; paintMic(); } } }, 200);
      return;
    }
    paintMic();
    finishVoice();
  };
  rec.start();
}

/* ---------- AI voice clean-up (always on when the Gemini key is set): also record the voice and let Gemini write the text ---------- */
let mr = null; let mrStream = null; let mrChunks = []; let sessionBase = ''; let refining = false;
const wantRefine = () => me?.ai && window.MediaRecorder && navigator.mediaDevices?.getUserMedia;

async function startRecorder() {
  try {
    mrStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    if (!wantListening) { mrStream.getTracks().forEach((t) => t.stop()); return; } // user already turned the mic off
    mrChunks = []; mr = new MediaRecorder(mrStream);
    mr.ondataavailable = (e) => { if (e.data.size) mrChunks.push(e.data); };
    mr.start(1000);
  } catch { mr = null; }
}
function stopRecorder() { // resolves with the recording, or null when nothing was recorded / it was dropped
  return new Promise((resolve) => {
    const r = mr; mr = null;
    if (!r) { mrStream?.getTracks().forEach((t) => t.stop()); return resolve(null); }
    r.onstop = () => { mrStream?.getTracks().forEach((t) => t.stop()); const blob = new Blob(mrChunks, { type: r.mimeType || 'audio/webm' }); mrChunks = []; resolve(blob.size > 2000 ? blob : null); };
    try { r.stop(); } catch { resolve(null); }
  });
}
function dropRecorder() { const r = mr; mr = null; if (r) { r.onstop = null; try { r.stop(); } catch { /* already stopped */ } } mrStream?.getTracks().forEach((t) => t.stop()); mrChunks = []; }

// webm/opus -> 16 kHz mono 16-bit WAV (a format Gemini accepts), returned as base64. null if too long.
async function blobToWavBase64(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let audio;
  try { audio = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close(); }
  if (audio.duration > 120) return null;
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(audio.duration * rate)), rate);
  const src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const view = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(new Blob([view], { type: 'audio/wav' })); });
  return String(dataUrl).split(',')[1];
}

async function refine(blob) {
  const inp = $('input');
  refining = true; inp.readOnly = true; inp.placeholder = 'Improving your words with AI...'; $('send-btn').disabled = true;
  try {
    const wav = await blobToWavBase64(blob);
    if (!wav) { toast('That was a long recording, so I kept the normal text.'); return; }
    // If the AI takes too long we keep the rough text, so Send can never stay locked for ever.
    const r = await Promise.race([api('POST', '/api/transcribe', { audio: wav, mime: 'audio/wav' }), new Promise((_, no) => setTimeout(() => no(new Error('it took too long')), 30000))]);
    let t = String(r.text || '').trim();
    if (/[\u0900-\u097F]/.test(t)) t = devanagariToRoman(t); // safety: never show Devanagari
    if (t) { inp.value = joinText(sessionBase, t); autosize(); }
  } catch (e) { toast(`Could not improve the text (${e.message}). Kept the normal text.`); }
  finally { refining = false; inp.readOnly = false; inp.placeholder = IDLE_PLACEHOLDER; updateSendBtn(); }
}

async function finishVoice() {
  const go = sendWhenStopped; sendWhenStopped = false;
  let blob = null;
  try { blob = await stopRecorder(); if (blob) await refine(blob); }
  finally { if (!wantListening) setHold(false); } // the AI is done (or failed): Send opens again
  if (go && $('opt-autosend').checked && $('input').value.trim()) send();
  $('input').focus();
}

// Called when the user turns the mic off (or sends the message).
function stopVoice({ autoSend = false, discard = false } = {}) {
  const was = wantListening;
  if (discard && rec) rec.onresult = null; // late words must not refill a box we just cleared
  if (discard) { dropRecorder(); setHold(false); }
  wantListening = false; sendWhenStopped = autoSend && was;
  clearTimeout(restartTimer);
  try { rec?.stop(); } catch { /* not running */ }
  paintMic();
}
function startVoice() {
  if (!SR) return toast('Voice input needs Chrome or Edge. You can type instead.');
  if (refining) return toast('One moment, I am still improving the last words.');
  if (wantListening) return stopVoice({ autoSend: true });
  baseText = $('input').value ? $('input').value.trimEnd() + ' ' : ''; finalText = ''; sessionBase = baseText;
  wantListening = true; paintMic();
  if (wantRefine()) { setHold(true); startRecorder(); }
  try { beginRecognition(); } catch { wantListening = false; dropRecorder(); setHold(false); toast('Could not start the microphone.'); }
}
$('mic-btn').onclick = startVoice;
if (!SR) $('mic-btn').title = 'Voice input needs Chrome or Edge';
$('opt-autosend').checked = store('autosend') === '1';
$('opt-speak').checked = store('speak') === '1';
$('opt-autosend').onchange = (e) => store('autosend', e.target.checked ? '1' : '0');
$('opt-speak').onchange = (e) => { store('speak', e.target.checked ? '1' : '0'); if (!e.target.checked) window.speechSynthesis?.cancel(); };
function speak(text) {
  if (!$('opt-speak').checked || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(String(text).replace(/\*\*/g, '').replace(/₹/g, 'rupees ').replace(/\n/g, '. '));
  u.lang = 'en-IN'; window.speechSynthesis.speak(u);
}

/* ---------- left-hand dashboard ---------- */
const TABS = [['overview', 'Overview'], ['bookings', 'Bookings'], ['boats', 'Houseboats'], ['money', 'Money'], ['calendar', 'Calendar'], ['people', 'Clients'], ['reports', 'Reports']];
let tab = 'overview'; let calFrom = null; let calDay = ''; let todayStr = null; let dayFilter = ''; let searchText = ''; let pendingOnly = false; let peopleKind = 'client'; let peopleQ = ''; let repMonth = '';

function renderTabs() {
  const box = $('tabs'); box.replaceChildren();
  for (const [id, label] of TABS) box.append(h('button', { type: 'button', role: 'tab', 'aria-selected': String(id === tab), onclick: () => { tab = id; renderTabs(); refreshPanel(); } }, label));
}
const kpi = (label, value, cls = '', money = false) => h('div', { class: 'kpi' + (money ? ' money' : '') }, h('div', { class: 'l' }, label), h('div', { class: `v ${cls}` }, value));
const empty = (text) => h('div', { class: 'empty' }, text);

function asTokenChat(token) { showView('chat'); send(`Show details of ${token}`); }

// Rooms of one booking, grouped by houseboat, each room a clickable token chip.
function roomGroups(b) {
  const groups = new Map();
  for (const r of b.rooms) { if (!groups.has(r.houseboat)) groups.set(r.houseboat, { own: !!r.is_own, rooms: [] }); groups.get(r.houseboat).rooms.push(r); }
  return [...groups].sort((x, y) => Number(y[1].own) - Number(x[1].own)).map(([name, g]) => h('div', { class: 'boat-group' },
    h('div', { class: 'boat-name' }, dot(name), name, g.own && h('span', { class: 'pill own' }, 'own'), h('span', { class: 'count' }, `${plural(g.rooms.length, 'room')} · ${plural(sumGuests(g.rooms), 'guest')}`)),
    h('div', { class: 'room-grid' }, g.rooms.map(roomTile(name)))));
}

// One room = one tile: token and price on top, guests and meal plan, then the shikara ride. Anything not told yet shows "?".
function roomTile(boat) {
  const q = (v, text, what) => (v == null ? h('span', { class: 'q-wrap' }, h('b', { class: 'q', title: 'Not told yet' }, '?'), what ? ` ${what}` : '') : text);
  return (r) => colored(h('button', { class: 'room' + (roomPending(r) ? ' pending' : ''), type: 'button', title: `Ask about ${r.token}`, onclick: () => asTokenChat(r.token) },
    h('span', { class: 'room-top' }, h('span', { class: 'room-tok' }, r.token), h('span', { class: 'room-price' }, r.price == null ? q(null, null, '/night') : [inr(r.price), h('small', {}, '/night')])),
    h('span', { class: 'room-info' },
      h('span', {}, q(r.guests, plural(r.guests, 'guest'), 'guests')),
      h('span', { class: 'sep' }, '·'),
      h('span', { title: MEAL[r.meal_plan] || 'Meal plan not told yet' }, q(r.meal_plan, r.meal_plan, 'meal'))),
    h('span', { class: `sk ${skState(r)}`, title: skTitle(r) }, skText(r))), boat);
}

async function askDelete(kind, id) {
  try { openModal({ ...(await api('POST', '/api/delete-request', { kind, id })), status: 'pending' }); } catch (e) { toast(e.message); }
}

function bookingCard(b) {
  const due = b.balance;
  const owed = b.houseboat_dues.filter((d) => d.pending !== 0);
  return h('div', { class: 'card' },
    h('div', { class: 'row' }, h('span', { class: 'name' }, `#${b.id} ${b.client_name}`), h('span', { class: 'row-act' }, h('span', { class: 'pill ' + (b.status === 'cancelled' ? 'cancelled' : '') }, b.status), h('button', { class: 'link-small danger', type: 'button', onclick: () => askDelete('booking', b.id) }, 'Delete'))),
    h('div', { class: 'sub' }, `${dshort(b.check_in)} to ${dshort(b.check_out)} · ${plural(b.nights, 'night')}${b.phone ? ' · ' + b.phone : ''}`),
    h('div', { class: 'sub' }, b.sender ? `Sender: ${b.sender}` : 'Sender: – (older booking)'),
    b.status !== 'cancelled' && (b.rooms_required > 0 || b.pending_tokens?.length > 0) && h('div', { class: 'flags' },
      b.rooms_required > 0 && h('span', { class: 'pill ' + (b.rooms_left ? 'due' : '') }, `${b.rooms_required} required · ${b.rooms_allocated} allocated${b.rooms_left ? ` · ${b.rooms_left} left` : ''}`),
      b.pending_tokens?.length > 0 && h('span', { class: 'pill due', title: b.pending_tokens.join(', ') }, `Details pending: ${b.pending_tokens.length}`)),
    b.status !== 'cancelled' && roomGroups(b),
    h('div', { class: 'money-row' }, h('span', {}, `Total ${inr(b.billed)} · received ${inr(b.received)}`), due !== 0 ? h('span', { class: 'pill due' }, due > 0 ? `Client due ${inr(due)}` : `Refund ${inr(-due)}`) : h('span', { class: 'pill' }, 'Settled')),
    owed.length > 0 && h('div', { class: 'owes' }, owed.map((d) => h('span', {}, `You owe ${d.houseboat}: `, h('b', {}, inr(d.pending))))));
}

async function renderOverview(body) {
  const [d, bookings] = await Promise.all([api('GET', '/api/dashboard'), api('GET', '/api/bookings?status=confirmed')]);
  todayStr = d.today;
  body.append(h('div', { class: 'kpis' },
    kpi('Rooms tonight', d.rooms_tonight), kpi('Arrivals today', d.arrivals_today), kpi('Departures today', d.departures_today),
    kpi('Clients owe you', inr(d.to_receive), d.to_receive > 0 ? 'neg' : '', true), kpi('You owe houseboats', inr(d.to_pay), d.to_pay > 0 ? 'neg' : '', true), kpi('Upcoming bookings', d.upcoming_bookings),
    d.details_pending > 0 && kpi('Details pending', d.details_pending, 'warn'), d.rooms_left_to_allocate > 0 && kpi('Rooms to allocate', d.rooms_left_to_allocate, 'warn')));
  if (d.details_pending > 0) body.append(h('button', { class: 'alert-btn', type: 'button', onclick: () => { tab = 'bookings'; pendingOnly = true; renderTabs(); refreshPanel(); } }, `${plural(d.details_pending, 'booking')} with guests, price, meal plan or shikara ride still to fill in – tap to see`));
  body.append(h('div', { class: 'sec-title' }, 'Coming up'));
  const up = bookings.filter((b) => b.check_out > d.today).sort((a, b) => a.check_in.localeCompare(b.check_in)).slice(0, 6);
  if (!up.length) body.append(empty('No upcoming bookings yet. Tell the chat: "2 Dec, 8 rooms, 4 mine, 2 Chinar, 2 Cultural Palace".'));
  else up.forEach((b) => body.append(bookingCard(b)));
}

// Day view: pick a date and see which houseboat holds how many rooms, for which client.
// "Who is staying this night": rooms and guests per houseboat, then what is still vacant.
function daySummaryBox(date, rows, av) {
  const by = new Map();
  for (const b of rows) for (const r of b.rooms) {
    if (!by.has(r.houseboat)) by.set(r.houseboat, { own: !!r.is_own, rooms: 0, guests: 0, clients: new Set() });
    const g = by.get(r.houseboat); g.rooms++; g.guests += r.guests || 0; g.clients.add(b.client_name);
  }
  const totalRooms = [...by.values()].reduce((sum, g) => sum + g.rooms, 0);
  const box = h('div', { class: 'day-sum' }, h('strong', {}, `${dshort(date)}: ${plural(totalRooms, 'room')} booked`));
  if (!by.size) box.append(h('div', { class: 'sub' }, 'No rooms booked this night.'));
  for (const [name, g] of by) box.append(h('div', { class: 'line' }, h('span', {}, dot(name), name, g.own ? ' (own)' : '', h('span', { class: 'sub' }, ` · ${[...g.clients].join(', ')}`)), h('strong', {}, `${plural(g.rooms, 'room')} · ${plural(g.guests, 'guest')}`)));
  const vacant = av.houseboats.filter((x) => x.vacant !== null);
  if (vacant.length) box.append(h('div', { class: 'sub vac' }, 'Vacant: ' + vacant.map((x) => `${x.houseboat} ${x.vacant} of ${x.total_rooms}`).join(' · ')));
  return box;
}

async function renderBookings(body) {
  const find = h('input', { type: 'search', placeholder: 'Search client or sender', value: searchText, 'aria-label': 'Search client or sender', class: 'find' });
  find.onchange = () => { searchText = find.value.trim(); refreshPanel(); };
  body.append(h('div', { class: 'day-pick' }, find,
    h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: pendingOnly, onchange: (e) => { pendingOnly = e.target.checked; refreshPanel(); } }), ' Details pending only')));
  const picker = h('input', { type: 'date', value: dayFilter, 'aria-label': 'Pick a date' });
  picker.onchange = () => { dayFilter = picker.value; refreshPanel(); };
  body.append(h('div', { class: 'day-pick' }, h('strong', {}, 'Day view'), picker,
    h('button', { type: 'button', onclick: () => { dayFilter = todayStr || new Date().toISOString().slice(0, 10); refreshPanel(); } }, 'Today'),
    dayFilter && h('button', { type: 'button', onclick: () => { dayFilter = ''; refreshPanel(); } }, 'Show all')));
  const qs = new URLSearchParams();
  if (dayFilter) { qs.set('date', dayFilter); qs.set('status', 'confirmed'); }
  if (pendingOnly) qs.set('pending', '1');
  if (searchText) { qs.set('client', searchText); }
  let rows = await api('GET', '/api/bookings' + (qs.toString() ? `?${qs}` : ''));
  if (searchText && !rows.length) rows = await api('GET', `/api/bookings?${new URLSearchParams({ sender: searchText, ...(dayFilter ? { date: dayFilter, status: 'confirmed' } : {}), ...(pendingOnly ? { pending: '1' } : {}) })}`);
  if (dayFilter) body.append(daySummaryBox(dayFilter, rows, await api('GET', `/api/availability?date=${dayFilter}`)));
  if (!rows.length) return body.append(empty(dayFilter ? 'Nothing on this day.' : 'No bookings yet. Try: "2 Dec, 8 rooms, 4 mine, 2 Chinar, 2 Cultural Palace".'));
  rows.forEach((b) => body.append(bookingCard(b)));
  if (!dayFilter && !pendingOnly && !searchText) body.append(h('div', { class: 'del-all' }, h('button', { class: 'link-small danger', type: 'button', onclick: () => askDelete('all') }, 'Delete all bookings')));
}

function openAddBoat(existing = null) {
  modalPending = null;
  const name = h('input', { id: 'hb-name', type: 'text', maxlength: '60', placeholder: 'e.g. Cultural Palace', autocomplete: 'off', value: existing?.name || '' });
  const rooms = h('input', { id: 'hb-rooms', type: 'number', min: '1', max: '5', inputmode: 'numeric', placeholder: 'e.g. 4', value: existing?.total_rooms || '' });
  const own = h('input', { id: 'hb-own', type: 'checkbox' }); own.checked = existing ? !!existing.is_own : false;
  const err = h('p', { class: 'error', role: 'alert', hidden: true });
  const save = h('button', { class: 'yes', type: 'submit' }, existing ? 'Save' : 'Add houseboat');
  const form = h('form', { class: 'hb-form' },
    h('h2', { id: 'modal-title' }, existing ? `Edit ${existing.name}` : 'Add houseboat'),
    h('label', {}, 'Houseboat name', name),
    h('label', {}, 'Total rooms', rooms),
    h('label', { class: 'check' }, own, ' This is my own houseboat (I pay nobody for its rooms)'),
    h('p', { class: 'sub' }, 'Room tokens use the first 3 letters of the name, like CUL001. A houseboat has 3 to 5 rooms. Bookings can only use rooms up to the total.'),
    err);
  form.onsubmit = async (e) => {
    e.preventDefault(); save.disabled = true; err.hidden = true;
    try {
      const r = await api('POST', '/api/houseboats', { name: name.value, total_rooms: rooms.value ? Number(rooms.value) : null, is_own: own.checked });
      closeModal(); toast(r.updated ? `${r.name} updated.` : `${r.name} added. Tokens will look like ${r.prefix}001.`); refreshPanel(true);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; save.disabled = false; }
  };
  $('modal-body').replaceChildren(form);
  const cancel = h('button', { type: 'button', onclick: closeModal }, 'Cancel');
  save.setAttribute('form', 'hb-form'); form.id = 'hb-form';
  $('modal-actions').replaceChildren(cancel, save);
  $('modal').hidden = false; document.body.classList.add('no-scroll');
  name.focus();
}

async function renderBoats(body) {
  const boats = await api('GET', '/api/houseboats');
  body.append(h('div', { class: 'sec-title' }, plural(boats.length, 'houseboat'), h('button', { class: 'add-btn', type: 'button', onclick: () => openAddBoat() }, '+ Add houseboat')));
  if (!boats.length) return body.append(empty('No houseboats yet. Press "Add houseboat", or just use a name in a booking and it is created for you.'));
  for (const b of boats) {
    const total = b.total_rooms;
    body.append(h('div', { class: 'card' },
      h('div', { class: 'row' }, h('span', { class: 'name' }, dot(b.name), b.name, ' ', h('span', { class: 'pill own' }, b.prefix), b.is_own ? h('span', { class: 'pill own' }, 'own') : null),
        h('span', { class: 'row-act' }, h('button', { class: 'link-small', type: 'button', onclick: () => openAddBoat(b) }, 'Edit'), h('button', { class: 'link-small danger', type: 'button', onclick: () => askDelete('houseboat', b.id) }, 'Delete'))),
      h('div', { class: 'sub' }, `${total ? `${plural(total, 'room')} in total · ${b.booked_tonight} booked tonight · ${b.vacant_tonight} vacant` : `Room count not set · ${b.booked_tonight} booked tonight`} · ${plural(b.upcoming_rooms, 'upcoming room')} in ${plural(b.upcoming_bookings, 'booking')}`),
      !b.is_own && h('div', { class: 'money-row' }, h('span', {}, `To pay ${inr(b.payable)} · paid ${inr(b.paid)}`), b.pending !== 0 ? h('span', { class: 'pill due' }, b.pending > 0 ? `You owe ${inr(b.pending)}` : `They owe you ${inr(-b.pending)}`) : h('span', { class: 'pill' }, 'Settled'))));
  }
}

async function renderCalendar(body) {
  if (!calFrom) calFrom = todayStr || new Date().toISOString().slice(0, 10);
  const [g, boats] = await Promise.all([api('GET', `/api/calendar?from=${calFrom}&days=14`), api('GET', '/api/houseboats')]);
  if (!calDay || calDay < g.dates[0] || calDay > g.dates[g.dates.length - 1]) {
    // open on today if something is booked, else on the first booked night in view, else today
    const busy = new Set(g.rows.flatMap((r) => Object.keys(r.cells)));
    calDay = busy.has(todayStr) ? todayStr : g.dates.find((d) => busy.has(d)) || (g.dates.includes(todayStr) ? todayStr : g.dates[0]);
  }
  const pick = (d) => { calDay = d; refreshPanel(); };
  body.append(h('div', { class: 'cal-nav' },
    h('button', { type: 'button', onclick: () => { calFrom = addDays(calFrom, -14); refreshPanel(); } }, '‹ Earlier'),
    h('strong', {}, `${dshort(g.dates[0])} – ${dshort(g.dates[g.dates.length - 1])}`),
    h('button', { type: 'button', onclick: () => { calFrom = addDays(calFrom, 14); refreshPanel(); } }, 'Later ›')));
  if (!boats.length) return body.append(empty('Add a houseboat first (Houseboats tab), then your bookings show up here by date.'));
  const cells = new Map(g.rows.map((r) => [r.houseboat, r.cells]));
  const t = h('table', { class: 'cal' });
  t.append(h('thead', {}, h('tr', {}, h('th', { class: 'room-h' }, 'Houseboat'), g.dates.map((d) => h('th', { class: (d === todayStr ? 'today ' : '') + (d === calDay ? 'sel' : ''), role: 'button', tabindex: '0', 'aria-label': `Show ${dshort(d)}`, onclick: () => pick(d), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(d); } } }, String(Number(d.slice(8))))))));
  const tb = h('tbody');
  for (const r of boats) {
    const mine = cells.get(r.name) || {};
    tb.append(h('tr', {}, h('td', { class: 'room-h' }, dot(r.name), r.name), g.dates.map((d) => {
      const c = mine[d]; const sel = d === calDay ? ' sel' : '';
      return c ? colored(h('td', { class: 'busy' + sel, title: `${plural(c.rooms, 'room')}: ${c.clients}`, onclick: () => pick(d) }, String(c.rooms)), r.name) : h('td', { class: sel.trim(), onclick: () => pick(d) });
    })));
  }
  t.append(tb);
  body.append(h('div', { class: 'cal-wrap' }, t), h('div', { class: 'cal-legend' }, 'The number is how many rooms are booked that night. Tap a date to see who is staying.'));
  // Who is staying on the chosen night (this also fills the space under the grid with useful details)
  const [rows, av] = await Promise.all([api('GET', `/api/bookings?date=${calDay}&status=confirmed`), api('GET', `/api/availability?date=${calDay}`)]);
  body.append(daySummaryBox(calDay, rows, av));
  rows.forEach((b) => body.append(bookingCard(b)));
}

async function renderMoney(body) {
  const b = await api('GET', '/api/balance');
  const t = b.totals;
  body.append(h('div', { class: 'sec-title' }, 'Clients pay you'));
  body.append(h('div', { class: 'kpis' }, kpi('Billed', inr(t.billed)), kpi('Received', inr(t.received), 'pos'), kpi('Still due', inr(t.to_receive), t.to_receive > 0 ? 'neg' : '')));
  if (!b.client_dues.length) body.append(empty('No client has a balance.')); else b.client_dues.forEach((x) => body.append(bookingCard(x)));
  body.append(h('div', { class: 'sec-title' }, 'You pay houseboats'));
  body.append(h('div', { class: 'kpis' }, kpi('To pay', inr(t.payable)), kpi('Paid', inr(t.paid_out), 'pos'), kpi('Pending', inr(t.to_pay), t.to_pay > 0 ? 'neg' : '')));
  if (!b.houseboats.length) body.append(empty('No partner houseboats yet.'));
  for (const hb of b.houseboats) {
    // pending below zero = you paid more than you owe this houseboat (so they hold your money)
    const extra = hb.pending < 0;
    body.append(h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'name' }, dot(hb.name), hb.name), hb.pending > 0 ? h('span', { class: 'pill due' }, `Pending ${inr(hb.pending)}`) : extra ? h('span', { class: 'pill due warn' }, `Paid extra ${inr(-hb.pending)}`) : h('span', { class: 'pill' }, 'Settled')),
      h('div', { class: 'sub' }, `To pay ${inr(hb.payable)} · paid ${inr(hb.paid)}`),
      extra && h('div', { class: 'sub' }, `You paid ${inr(-hb.pending)} more than you owe ${hb.name}. If that payment was a mistake, tap Reverse on it below.`)));
  }
  body.append(h('div', { class: 'sec-title' }, 'Recent money entries'));
  if (!b.ledger.length) body.append(empty('No entries yet.'));
  const reversed = new Set(b.ledger.filter((x) => x.type === 'REVERSAL').map((x) => x.ref_id));
  for (const l of b.ledger) {
    const canReverse = (l.type === 'PAYMENT' || l.type === 'REFUND') && !reversed.has(l.id);
    body.append(h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'name' }, `L${l.id} · ${l.side === 'CLIENT' ? 'Client' : 'Houseboat'} ${l.type.toLowerCase()}`),
        h('span', { class: 'row-act' }, h('span', { class: 'ledger-amt' }, (l.amount < 0 ? '−' : '+') + inr(Math.abs(l.amount))), canReverse && h('button', { class: 'link-small danger', type: 'button', title: 'Undo this entry (a reversal is added, nothing is erased)', onclick: () => askDelete('entry', l.id) }, 'Reverse'))),
      h('div', { class: 'sub' }, [l.client_name && `#${l.booking_id} ${l.client_name}`, l.houseboat, l.method, l.note].filter(Boolean).join(' · '))));
  }
}

// Clients and senders are built automatically from the bookings.
async function renderPeople(body) {
  const seg = h('div', { class: 'day-pick' },
    ...['client', 'sender'].map((k) => h('button', { type: 'button', class: 'segbtn', 'aria-pressed': String(peopleKind === k), onclick: () => { peopleKind = k; refreshPanel(); } }, k === 'client' ? 'Clients' : 'Senders')),
    h('input', { type: 'search', placeholder: 'Search name or phone', value: peopleQ, class: 'find', 'aria-label': 'Search', onchange: (e) => { peopleQ = e.target.value.trim(); refreshPanel(); } }));
  body.append(seg);
  const r = await api('GET', `/api/people?kind=${peopleKind}&q=${encodeURIComponent(peopleQ)}`);
  if (!r.people.length) return body.append(empty(peopleQ ? 'Nobody matches that search.' : `No ${peopleKind}s yet. They appear here automatically after your first booking.`));
  body.append(h('div', { class: 'sub' }, `${plural(r.people.length, peopleKind)}, biggest billing first. Tap one to see their bookings in the chat.`));
  for (const p of r.people) {
    body.append(h('button', { class: 'card person', type: 'button', onclick: () => { showView('chat'); send(peopleKind === 'sender' ? `Show bookings sent by ${p.name}` : `Show bookings of client ${p.name}`); } },
      h('div', { class: 'row' }, h('span', { class: 'name' }, p.name), p.due !== 0 ? h('span', { class: 'pill due' }, p.due > 0 ? `Due ${inr(p.due)}` : `Refund ${inr(-p.due)}`) : h('span', { class: 'pill' }, 'Settled')),
      h('div', { class: 'sub' }, `${plural(p.bookings, 'booking')} · ${plural(p.rooms, 'room')} · billed ${inr(p.billed)}${p.phone ? ' · ' + p.phone : ''}${p.last_stay ? ' · last stay ' + dshort(p.last_stay) : ''}${p.pending_rooms ? ` · ${p.pending_rooms} room details pending` : ''}`)));
  }
}

const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const monthLabel = (m) => { const [y, mo] = m.split('-').map(Number); return `${MON[mo - 1]} ${y}`; };

// Revenue for a month: rooms count for the nights they stay inside that month.
async function renderReports(body) {
  if (!repMonth) repMonth = (todayStr || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const r = await api('GET', `/api/reports?month=${repMonth}`);
  body.append(h('div', { class: 'cal-nav' },
    h('button', { type: 'button', onclick: () => { repMonth = shiftMonth(repMonth, -1); refreshPanel(); } }, '‹ Earlier'),
    h('strong', {}, monthLabel(repMonth)),
    h('button', { type: 'button', onclick: () => { repMonth = shiftMonth(repMonth, 1); refreshPanel(); } }, 'Later ›')));
  const t = r.totals;
  body.append(h('div', { class: 'kpis' }, kpi('Client billing', inr(t.revenue), 'pos'), kpi('Payable to houseboats', inr(t.payable)), kpi('Your margin', inr(t.margin), t.margin >= 0 ? 'pos' : 'neg')));
  body.append(h('div', { class: 'sub' }, `${plural(t.bookings, 'booking')} · ${plural(t.room_nights, 'room-night')}. Each room counts for the nights it stays inside this month.${r.pending_price_rooms ? ` ${plural(r.pending_price_rooms, 'room')} without a price count as ₹0.` : ''}`));
  if (r.shikara?.rides) body.append(h('div', { class: 'sub' }, `Shikara rides for guests arriving this month: ${r.shikara.rides}, ${inr(r.shikara.amount)} (charged once per room, on top of the room billing).`));
  if (!r.by_houseboat.length) return body.append(empty('No bookings in this month.'));
  body.append(h('div', { class: 'sec-title' }, 'By houseboat'));
  for (const x of r.by_houseboat) body.append(h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'name' }, dot(x.houseboat), x.houseboat, x.own && h('span', { class: 'pill own' }, 'own')), h('strong', {}, inr(x.revenue))),
    h('div', { class: 'sub' }, `${plural(x.room_nights, 'room-night')} · ${plural(x.bookings, 'booking')}${x.own ? '' : ` · payable ${inr(x.payable)} · margin ${inr(x.margin)}`}`)));
  body.append(h('div', { class: 'sec-title' }, 'By sender'));
  for (const x of r.by_sender) body.append(h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'name' }, x.sender), h('strong', {}, inr(x.revenue))), h('div', { class: 'sub' }, `${plural(x.bookings, 'booking')} · ${plural(x.room_nights, 'room-night')}`)));
}

const RENDER = { overview: renderOverview, bookings: renderBookings, boats: renderBoats, money: renderMoney, calendar: renderCalendar, people: renderPeople, reports: renderReports };
let panelSeq = 0;
async function refreshPanel(flash = false) {
  const seq = ++panelSeq;
  const body = document.createDocumentFragment();
  try { await RENDER[tab](body); } catch (e) { body.replaceChildren(empty(e.message)); }
  if (seq !== panelSeq) return; // a newer refresh won
  $('panel-body').replaceChildren(body);
  if (flash) { $('panel-body').classList.remove('flash'); void $('panel-body').offsetWidth; $('panel-body').classList.add('flash'); }
}

/* small screens show one view at a time: Chat or Dashboard */
function showView(v) {
  $('app').dataset.view = v;
  $('bt-chat').setAttribute('aria-pressed', String(v === 'chat'));
  $('bt-dash').setAttribute('aria-pressed', String(v === 'dash'));
  if (v === 'dash') refreshPanel();
}
$('bt-chat').onclick = () => showView('chat');
$('bt-dash').onclick = () => showView('dash');

/* ---------- Admin dashboard (the BoatHouse admin manages the customers) ---------- */
let adminData = null;
const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-');
const AI_URL = 'https://aistudio.google.com/apikey';

async function renderAdmin() {
  const root = $('admin-view');
  let d;
  try { d = await api('GET', '/api/admin/owners'); } catch (e) { toast(e.message); return; }
  adminData = d;
  const list = d.owners;
  const n = (s) => list.filter((o) => s.includes(o.status)).length;
  const stopped = n(['expired', 'locked']);
  root.replaceChildren(
    h('div', { class: 'admin-head' },
      h('div', {}, h('h1', {}, 'Customers'), h('p', { class: 'sub' }, `${plural(list.length, 'boat owner')} using BoatHouse AI`)),
      h('button', { class: 'primary', type: 'button', onclick: openAddCustomer }, '+ Add customer')),
    h('div', { class: 'kpis' }, kpi('On trial', String(n(['trial']))), kpi('Paid', String(n(['full']))), kpi('Ended or locked', String(stopped), stopped ? 'warn' : '')),
    ...(list.length ? list.map(customerCard) : [empty('No customers yet. Tap "+ Add customer" to make the first login.')]));
}

function customerCard(o) {
  const pill = { trial: ['Trial', 'trial'], expired: ['Trial ended', 'due'], locked: ['Locked', 'due'], full: ['Paid', ''] }[o.status];
  const when = o.status === 'trial' ? `Trial ends ${fmtDT(o.trial_ends_at)} (${plural(o.days_left, 'day')} left)`
    : o.status === 'expired' ? `Trial ended ${fmtDT(o.trial_ends_at)}. They see "contact the owner for renewal".`
      : o.status === 'locked' ? 'Locked by you. They see "contact the owner".' : 'Renewed. No end date.';
  const ai = o.ai === 'own' ? `Own AI key ${o.ai_hint}` : o.ai === 'shared' ? 'Shared server AI key (no key of their own yet)' : o.ai === 'unreadable' ? 'Saved AI key cannot be read. Enter it again.' : 'No AI key (simple mode only)';
  const btn = (label, fn, cls = '') => h('button', { class: `chip-btn ${cls}`.trim(), type: 'button', onclick: fn }, label);
  return h('div', { class: 'card cust' },
    h('div', { class: 'row' }, h('span', { class: 'name' }, o.name), h('span', { class: `pill ${pill[1]}`.trim() }, pill[0])),
    h('div', { class: 'sub' }, [o.email, o.phone].filter(Boolean).join(' · ')),
    o.note && h('div', { class: 'sub' }, o.note),
    h('div', { class: 'sub' }, when),
    h('div', { class: 'sub' }, `${ai} · ${plural(o.ai_calls, 'AI request')}`),
    h('div', { class: 'sub' }, `${plural(o.houseboats, 'houseboat')} · ${plural(o.bookings, 'booking')} · last login ${o.last_login_at ? fmtDT(o.last_login_at) : 'never'}`),
    h('div', { class: 'cust-acts' },
      btn('Extend trial', () => openExtend(o), o.status === 'expired' ? 'go' : ''),
      o.status !== 'full' && btn('Renew (paid)', () => confirmAccess(o, 'make_full', `Mark ${o.name} as paid?`, 'They keep access with no end date.', 'Mark as paid')),
      o.locked ? btn('Unlock', () => doAccess(o, 'unlock', 'Unlocked.')) : btn('Lock now', () => confirmAccess(o, 'lock', `Lock ${o.name} now?`, 'They are stopped at once and see "contact the owner". Their data stays safe.', 'Lock now'), 'danger'),
      btn(o.ai === 'own' ? 'Update API key' : 'Add API key', () => openAiKey(o)),
      btn('Test AI', () => testAi(o)),
      btn('Reset password', () => openResetPassword(o)),
      btn('Download data', () => downloadData(o))));
}

async function adminCall(method, path, body, okMsg) {
  try { const r = await api(method, path, body); if (okMsg) toast(okMsg); await renderAdmin(); return r; } catch (e) { toast(e.message); return null; }
}
const doAccess = (o, action, msg, days) => adminCall('POST', `/api/admin/owners/${o.id}/access`, { action, days }, msg);

function confirmAccess(o, action, title, text, yesLabel) {
  const yes = h('button', { class: 'yes', type: 'button', onclick: async () => { closeModal(); await doAccess(o, action, 'Done.'); } }, yesLabel);
  showModal([h('h2', { id: 'modal-title' }, title), h('p', {}, text)], [h('button', { type: 'button', onclick: closeModal }, 'Cancel'), yes]);
}

// A small form in the popup: build it, add Cancel + the main button.
function formModal(id, title, fields, saveLabel, onSubmit) {
  const err = h('p', { class: 'error', role: 'alert', hidden: true });
  const save = h('button', { class: 'yes', type: 'submit' }, saveLabel);
  const form = h('form', { class: 'hb-form', id }, h('h2', { id: 'modal-title' }, title), ...fields, err);
  form.onsubmit = async (e) => {
    e.preventDefault(); save.disabled = true; err.hidden = true;
    try { await onSubmit(); } catch (ex) { err.textContent = ex.message; err.hidden = false; save.disabled = false; }
  };
  save.setAttribute('form', id);
  showModal(form, [h('button', { type: 'button', onclick: closeModal }, 'Cancel'), save]);
  return form;
}

// The login details to send to the customer (copy and paste into WhatsApp).
function showLogin(o, password, heading) {
  const lines = [
    'BoatHouse AI login',
    `Link: ${location.origin}`,
    `Email: ${o.email}`,
    `Password: ${password}`,
    o.status === 'trial' ? `Your free trial ends on ${fmtDT(o.trial_ends_at)}.` : '',
    'You can change the password after you log in (top right menu > Change password).',
  ].filter(Boolean).join('\n');
  const box = h('textarea', { class: 'cred', rows: '7', readonly: true, 'aria-label': 'Login details' }, lines);
  const copy = h('button', { class: 'yes', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(lines); } catch { box.select(); document.execCommand('copy'); }
    toast('Copied. Paste it in WhatsApp.');
  } }, 'Copy login details');
  showModal([h('h2', { id: 'modal-title' }, heading), h('p', { class: 'sub' }, 'This password is shown only now. Copy it and send it to the owner.'), box],
    [h('button', { type: 'button', onclick: closeModal }, 'Close'), copy]);
}

function openAddCustomer() {
  const f = (label, attrs) => { const input = h('input', { type: 'text', autocomplete: 'off', ...attrs }); return { input, row: h('label', {}, label, input) }; };
  const name = f('Owner name', { required: true, maxlength: '80', placeholder: 'e.g. Rajan Nair' });
  const email = f('Email (they log in with this)', { type: 'email', required: true, inputmode: 'email', autocapitalize: 'none', placeholder: 'owner@email.com' });
  const phone = f('Phone (optional)', { maxlength: '20', inputmode: 'tel' });
  const note = f('Note for yourself (optional)', { maxlength: '200', placeholder: 'e.g. 4 boats in Alleppey' });
  const pass = f('Password (leave empty to make one)', { id: 'cu-pass' });
  const days = f('Free trial days', { type: 'number', min: '1', max: '365', value: '10', inputmode: 'numeric' });
  const paid = h('input', { type: 'checkbox' });
  paid.onchange = () => { days.input.disabled = paid.checked; };
  const key = f('Their Gemini API key (optional now)', { type: 'password', placeholder: 'Paste the key', autocomplete: 'off' });
  const form = formModal('cu-form', 'Add customer', [
    name.row, email.row, phone.row, note.row, pass.row, days.row,
    h('label', { class: 'check' }, paid, ' Already paid (no trial)'),
    key.row,
    h('p', { class: 'sub' }, ['Ask the owner to open ', h('a', { href: AI_URL, target: '_blank', rel: 'noopener' }, 'aistudio.google.com/apikey'), ', create an API key and send it to you. Their AI work then uses their own key. You can add it later with the AI key button.'])],
  'Create login', async () => {
    const r = await api('POST', '/api/admin/owners', { name: name.input.value, email: email.input.value, phone: phone.input.value, note: note.input.value, password: pass.input.value, plan: paid.checked ? 'full' : 'trial', trial_days: days.input.value, gemini_key: key.input.value });
    const typed = pass.input.value;
    await renderAdmin();
    showLogin(r.owner, r.password || typed, `Login for ${r.owner.name}`);
  });
  name.input.focus();
  return form;
}

function openExtend(o) {
  const days = h('input', { type: 'number', min: '1', max: '365', value: '10', inputmode: 'numeric', required: true });
  const presets = h('div', { class: 'presets' }, [7, 10, 30].map((d) => h('button', { type: 'button', class: 'chip-btn', onclick: () => { days.value = String(d); } }, `${d} days`)));
  formModal('ex-form', `Extend trial for ${o.name}`, [
    h('p', { class: 'sub' }, o.status === 'trial' ? `The trial ends ${fmtDT(o.trial_ends_at)}. The extra days are added after that.` : 'Their trial is over. The new days start from now and they can log in again.'),
    h('label', {}, 'Extra days', days), presets], 'Extend',
  async () => { await api('POST', `/api/admin/owners/${o.id}/access`, { action: 'extend', days: days.value }); closeModal(); toast('Trial extended.'); await renderAdmin(); });
  days.focus();
}

function openAiKey(o) {
  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Paste the key', spellcheck: 'false' });
  const form = formModal('ai-form', `${o.ai === 'own' ? 'Update' : 'Add'} API key for ${o.name}`, [
    h('p', { class: 'sub' }, o.ai === 'own' ? `A key is saved (${o.ai_hint}). Paste a new one to replace it.` : 'No key of their own yet. Paste the Gemini API key the owner sent you.'),
    h('label', {}, 'Gemini API key', key),
    h('p', { class: 'sub' }, ['The owner makes it at ', h('a', { href: AI_URL, target: '_blank', rel: 'noopener' }, 'aistudio.google.com/apikey'), '. It is stored encrypted and never shown again.'])],
  'Save key', async () => {
    if (!key.value.trim()) throw new Error('Paste the key first, or use Remove key.');
    await api('POST', `/api/admin/owners/${o.id}/ai-key`, { key: key.value }); closeModal(); toast('API key saved. Tap Test AI to check it.'); await renderAdmin();
  });
  if (o.ai === 'own') $('modal-actions').prepend(h('button', { type: 'button', class: 'no', onclick: async () => { closeModal(); await adminCall('POST', `/api/admin/owners/${o.id}/ai-key`, { key: '' }, 'Key removed.'); } }, 'Remove key'));
  key.focus();
  return form;
}

async function testAi(o) {
  toast('Testing the AI key...');
  try {
    const r = await api('POST', `/api/admin/owners/${o.id}/ai-test`);
    showModal([h('h2', { id: 'modal-title' }, r.ok ? 'The AI key works' : 'The AI key is not working'),
      h('p', {}, r.ok ? `Gemini answered using ${r.source === 'own' ? o.name + "'s own key" : 'the shared server key'}.` : r.error),
      !r.ok && h('p', { class: 'sub' }, 'Check that the key was copied fully, and that the owner made it in Google AI Studio.')],
    h('button', { class: 'yes', type: 'button', onclick: closeModal }, 'OK'));
  } catch (e) { toast(e.message); }
}

function openResetPassword(o) {
  const pass = h('input', { type: 'text', autocomplete: 'off', placeholder: 'Leave empty to make one automatically' });
  formModal('rp-form', `New password for ${o.name}`, [
    h('p', { class: 'sub' }, 'Use this when the owner forgot the password. They are logged out everywhere.'),
    h('label', {}, 'New password (8 or more characters)', pass)], 'Reset password',
  async () => {
    const typed = pass.value;
    const r = await api('POST', `/api/admin/owners/${o.id}/password`, { password: typed });
    await renderAdmin(); showLogin(r.owner, r.password || typed, `New password for ${r.owner.name}`);
  });
  pass.focus();
}

// A plain JSON file with everything this customer has saved.
async function downloadData(o) {
  try {
    const data = await api('GET', `/api/admin/owners/${o.id}/backup`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = h('a', { href: url, download: `boathouse-${o.email.replace(/[^a-z0-9]+/gi, '-')}-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Data file downloaded.');
  } catch (e) { toast(e.message); }
}

/* ---------- start ---------- */
async function enterApp() {
  me = await api('GET', '/api/me');
  $('owner-name').textContent = me.name; $('menu-name').textContent = me.name; $('menu-email').textContent = me.email;
  $('avatar').textContent = (me.name.trim()[0] || 'B').toUpperCase();
  const admin = me.role === 'admin';
  $('app').dataset.role = admin ? 'admin' : 'owner';
  $('clear-chat').hidden = admin; $('menu-aikey').hidden = admin;
  $('auth').hidden = true; $('app').hidden = false;
  if (admin) { $('admin-view').hidden = false; $('menu-trial').hidden = true; await renderAdmin(); return; }
  $('admin-view').hidden = true;
  // a trial account always sees how long is left
  const left = me.trial?.days_left;
  $('menu-trial').hidden = left == null;
  if (left != null) {
    $('menu-trial').textContent = `Free trial: ${plural(left, 'day')} left`;
    if (left <= 3) toast(`Your free trial ends in ${plural(left, 'day')}. Please contact the owner for renewal.`);
  }
  $('mode-badge').hidden = me.ai;
  showView('chat'); renderChips(); renderTabs();
  await Promise.all([loadHistory(), refreshPanel()]);
}

(async function boot() {
  if (store('token')) { try { await enterApp(); return; } catch (e) { if ($('auth').hidden) logout(); } }
  $('auth').hidden = false;
})();
