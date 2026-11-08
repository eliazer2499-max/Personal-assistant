// 2.3.17 (D): the last check before words leave for any chat (web, WhatsApp, WhatsApp Agent, Telegram, SMS, email).
// Tool-call markup a model wrote as words (harmony: <|start|>, <|channel|>, <|call|>, "to=functions…", "commentary json{")
// is never sent: it is cut out, and when nothing real is left, nothing is sent. Each block is logged.
import { log, audit } from './db.js';
import { withoutHarmony } from './harmony.js';

export function guardOut(text, where = '') {
  if (text === null || text === undefined) return text;
  const g = withoutHarmony(String(text));
  if (!g.blocked) return text;
  log('outguard: tool-call text blocked on', where || '?', '(' + String(text).length + ' chars' + (g.text ? ', ' + g.text.length + ' kept' : ', nothing left to send') + ')');
  try { audit('assistant', 'reply.toolcall_text_blocked', `${where || '?'}: ${String(text).length} chars${g.text ? ', words around it kept' : ', nothing sent'}`); } catch {}
  return g.text;
}
