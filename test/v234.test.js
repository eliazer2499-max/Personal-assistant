// 2.3.4: Settings → Channels → WhatsApp Agent → Reactions: Natural (AI decides, the default and where 2.3.3 installs
// land) / Every message / Off; the Natural-mode cap (no 3rd tool reaction in a row). Against a mock of the WhatsApp
// Agent Platform and a fake model. Not the real Meta service, his phone or his server.
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
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v234-'));
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
const PORT = 20860 + Math.floor(Math.random() * 150);
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


const reactsOn = (id) => reactions().filter(x => x.reaction.message_id === id);
const skipped = () => db.all("SELECT detail FROM audit WHERE action='wa_agent.react_skipped'");

test('setup: key + enabled', async () => {
  let r = await call('/api/wa-agent/key', { key: KEY }); assert.equal(r.status, 200);
  r = await call('/api/wa-agent', { enabled: true }); assert.equal(r.status, 200);
  await until(async () => (await call('/api/wa-agent')).j.state === 'connected', 8000, 'connected');
});

test('Natural (AI decides) is the default, and a 2.3.3 install (old "React to my messages" row, no mode) lands on it', async () => {
  let r = await call('/api/wa-agent');
  assert.equal(r.j.react_mode, 'natural'); assert.deepEqual(r.j.react_modes, ['natural', 'every', 'off']); assert.equal(r.j.react, true);
  for (const old of ['1', '0']) {          // 2.3.3 wrote only these two rows; whatever "React to my messages" was, he lands on Natural
    db.run("DELETE FROM settings WHERE k='wa_agent_react_mode'");
    db.setSetting('wa_agent_react', old); db.setSetting('wa_agent_react_emoji', '❤️');
    r = await call('/api/wa-agent');
    assert.equal(r.j.react_mode, 'natural', 'old row ' + old); assert.equal(waagent.reactEnabled(), false);
    assert.equal(r.j.react_emoji, '❤️', 'his emoji choice is kept for "Every message"');
  }
  r = await call('/api/wa-agent/react', { mode: 'sometimes' }); assert.equal(r.status, 400); assert.match(r.text, /Natural, Every message, Off/);
});

test('Natural: no automatic reaction on his message (the reply still comes)', async () => {
  for (const txt of ['plain hello one', 'plain hello two']) {
    const m = await fromHim(txt);
    await replyArrives(m.before, new RegExp('^ECHO ' + txt));
    await sleep(150);
    assert.equal(reactsOn(m.id).length, 0, 'no reaction on ' + txt);
  }
  assert.ok(AP.statuses.length > 0, 'read + typing still sent');
});

test('Natural: the react tool works (❤️ on the message being answered, exact reaction shape)', async () => {
  const m = await fromHim('REACT ❤️');
  const t = await replyArrives(m.before, /^TOOL react /);
  assert.match(t, /"reacted":"❤️"/);
  assert.deepEqual(reactsOn(m.id), [{ messaging_product: 'whatsapp', to: 'user:4242', type: 'reaction', reaction: { message_id: m.id, emoji: '❤️' } }]);
});

test('Natural cap: after reacting to 2 of his messages in a row, a 3rd tool reaction is skipped (Activity only), then it resets', async () => {
  // the previous test reacted to one message; one more makes two in a row
  const b = await fromHim('REACT 😂'); await replyArrives(b.before, /^TOOL react .*"reacted":"😂"/);
  const n0 = skipped().length;
  const c = await fromHim('REACT ✅');
  const t = await replyArrives(c.before, /^TOOL react /);
  assert.match(t, /"skipped":true/); assert.match(t, /just reply/);
  assert.equal(reactsOn(c.id).length, 0, 'the 3rd in a row did not reach WhatsApp');
  assert.equal(skipped().length, n0 + 1); assert.match(skipped().at(-1).detail, /already reacted to his last 2 messages/);
  const chat = db.all("SELECT text FROM messages WHERE role IN ('notice','assistant') ORDER BY id DESC LIMIT 3").map(r => r.text).join('\n');
  assert.doesNotMatch(chat, /react_skipped|skipped ✅/, 'the skip is not posted in the chat');
  // changing the reaction on a message it already reacted to is not a new one in a row
  const d = await fromHim('REACTREF ' + b.id + ' ✅'); await replyArrives(d.before, /^TOOL react /);
  assert.deepEqual(reactsOn(b.id).map(x => x.reaction.emoji), ['😂', '✅']);
  // removing is always allowed
  const rm = await waagent.toolReact(b.id, ''); assert.deepEqual(rm, { skipped: false, emoji: '' });
  assert.deepEqual(reactsOn(b.id).map(x => x.reaction.emoji), ['😂', '✅', '']);
  // c and d were not reacted to, so the next reaction goes out again
  const f = await fromHim('REACT 🙏'); await replyArrives(f.before, /^TOOL react .*"reacted":"🙏"/);
  assert.equal(reactsOn(f.id)[0].reaction.emoji, '🙏');
});

