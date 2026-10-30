// 2.3.3: WhatsApp Agent emoji reactions (automatic reaction on his message, the AI's react tool, the setting,
// failures that must not break the reply), against a mock of the WhatsApp Agent Platform and a fake model.
// Not the real Meta service, his phone or his server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const KEY = 'WAAGENTkey-' + crypto.randomBytes(12).toString('hex');
const LOGS = [];
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { LOGS.push(a.map(String).join(' ')); if (process.env.SHOW_LOGS) orig(...a); }; }
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v233-'));
const DATA = T + '/data', WS = T + '/ws', SITES = T + '/sites';
const FIX = path.join(import.meta.dirname, 'fixtures');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); } throw new Error('timed out waiting for ' + what); }

const AP = { feed: [], sent: [], uploads: [], media: {}, seq: 100, statuses: [], failReact: 0 };
const sha = (b) => crypto.createHash('sha256').update(b).digest();
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
  if (p === '/agent/v1/statuses') { AP.statuses.push(JSON.parse(body)); return J({ success: true }); }
  if (p === '/agent/v1/messages') { const j = JSON.parse(body);
    if (j.type === 'reaction' && AP.failReact) { AP.sent.push({ ...j, refused: AP.failReact }); return J({ error: { message: 'mock: reaction refused', code: AP.failReact === 400 ? 100 : 1 } }, AP.failReact); }
    AP.sent.push(j); return J({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.out' + AP.sent.length }] }); }
  if (p === '/agent/v1/media' && req.method === 'POST') {
    const s = body.toString('latin1');
    AP.uploads.push({ type: /name="type"\r\n\r\n([^\r]*)/.exec(s)?.[1], filename: /filename="([^"]*)"/.exec(s)?.[1], size: body.length });
    return J({ id: 'up-' + AP.uploads.length });
  }
  let m;
  if ((m = /^\/agent\/v1\/media\/([^/]+)$/.exec(p))) { const f = AP.media[m[1]]; if (!f) return J({ error: { message: 'Unsupported get request', code: 100 } }, 400);
    return J({ url: MOCK + '/agent/v1/media/' + m[1] + '/content', mime_type: f.mime, sha256: sha(f.buf).toString('hex'), file_size: f.buf.length, id: m[1] }); }
  if ((m = /^\/agent\/v1\/media\/([^/]+)\/content$/.exec(p))) { const f = AP.media[m[1]]; res.writeHead(200, { 'Content-Type': f.mime }); return res.end(f.buf); }
  J({ error: { message: 'mock: no route ' + p } }, 404);
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const MOCK = 'http://127.0.0.1:' + mock.address().port;
const PORT = 20700 + Math.floor(Math.random() * 150);
Object.assign(process.env, {
  MA_DATA_DIR: DATA, MA_WORKSPACE: WS, MA_SITES_DIR: SITES, MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_RELEASE_BASE: 'http://127.0.0.1:1',
  MA_MOCK_MODULE: new URL('./mock-model-v233.js', import.meta.url).href,
  MA_WA_AGENT_BASE: MOCK + '/agent/v1', MA_WA_AGENT_POLL_TIMEOUT: '1', MA_WA_AGENT_MIN_INTERVAL_MS: '30', MA_WA_AGENT_WINDOW_MS: '2000', MA_WA_AGENT_BACKOFF_MS: '50', MA_WA_AGENT_CONFLICT_MS: '100',
});
const { start } = await import('../src/server.js');
const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const waagent = await import('../src/channels/waagent.js');
const tools = await import('../src/tools/index.js');
const chats = await import('../src/chats.js');
const server = start();
await sleep(300);
db.setSetting('setup_done', '1'); db.setSecret('gemini_api_key', 'AIzaFAKE' + 'x'.repeat(30));
const BASE = 'http://127.0.0.1:' + PORT;
const S = auth.newSession('127.0.0.1', 'test');
const cookie = S.cookie.split(';')[0], csrf = S.csrf;
async function call(p, body) {
  const r = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-CSRF': csrf } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text, headers: r.headers };
}
async function waitJob(id) { for (let i = 0; i < 400; i++) { const j = db.get('SELECT * FROM jobs WHERE id=?', id); if (['done', 'error'].includes(j.status)) return j; await sleep(25); } throw new Error('job did not finish'); }
async function ask(text) { const r = await call('/api/chat', { text }); assert.equal(r.status, 200, r.text); return waitJob(r.j.job); }
const sentTexts = () => AP.sent.filter(s => s.type === 'text').map(s => s.text.body);

const reactions = () => AP.sent.filter(s => s.type === 'reaction');
const textsAfter = (n) => AP.sent.slice(n).filter(s => s.type === 'text').map(s => s.text.body);
let N = 0;
async function fromHim(text) {
  const id = 'wamid.in' + (++N) + '-' + crypto.randomBytes(3).toString('hex');
  await until(() => { waagent.limits.messages.prune(Date.now()); return waagent.limits.messages.stamps.length <= 8; }, 5000, 'room in the 12-a-window budget');   // test window is 2 s
  const before = AP.sent.length;
  push({ id, from: 'user:4242', type: 'text', text: { body: text } });
  return { id, before };
}
const replyArrives = (before, re) => until(() => textsAfter(before).find(t => re.test(t)), 8000, 'the reply ' + re).catch(e => { e.message += ' — got: ' + JSON.stringify(textsAfter(before)).slice(0, 400); throw e; });

test.after(() => { waagent.stop(); server.close(); mock.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });

test('setup: key + enabled; React to my messages is on with 👍 by default and the status says so', async () => {
  let r = await call('/api/wa-agent/key', { key: KEY }); assert.equal(r.status, 200);
  r = await call('/api/wa-agent', { enabled: true }); assert.equal(r.status, 200);
  r = await call('/api/wa-agent');
  assert.equal(r.j.react, true); assert.equal(r.j.react_emoji, '👍'); assert.deepEqual(r.j.react_choices, ['👍', '👀', '❤️', '✅']);
  await until(async () => (await call('/api/wa-agent')).j.state === 'connected', 8000, 'connected');
});

test('auto-react: his accepted message gets 👍 right away, in the exact reaction shape, next to read + typing and before the reply', async () => {
  const { id, before } = await fromHim('hello there');
  await replyArrives(before, /^ECHO hello there/);
  const mine = reactions().filter(x => x.reaction.message_id === id);
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0], { messaging_product: 'whatsapp', to: 'user:4242', type: 'reaction', reaction: { message_id: id, emoji: '👍' } });
  const iR = AP.sent.indexOf(mine[0]), iT = AP.sent.findIndex((s, i) => i >= before && s.type === 'text');
  assert.ok(iR < iT, 'the reaction went out before the answer');
  assert.ok(AP.statuses.some(s => s.message_id === id && s.status === 'read' && s.typing_indicator?.type === 'text'), 'read + typing still sent');
  // his own reaction to one of our messages is still just marked seen (no job, no reaction back)
  const b2 = AP.sent.length, jobs = db.get('SELECT COUNT(*) AS n FROM jobs').n;
  push({ id: 'wamid.hisreact1', from: 'user:4242', type: 'reaction', reaction: { message_id: 'wamid.out1', emoji: '❤️' } });
  await until(() => db.get("SELECT 1 AS x FROM seen WHERE id='waa:wamid.hisreact1'"), 5000, 'seen');
  await sleep(150);
  assert.equal(AP.sent.length, b2); assert.equal(db.get('SELECT COUNT(*) AS n FROM jobs').n, jobs);
});

test('the setting: another emoji is used; only the four choices are accepted; off means no reaction at all', async () => {
  let r = await call('/api/wa-agent/react', { emoji: '❤️' }); assert.equal(r.status, 200); assert.equal(r.j.react_emoji, '❤️');
  let m = await fromHim('second one');
  await replyArrives(m.before, /^ECHO second one/);
  assert.equal(reactions().find(x => x.reaction.message_id === m.id)?.reaction.emoji, '❤️');
  r = await call('/api/wa-agent/react', { emoji: '💩' }); assert.equal(r.status, 400); assert.match(r.text, /Pick one of 👍 👀 ❤️ ✅/);
  assert.equal(db.setting('wa_agent_react_emoji'), '❤️');
  r = await call('/api/wa-agent/react', { on: false }); assert.equal(r.status, 200); assert.equal(r.j.react, false);
  m = await fromHim('no reaction please');
  await replyArrives(m.before, /^ECHO no reaction please/);
  await sleep(150);
  assert.equal(reactions().filter(x => x.reaction.message_id === m.id).length, 0, 'setting off → no reaction');
  assert.ok(db.get("SELECT 1 AS x FROM audit WHERE action='wa_agent.react' AND detail='off'"), 'the change is in the Activity log');
  r = await call('/api/wa-agent/react', { on: true, emoji: '👍' }); assert.equal(r.j.react, true); assert.equal(r.j.react_emoji, '👍');
});

test('a refused or failing reaction never breaks the reply; it goes to the Activity log only', async () => {
  for (const code of [400, 500]) {
    AP.failReact = code;
    const m = await fromHim('still answer me ' + code);
    await replyArrives(m.before, new RegExp('^ECHO still answer me ' + code));
    assert.ok(AP.sent.some(s => s.type === 'reaction' && s.refused === code && s.reaction.message_id === m.id), 'it was tried');
    await until(() => db.get("SELECT detail FROM audit WHERE action='wa_agent.react_failed' AND detail LIKE 'automatic 👍:%' ORDER BY id DESC LIMIT 1"), 3000, 'activity row');
  }
  AP.failReact = 0;
  const chat = db.all("SELECT text FROM messages WHERE role IN ('notice','assistant') ORDER BY id DESC LIMIT 6").map(r => r.text).join('\n');
  assert.doesNotMatch(chat, /Reaction not sent|refused|react_failed/i, 'nothing about the failed reaction in the chat');
  // the waagent connection stays up
  assert.equal((await call('/api/wa-agent')).j.state, 'connected');
});

test('AI tool react: ✅ on the message being answered (replaces the automatic 👍), a given message id, empty = remove', async () => {
  let m = await fromHim('REACT ✅');
  await replyArrives(m.before, /^TOOL react .*"ok":true/);
  const mine = reactions().filter(x => x.reaction.message_id === m.id).map(x => x.reaction.emoji);
  assert.deepEqual(mine, ['👍', '✅'], 'auto 👍 first, then the AI\'s ✅ on the same message');
  assert.equal(reactions().find(x => x.reaction.emoji === '✅').to, 'user:4242');
  const first = m.id;
  m = await fromHim('REACTREF ' + first + ' 😂');
  await replyArrives(m.before, /^TOOL react .*"reacted":"😂"/);
  assert.ok(reactions().some(x => x.reaction.message_id === first && x.reaction.emoji === '😂'), 'reacted to the referenced message');
  m = await fromHim('REACTNONE');
  await replyArrives(m.before, /^TOOL react .*"ok":true/);
  assert.ok(reactions().some(x => x.reaction.message_id === m.id && x.reaction.emoji === ''), 'empty emoji removes the reaction');
  assert.ok(db.get("SELECT 1 AS x FROM audit WHERE action='tool.react' AND detail='reacted ✅'"));
});

test('AI tool react: a failure is a short note to the model (the reply still goes out) and an Activity row', async () => {
  AP.failReact = 400;
  const m = await fromHim('REACT ❤️');
  const t = await replyArrives(m.before, /^TOOL react /);
  AP.failReact = 0;
  assert.match(t, /"error":"Reaction not sent: .*Just carry on with your reply/);
  assert.ok(db.get("SELECT 1 AS x FROM audit WHERE action='wa_agent.react_failed' AND detail LIKE 'react tool ❤️:%'"));
});

test('the 12-a-minute budget: when it is full the reaction is skipped (not waited for), so it never holds up the reply', async () => {
  waagent.limits.messages.penalize(1);
  await assert.rejects(waagent.reactTo('wamid.x1', '👍'), /skipped: WhatsApp's 12-a-minute limit is full/);
  await sleep(2100);
});

test('AI tool react: not available outside WhatsApp Agent; bad emoji refused; prompt guidance only on WhatsApp', async () => {
  const ex = (args, ctx) => tools.execTool('react', args, { actor: 'assistant', chatId: chats.mainChatId(), jobId: null, ...ctx });
  const before = AP.sent.length;
  for (const ch of ['web', 'telegram', 'system']) assert.match((await ex({ emoji: '❤️' }, { channel: ch })).error, /^Not available here/);
  const j = await ask('REACT ❤️');                                        // from the web chat, through the model
  assert.match(j.result, /Not available here/);
  for (const bad of ['abc', '👍👍', 'x'.repeat(40), '<b>']) assert.match((await ex({ emoji: bad }, { channel: 'whatsapp_agent', meta: { waa_wamid: 'wamid.zz' } })).error, /Reaction not sent: Give/);
  assert.match((await ex({}, { channel: 'whatsapp_agent' })).error, /Missing "emoji"/);
  assert.equal(AP.sent.length, before, 'none of these reached WhatsApp');
  assert.ok(tools.toolList().some(t => t.name === 'react'), 'listed under Settings → Tools');
  const brain = await import('../src/brain.js');
  assert.match(brain.systemPrompt('whatsapp_agent'), /react tool .*Use it sparingly/);
  assert.doesNotMatch(brain.systemPrompt('web'), /react tool/);
});
