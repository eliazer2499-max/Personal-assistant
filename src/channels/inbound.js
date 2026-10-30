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
    addMessage('owner', channel, t);
    const r = await decide(d.id, d.yes, channel);
    addMessage('notice', channel, r.message);
    return r.message;
  }
  if (/^\/?(approvals|pending)$/i.test(t)) {
    const p = pending();
    return p.length ? p.map(a => `A${a.id}: ${a.summary.split('\n')[0]}`).join('\n') + '\nReply YES A# or NO A#.' : 'Nothing is waiting for your OK.';
  }
  if (/^\/?help$/i.test(t)) return 'Ask me anything or give me a job. Approve with "YES A12", refuse with "NO A12". "approvals" lists what is waiting.';
  startJob({ text: t, channel, meta });
  return '';
}
