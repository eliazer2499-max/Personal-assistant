// Delivering words to the owner on a channel. Every channel only ever talks to the owner.
import { run, get, now, setting, log, redact } from './db.js';
import { chatOfJob, chatById, mainChatId, touchChat } from './chats.js';
import { looksLikeReplies, repliesToPlain } from './replies.js';
import { splitStatusEmoji } from './emoji.js';
import { guardOut } from './outguard.js';

// 2.3.16: the last guard — the assistant's replies JSON is never stored or sent as text (only its words).
const plainWords0 = (role, text) => (role === 'assistant' || role === 'notice') && looksLikeReplies(text) ? repliesToPlain(text).text : text;
// 2.3.17 (D): and tool-call text a model wrote as words is never stored or sent either.
const plainWords = (role, text) => { const t = plainWords0(role, text); return role === 'assistant' || role === 'notice' ? guardOut(t, 'chat') : t; };

/** Store a message. It goes to chatId, else the chat of its job, else the main chat. */
export function addMessage(role, channel, text, meta = null, jobId = null, chatId = null) {
  const chat = chatId && chatById(chatId) ? Number(chatId) : (jobId ? chatOfJob(jobId) : mainChatId());
  text = plainWords(role, String(text ?? ''));
  const r = run('INSERT INTO messages(role,channel,text,meta,job_id,ts,chat_id) VALUES(?,?,?,?,?,?,?)', role, channel, redact(String(text)).slice(0, 100000), meta ? JSON.stringify(meta) : null, jobId, now(), chat);
  touchChat(chat);
  return Number(r.lastInsertRowid);
}

/** Send text to the owner on one channel. opts: { approvalId, meta } */
export async function deliver(channel, text, opts = {}) {
  if (!opts.approvalId) {
    text = plainWords('assistant', String(text ?? ''));
    if (!text.trim() && !(opts.files && opts.files.length)) return true;
    // 2.3.16: a bare status emoji is a reaction, never its own message. The WhatsApp Agent turns it into one (or
    // drops it); the other channels already got their reaction from the brain, so the emoji alone is not sent.
    if (channel !== 'whatsapp_agent' && channel !== 'web' && !(opts.files && opts.files.length) && splitStatusEmoji(text).where === 'only') { log('deliver: emoji-only text not sent on', channel); return true; }
  }
  // 2.3.17 (D): never tool-call text, on any channel (plainWords above already checked the assistant's words)
  else { text = guardOut(String(text ?? ''), channel); if (!text.trim() && !(opts.files && opts.files.length)) return true; }
  try {
    if (channel === 'telegram') return await (await import('./channels/telegram.js')).sendOwner(text, opts);
    if (channel === 'whatsapp') return await (await import('./channels/whatsapp.js')).sendOwner(text, opts);
    if (channel === 'sms') return await (await import('./channels/sms.js')).sendOwner(text, opts);
    if (channel === 'email') return await (await import('./channels/email.js')).sendOwner(text, opts);
    if (channel === 'whatsapp_agent') return await (await import('./channels/waagent.js')).sendOwner(text, opts);
    return true; // web: the message row is the delivery
  } catch (e) {
    log('deliver failed', channel, e.message);
    addMessage('notice', 'web', `Could not deliver to ${channel}: ${e.message}`);
    return false;
  }
}

/** A notice for the owner: stored on the web page, and pushed to his chosen notify channel. */
export async function notifyOwner(text, opts = {}) {
  const ap = opts.approvalId ? get('SELECT job_id FROM approvals WHERE id=?', opts.approvalId) : null;
  addMessage(opts.role || 'notice', 'web', text, opts.approvalId ? { approval: opts.approvalId } : null, ap?.job_id || null);
  const ch = opts.channel || setting('notify_channel');
  if (ch && ch !== 'web') await deliver(ch, text, opts);
  if (!opts.channel) await alsoAgent(ch, text, opts);
}

/** 2.2: when the WhatsApp Agent is on and knows his chat, reminders, summaries, notices and approval
 *  requests also go there (unless it already was the chosen channel). */
export function agentActive() { return setting('wa_agent_enabled') === '1' && !!setting('wa_agent_creator'); }
export async function alsoAgent(primary, text, opts = {}) {
  if (primary === 'whatsapp_agent' || !agentActive()) return;
  await deliver('whatsapp_agent', text, opts);
}
