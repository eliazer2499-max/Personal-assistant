// 2.3.1: reading the files the owner sends, with no dependencies (Node's own zlib).
// Word (.docx), Excel (.xlsx), PowerPoint (.pptx) and .zip are all zip archives; this reads them
// directly. Everything here is defensive: sizes are capped so a "zip bomb" cannot fill memory.
import zlib from 'node:zlib';

const MAX_ENTRY = 50 * 1024 * 1024;     // one unpacked file
export const xmlDecode = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10))).replace(/&amp;/g, '&');

/** The entries of a zip file (name, sizes, where the data is). */
export function zipEntries(buf) {
  if (!buf || buf.length < 22) throw new Error('not a zip file');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file (or it is damaged)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff || count === 0xffff) throw new Error('this zip is too big to open here (zip64)');
  const out = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    out.push({ name, method, csize, usize, off, encrypted: !!(flags & 1), dir: name.endsWith('/') });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
/** Unpack one entry. */
export function zipRead(buf, e, max = MAX_ENTRY) {
  if (e.encrypted) throw new Error('it is password-protected');
  if (e.usize > max) throw new Error('it is too big to unpack');
  if (e.off + 30 > buf.length || buf.readUInt32LE(e.off) !== 0x04034b50) throw new Error('the zip is damaged');
  const lnlen = buf.readUInt16LE(e.off + 26), lxlen = buf.readUInt16LE(e.off + 28);
  const start = e.off + 30 + lnlen + lxlen;
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) return data;
  if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: max });
  throw new Error('it uses a compression this app cannot unpack');
}
function entryText(buf, entries, name) {
  const e = entries.find(x => x.name === name);
  return e ? zipRead(buf, e).toString('utf8') : null;
}

/** Word .docx → plain text. */
export function docxText(buf) {
  let entries; try { entries = zipEntries(buf); } catch { throw new Error('not a .docx (zip) file'); }
  const xml = entryText(buf, entries, 'word/document.xml');
  if (xml == null) throw new Error('no text found in the .docx');
  return xmlDecode(xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>|<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
}

/** PowerPoint .pptx → the text of each slide. */
export function pptxText(buf) {
  const entries = zipEntries(buf);
  const slides = entries.filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a, b) => parseInt(a.name.match(/\d+/)[0], 10) - parseInt(b.name.match(/\d+/)[0], 10));
  if (!slides.length) throw new Error('no slides found');
  return slides.map((e, i) => {
    const xml = zipRead(buf, e).toString('utf8');
    const t = xml.replace(/<\/a:p>/g, '\n').replace(/<a:br\/>/g, '\n').replace(/<(?!\/?a:t\b)[^>]+>/g, '').replace(/<\/?a:t\b[^>]*>/g, '');
    return `Slide ${i + 1}:\n` + xmlDecode(t).replace(/\n{2,}/g, '\n').trim();
  }).join('\n\n');
}

