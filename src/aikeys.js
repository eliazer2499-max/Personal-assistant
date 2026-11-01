// 2.3: AI keys. Several named keys (Gemini or any OpenAI-compatible API), each Active or not, in
// priority order. The brain tries them in order and moves to the next one when a key hits its free
// limit, is refused, or its provider is down. Key values live encrypted in the secrets table
// (name "ai_key_<id>"), exactly like every other secret; this table only holds names and status.
import { cfg } from './config.js';
import { db, all, get, run, now, setting, setSetting, secret, setSecret, hasSecret, audit, log, redact, DEFAULTS } from './db.js';
import { cleanAccountId, cleanCfModel, CF_DEFAULT_MODEL, ACCOUNT_ID_HELP, CF_AUTO, CF_AUTO_LABEL, cfFreeToday, cfCachedModels, cfForgetKey } from './cloudflare.js';
import { CF_CHAT_DEFAULT, CF_CHAT_HELP, CF_CHAT_USES, cleanCfChatModel } from './cfchat.js';

export const GROQ_BASE = 'https://api.groq.com/openai/v1';
export const GROQ_MODEL = 'openai/gpt-oss-120b';
const SEC = (id) => 'ai_key_' + id;

// 2.3.1: "Use for" — which jobs each key is picked for. The brain picks the first active, not-resting key
// tagged for the job, in his order; when none is free it falls back to any active key.
export const USES = ['chat', 'coding', 'pictures', 'media', 'background'];
export const USE_LABELS = { chat: 'Chat', coding: 'Coding', pictures: 'Pictures', media: 'Voice, photos & files', background: 'Background jobs' };
export function defaultUses(kind) { return kind === 'gemini' ? ['chat', 'pictures', 'media', 'background'] : kind === 'cloudflare' ? ['pictures'] : ['chat', 'coding']; }
// 2.3.11: "Cloudflare (pictures)" keys (Workers AI on his own account) only make pictures.
export const KIND_LABELS = { gemini: 'Gemini', openai: 'OpenAI-compatible', cloudflare: 'Cloudflare (pictures)' };
export const kindLabel = (k) => KIND_LABELS[k] || 'OpenAI-compatible';
export const CF_ONLY = 'Cloudflare keys only make pictures';
// 2.3.13: a Cloudflare key can also chat (Chat, Background jobs) when he ticks it; it never does coding or voice/photos/files on purpose.
export const CF_NOT = 'Cloudflare keys do pictures, chat and background jobs';
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
  if (kind === 'cloudflare') return USES.filter(u => (u === 'pictures' || CF_CHAT_USES.includes(u)) && arr.includes(u));    // 2.3.13: pictures, chat, background
  return USES.filter(u => arr.includes(u));       // stored in a fixed order
}

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, kind TEXT, base_url TEXT, model TEXT,
    active INTEGER DEFAULT 1, position INTEGER, created INTEGER, last_used INTEGER, last_ok INTEGER, last_error TEXT, last_error_at INTEGER,
    cool_until INTEGER DEFAULT 0, problem TEXT, use_for TEXT, caps TEXT)`);
  // 2.3.0 → 2.3.1: add "Use for"; keys that had none get the defaults for their type.
  if (!all('PRAGMA table_info(ai_keys)').some(c => c.name === 'use_for')) {
    db.exec('ALTER TABLE ai_keys ADD COLUMN use_for TEXT');
    for (const r of all('SELECT id, kind FROM ai_keys')) run('UPDATE ai_keys SET use_for=? WHERE id=?', defaultUses(r.kind).join(','), r.id);
    if (all('SELECT id FROM ai_keys').length) audit('system', 'brain.keys', '2.3.1: gave each AI key its default "Use for" (Gemini: chat, voice/photos/files, pictures, background; OpenAI-compatible: chat, coding)');
  }
  // 2.3.1 → 2.3.2: what each model can do (filled in by Test). Existing keys start untested and keep their ticks.
  if (!all('PRAGMA table_info(ai_keys)').some(c => c.name === 'caps')) db.exec('ALTER TABLE ai_keys ADD COLUMN caps TEXT');
  // 2.3.12 → 2.3.13: a Cloudflare key's chat model (its picture model stays in "model"). Empty = the default chat model.
  if (!all('PRAGMA table_info(ai_keys)').some(c => c.name === 'chat_model')) db.exec('ALTER TABLE ai_keys ADD COLUMN chat_model TEXT');
}

// ---------------- 2.3.2: what the model can do ("caps"), found by Test ----------------
// caps = { v, kind, model, base_url, text, images, audio, pdf, files_text, pictures, tools, checked_at, unchecked: {cap: why}, stale }
// Each capability is true (works), false (refused) or null (could not be checked, e.g. a limit). No secrets in here.
export const CAPS = ['text', 'images', 'audio', 'pdf', 'pictures', 'tools'];
export const CAP_LABELS = { text: 'Chat', images: 'Photos', audio: 'Voice', pdf: 'PDF', pictures: 'Pictures', tools: 'Tools' };
const MEDIA_CAP = { image: 'images', audio: 'audio', pdf: 'pdf' };
export function capsOf(r) { if (!r || !r.caps) return null; try { const c = JSON.parse(r.caps); return c && typeof c === 'object' ? c : null; } catch { return null; } }
/** 2.3.13: a Cloudflare key's chat model (empty = the default). */
export function cfChatModelOf(r) { return (r && r.chat_model) || CF_CHAT_DEFAULT; }
function effModel(r) { return r.model || (r.kind === 'gemini' ? setting('model') || DEFAULTS.model : r.kind === 'cloudflare' ? CF_DEFAULT_MODEL : ''); }
/** The caps only count while they were found for this key's current type, address and model, and the key was not replaced since. */
export function freshCaps(r) {
  const c = capsOf(r);
  if (!c || c.stale || c.kind !== r.kind || c.model !== effModel(r) || ((r.kind === 'openai' || r.kind === 'cloudflare') && (c.base_url || '') !== (r.base_url || ''))) return null;
  return c;
}
const and = (...v) => v.includes(false) ? false : v.includes(null) || v.includes(undefined) ? null : true;
export const PIC_CANT = 'This model can\'t make pictures';
const PIC_TEST = 'Tap Test to check if this model can make pictures';
/** For each "Use for": ok true/false/null (null = not known yet → behave like 2.3.1) and a one-line reason. */
export function useSupport(r) {
  const c = freshCaps(r);
  const out = {};
  if (r.kind === 'cloudflare') {      // 2.3.11: pictures; 2.3.13: also Chat and Background jobs (he ticks them); coding and media greyed out
    for (const u of USES) out[u] = { ok: false, why: CF_NOT };
    out.pictures = !c ? { ok: null, why: '' } : c.pictures === false ? { ok: false, why: String(c.why?.pictures || 'The last Test failed — fix it and tap Test') } : { ok: true, why: '' };
    const sameChat = c && c.chat_model === cfChatModelOf(r);           // chat was checked for THIS chat model
    const chat = sameChat && (c.text === true || c.text === false) ? c.text : null;
    out.chat = { ok: chat, why: chat === false ? String(c.why?.text || 'The chat model did not answer — pick another and tap Test') : '' };
    const tools = sameChat && c.tools === false ? false : null;
    out.background = chat === false ? { ...out.chat } : tools === false ? { ok: false, why: 'This chat model can\'t use tools, so it can\'t do this' } : { ok: chat, why: '' };
    return out;
  }
  if (!c) {
    for (const u of USES) out[u] = { ok: null, why: '' };
    if (r.kind !== 'gemini') out.pictures = { ok: false, why: PIC_TEST };
    return out;
  }
  const v = (k) => c[k] === true ? true : c[k] === false ? false : null;
  const ok = (x) => x === true ? '✓' : x === false ? '✗' : '?';
  out.chat = { ok: v('text'), why: v('text') === false ? 'This model did not answer a simple chat message' : '' };
  const tw = v('tools') === false ? 'This model can\'t use tools, so it can\'t do this' : '';
  out.coding = { ok: and(v('text'), v('tools')), why: tw };
  out.background = { ok: and(v('text'), v('tools')), why: tw };
  if (r.kind === 'gemini') out.pictures = { ok: v('pictures'), why: v('pictures') === false ? 'This key can\'t reach the picture model' : '' };
  // 2.3.10: any model that can make pictures. Caps from before 2.3.10 (v1) never checked this → ask for a new Test.
  else if (!(c.v >= 2)) out.pictures = { ok: false, why: PIC_TEST };
  else out.pictures = v('pictures') === true ? { ok: true, why: c.pictures_guess ? 'Probably can — will try' : '' }
    : v('pictures') === false ? { ok: false, why: PIC_CANT } : { ok: null, why: '' };
  const m = [v('images'), v('audio'), v('pdf')];
  const mOk = m.includes(true) ? true : m.every(x => x === false) ? false : null;
  const detail = `photos ${ok(m[0])} voice ${ok(m[1])} PDF ${ok(m[2])}${c.files_text ? ' · Word/Excel/zip as text ✓' : ''}`;
  out.media = { ok: mOk, why: mOk === false ? 'This model can\'t see photos, hear voice notes or read PDFs' : m.every(x => x === true) ? '' : detail };
  return out;
}
/** Short text for the Activity log: "chat ✓ tools ✓ photos ✗ voice ✗ PDF ✗ pictures ✗". */
export function capsLine(c) {
  const ok = (x) => x === true ? '✓' : x === false ? '✗' : '?';
  return [['chat', 'text'], ['tools', 'tools'], ['photos', 'images'], ['voice', 'audio'], ['PDF', 'pdf'], ['pictures', 'pictures']].map(([l, k]) => `${l} ${ok(c[k])}`).join(' ');
}
/** Test found new caps: store them (keeping an older answer for anything that could not be checked this time). */
export function saveCaps(id, found) {
  const r = keyRow(id); if (!r) return null;
  const c = buildCaps(r, found, freshCaps(r));
  run('UPDATE ai_keys SET caps=? WHERE id=?', JSON.stringify(c), id);
  return c;
}
/** 2.3.9: the caps object for a key setup (saved or not yet saved). Nothing is stored here. */
export function buildCaps(r, found, old = null) {
  const c = { v: 2, kind: r.kind, model: effModel(r), base_url: r.kind === 'openai' || r.kind === 'cloudflare' ? (r.base_url || '') : '', checked_at: now(), unchecked: {} };
  for (const k of [...CAPS, 'files_text']) {
    const val = found[k];
    if (val === true || val === false) c[k] = val;
    else { c[k] = old && (old[k] === true || old[k] === false) ? old[k] : null; if (k !== 'files_text') c.unchecked[k] = found.why?.[k] || 'not checked'; }
  }
  if (r.kind === 'openai' && c.pictures === true && found.pictures === true) { c.pictures_via = found.pictures_via === 'chat' ? 'chat' : 'images'; if (found.pictures_guess) c.pictures_guess = true; }
  if (found.why) c.why = Object.fromEntries(Object.entries(found.why).map(([k, w]) => [k, redact(String(w)).slice(0, 160)]));
  // 2.3.13: a Cloudflare key's chat answer belongs to one chat model. Not checked this time → keep the last answer for the same model.
  if (r.kind === 'cloudflare') {
    if (found.chat_model) c.chat_model = found.chat_model;
    else if (old && old.chat_model && old.chat_model === cfChatModelOf(r)) {
      c.chat_model = old.chat_model; c.text = old.text ?? null; c.tools = old.tools ?? null;
      if (old.why?.text) c.why = { ...(c.why || {}), text: old.why.text };
    }
  }
  return c;
}
/** After a Test: tick every "Use for" the model can do, untick the ones it can't; leave the unknown ones as they were. */
export function applyTestedUses(id) {
  const r = keyRow(id); if (!r) return { added: [], removed: [] };
  const sup = useSupport(r), cur = usesOf(r);
  const next = nextUses(r, sup, cur);
  const added = next.filter(u => !cur.includes(u)), removed = cur.filter(u => !next.includes(u));
  if (added.length || removed.length) run('UPDATE ai_keys SET use_for=? WHERE id=?', next.join(','), id);
  return { added, removed };
}
/**
 * The "Use for" ticks after a Test. 2.3.10: Pictures on a non-Gemini key is never ticked by itself (those picture
 * models usually cost money): the box is only made available, and he ticks it himself.
 */
export function nextUses(r, sup, cur) {
  // 2.3.13: on a Cloudflare key Chat and Background jobs are never ticked by a Test; he ticks them (they use the free daily amount)
  if (r.kind === 'cloudflare') return USES.filter(u => u === 'pictures' ? (sup[u].ok === true || (sup[u].ok === null && cur.includes(u))) : CF_CHAT_USES.includes(u) && cur.includes(u) && sup[u].ok !== false);
  return USES.filter(u => (sup[u].ok === true && (u !== 'pictures' || r.kind === 'gemini' || r.kind === 'cloudflare' || cur.includes(u))) || (sup[u].ok === null && cur.includes(u)));
}
/** Can this key take every kind of media in the request? false only when its (current) caps say no. */
export function cannotTake(r, mediaKinds = []) {
  const c = freshCaps(r); if (!c) return [];
  return [...new Set(mediaKinds)].filter(k => MEDIA_CAP[k] && c[MEDIA_CAP[k]] === false);
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
  const r = run('INSERT INTO ai_keys(name,kind,base_url,model,active,position,created,cool_until,use_for,chat_model) VALUES(?,?,?,?,?,?,?,0,?,?)',
    k.name, k.kind, k.base_url || '', k.model || '', k.active ? 1 : 0, pos, now(), (k.use_for || defaultUses(k.kind)).join(','), k.chat_model || '');
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
  if (kind === 'cloudflare') { const m = cleanCfModel(v); if (!m) throw httpErr(400, 'Cloudflare picture models look like ' + CF_DEFAULT_MODEL + ', or choose Auto (tap Test to see the list)'); return m; }
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
/** 2.3.13: a Cloudflare key's chat model. Empty = the default chat model (stored as ''). */
function cleanChatModel(v) {
  if (v === undefined || v === null || !String(v).trim() || String(v).trim() === CF_CHAT_DEFAULT) return '';
  const m = cleanCfChatModel(v); if (!m) throw httpErr(400, 'Cloudflare chat models look like ' + CF_CHAT_DEFAULT + ' (tap Test to see the list)');
  return m;
}
function cleanKind(v) { if (v === 'gemini' || v === 'openai' || v === 'cloudflare') return v; throw httpErr(400, 'Type must be Gemini, OpenAI-compatible or Cloudflare (pictures)'); }
/** 2.3.11: a Cloudflare key keeps its Account ID (not a secret) in base_url. */
function cleanAcct(b, fallback = '') {
  const raw = b.account_id !== undefined ? b.account_id : b.base_url !== undefined ? b.base_url : fallback;
  const id = cleanAccountId(raw); if (!id) throw httpErr(400, ACCOUNT_ID_HELP); return id;
}
const baseFor = (kind, b, fallback) => kind === 'openai' ? cleanBase(b.base_url) : kind === 'cloudflare' ? cleanAcct(b, fallback) : '';

// ---------- CRUD (no key value ever leaves these functions) ----------
export function keyRow(id) { ensureKeys(); return get('SELECT * FROM ai_keys WHERE id=?', Number(id)); }
export function keyValue(id) { return secret(SEC(id)); }
export function listRows() { ensureKeys(); return all('SELECT * FROM ai_keys ORDER BY position, id'); }

export function publicKey(r) {
  const t = now();
  return { id: r.id, name: r.name, kind: r.kind, kind_label: kindLabel(r.kind), base_url: r.kind === 'openai' ? r.base_url : '', account_id: r.kind === 'cloudflare' ? r.base_url : '', model: r.model, active: !!r.active,
    has_key: hasSecret(SEC(r.id)), last_used: r.last_used || null, last_ok: r.last_ok || null,
    last_error: r.last_error || null, last_error_at: r.last_error_at || null, problem: r.problem || null,
    resting_until: r.cool_until > t ? r.cool_until : null, resting_until_text: r.cool_until > t ? clock(r.cool_until) : null,
    effective_model: effModel(r),
    use_for: usesOf(r), caps: capsOf(r), caps_fresh: !!freshCaps(r), use_support: useSupport(r),
    in_use: String(r.id) === setting('ai_key_in_use'),
    ...(r.kind === 'cloudflare' ? { auto: effModel(r) === CF_AUTO, model_label: effModel(r) === CF_AUTO ? CF_AUTO_LABEL : effModel(r), free_today: cfFreeToday(r.id, effModel(r), cfCachedModels(r.id)),
      chat_model: r.chat_model || '', effective_chat_model: cfChatModelOf(r), chat_default: CF_CHAT_DEFAULT, chat_help: CF_CHAT_HELP } : {}) };      // 2.3.12, 2.3.13
}
export function listKeys() { return listRows().map(publicKey); }

export function addKey(b) {
  ensureKeys();
  const kind = cleanKind(b.kind);
  const k = { name: cleanName(b.name), kind, base_url: baseFor(kind, b), model: cleanModel(b.model, kind), active: b.active === undefined ? 1 : (b.active ? 1 : 0), use_for: cleanUses(b.use_for, kind),
    chat_model: kind === 'cloudflare' ? cleanChatModel(b.chat_model) : '' };
  const value = String(b.key ?? '').trim();
  if (kind === 'gemini' && !value) throw httpErr(400, 'Paste the key (from aistudio.google.com/apikey)');
  if (kind === 'cloudflare' && !value) throw httpErr(400, 'Paste the API token (Cloudflare: My Profile → API Tokens → Create Token → "Workers AI" template)');
  if (kind === 'cloudflare' && (value.length > 1000 || /\s/.test(value))) throw httpErr(400, 'That doesn\'t look like a token. Paste just the token.');
  const id = insertKey(k, value);
  audit('owner', 'brain.key_added', `"${k.name}" (${kindLabel(kind)}${k.active ? ', active' : ', inactive'})`);
  return publicKey(keyRow(id));
}
/**
 * 2.3.9: "Test" in the Add-key sheet. Checks what he typed (type, address, model, key) without saving.
 * b.id = the key being edited: an empty key field means "use the key already saved for it".
 * Returns a key-like object (id null, nothing in the database) and the key value to try.
 */
export function draftKey(b) {
  ensureKeys();
  const kind = cleanKind(b.kind);
  const hasId = b.id !== undefined && b.id !== null && b.id !== '';
  const r = hasId ? keyRow(b.id) : null;
  if (hasId && !r) throw httpErr(404, 'That key was removed');
  // 2.3.11: a Cloudflare Account ID / model with a typo is reported by Test itself (plain words), not refused here
  const base_url = kind === 'openai' ? cleanBase(b.base_url)
    : kind === 'cloudflare' ? (cleanAccountId(b.account_id ?? b.base_url) || String(b.account_id ?? b.base_url ?? '').replace(/[^\w-]/g, '').slice(0, 64)) : '';
  const model = kind === 'cloudflare' ? (cleanCfModel(b.model) || String(b.model ?? '').trim().slice(0, 200))
    : String(b.model ?? '').trim() ? cleanModel(b.model, kind) : '';
  let value = String(b.key ?? '').trim(), stored = false;
  if (value.length > 1000 || /\s/.test(value)) throw httpErr(400, 'That doesn\'t look like a key. Paste just the key.');
  if (!value && r) { value = String(keyValue(r.id) || '').trim(); stored = !!value; }
  const name = String(b.name ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80) || (r ? r.name : 'New key');
  const chat_model = kind === 'cloudflare' ? (String(b.chat_model ?? '').trim() ? (cleanCfChatModel(b.chat_model) || String(b.chat_model).trim().slice(0, 200)) : (b.chat_model === undefined && r ? r.chat_model || '' : '')) : '';
  return { k: { id: null, name, kind, base_url, model, chat_model, use_for: cleanUses(b.use_for, kind).join(',') }, key: value, stored };
}
export function updateKey(id, b) {
  const r = keyRow(id); if (!r) throw httpErr(404, 'That key was removed');
  const kind = b.kind !== undefined ? cleanKind(b.kind) : r.kind;
  const name = b.name !== undefined ? cleanName(b.name) : r.name;
  const base = kind === 'openai' ? (b.base_url !== undefined ? cleanBase(b.base_url) : (r.base_url || cleanBase(b.base_url)))
    : kind === 'cloudflare' ? cleanAcct(b, r.kind === 'cloudflare' ? r.base_url : '') : '';
  const model = b.model !== undefined ? cleanModel(b.model, kind) : (kind === 'cloudflare' && r.kind !== 'cloudflare' ? CF_DEFAULT_MODEL : r.model);
  const active = b.active !== undefined ? (b.active ? 1 : 0) : r.active;
  const chatModel = kind !== 'cloudflare' ? '' : b.chat_model !== undefined ? cleanChatModel(b.chat_model) : (r.chat_model || '');     // 2.3.13
  let uses = b.use_for !== undefined ? cleanUses(b.use_for, kind) : usesOf(r);
  const keyReplaced = b.key !== undefined && !!String(b.key).trim();
  // 2.3.2: a job the last Test showed this model can't do is not kept (the screen greys it out too).
  if (b.use_for !== undefined && !keyReplaced) { const sup = useSupport({ ...r, kind, base_url: base, model, chat_model: chatModel }); uses = uses.filter(u => sup[u].ok !== false); }
  const usesChanged = uses.join(',') !== usesOf(r).join(',');
  const changedSetup = kind !== r.kind || base !== (r.base_url || '') || model !== r.model || chatModel !== (r.chat_model || '') || (b.key !== undefined && String(b.key).trim());
  run('UPDATE ai_keys SET name=?, kind=?, base_url=?, model=?, active=?, use_for=?, chat_model=? WHERE id=?', name, kind, base, model, active, uses.join(','), chatModel, r.id);
  if (b.key !== undefined && String(b.key).trim()) setSecret(SEC(r.id), String(b.key).trim());
  if (changedSetup) run('UPDATE ai_keys SET problem=NULL, cool_until=0 WHERE id=?', r.id);
  if (keyReplaced) { const c = capsOf(r); if (c) run('UPDATE ai_keys SET caps=? WHERE id=?', JSON.stringify({ ...c, stale: true }), r.id); }   // new key → Test again    // fixed it? try again right away
  const what = [b.name !== undefined && name !== r.name ? 'renamed' : '', active !== r.active ? (active ? 'switched on' : 'switched off') : '',
    b.key !== undefined && String(b.key).trim() ? 'key replaced' : '', model !== r.model ? 'model ' + model : '', chatModel !== (r.chat_model || '') ? 'chat model ' + (chatModel || CF_CHAT_DEFAULT) : '',
    usesChanged ? 'use for ' + (uses.map(u => USE_LABELS[u]).join(', ') || 'nothing') : ''].filter(Boolean).join(', ');
  audit('owner', 'brain.key_changed', `"${name}"${what ? ': ' + what : ''}`);
  return publicKey(keyRow(r.id));
}
export function removeKey(id) {
  const r = keyRow(id); if (!r) throw httpErr(404, 'That key was removed');
  run('DELETE FROM ai_keys WHERE id=?', r.id);
  if (r.kind === 'cloudflare') cfForgetKey(r.id);      // 2.3.12: its picture counter and model list go too
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
export function providerMessage(text) {
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
export function usableKeys({ withMedia = false, use = null, mediaKinds = [] } = {}) {
  const rows = listRows().filter(r => r.active && (r.kind === 'openai' || hasSecret(SEC(r.id))) && (r.kind !== 'cloudflare' || use === 'pictures' || usesOf(r).some(u => CF_CHAT_USES.includes(u))));   // 2.3.11: Cloudflare keys make pictures; 2.3.13: and chat when he ticked Chat or Background jobs
  const groups = use ? [rows.filter(r => usesOf(r).includes(use)), rows.filter(r => !usesOf(r).includes(use))] : [rows];
  let out = [];
  if (withMedia) { for (const g of groups) out.push(...g.filter(r => r.kind === 'gemini')); for (const g of groups) out.push(...g.filter(r => r.kind !== 'gemini')); }
  else for (const g of groups) out.push(...g);
  // 2.3.2: a key whose Test showed it can't take this request's media (voice / photo / PDF) goes to the very end:
  // it is only used when nothing else answers, and then the media reaches it as a short note instead.
  if (mediaKinds.length) { const ok = out.filter(r => !cannotTake(r, mediaKinds).length); out = [...ok, ...out.filter(r => !ok.includes(r))]; }
  return out.map(r => ({ ...r, tagged: !use || usesOf(r).includes(use), cannot: mediaKinds.length ? cannotTake(r, mediaKinds) : [] }));
}
/** Gemini keys for picture creation: tagged "Pictures" first, then the other Gemini keys; free ones before resting ones. */
export function geminiKeys() {
  const t = now();
  const rows = usableKeys({ use: 'pictures' }).filter(r => r.kind === 'gemini');
  const free = (r) => !(r.cool_until > t) && !r.problem;
  const noPic = (r) => freshCaps(r)?.pictures === false;          // 2.3.2: Test showed this key can't reach the picture model
  return [...rows.filter(r => free(r) && !noPic(r)), ...rows.filter(r => !free(r) && !noPic(r)), ...rows.filter(r => noPic(r))].map(r => ({ id: r.id, name: r.name, key: keyValue(r.id), tagged: r.tagged }));
}
/**
 * 2.3.10: other keys that may make pictures: active, not Gemini, ticked "Pictures" by him, and their Test showed
 * the model can (or probably can). In his order; free ones before resting ones.
 */
export function otherPictureKeys() {
  const t = now();
  // 2.3.11: a Cloudflare key ticked "Pictures" is used unless its last Test failed (it is free, and made for pictures)
  const rows = usableKeys({ use: 'pictures' }).filter(r => r.kind !== 'gemini' && r.tagged && (useSupport(r).pictures.ok === true || (r.kind === 'cloudflare' && useSupport(r).pictures.ok !== false)));
  const free = (r) => !(r.cool_until > t) && !r.problem;
  return [...rows.filter(free), ...rows.filter(r => !free(r))].map(r => ({ id: r.id, name: r.name, kind: r.kind, key: keyValue(r.id), base_url: r.base_url, model: r.kind === 'cloudflare' ? effModel(r) : r.model,
    pictures_via: freshCaps(r)?.pictures_via || 'images', guess: !!freshCaps(r)?.pictures_guess, tagged: true }));
}
export function inUse() {
  const r = setting('ai_key_in_use') && get('SELECT * FROM ai_keys WHERE id=?', Number(setting('ai_key_in_use')));
  return r ? { name: r.name, kind: kindLabel(r.kind), model: r.model || (r.kind === 'gemini' ? setting('model') : '') } : null;
}
export function statusSummary() {
  return listKeys().map(k => ({ name: k.name, type: kindLabel(k.kind), model: k.effective_model, ...(k.kind === 'cloudflare' && k.use_for.some(u => CF_CHAT_USES.includes(u)) ? { chat_model: k.effective_chat_model } : {}), active: k.active, in_use: k.in_use,
    use_for: k.use_for.map(u => USE_LABELS[u]),
    can_do: k.caps_fresh ? capsLine(k.caps) : 'not tested yet (tap Test)',
    status: !k.active ? 'inactive' : k.resting_until ? 'resting until ' + k.resting_until_text : k.problem ? k.problem : k.last_ok ? 'working' : 'not used yet',
    last_error: k.last_error || undefined }));
}
