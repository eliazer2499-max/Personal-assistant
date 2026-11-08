// Tool registry + the switchboard (Settings → Tools turns each tool on/off, like the starter's enabled_tools.txt).
import basic from './basic.js';
import google from './google.js';
import workspace from './workspace.js';
import ssh from './ssh.js';
import agents from './agents.js';
import sendfile from './sendfile.js';
import reacts from './react.js';
import sitecheck from './sitecheck.js';
import video from './video.js';
import browserTools from './browser.js';
import { browserActionsOn } from '../browser-core.js';
import { platformToken } from './workspace.js';
import { setting, setSetting, audit, all, redact } from '../db.js';
import { request } from '../approvals.js';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });

const platform = [
  { name: 'platforms_list', description: 'List platforms with a saved API token (GitHub, Cloudflare, …). Tokens are never shown.', params: {},
    run: async () => ({ platforms: all('SELECT name,kind,base_url FROM platforms ORDER BY name') }) },
  { name: 'platform_request', description: 'Call a saved platform\'s HTTP API with its token (e.g. GitHub: GET /user/repos; Cloudflare: GET /zones). GET runs right away; POST/PUT/PATCH/DELETE wait for the owner\'s YES.',
    params: { platform: S('Saved platform name, e.g. github'), method: S('GET, POST, PUT, PATCH or DELETE', { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }), path: S('Path after the base URL, e.g. /user/repos'), body: S('JSON body text (optional)') },
    required: ['platform', 'path'],
    approval: (a) => (String(a.method || 'GET').toUpperCase() === 'GET') ? null : `${String(a.method).toUpperCase()} ${a.platform} ${a.path}${a.body ? '\n' + String(a.body).slice(0, 800) : ''}`,
    run: async ({ platform, method, path, body }) => {
      if (String(platform).toLowerCase() === 'whatsapp-agent') throw new Error('That key is only used by the WhatsApp Agent channel. To message the owner use notify_me.');
      const p = platformToken(platform);
      const defaults = { github: 'https://api.github.com', cloudflare: 'https://api.cloudflare.com/client/v4', digitalocean: 'https://api.digitalocean.com/v2', vercel: 'https://api.vercel.com', netlify: 'https://api.netlify.com/api/v1' };
      const base = (p.base_url || defaults[p.kind] || defaults[p.name] || '').replace(/\/+$/, '');
      if (!base) throw new Error('This platform has no API base URL saved.');
      const url = base + '/' + String(path).replace(/^\/+/, '');
      if (!url.startsWith(base + '/')) throw new Error('Bad path');
      const r = await fetch(url, { method: (method || 'GET').toUpperCase(), headers: { Authorization: 'Bearer ' + p.token, Accept: 'application/json', 'User-Agent': 'myassistant', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body || undefined, signal: AbortSignal.timeout(30000) });
      const t = redact(await r.text());
      return { status: r.status, body: t.slice(0, 20000) };
    } },
];

const messaging = [
  { name: 'notify_me', description: 'Send the owner a message on one of his channels (telegram, whatsapp, whatsapp_agent, sms, email, web). Default: his chosen notify channel (and his WhatsApp Agent chat when it is on).',
    params: { text: S('Message'), channel: S('telegram, whatsapp, whatsapp_agent, sms, email or web (optional)') }, required: ['text'],
    run: async ({ text, channel }) => { const { notifyOwner } = await import('../notify.js'); await notifyOwner(text, { channel }); return { sent: true }; } },
  { name: 'sms_send', description: 'Send a text message (SMS) through the owner\'s Android gateway phone. Texts to anyone other than the owner wait for his YES.',
    params: { to: S('Phone number in +1… format'), text: S('Message') }, required: ['to', 'text'],
    approval: (a) => { const own = setting('sms_allow').split(/[,\s]+/).map(n => n.replace(/[^\d+]/g, '')); return own.includes(String(a.to).replace(/[^\d+]/g, '')) ? null : `Text ${a.to}:\n${a.text}`; },
    run: async ({ to, text }) => (await import('../channels/sms.js')).sendSms(to, text) },
  { name: 'whatsapp_send', description: 'Send a WhatsApp message from the owner\'s WhatsApp Business number. Anyone other than the owner waits for his YES (and WhatsApp only allows free text within 24 h of their last message).',
    params: { to: S('Phone number with country code, digits only'), text: S('Message') }, required: ['to', 'text'],
    approval: (a) => { const own = setting('wa_allow').split(/[,\s]+/).map(n => n.replace(/\D/g, '')); return own.includes(String(a.to).replace(/\D/g, '')) ? null : `WhatsApp ${a.to}:\n${a.text}`; },
    run: async ({ to, text }) => (await import('../channels/whatsapp.js')).sendWhatsApp(to, text) },
  { name: 'check_update', description: 'Check whether a newer version of this assistant is available (it never updates itself; the owner taps Update).', params: {},
    run: async () => (await import('../updates.js')).checkUpdate(true) },
];

export const ALL = [...basic, ...google, ...workspace, ...ssh, ...platform, ...messaging, ...agents, ...sendfile, ...reacts, ...sitecheck, ...video, ...browserTools];
const MAP = new Map(ALL.map(t => [t.name, t]));
export function byName(n) { return MAP.get(n); }

export function disabledSet() { return new Set(setting('tools_disabled').split(',').filter(Boolean)); }
export function setEnabled(name, on) {
  const d = disabledSet(); if (on) d.delete(name); else d.add(name);
  setSetting('tools_disabled', [...d].join(','));
  audit('owner', on ? 'tool.enabled' : 'tool.disabled', name);
}
export function enabledTools() { const d = disabledSet(); const web = browserActionsOn(); return ALL.filter(t => !d.has(t.name) && (web || !t.browserAction)); }   // 2.3.8: Browser actions off hides the browser tools
export function toolList() { const d = disabledSet(); return ALL.map(t => ({ name: t.name, description: t.description, enabled: !d.has(t.name), approval: !!t.approval })); }

/** Run a tool for the model. Approval-gated calls are filed, not run. */
export async function execTool(name, args, ctx) {
  const t = MAP.get(name);
  if (!t) return { error: 'No such tool: ' + name };
  if (disabledSet().has(name)) return { error: `The tool ${name} is switched off by the owner (Settings → Tools).` };
  args = args || {};
  for (const r of (t.required || [])) if (args[r] === undefined || args[r] === '') return { error: `Missing "${r}"` };
  try {
    // 2.3.17 (E): a check that must pass before his YES is even asked for (publish_site: no broken or hot-linked pictures)
    if (t.precheck) { const pc = await t.precheck(args, ctx); if (pc) return pc; }
    if (t.approval) {
      const summary = typeof t.approval === 'function' ? t.approval(args, ctx) : `${name} ${JSON.stringify(args)}`;
      if (summary) {
        const id = await request(name, args, summary, ctx);
        return { status: 'waiting_for_owner_approval', approval: 'A' + id, note: `Not done yet: A${id} waits for the owner's YES; he already got the request, so do not repeat it, do not mention its code, and do not say it is done.` };
      }
    }
    const res = await t.run(args, ctx);
    if (['file_write', 'run_command', 'ssh_run', 'gmail_send', 'sms_send', 'whatsapp_send', 'docs_create', 'drive_upload', 'sheets_append', 'memory_forget'].includes(name)) audit('assistant', 'tool.' + name, { args: summarizeArgs(args), exit: res && res.exit_code });
    return res;
  } catch (e) {
    return { error: redact(e.message || String(e)) };
  }
}
export function summarizeArgs(a) {
  const o = {};
  for (const [k, v] of Object.entries(a || {})) o[k] = typeof v === 'string' && v.length > 160 ? v.slice(0, 160) + '…' : v;
  if (a && a.secret) for (const k of ['text', 'value']) if (k in o) o[k] = '(hidden)';   // 2.3.8: browser_type secret=true never reaches Activity or the audit log
  return o;
}

/** Declarations for the model. */
export function declarations(opts = {}) {
  return enabledTools().filter(t => !(opts.helper && ['delegate', 'helpers_wait'].includes(t.name))).map(t => ({ name: t.name, description: t.description, parameters: { type: 'object', properties: t.params || {}, required: t.required || [] } }));
}
