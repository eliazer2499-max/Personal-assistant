// Telegram: owner pastes a BotFather token; we set the webhook ourselves and pair to his chat with a one-time code.
import { cfg } from '../config.js';
import { setting, setSetting, secret, setSecret, audit, seenOnce, log, redact } from '../db.js';
import { token, safeEqual } from '../crypto.js';
import { ownerSaid } from './inbound.js';
import { decide } from '../approvals.js';
import { guardOut } from '../outguard.js';

async function api(method, body, tok) {
  const t = tok || secret('telegram_token');
  if (!t) throw new Error('Telegram is not set up');
  const r = await fetch(`${cfg.telegramBase}/bot${t}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error('Telegram: ' + redact(j.description || r.status));
  return j.result;
}

export async function setup(tok) {
  tok = String(tok || '').trim();
  if (!/^\d{5,15}:[A-Za-z0-9_-]{30,}$/.test(tok)) throw new Error('That does not look like a BotFather token (123456789:AA…).');
  const me = await api('getMe', {}, tok);
  const hookSecret = token(24).replace(/[^A-Za-z0-9_-]/g, '');
  await api('setWebhook', { url: cfg.publicUrl + '/hook/telegram', secret_token: hookSecret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true }, tok);
  setSecret('telegram_token', tok);
  setSecret('telegram_hook_secret', hookSecret);
  setSetting('telegram_bot', me.username);
  setSetting('telegram_chat_id', '');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  setSecret('telegram_pair_code', code + ':' + (Date.now() + 30 * 60000));
  audit('owner', 'telegram.setup', '@' + me.username);
  return { bot: me.username, link: `https://t.me/${me.username}?start=${code}`, code };
}
export async function disconnect() {
  try { await api('deleteWebhook', {}); } catch {}
  for (const k of ['telegram_token', 'telegram_hook_secret', 'telegram_pair_code']) setSecret(k, '');
  setSetting('telegram_chat_id', ''); setSetting('telegram_bot', '');
  audit('owner', 'telegram.disconnect', '');
}
export function status() { return { connected: !!secret('telegram_token'), bot: setting('telegram_bot'), paired: !!setting('telegram_chat_id') }; }

export async function handle(update, headers) {
  const want = secret('telegram_hook_secret');
  if (!want || !safeEqual(headers['x-telegram-bot-api-secret-token'] || '', want)) return { status: 403 };
  if (!seenOnce('tg:' + update.update_id)) return { status: 200 };
  // Answer Telegram at once; the work happens in the background.
  processUpdate(update).catch(e => log('telegram update failed', e.message));
  return { status: 200 };
}

export async function processUpdate(update) {
  const owner = setting('telegram_chat_id');
  if (update.callback_query) {
    const cq = update.callback_query;
    if (String(cq.message?.chat?.id) !== owner) return { status: 200 };
    const m = /^ap:(\d+):(yes|no)$/.exec(cq.data || '');
    if (m) {
      const r = await decide(parseInt(m[1], 10), m[2] === 'yes', 'telegram');
      await api('answerCallbackQuery', { callback_query_id: cq.id, text: r.message.slice(0, 190) }).catch(() => {});
      await sendOwner(r.message).catch(() => {});
    }
    return { status: 200 };
  }
  const msg = update.message;
  if (!msg || !msg.chat) return { status: 200 };
  const chatId = String(msg.chat.id);
  const text = msg.text || msg.caption || '';
  const start = /^\/start\s+(\d{6})$/.exec(text.trim());
  if (start && !owner) {
    const [code, exp] = (secret('telegram_pair_code') || ':').split(':');
    if (code && safeEqual(code, start[1]) && Date.now() < Number(exp) && msg.chat.type === 'private') {
      setSetting('telegram_chat_id', chatId); setSecret('telegram_pair_code', '');
      audit('owner', 'telegram.paired', 'chat ' + chatId);
      await api('sendMessage', { chat_id: chatId, text: 'Paired. I only answer this chat now. Ask me anything.' });
    }
    return { status: 200 };
  }
  if (!owner || chatId !== owner) { log('telegram: ignored message from a chat that is not the owner'); return { status: 200 }; }
  if (!text) { await sendOwner('I can read text messages here (voice and photos are not supported yet).'); return { status: 200 }; }
  api('sendChatAction', { chat_id: owner, action: 'typing' }).catch(() => {});
  const reply = await ownerSaid('telegram', text, msg.message_id ? { tg_msg_id: msg.message_id } : null);   // 2.3.15: id for reactions
  if (reply) await sendOwner(reply);
  return { status: 200 };
}

export async function sendOwner(text, opts = {}) {
  text = guardOut(text, 'telegram');           // 2.3.17 (D): tool-call text never leaves
  if (!String(text ?? '').trim() && !(opts.files && opts.files.length)) return true;
  const chat = setting('telegram_chat_id');
  if (!chat || !secret('telegram_token')) throw new Error('Telegram is not paired');
  const chunks = String(text).match(/[\s\S]{1,3900}/g) || [''];
  for (let i = 0; i < chunks.length; i++) {
    const body = { chat_id: chat, text: chunks[i], disable_web_page_preview: true };
    // 2.3.15: an answer to one of several messages is sent as a reply to that message (Telegram shows the quote)
    if (i === 0 && opts.replyTo?.tg_msg_id) body.reply_parameters = { message_id: Number(opts.replyTo.tg_msg_id), allow_sending_without_reply: true };
    if (opts.approvalId && i === chunks.length - 1) body.reply_markup = { inline_keyboard: [[{ text: '✅ YES', callback_data: `ap:${opts.approvalId}:yes` }, { text: '✖ NO', callback_data: `ap:${opts.approvalId}:no` }]] };
    await api('sendMessage', body);
  }
  return true;
}

/** 2.3.15: put one emoji on his Telegram message ('' removes it). Telegram allows a fixed set (reactions.telegramEmoji). */
export async function react(messageId, emoji) {
  const chat = setting('telegram_chat_id');
  if (!chat || !secret('telegram_token')) throw new Error('Telegram is not paired');
  await api('setMessageReaction', { chat_id: chat, message_id: Number(messageId), reaction: emoji ? [{ type: 'emoji', emoji }] : [] });
  return true;
}
