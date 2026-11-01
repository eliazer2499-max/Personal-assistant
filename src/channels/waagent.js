// WhatsApp Agent: Meta's WhatsApp Agent Platform (https://api.whatsapp.com/agent/v1), the "Agents" beta in
// personal WhatsApp (Settings → Agents → Create an agent; agent chat → Chat info → API key).
// We long-poll GET /updates (no public URL or webhook) and answer with POST /messages. Only the agent's
// creator can chat with it, and Meta lets the agent send only to its creator.
//
// Protocol followed from the community Hermes plugin "whatsapp-agent-platform" by ahtishamdilawar
// (github.com/ahtishamdilawar/hermes-whatsapp-agent-platform, reviewed commit 3a57b1d, client.py/adapter.py/state.py):
//   auth      Authorization: Bearer <key> on every call (and on the media download)
//   inbound   GET /updates?offset&timeout(0-25 s)&limit(1-100) → 200 {object:"whatsapp_agent_platform", entry[].changes[]
//             {field:"messages", value:{messages[], statuses[], contacts[]}}, next_offset} or 204 (nothing new).
//             Polling does not consume: we pass next_offset back unchanged and persist it after the page is handled.
//   outbound  POST /messages {messaging_product:"whatsapp", to:"user:<id>", type:"text", text:{body}} → messages[0].id
//             (text ≤ 4096 UTF-16 units; we split at 4000)
//   read/typing POST /statuses {messaging_product, status:"read", message_id, typing_indicator:{type:"text"}} → success.
//             Meta accepts it only for the creator's own messages (403/131005 otherwise): that is how the creator is confirmed.
//   reaction  POST /messages {messaging_product, to, type:"reaction", reaction:{message_id, emoji}} (2.3.3; emoji "" removes it).
//             One reaction per message: a new one replaces the old (so ✅ replaces the automatic 👍).
//   media in  GET /media/<id> → {url, mime_type, sha256 (hex), file_size}; GET url with the same Bearer, no redirects.
//   media out POST /media multipart (messaging_product, type, file) → {id}; POST /messages {type:"image", image:{id, caption}}
//   limits    per agent, rolling 60 s: messages 12, statuses 12, media 12, updates 15 (we poll ≤ 14/min).
//   errors    401 or code 190 / 400+100 on /updates = bad key; 403/131005 not the creator; 409/1752041 another poller
//             replaced ours; 429/130429 rate limited (Retry-After); 503 not accepted (retry); other 5xx = outcome
//             unknown (never re-sent, it may have arrived).
// The key lives in the Vault (platform "whatsapp-agent"), sealed like every other token; it is never logged or shown.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { cfg } from '../config.js';
import { get, run, setting, setSetting, audit, log, now, rememberSecret } from '../db.js';
import { seal, unseal } from '../crypto.js';
import { ownerSaid } from './inbound.js';
import { addMessage } from '../notify.js';
import { mainChatId } from '../chats.js';
import * as files from '../files.js';
import { splitStatusEmoji } from '../emoji.js';

export const CHANNEL = 'whatsapp_agent';
export const VAULT_NAME = 'whatsapp-agent';
const API_DEFAULT = 'https://api.whatsapp.com/agent/v1';
const MEDIA_HOSTS = new Set(['lookaside.fbsbx.com']);
const MEDIA_KINDS = ['image', 'video', 'audio', 'document', 'sticker'];
const CHUNK = 4000;
const CLOCK_SKEW = 120;               // s, comparing Meta timestamps with ours
const CONFLICT_LIMIT = 3, CONFLICT_WINDOW = 10 * 60000;

const base = () => (cfg.waAgentBase || API_DEFAULT).replace(/\/+$/, '');
const WINDOW = () => cfg.waAgentWindowMs || 60000;
const POLL_TIMEOUT = () => Math.max(0, Math.min(25, cfg.waAgentPollTimeout ?? 20));
const MIN_INTERVAL = () => cfg.waAgentMinIntervalMs ?? Math.ceil(60000 / 14);
const BACKOFF = () => cfg.waAgentBackoffMs || 2000;
const CONFLICT_BACKOFF = () => cfg.waAgentConflictMs || 60000;

// ---------------------------------------------------------------- key (Vault)
export function apiKey() {
  const r = get('SELECT token FROM platforms WHERE name=?', VAULT_NAME);
  if (!r) return '';
  try { const k = unseal(r.token); rememberSecret(k); return k; } catch { return ''; }
}
export const hasKey = () => !!get('SELECT 1 AS x FROM platforms WHERE name=?', VAULT_NAME);
const fingerprint = (k) => crypto.createHash('sha256').update(k).digest('hex').slice(0, 16);

export function saveKey(raw) {
  const k = String(raw || '').trim();
  if (!k) throw Object.assign(new Error('Paste the API key first.'), { status: 400 });
  if (k.length < 10 || k.length > 1024 || /\s/.test(k)) throw Object.assign(new Error('That does not look like an agent API key. Copy it again from WhatsApp: agent chat → Chat info → API key.'), { status: 400 });
  rememberSecret(k);
  run(`INSERT INTO platforms(name,kind,base_url,extra,token,added) VALUES(?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET kind=excluded.kind, base_url='', token=excluded.token`,
    VAULT_NAME, VAULT_NAME, '', null, seal(k), now());
  audit('owner', 'vault.saved', VAULT_NAME);
  keyChanged();
}
export function removeKey() {
  run('DELETE FROM platforms WHERE name=?', VAULT_NAME);
  audit('owner', 'vault.removed', VAULT_NAME);
  keyChanged();
}
/** The Vault row changed (here or on the Vault page): reconnect with the new key. */
export function keyChanged() { if (enabled()) start(); else stop(); }

