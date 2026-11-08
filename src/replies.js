// 2.3.15 (amended Nov 7, his words: "If I ask 2 questions its 2 answers not both in 1"): how the assistant answers
// several messages of his that it read together (a quick batch, or a message that came in while it worked).
// The model's final answer for such a batch is a small JSON list:
//   {"replies":[{"to":[1],"text":"…"},{"to":[2,3],"text":"…"},{"to":[4],"react":"❤️"},{"to":[1],"keep":true}]}
//   to    = the number(s) of his messages ([#1], [#2]…) that reply answers. The first one is the message it quotes.
//   text  = the words (left out = a reaction only)
//   react = optional: one emoji on that message (shown like a tapback)
//   keep  = only after a rewrite request: "the reply I already wrote for this message is still right, send it as it was"
// Separate questions → separate replies, each sent as a reply to its own message. A message that only adds to or
// corrects an earlier one is listed in that reply's "to" (merged). Anything that is not this JSON is one plain reply
// to all of them (exactly the earlier behaviour), so a model that ignores the format still answers.

/** Escape raw line breaks/tabs inside JSON strings (models often put real newlines in "text"). */
function repairJson(s) {
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === '\\') { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') continue;
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    } else { if (ch === '"') inStr = true; out += ch; }
  }
  return out;
}
function tryJson(s) {
  for (const v of [s, repairJson(s)]) { try { return JSON.parse(v); } catch {} }
  return undefined;
}
const nums = (v, n) => {
  const arr = Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : String(v).split(/[,\s&+]+/));
  const out = [];
  for (const x of arr) { const k = parseInt(String(x).replace(/^#/, ''), 10); if (k >= 1 && k <= n && !out.includes(k)) out.push(k); }
  return out;
};
const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/**
 * The replies list from the model's final text, or null when it is not in the replies format.
 * n = how many of his messages this answer covers. Items: { to: [numbers], text, react, keep }.
 */
export function parseReplies(text, n) {
  let t = String(text || '').trim();
  if (!t || !/"replies"|^\s*(?:```\w*\s*)?\[\s*\{/.test(t)) return null;
  t = unfence(t);
  let obj;
  const a = t.indexOf('{'), z = t.lastIndexOf('}');
  if (/^\s*\[/.test(t)) obj = tryJson(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
  if (obj === undefined && a >= 0 && z > a) obj = tryJson(t.slice(a, z + 1));
  if (obj === undefined) return null;
  const list = Array.isArray(obj) ? obj : Array.isArray(obj?.replies) ? obj.replies : null;
  if (!list) return null;
  const items = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const to = nums(r.to ?? r.reply_to ?? r.reply_to_message ?? r.reply_to_message_ids ?? r.messages ?? r.message, n);
    const it = { to: to.length ? to : [n], text: str(r.text ?? r.reply ?? r.answer).trim(), react: str(r.react ?? r.reaction ?? r.emoji).trim(), keep: r.keep === true || r.keep === 'true' };
    if (!it.text && !it.react && !it.keep) continue;
    items.push(it);
  }
  return items;
}

/** A plain (non-JSON) answer as a replies list: one reply to all of his messages so far. */
export function plainAsReplies(text, n) {
  return [{ to: Array.from({ length: Math.max(1, n) }, (_, i) => i + 1), text: String(text || '').trim(), react: '', keep: false }];
}

/** Fill "keep" items from the draft that was not sent; drop duplicates. Returns a new list (no keep left). */
export function resolveReplies(items, draft = []) {
  const out = [];
  for (const it of items) {
    if (it.keep) {
      const exact = draft.find(d => d.to[0] === it.to[0]) || draft.find(d => d.to.some(k => it.to.includes(k)));
      if (!exact) continue;                         // nothing to keep for that message
      out.push({ to: Array.from(new Set([...exact.to, ...it.to])), text: exact.text, react: it.react || exact.react, keep: false });
    } else out.push({ ...it, to: it.to.slice() });
  }
  // never the same words twice, and never two replies quoting the same message: merge them
  const merged = [];
  for (const it of out) {
    const same = merged.find(m => (it.text && m.text && m.text === it.text) || (it.text && m.text && m.to[0] === it.to[0]));
    if (same) {
      for (const k of it.to) if (!same.to.includes(k)) same.to.push(k);
      if (same.text !== it.text && it.text) same.text = same.text + '\n\n' + it.text;
      if (!same.react && it.react) same.react = it.react;
      continue;
    }
    merged.push(it);
  }
  return merged;
}

/** The list as the model wrote it (used to show it the draft it is rewriting). */
export function repliesJson(items) {
  return JSON.stringify({ replies: items.map(i => ({ to: i.to, ...(i.text ? { text: i.text } : {}), ...(i.react ? { react: i.react } : {}) })) });
}

// ---------------- 2.3.16: the replies JSON never reaches him as text ----------------
// Abish, Nov 8 2026 (after a publish he got the literal {"replies":[{"to":[3],"text":"Site is live at …"}]}): the
// model sometimes writes the replies JSON where it is not read as a list — a job resumed after his YES (no messages
// of his in it), a scheduled job, a fenced ```json block, words before it, or broken JSON. Every final answer
// now passes through repliesToPlain before it is stored or sent, on every channel.

/** Take off a ```json … ``` fence around the whole answer (or the first fenced block when that is all of the JSON). */
function unfence(t) {
  const m = /^```[\w-]*\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(t);
  if (m) return m[1].trim();
  const f = /```(?:json)?\s*\n?(\{[\s\S]*?"replies"[\s\S]*?\}|\[[\s\S]*?\])\s*```/i.exec(t);
  return f ? f[1].trim() : t;
}
const REPLY_KEYS = /"(?:to|text|react|reaction|keep|reply|reply_to|answer)"\s*:/;
/** Does this answer look like the replies JSON (whole, fenced, wrapped in words, or broken)? */
export function looksLikeReplies(text) {
  const t = String(text || '');
  if (/[{,]\s*"replies"\s*:\s*\[/.test(t)) return true;
  return /^\s*(?:```[\w-]*\s*)?\[\s*\{/.test(t) && REPLY_KEYS.test(t);
}
/** The "text" values found in broken JSON (one per reply), unescaped. */
function scrapeTexts(t) {
  const out = [];
  for (const m of t.matchAll(/"(?:text|reply|answer)"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"?/g)) {
    let v = m[1];
    try { v = JSON.parse('"' + v.replace(/\n/g, '\\n').replace(/\r/g, '').replace(/\t/g, '\\t') + '"'); }
    catch { v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
    if (v.trim()) out.push(v.trim());
  }
  return out;
}
/**
 * An answer as plain words for him. Not the replies JSON → returned exactly as it is.
 * The replies JSON → its replies' words, one paragraph each (in order, duplicates dropped); words written
 * around the JSON are kept when the JSON itself has none. Returns { text, reacts, wasJson }.
 */
export function repliesToPlain(text) {
  const t = String(text ?? '');
  if (!looksLikeReplies(t)) return { text: t, reacts: [], wasJson: false };
  const parsed = parseReplies(t, 999);
  let texts = [], reacts = [];
  if (parsed) { texts = parsed.filter(r => r.text).map(r => r.text); reacts = parsed.filter(r => r.react).map(r => r.react); }
  else texts = scrapeTexts(t);
  texts = texts.filter((x, i) => texts.indexOf(x) === i);
  if (!texts.length) {
    // words outside the JSON (e.g. "Done! {…}"), else nothing (the caller treats that as no words)
    const outside = t.replace(/```[\w-]*/g, '').replace(/\{[\s\S]*\}|\[[\s\S]*\]/, '').trim();
    texts = outside && !/[{}[\]"]/.test(outside) ? [outside] : [];
  }
  return { text: texts.join('\n\n'), reacts, wasJson: true };
}
