// Attachments: photos, voice notes and files the owner sends in chat.
// Stored under <dataDir>/files/<random id>, owner-only download, passed to the model inline.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { cfg } from './config.js';
import { all, get, run, now } from './db.js';
import { docxText, pptxText, xlsxSummary, csvSummary, zipSummary } from './extract.js';
export { docxText };

export const MAX_FILE = 20 * 1024 * 1024;           // one upload
export const MAX_INLINE = 18 * 1024 * 1024;         // all media in one model request (Gemini allows ~20 MB)

// mime -> kind. Anything else is refused.
const TYPES = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image', 'image/heic': 'image', 'image/heif': 'image',
  'audio/wav': 'audio', 'audio/x-wav': 'audio', 'audio/wave': 'audio', 'audio/webm': 'audio', 'audio/ogg': 'audio', 'audio/mp4': 'audio', 'audio/mpeg': 'audio',
  'audio/mp3': 'audio', 'audio/aac': 'audio', 'audio/x-m4a': 'audio', 'audio/m4a': 'audio', 'audio/flac': 'audio', 'audio/opus': 'audio',
  'application/pdf': 'pdf',
  'text/plain': 'text', 'text/markdown': 'text', 'text/csv': 'text', 'application/json': 'text', 'text/html': 'text', 'text/xml': 'text', 'application/xml': 'text',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  // 2.3.1: Excel, PowerPoint and zip are read too (text and tables are extracted on the server)
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip',
};
const BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif',
  '.wav': 'audio/wav', '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.log': 'text/plain',
  '.html': 'text/html', '.htm': 'text/html', '.xml': 'text/xml', '.js': 'text/plain', '.py': 'text/plain', '.sh': 'text/plain', '.yml': 'text/plain', '.yaml': 'text/plain',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.tsv': 'text/csv', '.markdown': 'text/markdown',
};
// 2.3.1: code and config files are read as text.
for (const e of ['ts', 'tsx', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'java', 'kt', 'kts', 'swift', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sql',
  'toml', 'ini', 'cfg', 'conf', 'properties', 'gradle', 'dart', 'lua', 'r', 'pl', 'scala', 'vue', 'svelte', 'bat', 'ps1', 'bash', 'zsh', 'srt', 'vtt', 'tex', 'rtf'])
  BY_EXT['.' + e] = 'text/plain';
// Formats that look readable but are not (yet): a clear answer instead of a generic one.
const NOT_READ = { '.doc': 'Old Word .doc files can\'t be read here. Save it as .docx or PDF and send it again.',
  '.xls': 'Old Excel .xls files can\'t be read here. Save it as .xlsx or CSV and send it again.',
  '.ppt': 'Old PowerPoint .ppt files can\'t be read here. Save it as .pptx or PDF and send it again.',
  '.rar': 'RAR archives can\'t be opened here. Send it as a .zip.', '.7z': '7-Zip archives can\'t be opened here. Send it as a .zip.' };
export const SUPPORTED_TEXT = 'Photos, voice notes, PDF, Word, Excel, PowerPoint, CSV, text/code files and .zip work.';
// Shown inline in the browser; everything else downloads.
const INLINE_OK = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'audio/wav', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/flac', 'application/pdf', 'text/plain', 'video/mp4', 'video/webm', 'video/quicktime']);

const dir = () => path.join(cfg.dataDir, 'files');
const err = (status, message) => Object.assign(new Error(message), { status });