// A new key is a new agent cursor: fresh offset, creator re-confirmed, older backlog skipped.
function resetIfNewKey(k) {
  const fp = fingerprint(k);
  if (setting('wa_agent_key_fp') === fp) return;
  setSetting('wa_agent_key_fp', fp);
  setSetting('wa_agent_offset', '0');
  setSetting('wa_agent_creator', '');
  setSetting('wa_agent_start_ts', String(Math.floor(Date.now() / 1000)));
}

// ---------------------------------------------------------------- state
export const enabled = () => setting('wa_agent_enabled') === '1';
const st = { state: 'off', error: '', since: 0 };
function setState(state, error = '') {
  if (st.state !== state || st.error !== error) { st.state = state; st.error = error; st.since = now(); }
}
export function status() {
  const n = (k) => parseInt(setting(k), 10) || 0;
  return {
    enabled: enabled(), has_key: hasKey(), state: enabled() ? st.state : 'off', error: enabled() ? st.error : '',
    creator_known: !!setting('wa_agent_creator'), last_in: n('wa_agent_last_in'), last_out: n('wa_agent_last_out'),
    queued: queue.length, since: st.since,
    react: reactMode() !== 'off', react_mode: reactMode(), react_modes: REACT_MODES, react_emoji: reactEmoji(), react_choices: REACT_CHOICES,
  };
}
export function setEnabled(on) {
  setSetting('wa_agent_enabled', on ? '1' : '0');
  audit('owner', 'wa_agent.' + (on ? 'enabled' : 'disabled'), '');
  if (on) start(); else stop();
  return status();
}

// ---------------------------------------------------------------- errors + HTTP
class WaErr extends Error {
  constructor(kind, message, o = {}) { super(message); this.kind = kind; this.status = o.status; this.code = o.code; this.retryAfter = o.retryAfter; }
}
function classify(status, body, action, retryAfterRaw) {
  const code = typeof body?.error?.code === 'number' ? body.error.code : undefined;
  const ra = retryAfterRaw != null && retryAfterRaw !== '' && isFinite(Number(retryAfterRaw)) ? Math.max(0, Number(retryAfterRaw)) : undefined;
  const o = { status, code, retryAfter: ra };
  const tag = `${action}: HTTP ${status}${code !== undefined ? ' code ' + code : ''}`;
  if (status === 401 || code === 190) return new WaErr('auth', tag + ' (API key missing or rejected)', o);
  if (status === 400 && code === 100 && action === 'updates') return new WaErr('auth', tag + ' (API key rejected)', o);
  if (status === 403 || code === 131005) return new WaErr('not_creator', tag + ' (not the agent\'s creator)', o);
  if (action === 'updates' && (status === 409 || code === 1752041)) return new WaErr('conflict', tag + ' (another program polled this key)', o);
  if (status === 429 || code === 130429) return new WaErr('rate', tag + ' (rate limited)', o);
  if (status === 503) return new WaErr('retry', tag + ' (not accepted, retry later)', o);
  if (status >= 500) return new WaErr('ambiguous', tag + ' (server error, outcome unknown)', o);
  if (action === 'media_get' && (code === 100 || status === 404 || status === 410)) return new WaErr('media_gone', tag + ' (file expired)', o);
  return new WaErr('rejected', tag, o);
}

let stopCtrl = null;   // aborts in-flight calls when the channel is turned off
async function request(method, path, action, { query, json, form, timeoutMs = 30000, write = false } = {}) {
  const key = apiKey();
  if (!key) throw new WaErr('auth', 'No API key saved');
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])) : '';
  const sc = stopCtrl;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (sc) signals.push(sc.signal);
  let r;
  try {
    r = await fetch(base() + path + qs, {
      method, redirect: 'error', signal: AbortSignal.any(signals),
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}) },
      body: json ? JSON.stringify(json) : form || undefined,
    });
  } catch (e) {
    if (sc?.signal.aborted) throw new WaErr('stopped', action + ': stopped');
    const c = e?.cause?.code || '';
    if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET_BEFORE|UND_ERR_CONNECT/.test(c) || !write) throw new WaErr('retry', `${action}: could not reach WhatsApp (${e.name === 'TimeoutError' ? 'timed out' : c || e.name})`);
    throw new WaErr('ambiguous', `${action}: connection lost, outcome unknown (${e.name === 'TimeoutError' ? 'timed out' : c || e.name})`);
  }
  if (r.status >= 400) {
    let body = {}; try { body = JSON.parse((await r.text()).slice(0, 16384)); } catch {}
    throw classify(r.status, body, action, r.headers.get('retry-after'));
  }
  return r;
}

