// Email channel: mail from the owner's own address with a subject starting "AI:" (or replies in those threads)
// is answered in the same thread. Checked every minute using one connected Gmail account.
import { setting, run, get, now, seenOnce, log, audit } from '../db.js';
import { gapi, accounts } from '../google.js';
import { bodyText, rawEmail, ownerAddresses } from '../tools/google.js';
import { ownerSaid } from './inbound.js';
import { guardOut } from '../outguard.js';

const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
const hdr = (m, n) => (m.payload?.headers || []).find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
const addr = (s) => (/<([^>]+)>/.exec(s)?.[1] || s).trim().toLowerCase();

export function account() {
  const want = setting('email_account');
  const list = accounts();
  return (want && list.find(a => a.email === want)?.email) || list[0]?.email || '';
}

/** Strip quoted history so "YES A3" in a reply is found. */
export function freshText(t) {
  const lines = String(t || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) { if (/^On .+wrote:\s*$/.test(l) || /^>/.test(l) || /^-{2,}\s*Original Message/i.test(l)) break; out.push(l); }
  return out.join('\n').trim();
}

let busy = false;
export async function poll() {
  if (busy || setting('email_channel') !== '1') return 0;
  const acct = account();
  if (!acct) return 0;
  busy = true;
  let n = 0;
  try {
    const owners = ownerAddresses();
    const j = await gapi(acct, 'GET', G + '/messages?' + new URLSearchParams({ q: 'from:me subject:AI newer_than:2d -in:drafts', maxResults: '20' }));
    const since = Number(setting('email_enabled_at') || 0);
    for (const m of (j.messages || []).reverse()) {
      if (get('SELECT 1 AS x FROM seen WHERE id=?', 'mail:' + m.id) || get('SELECT 1 AS x FROM seen WHERE id=?', 'mailsent:' + m.id)) continue;
      const d = await gapi(acct, 'GET', G + `/messages/${m.id}?format=full`);
      if (Number(d.internalDate || 0) < since) { seenOnce('mail:' + m.id); continue; }
      const subject = hdr(d, 'Subject');
      const from = addr(hdr(d, 'From'));
      const isOurs = /^\s*\[Assistant\]/.test(bodyText(d.payload));
      if (!seenOnce('mail:' + m.id)) continue;
      if (isOurs || !owners.has(from) || !/^(re:\s*)*ai:/i.test(subject.trim())) continue;
      n++;
      const text = freshText(bodyText(d.payload)) || subject.replace(/^(re:\s*)*ai:\s*/i, '');
      const meta = { account: acct, thread_id: d.threadId, in_reply_to: hdr(d, 'Message-ID'), references: (hdr(d, 'References') + ' ' + hdr(d, 'Message-ID')).trim(), subject: /^re:/i.test(subject) ? subject : 'Re: ' + subject };
      try { await gapi(acct, 'POST', G + `/messages/${m.id}/modify`, { removeLabelIds: ['UNREAD'] }); } catch {}
      const reply = await ownerSaid('email', text, meta);
      if (reply) await sendOwner(reply, { meta });
    }
  } catch (e) { log('email poll', e.message); }
  finally { busy = false; }
  return n;
}

export async function sendOwner(text, opts = {}) {
  text = guardOut(text, 'email');           // 2.3.17 (D): tool-call text never leaves
  if (!String(text ?? '').trim() && !(opts.files && opts.files.length)) return true;
  const meta = opts.meta || {};
  const acct = meta.account || account();
  if (!acct) throw new Error('No Google account connected for email');
  const to = acct;
  const subject = meta.subject || (opts.approvalId ? `AI: approval A${opts.approvalId}` : 'AI: message from your assistant');
  const raw = rawEmail({ to, subject, body: '[Assistant]\n' + text, inReplyTo: meta.in_reply_to, references: meta.references });
  const r = await gapi(acct, 'POST', G + '/messages/send', meta.thread_id ? { raw, threadId: meta.thread_id } : { raw });
  seenOnce('mailsent:' + r.id); seenOnce('mail:' + r.id);
  return true;
}