// ---------- tables (Excel and CSV) ----------
const colIndex = (ref) => { const m = /^([A-Z]+)/.exec(ref || ''); if (!m) return -1; let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
function cellText(s) { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > 80 ? s.slice(0, 79) + '…' : s; }
/** A table (array of rows) → a short readable summary for the model. */
export function tableSummary(rows, { title, maxRows = 60, maxChars = 16000 } = {}) {
  rows = rows.filter(r => r.some(c => String(c ?? '').trim() !== ''));
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const lines = [`${title}: ${rows.length} row${rows.length === 1 ? '' : 's'} × ${cols} column${cols === 1 ? '' : 's'}`];
  if (!rows.length) return lines[0] + ' (empty)';
  lines.push('Columns (first row): ' + rows[0].map(cellText).join(' | '));
  let used = lines.join('\n').length, shown = 0;
  for (let i = 1; i < rows.length && shown < maxRows; i++) {
    const l = `${i + 1}: ` + rows[i].map(cellText).join(' | ');
    if (used + l.length > maxChars) break;
    lines.push(l); used += l.length + 1; shown++;
  }
  if (shown < rows.length - 1) lines.push(`…(showing ${shown} of ${rows.length - 1} data rows)`);
  return lines.join('\n');
}

/** Excel .xlsx → a summary of each sheet (name, size, header, first rows). */
export function xlsxSummary(buf, opts = {}) {
  const entries = zipEntries(buf);
  const wb = entryText(buf, entries, 'xl/workbook.xml');
  if (wb == null) throw new Error('not an Excel .xlsx file');
  const rels = entryText(buf, entries, 'xl/_rels/workbook.xml.rels') || '';
  const target = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1], t = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && t) target[id] = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
  }
  const shared = [];
  const ss = entryText(buf, entries, 'xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(xmlDecode([...m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
  // which cell styles are dates (so 46297 shows as 2026-10-02)
  const dateStyle = new Set();
  const styles = entryText(buf, entries, 'xl/styles.xml');
  if (styles) {
    const custom = {};
    for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) { const id = /numFmtId="(\d+)"/.exec(m[0])?.[1], code = xmlDecode(/formatCode="([^"]*)"/.exec(m[0])?.[1] || ''); if (id) custom[id] = code; }
    const isDate = (id) => (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (custom[id] !== undefined && /(^|[^\\"])[dmyhs]/i.test(custom[id].replace(/"[^"]*"|\[[^\]]*\]/g, '')) && !/^[#0.,%\s]*$/.test(custom[id]));
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] || '';
    [...xfs.matchAll(/<xf\b[^>]*>/g)].forEach((m, i) => { const id = parseInt(/numFmtId="(\d+)"/.exec(m[0])?.[1] || '0', 10); if (isDate(id)) dateStyle.add(String(i)); });
  }
  const serialDate = (v) => {
    const n = parseFloat(v); if (!isFinite(n) || n < 1 || n > 2958465) return v;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
    const iso = d.toISOString();
    return n % 1 ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10);
  };
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map(m => ({ name: xmlDecode(/\bname="([^"]*)"/.exec(m[0])?.[1] || 'Sheet'), rid: /\br:id="([^"]+)"/.exec(m[0])?.[1] }));
  const out = [];
  const maxSheets = 8;
  sheets.slice(0, maxSheets).forEach((s, i) => {
    const file = target[s.rid] || `xl/worksheets/sheet${i + 1}.xml`;
    const xml = entryText(buf, entries, file);
    if (xml == null) { out.push(`Sheet "${s.name}": (could not be read)`); return; }
    const rows = [];
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rnum = parseInt(/\br="(\d+)"/.exec(rm[1])?.[1] || String(rows.length + 1), 10) - 1;
      const row = [];
      for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1], inner = cm[2] || '';
        let ci = colIndex(/\br="([A-Z]+)\d*"/.exec(attrs)?.[1]); if (ci < 0) ci = row.length;
        const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let val = '';
        if (t === 's') val = shared[parseInt(v, 10)] ?? '';
        else if (t === 'inlineStr') val = xmlDecode([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else val = v != null ? xmlDecode(v) : '';
        if ((!t || t === 'n') && v != null && dateStyle.has(/\bs="(\d+)"/.exec(attrs)?.[1])) val = serialDate(val);
        if (ci < 200) row[ci] = val;
      }
      if (rnum < 1048576) rows[rnum] = Array.from(row, x => x ?? '');
      if (rows.length > 100000) break;
    }
    out.push(tableSummary(Array.from(rows, r => r || []), { title: `Sheet "${s.name}"`, maxRows: opts.maxRows || 60, maxChars: Math.floor((opts.maxChars || 30000) / Math.min(sheets.length, maxSheets)) }));
  });
  if (sheets.length > maxSheets) out.push(`…and ${sheets.length - maxSheets} more sheets not shown`);
  if (!styles) out.push('(Dates may show as Excel day numbers, e.g. 45500 = 2024-07-28.)');
  return { sheets: sheets.length, text: out.join('\n\n') };
}

/** CSV / TSV text → rows. Handles quotes; guesses the separator from the first line. */
export function parseCsv(text) {
  text = String(text).replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const sep = [',', ';', '\t', '|'].map(c => [c, first.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"' && cell === '') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; if (rows.length > 200000) break; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
export function csvSummary(text, name = 'file.csv') { return tableSummary(parseCsv(text), { title: `Table "${name}"`, maxRows: 120, maxChars: 30000 }); }

// ---------- zip ----------
const TEXTY = /\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|php|java|kt|kts|swift|go|rs|c|h|cc|cpp|hpp|cs|sh|bash|zsh|ps1|bat|sql|ya?ml|toml|ini|cfg|conf|env\.example|gradle|properties|log|svg|vue|svelte|dart|lua|r|pl|scala|gitignore|dockerfile|makefile)$/i;
const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
/** .zip → list of files, plus the text of small text files inside (as far as room allows). */
export function zipSummary(buf, name = 'archive.zip', { maxList = 200, perFile = 20000, total = 60000 } = {}) {
  const entries = zipEntries(buf);
  const files = entries.filter(e => !e.dir);
  const lines = [`Zip "${name}": ${files.length} file${files.length === 1 ? '' : 's'}, ${fmtSize(files.reduce((s, e) => s + e.usize, 0))} unpacked`];
  for (const e of files.slice(0, maxList)) lines.push(`- ${e.name} (${fmtSize(e.usize)})${e.encrypted ? ' [password-protected]' : ''}`);
  if (files.length > maxList) lines.push(`…and ${files.length - maxList} more`);
  let used = 0; const shown = [];
  for (const e of files) {
    if (!TEXTY.test(e.name.split('/').pop()) && !/(^|\/)(Dockerfile|Makefile|README|LICENSE)$/i.test(e.name)) continue;
    if (e.encrypted || e.usize > perFile || used + e.usize > total || /(^|\/)(node_modules|\.git|__MACOSX)\//.test(e.name)) continue;
    try {
      const t = zipRead(buf, e, perFile + 1).toString('utf8');
      if (t.includes('\u0000')) continue;
      shown.push(`--- ${e.name} ---\n${t}`); used += t.length;
    } catch {}
  }
  if (shown.length) lines.push('', `Text of ${shown.length} small file${shown.length === 1 ? '' : 's'} inside:`, ...shown);
  return lines.join('\n');
}
