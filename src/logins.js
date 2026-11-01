// 2.3.8: Saved logins — accounts the assistant made (or uses) on websites for the owner.
// The password is stored encrypted like AI keys and platform tokens (AES-256-GCM with master.key, in the
// secrets table). It never goes to the AI, the chat, the logs or Activity; only the owner can see it in
// Settings → Browser & logins (Show), while logged in.
import crypto from 'node:crypto';
import { db, all, get, run, now, setSecret, secret, rememberSecret, audit } from './db.js';

let ready = false;
function ensure() {
  if (ready && db) return;
  db.exec(`CREATE TABLE IF NOT EXISTS saved_logins (id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, email TEXT,
    status TEXT DEFAULT 'saved', created INTEGER, updated INTEGER, note TEXT)`);
  ready = true;
}
const SEC = (id) => 'login_pw_' + id;

/** "https://www.Example.com/signup?x" → "example.com". */
export function siteKey(s) {
  let v = String(s || '').trim().toLowerCase();
  if (!v) return '';
  try { v = new URL(/^[a-z]+:\/\//.test(v) ? v : 'https://' + v).hostname; } catch { v = v.replace(/[/?#].*$/, ''); }
  return v.replace(/^www\./, '').slice(0, 120);
}

/** A strong random password: 20 characters with upper, lower, digits and a few symbols most sites accept. */
export function newPassword(len = 20) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#%*-_+?'];
  const allc = sets.join('');
  const pick = (s) => s[crypto.randomInt(s.length)];
  const out = sets.map(pick);
  while (out.length < len) out.push(pick(allc));
  for (let i = out.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}

export function listLogins() {
  ensure();
  return all('SELECT id, site, email, status, created, updated, note FROM saved_logins ORDER BY site, id');
}
export function findLogin(site, email) {
  ensure();
  const k = siteKey(site);
  const rows = all('SELECT * FROM saved_logins WHERE site=? ORDER BY updated DESC, id DESC', k);
  if (email) return rows.find(r => (r.email || '').toLowerCase() === String(email).toLowerCase()) || null;
  // the same site family: login saved on example.com also works for app.example.com
  return rows[0] || all('SELECT * FROM saved_logins ORDER BY updated DESC').find(r => k.endsWith('.' + r.site) || r.site.endsWith('.' + k)) || null;
}
/** Save (or replace) the password for site + email. Returns the row id. The value never leaves this module except via loginPassword(). */
export function saveLogin({ site, email, password, status = 'saved', note = '' }) {
  ensure();
  const k = siteKey(site);
  if (!k) throw new Error('Which website? (site is empty)');
  if (!password) throw new Error('No password to save');
  rememberSecret(password);
  const old = findLogin(k, email || '');
  let id;
  if (old && (old.email || '') === (email || '')) { id = old.id; run('UPDATE saved_logins SET status=?, updated=?, note=? WHERE id=?', status, now(), note, id); }
  else id = Number(run('INSERT INTO saved_logins(site,email,status,created,updated,note) VALUES(?,?,?,?,?,?)', k, email || '', status, now(), now(), note).lastInsertRowid);
  setSecret(SEC(id), password);
  audit('assistant', 'login.saved', `${k}${email ? ' · ' + email : ''}`);
  return id;
}
export function setLoginStatus(id, status) { ensure(); run('UPDATE saved_logins SET status=?, updated=? WHERE id=?', status, now(), Number(id)); }
export function loginRow(id) { ensure(); return get('SELECT * FROM saved_logins WHERE id=?', Number(id)) || null; }
export function loginPassword(id) { ensure(); return secret(SEC(Number(id))); }
export function removeLogin(id, actor = 'owner') {
  ensure();
  const r = loginRow(id);
  if (!r) return false;
  run('DELETE FROM saved_logins WHERE id=?', r.id);
  setSecret(SEC(r.id), '');
  audit(actor, 'login.removed', `${r.site}${r.email ? ' · ' + r.email : ''}`);
  return true;
}
