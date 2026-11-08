// 2.3.17 (Abish, Nov 8 2026 1:26 AM, WhatsApp screenshot): his chat got the literal text
//   <|start|>assistant to=functions web searchcommentary json{" query":" SoftTech logo png site:github.com soft-tech.net"}<|call|>
// That is a tool call in the "harmony" format some open models (gpt-oss) write, returned by the key as plain words
// instead of a real tool call. Here such text is (1) read back into a real tool call where it can be, and
// (2) never let through to any chat. Pure text in, data out: no imports (unit-tested in test/v2317b.test.js).

// The format's own tokens, plus the two ways the address part looks once the tokens were stripped.
const TOKEN = /<\|(?:start|end|channel|message|call|constrain|return|im_start|im_end|im_sep)\|>/i;
const TO_FN = /\bto\s*=\s*(?:functions\s*[.:\s]|function\s*[.:]|browser\s*\.|python\b|container\s*\.)\s*[A-Za-z_]?/i;
const COMMENTARY_JSON = /\bcommentary\s*(?:<\|constrain\|>\s*)?(?:json)?\s*(?:<\|message\|>\s*)?\{/i;
const CHANNEL_WORD = /(?:^|<\|channel\|>|\|>)\s*(?:analysis|commentary|final)\s*(?:<\|message\|>)/i;

/** true = the text carries tool-call / channel markup that must never reach him. */
export function hasHarmony(text) {
  const t = String(text ?? '');
  if (!t) return false;
  return TOKEN.test(t) || TO_FN.test(t) || COMMENTARY_JSON.test(t) || CHANNEL_WORD.test(t);
}

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Names the model may write for a tool it was given under another name (gpt-oss's built-in "browser" tool).
const ALIASES = { search: 'web_search', websearch: 'web_search', browsersearch: 'web_search', googlesearch: 'web_search', searchweb: 'web_search',
  open: 'web_fetch', browseropen: 'web_fetch', fetch: 'web_fetch', webfetch: 'web_fetch', browserfetch: 'web_fetch', openurl: 'web_fetch', fetchurl: 'web_fetch' };

/** The real tool name for what the model wrote ("web search", "functions.web_search", "browser.search"), or null. */
export function toolNameFor(written, toolNames = []) {
  let w = String(written || '').trim().replace(/^functions?\s*[.:]\s*/i, '');
  w = w.replace(/(?:<\|[a-z_]+\|>|\s)*(?:commentary|analysis|final|json|code)?\s*$/i, '').replace(/(?:commentary|analysis|json)+$/i, '');
  const key = squash(w);
  if (!key) return null;
  const byKey = new Map(toolNames.map(n => [squash(n), n]));
  if (byKey.has(key)) return byKey.get(key);
  const alias = ALIASES[key];
  if (alias && toolNames.includes(alias)) return alias;
  return null;
}

/** The first balanced {...} starting at text[i] (strings respected), or null. */
function balanced(text, i) {
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(i, j + 1); }
  }
  return null;
}
// Tidy what such a model writes: " query":" SoftTech…" → query: "SoftTech…"
function tidyArgs(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out = {};
  for (const [k, v] of Object.entries(o)) out[String(k).trim()] = typeof v === 'string' ? v.trim() : v;
  return out;
}
function parseArgs(raw) {
  if (!raw) return null;
  try { return tidyArgs(JSON.parse(raw)); } catch {}
  try { return tidyArgs(JSON.parse(raw.replace(/,\s*}/g, '}').replace(/'/g, '"'))); } catch {}
  return null;
}

/**
 * Read harmony text back into real tool calls.
 * Returns { calls: [{name,args}], text, found } — found = the text had harmony markup at all; calls = the tool calls it
 * could read (only tools in toolNames); text = the words meant for him (a "final" channel message, or the plain words
 * around the markup), with every marker removed; unread = markup that named something it could not read.
 */
export function parseHarmony(text, toolNames = []) {
  const t = String(text ?? '');
  if (!hasHarmony(t)) return { found: false, calls: [], text: t, unread: 0 };
  const calls = []; let unread = 0; const cut = [];
  const re = /\bto\s*=\s*(functions?\s*[.:\s]\s*|browser\s*\.\s*|)([A-Za-z_][\w.\- ]{0,60}?)\s*(?=<\||\{|\bcommentary\b|\bjson\b|$)/gi;
  let m;
  while ((m = re.exec(t))) {
    const nameRaw = (m[1] && /browser/i.test(m[1]) ? 'browser.' : '') + m[2];
    const name = toolNameFor(nameRaw, toolNames);
    const at = t.indexOf('{', m.index + m[0].length);
    const stop = t.slice(m.index + m[0].length, at < 0 ? undefined : at);
    const raw = at >= 0 && !/\bto\s*=\s*functions?/i.test(stop) ? balanced(t, at) : null;
    const args = raw ? parseArgs(raw) : (/<\|call\|>/.test(stop) ? {} : null);
    if (name && args) calls.push({ name, args });
    else unread++;
    // the span to cut from his words: from the message's start (<|start|>, <|channel|>, "assistant") to the end of the call
    const before = t.slice(0, m.index);
    const opener = Math.max(before.lastIndexOf('<|start|>'), before.lastIndexOf('<|channel|>'), before.search(/(?:\bassistant\s*)?$/i));
    let end = raw ? at + raw.length : (at < 0 ? t.length : at);
    const tail = /^\s*(?:<\|(?:call|end|return)\|>)?/.exec(t.slice(end)); end += tail ? tail[0].length : 0;
    if (!raw && !/<\|call\|>/.test(stop)) end = Math.max(end, (() => { const k = t.indexOf('<|call|>', m.index); return k < 0 ? t.length : k + 8; })());
    cut.push([opener >= 0 && opener <= m.index ? opener : m.index, end]);
    re.lastIndex = Math.max(re.lastIndex, end);
  }
  // words for him: a final-channel message wins; else the plain words left once the markup is cut out
  let words = '';
  const fin = /<\|channel\|>\s*final\s*(?:<\|constrain\|>\s*\w+\s*)?<\|message\|>([\s\S]*?)(?=<\|(?:end|return|start|call)\|>|$)/i.exec(t);
  if (fin) words = fin[1];
  else {
    let w = '', from = 0;
    for (const [a, z] of cut.sort((x, y) => x[0] - y[0])) { if (a > from) w += t.slice(from, a); w += ' '; from = Math.max(from, z); }
    w += t.slice(from);
    words = w
      .replace(/<\|channel\|>\s*analysis[\s\S]*?(?:<\|end\|>|$)/gi, ' ')
      .replace(/<\|start\|>\s*assistant\b/gi, ' ')
      .replace(/<\|channel\|>\s*(?:commentary|final)\b/gi, ' ')
      .replace(/<\|[a-z_]+\|>/gi, ' ');
  }
  words = words.replace(/<\|[a-z_]+\|>/gi, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  if (hasHarmony(words)) words = '';
  return { found: true, calls, text: words, unread };
}

/** The last guard before words go to a chat: harmony markup never leaves. Returns { text, blocked }. */
export function withoutHarmony(text) {
  const t = String(text ?? '');
  if (!hasHarmony(t)) return { text: t, blocked: false };
  const p = parseHarmony(t, []);
  const rest = /[\p{L}\p{N}]{2}/u.test(p.text) ? p.text : '';
  return { text: rest, blocked: true };
}
