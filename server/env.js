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
    dbFile: env.DB_FILE || 'data/boathouse.db',
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
  if (!cfg.secret) {
    // Persist a generated secret so logins survive restarts.
    const f = path.join(path.dirname(cfg.dbFile === ':memory:' ? 'data/x' : cfg.dbFile), '.secret');
    try { cfg.secret = fs.readFileSync(f, 'utf8').trim(); } catch { /* generate below */ }
    if (!cfg.secret) {
      cfg.secret = crypto.randomBytes(32).toString('hex');
      if (cfg.dbFile !== ':memory:') {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, cfg.secret, { mode: 0o600 });
      }
    }
  }
  return cfg;
}