/** Normalise what the browser said into one allowed mime type (or throw 415). */
export function pickMime(declared, name) {
  let m = String(declared || '').toLowerCase().split(';')[0].trim();
  if (m === 'audio/x-wav' || m === 'audio/wave') m = 'audio/wav';
  if (m === 'audio/x-m4a' || m === 'audio/m4a') m = 'audio/mp4';
  if (m === 'audio/mp3') m = 'audio/mpeg';
  if (m === 'video/webm') m = 'audio/webm';       // some browsers label audio-only recordings as video
  if (m === 'video/mp4' && /voice/i.test(name || '')) m = 'audio/mp4';
  if (m === 'application/x-zip-compressed' || m === 'application/x-zip') m = 'application/zip';
  if (m === 'text/tab-separated-values') m = 'text/csv';
  const ext = path.extname(String(name || '')).toLowerCase();
  if (NOT_READ[ext]) throw err(415, NOT_READ[ext]);
  if (!TYPES[m]) m = BY_EXT[ext] || m;
  if (!TYPES[m] && (/^text\//.test(m) || /^application\/(javascript|x-javascript|x-sh|x-python|x-yaml|yaml|sql|x-httpd-php|toml)$/.test(m))) m = 'text/plain';
  if (!TYPES[m]) throw err(415, 'I can\'t read that type of file' + (ext ? ` (${ext})` : '') + '. ' + SUPPORTED_TEXT);
  return m;
}
export function safeName(name) {
  const n = String(name || 'file').replace(/[\\/\x00-\x1f"<>|:*?]+/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return n || 'file';
}

export function saveUpload(buf, declaredMime, name, chatId) {
  if (!buf || !buf.length) throw err(400, 'Empty file');
  if (buf.length > MAX_FILE) throw err(413, 'File too large (max 20 MB)');
  const fname = safeName(name);
  const mime = pickMime(declaredMime, fname);
  const kind = TYPES[mime];
  if (kind === 'image' && !looksLikeImage(buf)) throw err(415, 'That does not look like an image.');
  if (kind === 'pdf' && buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw err(415, 'That does not look like a PDF.');
  if (['docx', 'xlsx', 'pptx', 'zip'].includes(kind) && buf.subarray(0, 2).toString('latin1') !== 'PK') throw err(415, 'That file looks damaged (it is not a real ' + (kind === 'zip' ? '.zip' : '.' + kind) + ' file).');
  if (kind === 'text' && buf.subarray(0, 8192).includes(0)) throw err(415, 'That does not look like a text file.');
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir(), id), buf, { mode: 0o600 });
  run('INSERT INTO files(id,name,mime,size,kind,created,chat_id,message_id) VALUES(?,?,?,?,?,?,?,NULL)', id, fname, mime, buf.length, kind, now(), chatId || null);
  return publicFile(get('SELECT * FROM files WHERE id=?', id));
}
function looksLikeImage(b) {
  const h = b.subarray(0, 12);
  return (h[0] === 0xff && h[1] === 0xd8) || h.subarray(0, 4).toString('hex') === '89504e47' || h.subarray(0, 4).toString('latin1') === 'GIF8'
    || (h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP') || h.subarray(4, 8).toString('latin1') === 'ftyp';
}
/** A file the assistant made (e.g. a picture), shown in chat under its message. */
export function saveGenerated(buf, mime, name, chatId, messageId) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir(), id), buf, { mode: 0o600 });
  run('INSERT INTO files(id,name,mime,size,kind,created,chat_id,message_id) VALUES(?,?,?,?,?,?,?,?)', id, safeName(name), mime, buf.length, TYPES[mime] || outKind(mime), now(), chatId || null, messageId || null);
  return publicFile(get('SELECT * FROM files WHERE id=?', id));
}

// ---------- 2.3.1: files the assistant sends to the owner (send_file) ----------
export const MAX_SEND = 50 * 1024 * 1024;           // into the web chat
const OUT_EXT = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.3gp': 'video/3gpp', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.apk': 'application/vnd.android.package-archive', '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.tar': 'application/x-tar', '.gz': 'application/gzip', '.tgz': 'application/gzip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.epub': 'application/epub+zip', '.ics': 'text/calendar', '.vcf': 'text/vcard', '.webm': 'video/webm' };
/** The type of a file the assistant sends, from its name (the content is not trusted for display: see server.js). */
export function outMime(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return OUT_EXT[ext] || BY_EXT[ext] || 'application/octet-stream';
}
export function outKind(mime) {
  if (/^image\/(jpeg|png|webp|gif)$/.test(mime)) return 'image';
  if (/^audio\//.test(mime)) return 'audio';
  if (/^video\//.test(mime)) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  return TYPES[mime] && TYPES[mime] !== 'image' ? TYPES[mime] : 'file';
}
/** Copy a file the assistant is sending into the chat's file store, under its message. */
export function saveOutgoing(buf, name, chatId, messageId) {
  const fname = safeName(name);
  let mime = outMime(fname);
  if (/^image\//.test(mime) && mime !== 'image/svg+xml' && !looksLikeImage(buf)) mime = 'application/octet-stream';   // never show a non-image as one
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir(), id), buf, { mode: 0o600 });
  run('INSERT INTO files(id,name,mime,size,kind,created,chat_id,message_id) VALUES(?,?,?,?,?,?,?,?)', id, fname, mime, buf.length, outKind(mime), now(), chatId || null, messageId || null);
  return get('SELECT * FROM files WHERE id=?', id);
}
export const publicFile = (f) => f ? { id: f.id, name: f.name, mime: f.mime, size: f.size, kind: f.kind } : null;
export function fileRow(id) { return /^[a-f0-9]{32}$/.test(String(id || '')) ? get('SELECT * FROM files WHERE id=?', String(id)) || null : null; }
export function filesOfMessage(messageId) { return all('SELECT * FROM files WHERE message_id=? ORDER BY created', messageId); }
export function filesForMessages(ids) {
  if (!ids.length) return {};
  const o = {};
  for (const f of all(`SELECT * FROM files WHERE message_id IN (${ids.map(Number).join(',')}) ORDER BY created`)) (o[f.message_id] ||= []).push(publicFile(f));
  return o;
}
/** Files the owner uploaded but has not sent yet; only those can be attached to a new message. */
export function claimFiles(ids, messageId, chatId) {
  const out = [];
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, 10)) {
    const f = fileRow(id);
    if (!f) throw err(400, 'An attachment is missing. Attach it again.');
    if (f.message_id) throw err(400, 'That attachment was already sent.');
    run('UPDATE files SET message_id=?, chat_id=? WHERE id=?', messageId, chatId, f.id);
    out.push(f);
  }
  return out;
}
export function validateUnsent(ids) {
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, 10)) {
    const f = fileRow(id);
    if (!f) throw err(400, 'An attachment is missing. Attach it again.');
    if (f.message_id) throw err(400, 'That attachment was already sent.');
  }
}
export function filePath(f) { return path.join(dir(), f.id); }
export function inlineOk(mime) { return INLINE_OK.has(mime); }

