// Google OAuth 2.0 (web flow, multiple accounts) and a small authenticated fetch helper.
// The owner creates his own OAuth client once (Settings -> Google walks him through it).
import { cfg } from './config.js';
import { all, get, run, now, setting, secret, audit, redact } from './db.js';
import { seal, unseal, token } from './crypto.js';

export const SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/contacts.readonly',
];
const B = (u) => cfg.googleBase ? cfg.googleBase + new URL(u).pathname + new URL(u).search : u;
export const redirectUri = () => cfg.publicUrl + '/oauth/google/callback';

const pending = new Map(); // state -> expires
export function authUrl() {
  const cid = setting('google_client_id');
  if (!cid || !secret('google_client_secret')) throw new Error('Add your Google OAuth client ID and secret first (Settings → Google).');
  const state = token(18);
  pending.set(state, now() + 15 * 60 * 1000);
  const p = new URLSearchParams({
    client_id: cid, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state,
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p;
}

export async function handleCallback(q) {
  const exp = pending.get(q.state);
  pending.delete(q.state);
  if (!exp || exp < now()) throw new Error('This sign-in link expired. Start again from Settings → Google.');
  if (q.error) throw new Error('Google said: ' + q.error);
  const r = await fetch(B('https://oauth2.googleapis.com/token'), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: q.code, client_id: setting('google_client_id'), client_secret: secret('google_client_secret'), redirect_uri: redirectUri(), grant_type: 'authorization_code' }),
  });
  const t = await r.json();
  if (!r.ok) throw new Error('Google token exchange failed: ' + redact(t.error_description || t.error || r.status));
  const ui = await (await fetch(B('https://openidconnect.googleapis.com/v1/userinfo'), { headers: { Authorization: 'Bearer ' + t.access_token } })).json();
  const email = String(ui.email || '').toLowerCase();
  if (!email) throw new Error('Google did not return an email address.');
  const old = get('SELECT token FROM google_accounts WHERE email=?', email);
  const refresh = t.refresh_token || (old ? unseal(old.token) : '');
  if (!refresh) throw new Error('Google returned no long-term token. Remove the app at myaccount.google.com/permissions and add the account again.');
  run(`INSERT INTO google_accounts(email,name,scopes,token,added,status) VALUES(?,?,?,?,?,'ok')
       ON CONFLICT(email) DO UPDATE SET name=excluded.name, scopes=excluded.scopes, token=excluded.token, status='ok'`,
      email, ui.name || '', t.scope || '', seal(refresh), now());
  cache.set(email, { at: t.access_token, exp: now() + (t.expires_in || 3000) * 1000 - 60000 });
  audit('owner', 'google.account_added', email);
  return email;
}

const cache = new Map();
export function accounts() { return all('SELECT id,email,name,status,added FROM google_accounts ORDER BY id'); }
export function pickAccount(acct) {
  const list = accounts();
  if (!list.length) throw new Error('No Google account is connected yet. Add one in Settings → Google.');
  if (!acct) return list[0].email;
  const a = String(acct).toLowerCase();
  const hit = list.find(x => x.email === a) || list.find(x => x.email.startsWith(a) || x.email.includes(a));
  if (!hit) throw new Error('No connected Google account matches "' + acct + '". Connected: ' + list.map(x => x.email).join(', '));
  return hit.email;
}

export async function accessToken(email) {
  const c = cache.get(email);
  if (c && c.exp > now()) return c.at;
  const row = get('SELECT token FROM google_accounts WHERE email=?', email);
  if (!row) throw new Error('Unknown Google account ' + email);
  const r = await fetch(B('https://oauth2.googleapis.com/token'), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: setting('google_client_id'), client_secret: secret('google_client_secret'), refresh_token: unseal(row.token), grant_type: 'refresh_token' }),
  });
  const t = await r.json();
  if (!r.ok) {
    if (t.error === 'invalid_grant') {
      run("UPDATE google_accounts SET status='expired' WHERE email=?", email);
      throw new Error('Google sign-in for ' + email + ' expired or was revoked. Open Settings → Google and tap "Reconnect". (In Testing mode Google expires it every 7 days; set the app to "In production" to stop that.)');
    }
    throw new Error('Google token refresh failed: ' + redact(t.error || r.status));
  }
  cache.set(email, { at: t.access_token, exp: now() + (t.expires_in || 3000) * 1000 - 60000 });
  return t.access_token;
}

/** Authenticated Google API call. Returns parsed JSON (or text/buffer when asked). */
export async function gapi(email, method, url, body, opts = {}) {
  const at = await accessToken(email);
  const headers = { Authorization: 'Bearer ' + at, ...(opts.headers || {}) };
  let payload = body;
  if (body !== undefined && !(body instanceof Buffer) && typeof body !== 'string') { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(B(url), { method, headers, body: payload, signal: AbortSignal.timeout(opts.timeout || 60000) });
  if (opts.raw) { if (!r.ok) throw new Error('Google API ' + r.status + ': ' + (await r.text()).slice(0, 300)); return opts.raw === 'buffer' ? Buffer.from(await r.arrayBuffer()) : await r.text(); }
  const txt = await r.text();
  let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { raw: txt.slice(0, 500) }; }
  if (!r.ok) {
    const msg = (j.error && (j.error.message || j.error)) || txt.slice(0, 300);
    if (r.status === 403 && /has not been used|is disabled/i.test(msg)) throw new Error('That Google API is not switched on in your Google Cloud project. Settings → Google has a one-tap "Enable APIs" link. (' + msg.slice(0, 160) + ')');
    throw new Error('Google API ' + r.status + ': ' + String(msg).slice(0, 300));
  }
  return j;
}
