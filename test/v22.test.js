// 2.2: WhatsApp Agent channel against a mock of Meta's WhatsApp Agent Platform (/agent/v1).
// Not the real Meta service: the mock follows the shapes in the reference plugin (see src/channels/waagent.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const KEY = 'WAAGENTkey-' + crypto.randomBytes(12).toString('hex');
const WRONG = 'WRONGkey-' + crypto.randomBytes(12).toString('hex');

// capture everything the app logs (to prove the key never shows up)
const LOGS = [];
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { LOGS.push(a.map(String).join(' ')); if (process.env.SHOW_LOGS) orig(...a); }; }

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v22-'));
const DATA = T + '/data';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); } throw new Error('timed out waiting for ' + what); }

// ---------- mock Agent Platform ----------
const AP = { feed: [], polls: [], sent: [], statuses: [], uploads: [], mediaGets: [], media: {}, replay: false, fail429: 0, seq: 100 };
const sha = (b) => crypto.createHash('sha256').update(b).digest();
function addMedia(id, buf, mime) { AP.media[id] = { buf, mime }; }
function push(message) { AP.seq++; AP.feed.push({ seq: AP.seq, message: { timestamp: String(Math.floor(Date.now() / 1000)), ...message } }); return AP.seq; }
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  const J = (o, s = 200, h = {}) => { res.writeHead(s, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
  const auth = req.headers.authorization || '';
  const unauthorized = () => J({ error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190, fbtrace_id: 'T1' } }, 401);
  if (p.startsWith('/agent/v1/') && p !== '/agent/v1/updates' && auth !== 'Bearer ' + KEY) return J({ error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190, fbtrace_id: 'T1' } }, 401);
  if (p === '/agent/v1/updates' && req.method === 'GET') {
    const offset = u.searchParams.has('offset') ? parseInt(u.searchParams.get('offset'), 10) : null;
    AP.polls.push({ t: Date.now(), offset, timeout: u.searchParams.get('timeout'), auth });
    if (auth !== 'Bearer ' + KEY) return unauthorized();
    const pick = () => AP.feed.filter(x => AP.replay || offset === null || x.seq >= offset);
    let items = pick();
    const waitUntil = Date.now() + Math.min(1000, Number(u.searchParams.get('timeout') || 0) * 1000);
    while (!items.length && Date.now() < waitUntil) { await sleep(20); items = pick(); }
    if (!items.length) { res.writeHead(204); return res.end(); }
    return J({ object: 'whatsapp_agent_platform', entry: [{ id: '123', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', contacts: [{ wa_id: 'user:777', profile: { name: 'Abish' } }], messages: items.map(x => x.message), statuses: [] } }] }], next_offset: Math.max(...items.map(x => x.seq)) + 1 });
  }
  if (p === '/agent/v1/statuses' && req.method === 'POST') {
    const j = JSON.parse(body); AP.statuses.push(j);
    const m = AP.feed.find(x => x.message.id === j.message_id);
    if (!m || m.message.from !== 'user:777') return J({ error: { message: 'not the creator', code: 131005 } }, 403);
    return J({ success: true });
  }
  if (p === '/agent/v1/messages' && req.method === 'POST') {
    const j = JSON.parse(body);
    if (AP.fail429 > 0) { AP.fail429--; return J({ error: { message: 'rate limited', code: 130429 } }, 429, { 'Retry-After': '0' }); }
    AP.sent.push({ t: Date.now(), ...j });
    return J({ messaging_product: 'whatsapp', contacts: [{ input: j.to, wa_id: j.to }], messages: [{ id: 'wamid.out' + AP.sent.length }] });
  }
  if (p === '/agent/v1/media' && req.method === 'POST') { AP.uploads.push({ type: req.headers['content-type'], size: body.length, hasPng: body.includes(Buffer.from('89504e47', 'hex')) }); return J({ id: 'up-' + AP.uploads.length }); }
  let m;
  if ((m = /^\/agent\/v1\/media\/([^/]+)$/.exec(p)) && req.method === 'GET') {
    AP.mediaGets.push(m[1]); const f = AP.media[m[1]]; if (!f) return J({ error: { message: 'Unsupported get request', code: 100 } }, 400);
    return J({ url: MOCK + '/agent/v1/media/' + m[1] + '/content', mime_type: f.mime, sha256: sha(f.buf).toString('hex'), file_size: f.buf.length, id: m[1], messaging_product: 'whatsapp' });
  }
  if ((m = /^\/agent\/v1\/media\/([^/]+)\/content$/.exec(p))) { const f = AP.media[m[1]]; res.writeHead(200, { 'Content-Type': f.mime, 'Content-Length': f.buf.length }); return res.end(f.buf); }
  J({ error: { message: 'mock: no route ' + p } }, 404);
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const MOCK = 'http://127.0.0.1:' + mock.address().port;

const PORT = 19800 + Math.floor(Math.random() * 150);
Object.assign(process.env, {
  MA_DATA_DIR: DATA, MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/sites', MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_RELEASE_BASE: 'http://127.0.0.1:1',
  MA_MOCK_MODULE: new URL('./mock-model-wa.js', import.meta.url).href,
  MA_WA_AGENT_BASE: MOCK + '/agent/v1', MA_WA_AGENT_POLL_TIMEOUT: '1', MA_WA_AGENT_MIN_INTERVAL_MS: '30', MA_WA_AGENT_WINDOW_MS: '2000',
  MA_WA_AGENT_BACKOFF_MS: '50', MA_WA_AGENT_CONFLICT_MS: '100',
});
const { start } = await import('../src/server.js');
const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const waagent = await import('../src/channels/waagent.js');
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
const jobs = () => db.get('SELECT COUNT(*) AS n FROM jobs').n;
const sentTexts = () => AP.sent.filter(s => s.type === 'text').map(s => s.text.body);
const RESPONSES = [];   // every API answer body we read, checked for the key at the end
const callR = async (...a) => { const r = await call(...a); RESPONSES.push(r.text); return r; };

test.after(() => { waagent.stop(); server.close(); mock.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });

test('off by default: no polling, status says off, card data has no key', async () => {
  await sleep(200);
  assert.equal(AP.polls.length, 0);
  const r = await callR('/api/channels');
  assert.equal(r.status, 200);
  assert.deepEqual([r.j.wa_agent.enabled, r.j.wa_agent.has_key, r.j.wa_agent.state], [false, false, 'off']);
});

test('bad key: clear status message, auth header sent, polling stops', async () => {
  let r = await callR('/api/wa-agent/key', { key: 'short' }); assert.equal(r.status, 400);
  r = await callR('/api/wa-agent/key', { key: WRONG }); assert.equal(r.status, 200); assert.equal(r.j.has_key, true);
  r = await callR('/api/wa-agent', { enabled: true }); assert.equal(r.status, 200);
  await until(() => waagent.status().state === 'error', 5000, 'error state');
  const st = (await callR('/api/wa-agent')).j;
  assert.match(st.error, /rejected the API key/); assert.match(st.error, /Chat info → API key/);
  assert.equal(AP.polls.at(-1).auth, 'Bearer ' + WRONG);
  const n = AP.polls.length; await sleep(400); assert.equal(AP.polls.length, n, 'no more polls after a rejected key');
});

test('good key: reconnects at once, sends "Authorization: Bearer <key>" on every call', async () => {
  const r = await callR('/api/wa-agent/key', { key: KEY }); assert.equal(r.status, 200);
  await until(() => waagent.status().state === 'connected', 5000, 'connected');
  await until(() => AP.polls.filter(p => p.auth === 'Bearer ' + KEY).length >= 2, 5000, 'polls');
  const after = AP.polls.slice(AP.polls.findIndex(p => p.auth === 'Bearer ' + KEY));
  assert.ok(after.every(p => p.auth === 'Bearer ' + KEY));
  assert.equal(after[0].offset, 0); assert.equal(after[0].timeout, '0');   // quick first poll, then long polls
  assert.equal(after[1].timeout, '1');
  assert.equal(waagent.status().creator_known, false);
});

test('inbound text → main chat as his message → brain → reply POSTed to the agent chat', async () => {
  const before = jobs();
  push({ from: 'user:777', id: 'wamid.old', type: 'text', text: { body: 'OLD backlog' }, timestamp: String(Math.floor(Date.now() / 1000) - 3600) });
  push({ from: 'user:777', id: 'wamid.in1', type: 'text', text: { body: 'hello agent' } });
  await until(() => sentTexts().some(t => t.includes('hello agent')), 8000, 'reply');
  const out = AP.sent.find(s => s.text?.body.includes('hello agent'));
  assert.deepEqual([out.messaging_product, out.to, out.type], ['whatsapp', 'user:777', 'text']);
  assert.match(out.text.body, /^GOT\[\] hello agent/);
  const msg = db.get("SELECT * FROM messages WHERE role='owner' AND text='hello agent'");
  assert.equal(msg.channel, 'whatsapp_agent'); assert.equal(msg.chat_id, Number(db.setting('main_chat')));
  assert.ok(!db.get("SELECT 1 AS x FROM messages WHERE text LIKE '%OLD backlog%'"), 'backlog from before it was turned on is skipped');
  assert.equal(jobs(), before + 1);
  const rd = AP.statuses.find(s => s.message_id === 'wamid.in1');
  assert.deepEqual(rd, { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.in1', typing_indicator: { type: 'text' } });
  assert.equal(db.setting('wa_agent_creator'), 'user:777');
  assert.ok(waagent.status().last_in > 0 && waagent.status().last_out > 0);
});

test('someone who is not the creator is dropped (Meta refuses their read receipt)', async () => {
  const before = jobs(), sent = AP.sent.length;
  push({ from: 'user:999', id: 'wamid.stranger', type: 'text', text: { body: 'let me in' } });
  await until(() => AP.statuses.some(s => s.message_id === 'wamid.stranger'), 5000, 'creator check');
  await sleep(300);
  assert.equal(jobs(), before); assert.equal(AP.sent.length, sent);
  assert.ok(!db.get("SELECT 1 AS x FROM messages WHERE text='let me in'"));
});

test('offset is saved in the database; after a restart it continues there and nothing replays', async () => {
  await until(() => Number(db.setting('wa_agent_offset')) === AP.seq + 1, 5000, 'offset saved');
  const saved = Number(db.setting('wa_agent_offset')), before = jobs(), sent = AP.sent.length;
  waagent.stop(true);                     // like a service restart: memory gone, only the DB remains
  const n = AP.polls.length;
  assert.equal(waagent.start(), true);
  await until(() => AP.polls.length >= n + 3, 5000, 'polls after restart');
  assert.equal(AP.polls[n].offset, saved, 'first poll after restart uses the saved offset');
  // even if the platform sent the same messages again, the message ids are remembered
  AP.replay = true;
  await until(() => AP.polls.length >= n + 8, 5000, 'replayed polls');
  AP.replay = false;
  await sleep(200);
  assert.equal(jobs(), before, 'no message ran twice'); assert.equal(AP.sent.length, sent, 'no reply sent twice');
});

test('voice note and photo arrive as attachments for the brain; video gets a clear answer', async () => {
  const OGG = Buffer.concat([Buffer.from('OggS'), crypto.randomBytes(400)]);
  const JPG = Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), crypto.randomBytes(300)]);
  addMedia('5f637c19-4070-4385-ba83-297373444771', OGG, 'audio/ogg; codecs=opus');
  addMedia('998a7c17-60bf-4f40-a313-85f3723e2104', JPG, 'image/jpeg');
  push({ from: 'user:777', id: 'wamid.voice', type: 'audio', audio: { id: '5f637c19-4070-4385-ba83-297373444771', mime_type: 'audio/ogg; codecs=opus', sha256: sha(OGG).toString('base64'), voice: true } });
  await until(() => sentTexts().some(t => t.startsWith('GOT[audio]')), 8000, 'voice reply');
  push({ from: 'user:777', id: 'wamid.photo', type: 'image', image: { id: '998a7c17-60bf-4f40-a313-85f3723e2104', mime_type: 'image/jpeg', sha256: sha(JPG).toString('base64'), caption: 'what is this' } });
  await until(() => sentTexts().some(t => t.startsWith('GOT[image] what is this')), 8000, 'photo reply');
  const voice = db.get("SELECT f.* FROM files f JOIN messages m ON m.id=f.message_id WHERE m.channel='whatsapp_agent' AND f.kind='audio'");
  assert.ok(voice, 'voice note stored and attached to his message'); assert.equal(voice.mime, 'audio/ogg'); assert.equal(voice.size, OGG.length);
  const photo = db.get("SELECT f.*, m.text AS mt FROM files f JOIN messages m ON m.id=f.message_id WHERE f.kind='image' AND m.channel='whatsapp_agent'");
  assert.equal(photo.mt, 'what is this');
  assert.deepEqual(fs.readFileSync(path.join(DATA, 'files', photo.id)), JPG);
  // a kind the brain can't open: no download at all, a plain answer instead
  const gets = AP.mediaGets.length;
  push({ from: 'user:777', id: 'wamid.video', type: 'video', video: { id: 'aaaa-video', mime_type: 'video/mp4', sha256: 'x' } });
  await until(() => sentTexts().some(t => /can't open a video/.test(t)), 8000, 'video answer');
  assert.equal(AP.mediaGets.length, gets);
  // a damaged download is refused, and he hears about it
  addMedia('bbbb-bad', Buffer.from('%PDF-1.4 hello'), 'application/pdf');
  push({ from: 'user:777', id: 'wamid.pdfbad', type: 'document', document: { id: 'bbbb-bad', mime_type: 'application/pdf', filename: 'a.pdf', sha256: Buffer.alloc(32).toString('base64') } });
  await until(() => sentTexts().some(t => /checksum/.test(t)), 8000, 'damaged file answer');
});

test('replies: long text split in order, never more than 12 per minute window, 429 retried once', async () => {
  AP.sent.length = 0;
  const parts = Array.from({ length: 15 }, (_, i) => `PART${String(i).padStart(2, '0')} ` + 'x'.repeat(3900));
  AP.fail429 = 1;
  const t0 = Date.now();
  await waagent.sendOwner(parts.join('\n\n'), { wait: true });
  const got = AP.sent.map(s => s.text.body.slice(0, 6));
  assert.deepEqual(got, parts.map(p => p.slice(0, 6)), 'all 15 in order, none twice');
  assert.ok(AP.sent.every(s => s.text.body.length <= 4000));
  // window is 2 s in tests (60 s live): at most 12 sends inside any window
  for (let i = 12; i < AP.sent.length; i++) assert.ok(AP.sent[i].t - AP.sent[i - 12].t >= 1900, `send ${i} waited for the window`);
  assert.ok(Date.now() - t0 >= 1900);
});

test('pictures go out as photos (upload, then an image message)', async () => {
  const files = await import('../src/files.js');
  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), crypto.randomBytes(100)]);
  const f = files.saveGenerated(PNG, 'image/png', 'picture.png', null, null);
  AP.sent.length = 0;
  await waagent.sendOwner('Here it is', { wait: true, files: [db.get('SELECT * FROM files WHERE id=?', f.id)] });
  assert.equal(AP.uploads.length, 1); assert.match(AP.uploads[0].type, /multipart\/form-data/); assert.ok(AP.uploads[0].hasPng);
  assert.deepEqual(AP.sent.map(s => s.type), ['text', 'image']); assert.equal(AP.sent[1].image.id, 'up-1');
});

test('approvals and reminders also go to WhatsApp; "NO A#" there works like on other channels; the web tap still decides', async () => {
  const approvals = await import('../src/approvals.js');
  const { notifyOwner } = await import('../src/notify.js');
  AP.sent.length = 0;
  const id = await approvals.request('calculator', { expression: '1+1' }, 'Do a harmless thing', { channel: 'web' });
  await until(() => sentTexts().some(t => t.includes(`Needs your OK (A${id})`) && t.includes(`YES A${id}`)), 5000, 'approval on WhatsApp');
  assert.equal(db.get('SELECT status FROM approvals WHERE id=?', id).status, 'pending', 'nothing runs without his answer');
  push({ from: 'user:777', id: 'wamid.no1', type: 'text', text: { body: `NO A${id}` } });
  await until(() => sentTexts().some(t => t.includes(`Cancelled A${id}`)), 5000, 'decision reply');
  assert.equal(db.get('SELECT status, decided_via FROM approvals WHERE id=?', id).decided_via, 'whatsapp_agent');
  await notifyOwner('⏰ Reminder: call Avrum');
  await until(() => sentTexts().some(t => t.includes('Reminder: call Avrum')), 5000, 'reminder');
});

test('"Send test" button sends to the agent chat', async () => {
  AP.sent.length = 0;
  const r = await callR('/api/wa-agent/test', {}); assert.equal(r.status, 200);
  assert.match(AP.sent[0].text.body, /Test from your assistant/);
});

test('toggle off stops polling at once', async () => {
  const r = await callR('/api/wa-agent', { enabled: false }); assert.equal(r.j.state, 'off');
  await sleep(150);
  const n = AP.polls.length; await sleep(1500);
  assert.equal(AP.polls.length, n, 'no polls while off');
  const t = await callR('/api/wa-agent/test', {}); assert.equal(t.status, 400); assert.match(t.j.error, /turned off/);
});

test('the key never appears in logs, the activity log, messages, settings, API answers or the database file', async () => {
  const hay = [LOGS.join('\n'), JSON.stringify(db.all('SELECT * FROM audit')), JSON.stringify(db.all('SELECT * FROM messages')), JSON.stringify(db.all('SELECT * FROM settings')), RESPONSES.join('\n'), (await callR('/api/platforms')).text];
  for (const k of [KEY, WRONG]) for (const h of hay) assert.ok(!h.includes(k), 'key leaked');
  for (const f of fs.readdirSync(DATA).filter(f => f.startsWith('assistant.db'))) assert.ok(!fs.readFileSync(path.join(DATA, f)).includes(Buffer.from(KEY)), 'key in plain text in ' + f);
  assert.ok(LOGS.length > 0);
  assert.ok((await callR('/api/platforms')).j.platforms.some(p => p.name === 'whatsapp-agent' && p.token === '••••(saved)'));
});
