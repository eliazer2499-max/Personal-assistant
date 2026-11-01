// 2.3.11: pictures through the owner's own Cloudflare account (Workers AI, free daily allowance).
// A "Cloudflare (pictures)" key = Account ID (not secret, kept in the key's base_url column) + an API token
// (secret, kept encrypted like every other AI key). Only used for Pictures; never for chat.
// Docs checked Nov 1 2026: POST /accounts/{id}/ai/run/{model}; flux-1-schnell answers JSON {result:{image:<base64>}},
// stable-diffusion / dreamshaper / phoenix answer raw image bytes, flux-2 models take multipart form data.
// Free allowance: 10,000 Neurons a day, reset 00:00 UTC; error 3036 (HTTP 429) when it is used up.
import { cfg } from './config.js';
import { redact, rememberSecret, log, setting, db, get, run } from './db.js';

export const CF_DEFAULT_MODEL = '@cf/black-forest-labs/flux-1-schnell';
export const CF_PERMISSION = 'Workers AI (Workers AI Read + Workers AI Edit)';
export const cfBase = () => String(cfg.cloudflareBase || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
const T = () => (cfg.testMode ? 8000 : 30000);

// ---------------- 2.3.12: Auto — the main AI asks for "best" / "fast" / "auto", the code picks the model ----------------
export const CF_AUTO = 'auto';
export const CF_AUTO_LABEL = 'Auto (best model, switches by itself)';
export const CF_FREE_NEURONS = 10000;          // free Neurons a day per account, reset 00:00 UTC
export const CF_LOW = 0.15;                    // "close to used up" = under 15% left
/**
 * The ranking table (the ONE place). Order inside a tier = better first. neurons = one 1024×1024 picture as this app
 * asks for it, worked out from Cloudflare's price list (developers.cloudflare.com/workers-ai/platform/pricing, read
 * Nov 1 2026; a 1024×1024 picture = 4 tiles of 512×512):
 *   flux-2-dev     37.50 per output tile per step × 4 × 25 steps (we send steps=25, the docs' example) = 3750
 *   lucid-origin   636 per tile × 4 + 12 per step × ~25 steps (steps not documented; we send 1024×1024) ≈ 2844
 *   phoenix-1.0    530 per tile × 4 + 10 per step × 25 (default steps)                                  = 2370
 *   flux-2-klein-9b 1363.64 for the first megapixel                                                      ≈ 1364
 *   flux-2-klein-4b 26.05 per output tile × 4 (fixed 4 steps)                                            ≈ 104
 *   flux-1-schnell 4.80 per tile × 4 + 9.60 per step × 4 (default steps)                                 ≈ 58
 *   stable-diffusion / dreamshaper (beta, listed "$0.00 per step"): counted like flux-1-schnell to be safe.
 * Models not in this table go last and are counted at 500.
 */
export const CF_RANK = [
  { model: '@cf/black-forest-labs/flux-2-dev', tier: 'best', neurons: 3750 },
  { model: '@cf/black-forest-labs/flux-2-klein-9b', tier: 'best', neurons: 1364 },
  { model: '@cf/leonardo/lucid-origin', tier: 'best', neurons: 2844 },
  { model: '@cf/leonardo/phoenix-1.0', tier: 'best', neurons: 2370 },
  { model: '@cf/black-forest-labs/flux-2-klein-4b', tier: 'mid', neurons: 104 },
  { model: '@cf/black-forest-labs/flux-1-schnell', tier: 'fast', neurons: 58 },
  { model: '@cf/bytedance/stable-diffusion-xl-lightning', tier: 'basic', neurons: 58 },
  { model: '@cf/lykon/dreamshaper-8-lcm', tier: 'basic', neurons: 58 },
  { model: '@cf/stabilityai/stable-diffusion-xl-base-1.0', tier: 'basic', neurons: 58 },
];
const UNKNOWN_NEURONS = 500;
const TIER_ORDER = { best: ['best', 'mid', 'fast', 'basic'], fast: ['fast', 'mid', 'basic', 'best'], auto: ['mid', 'fast', 'best', 'basic'] };
const NEEDS_PHOTO = /inpainting|img2img/i;      // these need a photo to start from; Auto never picks them
export const cfCost = (m) => (CF_RANK.find(x => x.model === m) || {}).neurons || UNKNOWN_NEURONS;
export const shortModel = (m) => String(m || '').split('/').pop();
/**
 * The order to try models in for one request. available = the account's picture models (empty = not known: the table's).
 * → { order: [model], why: 'best model' | 'fast model' | 'everyday model' | 'saving free allowance', left }
 */
export function cfPlan({ quality = 'auto', available = [], usedToday = 0 } = {}) {
  const q = ['best', 'fast', 'auto'].includes(quality) ? quality : 'auto';
  const have = (available && available.length ? available : CF_RANK.map(x => x.model)).filter(m => !NEEDS_PHOTO.test(m));
  const known = CF_RANK.map((x, i) => ({ ...x, i })).filter(x => have.includes(x.model));
  const tiers = TIER_ORDER[q];
  let order = known.sort((a, b) => (tiers.indexOf(a.tier) - tiers.indexOf(b.tier)) || (q === 'fast' && a.tier === 'best' ? a.neurons - b.neurons : 0) || a.i - b.i).map(x => x.model);
  if (q === 'fast') { const i = order.indexOf('@cf/black-forest-labs/flux-1-schnell'); if (i > 0) order.unshift(...order.splice(i, 1)); }
  order.push(...have.filter(m => !order.includes(m)).sort());      // unknown models last
  const left = Math.max(0, CF_FREE_NEURONS - (Number(usedToday) || 0));
  let why = q === 'best' ? 'best model' : q === 'fast' ? 'fast model' : 'everyday model';
  if (left < CF_FREE_NEURONS * CF_LOW) {           // close to used up → cheapest first (better first when the cost is the same)
    const rank = (m) => order.indexOf(m);
    const cheap = [...order].sort((a, b) => (cfCost(a) - cfCost(b)) || (tierScore(a) - tierScore(b)) || rank(a) - rank(b));
    if (cheap[0] !== order[0]) why = 'saving free allowance';
    order = cheap;
  } else {                                        // a model that costs more than what is left goes last (it would hit the limit)
    const fits = order.filter(m => cfCost(m) <= left), over = order.filter(m => cfCost(m) > left);
    if (fits.length && over.length && over.includes(order[0])) why = 'saving free allowance';
    order = [...fits, ...over];
  }
  return { order, why, left };
}
const tierScore = (m) => { const t = (CF_RANK.find(x => x.model === m) || {}).tier; return t === 'fast' ? 0 : t === 'mid' ? 1 : t === 'best' ? 2 : t === 'basic' ? 3 : 4; };

// --- per key: today's Neurons (an estimate) and the cached model list. Never holds the token. ---
function usageTable() { db.exec('CREATE TABLE IF NOT EXISTS cf_usage (key_id INTEGER PRIMARY KEY, day TEXT, neurons REAL DEFAULT 0, models TEXT, models_at INTEGER, models_tried_at INTEGER)'); }
export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
function usageRow(keyId) { usageTable(); return get('SELECT * FROM cf_usage WHERE key_id=?', Number(keyId)) || null; }
/** Neurons used today by this key (estimate). A new UTC day starts at 0. */
export function cfUsedToday(keyId, t = Date.now()) { if (!keyId) return 0; const r = usageRow(keyId); return r && r.day === utcDay(t) ? Number(r.neurons) || 0 : 0; }
function ensureUsage(keyId) { usageTable(); run('INSERT OR IGNORE INTO cf_usage(key_id, day, neurons) VALUES(?,?,0)', Number(keyId), utcDay()); }
export function cfAddUsage(keyId, neurons, t = Date.now()) {
  if (!keyId) return 0;
  ensureUsage(keyId);
  const used = cfUsedToday(keyId, t) + Math.max(0, Number(neurons) || 0);
  run('UPDATE cf_usage SET day=?, neurons=? WHERE key_id=?', utcDay(t), Math.min(used, CF_FREE_NEURONS), Number(keyId));
  return used;
}
/** Cloudflare said today's free amount is used up: the estimate follows. */
export function cfMarkUsedUp(keyId, t = Date.now()) { if (!keyId) return; ensureUsage(keyId); run('UPDATE cf_usage SET day=?, neurons=? WHERE key_id=?', utcDay(t), CF_FREE_NEURONS, Number(keyId)); }
export function cfSaveModels(keyId, models) {
  if (!keyId || !Array.isArray(models) || !models.length) return;
  ensureUsage(keyId); run('UPDATE cf_usage SET models=?, models_at=?, models_tried_at=? WHERE key_id=?', JSON.stringify(models.slice(0, 100)), Date.now(), Date.now(), Number(keyId));
}
export function cfForgetKey(keyId) { usageTable(); run('DELETE FROM cf_usage WHERE key_id=?', Number(keyId)); }
const DAY = 24 * 3600 * 1000;
/** The account's picture models: the cached list (from Test), refreshed from Cloudflare at most once a day. */
export async function cfModelsFor({ keyId, accountId, token }) {
  const r = keyId ? usageRow(keyId) : null;
  let cached = []; try { cached = JSON.parse(r?.models || '[]'); } catch {}
  const fresh = r && r.models_at && Date.now() - r.models_at < DAY;
  const triedRecently = r && r.models_tried_at && Date.now() - r.models_tried_at < DAY;
  if (fresh || (keyId && triedRecently)) return cached;
  const got = await cfListModels({ accountId, token }).catch(() => null);
  if (keyId) { ensureUsage(keyId); if (got && got.length) cfSaveModels(keyId, got); else run('UPDATE cf_usage SET models_tried_at=? WHERE key_id=?', Date.now(), Number(keyId)); }
  return got && got.length ? got : cached;
}
/** The account's text-to-image models (GET …/ai/models/search). null when Cloudflare could not be asked. */
export async function cfListModels({ accountId, token }) {
  token = String(token || '').trim(); rememberSecret(token);
  const acct = cleanAccountId(accountId); if (!acct || !token) return null;
  const s = await call(`${cfBase()}/accounts/${acct}/ai/models/search?task=${encodeURIComponent('Text-to-Image')}&per_page=100`, { method: 'GET' }, token);
  const sb = await readJson(s);
  if (!s.ok || sb.j.success === false) return null;
  return pictureModels(sb.j);
}
function pictureModels(j) {
  const rows = Array.isArray(j.result) ? j.result : [];
  return rows.filter(x => !x.task || /text-to-image/i.test(String(x.task?.name || x.task))).map(x => String(x.name || '')).filter(n => n.startsWith('@')).sort();
}
/** For Settings: "Free pictures today: ~N left (estimate)". */
export function cfFreeToday(keyId, model, available = []) {
  const used = cfUsedToday(keyId); const left = Math.max(0, CF_FREE_NEURONS - used);
  const auto = model === CF_AUTO;
  const per = auto ? cfCost(cfPlan({ quality: 'fast', available, usedToday: 0 }).order[0] || CF_DEFAULT_MODEL) : cfCost(model || CF_DEFAULT_MODEL);
  const pictures = Math.floor(left / per);
  const bestM = auto ? cfPlan({ quality: 'best', available, usedToday: 0 }).order[0] : null;
  const best = bestM ? Math.floor(left / cfCost(bestM)) : null;
  return { used_neurons: Math.round(used), left_neurons: Math.round(left), pictures_left: pictures, best_left: best,
    text: `Free pictures today: ~${pictures} left (estimate)` + (auto && best > 0 && best !== pictures ? ` · ~${best} in best quality` : '') };
}
/** Auto keys: the cached model list, without asking Cloudflare (for Settings). */
export function cfCachedModels(keyId) { const r = keyId ? usageRow(keyId) : null; try { return JSON.parse(r?.models || '[]'); } catch { return []; } }

/** Account IDs are 32 hex characters. Returns the cleaned id or '' when it can't be one. */
export function cleanAccountId(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(s) ? s : '';
}
export const ACCOUNT_ID_HELP = 'That Account ID doesn\'t look right. It is 32 letters and numbers, on the right side of your Cloudflare account home page (dash.cloudflare.com).';
/** Workers AI text-to-image model names look like @cf/black-forest-labs/flux-1-schnell. */
export function cleanCfModel(v) {
  const s = String(v ?? '').trim() || CF_DEFAULT_MODEL;
  if (s.toLowerCase() === CF_AUTO) return CF_AUTO;      // 2.3.12: "Auto (best model, switches by itself)"
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
    const models = pictureModels(sb.j);
    if (m === CF_AUTO) {      // 2.3.12: Auto — no single model to check; say what it will use
      const best = cfPlan({ quality: 'best', available: models }).order[0], fast = cfPlan({ quality: 'fast', available: models }).order[0];
      if (!best) return out(false, 'Token and Account ID work, but this account has no picture models Auto can use. Tap one below.', { models, problem: 'model' });
      return out(true, `Works: token OK, Workers AI allowed. Pictures: Auto — your assistant picks from ${models.length || 'the'} picture models (best: ${shortModel(best)}, fast: ${shortModel(fast)}) and switches by itself. (Test makes no picture, so none of today's free amount was used.)`, { models, model: m, model_listed: true });
    }
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
  // 2.3.12: lucid-origin is asked for 1024×1024 (not its 1120 default) and flux-2-dev for 25 steps, so the Neuron estimate holds
  const extra = /\/lucid-origin$/.test(m) ? { width: 1024, height: 1024 } : {};
  const viaJson = () => call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: p, ...extra }), timeout: cfg.testMode ? 8000 : 120000 }, token);
  const viaForm = () => { const f = new FormData(); f.append('prompt', p); f.append('width', '1024'); f.append('height', '1024'); if (/\/flux-2-dev$/.test(m)) f.append('steps', '25'); return call(url, { method: 'POST', body: f, timeout: cfg.testMode ? 8000 : 120000 }, token); };
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
  // 2.3.12: usedUp = today's free amount is gone (the whole key); 3040 = this one model is out of capacity (try another model)
  const usedUp = limit && (e.codes.includes(3036) || /daily free allocation|neurons/i.test(e.msg));
  const keyLevel = keyProblem || (limit && !e.codes.includes(3040));
  return { ok: false, status: r.status, limit, keyProblem, usedUp, keyLevel, codes: e.codes, message };
}
