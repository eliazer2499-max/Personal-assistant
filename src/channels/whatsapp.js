// WhatsApp Cloud API (Meta). The owner creates a Meta developer app + number (his taps), pastes the IDs and
// tokens; we subscribe the webhook ourselves when he gives the app id + secret. Only allow-listed numbers command it.
import { cfg } from '../config.js';
import { setting, setSetting, secret, setSecret, audit, seenOnce, log, run, now, redact } from '../db.js';
import { token, safeEqual, hmacHex } from '../crypto.js';
import { ownerSaid } from './inbound.js';
import { decide } from '../approvals.js';

const G = () => `${cfg.graphBase}/${setting('wa_api_version') || 'v23.0'}`;
const digits = (s) => String(s || '').replace(/\D/g, '');
export const allowList = () => setting('wa_allow').split(/[,\s]+/).map(digits).filter(Boolean);

export function verifyToken() {
  let v = secret('wa_verify_token');
  if (!v) { v = token(18).replace(/[^A-Za-z0-9]/g, ''); setSecret('wa_verify_token', v); }
  return v;
}
export function status() {
  return { phone_number_id: setting('wa_phone_number_id'), waba_id: setting('wa_waba_id'), app_id: setting('wa_app_id'), has_token: !!secret('wa_token'), has_app_secret: !!secret('wa_app_secret'), allow: setting('wa_allow'), webhook_url: cfg.publicUrl + '/hook/whatsapp', verify_token_set: !!secret('wa_verify_token') };
}

