# BoatHouse AI

A chat-first management dashboard for houseboat owners. You get a booking for several rooms and place them on your own
houseboat or on partner houseboats (for example "Chinar" or "Cultural Palace"). The bot asks for the missing details, shows a
review popup, then saves the booking and gives **one token per room** (first 3 letters of the houseboat + room number, like
`CUL001`, `CUL002`, `CHI001`). Later you can ask by day, client, houseboat or token.

- **Dashboard on the left, one chat on the right.** There is only one chat; "Clear chat" empties the messages only.
- No property or room setup. A houseboat is just a name, created the first time you use it in a booking.
- The bot always **replies in simple English**, even if you speak Hindi.
- Every change shows a **review popup / Confirm card** first. Nothing is saved until you confirm (click, or type/say "yes" / "haan").
- Money is tracked **both ways**: what each client owes you, and what you owe each partner houseboat (your own boats owe nothing).
- Every owner has fully separate data. Money is kept in an append-only ledger (mistakes are fixed with reversal entries, never edits).

## What you need on your computer

| Need | Why | Check |
|---|---|---|
| Node.js **22.13 or newer** | runs the server | `node -v` |
| A free MongoDB Atlas database | keeps all the data (accounts, bookings, money, chat) | https://www.mongodb.com/cloud/atlas |
| Chrome or Edge | voice input (Firefox/Safari have no speech recognition) | |
| A free Gemini API key | the AI brain | https://aistudio.google.com/apikey |

## Run it locally

```bash
cd boathouse-ai
npm install                   # installs the MongoDB driver (the only package)
cp .env.example .env          # Windows: copy .env.example .env
# open .env and fill in:  MONGODB_URI=...   GEMINI_API_KEY=...
# also in .env: ADMIN_EMAIL and ADMIN_PASSWORD -> the admin login is created on the first start
# (or make it by hand: npm run add-admin)
npm run seed                  # optional: demo bookings  (login demo@boathouse.local / demo12345)
npm start
```

There is **no sign-up page**. Owners are created by you (the admin) on the server:

```bash
npm run add-owner                      # asks for name, email and password (the password is hidden)
npm run reset-password -- owner@email  # sets a new password for someone who forgot it
```

Then open http://localhost:3000, log in and start chatting.

### MongoDB Atlas in 5 steps

