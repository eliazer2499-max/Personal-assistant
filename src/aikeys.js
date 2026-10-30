// 2.3: AI keys. Several named keys (Gemini or any OpenAI-compatible API), each Active or not, in
// priority order. The brain tries them in order and moves to the next one when a key hits its free
// limit, is refused, or its provider is down. Key values live encrypted in the secrets table
// (name "ai_key_<id>"), exactly like every other secret; this table only holds names and status.
import { cfg } from './config.js';
import { db, all, get, run, now, setting, setSetting, secret, setSecret, hasSecret, audit, log, redact, DEFAULTS } from './db.js';

export const GROQ_BASE = 'https://api.groq.com/openai/v1';
export const GROQ_MODEL = 'openai/gpt-oss-120b';
const SEC = (id) => 'ai_key_' + id;

// 2.3.1: "Use for" — which jobs each key is picked for. The brain picks the first active, not-resting key
// tagged for the job, in his order; when none is free it falls back to any active key.
export const USES = ['chat', 'coding', 'pictures', 'media', 'background'];
export const USE_LABELS = { chat: 'Chat', coding: 'Coding', pictures: 'Pictures', media: 'Voice, photos & files', background: 'Background jobs' };
export function defaultUses(kind) { return kind === 'gemini' ? ['chat', 'pictures', 'media', 'background'] : ['chat', 'coding']; }
export function usesOf(r) {
  if (!r) return [];
  if (r.use_for == null) return defaultUses(r.kind);
  return String(r.use_for).split(',').filter(u => USES.includes(u));
}
function cleanUses(v, kind) {
  if (v === undefined || v === null) return defaultUses(kind);
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const bad = arr.map(String).filter(u => u && !USES.includes(u));
  if (bad.length) throw httpErr(400, 'Unknown "Use for" choice: ' + bad.join(', '));
  return USES.filter(u => arr.includes(u));       // stored in a fixed order
}

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, kind TEXT, base_url TEXT, model TEXT,
    active INTEGER DEFAULT 1, position INTEGER, created INTEGER, last_used INTEGER, last_ok INTEGER, last_error TEXT, last_error_at INTEGER,
    cool_until INTEGER DEFAULT 0, problem TEXT, use_for TEXT)`);
  // 2.3.0 → 2.3.1: add "Use for"; keys that had none get the defaults for their type.
  if (!all('PRAGMA table_info(ai_keys)').some(c => c.name === 'use_for')) {
    db.exec('ALTER TABLE ai_keys ADD COLUMN use_for TEXT');
    for (const r of all('SELECT id, kind FROM ai_keys')) run('UPDATE ai_keys SET use_for=? WHERE id=?', defaultUses(r.kind).join(','), r.id);
    if (all('SELECT id FROM ai_keys').length) audit('system', 'brain.keys', '2.3.1: gave each AI key its default "Use for" (Gemini: chat, voice/photos/files, pictures, background; OpenAI-compatible: chat, coding)');
  }
}

/** Carry the 2.2 settings over (runs on start and before every use; each part runs once). */
export function ensureKeys() {
  ensureTable();
  const flag = (k) => setting(k) === '1';
  if (!flag('ai_keys_migrated_gemini') && hasSecret('gemini_api_key')) {
    const id = insertKey({ name: 'Gemini (main)', kind: 'gemini', base_url: '', model: '', active: 1 }, secret('gemini_api_key'));   // blank model = the default Gemini model setting
    setSetting('ai_key_main_id', String(id));
    setSetting('ai_keys_migrated_gemini', '1');
    audit('system', 'brain.keys', 'Moved your Gemini key into AI keys as "Gemini (main)"');
  }
  const oBase = setting('openai_base_url'), oModel = setting('openai_model');
  const hasOpenai = hasSecret('openai_api_key') || !!oModel || (oBase && oBase !== DEFAULTS.openai_base_url);
  if (!flag('ai_keys_migrated_openai') && hasOpenai) {
    const wasOn = setting('provider') === 'openai';
    const id = insertKey({ name: 'Second provider', kind: 'openai', base_url: oBase || DEFAULTS.openai_base_url, model: oModel, active: wasOn ? 1 : 0 }, secret('openai_api_key'));
    if (wasOn) moveToTop(id);    // he had switched to it, so it stays first; Gemini becomes its backup
    setSetting('ai_keys_migrated_openai', '1');
    audit('system', 'brain.keys', `Moved your second provider into AI keys as "Second provider" (${wasOn ? 'active' : 'inactive'})`);
  }
}

function insertKey(k, value) {
  const pos = (get('SELECT MAX(position) AS p FROM ai_keys').p ?? 0) + 1;
  const r = run('INSERT INTO ai_keys(name,kind,base_url,model,active,position,created,cool_until,use_for) VALUES(?,?,?,?,?,?,?,0,?)',
    k.name, k.kind, k.base_url || '', k.model || '', k.active ? 1 : 0, pos, now(), (k.use_for || defaultUses(k.kind)).join(','));
  const id = Number(r.lastInsertRowid);
  if (value) setSecret(SEC(id), String(value).trim());
  return id;
}
function moveToTop(id) {
  const min = get('SELECT MIN(position) AS p FROM ai_keys').p ?? 0;
  run('UPDATE ai_keys SET position=? WHERE id=?', min - 1, id);
}

// ---------- validation ----------
export function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
function cleanName(v) { const s = String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80); if (!s) throw httpErr(400, 'Give the key a name, e.g. "Gemini – project 2"'); return s; }
function cleanModel(v, kind) {
  const s = String(v ?? '').trim().replace(/^models\//, '').slice(0, 200);
  if (!s) { if (kind === 'gemini') return ''; throw httpErr(400, 'Type the model name (tap Test to see the list)'); }
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-\/:@]*$/.test(s)) throw httpErr(400, 'Model names look like gemini-3.6-flash or openai/gpt-oss-120b');
  return s;
}
function cleanBase(v) {
  const s = String(v ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(s)) throw httpErr(400, 'API base URL must start with https:// (e.g. ' + GROQ_BASE + ')');
  return s.replace(/\/chat\/completions$/, '');
}
function cleanKind(v) { if (v === 'gemini' || v === 'openai') return v; throw httpErr(400, 'Type must be Gemini or OpenAI-compatible'); }

// ---------- CRUD (no key value ever leaves these functions) ----------
export function keyRow(id) { ensureKeys(); return get('SELECT * FROM ai_keys WHERE id=?', Number(id)); }
export function keyValue(id) { return secret(SEC(id)); }
export function listRows() { ensureKeys(); return all('SELECT * FROM ai_keys ORDER BY position, id'); }

export function publicKey(r) {
  const t = now();
  return { id: r.id, name: r.name, kind: r.kind, base_url: r.kind === 'openai' ? r.base_url : '', model: r.model, active: !!r.active,
    has_key: hasSecret(SEC(r.id)), last_used: r.last_used || null, last_ok: r.last_ok || null,
    last_error: r.last_error || null, last_error_at: r.last_error_at || null, problem: r.problem || null,
    resting_until: r.cool_until > t ? r.cool_until : null, resting_until_text: r.cool_until > t ? clock(r.cool_until) : null,
    effective_model: r.model || (r.kind === 'gemini' ? setting('model') || DEFAULTS.model : ''),
    use_for: usesOf(r),
    in_use: String(r.id) === setting('ai_key_in_use') };
}
export function listKeys() { return listRows().map(publicKey); }

export function addKey(b) {
  ensureKeys();
  const kind = cleanKind(b.kind);
  const k = { name: cleanName(b.name), kind, base_url: kind === 'openai' ? cleanBase(b.base_url) : '', model: cleanModel(b.model, kind), active: b.active === undefined ? 1 : (b.active ? 1 : 0), use_for: cleanUses(b.use_for, kind) };
  const value = String(b.key ?? '').trim();
  if (kind === 'gemini' && !value) throw httpErr(400, 'Paste the key (from aistudio.google.com/apikey)');
  const id = insertKey(k, value);
  audit('owner', 'brain.key_added', `"${k.name}" (${kind === 'gemini' ? 'Gemini' : 'OpenAI-compatible'}${k.active ? ', active' : ', inactive'})`);
  return publicKey(keyRow(id));
}
export function updateKey(id, b) {
  const r = keyRow(id); if (!r) throw httpErr(404, 'That key was removed');
  const kind = b.kind !== undefined ? cleanKind(b.kind) : r.kind;
  const name = b.name !== undefined ? cleanName(b.name) : r.name;
  const base = kind === 'openai' ? (b.base_url !== undefined ? cleanBase(b.base_url) : (r.base_url || cleanBase(b.base_url))) : '';
  const model = b.model !== undefined ? cleanModel(b.model, kind) : r.model;
  const active = b.active !== undefined ? (b.active ? 1 : 0) : r.active;
  const uses = b.use_for !== undefined ? cleanUses(b.use_for, kind) : usesOf(r);
  const usesChanged = uses.join(',') !== usesOf(r).join(',');
  const changedSetup = kind !== r.kind || base !== (r.base_url || '') || model !== r.model || (b.key !== undefined && String(b.key).trim());
  run('UPDATE ai_keys SET name=?, kind=?, base_url=?, model=?, active=?, use_for=? WHERE id=?', name, kind, base, model, active, uses.join(','), r.id);
  if (b.key !== undefined && String(b.key).trim()) setSecret(SEC(r.id), String(b.key).trim());
  if (changedSetup) run('UPDATE ai_keys SET problem=NULL, cool_until=0 WHERE id=?', r.id);    // fixed it? try again right away
  const what = [b.name !== undefined && name !== r.name ? 'renamed' : '', active !== r.active ? (active ? 'switched on' : 'switched off') : '',
    b.key !== undefined && String(b.key).trim() ? 'key replaced' : '', model !== r.model ? 'model ' + model : '',
    usesChanged ? 'use for ' + (uses.map(u => USE_LABELS[u]).join(', ') || 'nothing') : ''].filter(Boolean).join(', ');
  audit('owner', 'brain.key_changed', `"${name}"${what ? ': ' + what : ''}`);
  return publicKey(keyRow(r.id));
}
export function removeKey(id) {
  const r = keyRow(id); if (!r) throw httpErr(404, 'That key was removed');
  run('DELETE FROM ai_keys WHERE id=?', r.id);
  setSecret(SEC(r.id), '');
  if (String(r.id) === setting('ai_key_main_id')) { setSecret('gemini_api_key', ''); setSetting('ai_key_main_id', ''); }
  if (String(r.id) === setting('ai_key_in_use')) setSetting('ai_key_in_use', '');
  audit('owner', 'brain.key_removed', `"${r.name}"`);
  return { ok: true };
}
export function moveKey(id, dir) {
  const rows = listRows(); const i = rows.findIndex(x => x.id === Number(id));
  if (i < 0) throw httpErr(404, 'That key was removed');
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= rows.length) return listKeys();
  [rows[i], rows[j]] = [rows[j], rows[i]];
  rows.forEach((r, n) => run('UPDATE ai_keys SET position=? WHERE id=?', n + 1, r.id));
  audit('owner', 'brain.key_moved', `"${rows[j].name}" ${dir}`);
  return listKeys();
}

/** 2.2 compatibility: the old single "Gemini key" field updates the "Gemini (main)" entry. */
export function setMainGeminiKey(value) {
  ensureKeys();
  const id = setting('ai_key_main_id');
  if (id && keyRow(id)) {
    if (value) { setSecret(SEC(id), value); run('UPDATE ai_keys SET problem=NULL, cool_until=0 WHERE id=?', Number(id)); }
    else removeKey(id);
  } else if (value) {
    const nid = insertKey({ name: 'Gemini (main)', kind: 'gemini', model: '', active: 1 }, value);
    setSetting('ai_key_main_id', String(nid)); setSetting('ai_keys_migrated_gemini', '1');
  }
}

// ---------- time helpers ----------
function tzOffset(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ts)).filter(x => x.type !== 'literal').map(x => [x.type, parseInt(x.value, 10)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}
/** Google's free daily limits reset at midnight Pacific time. */
export function nextPacificMidnight(t = now()) {
  const tz = 'America/Los_Angeles';
  const local = new Date(t + tzOffset(t, tz));
  const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 0, 0, 0);
  let guess = target - tzOffset(target, tz);
  guess = target - tzOffset(guess, tz);
  return guess;
}
export function clock(ts) {
  const tz = setting('timezone') || 'America/New_York';
  try { return new Date(ts).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); }
  catch { return new Date(ts).toISOString().slice(11, 16) + ' UTC'; }
}
const roundClock = (ts) => clock(ts).replace(':00 ', ' ');

// ---------- reading provider errors ----------
function secondsFrom(text) {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text) || /retry in (\d+(?:\.\d+)?)\s*s/i.exec(text);
  if (m) return parseFloat(m[1]);
  const g = /try again in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i.exec(text);    // Groq: "try again in 7m12.5s"
  if (g && (g[1] || g[2] || g[3])) return (parseInt(g[1] || 0, 10) * 3600) + (parseInt(g[2] || 0, 10) * 60) + parseFloat(g[3] || 0);
  return 0;
}
function providerMessage(text) {
  try { const j = JSON.parse(text); const e = Array.isArray(j) ? j[0]?.error : j.error; return String((e && (e.message || e.status)) || j.message || '').trim(); } catch { return String(text || '').trim(); }
}
const short = (s, n = 140) => { s = redact(String(s || '')).replace(/\s+/g, ' ').replace(/https?:\/\/\S+/g, '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/**
 * Turn a failed answer into a decision: what to tell the owner (short, human), whether the key
 * should rest and until when, and whether it is a set-up problem on that key.
 * kind: quota | bad_key | model | server | network | other
 */
export function classify({ status = 0, text = '', headers = null, provider = 'gemini', networkError = '' }) {
  const t = now();
  const who = provider === 'gemini' ? 'Google' : 'Provider';
  if (networkError) return { kind: 'network', reason: `could not be reached (${short(networkError, 60)})`, until: t + 60000 };
  const msg = providerMessage(text);
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(text) || (status >= 400 && /quota/i.test(msg) && status !== 404)) {
    const perDay = /PerDay|per[ _-]?day|daily|\bRPD\b|\bTPD\b|limit:\s*0\b/i.test(text);
    if (provider === 'gemini' && perDay) {
      const until = nextPacificMidnight(t);
      return { kind: 'quota', reason: `Google free daily limit reached (429) — resets ~${roundClock(until)}`, until, perDay: true };
    }
    const ra = parseFloat(headers?.get?.('retry-after') || '0') || 0;
    const secs = ra || secondsFrom(text) || (perDay ? 3600 : 60);
    const until = t + Math.min(Math.max(secs, 1), 24 * 3600) * 1000;
    return { kind: 'quota', reason: `${provider === 'gemini' ? 'Google free limit' : 'rate limit'} reached (429)${perDay ? ' for today' : ''} — ${secs > 90 ? 'until ~' + clock(until) : 'busy for ~' + Math.ceil(secs) + ' s'}`, until, perDay };
  }
  if (status === 413) return { kind: 'other', reason: 'request too large for this key\'s limit (413)' + (msg ? ': ' + short(msg, 90) : ''), until: 0 };
  if (status === 401 || /API_KEY_INVALID|API key not valid|invalid[_ ]api[_ ]key|Incorrect API key|unregistered callers/i.test(text))
    return { kind: 'bad_key', reason: `bad key (${status || 401}) — paste a new one`, until: t + 30 * 60000, problem: 'bad key' };
  if (status === 403) return { kind: 'bad_key', reason: `key not allowed (403)${msg ? ': ' + short(msg, 90) : ''}`, until: t + 30 * 60000, problem: 'key not allowed' };
  if (status === 404 || /model_not_found|does not exist|is not found for API version|not supported for generateContent/i.test(text))
    return { kind: 'model', reason: 'model not found — tap Test and pick one from the list', until: 0, problem: 'model not found' };
  if (status >= 500) return { kind: 'server', reason: `${who === 'Google' ? 'Google is' : 'provider is'} having trouble (${status})`, until: t + 60000 };
  if (status === 408) return { kind: 'server', reason: 'timed out (408)', until: t + 60000 };
  return { kind: 'other', reason: `error ${status}${msg ? ': ' + short(msg) : ''}`, until: 0 };
}

// ---------- status ----------
export function markOk(id) {
  run('UPDATE ai_keys SET last_used=?, last_ok=?, problem=NULL, cool_until=0 WHERE id=?', now(), now(), id);
  setSetting('ai_key_in_use', String(id));
}
export function markTested(id) {
  run('UPDATE ai_keys SET last_ok=?, problem=NULL, cool_until=0, last_error=NULL, last_error_at=NULL WHERE id=?', now(), id);
}
export function markFail(id, c, { fromTest = false } = {}) {
  run('UPDATE ai_keys SET last_error=?, last_error_at=?, cool_until=?, problem=? WHERE id=?', redact(c.reason).slice(0, 300), now(), c.until || 0, c.problem || null, id);
  if (!fromTest) run('UPDATE ai_keys SET last_used=? WHERE id=?', now(), id);
}
/**
 * Keys the brain may use, in order. use = the kind of job (chat | coding | media | background): keys tagged
 * for it come first (in his order), then every other active key as a fallback. withMedia = the request
 * carries a voice note, photo or PDF: Gemini keys first in both groups (they can hear and see).
 */
export function usableKeys({ withMedia = false, use = null } = {}) {
  const rows = listRows().filter(r => r.active && (r.kind === 'openai' || hasSecret(SEC(r.id))));
  const groups = use ? [rows.filter(r => usesOf(r).includes(use)), rows.filter(r => !usesOf(r).includes(use))] : [rows];
  const out = [];
  if (withMedia) { for (const g of groups) out.push(...g.filter(r => r.kind === 'gemini')); for (const g of groups) out.push(...g.filter(r => r.kind !== 'gemini')); }
  else for (const g of groups) out.push(...g);
  return out.map(r => ({ ...r, tagged: !use || usesOf(r).includes(use) }));
}
/** Gemini keys for picture creation: tagged "Pictures" first, then the other Gemini keys; free ones before resting ones. */
export function geminiKeys() {
  const t = now();
  const rows = usableKeys({ use: 'pictures' }).filter(r => r.kind === 'gemini');
  const free = (r) => !(r.cool_until > t) && !r.problem;
  return [...rows.filter(r => free(r)), ...rows.filter(r => !free(r))].map(r => ({ id: r.id, name: r.name, key: keyValue(r.id), tagged: r.tagged }));
}
export function inUse() {
  const r = setting('ai_key_in_use') && get('SELECT * FROM ai_keys WHERE id=?', Number(setting('ai_key_in_use')));
  return r ? { name: r.name, kind: r.kind === 'gemini' ? 'Gemini' : 'OpenAI-compatible', model: r.model || (r.kind === 'gemini' ? setting('model') : '') } : null;
}
export function statusSummary() {
  return listKeys().map(k => ({ name: k.name, type: k.kind === 'gemini' ? 'Gemini' : 'OpenAI-compatible', model: k.effective_model, active: k.active, in_use: k.in_use,
    use_for: k.use_for.map(u => USE_LABELS[u]),
    status: !k.active ? 'inactive' : k.resting_until ? 'resting until ' + k.resting_until_text : k.problem ? k.problem : k.last_ok ? 'working' : 'not used yet',
    last_error: k.last_error || undefined }));
}