function removeRow(f) { try { fs.rmSync(filePath(f), { force: true }); } catch {} run('DELETE FROM files WHERE id=?', f.id); }
export function removeFilesOfChat(chatId) { for (const f of all('SELECT * FROM files WHERE chat_id=?', chatId)) removeRow(f); }
/** Uploads never sent within a day are removed. */
export function purgeUnsent(maxAgeMs = 24 * 3600 * 1000) {
  const rows = all('SELECT * FROM files WHERE message_id IS NULL AND created < ?', now() - maxAgeMs);
  for (const f of rows) removeRow(f);
  return rows.length;
}

// ---------- turning files into model input ----------
const TEXT_MAX = 120000;
/**
 * Model input for a message's files.
 * Returns { media: [{ mime, data(base64), name, kind }], text: '…extra text for the prompt…', bytes }.
 * budget: how many inline bytes may still be used; files beyond it become a short note.
 */
export function modelInput(files, budget = MAX_INLINE) {
  const media = []; const notes = []; let bytes = 0;
  for (const f of files) {
    const label = f.kind === 'audio' ? 'voice note / audio' : f.kind;
    let buf;
    try { buf = fs.readFileSync(filePath(f)); } catch { notes.push(`[Attachment "${f.name}" is no longer on the server]`); continue; }
    if (f.kind === 'text' && f.mime === 'text/csv') {
      const t = buf.toString('utf8');
      notes.push(`[Table file "${f.name}" (CSV), summary:]\n${csvSummary(t, f.name)}` + (t.length <= 20000 ? `\n\n[Whole file:]\n${t}` : ''));
    } else if (f.kind === 'xlsx') {
      try { const s = xlsxSummary(buf); notes.push(`[Excel file "${f.name}", ${s.sheets} sheet${s.sheets === 1 ? '' : 's'}:]\n${s.text}`); }
      catch (e) { notes.push(`[Excel file "${f.name}" could not be read: ${e.message}]`); }
    } else if (f.kind === 'pptx') {
      try { const t = pptxText(buf); notes.push(`[PowerPoint file "${f.name}"]\n${t.slice(0, TEXT_MAX)}${t.length > TEXT_MAX ? '\n…(cut, file is longer)' : ''}`); }
      catch (e) { notes.push(`[PowerPoint file "${f.name}" could not be read: ${e.message}]`); }
    } else if (f.kind === 'zip') {
      try { notes.push(`[${zipSummary(buf, f.name)}]`); }
      catch (e) { notes.push(`[Zip file "${f.name}" could not be opened: ${e.message}]`); }
    } else if (f.kind === 'text') {
      const t = buf.toString('utf8');
      notes.push(`[File "${f.name}"]\n${t.slice(0, TEXT_MAX)}${t.length > TEXT_MAX ? '\n…(cut, file is longer)' : ''}`);
    } else if (f.kind === 'docx') {
      try { const t = docxText(buf); notes.push(`[Word file "${f.name}"]\n${t.slice(0, TEXT_MAX)}${t.length > TEXT_MAX ? '\n…(cut, file is longer)' : ''}`); }
      catch (e) { notes.push(`[Word file "${f.name}" could not be read: ${e.message}]`); }
    } else if (!['image', 'audio', 'pdf'].includes(f.kind)) {
      notes.push(`[File "${f.name}" (${f.mime}, ${Math.round(f.size / 1024)} KB): this type can't be read here.]`);
    } else if (bytes + buf.length <= budget) {
      media.push({ mime: f.mime, data: buf.toString('base64'), name: f.name, kind: f.kind });
      bytes += buf.length;
    } else notes.push(`[Earlier ${label} "${f.name}" left out: too much media in one request]`);
  }
  return { media, text: notes.join('\n\n'), bytes };
}

