// SMS/MMS through the free open-source "SMS Gateway for Android" app (github.com/capcom6/android-sms-gateway).
// Default: its Cloud server (api.sms-gate.app). The owner installs the app on a spare Android phone, turns on
// "Cloud server", and pastes the username/password it shows. We register our webhook ourselves.
import { cfg } from '../config.js';
import { setting, setSetting, secret, setSecret, audit, seenOnce, log, run, now, redact } from '../db.js';
import { token, safeEqual, hmacHex } from '../crypto.js';
import { ownerSaid } from './inbound.js';

const norm = (s) => { const d = String(s || '').replace(/[^\d+]/g, ''); return d.startsWith('+') ? d : (d.length === 10 ? '+1' + d : '+' + d); };
export const allowList = () => setting('sms_allow').split(/[,\s]+/).filter(Boolean).map(norm);
const base = () => setting('sms_base_url').replace(/\/+$/, '');
function auth() { return 'Basic ' + Buffer.from(setting('sms_username') + ':' + secret('sms_password')).toString('base64'); }
export function hookPath() {
  let s = secret('sms_hook_secret');
  if (!s) { s = token(18).replace(/[^A-Za-z0-9]/g, ''); setSecret('sms_hook_secret', s); }
  return '/hook/sms/' + s;
}
export function status() { return { base_url: base(), username: setting('sms_username'), has_password: !!secret('sms_password'), allow: setting('sms_allow'), webhook_url: cfg.publicUrl + '/hook/sms/…', signing: !!secret('sms_signing_key') }; }

async function gw(method, path, body) {
  const r = await fetch(base() + path, { method, headers: { Authorization: auth(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const t = await r.text();
  let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t.slice(0, 200) }; }
  return { ok: r.ok, status: r.status, j };
}

export async function setup(o) {
  if (o.sms_base_url) setSetting('sms_base_url', String(o.sms_base_url).trim());
  if (o.sms_username !== undefined) setSetting('sms_username', String(o.sms_username).trim());
  if (o.sms_password) setSecret('sms_password', String(o.sms_password).trim());
  if (o.sms_signing_key) setSecret('sms_signing_key', String(o.sms_signing_key).trim());
  if (o.sms_allow !== undefined) setSetting('sms_allow', String(o.sms_allow).split(/[,\s]+/).filter(Boolean).map(norm).join(','));
  if (!setting('sms_username') || !secret('sms_password')) return { ok: false, steps: ['Paste the username and password shown in the SMS Gateway app.'] };
  const url = cfg.publicUrl + hookPath();
  const steps = [];
  for (const event of ['sms:received', 'mms:received']) {
    const r = await gw('POST', '/webhooks', { id: 'myassistant-' + event.replace(':', '-'), url, event });
    steps.push(r.ok ? `Webhook for ${event} registered.` : `Webhook ${event} failed (${r.status}): ${redact(JSON.stringify(r.j)).slice(0, 160)}`);
  }
  audit('owner', 'sms.setup', steps.join(' | '));
  return { ok: steps.every(s => !/failed/.test(s)), steps };
}

export async function handle(secretInPath, raw, headers) {
  if (!secret('sms_hook_secret') || !safeEqual(secretInPath, secret('sms_hook_secret'))) return { status: 404 };
  const sk = secret('sms_signing_key');
  if (sk) {
    const sig = String(headers['x-signature'] || ''), ts = String(headers['x-timestamp'] || '');
    if (!sig || !safeEqual(sig.toLowerCase(), hmacHex(sk, Buffer.concat([raw, Buffer.from(ts)])))) return { status: 403 };
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 600) return { status: 403 };
  }
  let b; try { b = JSON.parse(raw.toString('utf8')); } catch { return { status: 400 }; }
  processEvent(b).catch(e => log('sms inbound failed', e.message));
  return { status: 200 };
}

export async function processEvent(b) {
  if (b.id && !seenOnce('sms:' + b.id)) return;
  const p = b.payload || {};
  const from = norm(p.sender || p.phoneNumber || '');
  if (b.event === 'mms:received') {
    run('INSERT INTO inbox(channel,sender,text,ts) VALUES(?,?,?,?)', 'sms', from, `(MMS${p.subject ? ': ' + p.subject : ''}; picture not downloaded)`, now());
    return;
  }
  if (b.event !== 'sms:received') return;
  const text = String(p.message || p.text || '');
  if (!allowList().includes(from)) { run('INSERT INTO inbox(channel,sender,text,ts) VALUES(?,?,?,?)', 'sms', from, text, now()); return; }
  const reply = await ownerSaid('sms', text, { sms_from: from });
  if (reply) await sendSms(from, reply).catch(e => log('sms send', e.message));
}

export async function sendSms(to, text) {
  if (!setting('sms_username') || !secret('sms_password')) throw new Error('SMS gateway is not set up');
  const phone = norm(to);
  let r = await gw('POST', '/messages', { textMessage: { text: String(text).slice(0, 1500) }, phoneNumbers: [phone] });
  if (r.status === 404) r = await gw('POST', '/message', { message: String(text).slice(0, 1500), phoneNumbers: [phone] });
  if (!r.ok) throw new Error('SMS gateway ' + r.status + ': ' + redact(JSON.stringify(r.j)).slice(0, 200));
  return { queued: true, id: r.j.id, state: r.j.state };
}
export async function sendOwner(text, opts = {}) {
  const to = opts.meta?.sms_from || allowList()[0];
  if (!to) throw new Error('No owner phone number saved for SMS');
  const t = opts.approvalId ? String(text).replace(/\n\nReply YES[\s\S]*$/, '') .slice(0, 600) + (/Reply YES A\d+/.test(String(text)) ? `\nReply YES A${opts.approvalId} or NO A${opts.approvalId}` : '\nReply YES or NO') : text;   // 2.3.16: the code only when 2+ wait
  return sendSms(to, t);
}
