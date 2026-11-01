// 2.3.11: pictures through the owner's own Cloudflare account (Workers AI, free daily allowance).
// A "Cloudflare (pictures)" key = Account ID (not secret, kept in the key's base_url column) + an API token
// (secret, kept encrypted like every other AI key). Only used for Pictures; never for chat.
// Docs checked Nov 1 2026: POST /accounts/{id}/ai/run/{model}; flux-1-schnell answers JSON {result:{image:<base64>}},
// stable-diffusion / dreamshaper / phoenix answer raw image bytes, flux-2 models take multipart form data.
// Free allowance: 10,000 Neurons a day, reset 00:00 UTC; error 3036 (HTTP 429) when it is used up.
import { cfg } from './config.js';
import { redact, rememberSecret, log, setting } from './db.js';

export const CF_DEFAULT_MODEL = '@cf/black-forest-labs/flux-1-schnell';
export const CF_PERMISSION = 'Workers AI (Workers AI Read + Workers AI Edit)';
export const cfBase = () => String(cfg.cloudflareBase || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
const T = () => (cfg.testMode ? 8000 : 30000);

/** Account IDs are 32 hex characters. Returns the cleaned id or '' when it can't be one. */
export function cleanAccountId(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(s) ? s : '';
}
export const ACCOUNT_ID_HELP = 'That Account ID doesn\'t look right. It is 32 letters and numbers, on the right side of your Cloudflare account home page (dash.cloudflare.com).';
/** Workers AI text-to-image model names look like @cf/black-forest-labs/flux-1-schnell. */
export function cleanCfModel(v) {
  const s = String(v ?? '').trim() || CF_DEFAULT_MODEL;
  if (!/^@[a-z0-9-]+\/[A-Za-z0-9._\-]+(\/[A-Za-z0-9._\-]+)*$/.test(s) || s.length > 200) return '';
  return s;
}

/** Cloudflare's own error words: { codes: [n], msg } (never includes the token: it is redacted and wiped). */
export function cfErrors(text, token = '') {
  let codes = [], msg = '';
  try {
    const j = JSON.parse(text);
    const errs = Array.isArray(j.errors) ? j.errors : j.error ? [j.error] : [];
    codes = errs.map(e => Number(e.code)).filter(Boolean);
    msg = errs.map(e => e.message || '').filter(Boolean).join('; ') || String(j.message || '');
  } catch { msg = String(text || '').slice(0, 300); }
  msg = redact(msg).replace(/\s+/g, ' ').trim();
  if (token && token.length >= 4) msg = msg.split(token).join('[hidden]');
  return { codes, msg: msg.length > 220 ? msg.slice(0, 219) + '…' : msg };
}
/** Out of today's free amount (or Cloudflare is busy): try the next picture key. */
export function isCfLimit(status, codes, msg) {
  return status === 429 || codes.includes(3036) || codes.includes(3040) || /daily free allocation|neurons|rate limit|capacity temporarily exceeded/i.test(msg);
}

async function call(url, init, token) {
  try {
    return await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(init.timeout || T()) });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code || e.message || 'no answer');
    const err = new Error('Could not reach Cloudflare (' + redact(String(why)) + ')'); err.network = true; throw err;
  }
}
async function readJson(r) { const text = await r.text().catch(() => ''); let j = {}; try { j = JSON.parse(text); } catch {} return { text, j }; }

/**
 * Test a Cloudflare key: 1) is the token valid (GET /user/tokens/verify, or the account-token verify),
 * 2) can it use Workers AI on this account (GET /accounts/{id}/ai/models/search?task=Text-to-Image) → the
 * picture models as chips. No picture is made (no allowance used).
 * → { ok, message, models, model, model_listed, problem }
 */