// Rolling 60 s window, like the reference: a short burst goes through, it only waits when the window is full.
class RateWindow {
  constructor(limit) { this.limit = limit; this.stamps = []; }
  prune(t) { const w = WINDOW(); while (this.stamps.length && t - this.stamps[0] >= w) this.stamps.shift(); }
  delay() { const t = Date.now(); this.prune(t); return this.stamps.length < this.limit ? 0 : Math.max(0, WINDOW() - (t - this.stamps[0])); }
  tryAcquire() { if (this.delay() > 0) return false; this.stamps.push(Date.now()); return true; }
  async acquire() { for (;;) { const d = this.delay(); if (d <= 0) { this.stamps.push(Date.now()); return; } await sleep(d + 5); } }
  penalize(sec) { const t = Date.now(); const fill = t - WINDOW() + Math.min(WINDOW(), Math.max(0, sec * 1000)); this.stamps = Array(this.limit).fill(fill); }
}
export const limits = { messages: new RateWindow(12), statuses: new RateWindow(12), media: new RateWindow(12) };
const sleep = (ms, signal) => new Promise((res) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

// ---------------------------------------------------------------- API calls
export async function getUpdates(offset, timeout) {
  const r = await request('GET', '/updates', 'updates', { query: { offset, timeout, limit: 50 }, timeoutMs: (timeout + 15) * 1000 });
  if (r.status === 204) return { next_offset: null, messages: [] };
  let j; try { j = await r.json(); } catch { throw new WaErr('malformed', 'updates: body is not JSON'); }
  if (!j || j.object !== 'whatsapp_agent_platform' || !Number.isInteger(j.next_offset)) throw new WaErr('malformed', 'updates: unexpected answer');
  const messages = [];
  for (const e of Array.isArray(j.entry) ? j.entry : []) for (const ch of Array.isArray(e?.changes) ? e.changes : []) {
    if (ch?.field !== 'messages' || !ch.value) continue;
    for (const m of Array.isArray(ch.value.messages) ? ch.value.messages : []) if (m && typeof m === 'object') messages.push(m);
  }
  return { next_offset: j.next_offset, messages };
}
async function postMessage(payload, { needId = true } = {}) {
  await limits.messages.acquire();
  let r;
  try { r = await request('POST', '/messages', 'send', { json: { messaging_product: 'whatsapp', ...payload }, timeoutMs: 60000, write: true }); }
  catch (e) { if (e.kind === 'rate') limits.messages.penalize(e.retryAfter ?? 10); throw e; }
  const j = await r.json().catch(() => ({}));
  const id = j?.messages?.[0]?.id;
  if (typeof id !== 'string' || !id) { if (!needId) return ''; throw new WaErr('malformed', 'send: answer without a message id'); }
  return id;
}

// ---------------------------------------------------------------- reactions (2.3.3)
export const REACT_CHOICES = ['👍', '👀', '❤️', '✅'];
const WAMID_RE = /^[A-Za-z0-9._:=+\/-]{1,256}$/;
// 2.3.4: Settings → Channels → WhatsApp Agent → Reactions is one of three modes:
//   natural — no automatic reaction on chit-chat; the assistant reacts now and then with the react tool, like a friend
//             texting (default; 2.3.3 installs move here too, whatever "React to my messages" was set to).
//             2.3.7: a real request (the job used at least one tool other than react) gets 👍 when the work starts and
//             ✅ when it finishes well — see taskStarted / taskDone;
//   every   — the 2.3.3 behaviour: every accepted message gets the chosen emoji (👍 👀 ❤️ ✅);
//   off     — no reactions at all, the react tool included.
export const REACT_MODES = ['natural', 'every', 'off'];
export const reactMode = () => { const m = setting('wa_agent_react_mode'); return REACT_MODES.includes(m) ? m : 'natural'; };
export const reactEnabled = () => reactMode() === 'every';   // the automatic reaction
export const reactEmoji = () => { const e = setting('wa_agent_react_emoji'); return REACT_CHOICES.includes(e) ? e : '👍'; };
/** One emoji, or '' (removes our reaction). */
export function cleanEmoji(e) {
  const s = String(e ?? '').trim();
  if (!s) return '';
  if (s.length > 16 || /[\s<>"'`\\]/.test(s) || /^[\x20-\x7e]+$/.test(s)) throw Object.assign(new Error('Give one emoji, like 👍 ❤️ 😂 ✅ (or empty to remove the reaction).'), { kind: 'bad_emoji' });
  let n = 0; try { n = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length; } catch { n = 1; }
  if (n !== 1) throw Object.assign(new Error('Give exactly one emoji.'), { kind: 'bad_emoji' });
  return s;
}
/**
 * React to one of his WhatsApp messages with an emoji ('' removes our reaction). Same /messages endpoint, auth,
 * error handling and 12-a-minute budget as text. Never waits for the budget: if it is full the reaction is skipped,
 * so a reaction can never hold up a reply.
 */
export async function reactTo(wamid, emoji) {
  const id = String(wamid || '').trim();
  if (!WAMID_RE.test(id)) throw new WaErr('bad_ref', 'no WhatsApp message to react to');
  const e = cleanEmoji(emoji);
  const to = setting('wa_agent_creator');
  if (!enabled() || !hasKey() || !to) throw new WaErr('off', 'WhatsApp Agent is not connected');
  if (limits.messages.delay() > 0) throw new WaErr('rate', 'skipped: WhatsApp\'s 12-a-minute limit is full right now');
  await postMessage({ to, type: 'reaction', reaction: { message_id: id, emoji: e } }, { needId: false });
  return e;
}
/** Automatic reaction when one of his messages is accepted (Reactions = "Every message" only). */
function autoReact(wamid) {
  if (!reactEnabled()) return;
  const e = reactEmoji();
  reactTo(wamid, e).catch((err) => {
    log('wa agent react', err.message);
    audit('system', 'wa_agent.react_failed', `automatic ${e}: ${err.message}`);
  });
}
export function setReact({ mode, on, emoji } = {}) {
  if (mode !== undefined) {
    if (!REACT_MODES.includes(mode)) throw Object.assign(new Error('Pick one of: Natural, Every message, Off'), { status: 400 });
    setSetting('wa_agent_react_mode', mode);
  } else if (on !== undefined) setSetting('wa_agent_react_mode', on ? 'every' : 'off');   // 2.3.3 clients sent { on }
  if (emoji !== undefined) {
    if (!REACT_CHOICES.includes(emoji)) throw Object.assign(new Error('Pick one of ' + REACT_CHOICES.join(' ')), { status: 400 });
    setSetting('wa_agent_react_emoji', emoji);
  }
  const m = reactMode();
  audit('owner', 'wa_agent.react', m === 'every' ? 'every message ' + reactEmoji() : m === 'natural' ? 'natural (the assistant decides)' : 'off');
  return status();
}

// 2.3.4: which of his recent messages the assistant reacted to (for the Natural-mode cap). Oldest first, last 12.
const RECENT_MAX = 12;
function recentIn() { try { const a = JSON.parse(setting('wa_agent_react_recent') || '[]'); return Array.isArray(a) ? a.filter(x => x && typeof x.id === 'string') : []; } catch { return []; } }
function saveRecent(a) { setSetting('wa_agent_react_recent', JSON.stringify(a.slice(-RECENT_MAX))); }
export function noteInbound(wamid) { const a = recentIn().filter(x => x.id !== wamid); a.push({ id: wamid, r: false }); saveRecent(a); }
// 2.3.7: x.e = the emoji now on the message; x.auto = it was the automatic task reaction (👍/✅), which does not
// count toward the Natural cap (the cap is about the assistant's own chit-chat reactions).
function markReacted(wamid, on, e = '', auto = false) { const a = recentIn(); const x = a.find(y => y.id === wamid); if (x) { x.r = !!on; x.e = on ? e : ''; x.auto = !!(on && auto); saveRecent(a); } }
const onNow = (wamid) => recentIn().find(y => y.id === wamid)?.e || '';
/** True when the assistant already reacted to his 2 messages right before this one (so a 3rd in a row is skipped). */
export function reactedTwiceBefore(wamid) {
  const a = recentIn();
  let i = a.findIndex(x => x.id === wamid);
  if (i < 0) i = a.length;
  if (a[i] && a[i].r) return false;                     // changing a reaction already on this message (👍 → ✅) is fine
  const prev = a.slice(Math.max(0, i - 2), i);
  return prev.length === 2 && prev.every(x => x.r && !x.auto);
}
/**
 * The assistant's react tool. Off → refused. Natural → at most 2 of his messages in a row (a 3rd is skipped and the
 * skip goes to Activity only). Every message → as in 2.3.3. Errors are thrown for the tool to report.
 */
export async function toolReact(wamid, emoji) {
  const m = reactMode();
  if (m === 'off') throw new WaErr('off_setting', 'reactions are turned off (Settings → Channels → WhatsApp Agent → Reactions)');
  const e = cleanEmoji(emoji);
  const id = String(wamid || '').trim();
  if (m === 'natural' && e && reactedTwiceBefore(id)) {
    audit('system', 'wa_agent.react_skipped', `skipped ${e}: already reacted to his last 2 messages in a row`);
    return { skipped: true, emoji: e };
  }
  const sent = await reactTo(id, e);
  markReacted(id, !!sent, sent);
  return { skipped: false, emoji: sent };
}

// ---------------------------------------------------------------- 2.3.7: Natural-mode task reactions
// "Real request" = the job for his message used at least one tool other than react (a question it answers from its
// head, a "thanks" or an "ok" uses none). The brain calls taskStarted at that first tool call (👍, "I'm on it") and
// taskDone when the job ended well (✅). Natural mode only; Every message and Off are untouched. Same 12-a-minute
// budget as everything else and never awaited by the brain, so a reaction can never hold up a reply.
export const TASK_START = '👍', TASK_DONE = '✅';
const taskChain = new Map();   // per message: ✅ waits for a 👍 still on its way, so the right one ends up on
function autoTask(wamid, e, what) {
  const id = String(wamid || '').trim();
  const p = (taskChain.get(id) || Promise.resolve('')).then(() => autoTaskNow(id, e, what));
  taskChain.set(id, p);
  p.finally(() => { if (taskChain.get(id) === p) taskChain.delete(id); });
  return p;
}
async function autoTaskNow(id, e, what) {
  if (reactMode() !== 'natural' || !WAMID_RE.test(id)) return '';
  if (onNow(id) === e) return e;                                    // already showing (e.g. the AI put ✅ itself)
  try {
    const sent = await reactTo(id, e);
    markReacted(id, true, sent, true);
    audit('assistant', 'wa_agent.react_task', `${what}: ${sent}`);
    return sent;
  } catch (err) {
    log('wa agent react', err.message);
    audit('system', 'wa_agent.react_failed', `automatic ${e} (${what}): ${err.message}`);
    return '';
  }
}
/** The job for his message started real work (its first tool other than react): 👍 on his message. */
export const taskStarted = (wamid) => autoTask(wamid, TASK_START, 'task started');
/** That job finished well: ✅ replaces the 👍. */
export const taskDone = (wamid) => autoTask(wamid, TASK_DONE, 'task done');
/**
 * 2.3.5 safety net for the outbound text. The AI sometimes types its reaction ("✅", blank line, then the words)
 * instead of calling the react tool. A first or last line holding only 1–2 status emoji (✅ ☑️ ✔️ 👍 👌 ❤️ 🙏 😂 👀
 * 🎉 🔥) is taken out of the text and, when Reactions is Natural or Every message and the Natural cap allows, put on
 * the message being answered as a real reaction through reactTo (via toolReact, so the cap and Off are obeyed).
 * Off → the line is just dropped. A reply that is ONLY the emoji is never stripped to nothing: it goes as a reaction
 * instead of a bubble, or as text when Reactions is Off, there is no message to react to, the cap says no or the
 * reaction fails. Emoji inside a sentence are never touched. Activity gets one line; the chat never does.
 * Returns { text: string to send | null when nothing is left to send, reacted: emoji | '' }.
 */
export async function moveStatusEmoji(text, wamid, opts = {}) {
  const s = splitStatusEmoji(text);
  if (!s.where) return { text, reacted: '' };
  const e = s.emoji, id = String(wamid || '').trim();
  const mode = reactMode();
  // 2.3.7: the job finished a real request in Natural mode, so ✅ goes on his message anyway (sendOwner). The typed
  // line is just taken out (two reactions racing would leave the wrong one on); an emoji-only reply becomes that ✅.
  if (opts.taskDone && mode === 'natural' && WAMID_RE.test(id)) {
    if (s.where === 'only') {
      const r = await taskDone(id);
      if (r) { audit('assistant', 'wa_agent.react_moved', `the reply was only ${e}; the task ✅ went on his message instead`); return { text: null, reacted: r }; }
      audit('system', 'wa_agent.react_moved', `the reply was only ${e}; sent it as text (the ✅ reaction was not sent)`);
      return { text, reacted: '' };
    }
    audit('system', 'wa_agent.react_moved', `removed ${e} from the text; the task ✅ goes on his message instead`);
    return { text: s.text, reacted: '' };
  }
  const can = mode !== 'off' && WAMID_RE.test(id);
  let reacted = '', why = '';
  if (can) {
    const tryIt = async () => {
      const r = await toolReact(id, e);
      if (r.skipped) { why = 'already reacted to his last 2 messages'; return ''; }
      return r.emoji || e;
    };
    if (s.where === 'only') {
      try { reacted = await tryIt(); } catch (err) { why = err.message; }
    } else {
      // never hold up the words: the reaction goes out beside them
      tryIt().then((x) => { if (x) audit('assistant', 'wa_agent.react_moved', `moved ${e} from text to reaction`); else audit('system', 'wa_agent.react_moved', `removed ${e} from the text; no reaction (${why})`); })
        .catch((err) => { log('wa agent react', err.message); audit('system', 'wa_agent.react_failed', `moved ${e} out of the text, reaction not sent: ${err.message}`); });
      return { text: s.text, reacted: e };
    }
  } else why = mode === 'off' ? 'Reactions are Off' : 'no message of his to react to';
  if (s.where === 'only') {
    if (reacted) { audit('assistant', 'wa_agent.react_moved', `moved ${e} from text to reaction (the reply was only ${e})`); return { text: null, reacted }; }
    audit('system', 'wa_agent.react_moved', `the reply was only ${e}; sent it as text (${why})`);
    return { text, reacted: '' };
  }
  audit('system', 'wa_agent.react_moved', `removed ${e} from the text; no reaction (${why})`);
  return { text: s.text, reacted: '' };
}
export async function markRead(wamid, typing = true) {
  if (!limits.statuses.tryAcquire()) throw new WaErr('rate', 'statuses: local budget used up');
  const body = { messaging_product: 'whatsapp', status: 'read', message_id: wamid };
  if (typing) body.typing_indicator = { type: 'text' };
  const r = await request('POST', '/statuses', 'statuses', { json: body, write: true });
  const j = await r.json().catch(() => ({}));
  if (j?.success !== true) throw new WaErr('malformed', 'statuses: answer without success');
}
async function uploadMedia(buf, mime, name) {
  await limits.media.acquire();
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buf], { type: mime }), name);
  const r = await request('POST', '/media', 'media_upload', { form, timeoutMs: 60000, write: true });
  const j = await r.json().catch(() => ({}));
  if (typeof j?.id !== 'string' || !j.id) throw new WaErr('malformed', 'media_upload: answer without id');
  return j.id;
}

