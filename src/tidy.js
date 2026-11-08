// 2.3.16: last checks on the assistant's final words before they reach him (Abish, Nov 8 2026).
// No imports: pure text in, text out (unit-tested in test/v2316.test.js).

const APPROVAL_LINE = /\b(?:approval|approve|approved|your ok|your okay|confirm|confirmation|reply\s+["“']?yes|say\s+["“']?yes|tap\s+approve|needs your ok)\b/i;
/**
 * The approval request message he already got is the one confirmation. A final answer that only repeats that
 * an approval is waiting is dropped ('' = say nothing more); sentences about the waiting approval are taken out of
 * a longer answer and the rest is kept. codes = the approval codes this job filed, like ['A2'].
 */
export function withoutApprovalEcho(text, codes = []) {
  const t = String(text || '');
  if (!codes.length || !t.trim()) return t;
  const codeRe = new RegExp('\\b(?:' + codes.map(c => String(c).replace(/[^A-Za-z0-9]/g, '')).join('|') + ')\\b', 'i');
  const about = (s) => codeRe.test(s) || (APPROVAL_LINE.test(s) && /\b(?:wait|waiting|pending|needs?|request|yes|tap|approve)\b/i.test(s));
  const out = [];
  for (const para of t.split(/\n/)) {
    if (!para.trim()) { out.push(para); continue; }
    const parts = para.split(/(?<=[.!?])\s+(?=\S)/);
    const kept = parts.filter(p => !about(p));
    if (kept.length) out.push(kept.join(' '));
  }
  const rest = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return /[\p{L}\p{N}]{3}/u.test(rest) ? rest : '';
}

const ASKED_CODE = /\b(?:code|source|html|css|javascript|js|script|snippet|markup|file content|show me (?:the )?(?:file|index))\b/i;
const CODE_BLOCK = /```[\w+-]*[ \t]*\n[\s\S]*?(?:\n```|$)/g;
const LOOKS_HTML = /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<style[\s>]|<script[\s>]/i;
/**
 * He reads on a phone and asked for pictures, not code ("Rather send a picture"). Unless his message asked for
 * code, a pasted page (or any code block longer than 12 lines) is taken out of the answer and replaced by one line.
 */
export function withoutPastedCode(text, ownerText = '') {
  const t = String(text || '');
  if (ASKED_CODE.test(String(ownerText || ''))) return t;
  let cut = false;
  let s = t.replace(CODE_BLOCK, (blk) => {
    if (LOOKS_HTML.test(blk) || blk.split('\n').length > 14) { cut = true; return '\n'; }
    return blk;
  });
  // an unfenced page pasted as text: from the first <!DOCTYPE/<html to the last closing tag
  if (LOOKS_HTML.test(s)) {
    const a = s.search(/<!doctype html|<html[\s>]|<head[\s>]|<style[\s>]|<body[\s>]|<script[\s>]/i);
    const endTags = [...s.matchAll(/<\/(?:html|body|style|script|head)>/gi)];
    const z = endTags.length ? endTags[endTags.length - 1].index + endTags[endTags.length - 1][0].length : s.length;
    if (a >= 0 && z > a) { s = s.slice(0, a) + '\n' + s.slice(z); cut = true; }
  }
  if (!cut) return t;
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return (s ? s + '\n\n' : '') + '(I left the code out of the chat. Say "send me the code" and I\'ll send it as a file.)';
}