export async function cfTest({ accountId, token, model }) {
  token = String(token || '').trim(); rememberSecret(token);
  const m = cleanCfModel(model);
  const out = (ok, message, extra = {}) => ({ ok, message: (ok ? '✓ ' : '✗ ') + message, models: [], model: m || String(model || ''), ...extra });
  if (!token) return out(false, 'Paste the API token first, then tap Test.', { problem: 'no_key' });
  const acct = cleanAccountId(accountId);
  if (!acct) return out(false, ACCOUNT_ID_HELP, { problem: 'wrong_account' });
  const base = cfBase();
  try {
    // 1) the token itself
    let v = await call(base + '/user/tokens/verify', { method: 'GET' }, token);
    let vb = await readJson(v);
    if (!v.ok || !vb.j.success) {
      // account-owned tokens are checked at the account's own address
      const a = await call(`${base}/accounts/${acct}/tokens/verify`, { method: 'GET' }, token);
      const ab = await readJson(a);
      if (a.ok && ab.j.success) { v = a; vb = ab; }
    }
    if (!v.ok || !vb.j.success) {
      const e = cfErrors(vb.text, token);
      if (v.status >= 500) return out(false, 'Cloudflare is having trouble right now (' + v.status + '). Tap Test again in a minute.', { problem: 'server' });
      return out(false, 'Cloudflare says this API token is not valid' + (e.msg ? ' ("' + e.msg + '")' : '') + '. Copy it again (My Profile → API Tokens), paste it here and tap Test.', { problem: 'bad_token' });
    }
    const st = String(vb.j.result?.status || 'active');
    if (st !== 'active') return out(false, `This API token is ${st} (expired or switched off). Make a new one: My Profile → API Tokens → Create Token → "Workers AI" template.`, { problem: 'bad_token' });

    // 2) Workers AI on this account → the picture models
    const s = await call(`${base}/accounts/${acct}/ai/models/search?task=${encodeURIComponent('Text-to-Image')}&per_page=100`, { method: 'GET' }, token);
    const sb = await readJson(s);
    if (!s.ok || sb.j.success === false) {
      const e = cfErrors(sb.text, token);
      if (s.status === 429) return out(false, 'Cloudflare says: too many requests right now. Tap Test again in a minute.', { problem: 'limit' });
      if (s.status >= 500) return out(false, 'Cloudflare is having trouble right now (' + s.status + '). Tap Test again in a minute.', { problem: 'server' });
      if (s.status === 404 || e.codes.includes(7003) || e.codes.includes(7000)) return out(false, 'Cloudflare doesn\'t know this Account ID. Copy it again from the right side of your Cloudflare account home page.', { problem: 'wrong_account' });
      // 403 "Authentication error": another account's ID, or a token without the Workers AI permission. Ask which.
      let ids = null, names = [];
      try {
        const l = await call(base + '/accounts?per_page=50', { method: 'GET' }, token);
        const lb = await readJson(l);
        if (l.ok && Array.isArray(lb.j.result)) { ids = lb.j.result.map(x => String(x.id || '').toLowerCase()); names = lb.j.result.map(x => String(x.name || '')).filter(Boolean); }
      } catch {}
      if (ids && ids.length && !ids.includes(acct)) {
        return out(false, 'This Account ID is not the account this token belongs to' + (names.length ? ' (the token is for: ' + names.slice(0, 3).map(n => redact(n).slice(0, 60)).join(', ') + ')' : '') + '. Copy the Account ID from the same Cloudflare account you made the token in.', { problem: 'wrong_account' });
      }
      if (ids && ids.includes(acct)) {
        return out(false, 'This token doesn\'t have the "Workers AI" permission. Make a new token: My Profile → API Tokens → Create Token → "Workers AI" template (it gives Workers AI Read and Workers AI Edit) → Create, then paste it here.', { problem: 'no_permission' });
      }
      return out(false, 'Cloudflare refused (' + s.status + (e.msg ? ': ' + e.msg : '') + '). Either this token doesn\'t have the "Workers AI" permission, or the Account ID is from a different account. Make the token with the "Workers AI" template in the same account, and copy that account\'s ID.', { problem: 'no_permission' });
    }
    const rows = Array.isArray(sb.j.result) ? sb.j.result : [];
    const models = rows.filter(x => !x.task || /text-to-image/i.test(String(x.task?.name || x.task))).map(x => String(x.name || '')).filter(n => n.startsWith('@')).sort();
    if (!m) return out(false, 'Model names look like ' + CF_DEFAULT_MODEL + '. Tap one below.', { models, problem: 'model' });
    const listed = models.length ? models.includes(m) : undefined;
    if (listed === false) return out(false, `Token and Account ID work, but "${m}" is not one of Cloudflare's picture models. Tap one below.`, { models, model: m, model_listed: false, problem: 'model' });
    return out(true, `Works: token OK, Workers AI allowed. Pictures will use ${m}. (Test makes no picture, so none of today's free amount was used.)`, { models, model: m, model_listed: listed });
  } catch (e) {
    if (e.network) return out(false, e.message + '. Check the server\'s internet and tap Test again.', { problem: 'network' });
    throw e;
  }
}

