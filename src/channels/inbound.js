// One entry point for words the owner sends from any channel.
import { parseDecision, decide, pending } from '../approvals.js';
import { startJob } from '../brain.js';
import { addMessage } from '../notify.js';

/** Returns a short immediate reply (or '' when a job was started and will reply itself). */
export async function ownerSaid(channel, text, meta = null, files = []) {
  const t = String(text || '').trim();
  // A voice note / photo / file (2.2: WhatsApp Agent) always goes to the brain with its attachment.
  if (files && files.length) { startJob({ text: t, channel, meta, files }); return ''; }
  if (!t) return '';
  const d = parseDecision(t);
  if (d) {
    addMessage('owner', channel, t, meta);        // 2.3.16: with his message id, so the follow-up can react to his YES
    if (d.ask) { addMessage('notice', channel, d.ask); return d.ask; }   // 2.3.16: two different requests are open: which one?
    const r = await decide(d.id, d.yes, channel, meta);
    if (!r.picture) addMessage('notice', channel, r.message);   // 2.3.17: with a picture, its caption is the message
    return r.delivered ? '' : r.message;                        // 2.3.17: the picture + caption already went to WhatsApp
  }
  if (/^\/?(approvals|pending)$/i.test(t)) {
    const p = pending();
    if (p.length === 1) return `Waiting for your OK: ${p[0].summary.split('\n')[0]}\nReply YES or NO.`;   // 2.3.17: no code for one
    return p.length ? p.map(a => `A${a.id}: ${a.summary.split('\n')[0]}`).join('\n') + '\nReply YES A# or NO A#.' : 'Nothing is waiting for your OK.';
  }
  if (/^\/?help$/i.test(t)) return 'Ask me anything or give me a job. When something needs your OK, reply YES or NO. "approvals" lists what is waiting.';
  startJob({ text: t, channel, meta });
  return '';
}
