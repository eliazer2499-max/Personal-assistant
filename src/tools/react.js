// 2.3.3 (2.3.4: obeys Settings → Channels → WhatsApp Agent → Reactions): react — put an emoji reaction on his WhatsApp Agent message (❤️ 😂 ✅ …). Only in a WhatsApp Agent
// conversation; elsewhere it answers "not available here". A failure never breaks the reply: it is returned to the
// model as a short note and written to the Activity log.
import { audit } from '../db.js';

export const react = {
  name: 'react',
  // 2.3.5: says plainly that this is the way to react, instead of typing ✅/👍 into the text.
  description: 'React to his WhatsApp message with an emoji (shows on his message, like a person reacting). Use this instead of typing ✅/👍 in the text. E.g. ❤️ for thanks or good news, 😂 for a joke, ✅ when a job he asked for is done. Replaces any earlier reaction on that message; an empty emoji removes it. Only works when he is writing from his WhatsApp agent chat. Most messages need no reaction; never react instead of answering.',
  params: {
    emoji: { type: 'string', description: 'One emoji, like ❤️ 😂 ✅ 👍 (empty = remove the reaction)' },
    message_id: { type: 'string', description: 'Optional: the WhatsApp message id to react to. Leave empty for the message you are answering.' },
  },
  required: [],
  run: async ({ emoji, message_id }, ctx = {}) => {
    if (emoji === undefined || emoji === null) return { error: 'Missing "emoji" (use "" to remove a reaction).' };
    if (ctx.channel !== 'whatsapp_agent') return { error: 'Not available here: reactions only work in his WhatsApp agent chat.' };
    const wa = await import('../channels/waagent.js');
    const { setting } = await import('../db.js');
    const ref = String(message_id || '').trim() || ctx.meta?.waa_wamid || setting('wa_agent_last_wamid');
    try {
      const r = await wa.toolReact(ref, emoji);
      if (r.skipped) return { ok: true, skipped: true, note: 'Not sent: you already reacted to his last two messages. Skip reactions for now and just reply.' };
      const e = r.emoji;
      audit('assistant', 'tool.react', e ? 'reacted ' + e : 'removed the reaction');
      return { ok: true, reacted: e || '(removed)', note: 'Done. No need to mention the reaction in your reply.' };
    } catch (err) {
      audit('system', 'wa_agent.react_failed', `react tool ${String(emoji || '')}: ${err.message}`);
      return { error: 'Reaction not sent: ' + err.message + '. Just carry on with your reply.' };
    }
  },
};

export default [react];
