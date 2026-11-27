import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Tiny .env loader (no dependency). Real environment variables win over the file.
export function loadEnv(file = '.env') {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* no .env file: fine */ }
}

export function getConfig(overrides = {}) {
  const env = process.env;
  const cfg = {
    port: Number(env.PORT || 3000),
    mongoUri: env.MONGODB_URI || '',        // MongoDB Atlas connection string (mongodb+srv://...)
    mongoDb: env.MONGODB_DB || '',          // database name; empty = the one in the connection string, else "boathouse"
    secretFile: env.SECRET_FILE || 'data/.secret',
    geminiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-flash-lite-latest',
    secret: env.JWT_SECRET || '',
    allowSignup: env.ALLOW_SIGNUP === 'true',
    contactInfo: (env.CONTACT_INFO || '').trim(), // shown to customers whose trial ended, e.g. "WhatsApp 98xxxxxx"
    corsOrigins: (env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean),
    tz: env.APP_TZ || 'Asia/Kolkata',
    trustProxy: env.TRUST_PROXY === 'true', // true only behind ONE trusted proxy (Render, Railway, Nginx...) that sets X-Forwarded-For
    ...overrides,
  };
  if (env.NODE_ENV === 'production' && !overrides.store && !String(cfg.mongoUri).startsWith('mongodb')) {
    // memory:// would lose every booking on restart, so the live server never runs without a real database
    throw new Error('MONGODB_URI must be your MongoDB Atlas connection string (mongodb+srv://...) on the live server.');
  }
  if (!cfg.secret && env.NODE_ENV === 'production' && !overrides.secret) {
    // On a host the disk is wiped on every deploy: a generated secret would log everyone out and make saved AI keys unreadable.
    throw new Error('JWT_SECRET is missing. Set a long random JWT_SECRET (64 characters) in the host\'s environment variables.');
  }
  if (!cfg.secret) {
    // Your own computer: persist a generated secret so logins survive restarts.
    const f = cfg.secretFile;
    try { cfg.secret = fs.readFileSync(f, 'utf8').trim(); } catch { /* generate below */ }
    if (!cfg.secret) {
      cfg.secret = crypto.randomBytes(32).toString('hex');
      if (!String(cfg.mongoUri).startsWith('memory:')) {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, cfg.secret, { mode: 0o600 });
      }
    }
  }
  return cfg;
}