/** When the free amount comes back (00:00 UTC), in the owner's time zone. */
export function cfResetText(t = Date.now()) {
  const d = new Date(t); const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  const tz = setting('timezone') || 'America/New_York';
  try { return new Date(next).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).replace(':00 ', ' '); }
  catch { return '00:00 UTC'; }
}
function sniff(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return '';
}
/**
 * Make one picture. → { ok: true, buf, mime, model } or { ok: false, status, limit, keyProblem, message } (message has
 * Cloudflare's own words, never the token).
 */
export async function cfGenerate({ accountId, token, model, prompt }) {
  token = String(token || '').trim(); rememberSecret(token);
  const acct = cleanAccountId(accountId), m = cleanCfModel(model);
  if (!token) return { ok: false, keyProblem: true, message: 'This Cloudflare key has no API token saved.' };
  if (!acct) return { ok: false, keyProblem: true, message: 'This Cloudflare key\'s Account ID is not right (32 letters and numbers).' };
  if (!m) return { ok: false, keyProblem: true, message: 'This Cloudflare key\'s model name is not right.' };
  const url = `${cfBase()}/accounts/${acct}/ai/run/${m}`;
  const p = String(prompt || '').slice(0, 2048);
  const viaJson = () => call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: p }), timeout: cfg.testMode ? 8000 : 120000 }, token);
  const viaForm = () => { const f = new FormData(); f.append('prompt', p); f.append('width', '1024'); f.append('height', '1024'); return call(url, { method: 'POST', body: f, timeout: cfg.testMode ? 8000 : 120000 }, token); };
  let r;
  try {
    r = /\/flux-2-/.test(m) ? await viaForm() : await viaJson();
    if (r.status === 400 && !/\/flux-2-/.test(m)) {
      const peek = await r.clone().text().catch(() => '');
      if (/multipart|form[- ]?data/i.test(peek)) r = await viaForm();
    }
  } catch (e) {
    if (e.network) return { ok: false, network: true, message: e.message };
    throw e;
  }
  const ct = String(r.headers.get('content-type') || '').toLowerCase();
  if (r.ok && ct.startsWith('image/')) {
    const buf = Buffer.from(await r.arrayBuffer());
    const mime = sniff(buf) || (ct.includes('jpeg') ? 'image/jpeg' : ct.includes('webp') ? 'image/webp' : 'image/png');
    if (!buf.length) return { ok: false, message: 'Cloudflare answered with an empty picture.' };
    return { ok: true, buf, mime, model: m };
  }
  const text = await r.text().catch(() => '');
  let j = {}; try { j = JSON.parse(text); } catch {}
  if (r.ok && j.success !== false) {
    const b64 = (j.result && (j.result.image || (typeof j.result === 'string' ? j.result : ''))) || j.image || '';
    const clean = String(b64).replace(/^data:image\/[a-z]+;base64,/i, '');
    const buf = clean ? Buffer.from(clean, 'base64') : Buffer.alloc(0);
    const mime = sniff(buf);
    if (buf.length && mime) return { ok: true, buf, mime, model: m };
    if (!ct.includes('json') && text.length) { const raw = Buffer.from(text, 'latin1'); if (sniff(raw)) return { ok: true, buf: raw, mime: sniff(raw), model: m }; }
    return { ok: false, message: 'Cloudflare answered without a picture.' };
  }
  const e = cfErrors(text, token);
  const limit = isCfLimit(r.status, e.codes, e.msg);
  const keyProblem = !limit && (r.status === 401 || r.status === 403 || e.codes.includes(10000) || e.codes.includes(1000));
  let message;
  if (limit && (e.codes.includes(3036) || /daily free allocation|neurons/i.test(e.msg))) message = 'Cloudflare\'s free pictures for today are used up (they come back at ' + cfResetText() + '). Cloudflare said: ' + e.msg;
  else if (limit) message = 'Cloudflare is busy or limited right now (' + r.status + '): ' + e.msg;
  else if (keyProblem) message = 'Cloudflare refused this key (' + r.status + (e.msg ? ': ' + e.msg : '') + '). Check the token has the "Workers AI" permission and the Account ID is right (Settings → Brain → AI keys → Test).';
  else if (e.codes.includes(5007)) message = 'Cloudflare doesn\'t have the picture model ' + m + ' (' + e.msg + '). Pick another one with Test.';
  else message = 'Cloudflare picture failed (' + r.status + (e.msg ? ': ' + e.msg : '') + ').';
  log('picture (cloudflare):', r.status, e.codes.join(',') || '-');
  return { ok: false, status: r.status, limit, keyProblem, message };
}
