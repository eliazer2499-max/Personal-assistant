// Secrets at rest, passwords, TOTP 2FA and random tokens. Node built-ins only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let MASTER = null;

/** Load (or create on first run) the 32-byte master key: <dataDir>/master.key, mode 600. */
export function loadMasterKey(dataDir) {
  const p = path.join(dataDir, 'master.key');
  if (!fs.existsSync(p)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, crypto.randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
  }
  try { fs.chmodSync(p, 0o600); } catch {}
  const k = Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'base64');
  if (k.length !== 32) throw new Error('master.key is damaged');
  MASTER = k;
}

/** AES-256-GCM. Output "v1:" + base64(iv | tag | ciphertext). */
export function seal(plain) {
  if (!MASTER) throw new Error('master key not loaded');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', MASTER, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function unseal(box) {
  if (!box) return '';
  if (!MASTER) throw new Error('master key not loaded');
  const b = Buffer.from(String(box).slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', MASTER, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return 'scrypt$32768$' + salt.toString('base64') + '$' + h.toString('base64');
}
export function verifyPassword(pw, stored) {
  try {
    const [kind, n, salt, hash] = String(stored).split('$');
    if (kind !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length,
      { N: parseInt(n, 10), r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
    return crypto.timingSafeEqual(want, got);
  } catch { return false; }
}

export function token(bytes = 24) { return crypto.randomBytes(bytes).toString('base64url'); }
export function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function hmacHex(key, data) { return crypto.createHmac('sha256', key).update(data).digest('hex'); }

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const ch of clean) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function newTotpSecret() { return base32Encode(crypto.randomBytes(20)); }
export function totpAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
export function totpNow(secret, t = Date.now()) { return totpAt(secret, Math.floor(t / 30000)); }
/** Returns the matching time step (for replay protection) or -1. Accepts one step of clock drift. */
export function totpCheck(secret, code, t = Date.now()) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return -1;
  const step = Math.floor(t / 30000);
  for (const s of [step, step - 1, step + 1]) if (safeEqual(totpAt(secret, s), c)) return s;
  return -1;
}
export function otpauthUri(secret, label, issuer) {
  return 'otpauth://totp/' + encodeURIComponent(issuer + ':' + label) + '?secret=' + secret +
    '&issuer=' + encodeURIComponent(issuer) + '&algorithm=SHA1&digits=6&period=30';
}
