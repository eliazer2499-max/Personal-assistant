// 2.3.16: the assistant's replies in the web chat show their formatting (**bold**, lists, links, code)
// instead of the raw ** and # signs. Abish, Nov 8 2026: "when it returns a message with text in bold it
// shows there **message but on WhatsApp its good".
//
// Safe by construction: ALL of the text is HTML-escaped first, so no tag, attribute or entity from the
// message can survive; only the tags this file writes itself (strong, em, code, pre, ul/ol/li, p, br,
// a, del, blockquote, hr, table, div.mdh) appear in the result. Links are made only for http:, https:
// and mailto: addresses, and always open in a new tab with rel="noopener noreferrer nofollow".
// No imports, no DOM: the same file runs in the browser and in the tests (node).

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ESC[c]); }
const UNESC = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const unescapeHtml = s => s.replace(/&(?:amp|lt|gt|quot|#39);/g, m => UNESC[m]);

// placeholder marks (\u0001…\u0002); they are removed from the input first so a message can't fake one
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const PH = /\u0001(\d+)\u0002/g;

/** An address we are willing to link to (after the text was escaped). */
export function safeUrl(escapedUrl) {
  const raw = unescapeHtml(String(escapedUrl)).trim();
  if (!/^(?:https?:\/\/[^\s/?#]+|mailto:[^\s@]+@[^\s@]+)/i.test(raw)) return null;
  return raw;
}
function anchor(rawUrl, labelHtml) {
  return '<a href="' + escapeHtml(rawUrl) + '" target="_blank" rel="noopener noreferrer nofollow">' + labelHtml + '</a>';
}
// a bare address: stops at a space or at an escaped < > " ' ; a closing bracket or end punctuation is not part of it
const BARE = /\b(?:https?:\/\/|www\.)(?:(?!&lt;|&gt;|&quot;|&#39;)[^\s\u0001\u0002])+/gi;
function trimUrl(u) {
  let tail = '';
  for (;;) {
    const m = u.match(/(?:[.,;:!?*_~]|&amp;|\))$/);
    if (!m) break;
    if (m[0] === ')' && (u.split('(').length > u.split(')').length - 1)) break;   // "(…)" inside the address stays
    tail = m[0] + tail; u = u.slice(0, -m[0].length);
  }
  return [u, tail];
}

/** Inline formatting of one escaped line. */
function inline(s, keep) {
  const put = html => { keep.push(html); return '\u0001' + (keep.length - 1) + '\u0002'; };
  // `code` first: nothing inside it is formatted
  s = s.replace(/(`+)([^`\n]+?)\1(?!`)/g, (_, _t, c) => put('<code>' + c + '</code>'));
  // [label](address)
  s = s.replace(/\[([^\]\n]{1,300})\]\(\s*((?:(?!&lt;|&gt;|&quot;)[^\s)])+(?:\([^\s)]*\))?)\s*\)/g, (m, label, url) => {
    const u = safeUrl(url);
    return u ? put(anchor(u, emph(label))) : m;     // anything else (javascript:, data:, …) stays as plain text
  });
  // bare https://… and www.… addresses
  s = s.replace(BARE, m => {
    const [u, tail] = trimUrl(m);
    const href = /^www\./i.test(u) ? 'https://' + unescapeHtml(u) : safeUrl(u);
    if (!href || u.length < 8) return m;
    return put(anchor(href, u)) + tail;
  });
  // bare e-mail addresses → mailto
  s = s.replace(/(^|[\s(])([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![\w@])/g, (m, pre, mail) => pre + put(anchor('mailto:' + mail, mail)));
  return emph(s);
}
/** bold / italic / strike (on escaped text). */
function emph(s) {
  s = s.replace(/\*\*\*(?=\S)([^*\n]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<del>$1</del>');
  return s;
}

const LIST_UL = /^( *)[-*+•·] +(.*)$/;
const LIST_OL = /^( *)(\d{1,4})[.)] +(.*)$/;
const TABLE_SEP = /^ *\|? *:?-{2,}:? *(?:\| *:?-{2,}:? *)*\|? *$/;
const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

/** Markdown text → safe HTML for an assistant bubble. */
export function renderMarkdown(text) {
  let src = String(text ?? '').replace(/\r\n?/g, '\n').replace(CTRL, '');
  const keep = [];
  const put = html => { keep.push(html); return '\u0001' + (keep.length - 1) + '\u0002'; };
  // ``` code blocks ``` (an unclosed one runs to the end), taken out before anything else
  src = src.replace(/(^|\n)[ \t]*```[^\n`]*\n([\s\S]*?)(?:\n[ \t]*```[ \t]*(?=\n|$)|$)/g, (_, pre, code) =>
    pre + put('<pre><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>'));
  // a one-line ```code``` too
  src = src.replace(/```([^`\n]+)```/g, (_, c) => put('<code>' + escapeHtml(c) + '</code>'));

  const lines = escapeHtml(src).split('\n');
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push('<p>' + para.map(l => inline(l, keep)).join('<br>') + '</p>'); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { flush(); continue; }
    if (/^\u0001\d+\u0002$/.test(t) && keep[+t.slice(1, -1)].startsWith('<pre>')) { flush(); out.push(t); continue; }
    let m;
    if ((m = t.match(/^(#{1,6}) +(.+?)(?: +#+)?$/))) { flush(); out.push('<div class="mdh mdh' + m[1].length + '">' + inline(m[2].replace(/^\*\*(.*)\*\*$/, '$1'), keep) + '</div>'); continue; }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(t.replace(/ /g, ''))) { flush(); out.push('<hr>'); continue; }
    if (t.startsWith('&gt;')) {                       // > quoted lines
      flush(); const q = [];
      while (i < lines.length && lines[i].trim().startsWith('&gt;')) q.push(lines[i++].trim().replace(/^&gt; ?/, ''));
      i--; out.push('<blockquote>' + q.map(l => inline(l, keep)).join('<br>') + '</blockquote>'); continue;
    }
    if (t.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-') && lines[i + 1].includes('|')) {   // | a | b | tables
      flush(); const head = cells(t); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      i--;
      out.push('<div class="mdtable"><table><thead><tr>' + head.map(c => '<th>' + inline(c, keep) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + head.map((_, k) => '<td>' + inline(r[k] || '', keep) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (LIST_UL.test(line) || LIST_OL.test(line)) {    // lists (one level of nesting by indent)
      flush();
      const stack = [];                                 // {tag, indent}
      let html = '';
      const open = (tag, indent, start) => { stack.push({ tag, indent }); html += '<' + tag + (tag === 'ol' && start && start !== '1' ? ' start="' + Number(start) + '"' : '') + '>'; };
      const close = () => { html += '</li></' + stack.pop().tag + '>'; };
      let first = true;
      while (i < lines.length) {
        const l = lines[i];
        const u = l.match(LIST_UL), o = l.match(LIST_OL);
        if (!u && !o) {
          // a plain line indented under an item continues it; anything else ends the list
          if (l.trim() && /^ {2,}/.test(l) && stack.length) { html += '<br>' + inline(l.trim(), keep); i++; continue; }
          break;
        }
        const indent = (u || o)[1].length, tag = u ? 'ul' : 'ol', body = u ? u[2] : o[3];
        if (first) { open(tag, indent, o && o[2]); first = false; }
        else {
          let top = stack[stack.length - 1];
          if (indent > top.indent + 1 && stack.length < 3) { open(tag, indent, o && o[2]); }
          else {
            while (stack.length > 1 && indent < top.indent) { close(); top = stack[stack.length - 1]; }
            if (top.tag !== tag && indent <= top.indent) { html += '</li></' + stack.pop().tag + '>'; open(tag, indent, o && o[2]); }
            else html += '</li>';
          }
        }
        html += '<li>' + inline(body, keep);
        i++;
        if (i < lines.length && !lines[i].trim() && i + 1 < lines.length && (LIST_UL.test(lines[i + 1]) || LIST_OL.test(lines[i + 1]))) i++;   // a blank line between items
      }
      while (stack.length) close();
      i--; out.push(html); continue;
    }
    para.push(t === line ? line : line.replace(/^ +/, ''));
  }
  flush();
  // put the kept pieces back (twice: a kept link label can hold kept code)
  let html = out.join('');
  for (let k = 0; k < 3 && PH.test(html); k++) { PH.lastIndex = 0; html = html.replace(PH, (_, n) => keep[+n] ?? ''); }
  return html;
}

/** Markdown text → one plain line for previews (chat list, quotes, job cards): the signs are taken off, not drawn. */
export function stripMarkdown(text) {
  let s = String(text ?? '').replace(/\r\n?/g, '\n').replace(CTRL, '');
  s = s.replace(/```[^\n`]*\n?([\s\S]*?)(?:```|$)/g, '$1');
  s = s.replace(/`+([^`\n]+?)`+/g, '$1');
  s = s.replace(/!?\[([^\]\n]*)\]\(\s*[^\s)]*\s*\)/g, '$1');
  s = s.replace(/^ *#{1,6} +/gm, '').replace(/^ *> ?/gm, '');
  s = s.replace(/^ *[-*+•] +/gm, '• ');
  s = s.replace(/^ *(?:-{3,}|\*{3,}|_{3,}) *$/gm, '');
  s = s.replace(/^ *\|?(?: *:?-{2,}:? *\|?)+ *$/gm, '');
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1').replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1$2');
  s = s.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1$2').replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1$2');
  s = s.replace(/~~(?=\S)([^~\n]*?\S)~~/g, '$1');
  return s;
}
/** stripMarkdown on one line, spaces folded (for the chat list and quotes). */
export function previewText(text, max) {
  const s = stripMarkdown(text).replace(/\s+/g, ' ').trim();
  return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
}