test('cap unit: reactedTwiceBefore looks only at the 2 messages right before this one', () => {
  db.setSetting('wa_agent_react_recent', JSON.stringify([{ id: 'w1', r: true }, { id: 'w2', r: true }, { id: 'w3', r: false }, { id: 'w4', r: true }, { id: 'w5', r: true }, { id: 'w6', r: false }]));
  assert.equal(waagent.reactedTwiceBefore('w6'), true);
  assert.equal(waagent.reactedTwiceBefore('w5'), false, 'w5 already has a reaction (changing it is fine)');
  assert.equal(waagent.reactedTwiceBefore('w3'), true);
  assert.equal(waagent.reactedTwiceBefore('w2'), false);
  assert.equal(waagent.reactedTwiceBefore('unknown'), false, 'unknown id: compares with the last two (w5 ✓, w6 ✗)');
  waagent.noteInbound('w7'); assert.equal(waagent.reactedTwiceBefore('w7'), false);
  db.setSetting('wa_agent_react_recent', '[]');
});

test('Off: no automatic reaction and the react tool is refused too', async () => {
  let r = await call('/api/wa-agent/react', { mode: 'off' }); assert.equal(r.status, 200); assert.equal(r.j.react_mode, 'off'); assert.equal(r.j.react, false);
  const a = await fromHim('plain off'); await replyArrives(a.before, /^ECHO plain off/);
  const b = await fromHim('REACT ❤️'); const t = await replyArrives(b.before, /^TOOL react /);
  assert.match(t, /"error":"Reaction not sent: reactions are turned off/);
  await sleep(150);
  assert.equal(reactsOn(a.id).length + reactsOn(b.id).length, 0);
  const brain = await import('../src/brain.js');
  assert.doesNotMatch(brain.systemPrompt('whatsapp_agent'), /react tool/, 'no reaction guidance when Off');
});

test('Every message (👍): behaves as 2.3.3 — automatic emoji on each message, the tool can change it, no cap', async () => {
  let r = await call('/api/wa-agent/react', { mode: 'every', emoji: '👍' }); assert.equal(r.j.react_mode, 'every'); assert.equal(r.j.react_emoji, '👍');
  const p = await fromHim('plain every'); await replyArrives(p.before, /^ECHO plain every/);
  assert.deepEqual(reactsOn(p.id).map(x => x.reaction.emoji), ['👍']);
  const ids = [];
  for (const e of ['❤️', '😂', '✅']) { const m = await fromHim('REACT ' + e); await replyArrives(m.before, new RegExp('^TOOL react .*"reacted":"' + e + '"')); ids.push([m.id, e]); }
  for (const [id, e] of ids) assert.deepEqual(reactsOn(id).map(x => x.reaction.emoji), ['👍', e], 'auto 👍 then ' + e);
  // the 2.3.3 { on } switch still maps: on → Every message, off → Off
  r = await call('/api/wa-agent/react', { on: false }); assert.equal(r.j.react_mode, 'off');
  r = await call('/api/wa-agent/react', { on: true }); assert.equal(r.j.react_mode, 'every');
});

test('prompt: Natural tells the AI to react like a friend texting; Every keeps the 2.3.3 line', async () => {
  const brain = await import('../src/brain.js');
  let p = brain.systemPrompt('whatsapp_agent');
  assert.match(p, /Use it sparingly/);
  await call('/api/wa-agent/react', { mode: 'natural' });
  p = brain.systemPrompt('whatsapp_agent');
  for (const re of [/most messages get no reaction/, /👍 when he gives you a task that will take a while/, /❤️ for thanks or good news/, /😂 for something funny/, /✅ when a task he asked for is done/, /🙏 for an apology or a favour/, /Never react to every message/, /twice in a row/, /never react instead of answering a question/, /about 1 in 3/]) assert.match(p, re);
  assert.doesNotMatch(brain.systemPrompt('web'), /On WhatsApp you can put an emoji reaction/);   // 2.3.15: web has its own reactions guide
});
