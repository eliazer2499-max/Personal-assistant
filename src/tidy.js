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

// ---------------- 2.3.17 (Abish, Nov 8 1:23 AM) ----------------
// (1) After his YES he already got "Published: <link>". A follow-up answer that only says it again is not sent.
// (2) He asked for "the design and the logo" and got "a logo placeholder". A placeholder is never the answer to a
//     logo/design request unless he asked for one.

const DONE_WORDS = new Set(('the a an your my his it its it\'s is are was has have been be now here there at on in to of for and ' +
  'site website page web app published publish live online up done ready successfully success approved approval request ' +
  'link url address you can see view visit open check out find go deployed sent pushed added created all set great ' +
  'perfect ok okay yes ✅ 🎉 👍 🚀 just this that').split(/\s+/));
/** true = the text adds nothing to the message he already got (`told`) — same links, only "it's live / done" words. */
export function restatesResult(text, told = '') {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/\?/.test(t)) return false;                                   // a question for him is new
  const toldUrls = new Set((String(told).match(/https?:\/\/[^\s)>\]]+/g) || []).map(u => u.replace(/[.,!]+$/, '').replace(/\/$/, '')));
  const urls = (t.match(/https?:\/\/[^\s)>\]]+/g) || []).map(u => u.replace(/[.,!]+$/, '').replace(/\/$/, ''));
  if (urls.some(u => !toldUrls.has(u))) return false;               // a new link is new
  const words = t.replace(/https?:\/\/[^\s)>\]]+/g, ' ').replace(/[*_`~"“”'’:;,.!()\[\]—–-]+/g, ' ').toLowerCase().split(/\s+/).filter(Boolean);
  const rest = words.filter(w => !DONE_WORDS.has(w) && !/^a\d+$/.test(w) && !String(told).toLowerCase().includes(w));
  return rest.length < 3;
}

const LOGO_OR_DESIGN = /\b(?:logo|logos|icon|branding|brand|design|redesign|re-design|new look|look nicer|make it (?:look )?(?:nice|beautiful|pretty|modern))\b/i;
const WANTS_PLACEHOLDER = /\bplace\s*-?\s*holders?\b|\bdummy\b|\bfor now\b|\btemporary\b|\blorem\b/i;
/** His words ask for a real logo or a design (and not for a placeholder). */
export function asksForDesign(ownerText = '') {
  const t = String(ownerText || '');
  return LOGO_OR_DESIGN.test(t) && !WANTS_PLACEHOLDER.test(t);
}
/** A placeholder where a logo should be: in a written file, or named in the answer. */
const PLACEHOLDER = /\blogo[\s_-]*(?:placeholder|here|goes here|coming soon)\b|\bplaceholder[\s_-]*(?:logo|image|icon|img)\b|\byour[\s_-]*logo\b|>\s*(?:LOGO|Logo)\s*<\/|class=["'][^"']*placeholder[^"']*["']|via\.placeholder\.com|placehold\.(?:co|it)|dummyimage\.com/i;
export function hasLogoPlaceholder(text = '') { return PLACEHOLDER.test(String(text || '')); }
export function mentionsPlaceholder(text = '') { return /\bplace\s*-?\s*holder/i.test(String(text || '')) || hasLogoPlaceholder(text); }
/** A file that is a real logo: an .svg with drawing in it (or a png/jpg the job made), not a box with "LOGO". */
export function isRealLogoFile(relPath = '', content = '') {
  const p = String(relPath || '').toLowerCase(), c = String(content || '');
  if (!/\.svg$/.test(p)) return false;
  if (!/<svg[\s>]/i.test(c) || hasLogoPlaceholder(c)) return false;
  const shapes = (c.match(/<(?:path|circle|ellipse|polygon|polyline|rect|line|text|g)\b/gi) || []).length;
  return shapes >= 2;
}
export const LOGO_NUDGE = '[System note] He asked for a real logo / design, and what you made is a placeholder (or no logo at all). Do not leave a placeholder. Make the actual logo now: write it yourself as an SVG file (for example logo.svg in the project) that matches the site\'s name and colours (a simple mark or monogram + the name, clean shapes, works small), put it in the page (header, and as the favicon), improve the design he asked for, take a phone-size site_screenshot, send him the picture with send_file, and say in 1–2 lines what you made.';