async function graph(method, path, body, tok) {
  const r = await fetch(G() + path, { method, headers: { Authorization: 'Bearer ' + (tok || secret('wa_token')), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('WhatsApp: ' + redact(j.error?.message || r.status));
  return j;
}

/** Save settings, then do the integration steps Meta allows by API. */
export async function setup(o) {
  for (const k of ['wa_phone_number_id', 'wa_waba_id', 'wa_app_id']) if (o[k] !== undefined) setSetting(k, digits(o[k]));
  if (o.wa_allow !== undefined) setSetting('wa_allow', String(o.wa_allow).split(/[,\s]+/).map(digits).filter(Boolean).join(','));
  if (o.wa_token) setSecret('wa_token', String(o.wa_token).trim());
  if (o.wa_app_secret) setSecret('wa_app_secret', String(o.wa_app_secret).trim());
  const vt = verifyToken();
  const steps = [];
  if (!secret('wa_token') || !setting('wa_phone_number_id')) return { ok: false, steps: ['Paste at least the Phone number ID and the access token.'] };
  const num = await graph('GET', `/${setting('wa_phone_number_id')}?fields=display_phone_number,verified_name`);
  steps.push(`Number OK: ${num.display_phone_number || ''} ${num.verified_name || ''}`.trim());
  if (setting('wa_app_id') && secret('wa_app_secret')) {
    const appTok = setting('wa_app_id') + '|' + secret('wa_app_secret');
    const p = new URLSearchParams({ object: 'whatsapp_business_account', callback_url: cfg.publicUrl + '/hook/whatsapp', verify_token: vt, fields: 'messages', access_token: appTok });
    const r = await fetch(`${G()}/${setting('wa_app_id')}/subscriptions`, { method: 'POST', body: p, signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    steps.push(r.ok ? 'Webhook registered with Meta (messages).' : 'Webhook registration failed: ' + redact(j.error?.message || r.status) + ' — use the manual steps below.');
  } else steps.push('No App ID/App secret: set the webhook by hand (steps below).');
  if (setting('wa_waba_id')) {
    try { await graph('POST', `/${setting('wa_waba_id')}/subscribed_apps`); steps.push('Your WhatsApp account is subscribed to this app.'); }
    catch (e) { steps.push('Subscribing your WhatsApp account failed: ' + e.message); }
  }
  audit('owner', 'whatsapp.setup', steps.join(' | '));
  return { ok: true, steps };
}

export function verifyGet(q) {
  if (q['hub.mode'] === 'subscribe' && secret('wa_verify_token') && safeEqual(q['hub.verify_token'] || '', secret('wa_verify_token'))) return { status: 200, body: String(q['hub.challenge'] || '') };
  return { status: 403, body: 'no' };
}

export async function handle(raw, headers) {
  const appSecret = secret('wa_app_secret');
  if (appSecret) {
    const sig = String(headers['x-hub-signature-256'] || '');
    if (!safeEqual(sig, 'sha256=' + hmacHex(appSecret, raw))) return { status: 403 };
  } else if (!secret('wa_token')) return { status: 403 };
  let body; try { body = JSON.parse(raw.toString('utf8')); } catch { return { status: 400 }; }
  processBody(body).catch(e => log('whatsapp inbound failed', e.message));
  return { status: 200 };
}

export async function processBody(body) {
  const allow = allowList();
  for (const e of body.entry || []) for (const ch of e.changes || []) {
    for (const m of ch.value?.messages || []) {
      if (!seenOnce('wa:' + m.id)) continue;
      const from = digits(m.from);
      let text = m.text?.body || m.button?.text || '';
      if (m.type === 'interactive') {
        const id = m.interactive?.button_reply?.id || '';
        const a = /^ap:(\d+):(yes|no)$/.exec(id);
        if (a && allow.includes(from)) { const r = await decide(parseInt(a[1], 10), a[2] === 'yes', 'whatsapp'); await sendWhatsApp(from, r.message).catch(() => {}); continue; }
        text = m.interactive?.button_reply?.title || '';
      }
      if (!allow.includes(from)) { run('INSERT INTO inbox(channel,sender,text,ts) VALUES(?,?,?,?)', 'whatsapp', from, text || '(' + m.type + ')', now()); continue; }
      if (!text) { await sendWhatsApp(from, 'I can read text messages here (voice notes and photos are not supported yet).').catch(() => {}); continue; }
      const reply = await ownerSaid('whatsapp', text, { wa_from: from, wa_msg_id: m.id });   // 2.3.15: id for reactions
      if (reply) await sendWhatsApp(from, reply).catch(e => log('wa send', e.message));
    }
  }
}

export async function sendWhatsApp(to, text, approvalId, replyTo = '') {
  const pid = setting('wa_phone_number_id');
  if (!pid || !secret('wa_token')) throw new Error('WhatsApp is not set up');
  const chunks = String(text).match(/[\s\S]{1,3800}/g) || [''];
  let last;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const body = approvalId && isLast
      ? { messaging_product: 'whatsapp', to: digits(to), type: 'interactive', interactive: { type: 'button', body: { text: chunks[i].slice(0, 1000) }, action: { buttons: [{ type: 'reply', reply: { id: `ap:${approvalId}:yes`, title: 'YES' } }, { type: 'reply', reply: { id: `ap:${approvalId}:no`, title: 'NO' } }] } } }
      : { messaging_product: 'whatsapp', to: digits(to), type: 'text', text: { body: chunks[i], preview_url: false } };
    if (i === 0 && replyTo) body.context = { message_id: String(replyTo) };   // 2.3.15: a reply to his message (quoted)
    last = await graph('POST', `/${pid}/messages`, body);
  }
  return { sent: true, id: last?.messages?.[0]?.id };
}
export async function sendOwner(text, opts = {}) {
  const to = opts.meta?.wa_from || allowList()[0];
  if (!to) throw new Error('No owner WhatsApp number saved');
  return sendWhatsApp(to, text, opts.approvalId, opts.replyTo?.wa_msg_id || '');
}

/** 2.3.15: put one emoji on his WhatsApp message ('' removes it), the Cloud API's reaction message. */
export async function react(to, messageId, emoji) {
  const pid = setting('wa_phone_number_id');
  if (!pid || !secret('wa_token')) throw new Error('WhatsApp is not set up');
  const num = digits(to || allowList()[0] || '');
  if (!num) throw new Error('No owner WhatsApp number saved');
  await graph('POST', `/${pid}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to: num, type: 'reaction', reaction: { message_id: String(messageId), emoji: emoji || '' } });
  return true;
}
