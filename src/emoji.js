// 2.3.5: a reply that opens (or ends) with a line holding only a status emoji like "✅" — the AI typing a reaction
// into its text instead of using the react tool. Pure helpers, no imports: used by the WhatsApp Agent outbound
// path (which moves the emoji onto his message as a real reaction), by the stored chat text, and by the web page.
//
// A "lone status-emoji line" is 1–2 of ✅ ☑️ ✔️ 👍 👌 ❤️ 🙏 😂 👀 🎉 🔥 (skin tones and the emoji variation mark allowed),
// optionally with spaces, and nothing else. Emoji inside a sentence ("Done ✅", "✅ Reminder set") are never touched.
const ONE = '(?:[\\u2705\\u2611\\u2714\\u2764]\\uFE0F?|(?:\\u{1F44D}|\\u{1F44C}|\\u{1F64F})[\\u{1F3FB}-\\u{1F3FF}]?\\uFE0F?|\\u{1F602}\\uFE0F?|\\u{1F440}\\uFE0F?|\\u{1F389}\\uFE0F?|\\u{1F525}\\uFE0F?)';
export const STATUS_EMOJI_LINE = new RegExp('^[ \\t\\u00A0]*(' + ONE + ')(?:[ \\t\\u00A0]*' + ONE + ')?[ \\t\\u00A0]*$', 'u');
const blank = (l) => !l.trim();

/** The single emoji to use as a reaction (adds the variation mark to ❤ ✔ ☑ so WhatsApp shows the emoji form). */
export function reactionForm(e) {
  const s = String(e || '');
  return /^[\u2764\u2714\u2611]$/.test(s) ? s + '\uFE0F' : s;
}

/**
 * Split a reply into its words and a lone status emoji.
 * Returns { text, emoji, where } where where is:
 *   ''      nothing to do (text unchanged, emoji ''),
 *   'lead'  a lone first line was removed (and the blank lines after it),
 *   'trail' a lone last line was removed (and the blank lines before it),
 *   'both'  both were removed (emoji = the first one),
 *   'only'  the whole reply is just that emoji: text is left as it was (never stripped to nothing).
 */
export function splitStatusEmoji(text) {
  const s = String(text ?? '');
  const none = { text: s, emoji: '', where: '' };
  if (!/[\u2705\u2611\u2714\u2764\u{1F44D}\u{1F44C}\u{1F64F}\u{1F602}\u{1F440}\u{1F389}\u{1F525}]/u.test(s)) return none;
  const lines = s.replace(/\r\n?/g, '\n').split('\n');
  let i = 0, j = lines.length - 1;
  while (i <= j && blank(lines[i])) i++;
  while (j >= i && blank(lines[j])) j--;
  if (i > j) return none;
  if (i === j) { const m = STATUS_EMOJI_LINE.exec(lines[i]); return m ? { text: s, emoji: reactionForm(m[1]), where: 'only' } : none; }
  let lead = '', trail = '';
  let m = STATUS_EMOJI_LINE.exec(lines[i]);
  if (m) { lead = reactionForm(m[1]); i++; while (i <= j && blank(lines[i])) i++; }
  if (i <= j && (m = STATUS_EMOJI_LINE.exec(lines[j]))) {
    if (i === j) { /* only one line of words would remain and it is itself an emoji line: the reply is emoji only */ }
    else { trail = reactionForm(m[1]); j--; while (j >= i && blank(lines[j])) j--; }
  }
  if (!lead && !trail) return none;
  const rest = lines.slice(i, j + 1);
  if (!rest.length || rest.every(blank) || (rest.length === 1 && STATUS_EMOJI_LINE.test(rest[0]))) return { text: s, emoji: lead || trail, where: 'only' };
  return { text: rest.join('\n'), emoji: lead || trail, where: lead && trail ? 'both' : lead ? 'lead' : 'trail' };
}

/** The words to keep (store / show): the stripped text, or the original when it is emoji only or untouched. */
export function withoutStatusEmoji(text) {
  const r = splitStatusEmoji(text);
  return r.where && r.where !== 'only' ? r.text : String(text ?? '');
}

/**
 * 2.3.15 (moved here from channels/waagent.js, same rules): one emoji, or '' (removes a reaction). Throws a short
 * plain-words error (kind 'bad_emoji') for anything that is not exactly one emoji.
 */
export function cleanEmoji(e) {
  const s = String(e ?? '').trim();
  if (!s) return '';
  if (s.length > 16 || /[\s<>"'`\\]/.test(s) || /^[\x20-\x7e]+$/.test(s)) throw Object.assign(new Error('Give one emoji, like 👍 ❤️ 😂 ✅ (or empty to remove the reaction).'), { kind: 'bad_emoji' });
  let n = 0; try { n = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length; } catch { n = 1; }
  if (n !== 1) throw Object.assign(new Error('Give exactly one emoji.'), { kind: 'bad_emoji' });
  return s;
}

/**
 * 2.3.15: the AI's way of saying "a reaction says it all, send no words": an empty answer or the marker NO_REPLY
 * (also "(no reply)", "[NO_REPLY]", "no_reply."). Anything with real words is a reply.
 */
export const NO_REPLY = 'NO_REPLY';
export function isNoReply(text) {
  const s = String(text ?? '').trim();
  return !s || /^[\[(]?\s*no[ _-]?reply\s*[\])]?\.?$/i.test(s);
}
