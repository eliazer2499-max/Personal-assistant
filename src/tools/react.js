// 2.3.3 (2.3.4: obeys Settings → Channels → WhatsApp Agent → Reactions): react — put an emoji reaction on his message.
// 2.3.15: works on every channel, not only the WhatsApp Agent: the emoji shows on his bubble in the web chat, and on
// Telegram / his WhatsApp number as a real reaction too (SMS and email have none: web chat only). When several of
// his messages are answered together, "message" says which one (1 = the first; default the newest).
// A reaction can be the whole answer: react, then answer NO_REPLY (brain.js sends no words then).
// A failure never breaks the reply: it is returned to the model as a short note and written to the Activity log.
import { audit } from '../db.js';

export const react = {
  name: 'react',
  description: 'React to his message with an emoji (shows on his message, like a person reacting). Use this instead of typing ✅/👍 in the text. E.g. 👍 got it / on it, ❤️ thanks or good news, 😂 a joke, ✅ a job he asked for is done, 🙏 a favour, 👀 looking into it. Replaces any earlier reaction on that message; an empty emoji removes it. When a reaction says everything (he wrote "thanks", "ok", "great", "got it"), react and then answer exactly NO_REPLY so no words are sent. Most messages need no reaction; never react instead of answering a question or a request.',
  params: {
    emoji: { type: 'string', description: 'One emoji, like ❤️ 😂 ✅ 👍 (empty = remove the reaction)' },
    message: { type: 'number', description: 'Optional: when he sent several messages in a row ([#1], [#2]…), which one to react to. Default: his newest message.' },
    message_id: { type: 'string', description: 'Optional, WhatsApp agent chat only: the WhatsApp message id to react to. Leave empty for the message you are answering.' },
  },
  required: [],
  run: async ({ emoji, message, message_id }, ctx = {}) => {
    if (emoji === undefined || emoji === null) return { error: 'Missing "emoji" (use "" to remove a reaction).' };
    const msgs = Array.isArray(ctx.ownerMsgs) ? ctx.ownerMsgs : [];
    const n = parseInt(message, 10);
    const pick = msgs.length ? (n >= 1 && n <= msgs.length ? msgs[n - 1] : msgs[msgs.length - 1]) : null;
    if (ctx.channel === 'whatsapp_agent') {
      const wa = await import('../channels/waagent.js');
      const { setting } = await import('../db.js');
      const ref = String(message_id || '').trim() || pick?.meta?.waa_wamid || ctx.meta?.waa_wamid || setting('wa_agent_last_wamid');
      try {
        const r = await wa.toolReact(ref, emoji);
        if (r.skipped) return { ok: true, skipped: true, note: 'Not sent: you already reacted to his last two messages. Skip reactions for now and just reply.' };
        const e = r.emoji;
        audit('assistant', 'tool.react', e ? 'reacted ' + e : 'removed the reaction');
        if (e && Array.isArray(ctx.reacted)) ctx.reacted.push({ id: pick?.id || null, emoji: e, wamid: ref });
        return { ok: true, reacted: e || '(removed)', note: 'Done. No need to mention the reaction in your reply.' };
      } catch (err) {
        audit('system', 'wa_agent.react_failed', `react tool ${String(emoji || '')}: ${err.message}`);
        return { error: 'Reaction not sent: ' + err.message + '. Just carry on with your reply.' };
      }
    }
    if (!pick) return { error: 'Not available here: there is no message of his to react to in this job.' };
    const R = await import('../reactions.js');
    if (!R.reactionsOn()) return { error: 'Reactions are turned off (Settings → AI → Replies). Just reply in words.' };
    const row = R.ownerRow(pick.id);
    if (!row) return { error: 'Not available here: that message is gone.' };
    try {
      const r = await R.reactOnRow(row, emoji);
      if (r.emoji && Array.isArray(ctx.reacted)) ctx.reacted.push({ id: row.id, emoji: r.emoji });
      return { ok: true, reacted: r.emoji || '(removed)', note: 'Done. No need to mention the reaction in your reply.' + (r.note ? ' (' + r.note + ')' : '') };
    } catch (err) {
      return { error: 'Reaction not sent: ' + err.message + '. Just carry on with your reply.' };
    }
  },
};

export default [react];
