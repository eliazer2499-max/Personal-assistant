// Delivering words to the owner on a channel. Every channel only ever talks to the owner.
import { run, get, now, setting, log, redact } from './db.js';
import { chatOfJob, chatById, mainChatId, touchChat } from './chats.js';

/** Store a message. It goes to chatId, else the chat of its job, else the main chat. */
export function addMessage(role, channel, text, meta = null, jobId = null, chatId = null) {
  const chat = chatId && chatById(chatId) ? Number(chatId) : (jobId ? chatOfJob(jobId) : mainChatId());
  const r = run('INSERT INTO messages(role,channel,text,meta,job_id,ts,chat_id) VALUES(?,?,?,?,?,?,?)', role, channel, redact(String(text)).slice(0, 100000), meta ? JSON.stringify(meta) : null, jobId, now(), chat);
  touchChat(chat);
  return Number(r.lastInsertRowid);
}

/** Send text to the owner on one channel. opts: { approvalId, meta } */
export async function deliver(channel, text, opts = {}) {
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
