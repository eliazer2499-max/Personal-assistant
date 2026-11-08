// My Assistant v2 — HTTP server (behind Caddy for HTTPS). No npm dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { cfg, APP_DIR, VERSION } from './config.js';
import { loadMasterKey } from './crypto.js';
import { openDb, all, get, run, now, setting, setSetting, allSettings, secret, setSecret, hasSecret, audit, log, redact } from './db.js';
import * as auth from './auth.js';
import { startJob, cancelJob, recoverJobs, geminiModels, testKey, testDraft, batchWait, BATCH_WAIT_DEFAULT } from './brain.js';
import { reactionsForChat } from './reactions.js';
import * as aikeys from './aikeys.js';
import { registerBrowserRoutes } from './browser-web.js';
import { addMessage } from './notify.js';
import * as approvals from './approvals.js';
import * as tools from './tools/index.js';
import * as google from './google.js';
import * as telegram from './channels/telegram.js';
import * as whatsapp from './channels/whatsapp.js';
import * as sms from './channels/sms.js';
import * as email from './channels/email.js';
import * as waagent from './channels/waagent.js';
import { appKey, sshExec } from './tools/ssh.js';
import { seal } from './crypto.js';
import { startScheduler, backupNow } from './scheduler.js';
import * as updates from './updates.js';
import * as address from './address.js';
import { normalizeSource, label as srcLabel } from './release-source.js';
import * as chats from './chats.js';
import * as files from './files.js';
import * as sitesMod from './sites.js';
import { serveSite } from './siteserve.js';