const MEDIA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function trustedMediaUrl(raw) {
  let u; try { u = new URL(String(raw)); } catch { throw new WaErr('media', 'the file link was malformed'); }
  const b = new URL(base());
  const sameAsApi = u.origin === b.origin;                       // the API host itself (also how tests serve files)
  const allowed = (u.protocol === 'https:' && !u.username && !u.password && (u.port === '' || u.port === '443') && MEDIA_HOSTS.has(u.hostname)) || sameAsApi;
  if (!allowed) throw new WaErr('media', 'the file link pointed somewhere unexpected');
  return u;
}
function parseSha(v) {
  const s = String(v || '').trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  try { const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); return b.length === 32 ? b : null; } catch { return null; }
}
/** Download one inbound file into the upload store (same limits as the web paperclip). */
export async function fetchMedia(obj, type) {
  if (!MEDIA_ID.test(String(obj?.id || ''))) throw new WaErr('media', 'the file id was malformed');
  const name0 = obj.filename || (type === 'audio' ? (obj.voice ? 'voice-note' : 'audio') : type === 'image' ? 'photo' : type);
  const ext = { 'audio/ogg': '.ogg', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
    'application/zip': '.zip', 'text/csv': '.csv', 'text/plain': '.txt', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx' };
  let mime = String(obj.mime_type || '').split(';')[0].trim().toLowerCase();
  const name = /\.[a-z0-9]{1,5}$/i.test(name0) ? name0 : name0 + (ext[mime] || '');
  files.pickMime(mime, name);                     // throws 415 for kinds the brain cannot use (video, zip, …) before downloading
  await limits.media.acquire();
  const r = await request('GET', '/media/' + obj.id, 'media_get', {});
  const info = await r.json().catch(() => ({}));
  if (typeof info?.url !== 'string') throw new WaErr('media', 'WhatsApp did not give a file link');
  if (Number.isInteger(info.file_size) && info.file_size > files.MAX_FILE) throw Object.assign(new Error('File too large (max 20 MB)'), { status: 413 });
  const url = trustedMediaUrl(info.url);
  const key = apiKey();
  let d;
  try { d = await fetch(url, { headers: { Authorization: 'Bearer ' + key, 'Accept-Encoding': 'identity' }, redirect: 'manual', signal: AbortSignal.timeout(90000) }); }
  catch (e) { throw new WaErr('retry', 'download: ' + (e.name === 'TimeoutError' ? 'timed out' : 'could not connect')); }
  if (d.status >= 300 && d.status < 400) throw new WaErr('media', 'download: redirect refused');
  if (d.status === 404 || d.status === 410) throw new WaErr('media_gone', 'the file has expired on WhatsApp');
  if (d.status !== 200) throw new WaErr('media', 'download: HTTP ' + d.status);
  const chunks = []; let size = 0;
  for await (const c of d.body) { size += c.length; if (size > files.MAX_FILE) throw Object.assign(new Error('File too large (max 20 MB)'), { status: 413 }); chunks.push(c); }
  const buf = Buffer.concat(chunks);
  const digest = crypto.createHash('sha256').update(buf).digest();
  for (const want of [info.sha256, obj.sha256].filter(Boolean).map(parseSha)) if (want && !crypto.timingSafeEqual(digest, want)) throw new WaErr('media', 'the file arrived damaged (checksum mismatch)');
  if (info.mime_type) mime = String(info.mime_type).split(';')[0].trim().toLowerCase();
  return files.saveUpload(buf, mime, name, mainChatId());
}

// ---------------------------------------------------------------- outbound queue (12/min, one at a time)
const queue = [];
let draining = false;
function enqueue(item) { return new Promise((resolve, reject) => { queue.push({ ...item, resolve, reject, tries: 0 }); drain(); }); }
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const it = queue[0];
      try {
        let id;
        if (it.type === 'file') {
          const plan = filePlan(it.mime, it.name, it.buf.length);
          const mediaId = await uploadMedia(it.buf, plan.mime, plan.name);
          const obj = { id: mediaId };
          if (plan.kind === 'document') obj.filename = plan.name;
          if (it.caption && plan.kind !== 'audio') obj.caption = String(it.caption).slice(0, 1024);
          id = await postMessage({ to: it.to, type: plan.kind, [plan.kind]: obj });
        } else id = await postMessage({ to: it.to, type: 'text', text: { body: it.text } });
        queue.shift();
        setSetting('wa_agent_last_out', String(now()));
        it.resolve(id);
      } catch (e) {
        // Rate limit / 503 / no connection: certainly not sent, so it is safe to try again after a pause.
        if ((e.kind === 'rate' || e.kind === 'retry') && it.tries < 5 && enabled()) {
          it.tries++;
          await sleep(e.kind === 'rate' ? 0 : Math.min(30000, BACKOFF() * 2 ** it.tries));
          continue;
        }
        queue.shift();
        if (e.kind === 'auth') setState('error', BAD_KEY);
        it.reject(e.kind === 'ambiguous' ? Object.assign(new Error('WhatsApp did not confirm one message (it may or may not have arrived); not re-sent to avoid a duplicate'), { kind: e.kind }) : e);
      }
    }
  } finally { draining = false; }
}
function rejectQueue(why) { while (queue.length) queue.shift().reject(new Error(why)); }

