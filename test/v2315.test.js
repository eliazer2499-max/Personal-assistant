// 2.3.15: (1) reactions — the assistant puts an emoji on his message on every channel (web chat bubble, Telegram's
// own reaction, his WhatsApp number's reaction, the WhatsApp Agent as before), and a reaction can be the whole answer
// (NO_REPLY = no words). (2) several quick messages → ONE answer: it waits until he is quiet (Settings → AI →
// Replies), never longer than the cap, and a message that lands while it works or writes is folded into the same
// answer. Against fakes (Telegram, Graph, the WhatsApp Agent Platform) and a fake model — not the real services,
// his phone or his server.
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
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v2315-'));
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

const PORT = 21700 + Math.floor(Math.random() * 150);
Object.assign(process.env, {
  MA_DATA_DIR: T + '/data', MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/sites', MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_RELEASE_BASE: 'http://127.0.0.1:1',
  MA_MOCK_MODULE: new URL('./mock-model-v2315.js', import.meta.url).href,
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
const calls = () => globalThis.__M2315;
const setWait = (ms, max) => { db.setSetting('batch_wait_ms', String(ms)); if (max) db.setSetting('batch_max_ms', String(max)); else db.setSetting('batch_max_ms', ''); };

test.after(() => { waagent.stop(); server.close(); mock.close(); F.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });

// ---------------------------------------------------------------- settings + prompt
test('settings: Replies (reactions on, wait 3.5 s by default on a real server; 0–10 s; off is allowed)', async () => {
  let r = await call('/api/settings');
  assert.equal(r.j.settings.reactions, '1');
  assert.equal(r.j.settings.batch_wait_default, '3500');
  assert.equal(brain.BATCH_WAIT_DEFAULT, 3500);
  assert.equal(brain.batchMax(), 15000, 'never waits longer than 15 s from his first message');
  r = await call('/api/settings', { batch_wait_ms: '20000' }); assert.equal(r.status, 400); assert.match(r.text, /0 to 10 seconds/);
  r = await call('/api/settings', { batch_wait_ms: '2000', reactions: 'off' }); assert.equal(r.status, 200);
  assert.equal(db.setting('reactions'), '0'); assert.equal(brain.batchWait(), 2000);
  assert.doesNotMatch(brain.systemPrompt('web'), /react tool/, 'reactions off: no reactions guide');
  r = await call('/api/settings', { reactions: '1', batch_wait_ms: '0' }); assert.equal(r.status, 200);
  assert.equal(brain.batchWait(), 0);
  assert.doesNotMatch(brain.systemPrompt('web'), /\[#1\], \[#2\]/, 'batching off: no batch guide');
  setWait(400);
  const p = brain.systemPrompt('web');
  assert.match(p, /react tool/); assert.match(p, /answer exactly NO_REPLY/); assert.match(p, /never react to every message/i);
  assert.match(p, /each separate question or request gets its OWN reply/); assert.match(p, /merged into the reply for that earlier message/); assert.match(p, /"replies":\[\{"to":\[1\]/);
  assert.match(brain.systemPrompt('telegram'), /react tool/);
  assert.match(brain.systemPrompt('whatsapp_agent'), /answer exactly NO_REPLY/, 'WhatsApp Agent: Natural guide + reaction-only');
  assert.doesNotMatch(brain.systemPrompt('system'), /react tool/);
  // when/how often to write (his rules, Nov 7)
  for (const re of [/A quick question: just answer it\. No "on it"/, /A longer job: his message gets 👍 automatically when you start working — that is your acknowledgement/, /only for a real milestone: it is done, something went wrong, or you need something from him\. No running commentary/, /"thanks", "ok", "cool", "great", a goodbye: a reaction only/, /each separate question gets its own reply \(sent as a reply to that message\); a message that only adds to or corrects an earlier one is merged into that reply/, /Scheduled and background jobs: stay silent unless there is something new to report/]) assert.match(p, re);
});

test('NO_REPLY marker', () => {
  for (const s of ['NO_REPLY', 'no reply', '(NO_REPLY)', '[no_reply]', 'NO_REPLY.', '', '  ']) assert.ok(emoji.isNoReply(s), JSON.stringify(s));
  for (const s of ['No reply yet from the shop', 'ok', '👍', 'NO_REPLY but here is more']) assert.ok(!emoji.isNoReply(s), s);
});

// ---------------------------------------------------------------- 1) reactions
test('reaction-only reply (web): "thanks" gets ❤️ on his bubble and NO words', async () => {
  setWait(300);
  const chat = await newChat();
  const id = await say(chat, 'THANKS so much');
  const j = await waitJob(id);
  assert.equal(j.status, 'done'); assert.equal(j.result, '(answered with a reaction: ❤️)');
  assert.deepEqual(replies(chat), [], 'no assistant bubble');
  const own = msgs(chat).find(m => m.role === 'owner');
  const r = await call('/api/chat?chat=' + chat);
  assert.equal(r.j.reactions[own.id], '❤️', 'the web page gets the reaction for his bubble');
  assert.ok(db.get("SELECT 1 AS x FROM audit WHERE action='reply.reaction_only'"));
  // the next job's history shows the AI it reacted
  const id2 = await say(chat, 'what next');
  await waitJob(id2);
  const seen = calls().at(-1);
  assert.ok(seen.some(i => i.role === 'user' && /THANKS so much \[you reacted ❤️\]/.test(i.text)), JSON.stringify(seen));
  assert.deepEqual(replies(chat), ['ANSWER: what next']);
});

test('NO_REPLY without a reaction → his message still gets 👍; an emoji-only reply goes on his message', async () => {
  const chat = await newChat();
  let j = await waitJob(await say(chat, 'SILENT ok'));
  assert.equal(j.result, '(answered with a reaction: 👍)');
  j = await waitJob(await say(chat, 'HEART great news'));
  assert.equal(j.result, '(answered with a reaction: ❤️)');
  assert.deepEqual(replies(chat), []);
  const r = await call('/api/chat?chat=' + chat);
  assert.deepEqual(Object.values(r.j.reactions).sort(), ['❤️', '👍'].sort());
});

test('react first, then answer: a job gets 👍 on his message AND a reply in words', async () => {
  const chat = await newChat();
  const j = await waitJob(await say(chat, 'JOB list my projects'));
  assert.equal(j.result, 'JOB DONE');
  assert.deepEqual(replies(chat), ['JOB DONE']);
  const own = msgs(chat).find(m => m.role === 'owner');
  await until(async () => (await call('/api/chat?chat=' + chat)).j.reactions[own.id] === '✅', 3000, '✅ after the answer');
});

test('reactions Off: no reaction tool; NO_REPLY sends nothing (2.3.16: never a bare "👍" message)', async () => {
  db.setSetting('reactions', '0');
  try {
    const chat = await newChat();
    let j = await waitJob(await say(chat, 'THANKS'));
    assert.match(j.result, /^\(no reply; the reaction could not be placed\)$/);
    assert.deepEqual(replies(chat), []);
    assert.deepEqual((await call('/api/chat?chat=' + chat)).j.reactions, {});
  } finally { db.setSetting('reactions', '1'); }
});

// ---------------------------------------------------------------- 2) several quick messages → one answer
test('batch: 3 quick messages → ONE job, ONE model call that sees all 3, ONE reply', async () => {
  setWait(500);
  const chat = await newChat();
  const n0 = calls().length;
  const a = await say(chat, 'find me a flight to SF');
  await sleep(150);
  const b = await say(chat, 'friday morning');
  await sleep(150);
  const c = await say(chat, 'actually make it saturday');
  assert.equal(a, b); assert.equal(b, c, 'all three joined the same job');
  assert.equal(job(a).progress, brain.WAITING_LABEL, 'still waiting for him to stop typing');
  const t0 = Date.now();
  const j = await waitJob(a);
  assert.ok(Date.now() - t0 >= 250, 'it waited for the quiet time after the last message');
  assert.equal(calls().slice(n0).filter(c => c.some(i => /find me a flight/.test(i.text || ''))).length, 1, 'one model call');
  assert.deepEqual(replies(chat), ['ANSWER: [#1] find me a flight to SF | [#2] friday morning | [#3] actually make it saturday']);
  const input = calls().at(-1).at(-1).text;
  assert.match(input, /^\[He sent 3 messages in a row\. Each separate question or request gets its own reply; a message that only adds to or corrects an earlier one is merged/);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM jobs WHERE chat_id=?", chat).n, 1);
  assert.equal(msgs(chat).filter(m => m.role === 'owner').length, 3, 'his 3 bubbles are all kept');
});

test('batch: the web page sees "typing" (waiting) and then the answer; a single message is unchanged', async () => {
  setWait(400);
  const chat = await newChat();
  const id = await say(chat, 'hello there');
  const r = await call('/api/chat?chat=' + chat);
  const jj = r.j.jobs.find(x => x.id === id);
  assert.equal(jj.status, 'queued'); assert.equal(jj.progress, 'Waiting for more messages');
  await waitJob(id);
  assert.deepEqual(replies(chat), ['ANSWER: hello there'], 'one message: his words as they are, no [#1]');
});

test('batch: never waits longer than the cap, even if he keeps typing', async () => {
  setWait(500, 1200);
  const chat = await newChat();
  const t0 = Date.now();
  const id = await say(chat, 'one');
  let started = 0;
  for (let i = 0; i < 10 && !started; i++) {
    await sleep(250);
    if (job(id).progress !== brain.WAITING_LABEL) started = Date.now() - t0;
    else await say(chat, 'more ' + i);
  }
  assert.ok(started && started < 1700, 'started at ' + started + ' ms');
  await waitJob(id);
  await until(() => !db.get("SELECT 1 AS x FROM jobs WHERE chat_id=? AND status IN ('queued','running')", chat), 8000, 'all done');
  setWait(400);
});

test('batch: a message that lands while the answer is being written is folded in — one answer, not two', async () => {
  setWait(200);
  const chat = await newChat();
  const n0 = calls().length;
  const id = await say(chat, 'SLOW 900 book a table for 4');
  await until(() => job(id).status === 'running', 5000, 'running');
  await sleep(250);
  const id2 = await say(chat, 'at 8pm please');
  assert.equal(id2, id, 'joined the running job');
  const j = await waitJob(id);
  assert.equal(j.status, 'done');
  assert.deepEqual(replies(chat), ['MERGED: [#2] at 8pm please'], 'one reply that covers both');
  assert.equal(calls().slice(n0).filter(c => c.some(i => /book a table/.test(i.text || ''))).length, 2, 'the draft was rewritten once');
  const second = calls().at(-1);
  assert.equal(second.at(-2).role, 'assistant'); assert.equal(second.at(-2).text, '{"replies":[{"to":[1],"text":"DRAFT"}]}', 'the unsent draft is shown back as the replies JSON');
  assert.match(second.at(-1).text, /^\[Your replies above were NOT sent/);
  assert.match(second[second.length - 3].text, /SLOW 900 book a table for 4/, 'his first message is still there');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM jobs WHERE chat_id=?', chat).n, 1);
});

test('batch: a message that lands while it is working (between tool steps) is read at the next step', async () => {
  const chat = await newChat();
  const id = await say(chat, 'SLOWTOOL 700 check my projects');
  await until(() => job(id).status === 'running', 5000, 'running');
  await sleep(200);
  assert.equal(await say(chat, 'and the old ones too'), id);
  const j = await waitJob(id);
  assert.deepEqual(replies(chat), ['FOLDED: [#2] and the old ones too']);
  assert.ok(db.get("SELECT 1 AS x FROM job_events WHERE job_id=? AND kind='note' AND text LIKE 'He sent one more message%'", id), 'shown in the job card');
});

test('his rule (7:01 PM): ANY message before the reply has gone out is merged — a slow reply with a 2nd message 10 s in → exactly ONE reply to both', async () => {
  setWait(300);
  const chat = await newChat();
  const id = await say(chat, 'SLOW 12000 compare these two phones');
  await until(() => job(id).status === 'running', 5000, 'running');
  await sleep(10000);
  assert.equal(job(id).status, 'running', 'still writing the first answer');
  assert.equal(await say(chat, 'also check the battery life'), id, 'joined the job that is still writing');
  const j = await waitJob(id, 30000);
  assert.equal(j.status, 'done');
  await sleep(500);
  assert.deepEqual(replies(chat), ['MERGED: [#2] also check the battery life'], 'exactly one reply');
  const last = calls().filter(c => c.some(i => /compare these two phones/.test(i.text || ''))).at(-1);
  assert.ok(last.some(i => /compare these two phones/.test(i.text || '')) && /also check the battery life/.test(last.at(-1).text), 'the one reply was written seeing both');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM jobs WHERE chat_id=?', chat).n, 1);
});

test('his rule: messages keep coming while it writes → still one reply (rewritten each time)', async () => {
  setWait(200);
  const chat = await newChat();
  const id = await say(chat, 'SLOW 600 plan my day');
  await until(() => job(id).status === 'running', 5000, 'running');
  for (const t of ['gym at 7', 'lunch with Moshe', 'call the bank']) { await sleep(450); assert.equal(await say(chat, t), id, t); }
  await waitJob(id, 20000);
  await sleep(400);
  const r = replies(chat);
  assert.equal(r.length, 1, JSON.stringify(r));
  assert.match(r[0], /^MERGED: /);
  for (const t of ['gym at 7', 'lunch with Moshe', 'call the bank']) assert.ok(r[0].includes(t), t + ' in ' + r[0]);
});

test('batch: after the reply has gone out, a new message starts a new job', async () => {
  const chat = await newChat();
  const a = await say(chat, 'first question');
  await waitJob(a);
  const b = await say(chat, 'second question');
  assert.notEqual(a, b);
  await waitJob(b);
  assert.deepEqual(replies(chat), ['ANSWER: first question', 'ANSWER: second question']);
});

test('batch Off (0): one job per message, exactly like 2.3.14', async () => {
  setWait(0);
  const chat = await newChat();
  const a = await say(chat, 'alpha'), b = await say(chat, 'beta');
  assert.notEqual(a, b);
  await waitJob(a); await waitJob(b);
  assert.deepEqual(replies(chat).sort(), ['ANSWER: alpha', 'ANSWER: beta']);
  setWait(300);
});

test('batch + react tool: "message" picks which of his messages gets the reaction', async () => {
  const chat = await newChat();
  const a = await say(chat, 'REACTFIRST can you check the weather');
  await say(chat, 'for tomorrow');
  await waitJob(a);
  const own = msgs(chat).filter(m => m.role === 'owner');
  const rx = (await call('/api/chat?chat=' + chat)).j.reactions;
  assert.equal(rx[own[0].id], '👍'); assert.equal(rx[own[1].id], undefined);
  assert.deepEqual(replies(chat), ['ANSWER: [#1] REACTFIRST can you check the weather | [#2] for tomorrow']);
});


// ---------------------------------------------------------------- 2b) his correction (Nov 7, 7:21 PM): "If I ask 2 questions its 2 answers not both in 1"
const amsgs = (chat) => db.all("SELECT id,role,text,meta FROM messages WHERE chat_id=? AND role IN ('owner','assistant') ORDER BY id", chat).map(m => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null }));

test('his correction: 2 different questions sent quickly → 2 replies, each quoting its own message', async () => {
  setWait(300);
  const chat = await newChat();
  const a = await say(chat, 'what time does the bank open?');
  await sleep(100);
  assert.equal(await say(chat, 'how much is a stamp?'), a, 'read together (one job)');
  await waitJob(a);
  const all = amsgs(chat);
  const own = all.filter(m => m.role === 'owner'), rep = all.filter(m => m.role === 'assistant');
  assert.deepEqual(rep.map(r => r.text), ['ANSWER to #1: what time does the bank open?', 'ANSWER to #2: how much is a stamp?'], 'two answers, not both in one');
  assert.deepEqual(rep.map(r => r.meta.reply_to), [own[0].id, own[1].id], 'each one is a reply to its own message');
  assert.deepEqual(rep.map(r => r.meta.quote), ['what time does the bank open?', 'how much is a stamp?']);
  assert.ok(db.get("SELECT 1 AS x FROM audit WHERE action='reply.separate'"));
  // the web page gets the quote with each reply
  const r = await call('/api/chat?chat=' + chat);
  assert.deepEqual(r.j.messages.filter(m => m.role === 'assistant').map(m => m.meta.reply_to), [own[0].id, own[1].id]);
});

test('his correction: a question + a correction → ONE reply (merged), not two', async () => {
  const chat = await newChat();
  const a = await say(chat, 'book a table for 4 tonight?');
  await sleep(100);
  await say(chat, 'make it 8pm');
  await waitJob(a);
  const rep = amsgs(chat).filter(m => m.role === 'assistant');
  assert.equal(rep.length, 1, JSON.stringify(rep));
  assert.equal(rep[0].text, 'ANSWER to #1: book a table for 4 tonight? + make it 8pm');
  assert.equal(rep[0].meta, null, 'one ordinary reply (it covers his newest message): no quote needed');
});

test('his correction: a question + "thanks" → ONE reply + a ❤️ on the thanks', async () => {
  const chat = await newChat();
  const a = await say(chat, 'is the post office open on sunday?');
  await sleep(100);
  await say(chat, 'thanks');
  await waitJob(a);
  const all = amsgs(chat);
  const own = all.filter(m => m.role === 'owner'), rep = all.filter(m => m.role === 'assistant');
  assert.deepEqual(rep.map(r => r.text), ['ANSWER to #1: is the post office open on sunday?']);
  assert.equal(rep[0].meta.reply_to, own[0].id, 'it quotes the question (his newest message is the thanks)');
  const rx = (await call('/api/chat?chat=' + chat)).j.reactions;
  assert.equal(rx[own[1].id], '❤️', 'the thanks gets a reaction only');
  assert.equal(rx[own[0].id], undefined);
});

test('his correction: 2 questions + a fix to the first + thanks → 2 replies (the fix merged into #1) and a ❤️', async () => {
  const chat = await newChat();
  const a = await say(chat, 'what is the weather in Monsey?');
  for (const x of ['I mean tomorrow', 'and when is shabbos?', 'thanks']) { await sleep(80); await say(chat, x); }
  await waitJob(a);
  const all = amsgs(chat);
  const own = all.filter(m => m.role === 'owner'), rep = all.filter(m => m.role === 'assistant');
  assert.deepEqual(rep.map(r => r.text), ['ANSWER to #1: what is the weather in Monsey? + I mean tomorrow', 'ANSWER to #3: and when is shabbos?']);
  assert.deepEqual(rep.map(r => r.meta.reply_to), [own[0].id, own[2].id]);
  assert.equal((await call('/api/chat?chat=' + chat)).j.reactions[own[3].id], '❤️');
});

test('his correction: a NEW separate question while the first answer is being written → the first answer is still sent as written, the new one answered separately', async () => {
  setWait(200);
  const chat = await newChat();
  const n0 = calls().length;
  const id = await say(chat, 'SLOWQ 900 how far is Lakewood?');
  await until(() => job(id).status === 'running', 5000, 'running');
  await sleep(250);
  assert.equal(await say(chat, 'what time is it in Israel?'), id, 'joined the running job');
  await waitJob(id);
  const all = amsgs(chat);
  const own = all.filter(m => m.role === 'owner'), rep = all.filter(m => m.role === 'assistant');
  assert.deepEqual(rep.map(r => r.text), ['DRAFT ANSWER 1', 'ANSWER to #2: what time is it in Israel?'], 'the still-valid draft was kept (not thrown away), the new question got its own answer');
  assert.deepEqual(rep.map(r => r.meta.reply_to), [own[0].id, own[1].id]);
  const second = calls().slice(n0).at(-1);
  assert.equal(second.at(-2).text, '{"replies":[{"to":[1],"text":"DRAFT ANSWER 1"}]}');
  assert.match(second.at(-1).text, /\{"to":\[its number\],"keep":true\}/);
});

test('his correction: a message that CHANGES the first while it is being written → the first answer is rewritten (one reply, no duplicate)', async () => {
  setWait(200);
  const chat = await newChat();
  const id = await say(chat, 'SLOW 900 JSONFIX book a table for 4');
  await until(() => job(id).status === 'running', 5000, 'running');
  await sleep(250);
  await say(chat, 'make it 8pm');
  await waitJob(id);
  const rep = amsgs(chat).filter(m => m.role === 'assistant');
  assert.equal(rep.length, 1);
  assert.match(rep[0].text, /^REWRITTEN: .*make it 8pm/);
  assert.ok(!rep.some(r => r.text === 'DRAFT'), 'the old draft was not sent');
});

test('replies format: parser (JSON, code fences, raw newlines, keep, duplicates, junk → plain)', async () => {
  const R = await import('../src/replies.js');
  assert.equal(R.parseReplies('Sure, the bank opens at 9.', 2), null, 'plain words are not the format');
  assert.deepEqual(R.parseReplies('```json\n{"replies":[{"to":[1],"text":"a"},{"to":["#2"],"text":"b","react":"👍"}]}\n```', 2), [{ to: [1], text: 'a', react: '', keep: false }, { to: [2], text: 'b', react: '👍', keep: false }]);
  assert.deepEqual(R.parseReplies('{"replies":[{"to":[1],"text":"line one\nline two"}]}', 1)[0].text, 'line one\nline two', 'a real newline inside the text is fine');
  assert.deepEqual(R.parseReplies('{"replies":[{"to":[9],"text":"x"}]}', 2)[0].to, [2], 'an unknown number goes to his newest message');
  assert.deepEqual(R.resolveReplies([{ to: [1], keep: true, text: '', react: '' }, { to: [2], text: 'new', react: '', keep: false }], [{ to: [1], text: 'old one', react: '' }]),
    [{ to: [1], text: 'old one', react: '', keep: false }, { to: [2], text: 'new', react: '', keep: false }]);
  assert.equal(R.resolveReplies([{ to: [1], text: 'same', react: '', keep: false }, { to: [2], text: 'same', react: '', keep: false }]).length, 1, 'never the same words twice');
  assert.equal(R.parseReplies('{"replies": [oops', 2), null, 'broken JSON → treated as plain words');
});

// ---------------------------------------------------------------- other channels
test('Telegram: quick messages are one answer; the reaction is Telegram\'s own (✅ → 👌, the nearest it allows)', async () => {
  db.setSecret('telegram_token', '123456789:AA' + 'x'.repeat(33)); db.setSecret('telegram_hook_secret', 'h'); db.setSetting('telegram_chat_id', '777');
  F.calls.length = 0; F.state.tgSent.length = 0;
  const upd = (id, text) => ({ update_id: 9000 + id, message: { message_id: 500 + id, chat: { id: 777, type: 'private' }, text } });
  await telegram.processUpdate(upd(1, 'THANKS for the help'));
  await until(() => F.calls.some(c => /setMessageReaction$/.test(c.path)), 5000, 'reaction');
  const rc = F.calls.find(c => /setMessageReaction$/.test(c.path));
  assert.deepEqual(JSON.parse(rc.body), { chat_id: '777', message_id: 501, reaction: [{ type: 'emoji', emoji: '❤' }] });
  await sleep(300);
  assert.equal(F.state.tgSent.length, 0, 'no words sent for a thanks');
  assert.equal(await import('../src/reactions.js').then(R => R.telegramEmoji('✅')), '👌');
  await telegram.processUpdate(upd(2, 'what is 2+2'));
  await sleep(100);
  await telegram.processUpdate(upd(3, 'and 3+3'));
  await until(() => F.state.tgSent.length >= 1, 5000, 'answer');
  await sleep(500);
  assert.deepEqual(F.state.tgSent.map(x => x.text), ['ANSWER: [#1] what is 2+2 | [#2] and 3+3']);
});

test('rule 3: a longer job → his message gets 👍 (the acknowledgement), then ONE message with the result, then ✅ — no running commentary', async () => {
  F.calls.length = 0; F.state.tgSent.length = 0;
  await telegram.processUpdate({ update_id: 9100, message: { message_id: 600, chat: { id: 777, type: 'private' }, text: 'LONGJOB go through all my projects' } });
  await until(() => F.state.tgSent.length >= 1, 8000, 'result');
  await until(() => F.calls.filter(c => /setMessageReaction$/.test(c.path)).length >= 2, 4000, '👍 then ✅');
  await sleep(500);
  assert.deepEqual(F.state.tgSent.map(x => x.text), ['LONG DONE'], 'only the result was sent — not "Looking into it now…" or "Still going"');
  const rx = F.calls.filter(c => /setMessageReaction$/.test(c.path)).map(c => JSON.parse(c.body));
  assert.deepEqual(rx.map(r => [r.message_id, r.reaction[0]?.emoji]), [[600, '👍'], [600, '👌']], '👍 at the start, ✅ (Telegram: 👌) at the end');
  const order = F.calls.filter(c => /setMessageReaction$|sendMessage$/.test(c.path)).map(c => /sendMessage$/.test(c.path) ? 'text' : JSON.parse(c.body).reaction[0].emoji);
  assert.deepEqual(order, ['👍', 'text', '👌']);
  assert.ok(db.get("SELECT 1 AS x FROM job_events WHERE kind='note' AND text='Still going, one more check'"), 'the in-between notes stay in the job card only');
});

test('rule 4 on Telegram: "cool" → a reaction, no text', async () => {
  F.calls.length = 0; F.state.tgSent.length = 0;
  await telegram.processUpdate({ update_id: 9101, message: { message_id: 601, chat: { id: 777, type: 'private' }, text: 'SILENT cool' } });
  await until(() => F.calls.some(c => /setMessageReaction$/.test(c.path)), 5000, 'reaction');
  await sleep(500);
  assert.equal(F.state.tgSent.length, 0);
  assert.deepEqual(JSON.parse(F.calls.find(c => /setMessageReaction$/.test(c.path)).body).reaction, [{ type: 'emoji', emoji: '👍' }]);
});

test('rule 6: a scheduled job with nothing new stays silent (NO_REPLY → nothing stored, nothing sent)', async () => {
  const before = db.get("SELECT COUNT(*) AS n FROM messages WHERE role IN ('assistant','notice')").n;
  const id = brain.startJob({ text: '[Scheduled job 9] SILENT check the prices', channel: 'system', hidden: true, title: 'Scheduled: prices' });
  const j = await waitJob(id);
  assert.equal(j.result, '(nothing to say)');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM messages WHERE role IN ('assistant','notice')").n, before);
  const sched = fs.readFileSync(new URL('../src/scheduler.js', import.meta.url), 'utf8');
  assert.match(sched, /If there is nothing new to report, do not message him: answer exactly NO_REPLY/);
});

test('WhatsApp number: the reaction goes as WhatsApp\'s reaction message on his message', async () => {
  db.setSetting('wa_phone_number_id', '1234'); db.setSecret('wa_token', 'EAAfake' + 'x'.repeat(20)); db.setSetting('wa_allow', '15551230000');
  F.state.waSent.length = 0;
  await whatsapp.processBody({ entry: [{ changes: [{ value: { messages: [{ id: 'wamid.HIM1', from: '15551230000', type: 'text', text: { body: 'THANKS' } }] } }] }] });
  await until(() => F.state.waSent.some(x => x.type === 'reaction'), 5000, 'reaction');
  await sleep(300);
  assert.deepEqual(F.state.waSent, [{ messaging_product: 'whatsapp', recipient_type: 'individual', to: '15551230000', type: 'reaction', reaction: { message_id: 'wamid.HIM1', emoji: '❤️' } }]);
});

test('SMS: no reactions there — a "thanks" sends nothing, the web chat still shows the ❤️', async () => {
  const before = F.state.smsSent.length;
  const { ownerSaid } = await import('../src/channels/inbound.js');
  await ownerSaid('sms', 'THANKS', { sms_from: '+15551230000' });
  await until(() => db.get("SELECT 1 AS x FROM jobs WHERE channel='sms' AND status='done'"), 5000, 'job');
  await sleep(200);
  assert.equal(F.state.smsSent.length, before);
  const own = db.get("SELECT id FROM messages WHERE channel='sms' AND role='owner' ORDER BY id DESC LIMIT 1");
  assert.equal(db.get('SELECT emoji FROM reactions WHERE message_id=?', own.id).emoji, '❤️');
});

test('WhatsApp Agent: two quick messages → one reply; a thanks → ❤️ only; reactions show in the web chat too', async () => {
  let r = await call('/api/wa-agent/key', { key: KEY }); assert.equal(r.status, 200);
  r = await call('/api/wa-agent', { enabled: true }); assert.equal(r.status, 200);
  await until(async () => (await call('/api/wa-agent')).j.state === 'connected', 8000, 'connected');
  const n = AP.sent.length;
  push({ id: 'wamid.A1', from: 'user:4242', type: 'text', text: { body: 'remind me to call mom' } });
  await sleep(120);
  push({ id: 'wamid.A2', from: 'user:4242', type: 'text', text: { body: 'at 6pm' } });
  await until(() => AP.sent.slice(n).some(s => s.type === 'text'), 8000, 'reply');
  await sleep(700);
  assert.deepEqual(AP.sent.slice(n).filter(s => s.type === 'text').map(s => s.text.body), ['ANSWER: [#1] remind me to call mom | [#2] at 6pm'], 'one reply to both');
  const n2 = AP.sent.length;
  push({ id: 'wamid.A3', from: 'user:4242', type: 'text', text: { body: 'THANKS' } });
  await until(() => AP.sent.slice(n2).some(s => s.type === 'reaction'), 8000, 'reaction');
  await sleep(700);
  assert.deepEqual(AP.sent.slice(n2), [{ messaging_product: 'whatsapp', to: 'user:4242', type: 'reaction', reaction: { message_id: 'wamid.A3', emoji: '❤️' } }], 'just the reaction, no words');
  const own = db.get("SELECT id FROM messages WHERE role='owner' AND channel='whatsapp_agent' AND json_extract(meta,'$.waa_wamid')='wamid.A3'");
  assert.equal(db.get('SELECT emoji FROM reactions WHERE message_id=?', own.id).emoji, '❤️', 'mirrored to the web chat');
  // his correction: 2 questions → 2 replies, each quoting its own WhatsApp message
  const n3 = AP.sent.length;
  push({ id: 'wamid.B1', from: 'user:4242', type: 'text', text: { body: 'when is the next train?' } });
  await sleep(120);
  push({ id: 'wamid.B2', from: 'user:4242', type: 'text', text: { body: 'how much is a ticket?' } });
  await until(() => AP.sent.slice(n3).filter(s => s.type === 'text').length >= 2, 8000, 'two replies');
  await sleep(500);
  assert.deepEqual(AP.sent.slice(n3).filter(s => s.type === 'text').map(s => [s.text.body, s.context?.message_id]), [['ANSWER to #1: when is the next train?', 'wamid.B1'], ['ANSWER to #2: how much is a ticket?', 'wamid.B2']]);
});

test('his correction on Telegram: 2 questions → 2 replies, each a Telegram reply to its own message', async () => {
  setWait(300); F.calls.length = 0; F.state.tgSent.length = 0;
  const upd = (id, text) => ({ update_id: 9300 + id, message: { message_id: 700 + id, chat: { id: 777, type: 'private' }, text } });
  await telegram.processUpdate(upd(1, 'what is the capital of France?'));
  await sleep(80);
  await telegram.processUpdate(upd(2, 'and of Spain?'));
  await until(() => F.state.tgSent.length >= 2, 6000, 'two answers');
  await sleep(300);
  assert.deepEqual(F.state.tgSent.map(x => [x.text, x.reply_parameters?.message_id]), [['ANSWER to #1: what is the capital of France?', 701], ['ANSWER to #2: and of Spain?', 702]]);
});

test('his correction on his WhatsApp number: 2 questions → 2 replies, each quoting (context) its own message', async () => {
  setWait(300); F.state.waSent.length = 0;
  const msg = (id, body) => ({ entry: [{ changes: [{ value: { messages: [{ id, from: '15551230000', type: 'text', text: { body } }] } }] }] });
  await whatsapp.processBody(msg('wamid.Q1', 'is the store open?'));
  await sleep(80);
  await whatsapp.processBody(msg('wamid.Q2', 'do they deliver?'));
  await until(() => F.state.waSent.filter(x => x.type === 'text').length >= 2, 6000, 'two answers');
  await sleep(300);
  assert.deepEqual(F.state.waSent.filter(x => x.type === 'text').map(x => [x.text.body, x.context?.message_id]), [['ANSWER to #1: is the store open?', 'wamid.Q1'], ['ANSWER to #2: do they deliver?', 'wamid.Q2']]);
});

test('nothing secret in the stored meta of his messages (only message ids)', () => {
  for (const m of db.all("SELECT meta FROM messages WHERE role='owner' AND meta IS NOT NULL")) {
    assert.deepEqual(Object.keys(JSON.parse(m.meta)).filter(k => !['waa_wamid', 'tg_msg_id', 'wa_msg_id', 'wa_from'].includes(k)), []);
  }
  const dump = JSON.stringify(db.all('SELECT * FROM messages')) + JSON.stringify(db.all('SELECT * FROM reactions'));
  assert.ok(!dump.includes(KEY) && !dump.includes('AIzaFAKE'));
});