const PUB = path.join(APP_DIR, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon' };
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
};

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !(body instanceof Buffer);
  res.writeHead(status, { ...SEC_HEADERS, 'Cache-Control': 'no-store', ...(isObj ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(auth.httpErr(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const json = (buf) => { try { return buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { throw auth.httpErr(400, 'Bad JSON'); } };
const mask = (s) => s ? '••••' + String(s).slice(-4) : '';

function serveStatic(res, p, req) {
  const rel = p === '/' ? '/index.html' : p;
  const f = path.normalize(path.join(PUB, rel));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return false;
  const type = TYPES[path.extname(f)] || 'application/octet-stream';
  // Revalidate every time (cheap 304), so after an update the phone gets the new app.js/style.css at once.
  const st = fs.statSync(f), etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const hdrs = { ...SEC_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag };
  if (req && req.headers['if-none-match'] === etag) { res.writeHead(304, hdrs); return res.end(), true; }
  res.writeHead(200, hdrs);
  res.end(fs.readFileSync(f));
  return true;
}

// Owner-only file download, with byte ranges (iPhone Safari needs them to play audio).
function serveFile(req, res, id, forceDownload) {
  const f = files.fileRow(id);
  let st = null; try { st = f && fs.statSync(files.filePath(f)); } catch {}
  if (!f || !st) return send(res, 404, { error: 'File not found' });
  const inline = files.inlineOk(f.mime) && !forceDownload;
  const headers = { ...SEC_HEADERS, 'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Content-Type': inline ? f.mime : 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${f.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(f.name)}` };
  let start = 0, end = st.size - 1, status = 200;
  const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (rg && st.size > 0) {
    if (rg[1] === '') { start = Math.max(0, st.size - parseInt(rg[2] || '0', 10)); }
    else { start = parseInt(rg[1], 10); if (rg[2] !== '') end = Math.min(end, parseInt(rg[2], 10)); }
    if (start > end || start >= st.size) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = String(st.size ? end - start + 1 : 0);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || !st.size) return res.end();
  fs.createReadStream(files.filePath(f), { start, end }).pipe(res);
}

// ---------- API (owner only) ----------
const routes = [];
const R = (method, re, fn) => routes.push({ method, re, fn });

R('GET', /^\/api\/me$/, (c) => ({ csrf: c.session.csrf, version: VERSION, name: setting('assistant_name'), public_url: cfg.publicUrl, has_key: aikeys.usableKeys().length > 0, google: google.accounts().length, update_available: setting('update_available') }));
R('POST', /^\/api\/logout$/, (c) => { c.setCookie = auth.logout(c.req); return { ok: true }; });

// chats
function chatParam(v) { const id = parseInt(v || '0', 10); if (id && !chats.chatById(id)) throw auth.httpErr(404, 'That chat was deleted'); return id || chats.mainChatId(); }
R('GET', /^\/api\/chats$/, () => ({ chats: chats.listChats(), main: chats.mainChatId() }));
R('POST', /^\/api\/chats$/, (c) => ({ chat: chats.createChat(c.body.title) }));
R('POST', /^\/api\/chats\/(\d+)$/, (c) => ({ chat: chats.renameChat(parseInt(c.m[1], 10), c.body.title) }));
R('POST', /^\/api\/chats\/(\d+)\/delete$/, (c) => chats.deleteChat(parseInt(c.m[1], 10)));
R('POST', /^\/api\/chats\/(\d+)\/main$/, (c) => { chats.setMainChat(parseInt(c.m[1], 10)); return { ok: true, main: chats.mainChatId() }; });

R('GET', /^\/api\/chat$/, (c) => {
  const chatId = chatParam(c.q.get('chat'));
  const after = parseInt(c.q.get('after') || '0', 10);
  const msgs = after ? all('SELECT * FROM messages WHERE chat_id=? AND id>? ORDER BY id LIMIT 300', chatId, after) : all('SELECT * FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 80', chatId).reverse();
  const fmap = files.filesForMessages(msgs.map(m => m.id));
  const jobs = all("SELECT id,channel,status,title,progress,steps,created,updated,parent_job FROM jobs WHERE chat_id=? AND (status IN ('queued','running','cancelling') OR updated > ?) ORDER BY id DESC LIMIT 10", chatId, now() - 120000);
  const events = jobs.length ? all(`SELECT * FROM job_events WHERE job_id IN (${jobs.map(j => j.id).join(',')}) ORDER BY id`) : [];
  const ap = all("SELECT id,status FROM approvals WHERE id IN (SELECT json_extract(meta,'$.approval') FROM messages WHERE meta IS NOT NULL ORDER BY id DESC LIMIT 200)");
  const chat = chats.chatById(chatId);
  return { chat: { id: chat.id, title: chat.title, main: chat.id === chats.mainChatId() }, messages: msgs.map(m => ({ id: m.id, role: m.role, channel: m.channel, text: m.text, meta: m.meta ? JSON.parse(m.meta) : null, job_id: m.job_id, ts: m.ts, files: fmap[m.id] || undefined })), jobs, events, approval_status: Object.fromEntries(ap.map(a => [a.id, a.status])), pending: approvals.pending().length, reactions: reactionsForChat(chatId) };   // 2.3.15: reactions on his messages
});
R('POST', /^\/api\/chat$/, (c) => {
  const text = String(c.body.text || '').trim();
  const fileIds = Array.isArray(c.body.files) ? c.body.files.map(String).slice(0, 10) : [];
  if (!text && !fileIds.length) throw auth.httpErr(400, 'Empty message');
  const chatId = chatParam(c.body.chat_id);
  const d = !fileIds.length && approvals.parseDecision(text);
  if (d && d.ask) { addMessage('owner', 'web', text, null, null, chatId); addMessage('notice', 'web', d.ask, null, null, chatId); return { ok: true, ask: d.ask }; }   // 2.3.16
  if (d) { return approvals.decide(d.id, d.yes, 'web').then(r => { addMessage('notice', 'web', r.message, null, null, chatId); return { ok: true, decided: r }; }); }
  return { job: startJob({ text: text.slice(0, 20000), channel: 'web', chatId, files: fileIds }), chat_id: chatId };
});
R('POST', /^\/api\/jobs\/(\d+)\/cancel$/, (c) => ({ ok: cancelJob(parseInt(c.m[1], 10)) }));

R('GET', /^\/api\/approvals$/, (c) => {
  approvals.expire();
  const st = c.q.get('status') || 'pending';
  const rows = st === 'all' ? all('SELECT * FROM approvals ORDER BY id DESC LIMIT 100') : all("SELECT * FROM approvals WHERE status='pending' ORDER BY id");
  return { approvals: rows.map(a => ({ id: a.id, tool: a.tool, summary: a.summary, status: a.status, created: a.created, expires: a.expires, decided_via: a.decided_via, result: a.result ? redact(a.result).slice(0, 600) : null })) };
});
R('POST', /^\/api\/approvals\/(\d+)$/, async (c) => approvals.decide(parseInt(c.m[1], 10), !!c.body.yes, 'web'));
R('GET', /^\/api\/audit$/, (c) => {
  const before = parseInt(c.q.get('before') || '0', 10) || 9e15;
  return { audit: all('SELECT * FROM audit WHERE id<? ORDER BY id DESC LIMIT 100', before) };
});

// settings / brain
const PLAIN_KEYS = ['assistant_name', 'provider', 'model', 'openai_base_url', 'openai_model', 'max_steps', 'max_minutes', 'max_parallel', 'image_model', 'update_repo', 'history_messages', 'timezone', 'notify_channel', 'morning_summary', 'morning_time', 'continue_after_approval', 'update_url', 'update_source', 'backup_keep', 'backup_drive_account', 'owner_emails', 'reactions', 'batch_wait_ms'];
R('GET', /^\/api\/settings$/, () => {
  const s = allSettings(); const o = {};
  for (const k of PLAIN_KEYS) o[k] = s[k];
  o.batch_wait_ms = String(batchWait()); o.batch_wait_default = String(BATCH_WAIT_DEFAULT); o.reactions = setting('reactions');   // 2.3.15
  return { settings: o, has_gemini_key: aikeys.geminiKeys().length > 0, has_openai_key: hasSecret('openai_api_key'), tools: tools.toolList(), version: VERSION };
});
R('POST', /^\/api\/settings$/, (c) => {
  const b = c.body;
  for (const k of PLAIN_KEYS) if (b[k] !== undefined) {
    let v = String(b[k]).trim().slice(0, 500);
    if (k === 'model' && v && !/^[a-z0-9][a-z0-9.\-]*$/i.test(v)) throw auth.httpErr(400, 'Model names look like gemini-3.6-flash');
    if (k === 'timezone') { try { new Intl.DateTimeFormat('en', { timeZone: v }); } catch { throw auth.httpErr(400, 'Unknown time zone'); } }
    if (k === 'morning_time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw auth.httpErr(400, 'Time like 07:30');
    if (k === 'update_url' && v && !/^https:\/\//.test(v)) throw auth.httpErr(400, 'Update link must be https');
    if (k === 'update_source') {
      if (v) v = normalizeSource(v);
      if (v && !/^https:\/\/[^\s/]+\.[^\s/]+(\/[^\s]*)?$/.test(v)) throw auth.httpErr(400, 'Update source: an https address like https://updates.example.com, or blank for the default');
      if (v === normalizeSource(cfg.updateSource)) v = '';
      if (v !== setting('update_source')) { audit('owner', 'update.source', v || 'default (' + cfg.updateSource + ')'); setSetting('update_available', ''); }
    }
    if (k === 'reactions') v = /^(0|off|false|no)$/i.test(v) ? '0' : '1';   // 2.3.15
    if (k === 'batch_wait_ms') { const n = parseInt(v, 10); if (!(n >= 0 && n <= 10000)) throw auth.httpErr(400, 'Wait for more messages: 0 to 10 seconds'); v = String(n); }
    if (k === 'max_parallel') { const n = parseInt(v, 10); if (!(n >= 1 && n <= 6)) throw auth.httpErr(400, 'Jobs at the same time: 1 to 6'); v = String(n); }
    if (k === 'image_model' && v && !/^[a-z0-9][a-z0-9.\-]*$/i.test(v)) throw auth.httpErr(400, 'Model names look like gemini-3.1-flash-image');
    if (k === 'update_repo') { v = v.replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, ''); if (v && !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(v)) throw auth.httpErr(400, 'Update source: a GitHub repo like owner/name, or blank for the default'); if (v !== setting('update_repo')) { audit('owner', 'update.source', v || 'default'); setSetting('update_available', ''); } }
    setSetting(k, v);
  }
  if (b.gemini_api_key !== undefined) { const v = String(b.gemini_api_key).trim(); setSecret('gemini_api_key', v); aikeys.setMainGeminiKey(v); audit('owner', 'secret.gemini_key', v ? 'saved' : 'removed'); }
  if (b.openai_api_key !== undefined) { setSecret('openai_api_key', String(b.openai_api_key).trim()); audit('owner', 'secret.openai_key', b.openai_api_key ? 'saved' : 'removed'); }
  audit('owner', 'settings.changed', Object.keys(b).filter(k => !/key/.test(k)).join(','));
  return { ok: true };
});
// 2.3: AI keys (names, order, status; key values are write-only)
const keyErr = (e) => { if (e.status) throw auth.httpErr(e.status, e.message); throw e; };
R('GET', /^\/api\/brain\/keys$/, () => ({ keys: aikeys.listKeys(), in_use: aikeys.inUse(), default_model: setting('model'), groq: { base_url: aikeys.GROQ_BASE, model: aikeys.GROQ_MODEL } }));
R('POST', /^\/api\/brain\/keys$/, (c) => { try { return { key: aikeys.addKey(c.body), keys: aikeys.listKeys() }; } catch (e) { keyErr(e); } });
R('POST', /^\/api\/brain\/keys\/(\d+)$/, (c) => { try { return { key: aikeys.updateKey(c.m[1], c.body), keys: aikeys.listKeys() }; } catch (e) { keyErr(e); } });
R('POST', /^\/api\/brain\/keys\/(\d+)\/delete$/, (c) => { try { aikeys.removeKey(c.m[1]); return { ok: true, keys: aikeys.listKeys() }; } catch (e) { keyErr(e); } });
R('POST', /^\/api\/brain\/keys\/(\d+)\/move$/, (c) => { try { return { keys: aikeys.moveKey(c.m[1], c.body.dir === 'up' ? 'up' : 'down') }; } catch (e) { keyErr(e); } });
// 2.3.9: Test what is typed in the Add-key / edit sheet without saving anything (10 a minute).
const draftTests = [];
export function resetKeyTestLimit() { draftTests.length = 0; }   // tests only
R('POST', /^\/api\/brain\/keys\/test$/, async (c) => {
  const t = Date.now();
  while (draftTests.length && draftTests[0] <= t - 60000) draftTests.shift();
  if (draftTests.length >= 10) throw auth.httpErr(429, 'That was a lot of tests in one minute. Wait a minute, then tap Test again.');
  draftTests.push(t);
  try { return await testDraft(c.body); } catch (e) { keyErr(e); }
});
R('POST', /^\/api\/brain\/keys\/(\d+)\/test$/, async (c) => { try { const r = await testKey(c.m[1]); return { ...r, key: aikeys.publicKey(aikeys.keyRow(c.m[1])) }; } catch (e) { keyErr(e); } });
// 2.2's "Check key": tests the first Gemini key
R('POST', /^\/api\/brain\/test$/, async () => {
  const g = aikeys.listRows().find(r => r.kind === 'gemini' && r.active) || aikeys.listRows()[0];
  if (!g) throw auth.httpErr(400, 'No AI key saved');
  const r = await testKey(g.id);
  return { ok: r.ok, message: r.message, model: r.model, model_listed: r.model_listed, flash_models: (r.models || []).filter(n => /flash|lite/.test(n)).slice(0, 12), models: r.models };
});
R('POST', /^\/api\/tools$/, (c) => { tools.setEnabled(String(c.body.name), !!c.body.enabled); return { ok: true }; });

// google
R('GET', /^\/api\/google$/, () => ({
  client_id: setting('google_client_id'), has_secret: hasSecret('google_client_secret'), redirect_uri: google.redirectUri(),
  javascript_origin: cfg.publicUrl, accounts: google.accounts(),
  enable_apis_link: 'https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com,docs.googleapis.com,sheets.googleapis.com,people.googleapis.com',
}));
R('POST', /^\/api\/google\/client$/, (c) => {
  const id = String(c.body.client_id || '').trim();
  if (id && !/\.apps\.googleusercontent\.com$/.test(id)) throw auth.httpErr(400, 'The client ID ends with .apps.googleusercontent.com');
  if (id) setSetting('google_client_id', id);
  if (c.body.client_secret) setSecret('google_client_secret', String(c.body.client_secret).trim());
  audit('owner', 'google.client_saved', id);
  return { ok: true };
});
R('POST', /^\/api\/google\/start$/, () => ({ url: google.authUrl() }));
R('POST', /^\/api\/google\/(\d+)\/remove$/, (c) => { const a = get('SELECT email FROM google_accounts WHERE id=?', c.m[1]); run('DELETE FROM google_accounts WHERE id=?', c.m[1]); audit('owner', 'google.account_removed', a?.email || c.m[1]); return { ok: true }; });

// channels
R('GET', /^\/api\/channels$/, () => ({
  telegram: telegram.status(),
  email: { enabled: setting('email_channel') === '1', account: email.account(), accounts: google.accounts().map(a => a.email) },
  sms: { ...sms.status(), webhook_url: hasSecret('sms_hook_secret') ? cfg.publicUrl + '/hook/sms/' + '•••' : '' },
  whatsapp: { ...whatsapp.status(), verify_token: secret('wa_verify_token') ? whatsapp.verifyToken() : '' },
  notify_channel: setting('notify_channel'),
  wa_agent: waagent.status(),
}));
// WhatsApp Agent (2.2): the key goes into the Vault (never sent back), a toggle starts/stops the long-poll worker.
R('GET', /^\/api\/wa-agent$/, () => waagent.status());
R('POST', /^\/api\/wa-agent$/, (c) => waagent.setEnabled(!!c.body.enabled));
R('POST', /^\/api\/wa-agent\/react$/, (c) => waagent.setReact({ mode: c.body.mode, on: c.body.on === undefined ? undefined : !!c.body.on, emoji: c.body.emoji }));
R('POST', /^\/api\/wa-agent\/key$/, (c) => { waagent.saveKey(c.body.key); return waagent.status(); });
R('POST', /^\/api\/wa-agent\/key\/remove$/, () => { waagent.removeKey(); return waagent.status(); });
R('POST', /^\/api\/wa-agent\/test$/, async () => {
  try { await waagent.sendOwner('Test from your assistant ✅ Write here any time; I answer in this chat.', { wait: true }); }
  catch (e) { throw auth.httpErr(400, e.message); }
  return { ok: true };
});
R('POST', /^\/api\/telegram\/setup$/, async (c) => telegram.setup(c.body.token));
R('POST', /^\/api\/telegram\/disconnect$/, async () => { await telegram.disconnect(); return { ok: true }; });
R('POST', /^\/api\/telegram\/test$/, async () => { await telegram.sendOwner('Test from your assistant ✅'); return { ok: true }; });
R('POST', /^\/api\/email$/, (c) => {
  if (c.body.enabled !== undefined) { setSetting('email_channel', c.body.enabled ? '1' : '0'); if (c.body.enabled) setSetting('email_enabled_at', now() - 5 * 60000); }
  if (c.body.account !== undefined) setSetting('email_account', String(c.body.account));
  audit('owner', 'email.channel', JSON.stringify(c.body));
  return { ok: true };
});
R('POST', /^\/api\/sms\/setup$/, async (c) => sms.setup(c.body));
R('POST', /^\/api\/sms\/test$/, async () => sms.sendOwner('Test from your assistant ✅'));
R('POST', /^\/api\/whatsapp\/prepare$/, () => ({ verify_token: whatsapp.verifyToken(), webhook_url: cfg.publicUrl + '/hook/whatsapp' }));
R('POST', /^\/api\/whatsapp\/setup$/, async (c) => whatsapp.setup(c.body));
R('POST', /^\/api\/whatsapp\/test$/, async () => whatsapp.sendOwner('Test from your assistant ✅'));
R('GET', /^\/api\/qr$/, async (c) => { const svg = await auth.qrSvg(String(c.q.get('text') || '').slice(0, 1000)); return { svg }; });

// servers
R('GET', /^\/api\/servers$/, () => { let pub = ''; try { pub = appKey().pub; } catch (e) { pub = '(could not make a key: ' + e.message + ')'; } return { public_key: pub, servers: all('SELECT id,name,host,port,user,key_kind,notes,added FROM servers ORDER BY name') }; });
R('POST', /^\/api\/servers$/, (c) => {
  const b = c.body;
  const name = String(b.name || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(name)) throw auth.httpErr(400, 'Name: letters, numbers, dash');
  const host = String(b.host || '').trim();
  if (!/^[A-Za-z0-9.\-:\[\]]+$/.test(host)) throw auth.httpErr(400, 'Host must be a hostname or IP');
  const user = String(b.user || '').trim();
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user)) throw auth.httpErr(400, 'Bad user name');
  const port = parseInt(b.port || '22', 10);
  let kind = 'app', key = null;
  if (b.private_key && String(b.private_key).includes('PRIVATE KEY')) { kind = 'pasted'; key = seal(String(b.private_key).trim()); }
  run(`INSERT INTO servers(name,host,port,user,key_kind,key_enc,notes,added) VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET host=excluded.host, port=excluded.port, user=excluded.user, key_kind=excluded.key_kind, key_enc=COALESCE(excluded.key_enc, servers.key_enc), notes=excluded.notes`,
      name, host, port, user, kind, key, String(b.notes || '').slice(0, 300), now());
  audit('owner', 'server.saved', `${name} ${user}@${host}:${port} (${kind} key)`);
  return { ok: true };
});
R('POST', /^\/api\/servers\/(\d+)\/remove$/, (c) => { const s = get('SELECT name FROM servers WHERE id=?', c.m[1]); run('DELETE FROM servers WHERE id=?', c.m[1]); audit('owner', 'server.removed', s?.name); return { ok: true }; });
R('POST', /^\/api\/servers\/(\d+)\/test$/, async (c) => { const s = get('SELECT * FROM servers WHERE id=?', c.m[1]); if (!s) throw auth.httpErr(404, 'No such server'); return sshExec(s, 'uname -a && uptime', 25); });

registerBrowserRoutes(R);   // 2.3.8: Settings → Browser & logins, and the live browser page

// platforms vault
R('GET', /^\/api\/platforms$/, () => ({ platforms: all('SELECT id,name,kind,base_url,extra,added FROM platforms ORDER BY name').map(p => ({ ...p, token: '••••(saved)' })) }));
R('POST', /^\/api\/platforms$/, (c) => {
  const b = c.body;
  const name = String(b.name || b.kind || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(name)) throw auth.httpErr(400, 'Name: letters, numbers, dash');
  if (!b.token) throw auth.httpErr(400, 'Paste the token');
  const extra = b.account_id ? JSON.stringify({ account_id: String(b.account_id).trim() }) : null;
  run(`INSERT INTO platforms(name,kind,base_url,extra,token,added) VALUES(?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET kind=excluded.kind, base_url=excluded.base_url, extra=excluded.extra, token=excluded.token`,
      name, String(b.kind || name), String(b.base_url || '').trim(), extra, seal(String(b.token).trim()), now());
  audit('owner', 'vault.saved', name);
  if (name === waagent.VAULT_NAME) waagent.keyChanged();
  return { ok: true };
});
R('POST', /^\/api\/platforms\/(\d+)\/remove$/, (c) => { const p = get('SELECT name FROM platforms WHERE id=?', c.m[1]); run('DELETE FROM platforms WHERE id=?', c.m[1]); audit('owner', 'vault.removed', c.m[1]); if (p?.name === waagent.VAULT_NAME) waagent.keyChanged(); return { ok: true }; });

// tasks, memory, schedules, projects
R('GET', /^\/api\/tasks$/, () => ({
  tasks: all("SELECT * FROM tasks ORDER BY status='done', COALESCE(due, 9e15), id DESC LIMIT 200"),
  memory: all('SELECT * FROM memory ORDER BY id DESC LIMIT 200'),
  schedules: all('SELECT * FROM schedules WHERE active=1 ORDER BY next_run'),
  inbox: all('SELECT * FROM inbox ORDER BY id DESC LIMIT 30'),
}));
R('POST', /^\/api\/tasks$/, (c) => { const due = c.body.due ? Date.parse(c.body.due) : null; run('INSERT INTO tasks(title,due,remind,status,created) VALUES(?,?,1,?,?)', String(c.body.title || '').slice(0, 300), isNaN(due) ? null : due, 'open', now()); return { ok: true }; });
R('POST', /^\/api\/tasks\/(\d+)\/done$/, (c) => { run("UPDATE tasks SET status='done' WHERE id=?", c.m[1]); return { ok: true }; });
R('POST', /^\/api\/memory\/(\d+)\/remove$/, (c) => { run('DELETE FROM memory WHERE id=?', c.m[1]); audit('owner', 'memory.removed', c.m[1]); return { ok: true }; });
R('POST', /^\/api\/schedules\/(\d+)\/cancel$/, (c) => { run('UPDATE schedules SET active=0 WHERE id=?', c.m[1]); return { ok: true }; });
R('GET', /^\/api\/projects$/, async () => {
  const p = await tools.byName('project_list').run({}); const s = await tools.byName('sites_list').run({});
  return { ...p, ...s, workspace: cfg.workspace };
});
// 2.3.7: Sites list → Delete. His tap (after "Are you sure?" on the page) is the approval; confirm:true must be sent.
R('POST', /^\/api\/sites\/remove$/, async (c) => {
  if (c.body.confirm !== true) throw auth.httpErr(400, 'Not confirmed. Nothing was deleted.');
  try { return await sitesMod.removeSite({ platform: c.body.platform, name: c.body.name, action: c.body.action }, 'owner'); }
  catch (e) { audit('owner', 'site.remove_failed', `${String(c.body.platform || '')} ${String(c.body.name || '')}: ${e.message}`.slice(0, 300)); throw auth.httpErr(e.kind === 'permission' ? 403 : 400, e.message); }
});

// updates, backups, security
R('GET', /^\/api\/update$/, () => { const list = updates.updateSources(); return { current: VERSION, available: setting('update_available'), notes: setting('update_notes'), url: updates.updateUrl(), repo: updates.updateRepo(), default_source: cfg.releaseBase,
  source: setting('update_source'), source_default: cfg.updateSource, sources: list.map(srcLabel), checked_from: setting('update_checked_from'), log: updates.updateLog() }; });
R('POST', /^\/api\/update\/check$/, async () => updates.checkUpdate(true));
R('POST', /^\/api\/update\/apply$/, () => updates.applyUpdate());
// 2.3.19: Settings → Main address (signed in = the owner; every POST also needs the session's CSRF header)
R('GET', /^\/api\/address$/, () => address.addressInfo());
R('POST', /^\/api\/address\/check$/, async (c) => address.checkAddress(c.body.address));
R('POST', /^\/api\/address\/switch$/, async (c) => address.switchAddress(c.body.address, c.body.confirm));
R('POST', /^\/api\/backup\/now$/, () => ({ file: path.basename(backupNow()) }));
R('GET', /^\/api\/backups$/, () => { const d = path.join(cfg.dataDir, 'backups'); let f = []; try { f = fs.readdirSync(d).filter(x => x.endsWith('.db')).sort().reverse(); } catch {} return { backups: f, dir: d }; });
R('POST', /^\/api\/password$/, (c) => { auth.changePassword(c.ip, c.body); return { ok: true }; });
R('POST', /^\/api\/sessions\/revoke$/, (c) => { run('DELETE FROM sessions WHERE id<>?', c.session.id); audit('owner', 'sessions.revoked', ''); return { ok: true }; });

// ---------- request handler ----------
async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const ip = auth.clientIp(req);
  try {
    if (p === '/healthz') return send(res, 200, { ok: true, version: VERSION });
    // 2.3.19: "does this address reach this same assistant?" — answers only the one-time code this server just made
    const am = /^\/api\/address-check\/([A-Za-z0-9]{1,40})$/.exec(p);
    if (am && req.method === 'GET') { const a = address.nonceAnswer(am[1]); return a ? send(res, 200, a) : send(res, 404, { error: 'Not found' }); }

    // Webhooks (each verifies its own secret)
    if (p === '/hook/telegram' && req.method === 'POST') { const r = await telegram.handle(json(await readBody(req, 1e6)), req.headers); return send(res, r.status, { ok: r.status === 200 }); }
    if (p === '/hook/whatsapp' && req.method === 'GET') { const r = whatsapp.verifyGet(Object.fromEntries(u.searchParams)); return send(res, r.status, r.body, { 'Content-Type': 'text/plain' }); }
    if (p === '/hook/whatsapp' && req.method === 'POST') { const r = await whatsapp.handle(await readBody(req, 1e6), req.headers); return send(res, r.status, { ok: r.status === 200 }); }
    const sm = /^\/hook\/sms\/([A-Za-z0-9]+)$/.exec(p);
    if (sm && req.method === 'POST') { const r = await sms.handle(sm[1], await readBody(req, 1e6), req.headers); return send(res, r.status, { ok: r.status === 200 }); }

    // Public auth endpoints
    if (p === '/api/hello') return send(res, 200, { setup_needed: auth.setupNeeded(), version: VERSION, name: setting('assistant_name'), logged_in: !!auth.sessionFrom(req) });
    if (p === '/api/setup/start' && req.method === 'POST') return send(res, 200, await auth.setupStart(ip, json(await readBody(req))));
    if (p === '/api/setup/finish' && req.method === 'POST') {
      const r = auth.setupFinish(ip, json(await readBody(req)));
      const s = auth.newSession(ip, req.headers['user-agent']);
      return send(res, 200, { ...r, csrf: s.csrf }, { 'Set-Cookie': s.cookie });
    }
    if (p === '/api/login' && req.method === 'POST') { const s = auth.login(ip, req.headers['user-agent'], json(await readBody(req))); return send(res, 200, { ok: true, csrf: s.csrf }, { 'Set-Cookie': s.cookie }); }

    if (p === '/oauth/google/callback') {
      const s = auth.sessionFrom(req);
      if (!s) return send(res, 403, 'Please log in to your assistant first, then add the Google account again.', { 'Content-Type': 'text/plain; charset=utf-8' });
      try { const email = await google.handleCallback(Object.fromEntries(u.searchParams)); return send(res, 302, '', { Location: '/#/settings/google?added=' + encodeURIComponent(email) }); }
      catch (e) { return send(res, 302, '', { Location: '/#/settings/google?error=' + encodeURIComponent(e.message.slice(0, 300)) }); }
    }

    if (p.startsWith('/api/')) {
      const session = auth.sessionFrom(req);
      if (!session) return send(res, 401, { error: 'Not logged in' });
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (req.headers['x-csrf'] !== session.csrf) return send(res, 403, { error: 'Session check failed. Reload the page.' });
        // Uploads are the one raw-bytes route (same login + CSRF check as everything else).
        if (p === '/api/files' && req.method === 'POST') {
          if (Number(req.headers['content-length'] || 0) > files.MAX_FILE) { res.setHeader('Connection', 'close'); return send(res, 413, { error: 'File too large (max 20 MB)' }); }
          let buf;
          try { buf = await readBody(req, files.MAX_FILE); } catch (e) { if (e.status === 413) { res.setHeader('Connection', 'close'); return send(res, 413, { error: 'File too large (max 20 MB)' }); } throw e; }
          let name = 'file'; try { name = decodeURIComponent(String(req.headers['x-file-name'] || u.searchParams.get('name') || 'file')); } catch {}
          const chatId = parseInt(u.searchParams.get('chat') || '0', 10) || null;
          const f = files.saveUpload(buf, req.headers['content-type'], name, chatId && chats.chatById(chatId) ? chatId : null);
          audit('owner', 'file.upload', `${f.kind} ${f.size} bytes`);
          return send(res, 200, { file: f });
        }
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'JSON only' });
      }
      const fm = /^\/api\/files\/([a-f0-9]{32})$/.exec(p);
      if (fm && (req.method === 'GET' || req.method === 'HEAD')) return serveFile(req, res, fm[1], u.searchParams.get('download') === '1');
      const wm = /^\/api\/files\/([a-f0-9]{32})\/wave$/.exec(p);
      if (wm && req.method === 'GET') {
        const f = files.fileRow(wm[1]);
        if (!f) return send(res, 404, { error: 'File not found' });
        if (f.kind !== 'audio') return send(res, 400, { error: 'Not a voice note' });
        return send(res, 200, files.audioWave(f));
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(p);
        if (!m) continue;
        const c = { req, res, m, q: u.searchParams, session, ip, body: req.method === 'GET' ? {} : json(await readBody(req)) };
        const out = await r.fn(c);
        return send(res, 200, out ?? { ok: true }, c.setCookie ? { 'Set-Cookie': c.setCookie } : {});
      }
      return send(res, 404, { error: 'No such API' });
    }
    if (p === '/sites' || p.startsWith('/sites/')) { if (serveSite(req, res)) return; }   // 2.3.16: published sites, with a 404 page
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(res, p, req)) return;
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) log('error', p, e.stack || e.message);
    return send(res, status, { error: redact(e.message || 'Error') });
  }
}

export function start() {
  loadMasterKey(cfg.dataDir);
  openDb();
  aikeys.ensureKeys();
  tools.ALL; approvals.bindTools(tools);
  auth.ensureSetupCode();
  recoverJobs();
  try { files.purgeUnsent(); } catch (e) { log('purge files', e.message); }
  for (const d of [cfg.workspace, cfg.sitesDir]) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 300000;   // phones uploading a 20 MB file on a slow line
  server.listen(cfg.port, cfg.host, () => log(`My Assistant ${VERSION} listening on ${cfg.host}:${cfg.port} — ${cfg.publicUrl}`));
  const timer = startScheduler();
  try { waagent.start(); } catch (e) { log('wa agent start', e.message); }
  // 2.3.19: after a switch of the main address, the webhooks follow it (Telegram is asked at every start)
  setTimeout(() => { address.syncAfterStart({ telegram, sms, whatsapp }).then(st => { if (st.length) log('address:', st.join(' | ')); }).catch(e => log('address sync', e.message)); }, cfg.testMode ? 50 : 3000).unref();
  server.on('close', () => waagent.stop(true));
  const stop = () => { clearInterval(timer); waagent.stop(true); server.close(); setTimeout(() => process.exit(0), 500); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  return server;
}

// Start when run directly. Compare real paths: the installer runs it through the /opt/myassistant/current symlink.
const isMain = (() => { try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(new URL(import.meta.url)); } catch { return false; } })();
if (isMain) start();