/** WhatsApp's own formatting: **bold** → *bold*, no markdown headings. */
export function toWhatsApp(text) {
  return String(text).replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#{1,6}\s+/gm, '');
}
/** Split into ≤ 4000-unit messages, at a paragraph, line or word break when possible. */
export function splitText(text, max = CHUNK) {
  const out = []; let s = String(text);
  while (s.length > max) {
    let cut = s.lastIndexOf('\n\n', max); if (cut < max * 0.5) cut = s.lastIndexOf('\n', max); if (cut < max * 0.5) cut = s.lastIndexOf(' ', max); if (cut < max * 0.5) cut = max;
    if (/[\uD800-\uDBFF]/.test(s[cut - 1])) cut--;              // never split an emoji in half
    out.push(s.slice(0, cut).trimEnd()); s = s.slice(cut).replace(/^\s+/, '');
  }
  if (s.trim()) out.push(s);
  return out.length ? out : [];
}

// ---------------------------------------------------------------- 2.3.1: files out
// Meta's limits for agents, as the reference plugin (media.py SEND_LIMITS) states them: images 5 MiB (JPEG/PNG),
// video 16 MiB (MP4/3GP), audio 16 MiB (MP3, M4A, AAC, AMR, Ogg), documents 16 MiB. Anything else goes as a file.
const MIB = 1024 * 1024;
export const WA_MAX_FILE = 16 * MIB;
const AUDIO_OK = new Set(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr', 'audio/ogg']);
const VIDEO_OK = new Set(['video/mp4', 'video/3gpp']);
const DOC_OK = new Set(['application/pdf', 'text/plain', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation']);
/** How one file goes to WhatsApp: { kind: image|audio|video|document, mime, name } (or throws when too big). */
export function filePlan(mime, name, size) {
  mime = String(mime || '').split(';')[0].trim().toLowerCase();
  if (size > WA_MAX_FILE) throw Object.assign(new Error(`too big for WhatsApp (${(size / MIB).toFixed(1)} MB; WhatsApp agents take files up to 16 MB)`), { kind: 'too_big', status: 413 });
  if (/^image\/(jpeg|png)$/.test(mime) && size <= 5 * MIB) return { kind: 'image', mime, name };
  if (AUDIO_OK.has(mime)) return { kind: 'audio', mime, name };
  if (VIDEO_OK.has(mime)) return { kind: 'video', mime, name };
  if (DOC_OK.has(mime) && !/^image\//.test(mime)) return { kind: 'document', mime, name };
  if (/^text\//.test(mime) || mime === 'application/json') return { kind: 'document', mime: 'text/plain', name };
  return { kind: 'document', mime: 'application/octet-stream', name };     // zip, apk, big photos, other audio/video: as a file
}
/** send_file: one file (with an optional caption) to his agent chat; waits until WhatsApp took it. */
export async function sendFileNow(row, caption = '') {
  if (!enabled()) throw Object.assign(new Error('WhatsApp Agent is turned off (Settings → Channels)'), { kind: 'off' });
  if (!hasKey()) throw Object.assign(new Error('no WhatsApp Agent key saved (Settings → Channels)'), { kind: 'off' });
  const to = setting('wa_agent_creator');
  if (!to) throw Object.assign(new Error('send the WhatsApp agent one message first, so I know your chat'), { kind: 'off' });
  const plan = filePlan(row.mime, row.name, row.size);           // too big → throws before anything is sent
  const jobs = [];
  if (caption && plan.kind === 'audio') jobs.push(enqueue({ type: 'text', to, text: toWhatsApp(caption).slice(0, 4000) }));   // audio takes no caption
  jobs.push(enqueue({ type: 'file', to, buf: fs.readFileSync(files.filePath(row)), mime: row.mime, name: row.name, caption: plan.kind === 'audio' ? '' : toWhatsApp(caption) }));
  await Promise.all(jobs);
  return plan.kind;
}

/** Send to the owner's agent chat. opts: { wait, files: [file rows] }. Without wait it returns at once (queued). */
export async function sendOwner(text, opts = {}) {
  if (!enabled()) throw new Error('WhatsApp Agent is turned off');
  if (!hasKey()) throw new Error('No WhatsApp Agent key saved');
  const to = setting('wa_agent_creator');
  if (!to) throw new Error('Send your WhatsApp agent one message first, so I know your chat');
  // 2.3.5: a lone "✅" line typed into the reply becomes a real reaction on his message (or is just dropped).
  const net = await moveStatusEmoji(text, opts.meta?.waa_wamid, { taskDone: !!opts.taskDone });
  if (net.reacted && net.text === null) return true;           // the whole reply was an emoji: it went as a reaction
  text = net.text ?? text;
  const jobs = splitText(toWhatsApp(text)).map(c => enqueue({ type: 'text', to, text: c }));
  // 2.3.7: Natural mode, a real request that finished well → ✅ on his message, queued right after the words (not awaited).
  if (opts.taskDone) Promise.resolve(jobs[0]).catch(() => {}).finally(() => taskDone(opts.meta?.waa_wamid));
  for (const f of opts.files || []) {
    try { jobs.push(enqueue({ type: 'file', to, buf: fs.readFileSync(files.filePath(f)), mime: f.mime, name: f.name })); } catch (e) { log('wa agent: file not sent', e.message); }
  }
  const done = Promise.all(jobs);
  if (opts.wait) { await done; return true; }
  done.catch(e => { log('wa agent send failed', e.message); addMessage('notice', 'web', 'Could not deliver to WhatsApp: ' + e.message); });
  return true;
}

// ---------------------------------------------------------------- inbound
const isSeen = (wamid) => !!get('SELECT 1 AS x FROM seen WHERE id=?', 'waa:' + wamid);
const markSeen = (wamid) => { try { run('INSERT INTO seen(id,ts) VALUES(?,?)', 'waa:' + wamid, now()); } catch {} };

async function authorize(from, wamid) {
  const creator = setting('wa_agent_creator');
  if (creator && from === creator) { markRead(wamid, true).catch(() => {}); return true; }
  try { await markRead(wamid, true); }
  catch (e) {
    if (e.kind === 'not_creator') return false;
    if (e.kind === 'retry' || e.kind === 'rate' || e.kind === 'ambiguous') throw e;   // can't confirm now: re-poll this page
    return false;
  }
  setSetting('wa_agent_creator', from);
  audit('system', creator ? 'wa_agent.creator_changed' : 'wa_agent.creator_confirmed', 'confirmed by WhatsApp');
  return true;
}

const LABEL = { image: 'photo', video: 'video', audio: 'audio', document: 'file', sticker: 'sticker' };
async function handleInbound(m) {
  const wamid = m.id, from = m.from, type = m.type;
  if (typeof wamid !== 'string' || !wamid || typeof from !== 'string' || !/^user:\S+$/.test(from)) return;
  if (isSeen(wamid)) return;                                         // dedupe across restarts and replays
  const ts = parseInt(m.timestamp, 10);
  const startTs = parseInt(setting('wa_agent_start_ts'), 10) || 0;
  if (ts && ts < startTs - CLOCK_SKEW) { markSeen(wamid); return; }   // backlog from before it was first turned on
  if (type === 'reaction') { markSeen(wamid); return; }
  if (!(await authorize(from, wamid))) { markSeen(wamid); log('wa agent: dropped a message from someone who is not the agent\'s creator'); return; }
  markSeen(wamid);
  setSetting('wa_agent_last_in', String(now()));
  setSetting('wa_agent_last_wamid', wamid);
  noteInbound(wamid);                                                // 2.3.4: for the Natural-mode cap
  autoReact(wamid);                                                  // 2.3.3: only in "Every message" mode; never awaited
  const meta = { waa_wamid: wamid };
  if (type === 'text') {
    const t = typeof m.text?.body === 'string' ? m.text.body : '';
    const reply = await ownerSaid(CHANNEL, t, meta);
    if (reply) await sendOwner(reply).catch(e => log('wa agent reply', e.message));
    return;
  }
  if (MEDIA_KINDS.includes(type)) {
    const obj = m[type] || {};
    const caption = typeof obj.caption === 'string' ? obj.caption : '';
    let row = null, problem = '';
    try { row = await fetchMedia(obj, type); }
    catch (e) {
      if (e.status === 415) problem = type === 'document' && e.message ? e.message : `I can't open a ${LABEL[type]} like that here. ${files.SUPPORTED_TEXT}`;
      else if (e.status === 413) problem = `That ${LABEL[type]} is too big for me (max 20 MB).`;
      else problem = `I couldn't download that ${LABEL[type]} from WhatsApp (${e.message}). Please send it again.`;
      log('wa agent media', type, e.message);
    }
    if (row) { await ownerSaid(CHANNEL, caption, meta, [row.id]); return; }
    if (caption) { await ownerSaid(CHANNEL, caption + `\n\n[He also sent a ${LABEL[type]} on WhatsApp that could not be opened: ${problem}]`, meta); return; }
    addMessage('owner', CHANNEL, `(${LABEL[type]})`);
    addMessage('notice', CHANNEL, problem);
    await sendOwner(problem).catch(() => {});
    return;
  }
  addMessage('owner', CHANNEL, `(${type || 'message'})`);
  await sendOwner('I can read text, voice notes, photos and files here.').catch(() => {});
}

// ---------------------------------------------------------------- the long-poll worker
const BAD_KEY = 'WhatsApp rejected the API key. In WhatsApp open your agent\'s chat → Chat info → API key, copy it again and paste it here.';
let gen = 0;
export const running = () => !!stopCtrl;

export function start() {
  stop(true);
  if (!enabled()) { setState('off'); return false; }
  const key = apiKey();
  if (!key) { setState('error', 'No API key saved yet. Paste it below (WhatsApp → agent chat → Chat info → API key).'); return false; }
  resetIfNewKey(key);
  const my = ++gen;
  stopCtrl = new AbortController();
  setState('connecting');
  loop(my, stopCtrl.signal).catch(e => { log('wa agent loop crashed', e.message); if (gen === my) setState('error', 'Stopped after an internal error; turn it off and on.'); });
  return true;
}
export function stop(silent = false) {
  gen++;
  if (stopCtrl) { stopCtrl.abort(); stopCtrl = null; }
  if (!silent) { setState('off'); rejectQueue('WhatsApp Agent was turned off'); }
}

async function loop(my, signal) {
  let failures = 0, lastPoll = 0, first = true;
  const conflicts = [];
  while (gen === my) {
    const wait = MIN_INTERVAL() - (Date.now() - lastPoll);
    if (wait > 0) await sleep(wait, signal);
    if (gen !== my) return;
    lastPoll = Date.now();
    try {
      const offset = parseInt(setting('wa_agent_offset'), 10) || 0;
      const u = await getUpdates(offset, first ? 0 : POLL_TIMEOUT());
      if (gen !== my) return;
      first = false;
      setState('connected');
      if (u.next_offset !== null) {
        for (const m of u.messages) {
          try { await handleInbound(m); }
          catch (e) { if (e instanceof WaErr && ['retry', 'rate', 'ambiguous'].includes(e.kind)) throw e; log('wa agent: skipped one message', e.message); }
        }
        if (gen !== my) return;
        setSetting('wa_agent_offset', String(u.next_offset));   // persisted: a restart continues here, no replay
      }
      failures = 0;
    } catch (e) {
      if (gen !== my || e.kind === 'stopped') return;
      if (e.kind === 'auth') { setState('error', BAD_KEY); log('wa agent: polling stopped,', e.message); audit('system', 'wa_agent.bad_key', e.message); stopCtrl = null; return; }
      if (e.kind === 'conflict') {
        const t = Date.now(); conflicts.push(t); while (conflicts.length && t - conflicts[0] > CONFLICT_WINDOW) conflicts.shift();
        if (conflicts.length >= CONFLICT_LIMIT) { setState('error', 'Another program is using this agent\'s API key (only one can listen at a time). Stop the other one, then turn this off and on.'); stopCtrl = null; return; }
        setState('connecting', 'Another program asked WhatsApp with this key; trying again in a minute.');
        await sleep(CONFLICT_BACKOFF(), signal);
        continue;
      }
      failures++;
      let delay = Math.min(60000, BACKOFF() * 2 ** Math.min(failures - 1, 5));
      if (e.kind === 'rate' && e.retryAfter != null) delay = Math.max(delay, Math.min(60000, e.retryAfter * 1000));
      setState('connecting', `Reconnecting (${String(e.message).slice(0, 120)})`);
      log('wa agent: poll failed,', e.message, '- retrying in', Math.round(delay / 1000) + 's');
      await sleep(delay, signal);
    }
  }
}
