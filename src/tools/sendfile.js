// 2.3.1: send_file — give the owner a file as an attachment (web chat, and WhatsApp Agent when he writes
// from there), instead of publishing a web page just to hand it over.
// Only files inside his workspace projects, his published sites folder, or files already in the chat
// (his uploads and pictures the assistant made) can be sent; ".." and symlinks that leave those folders are refused.
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config.js';
import { audit, setting } from '../db.js';
import { inProject } from './workspace.js';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const err = (m) => Object.assign(new Error(m), { userFacing: true });
const fmtMB = (n) => (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0) + ' MB';

function inside(base, p) {
  const b = path.resolve(base), q = path.resolve(p);
  if (q !== b && !q.startsWith(b + path.sep)) return false;
  if (fs.existsSync(q)) {
    const rb = fs.existsSync(b) ? fs.realpathSync(b) : b, rq = fs.realpathSync(q);
    if (rq !== rb && !rq.startsWith(rb + path.sep)) return false;
  }
  return true;
}
const ALLOWED = 'Only files in your workspace projects, your published sites, or files already in this chat can be sent.';

/** Where a requested path points: { buf, name, row? }. Throws a short, plain error. */
export async function resolveFile(spec, chatId = 0) {
  const files = await import('../files.js');
  let s = String(spec || '').trim();
  if (!s) throw err('Say which file to send (e.g. "music/song.mp3").');
  // a file already in the chat (his upload, or a picture made here)
  const fid = /^(?:file:)?([a-f0-9]{32})$/.exec(s) || /\/api\/files\/([a-f0-9]{32})/.exec(s);
  if (fid) {
    const row = files.fileRow(fid[1]);
    if (!row) throw err('That chat file is no longer on the server.');
    return { buf: fs.readFileSync(files.filePath(row)), name: row.name, size: row.size };
  }
  if (s.includes('\0') || /(^|[\\/])\.\.([\\/]|$)/.test(s)) throw err('That path tries to leave the allowed folders. ' + ALLOWED);
  let full;
  const ws = path.resolve(cfg.workspace), sites = path.resolve(cfg.sitesDir);
  if (path.isAbsolute(s)) {
    if (inside(ws, s)) full = path.resolve(s);
    else if (inside(sites, s)) full = path.resolve(s);
    else throw err(ALLOWED);
    if (!inside(ws, full) && !inside(sites, full)) throw err(ALLOWED);
  } else {
    s = s.replace(/^\.\/+/, '').replace(/^workspace\/+/, '');
    if (/^sites\//.test(s)) {
      full = path.resolve(sites, s.replace(/^sites\/+/, ''));
      if (!inside(sites, full)) throw err(ALLOWED);
    } else {
      const [project, ...rest] = s.split('/');
      if (!rest.length) {
        // a file already in the chat, by its name (his upload, or a picture made here)
        const { get } = await import('../db.js');
        const row = get('SELECT * FROM files WHERE name=? ORDER BY (chat_id=?) DESC, created DESC LIMIT 1', files.safeName(project), chatId || 0);
        if (row) { try { return { buf: fs.readFileSync(files.filePath(row)), name: row.name, size: row.size }; } catch {} }
      }
      if (!rest.length) throw err('Give the project too, like "' + project + '/file.mp3" (project_list and file_list show what is there).');
      try { full = inProject(project, rest.join('/')); } catch (e) { throw err(/leaves/.test(e.message) ? 'That path leaves the project folder. ' + ALLOWED : e.message); }
    }
  }
  let st; try { st = fs.statSync(full); } catch { throw err('No such file: ' + s + ' (file_list shows what is there).'); }
  if (st.isDirectory()) throw err('That is a folder. Zip it first (run_command: zip -r name.zip folder) and send the .zip.');
  if (!st.isFile()) throw err('That is not a normal file.');
  if (st.size === 0) throw err('That file is empty.');
  if (st.size > files.MAX_SEND) throw err(`That file is ${fmtMB(st.size)}; the chat takes files up to ${fmtMB(files.MAX_SEND)}. Make it smaller (e.g. a lower bitrate) or upload it to Google Drive.`);
  return { buf: fs.readFileSync(full), name: path.basename(full), size: st.size };
}

export const sendFile = {
  name: 'send_file',
  description: 'Send the owner a file as an attachment: it appears in this chat (with a player for audio/video, a preview for pictures and PDFs, a download button for anything else) and, when he writes from WhatsApp, also in his WhatsApp chat. Use this whenever he asks for a file ("send me the MP3"), instead of publishing a page. path = "<project>/<path in project>" from the workspace (e.g. "music/out/song.mp3"), "sites/<site>/<file>", or the id of a file already in the chat.',
  params: {
    path: S('Which file: "<project>/<path inside the project>", "sites/<site name>/<file>", or the name or id of a file already in the chat'),
    caption: S('Optional short text to go with the file'),
    to: S('Optional: "chat" (only this chat) or "whatsapp" (this chat + WhatsApp). Default: WhatsApp too when he is writing from WhatsApp.', { enum: ['chat', 'whatsapp'] }),
  },
  required: ['path'],
  run: async ({ path: p, caption, to }, ctx = {}) => {
    const files = await import('../files.js');
    const { addMessage, agentActive } = await import('../notify.js');
    let f;
    try { f = await resolveFile(p, ctx.chatId); } catch (e) { return { error: e.message }; }
    caption = String(caption || '').trim().slice(0, 1000);
    const wantWa = to === 'whatsapp' || (to !== 'chat' && (ctx.channel === 'whatsapp_agent' || (ctx.channel === 'system' && agentActive())));
    const msgId = addMessage('assistant', 'web', caption || '📎 ' + f.name, { sent_file: true }, ctx.jobId || null, ctx.chatId || null);
    const row = files.saveOutgoing(f.buf, f.name, ctx.chatId, msgId);
    const out = { ok: true, shown_in_chat: true, file: row.name, size: fmtMB(row.size), type: row.kind };
    if (wantWa) {
      try { out.whatsapp = 'sent as ' + (await (await import('../channels/waagent.js')).sendFileNow(row, caption)); }
      catch (e) {
        out.whatsapp = 'not sent: ' + e.message;
        out.note_whatsapp = e.kind === 'too_big' ? 'Tell him it is too big for WhatsApp and is waiting in the web chat to download.' : 'Tell him why it did not go to WhatsApp; it is in the web chat.';
      }
    }
    audit('assistant', 'tool.send_file', `${row.name} (${out.size})${wantWa ? ' · WhatsApp: ' + out.whatsapp : ''}`);
    out.note = 'The file is already in his chat' + (out.whatsapp?.startsWith('sent') ? ' and on WhatsApp' : '') + '. Just say it is there; do not paste links or publish a page for it.';
    return out;
  },
};

export default [sendFile];