1. Create a free cluster at https://www.mongodb.com/cloud/atlas (any region near you, e.g. Mumbai).
2. **Database Access** → add a user, e.g. `boathouse_app`, with a long random password and the role *Read and write to any database* (or, better, `readWrite` on the `boathouse` database only).
3. **Network Access** → add your own IP for testing. For Render add `0.0.0.0/0` (Render's free plan has no fixed IP), which is why the long password matters.
4. **Connect → Drivers** → copy the `mongodb+srv://...` string, put your password in it and add the database name before the `?`: `...mongodb.net/boathouse?retryWrites=true&w=majority`.
5. Paste it as `MONGODB_URI` in `.env` (and later in Render). Never commit it.

### Moving your old data from SQLite

If you used the earlier version, your data is in `data/boathouse.db`. Copy it into MongoDB once:

```bash
npm run migrate-to-mongo      # reads data/boathouse.db, writes into the (empty) MongoDB database from .env
```

Every id stays the same (booking #12 stays #12) and every password keeps working. The SQLite file is only read; keep it as a backup.
It refuses to copy into a database that already has accounts, so nothing can get mixed or duplicated.
Also copy the value of `data/.secret` into `JWT_SECRET` (in `.env` and on Render): with the same secret, logins and saved customer AI keys keep working.

### Login rules
- **One login at a time.** When an owner logs in on a new phone or browser, every older login is signed out. The old device sees a message saying the account was opened on another device.
- **Change password:** tap your avatar (top right) → *Change password*. It checks the current password, saves the new scrypt hash in the database, keeps this device logged in and signs the others out.
- **Forgot password:** run `npm run reset-password -- owner@email` on the server (no e-mail service is needed).

### Install as an app
BoatHouse is an installable web app (PWA): avatar menu → *Install the app* (also shown on the login screen). Android Chrome and desktop Chrome/Edge install in one tap; on iPhone it shows the Safari steps (Share → Add to Home Screen). Phones only offer Install on an **https** address, so it works from the hosted link, not from `http://192.168...`. For a real Android `.apk` or Play Store listing, wrap the hosted https link with PWABuilder or Capacitor later.
Without a Gemini key the app still runs in **simple mode** (keywords like "summary", "bookings", "balance", "payable", "rooms on 2 Dec", a token like CUL001);
adding or changing data needs the key.

Run the automated tests with `npm test`.

## Voice

- Pick **EN** or **हिं** next to the mic before you speak. Choose **हिं** for Hindi (it also catches English words like "booking" or "December"). What you say in Hindi appears in the box as Hinglish in English letters (for example "mera hisab batao"), so it is easy to read and fix.
- Tap the mic once to start. It **stays on until you tap it again**, even through pauses. Your words appear in the box so you can fix them, then press Send.
- **AI voice clean-up** (always on when the Gemini key is set, no switch): there is just one mic button. While you speak, the browser's own recogniser shows rough live text in English letters. When you turn the mic off, your recorded voice is sent to Gemini, which writes the text properly (Hindi, English or Hinglish; it also knows your houseboat names), and replaces the rough text in the box. It uses a little free AI quota per recording. If the AI is busy or there is no key, the rough text is kept.
- Tick "Send automatically when I turn the mic off" if you want it to send as soon as you stop.
- Voice needs Chrome or Edge and a microphone permission. You can also just type in Hindi (Devanagari), Hinglish or English.

**Is the AI really connected?** Run `npm run check-ai`. It prints CONNECTED, or the exact reason from Gemini (bad key, quota, wrong model).

## Giving the app to boat owners (admin and 10-day trial)

You (the BoatHouse admin) have one special login. It opens a **Customers** screen instead of the boat dashboard.

1. Make your admin login once: `npm run add-admin`. It asks for your name, email and password (typing is hidden). The password is never written in any file.
2. Log in. Tap **+ Add customer**, enter the owner's name and email, then **Create login**. A box shows the login link, email and password. Tap **Copy login details** and send it on WhatsApp. The owner can change the password later from the top right menu.
3. The free trial lasts exactly 10 days from that moment (you can change the days in the form). After that the owner cannot log in or use the app, and sees: "Your free trial has ended. Please contact the owner for renewal of this service." Their data is not deleted.
4. For each customer you can **Extend trial**, **Renew (paid)** (no end date), **Lock now** / **Unlock**, **Reset password**, **Download data** (a JSON file of everything they saved) and set their **AI key**.

Each owner can use their own Gemini API key, so the AI load is spread over many keys. Ask the owner to make one at https://aistudio.google.com/apikey and send it to you, then paste it in **AI key** (or in the Add customer form). It is saved encrypted. **Test AI** checks that it works. A customer without a key uses the shared `GEMINI_API_KEY` from `.env`, or simple mode if there is none.

Set `CONTACT_INFO` in `.env` (for example a phone number) to add it to the "contact the owner" message.

All customers share one database, but every query is filtered by owner, so one owner never sees another's data.

**Database note:** all customers share your MongoDB database. **Download data** gives you one customer's full data as a JSON file (for example before moving them to their own database, which is not built yet).

## Security

- **Secrets never go to GitHub.** `.env` (with the MongoDB connection string), `data/` and backups are in `.gitignore`. Only `.env.example` (empty values) is committed.
- **Passwords** are stored as scrypt hashes. API keys of customers are stored encrypted (AES-256-GCM). Neither is ever sent to the browser.
- **Everything is checked on the server.** The browser only shows data. Changing the page, the JavaScript or the browser storage cannot unlock a trial, open the admin screen, or reach another owner's data: every request is checked for a valid signed token, the account's role, its trial or lock, and the owner of each row.
- **Login tokens** are signed (HMAC-SHA256) and cannot be edited. Logging in on a new device signs out the old one. Changing or resetting a password signs out everywhere.
- **Brute force:** login is limited per IP and per account. Unknown email and wrong password give the same answer in the same time.
- **Abuse:** chat is limited to 40 messages per minute per owner, voice to 30 per minute. Big requests are refused.
- **Browser protections:** strict Content-Security-Policy (no inline or outside scripts), no framing, no MIME sniffing, camera and location off, HTTPS-only (HSTS) when hosted.
- **Static files:** only files inside `public/` are served; hidden files (like `.env`) and `../` paths are refused.
- `npm test` includes `test/security.test.js`, which tries these attacks and must pass.

- **Database:** the MongoDB user only needs `readWrite` on the `boathouse` database. Use a long random password (the Atlas network list is open to Render). Atlas keeps the data encrypted at rest; turn on its backups (paid tiers) or export regularly.
- **Bookings in MongoDB:** a database rule refuses any booking without a real sender, a unique key per room and night makes double booking impossible, and every confirmed change runs in one transaction (all or nothing). The ledger is append-only in the app: there is no code path that edits an entry, and entries are removed only by a confirmed "delete booking" / "delete all".

**When you host it:** use HTTPS, set a long random `JWT_SECRET` (the server refuses to start without it when `NODE_ENV=production`), set `TRUST_PROXY=true` behind Render / Railway / Nginx, keep `ALLOW_SIGNUP=false`, and never run `npm run seed` on the live database (its demo password is public; it refuses when `NODE_ENV=production`). If `JWT_SECRET` changes, everyone must log in again and saved customer AI keys must be entered again.

## Things to try (say or type)

- `2 Dec, 8 rooms, 4 mine, 2 Chinar, 2 Cultural Palace` - the bot asks client name and phone, **who sent the booking (sender)**, check-out date, guests per room, price per room and meal plan (EP, CP, MAP, AP) for each room, then shows the review popup. Say **skip** for guests, price or meal plan and fill them in later.
- `39 rooms needed, 31 for now` - saved as "39 required, 31 allocated, 8 left"; later `add 8 rooms to booking 5`.
- In the popup: press **Confirm & save**, or **Change something** and type e.g. `make Chinar 4500`.
- `Where did I give rooms on 2 Dec for Sharma?` - own rooms, each houseboat's rooms, guests per room, totals and money.
- `Who is in CUL001?` / `Show Chinar bookings`
- `What do I owe Cultural Palace?` / `Mera hisab batao` (clients) 
- `Sharma ne 20 hazaar diye, UPI` / `Chinar ko 10000 diye`
- `CUL001 me 4 guests kar do` / `Cancel booking 1`
- Counts: `How many rooms in Chinar on 28 Dec?` / `How many MAP rooms on 3 Jan?` / `How many rooms did ABC Travels send in January?`
- Free rooms: `How many rooms are vacant on 25 Dec?` (needs total rooms set with the Add houseboat button)
- Money by period: `December revenue`, `Chinar billing in January` (or open the **Reports** tab)
- Changes: `Change booking 5 to 3 Jan`, `Move CUL002 to Chinar`, `Remove CHI003 from booking 5`, `Change sender of booking 5 to Direct`
- Meal plans for many houseboats at once: say `28 December: Flower Garden EP, Chinar CP, Helen of Troy AP`. One confirm popup lists every room that will change (CPI and API are read as CP and AP).
- Delete one booking: say `delete booking 3` (or press **Delete** on the booking card). It removes the booking, its rooms and its money entries for good, after a confirm popup. Use `cancel booking 3` instead if you want to keep the record.
- Delete a houseboat: say `delete Chinar` (or press **Delete** on its card in the Houseboats tab). Allowed only when that houseboat has no bookings; otherwise delete or move those bookings first.
- A houseboat has 1 to 5 rooms (usually 3 or 4). A big group (for example 40 rooms) is spread over several houseboats, never put in one.
- Start fresh: type `delete all` (or `sab booking delete kar do`). You get a confirm popup showing how many bookings and money entries will be deleted for good. Houseboats and chat stay.
- Pending work: `Which bookings have details pending?` then `CHI002 guests 3, CP, 4500`

**Meal plans:** EP = room only, CP = + breakfast, MAP = + breakfast and dinner, AP = all meals. MAPI / CPI / EPI are understood as MAP / CP / EP.
**Sender (compulsory):** every new booking needs the name of who sent it (agent, company, person, or `Direct`). The bot asks if you forget, it never saves "Not Provided", and the database itself refuses a booking without a sender.
**Money rule used:** the client price is per room per night. A partner houseboat is assumed to charge you the same unless you say what you pay it (then it is stored as the houseboat price). Rooms on your own houseboat have nothing to pay out.

## How it works

```
Mic / keyboard -> editable text box -> POST /api/chat
   -> Gemini picks ONE tool + arguments (it never touches the database)
   -> server validates the arguments and runs the tool for the logged-in owner only
   -> read tool: result goes back to Gemini, which explains it in English
   -> write tool: server stores a pending action and shows a Confirm card
   -> Confirm (button or "haan") -> one MongoDB transaction (all or nothing) -> dashboard refreshes
```

Key rules (from the Phase 1 architecture PDF):
- Each `room_night_locks` document has the key `houseboat:room:date`, so two bookings can never take the same room token on the same night. Room numbers are given automatically (lowest free number), so overlapping bookings on one houseboat get CUL001, CUL002, CUL003...
- `ledger` is append-only: the data layer refuses to edit or delete entries (only a confirmed delete of bookings removes them).
- The AI only chooses from a fixed tool list; unknown tools or bad arguments are rejected.
- The confirmation text is written by the server, so it always matches what will be saved.

Upgrading from the SQLite version: run `npm run migrate-to-mongo` once (see above). Bookings made before the sender rule get the sender "Old booking (no sender)"; change it any time (`Change sender of booking 5 to ...`).

**Dashboard tabs:** Overview (with "details pending" and "rooms to allocate" alerts), Bookings (search by client or sender, day view with vacant rooms), Houseboats, Money, Calendar, **Clients** (clients and senders built automatically from your bookings, with totals and dues), **Reports** (month by month revenue by houseboat and by sender).

Files: `server/tools.js` (all business logic and the tool list), `server/chat.js` (AI loop + confirm gate),
`server/store.js` (MongoDB: collections, indexes, transactions), `server/ai.js` (Gemini adapter; swap it to use another model),
`public/` (the whole UI, no build step). Tests run on a small in-memory stand-in (`server/memory-mongo.js`), so `npm test` needs no database.
To run the same tests on real MongoDB, set `TEST_MONGODB_URI` in `.env` and run `npm run test:atlas` (each run uses temporary `bh_test_...` databases and empties them).

## Putting it online (Render + MongoDB Atlas)

The server also serves the website, so one Render service is all you need (no Netlify, no disk: the data is in Atlas).

1. Push the code to GitHub (`.env` and `data/` stay on your computer).
2. On Render: **New → Blueprint** → pick the repo. It reads `render.yaml` and asks for:
   - `MONGODB_URI`: your Atlas string (see above)
   - `JWT_SECRET`: a long random string. If you copied old data, use the value of your `data/.secret` (or your old `JWT_SECRET`).
   - `GEMINI_API_KEY` (optional shared key) and `CONTACT_INFO` (for example your WhatsApp number)
3. Make your admin login from your own computer: put the same `MONGODB_URI` in your `.env` and run `npm run add-admin` (it writes straight into Atlas). Skip it if you copied your data and already have an admin.
4. Open the `https://...onrender.com` link, log in, and add customers.

The free plan sleeps after 15 minutes without visitors (the first visit then takes about a minute). Choose the Starter plan in Render to keep it always on.

## Not built yet (planned next)

Partner owners and temporary holds, WhatsApp hand-off, GST invoices, staff roles and permissions,
reports to PDF/Excel, offline PWA, Ollama (local AI) option.
