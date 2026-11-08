// 2.3.5: a lone status-emoji line ("✅", blank line, words) typed into a WhatsApp Agent reply is taken out of the text
// and put on his message as a real reaction (Natural / Every message, cap obeyed), or just dropped (Off). Against a
// mock of the WhatsApp Agent Platform and a fake model. Not the real Meta service, his phone or his server.
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
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v235-'));
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
const PORT = 21060 + Math.floor(Math.random() * 150);
Object.assign(process.env, {
  MA_DATA_DIR: DATA, MA_WORKSPACE: WS, MA_SITES_DIR: SITES, MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_RELEASE_BASE: 'http://127.0.0.1:1',
  MA_MOCK_MODULE: new URL('./mock-model-v235.js', import.meta.url).href,
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


const moved = () => db.all("SELECT detail FROM audit WHERE action='wa_agent.react_moved' ORDER BY id").map(r => r.detail);
const say = (t) => 'SAY ' + t.replace(/\n/g, '\\n');
const BUG = '✅\n\nReminder set for tomorrow at 9:00 PM. I\'ll message you here.';

test('setup: key + enabled (Natural, the default)', async () => {
  let r = await call('/api/wa-agent/key', { key: KEY }); assert.equal(r.status, 200);
  r = await call('/api/wa-agent', { enabled: true }); assert.equal(r.status, 200);
  await until(async () => (await call('/api/wa-agent')).j.state === 'connected', 8000, 'connected');
  assert.equal((await call('/api/wa-agent')).j.react_mode, 'natural');
});

test('unit: what counts as a lone status-emoji line', async () => {
  const { splitStatusEmoji: s, withoutStatusEmoji: w } = await import('../src/emoji.js');
  assert.deepEqual(s(BUG), { text: "Reminder set for tomorrow at 9:00 PM. I'll message you here.", emoji: '✅', where: 'lead' });
  assert.deepEqual(s('All set.\n\n👍'), { text: 'All set.', emoji: '👍', where: 'trail' });
  assert.deepEqual(s('🎉 🔥\n\nyay\n\n👍'), { text: 'yay', emoji: '🎉', where: 'both' });
  assert.equal(s('❤\nthanks').emoji, '❤️', 'bare ❤ is sent in its emoji form');
  assert.equal(s('👍🏽\r\nok').text, 'ok');
  assert.deepEqual(s('✅'), { text: '✅', emoji: '✅', where: 'only' });
  assert.equal(s('  ✅✅  ').where, 'only');
  for (const t of ['✅ Reminder set', 'Done ✅', 'Done ✅ see you', 'a\n✅\nb', '⏰\n\nReminder', 'ok 👍👍👍', '✅✅✅\nthree is not a lone status line', 'hello'])
    assert.deepEqual(s(t), { text: t, emoji: '', where: '' }, 'untouched: ' + JSON.stringify(t));
  assert.equal(w('✅'), '✅', 'an emoji-only reply is never stripped to nothing');
});

test('leading "✅" line: stripped from the text and sent as a real reaction on his message (Natural)', async () => {
  db.setSetting('wa_agent_react_recent', '[]');
  const m = await fromHim(say(BUG));
  const t = await replyArrives(m.before, /^Reminder set for tomorrow/);
  assert.equal(t, "Reminder set for tomorrow at 9:00 PM. I'll message you here.");
  await until(() => reactsOn(m.id).length, 4000, 'the reaction');
  assert.deepEqual(reactsOn(m.id), [{ messaging_product: 'whatsapp', to: 'user:4242', type: 'reaction', reaction: { message_id: m.id, emoji: '✅' } }]);
  assert.ok(!textsAfter(m.before).some(x => /✅/.test(x)), 'no ✅ in any text bubble');
  await until(() => moved().includes('moved ✅ from text to reaction'), 3000, 'the Activity line');
  const stored = db.get("SELECT text FROM messages WHERE role='assistant' AND channel='whatsapp_agent' ORDER BY id DESC LIMIT 1").text;
  assert.equal(stored, "Reminder set for tomorrow at 9:00 PM. I'll message you here.", 'the chat keeps just the words');
  const chat = db.all("SELECT text FROM messages WHERE role='notice' ORDER BY id DESC LIMIT 5").map(r => r.text).join('\n');
  assert.doesNotMatch(chat, /moved ✅/, 'the move is logged to Activity only');
});

test('trailing "👍" line: handled the same way', async () => {
  db.setSetting('wa_agent_react_recent', '[]');
  const m = await fromHim(say('Booked the table for 8.\n\n👍'));
  const t = await replyArrives(m.before, /^Booked the table/);
  assert.equal(t, 'Booked the table for 8.');
  await until(() => reactsOn(m.id).length, 4000, 'the reaction');
  assert.deepEqual(reactsOn(m.id).map(x => x.reaction.emoji), ['👍']);
});

test('emoji inside normal sentences are left alone, and no reaction is made', async () => {
  const before = moved().length;
  for (const txt of ['✅ Reminder set for 9 PM', 'Done ✅ see you tomorrow 👍', 'Great news 🎉\nand more 🔥 here']) {
    const m = await fromHim(say(txt));
    const got = await replyArrives(m.before, /./);
    assert.equal(got, txt);
    await sleep(150);
    assert.equal(reactsOn(m.id).length, 0, 'no reaction for ' + txt);
  }
  assert.equal(moved().length, before);
});

test('emoji-only reply: goes as a reaction instead of a text bubble', async () => {
  db.setSetting('wa_agent_react_recent', '[]');
  const m = await fromHim(say('❤️'));
  await until(() => reactsOn(m.id).length, 4000, 'the reaction');
  assert.deepEqual(reactsOn(m.id).map(x => x.reaction.emoji), ['❤️']);
  await sleep(300);
  assert.deepEqual(textsAfter(m.before), [], 'no text bubble');
  assert.match(moved().at(-1), /moved ❤️ from text to reaction \(the reply was only ❤️\)/);
});

test('Natural cap: the moved emoji obeys it (3rd in a row is not sent, the line is still removed); emoji-only falls back to text', async () => {
  db.setSetting('wa_agent_react_recent', '[]');
  const a = await fromHim(say('✅\nfirst done')); await replyArrives(a.before, /^first done$/); await until(() => reactsOn(a.id).length, 4000, 'reaction a');
  const b = await fromHim(say('✅\nsecond done')); await replyArrives(b.before, /^second done$/); await until(() => reactsOn(b.id).length, 4000, 'reaction b');
  const n0 = skipped().length;
  const c = await fromHim(say('✅\n\nthird done'));
  const t = await replyArrives(c.before, /^third done$/);
  assert.equal(t, 'third done', 'the line is still taken out of the text');
  await until(() => skipped().length > n0, 3000, 'the cap skip in Activity');
  await sleep(200);
  assert.equal(reactsOn(c.id).length, 0, 'the 3rd reaction in a row did not reach WhatsApp');
  assert.match(moved().at(-1), /removed ✅ from the text; no reaction \(already reacted to his last 2 messages\)/);
  // emoji-only while the cap says no: it is not swallowed, it goes as text
  db.setSetting('wa_agent_react_recent', '[]');
  const a2 = await fromHim(say('✅\nfourth done')); await replyArrives(a2.before, /^fourth done$/); await until(() => reactsOn(a2.id).length, 4000, 'reaction a2');
  const b2 = await fromHim(say('✅\nfifth done')); await replyArrives(b2.before, /^fifth done$/); await until(() => reactsOn(b2.id).length, 4000, 'reaction b2');
  const d = await fromHim(say('👍'));
  await replyArrives(d.before, /^👍$/);
  assert.equal(reactsOn(d.id).length, 0);
});

test('Off: the line is stripped without reacting; an emoji-only reply goes as text', async () => {
  let r = await call('/api/wa-agent/react', { mode: 'off' }); assert.equal(r.j.react_mode, 'off');
  db.setSetting('wa_agent_react_recent', '[]');
  const m = await fromHim(say(BUG));
  const t = await replyArrives(m.before, /^Reminder set/);
  assert.doesNotMatch(t, /✅/);
  const o = await fromHim(say('✅'));
  await replyArrives(o.before, /^✅$/);
  await sleep(200);
  assert.equal(reactsOn(m.id).length + reactsOn(o.id).length, 0, 'no reactions at all when Off');
  assert.ok(moved().some(x => /removed ✅ from the text; no reaction \(Reactions are Off\)/.test(x)));
});

test('Every message: the auto 👍 is there, a typed ✅ line replaces it as the reaction', async () => {
  await call('/api/wa-agent/react', { mode: 'every', emoji: '👍' });
  const m = await fromHim(say('✅\n\nAll done.'));
  await replyArrives(m.before, /^All done\.$/);
  await until(() => reactsOn(m.id).length >= 2, 4000, 'two reactions');
  assert.deepEqual(reactsOn(m.id).map(x => x.reaction.emoji), ['👍', '✅']);
  await call('/api/wa-agent/react', { mode: 'natural' });
});

test('notices with no message to react to (reminders, summaries): a lone line is dropped, nothing reacts', async () => {
  const n = AP.sent.length;
  await waagent.sendOwner('✅\n\nYour 9 PM reminder: call the bank.', { wait: true });
  const t = AP.sent.slice(n);
  assert.deepEqual(t.map(x => x.type), ['text']);
  assert.equal(t[0].text.body, 'Your 9 PM reminder: call the bank.');
  await waagent.sendOwner('Test from your assistant ✅ Write here any time.', { wait: true });
  assert.equal(AP.sent.at(-1).text.body, 'Test from your assistant ✅ Write here any time.');
});

test('a reaction failure never breaks the reply', async () => {
  db.setSetting('wa_agent_react_recent', '[]');
  AP.failReact = 400;
  try {
    const m = await fromHim(say('✅\n\nSaved it.'));
    await replyArrives(m.before, /^Saved it\.$/);
    await until(() => db.all("SELECT 1 AS x FROM audit WHERE action='wa_agent.react_failed' AND detail LIKE '%moved ✅ out of the text%'").length, 3000, 'the failure in Activity');
    const o = await fromHim(say('👍'));
    await replyArrives(o.before, /^👍$/);      // emoji-only + failed reaction → sent as text
  } finally { AP.failReact = 0; }
});

test('prompt: Natural and Every message carry the no-lone-emoji rule; Off and web do not; the react tool says to use it instead', async () => {
  const brain = await import('../src/brain.js');
  const rule = 'Never start or end a reply with a lone status emoji such as ✅ 👍 ❤️. To react, call the react tool; it puts the emoji on his message. Emoji inside normal sentences are fine.';
  for (const mode of ['natural', 'every']) {
    await call('/api/wa-agent/react', { mode });
    assert.ok(brain.systemPrompt('whatsapp_agent').includes(rule), mode);
  }
  await call('/api/wa-agent/react', { mode: 'off' });
  assert.ok(!brain.systemPrompt('whatsapp_agent').includes(rule));
  db.setSetting('reactions', '0'); assert.ok(!brain.systemPrompt('web').includes(rule), 'web, reactions off');   // 2.3.15: web reacts too when on
  db.setSetting('reactions', '1'); assert.ok(brain.systemPrompt('web').includes(rule), 'web, reactions on');
  await call('/api/wa-agent/react', { mode: 'natural' });
  const decl = tools.declarations({}).find(t => t.name === 'react');
  assert.ok(decl, 'react is offered to the model');
  assert.match(decl.description, /shows on his message, like a person reacting/);
  assert.match(decl.description, /instead of typing ✅\/👍 in the text/);
});

test('history: older replies that opened with a lone ✅ line are given to the AI without it', async () => {
  const chat = chats.mainChatId();
  db.run("INSERT INTO messages(role,channel,text,ts,chat_id) VALUES('assistant','whatsapp_agent',?,?,?)", '✅\n\nOld reminder reply', Date.now(), chat);
  const m = await fromHim('HISTCHECK');
  const t = await replyArrives(m.before, /^HIST /);
  const seen = JSON.parse(t.slice(5));
  assert.equal(seen.length, 1); assert.match(seen[0], /Old reminder reply$/);
  assert.doesNotMatch(seen[0], /✅/, 'the AI sees its old reply without the ✅ line');
  // the stored row itself is not rewritten; the web page shows it without the line
  assert.equal(db.get("SELECT text FROM messages WHERE text LIKE '%Old reminder reply%'").text, '✅\n\nOld reminder reply');
  const app = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  const LONE = eval(app.match(/const LONE_STATUS = (\/.*\/u);/)[1]);
  assert.equal('✅\n\nOld reminder reply'.replace(LONE, ''), 'Old reminder reply');
  assert.equal('✅ Reminder'.replace(LONE, ''), '✅ Reminder');
});
