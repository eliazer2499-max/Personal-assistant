// Owner-only access: setup code (printed by the installer) -> password -> authenticator-app 2FA.
// Sessions are random tokens (only their hash is stored). Logins are rate-limited.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { cfg, isHttps } from './config.js';
import { get, run, all, now, setting, setSetting, secret, setSecret, audit, log } from './db.js';
import { hashPassword, verifyPassword, newTotpSecret, totpCheck, otpauthUri, token, sha256, safeEqual } from './crypto.js';

const SESSION_DAYS = 30;
const setupCodeFile = () => path.join(cfg.dataDir, 'setup-code');

export function setupNeeded() { return setting('setup_done') !== '1'; }
export function ensureSetupCode() {
  if (!setupNeeded()) return;
  if (!fs.existsSync(setupCodeFile())) {
    const code = token(9).replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase();
    fs.writeFileSync(setupCodeFile(), code + '\n', { mode: 0o600 });
    log(`First-run setup code written to ${setupCodeFile()} (run: sudo myassistant setup-code)`);
  }
}
function readSetupCode() { try { return fs.readFileSync(setupCodeFile(), 'utf8').trim(); } catch { return ''; } }

// ---- rate limiting ----
export function clientIp(req) {
  const ra = req.socket.remoteAddress || '';
  if (/^(::ffff:)?127\.0\.0\.1$|^::1$/.test(ra) && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return ra.replace(/^::ffff:/, '');
}
export function limited(ip) {
  const perIp = get('SELECT COUNT(*) AS n FROM login_fail WHERE ip=? AND ts>?', ip, now() - 15 * 60000).n;
  const global = get('SELECT COUNT(*) AS n FROM login_fail WHERE ts>?', now() - 3600000).n;
  if (perIp >= 5) return 'Too many tries. Wait 15 minutes.';
  if (global >= 30) return 'Logins are locked for an hour after many failed tries.';
  return '';
}
function fail(ip, what) { run('INSERT INTO login_fail(ip,ts) VALUES(?,?)', ip, now()); audit('anon', 'login.fail', `${what} from ${ip}`); }

// ---- QR (qrencode, reads text from stdin so secrets never appear in the process list) ----
export function qrSvg(text) {
  return new Promise((resolve) => {
    const p = execFile('qrencode', ['-t', 'SVG', '-m', '2', '-o', '-'], { timeout: 10000 }, (err, out) => resolve(err ? '' : String(out)));
    p.stdin.end(text);
  });
}

// ---- first-run setup ----
const pendingSetup = new Map();
export async function setupStart(ip, { code, password }) {
  if (!setupNeeded()) throw httpErr(409, 'Setup is already done.');
  const why = limited(ip); if (why) throw httpErr(429, why);
  const want = readSetupCode();
  if (!want || !safeEqual(String(code || '').trim().toUpperCase(), want)) { fail(ip, 'setup code'); throw httpErr(403, 'Wrong setup code. It was printed at the end of the install (or run: sudo myassistant setup-code).'); }
  if (String(password || '').length < 10) throw httpErr(400, 'Use a password of at least 10 characters.');
  const t = token(18), secretB32 = newTotpSecret();
  pendingSetup.set(t, { pw: hashPassword(password), secret: secretB32, exp: now() + 20 * 60000 });
  const uri = otpauthUri(secretB32, 'owner@' + (new URL(cfg.publicUrl).hostname), setting('assistant_name') || 'My Assistant');
  return { setup_token: t, secret: secretB32.replace(/(.{4})/g, '$1 ').trim(), otpauth: uri, qr_svg: await qrSvg(uri) };
}
export function setupFinish(ip, { setup_token, code }) {
  const p = pendingSetup.get(setup_token);
  if (!p || p.exp < now()) throw httpErr(400, 'Setup timed out. Start again.');
  const step = totpCheck(p.secret, code);
  if (step < 0) { fail(ip, 'setup totp'); throw httpErr(403, 'That 6-digit code did not match. Check the phone\'s time is automatic and try the newest code.'); }
  setSetting('owner_password', p.pw);
  setSecret('totp_secret', p.secret);
  setSetting('totp_last_step', step);
  const recovery = Array.from({ length: 8 }, () => token(6).replace(/[^A-Za-z0-9]/g, 'x').slice(0, 8).toUpperCase());
  setSetting('recovery_codes', recovery.map(c => sha256(c)).join(','));
  setSetting('setup_done', '1');
  pendingSetup.delete(setup_token);
  try { fs.rmSync(setupCodeFile()); } catch {}
  audit('owner', 'setup.done', 'password + 2FA set from ' + ip);
  return { recovery };
}

// ---- login / sessions ----
export function login(ip, ua, { password, code }) {
  if (setupNeeded()) throw httpErr(409, 'Finish setup first.');
  const why = limited(ip); if (why) throw httpErr(429, why);
  if (!verifyPassword(password, setting('owner_password'))) { fail(ip, 'password'); throw httpErr(403, 'Wrong password or code.'); }
  const c = String(code || '').trim();
  const step = totpCheck(secret('totp_secret'), c);
  let ok = false;
  if (step >= 0 && step > Number(setting('totp_last_step') || 0)) { setSetting('totp_last_step', step); ok = true; }
  else if (/^[A-Za-z0-9]{8}$/.test(c)) {
    const list = setting('recovery_codes').split(',').filter(Boolean);
    const h = sha256(c.toUpperCase());
    if (list.includes(h)) { setSetting('recovery_codes', list.filter(x => x !== h).join(',')); ok = true; audit('owner', 'login.recovery_code_used', `${list.length - 1} left`); }
  }
  if (!ok) { fail(ip, 'code'); throw httpErr(403, 'Wrong password or code.'); }
  audit('owner', 'login.ok', ip);
  return newSession(ip, ua);
}
export function newSession(ip, ua) {
  const t = token(32), csrf = token(18);
  run('INSERT INTO sessions(id,csrf,created,expires,ip,ua) VALUES(?,?,?,?,?,?)', sha256(t), csrf, now(), now() + SESSION_DAYS * 86400000, ip, String(ua || '').slice(0, 200));
  return { cookie: `ma_sid=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isHttps() ? '; Secure' : ''}`, csrf };
}
export function sessionFrom(req) {
  const m = /(?:^|;\s*)ma_sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = get('SELECT * FROM sessions WHERE id=? AND expires>?', sha256(m[1]), now());
  return s || null;
}
export function logout(req) {
  const s = sessionFrom(req);
  if (s) run('DELETE FROM sessions WHERE id=?', s.id);
  return `ma_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps() ? '; Secure' : ''}`;
}
export function changePassword(ip, { old_password, new_password, code }) {
  if (!verifyPassword(old_password, setting('owner_password')) || totpCheck(secret('totp_secret'), code) < 0) { fail(ip, 'change password'); throw httpErr(403, 'Old password or code is wrong.'); }
  if (String(new_password || '').length < 10) throw httpErr(400, 'Use at least 10 characters.');
  setSetting('owner_password', hashPassword(new_password));
  run('DELETE FROM sessions');
  audit('owner', 'password.changed', ip);
}
export function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
