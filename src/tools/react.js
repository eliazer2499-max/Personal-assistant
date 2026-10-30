// 2.3.3: react — put an emoji reaction on his WhatsApp Agent message (❤️ 😂 ✅ …). Only in a WhatsApp Agent
// conversation; elsewhere it answers "not available here". A failure never breaks the reply: it is returned to the
// model as a short note and written to the Activity log.
import { audit } from '../db.js';

export const react = {
  name: 'react',
  description: 'React to the owner\'s WhatsApp message with one emoji (e.g. ❤️ for thanks or good news, 😂 for a joke, ✅ when a job he asked for is done). Replaces any earlier reaction on that message; an empty emoji removes it. Only works when he is writing from his WhatsApp agent chat. Use sparingly, and still answer in words when an answer is needed.',
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
      const e = await wa.reactTo(ref, emoji);
      audit('assistant', 'tool.react', e ? 'reacted ' + e : 'removed the reaction');
      return { ok: true, reacted: e || '(removed)', note: 'Done. No need to mention the reaction in your reply.' };
    } catch (err) {
      audit('system', 'wa_agent.react_failed', `react tool ${String(emoji || '')}: ${err.message}`);
      return { error: 'Reaction not sent: ' + err.message + '. Just carry on with your reply.' };
    }
  },
};

export default [react];