// Voice-note waveform for the chat player: duration + 40 bar heights (0..1), from a PCM WAV file.
// Other audio formats get { duration: null, peaks: null } and the browser draws a neutral waveform.
const WAVE_CACHE = new Map();
export const WAVE_BARS = 40;
export function wavSummary(buf, bars = WAVE_BARS) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let o = 12, fmt = null, data = null;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4), size = buf.readUInt32LE(o + 4), body = o + 8;
    if (id === 'fmt ' && size >= 16) fmt = { format: buf.readUInt16LE(body), ch: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), byteRate: buf.readUInt32LE(body + 8), bits: buf.readUInt16LE(body + 14) };
    else if (id === 'data') { data = { start: body, len: Math.min(size, buf.length - body) }; break; }
    o = body + size + (size & 1);
  }
  if (!fmt || !data || !fmt.byteRate) return null;
  const duration = Math.round(data.len / fmt.byteRate * 100) / 100;
  if (fmt.format !== 1 || fmt.bits !== 16 || !fmt.ch) return { duration, peaks: null };
  const frame = 2 * fmt.ch, n = Math.floor(data.len / frame), per = Math.max(1, Math.floor(n / bars)), raw = [];
  for (let b = 0; b < bars; b++) {
    let sum = 0, cnt = 0;
    const from = b * per, to = Math.min(n, from + per), step = Math.max(1, Math.floor((to - from) / 400));
    for (let i = from; i < to; i += step) { const v = buf.readInt16LE(data.start + i * frame) / 32768; sum += v * v; cnt++; }
    raw.push(cnt ? Math.sqrt(sum / cnt) : 0);
  }
  const max = Math.max(...raw, 1e-6);
  return { duration, peaks: raw.map(v => Math.round(Math.min(1, v / max) * 100) / 100) };
}
export function audioWave(f) {
  if (!f || f.kind !== 'audio') return null;
  if (WAVE_CACHE.has(f.id)) return WAVE_CACHE.get(f.id);
  let out = { duration: null, peaks: null };
  if (f.mime === 'audio/wav') { try { out = wavSummary(fs.readFileSync(filePath(f))) || out; } catch {} }
  if (WAVE_CACHE.size > 500) WAVE_CACHE.clear();
  WAVE_CACHE.set(f.id, out);
  return out;
}
