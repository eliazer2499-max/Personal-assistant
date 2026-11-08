// 2.3.16 (Abish, Nov 8 2026): replies JSON never as text, one confirmation, a reaction is a reaction, a picture not
// pasted code, approvals without codes for one, a 404 page for sites, screenshots after the splash.
// Against fakes and a fake model — not his server, the real WhatsApp or Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fakeServer } from './fakes.js';

const LOGS = [];
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { LOGS.push(a.map(String).join(' ')); if (process.env.SHOW_LOGS) orig(...a); }; }
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v2316b-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(20); } throw new Error('timed out waiting for ' + what); }

// ---- WhatsApp Agent Platform mock (as in the 2.3.7 tests)
const KEY = 'WAAGENTkey-' + crypto.randomBytes(12).toString('hex');
const AP = { feed: [], sent: [], seq: 100 };
function push(message) { AP.seq++; AP.feed.push({ seq: AP.seq, message: { timestamp: String(Math.floor(Date.now() / 1000)), ...message } }); }
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  const J = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== 'Bearer ' + KEY) return J({ error: { message: 'Invalid OAuth access token.', code: 190 } }, 401);
  if (p === '/agent/v1/updates') {
    const offset = u.searchParams.has('offset') ? parseInt(u.searchParams.get('offset'), 10) : null;
    const pick = () => AP.feed.filter(x => offset === null || x.seq >= offset);
    let items = pick(); const end = Date.now() + Math.min(1000, Number(u.searchParams.get('timeout') || 0) * 1000);
    while (!items.length && Date.now() < end) { await sleep(20); items = pick(); }
    if (!items.length) { res.writeHead(204); return res.end(); }
    return J({ object: 'whatsapp_agent_platform', entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages: items.map(x => x.message) } }] }], next_offset: items.at(-1).seq + 1 });
  }
  if (p === '/agent/v1/statuses') return J({ success: true });
  if (p === '/agent/v1/messages') { AP.sent.push(JSON.parse(body)); return J({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.out' + AP.sent.length }] }); }
  J({ error: { message: 'mock: no route ' + p } }, 404);
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const MOCK = 'http://127.0.0.1:' + mock.address().port;
const F = await fakeServer();     // Telegram + Graph (his WhatsApp number)

const PORT = 26300 + Math.floor(Math.random() * 150);
Object.assign(process.env, {
  MA_DATA_DIR: T + '/data', MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/sites', MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_RELEASE_BASE: 'http://127.0.0.1:1',
  MA_MOCK_MODULE: new URL('./mock-model-v2316.js', import.meta.url).href,
  MA_TELEGRAM_BASE: F.url, MA_GRAPH_BASE: F.url,
  MA_WA_AGENT_BASE: MOCK + '/agent/v1', MA_WA_AGENT_POLL_TIMEOUT: '1', MA_WA_AGENT_MIN_INTERVAL_MS: '30', MA_WA_AGENT_WINDOW_MS: '2000', MA_WA_AGENT_BACKOFF_MS: '50', MA_WA_AGENT_CONFLICT_MS: '200',
});
const { start } = await import('../src/server.js');
const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const brain = await import('../src/brain.js');
const telegram = await import('../src/channels/telegram.js');
const whatsapp = await import('../src/channels/whatsapp.js');
const waagent = await import('../src/channels/waagent.js');
const emoji = await import('../src/emoji.js');
const server = start();
await sleep(300);
db.setSetting('setup_done', '1'); db.setSecret('gemini_api_key', 'AIzaFAKE' + 'x'.repeat(30));
const BASE = 'http://127.0.0.1:' + PORT;
const S = auth.newSession('127.0.0.1', 'test');
const cookie = S.cookie.split(';')[0], csrf = S.csrf;
async function call(p, body) {
  const r = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-CSRF': csrf } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
}
const job = (id) => db.get('SELECT * FROM jobs WHERE id=?', id);
async function waitJob(id, ms = 10000) { return until(() => { const j = job(id); return ['done', 'error', 'cancelled'].includes(j.status) ? j : null; }, ms, 'job ' + id); }
async function newChat() { const r = await call('/api/chats', {}); return r.j.chat.id; }
const say = async (chat, text) => { const r = await call('/api/chat', { text, chat_id: chat }); assert.equal(r.status, 200, r.text); return r.j.job; };
const msgs = (chat) => db.all("SELECT id,role,text FROM messages WHERE chat_id=? AND role IN ('owner','assistant') ORDER BY id", chat);
const replies = (chat) => msgs(chat).filter(m => m.role === 'assistant').map(m => m.text);

const setWait = (ms) => { db.setSetting('batch_wait_ms', String(ms)); db.setSetting('batch_max_ms', ''); };
await import('./mock-model-v2316.js');
const M = globalThis.__M2316;
const R = await import('../src/replies.js');
const tidy = await import('../src/tidy.js');
const approvals = await import('../src/approvals.js');
const notify = await import('../src/notify.js');
const { LEAK } = await import('./mock-model-v2316.js');
const SITES = T + '/sites';
const mkSite = (n, files = { 'index.html': '<h1>' + n + '</h1>' }) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(SITES, n, f)), { recursive: true }); fs.writeFileSync(path.join(SITES, n, f), c); } };
const noJson = (s) => !/"replies"|\{"to"|"to":\s*\[/.test(String(s));
const pendingIds = () => db.all("SELECT id FROM approvals WHERE status='pending'").map(r => r.id);
const clearApprovals = () => db.run("UPDATE approvals SET status='denied' WHERE status='pending'");
test.after(() => { waagent.stop(); server.close(); mock.close(); F.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });
setWait(0);

// ---------------------------------------------------------------- 1) the replies JSON never reaches him as text
test('replies JSON → plain words: his exact Nov 8 string, fenced, wrapped, broken, other shapes; real JSON he asked for stays', () => {
  const live = 'Site is live at https://ai.louisb.vip/sites/soft-tech-private-7f9a3/';
  assert.equal(R.repliesToPlain(LEAK).text, live);
  assert.equal(R.repliesToPlain('```json\n' + LEAK + '\n```').text, live);
  assert.equal(R.repliesToPlain('Here you go:\n```\n' + LEAK + '\n```').text, live);
  assert.equal(R.repliesToPlain('Done! ' + LEAK).text, live);
  assert.equal(R.repliesToPlain('{"replies":[{"to":[3],"text":"Site is live at x"').text, 'Site is live at x', 'cut-off JSON');
  assert.equal(R.repliesToPlain('{"replies":[{"text":"a\nb","to":"1"},{"react":"❤️","to":[2]},{"to":[4],"text":"c"}]}').text, 'a\nb\n\nc', 'raw newline, keys in any order, "to" as a string');
  assert.equal(R.repliesToPlain('[{"to":[1],"text":"one"},{"to":[2],"text":"two"}]').text, 'one\n\ntwo', 'a bare list');
  assert.equal(R.repliesToPlain('{"replies":[{"to":[1],"react":"❤️"}]}').text, '', 'reaction only → no words');
  assert.deepEqual(R.repliesToPlain('{"replies":[{"to":[1],"react":"❤️"}]}').reacts, ['❤️']);
  for (const plain of ['Site is live.', '{"name":"demo","port":8080}', 'Use [1, 2] as the list', '```json\n{"ok":true}\n```', '[{"id":1,"title":"x"}]'])
    assert.equal(R.repliesToPlain(plain).text, plain, 'not the replies format: unchanged: ' + plain);
  assert.equal(R.looksLikeReplies(LEAK), true); assert.equal(R.looksLikeReplies('{"name":"x"}'), false);
});

test('his Nov 8 bug, web: after YES the follow-up answer is plain words, never the JSON', async () => {
  mkSite('soft-tech-private-7f9a3'); clearApprovals(); M.mode = 'leak';
  const chat = await newChat();
  await waitJob(await say(chat, 'UNPUB soft-tech-private-7f9a3'));
  const ap = db.get("SELECT * FROM approvals WHERE status='pending' ORDER BY id DESC");
  const r = await call('/api/approvals/' + ap.id, { yes: true }); assert.equal(r.j.ok, true, r.text);
  const follow = await until(() => db.get("SELECT * FROM jobs WHERE parent_approval=? AND status='done'", ap.id), 8000, 'the job after his YES');
  assert.equal(follow.result, 'Site is live at https://ai.louisb.vip/sites/soft-tech-private-7f9a3/');
  const texts = db.all("SELECT text FROM messages WHERE role IN ('assistant','notice')").map(m => m.text);
  assert.ok(texts.includes('Site is live at https://ai.louisb.vip/sites/soft-tech-private-7f9a3/'));
  assert.ok(texts.every(noJson), JSON.stringify(texts.filter(t => !noJson(t))));
  assert.ok(db.get("SELECT 1 AS x FROM audit WHERE action='reply.json_unwrapped'"));
});

test('one message answered in a fenced replies JSON → plain words (web)', async () => {
  const chat = await newChat();
  const j = await waitJob(await say(chat, 'JSONSINGLE hi'));
  assert.equal(j.result, 'Plain answer');
  assert.deepEqual(replies(chat), ['Plain answer']);
});

test('the last guard: every channel (Telegram, WhatsApp number, SMS) sends only the words', async () => {
  db.setSecret('telegram_token', '123456789:AA' + 'x'.repeat(33)); db.setSecret('telegram_hook_secret', 'h'); db.setSetting('telegram_chat_id', '777');
  db.setSetting('wa_phone_number_id', '1234'); db.setSecret('wa_token', 'EAAfake' + 'x'.repeat(20)); db.setSetting('wa_allow', '15551230000');
  db.setSetting('sms_provider', db.setting('sms_provider') || '');
  F.state.tgSent.length = 0; F.state.waSent.length = 0;
  await notify.deliver('telegram', '```json\n' + LEAK + '\n```');
  await notify.deliver('whatsapp', LEAK);
  assert.deepEqual(F.state.tgSent.map(x => x.text), ['Site is live at https://ai.louisb.vip/sites/soft-tech-private-7f9a3/']);
  assert.deepEqual(F.state.waSent.filter(x => x.type === 'text').map(x => x.text.body), ['Site is live at https://ai.louisb.vip/sites/soft-tech-private-7f9a3/']);
  const id = notify.addMessage('assistant', 'web', LEAK);
  assert.equal(db.get('SELECT text FROM messages WHERE id=?', id).text, 'Site is live at https://ai.louisb.vip/sites/soft-tech-private-7f9a3/');
  const sms = fs.readFileSync(new URL('../src/notify.js', import.meta.url), 'utf8');
  assert.match(sms, /export async function deliver[\s\S]{0,200}plainWords/, 'the guard runs before any channel (SMS and email too)');
});

// ---------------------------------------------------------------- 2) one confirmation, not two
test('prompt: no own "reply YES" before an approval tool, no second "approval is waiting" message; site edits need no YES', () => {
  const p = brain.systemPrompt('whatsapp_agent');
  assert.match(p, /do NOT ask "should I\?" or "reply YES and I'll…" before calling such a tool: just call it\. That request IS his confirmation/);
  assert.match(p, /Do not send another message saying that an approval is waiting or repeating its code/);
  assert.match(p, /writing or changing files in your own workspace projects, building, testing, screenshots\. Just do it/);
  assert.doesNotMatch(p, /Tell him the code and what is waiting/);
  assert.match(brain.systemPrompt('web', { hidden: true }), /answer in plain words \(never the replies JSON\)/);
  assert.doesNotMatch(brain.systemPrompt('web', { hidden: true }), /\{"replies":\[\{"to":\[1\]/, 'no replies format in a job after his YES');
});

test('publish/delete request → exactly ONE approval message, no "A# is waiting" message after it', async () => {
  mkSite('echo-site'); clearApprovals();
  const chat = await newChat();
  const j = await waitJob(await say(chat, 'UNPUB echo-site ECHO'));
  assert.match(j.result, /^\(the approval request A\d+ was the answer\)$/);
  const all = db.all('SELECT role,text FROM messages WHERE job_id=?', j.id);
  assert.equal(all.filter(m => m.role === 'approval').length, 1);
  assert.deepEqual(all.filter(m => m.role === 'assistant'), [], 'no second message about the approval');
  // a real line next to the approval sentence: the line stays, the approval sentence goes
  clearApprovals(); mkSite('mixed-site');
  const j2 = await waitJob(await say(chat, 'UNPUB mixed-site MIXED'));
  assert.equal(j2.result, 'I made the page smaller.');
});

test('withoutApprovalEcho / withoutPastedCode (unit)', () => {
  assert.equal(tidy.withoutApprovalEcho('Approval request A2 is waiting for your confirmation. Reply YES A2 to publish.', ['A2']), '');
  assert.equal(tidy.withoutApprovalEcho('Built it, preview below.\nPublishing needs your OK (A2).', ['A2']), 'Built it, preview below.');
  assert.equal(tidy.withoutApprovalEcho('Approval A2 is waiting.', []), 'Approval A2 is waiting.', 'no approval in this job: untouched');
  assert.equal(tidy.withoutApprovalEcho('The approval of the budget went well.', ['A3']), 'The approval of the budget went well.');
  const pasted = 'Here:\n```html\n<!DOCTYPE html>\n<html><body>x</body></html>\n```\nLooks good?';
  assert.doesNotMatch(tidy.withoutPastedCode(pasted, 'change the title'), /<html|DOCTYPE/i);
  assert.match(tidy.withoutPastedCode(pasted, 'change the title'), /send me the code/);
  assert.equal(tidy.withoutPastedCode(pasted, 'show me the code'), pasted, 'he asked for the code');
  assert.equal(tidy.withoutPastedCode('Run `sudo messageassistant restart`.', 'how'), 'Run `sudo messageassistant restart`.');
  assert.equal(tidy.withoutPastedCode('```\nsudo apt update\n```', 'how'), '```\nsudo apt update\n```', 'a short command block stays');
});

// ---------------------------------------------------------------- 3) a picture, not pasted code
test('"change the site to show X" → no message with <html or <!DOCTYPE (fenced or not); asked for code → as written', async () => {
  const chat = await newChat();
  for (const k of ['PASTE', 'PASTERAW']) {
    const j = await waitJob(await say(chat, k + ' change the site to show Hello'));
    assert.doesNotMatch(j.result, /<html|<!doctype|<style|<script/i);
    assert.match(j.result, /I left the code out of the chat\. Say "send me the code"/);
  }
  assert.ok(replies(chat).every(t => !/<html|<!doctype/i.test(t)));
  const j3 = await waitJob(await say(chat, 'SHOWCODE show me the code of the page'));
  assert.match(j3.result, /<!DOCTYPE html>/, 'he asked for it');
  const p = brain.systemPrompt('whatsapp_agent');
  assert.match(p, /never paste HTML, CSS or JavaScript code into the chat\. After building or changing a site, take a phone-size site_screenshot and give him the picture with send_file/);
  assert.match(p, /Show code only when he asks for it, and then as a file with send_file/);
  assert.match(p, /If site_screenshot says there is no browser on this server, tell him in 1–2 lines what changed instead/);
});

// ---------------------------------------------------------------- 4) a reaction is a reaction, never a 👍 message
test('WhatsApp Agent: approval text has no code when it is the only one; bare "Yes" approves; the 👍 after it is a REACTION on his "Yes"', async () => {
  let r = await call('/api/wa-agent/key', { key: KEY }); assert.equal(r.status, 200);
  r = await call('/api/wa-agent', { enabled: true }); assert.equal(r.status, 200);
  await until(async () => (await call('/api/wa-agent')).j.state === 'connected', 8000, 'connected');
  clearApprovals(); mkSite('wa-site'); db.setSetting('wa_agent_react_recent', '[]');
  const n = AP.sent.length;
  push({ id: 'wamid.P1', from: 'user:4242', type: 'text', text: { body: 'UNPUB wa-site' } });
  await until(() => AP.sent.slice(n).some(s => s.type === 'text' && /^Needs your OK/.test(s.text.body)), 8000, 'the approval request');
  await sleep(400);
  const apText = AP.sent.slice(n).filter(s => s.type === 'text').map(s => s.text.body);
  assert.equal(apText.length, 1, 'one message: the request itself ' + JSON.stringify(apText));
  assert.match(apText[0], /Reply YES to approve, or NO\. Expires in 30 min\./);
  assert.doesNotMatch(apText[0], /YES A\d+/, 'no code when only one is waiting');
  M.mode = 'thumb'; db.setSetting('wa_agent_react_recent', '[]');
  const n2 = AP.sent.length;
  push({ id: 'wamid.Y1', from: 'user:4242', type: 'text', text: { body: 'Yes' } });
  await until(() => AP.sent.slice(n2).some(s => s.type === 'text' && /^Done A\d+/.test(s.text.body)), 8000, 'done');
  await until(() => AP.sent.slice(n2).some(s => s.type === 'reaction' && s.reaction.message_id === 'wamid.Y1'), 8000, 'the 👍 on his Yes');
  await sleep(600);
  const out = AP.sent.slice(n2);
  assert.deepEqual(out.filter(s => s.type === 'reaction' && s.reaction.message_id === 'wamid.Y1').map(s => s.reaction.emoji), ['👍']);
  assert.deepEqual(out.filter(s => s.type === 'text' && !/^Done A\d+/.test(s.text.body)), [], 'no 👍 text message, nothing else');
  assert.ok(!fs.existsSync(path.join(SITES, 'wa-site')));
});

test('WhatsApp Agent: his exact Nov 8 bug — after "Yes" the follow-up is plain words, not {"replies":…}', async () => {
  clearApprovals(); mkSite('soft-tech-private-7f9a3'); M.mode = 'leak';
  const n = AP.sent.length;
  push({ id: 'wamid.P2', from: 'user:4242', type: 'text', text: { body: 'UNPUB soft-tech-private-7f9a3' } });
  await until(() => AP.sent.slice(n).some(s => s.type === 'text' && /^Needs your OK/.test(s.text.body)), 8000, 'request');
  const n2 = AP.sent.length;
  push({ id: 'wamid.Y2', from: 'user:4242', type: 'text', text: { body: 'yes' } });
  await until(() => AP.sent.slice(n2).some(s => s.type === 'text' && /^Site is live/.test(s.text.body)), 8000, 'the follow-up');
  await sleep(400);
  const texts = AP.sent.slice(n2).filter(s => s.type === 'text').map(s => s.text.body);
  assert.ok(texts.includes('Site is live at https://ai.louisb.vip/sites/soft-tech-private-7f9a3/'), JSON.stringify(texts));
  assert.ok(texts.every(noJson), JSON.stringify(texts));
  fs.writeFileSync(T + '/wa-agent-after-yes.json', JSON.stringify(texts, null, 1));      // the test log the report points to
  M.mode = 'fence';
  const id = brain.startJob({ text: '[System note, not from the owner] test', channel: 'whatsapp_agent', hidden: true });
  await waitJob(id);
  await until(() => AP.sent.slice(n2).filter(s => s.type === 'text' && /^Site is live/.test(s.text.body)).length >= 2, 6000, 'the fenced one, unwrapped');
  await sleep(300);
  assert.ok(AP.sent.slice(n2).filter(s => s.type === 'text').every(s => noJson(s.text.body)));
});

test('a 👍 with no message id to put it on → nothing at all (no text, no reaction)', async () => {
  M.mode = 'thumb';
  const n = AP.sent.length;
  const j = await waitJob(brain.startJob({ text: '[System note, not from the owner] nothing to add', channel: 'whatsapp_agent', hidden: true }));
  assert.equal(j.status, 'done');
  await sleep(500);
  assert.deepEqual(AP.sent.slice(n), [], 'nothing sent');
  assert.ok(db.get("SELECT 1 AS x FROM audit WHERE action='wa_agent.react_moved' AND detail LIKE 'the reply was only 👍; not sent%'"));
  // Telegram / SMS: a bare emoji is never sent as text by the last guard either
  F.state.tgSent.length = 0;
  await notify.deliver('telegram', '👍');
  assert.equal(F.state.tgSent.length, 0);
});

test('Telegram: YES by text → the 👍 after it goes on his YES message (setMessageReaction), no text', async () => {
  clearApprovals(); mkSite('tg-site'); M.mode = 'thumb';
  F.calls.length = 0; F.state.tgSent.length = 0;
  await telegram.processUpdate({ update_id: 9801, message: { message_id: 801, chat: { id: 777, type: 'private' }, text: 'UNPUB tg-site' } });
  await until(() => pendingIds().length === 1, 8000, 'request');
  await sleep(300);
  F.calls.length = 0; F.state.tgSent.length = 0;
  await telegram.processUpdate({ update_id: 9802, message: { message_id: 802, chat: { id: 777, type: 'private' }, text: 'YES' } });
  await until(() => F.calls.some(c => /setMessageReaction$/.test(c.path) && JSON.parse(c.body).message_id === 802), 8000, 'reaction on 802');
  await sleep(500);
  assert.deepEqual(F.state.tgSent.map(x => x.text).filter(t => !/^Done A\d+/.test(t)), [], 'only the "Done" notice, no 👍 text');
});

// ---------------------------------------------------------------- 5) approvals: no code for one, bare YES, replaced, expiry
test('approvals: the only one → no code in the text, bare YES approves it', async () => {
  clearApprovals();
  const id = await approvals.request('gmail_send', { to: 'a@b.c', subject: 's', body: 'b' }, 'Send an email to a@b.c', { channel: 'web' });
  const txt = db.get("SELECT text FROM messages WHERE role='approval' AND json_extract(meta,'$.approval')=? ", id).text;
  assert.match(txt, /^Needs your OK \(A\d+\):/); assert.match(txt, /Reply YES to approve, or NO\. Expires in 30 min\.$/); assert.doesNotMatch(txt, /YES A\d/);
  assert.deepEqual(approvals.parseDecision('Yes'), { yes: true, id });
  assert.deepEqual(approvals.parseDecision('no'), { yes: false, id });
  assert.equal(approvals.parseDecision('yes please do the other thing'), null, 'not a bare YES');
});

test('approvals: a new request for the same site replaces the old one; bare YES approves the new one', async () => {
  clearApprovals();
  const a1 = await approvals.request('publish_site', { project: 'shop', name: 'shop' }, 'Publish "shop"', { channel: 'web' });
  db.run('UPDATE approvals SET created=? WHERE id=?', Date.now() - 20 * 60000, a1);       // asked 20 min ago (stale)
  const a2 = await approvals.request('publish_site', { project: 'shop', name: 'Shop ' }, 'Publish "shop" (again)', { channel: 'web' });
  assert.equal(db.get('SELECT status FROM approvals WHERE id=?', a1).status, 'superseded');
  assert.deepEqual(approvals.parseDecision('YES'), { yes: true, id: a2 });
  const d = await approvals.decide(a1, true, 'web'); assert.equal(d.ok, false); assert.match(d.message, /replaced by a newer request/);
  // a different site is a different request: not replaced; the stale one does not block a bare YES for the new one
  const b1 = await approvals.request('publish_site', { project: 'blog', name: 'blog' }, 'Publish "blog"', { channel: 'web' });
  assert.equal(db.get('SELECT status FROM approvals WHERE id=?', a2).status, 'pending');
  db.run('UPDATE approvals SET created=? WHERE id=?', Date.now() - 15 * 60000, a2);
  assert.deepEqual(approvals.parseDecision('yes'), { yes: true, id: b1 }, 'the newest; the other one is 15 min old');
  const t = db.get("SELECT text FROM messages WHERE role='approval' AND json_extract(meta,'$.approval')=?", b1).text;
  assert.match(t, new RegExp(`Reply YES A${b1} or NO A${b1}\\.`), 'two waiting → the code is shown');
});

test('approvals: two different FRESH requests → a bare YES asks which one (nothing runs)', async () => {
  clearApprovals();
  const x = await approvals.request('gmail_send', { to: 'x@y.z', subject: 's', body: 'b' }, 'Send an email to x@y.z', { channel: 'web' });
  const y = await approvals.request('publish_site', { project: 'news', name: 'news' }, 'Publish "news"', { channel: 'web' });
  const d = approvals.parseDecision('yes');
  assert.ok(d.ask); assert.match(d.ask, new RegExp(`^Which one\\? Reply YES A${x} for: Send an email to x@y\\.z · Reply YES A${y} for: Publish "news"$`));
  const chat = await newChat();
  const r = await call('/api/chat', { text: 'yes', chat_id: chat }); assert.equal(r.status, 200); assert.ok(r.j.ask);
  assert.deepEqual(pendingIds().sort(), [x, y].sort(), 'both still waiting');
  assert.deepEqual(approvals.parseDecision('YES A' + y), { yes: true, id: y });
});

test('approvals: expire after 30 min (setting approval_expiry_min); a late YES hears it expired', async () => {
  clearApprovals();
  assert.equal(approvals.expiryMs(), 30 * 60000);
  const id = await approvals.request('gmail_send', { to: 'late@y.z', subject: 's', body: 'b' }, 'Send to late@y.z', { channel: 'web' });
  const row = db.get('SELECT created, expires FROM approvals WHERE id=?', id);
  assert.ok(Math.abs(row.expires - row.created - 30 * 60000) < 2000);
  db.run('UPDATE approvals SET created=?, expires=? WHERE id=?', Date.now() - 31 * 60000, Date.now() + 99999, id);   // an old 24-hour one from 2.3.15
  approvals.expire();
  assert.equal(db.get('SELECT status FROM approvals WHERE id=?', id).status, 'expired');
  const d = approvals.parseDecision('YES'); assert.deepEqual(d, { yes: true, id });
  const r = await approvals.decide(d.id, true, 'web'); assert.equal(r.ok, false); assert.match(r.message, /^That request \(A\d+\) expired, so nothing was done\. Ask me again\.$/);
  assert.equal(approvals.parseDecision('ok'), null, '"ok" alone is just ok');
  db.setSetting('approval_expiry_min', '120'); assert.equal(approvals.expiryMs(), 120 * 60000);
  const id2 = await approvals.request('gmail_send', { to: 'b@y.z', subject: 's', body: 'b' }, 'Send to b@y.z', { channel: 'web' });
  assert.match(db.get("SELECT text FROM messages WHERE role='approval' AND json_extract(meta,'$.approval')=?", id2).text, /Expires in 2 h\./);
  db.setSetting('approval_expiry_min', '');
});

// ---------------------------------------------------------------- 6) 404 page for published sites
const get = (p, h = {}) => fetch(BASE + p, { redirect: 'manual', headers: h });
test('sites: files, folders, redirects; a missing page → 404 page (the site\'s own 404.html when it has one); unknown site → 404', async () => {
  mkSite('demo', { 'index.html': '<h1>demo home</h1>', 'style.css': 'body{}', 'sub/index.html': 'sub page', 'img/a.png': 'PNG', 'empty/x.txt': 'x' });
  mkSite('own', { 'index.html': 'own home', '404.html': '<h1>Custom missing page</h1>' });
  let r = await get('/sites/demo/'); assert.equal(r.status, 200); assert.equal(await r.text(), '<h1>demo home</h1>'); assert.match(r.headers.get('content-type'), /text\/html/);
  r = await get('/sites/demo/style.css'); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/css/); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  r = await get('/sites/demo/img/a.png'); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
  r = await get('/sites/demo'); assert.equal(r.status, 301); assert.equal(r.headers.get('location'), '/sites/demo/');
  r = await get('/sites/demo/sub'); assert.equal(r.status, 301); assert.equal(r.headers.get('location'), '/sites/demo/sub/');
  r = await get('/sites/demo/sub/'); assert.equal(r.status, 200); assert.equal(await r.text(), 'sub page');
  r = await get('/sites/demo/nope.html'); assert.equal(r.status, 404); let t = await r.text();
  assert.match(t, /<title>Page not found<\/title>/); assert.match(t, /<code>\/sites\/demo\/nope\.html<\/code>/); assert.match(t, /href="\/sites\/demo\/"/);
  r = await get('/sites/demo/empty/'); assert.equal(r.status, 404, 'a folder without index.html');
  r = await get('/sites/own/missing/page'); assert.equal(r.status, 404); assert.equal(await r.text(), '<h1>Custom missing page</h1>');
  r = await get('/sites/nosuch/'); assert.equal(r.status, 404); t = await r.text(); assert.match(t, /Page not found/); assert.match(t, /This site does not exist/); assert.doesNotMatch(t, /<a /);
  r = await get('/sites/nosuch'); assert.equal(r.status, 404);
  r = await get('/sites/'); assert.equal(r.status, 404);
  r = await get('/sites/demo/%3Cscript%3Ealert(1)%3C%2Fscript%3E'); t = await r.text(); assert.equal(r.status, 404); assert.doesNotMatch(t, /<script>alert/); assert.match(t, /&lt;script&gt;|%3Cscript%3E/);
  r = await fetch(BASE + '/sites/demo/', { method: 'HEAD' }); assert.equal(r.status, 200); assert.equal(r.headers.get('content-length'), '18');
  r = await get('/sites/demo/style.css', { Range: 'bytes=0-3' }); assert.equal(r.status, 206); assert.equal(await r.text(), 'body');
  for (const n of ['demo', 'own']) assert.ok(fs.existsSync(path.join(SITES, n)));
});

test('sites: nothing outside a site can be reached (.., encoded .., backslash, symlinks out, hidden files)', async () => {
  fs.writeFileSync(path.join(T, 'secret.txt'), 'TOPSECRET'); fs.writeFileSync(path.join(SITES, 'demo', '.env'), 'TOPSECRET');
  try { fs.symlinkSync(path.join(T, 'secret.txt'), path.join(SITES, 'demo', 'link.txt')); } catch {}
  try { fs.symlinkSync(T, path.join(SITES, 'outside')); } catch {}
  for (const p of ['/sites/demo/../../secret.txt', '/sites/demo/%2e%2e/%2e%2e/secret.txt', '/sites/demo/..%2f..%2fsecret.txt', '/sites/demo/%2E%2E%5C%2E%2E%5Csecret.txt', '/sites/%2e%2e/secret.txt',
    '/sites/demo/.env', '/sites/demo/link.txt', '/sites/outside/secret.txt', '/sites/demo/%00x', '/sites/..%2f/secret.txt']) {
    const r = await fetch(BASE + p, { redirect: 'manual' });
    const t = await r.text();
    assert.ok([400, 404].includes(r.status), p + ' → ' + r.status);
    assert.doesNotMatch(t, /TOPSECRET/, p);
  }
});

test('sites: the installer sends Caddy\'s misses to the app (404 page), keeps serving files as before; the prompt mentions 404.html', () => {
  const ins = fs.readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  assert.match(ins, /handle \/sites\/\* \{\n\t\troot \* \$SRV\n\t\tfile_server\n\t\}/);
  assert.match(ins, /handle_errors \{\n\t\t@site404 expression "\{err\.status_code\} == 404 && \{path\}\.startsWith\('\/sites\/'\)"\n\t\thandle @site404 \{\n\t\t\treverse_proxy 127\.0\.0\.1:\$PORT/);
  assert.match(ins, /caddy validate --config \/etc\/caddy\/Caddyfile --adapter caddyfile/, 'an old Caddy that cannot read the rule gets the earlier file back');
  assert.doesNotMatch(ins, /handle_path \/sites\/\*/);
  assert.match(brain.systemPrompt('web'), /can have its own 404\.html/);
});

// ---------------------------------------------------------------- 7) screenshots wait for the page to settle
const sc = await import('../src/tools/sitecheck.js');
test('site_screenshot: waits for the network to go quiet + 3 s by default (wait_ms up to 15 s)', () => {
  assert.equal(sc.settleMs(undefined), 3000); assert.equal(sc.settleMs(''), 3000); assert.equal(sc.settleMs(0), 0);
  assert.equal(sc.settleMs(99999), 15000); assert.equal(sc.settleMs(-5), 0); assert.equal(sc.settleMs('5000'), 5000);
  assert.ok(sc.siteScreenshot.params.wait_ms); assert.match(sc.siteScreenshot.params.full_page.description, /still phone width/);
  const src = fs.readFileSync(new URL('../src/tools/sitecheck.js', import.meta.url), 'utf8');
  assert.match(src, /Network\.requestWillBeSent/); assert.match(src, /waitMs: settleMs\(wait_ms\)/);
});
const CHROME = process.env.MA_TEST_CHROMIUM || (() => { try { const d = path.join(os.homedir(), '.cache/ms-playwright'); const e = fs.readdirSync(d).find(n => n.startsWith('chromium_headless_shell-')); const p = e && path.join(d, e, 'chrome-headless-shell-linux64/chrome-headless-shell'); return p && fs.existsSync(p) ? p : ''; } catch { return ''; } })();
test('site_screenshot: a page with a 2 s loading splash is photographed after the splash, not during it', { skip: !CHROME && 'needs Chromium' }, async () => {
  const page = '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"><title>Loading</title></head><body style="background:#000"><div id="s">Loading…</div><script>setTimeout(()=>{document.title="READY";document.body.style.background="#0a0";document.getElementById("s").textContent="Welcome"},2000)</script></body></html>';
  const srv = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.end(page); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const prev = process.env.MA_CHROMIUM; process.env.MA_CHROMIUM = CHROME;
  try {
    const u = 'http://127.0.0.1:' + srv.address().port + '/';
    const quick = await sc.screenshotUrl(u, { waitMs: 0 });
    assert.equal(quick.shots[0].facts.title, 'Loading', 'without the wait the splash is what you get (the bug)');
    const t0 = Date.now();
    const r = await sc.screenshotUrl(u);
    assert.equal(r.shots[0].facts.title, 'READY', 'the default wait gets past the splash');
    assert.ok(Date.now() - t0 < 12000);
    const full = await sc.screenshotUrl(u, { fullPage: true });
    assert.equal(full.shots[0].png.readUInt32BE(16), 390 * 2, 'full page keeps the phone width (390 px at 2×)');
  } finally { if (prev === undefined) delete process.env.MA_CHROMIUM; else process.env.MA_CHROMIUM = prev; srv.close(); }
});
