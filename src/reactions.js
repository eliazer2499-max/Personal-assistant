// 2.3.15: reactions on the owner's messages, on every channel.
// One row per message of his (reactions table): the emoji the assistant put on it. The web chat shows it on his
// bubble. Where the channel has its own reactions it is put there too:
//   WhatsApp Agent  — channels/waagent.js (its own Reactions setting and caps, unchanged; mirrored here)
//   Telegram        — setMessageReaction (Telegram allows a fixed set of emoji; others are swapped for the nearest)
//   WhatsApp number — the Cloud API's reaction message
//   SMS, email      — no reactions there: only the web chat shows it.
// A reaction never holds up or breaks a reply: native failures are returned as a note and written to Activity.
import { all, get, run, now, setting, audit, log } from './db.js';
import { cleanEmoji, reactionForm } from './emoji.js';

export const reactionsOn = () => setting('reactions') !== '0';

export function setReaction(messageId, emoji, auto = false) {
  const id = Number(messageId);
  if (!id) return;
  if (!emoji) { run('DELETE FROM reactions WHERE message_id=?', id); return; }
  run('INSERT INTO reactions(message_id,emoji,ts,auto) VALUES(?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET emoji=excluded.emoji, ts=excluded.ts, auto=excluded.auto',
    id, String(emoji), now(), auto ? 1 : 0);
}
export const reactionOf = (messageId) => get('SELECT emoji FROM reactions WHERE message_id=?', Number(messageId))?.emoji || '';

/** { messageId: emoji } for the newest `limit` messages of a chat (the web page paints these on his bubbles). */
export function reactionsForChat(chatId, limit = 200) {
  const rows = all(`SELECT r.message_id AS id, r.emoji FROM reactions r JOIN messages m ON m.id=r.message_id
    WHERE m.chat_id=? AND m.id >= COALESCE((SELECT MIN(id) FROM (SELECT id FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT ?)), 0)`, Number(chatId), Number(chatId), limit);
  return Object.fromEntries(rows.map(r => [r.id, r.emoji]));
}

/** A reaction that went out on the WhatsApp Agent: show it on the same message in the web chat. */
export function mirrorWaReaction(wamid, emoji) {
  const row = get("SELECT id FROM messages WHERE role='owner' AND channel='whatsapp_agent' AND json_extract(meta,'$.waa_wamid')=? ORDER BY id DESC LIMIT 1", String(wamid || ''));
  if (row) setReaction(row.id, emoji);
}

// Telegram only takes these as bot reactions (Bot API ReactionTypeEmoji). Nearest swap for the ones we use.
export const TG_ALLOWED = ['👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡'];
const TG_SWAP = { '✅': '👌', '☑️': '👌', '✔️': '👌', '😂': '🤣', '😅': '😁', '😊': '🥰', '🙂': '👍', '💪': '🔥', '🎊': '🎉', '❤️': '❤', '♥️': '❤', '😮': '🤯', '😲': '🤯' };
export function telegramEmoji(e) {
  if (!e) return '';
  const plain = String(e).replace(/\uFE0F/g, '');
  if (TG_ALLOWED.includes(plain)) return plain;
  if (TG_SWAP[e]) return TG_SWAP[e];
  if (TG_SWAP[plain]) return TG_SWAP[plain];
  return '👍';
}

/** The owner message rows of a job's input that can be reacted to (role owner), oldest first. */
export function ownerRow(id) { return id ? get("SELECT id,channel,meta,chat_id FROM messages WHERE id=? AND role='owner'", Number(id)) : null; }

/**
 * React to one stored message of his (row from ownerRow) on a channel that is NOT the WhatsApp Agent.
 * Returns { emoji, native: 'telegram'|'whatsapp'|'' , note }.
 */
export async function reactOnRow(row, emoji, { auto = false } = {}) {
  const e = reactionForm(cleanEmoji(emoji));
  setReaction(row.id, e, auto);
  let meta = {}; try { meta = row.meta ? JSON.parse(row.meta) : {}; } catch {}
  let native = '', note = '';
  try {
    if (row.channel === 'telegram' && meta.tg_msg_id) {
      await (await import('./channels/telegram.js')).react(meta.tg_msg_id, telegramEmoji(e)); native = 'telegram';
    } else if (row.channel === 'whatsapp' && meta.wa_msg_id) {
      await (await import('./channels/whatsapp.js')).react(meta.wa_from, meta.wa_msg_id, e); native = 'whatsapp';
    }
  } catch (err) {
    note = 'shown in the web chat only (' + row.channel + ' did not take it: ' + err.message + ')';
    log('react', row.channel, err.message);
    audit('system', 'react.failed', `${row.channel} ${e || '(remove)'}: ${err.message}`.slice(0, 300));
  }
  audit('assistant', auto ? 'react.auto' : 'tool.react', (e ? 'reacted ' + e : 'removed the reaction') + ` (${row.channel})`);
  return { emoji: e, native, note };
}
