// Keeps a secret (like a customer's Gemini API key) encrypted inside the database.
// AES-256-GCM, with the key made from the server secret (JWT_SECRET / data/.secret).
// A copy of the database file alone cannot be read without that secret. The key is never sent back to any browser.
import crypto from 'node:crypto';

const keyFrom = (secret) => crypto.createHash('sha256').update(`boathouse-secretbox-v1:${secret}`).digest();

export function seal(plain, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

// Returns the text, or null when it cannot be opened (wrong secret, damaged value).
export function open(sealed, secret) {
  try {
    const [v, iv, tag, ct] = String(sealed).split('.');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
