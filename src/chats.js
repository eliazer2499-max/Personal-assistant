// Multiple chats (conversations). Each chat has its own history; tasks, memory and settings are global.
// The "main" chat receives words from other channels (Telegram, WhatsApp, SMS, email), reminders and
// scheduled jobs — the same place they went before 2.1.
import { all, get, run, now, setting, setSetting, audit } from './db.js';
import { removeFilesOfChat } from './files.js';

export function listChats() {
  return all(`SELECT c.id, c.title, c.created, c.updated,
    (SELECT COUNT(*) FROM messages m WHERE m.chat_id=c.id AND m.role IN ('owner','assistant')) AS count,
    (SELECT text FROM messages m WHERE m.chat_id=c.id AND m.role IN ('owner','assistant') ORDER BY m.id DESC LIMIT 1) AS last
    FROM chats c ORDER BY c.updated DESC, c.id DESC`).map(c => ({ ...c, last: c.last ? String(c.last).slice(0, 90) : '' }));
}
export function chatById(id) { return id ? get('SELECT * FROM chats WHERE id=?', Number(id)) || null : null; }
export function createChat(title) {
  const t = String(title || '').trim().slice(0, 80) || 'New chat';
  const r = run('INSERT INTO chats(title,created,updated) VALUES(?,?,?)', t, now(), now());
  return chatById(Number(r.lastInsertRowid));
}
/** The chat that takes messages from other channels and system notices. Created on first need. */
export function mainChatId() {
  const m = parseInt(setting('main_chat'), 10);
  if (m && chatById(m)) return m;
  const newest = get('SELECT id FROM chats ORDER BY updated DESC, id DESC LIMIT 1');
  const id = newest ? newest.id : createChat('Chat 1').id;
  setSetting('main_chat', id);
  return id;
}
export function setMainChat(id) { if (chatById(id)) setSetting('main_chat', Number(id)); }
export function renameChat(id, title) {
  const t = String(title || '').trim().slice(0, 80);
  if (!t) throw Object.assign(new Error('Give the chat a name'), { status: 400 });
  if (!chatById(id)) throw Object.assign(new Error('No such chat'), { status: 404 });
  run('UPDATE chats SET title=? WHERE id=?', t, Number(id));
  return chatById(id);
}
export function deleteChat(id) {
  id = Number(id);
  const c = chatById(id);
  if (!c) throw Object.assign(new Error('No such chat'), { status: 404 });
  run("UPDATE jobs SET status='cancelling' WHERE chat_id=? AND status IN ('queued','running')", id);
  removeFilesOfChat(id);
  run('DELETE FROM messages WHERE chat_id=?', id);
  run('DELETE FROM chats WHERE id=?', id);
  if (parseInt(setting('main_chat'), 10) === id) setSetting('main_chat', '');
  audit('owner', 'chat.deleted', `"${c.title}" (${id})`);
  return { ok: true };
}
/** Chat of a job (or the main chat). */
export function chatOfJob(jobId) {
  const j = jobId ? get('SELECT chat_id FROM jobs WHERE id=?', jobId) : null;
  return j && j.chat_id && chatById(j.chat_id) ? j.chat_id : mainChatId();
}
export function touchChat(id) { run('UPDATE chats SET updated=? WHERE id=?', now(), id); }
/** A new chat named "New chat" takes its name from the owner's first words. */
export function autoTitle(id, text) {
  const c = chatById(id);
  if (!c || c.title !== 'New chat') return;
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return;
  run('UPDATE chats SET title=? WHERE id=?', t.length > 40 ? t.slice(0, 38).replace(/\s+\S*$/, '') + '…' : t, id);
}
