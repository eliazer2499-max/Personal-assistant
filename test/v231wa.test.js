// 2.3.1: send_file (web chat + WhatsApp Agent, path safety, size limits) and files arriving from WhatsApp,
// against a mock of the WhatsApp Agent Platform (shapes as in src/channels/waagent.js) and a fake model.
// Not the real Meta service or his phone.
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
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v231wa-'));
const DATA = T + '/data', WS = T + '/ws', SITES = T + '/sites';
const FIX = path.join(import.meta.dirname, 'fixtures');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); } throw new Error('timed out waiting for ' + what); }

const AP = { feed: [], sent: [], uploads: [], media: {}, seq: 100 };
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
  if (p === '/agent/v1/statuses') return J({ success: true });
  if (p === '/agent/v1/messages') { const j = JSON.parse(body); AP.sent.push(j); return J({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.out' + AP.sent.length }] }); }
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
  MA_MOCK_MODULE: new URL('./mock-model-v231.js', import.meta.url).href,
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
const run = (args, ctx = {}) => tools.execTool('send_file', args, { actor: 'assistant', channel: 'web', chatId: chats.mainChatId(), jobId: null, ...ctx });
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), crypto.randomBytes(200)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), crypto.randomBytes(3000)]);
fs.mkdirSync(WS + '/music/out', { recursive: true }); fs.mkdirSync(SITES + '/menu', { recursive: true });
fs.writeFileSync(WS + '/music/out/song.mp3', MP3); fs.writeFileSync(WS + '/music/cover.png', PNG);
fs.writeFileSync(WS + '/music/report.pdf', '%PDF-1.4\n%%EOF'); fs.copyFileSync(path.join(FIX, 'project.zip'), WS + '/music/project.zip');
fs.writeFileSync(WS + '/music/empty.txt', ''); fs.writeFileSync(SITES + '/menu/index.html', '<h1>menu</h1>');
fs.symlinkSync('/etc/hostname', WS + '/music/escape.txt');
fs.writeFileSync(T + '/secret.txt', 'outside');

test.after(() => { waagent.stop(); server.close(); mock.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });

test('send_file in the web chat: the file shows under an assistant message with the right type; the AI is told not to publish a page', async () => {
  const j = await ask('SENDFILE music/out/song.mp3');
  assert.equal(j.status, 'done');
  assert.match(j.result, /^TOOL send_file .*"shown_in_chat":true.*"file":"song\.mp3"/);
  assert.match(j.result, /do not paste links or publish a page/);
  const f = db.get("SELECT f.*, m.meta, m.role, m.text AS mt FROM files f JOIN messages m ON m.id=f.message_id WHERE f.name='song.mp3'");
  assert.deepEqual([f.role, f.kind, f.mime, f.size, f.mt], ['assistant', 'audio', 'audio/mpeg', MP3.length, 'here it is']);
  assert.match(f.meta, /"sent_file":true/);
  const r = await fetch(BASE + '/api/files/' + f.id, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'audio/mpeg'); assert.ok(Buffer.from(await r.arrayBuffer()).equals(MP3));
  const msgs = await call('/api/chat');
  assert.ok(JSON.stringify(msgs.j).includes('"name":"song.mp3"'), 'the chat API lists it under the message');
  assert.equal(AP.sent.length, 0, 'nothing went to WhatsApp (not set up, not asked)');
  // the system prompt steers files to send_file, not publish_site
  const brain = await import('../src/brain.js');
  assert.match(brain.systemPrompt('web'), /use send_file[\s\S]*Do NOT publish a web page just to hand him a file/);
  assert.match(brain.systemPrompt('web'), /Word, Excel, PowerPoint, CSV, text\/code files, \.zip/);
});

test('send_file only reads allowed places: no "..", no absolute paths outside, no symlink escapes, no folders', async () => {
  const before = db.get('SELECT COUNT(*) AS n FROM messages').n;
  for (const [p, re] of [
    ['../secret.txt', /leave the allowed folders/], ['music/../../secret.txt', /leave the allowed folders/], [T + '/secret.txt', /Only files in your workspace/],
    ['/etc/passwd', /Only files in your workspace/], ['music/escape.txt', /leaves the project folder/], ['sites/../secret.txt', /leave the allowed folders/],
    ['music', /Give the project too/], ['music/out', /That is a folder/], ['music/empty.txt', /empty/], ['music/nope.mp3', /No such file/],
    [DATA + '/assistant.db', /Only files in your workspace/], ['file:' + 'a'.repeat(32), /no longer on the server/],
  ]) {
    const r = await run({ path: p });
    assert.ok(r.error, p + ' should be refused'); assert.match(r.error, re, p + ': ' + r.error);
  }
  assert.equal(db.get('SELECT COUNT(*) AS n FROM messages').n, before, 'nothing was added to the chat');
  // allowed: an absolute path inside the workspace, a published site file, a chat file by id and by name
  let r = await run({ path: WS + '/music/cover.png' }); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.type, 'image');
  r = await run({ path: 'sites/menu/index.html' }); assert.equal(r.ok, true, JSON.stringify(r));
  const pic = db.get("SELECT id FROM files WHERE name='cover.png'");
  r = await run({ path: pic.id }); assert.equal(r.ok, true);
  r = await run({ path: 'song.mp3' }); assert.equal(r.ok, true, 'a chat file by its name');
});

test('send_file size limit: over 50 MB is refused with a plain reason', async () => {
  const big = WS + '/music/huge.mp4';
  fs.closeSync(fs.openSync(big, 'w')); fs.truncateSync(big, 51 * 1024 * 1024);    // sparse: takes no disk space
  const r = await run({ path: 'music/huge.mp4' });
  assert.match(r.error, /That file is 51 MB; the chat takes files up to 50 MB/);
  fs.rmSync(big);
});

test('WhatsApp: from the agent chat, files go out as audio / photo / document, captions kept, never sent twice', async () => {
  let r = await call('/api/wa-agent/key', { key: KEY }); assert.equal(r.status, 200);
  r = await call('/api/wa-agent', { enabled: true }); assert.equal(r.status, 200);
  await until(() => waagent.status().state === 'connected', 5000, 'connected');
  push({ from: 'user:777', id: 'wamid.a1', type: 'text', text: { body: 'SENDFILE music/out/song.mp3' } });
  await until(() => sentTexts().some(t => t.startsWith('TOOL send_file')), 8000, 'final reply');
  assert.deepEqual(AP.sent.map(s => s.type), ['text', 'audio', 'text'], JSON.stringify(AP.sent).slice(0, 600));
  assert.equal(AP.sent[0].text.body, 'here it is', 'audio takes no caption, so the caption goes first as text');
  assert.equal(AP.sent[1].audio.id, 'up-1'); assert.equal(AP.uploads[0].type, 'audio/mpeg'); assert.equal(AP.uploads[0].filename, 'song.mp3');
  assert.match(AP.sent[2].text.body, /"whatsapp":"sent as audio"/);
  await sleep(300);
  assert.equal(AP.uploads.length, 1, 'the job end does not send the same file again');
  // a picture → photo with caption; a PDF → document with its name; a zip → generic file
  AP.sent.length = 0; AP.uploads.length = 0;
  push({ from: 'user:777', id: 'wamid.a2', type: 'text', text: { body: 'SENDFILE music/cover.png' } });
  await until(() => sentTexts().some(t => t.startsWith('TOOL send_file')), 8000, 'reply 2');
  assert.deepEqual(AP.sent.map(s => s.type), ['image', 'text']); assert.equal(AP.sent[0].image.caption, 'here it is');
  AP.sent.length = 0; AP.uploads.length = 0;
  push({ from: 'user:777', id: 'wamid.a3', type: 'text', text: { body: 'SENDFILE music/report.pdf' } });
  await until(() => sentTexts().some(t => t.startsWith('TOOL send_file')), 8000, 'reply 3');
  assert.equal(AP.sent[0].type, 'document'); assert.equal(AP.sent[0].document.filename, 'report.pdf'); assert.equal(AP.uploads[0].type, 'application/pdf');
  AP.sent.length = 0; AP.uploads.length = 0;
  push({ from: 'user:777', id: 'wamid.a4', type: 'text', text: { body: 'SENDFILE music/project.zip' } });
  await until(() => sentTexts().some(t => t.startsWith('TOOL send_file')), 8000, 'reply 4');
  assert.equal(AP.sent[0].type, 'document'); assert.equal(AP.sent[0].document.filename, 'project.zip'); assert.equal(AP.uploads[0].type, 'application/octet-stream');
});

test('WhatsApp: over 16 MB is not sent there, he is told why, and it waits in the web chat', async () => {
  fs.writeFileSync(WS + '/music/long.mp3', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(17 * 1024 * 1024)]));
  AP.sent.length = 0; AP.uploads.length = 0;
  push({ from: 'user:777', id: 'wamid.b1', type: 'text', text: { body: 'SENDFILE music/long.mp3' } });
  const t = await until(() => sentTexts().find(x => x.startsWith('TOOL send_file')), 8000, 'reply');
  assert.match(t, /"whatsapp":"not sent: too big for WhatsApp \(17\.0 MB; WhatsApp agents take files up to 16 MB\)"/);
  assert.match(t, /too big for WhatsApp and is waiting in the web chat/);
  assert.equal(AP.uploads.length, 0);
  assert.ok(db.get("SELECT 1 AS x FROM files WHERE name='long.mp3'"), 'in the web chat');
  fs.rmSync(WS + '/music/long.mp3');
});

test('from the web, to: "whatsapp" sends it there too', async () => {
  AP.sent.length = 0; AP.uploads.length = 0;
  const j = await ask('SENDFILE music/cover.png TO whatsapp');
  assert.match(j.result, /"whatsapp":"sent as image"/);
  assert.deepEqual(AP.sent.map(s => s.type), ['image']);
});

test('filePlan follows the WhatsApp limits', () => {
  const MB = 1024 * 1024;
  assert.deepEqual(waagent.filePlan('image/png', 'a.png', 1000), { kind: 'image', mime: 'image/png', name: 'a.png' });
  assert.equal(waagent.filePlan('image/jpeg', 'big.jpg', 6 * MB).kind, 'document');
  assert.equal(waagent.filePlan('image/webp', 'a.webp', 1000).mime, 'application/octet-stream');
  assert.equal(waagent.filePlan('audio/mp4', 'a.m4a', 1000).kind, 'audio');
  assert.deepEqual([waagent.filePlan('audio/wav', 'a.wav', 1000).kind, waagent.filePlan('audio/wav', 'a.wav', 1000).mime], ['document', 'application/octet-stream']);
  assert.equal(waagent.filePlan('video/mp4', 'a.mp4', 1000).kind, 'video');
  assert.equal(waagent.filePlan('video/quicktime', 'a.mov', 1000).kind, 'document');
  assert.equal(waagent.filePlan('text/csv', 'a.csv', 1000).mime, 'text/plain');
  assert.equal(waagent.filePlan('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'a.xlsx', 1000).mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.throws(() => waagent.filePlan('application/pdf', 'a.pdf', 17 * MB), /too big for WhatsApp/);
});

test('files from WhatsApp: Excel and zip are read for the AI; an old .doc gets a clear answer', async () => {
  AP.sent.length = 0;
  const X = fs.readFileSync(path.join(FIX, 'xlsxwriter.xlsx'));
  AP.media['m-xlsx'] = { buf: X, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  push({ from: 'user:777', id: 'wamid.c1', type: 'document', document: { id: 'm-xlsx', filename: 'budget.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: sha(X).toString('base64'), caption: 'total?' } });
  let t = await until(() => sentTexts().find(x => x.startsWith('GOT[]')), 8000, 'xlsx reply');
  assert.match(t, /total\?/); assert.match(t, /Excel file "budget\.xlsx", 1 sheet/); assert.match(t, /4: Total \| 1550\.5/);
  AP.sent.length = 0;
  const Z = fs.readFileSync(path.join(FIX, 'project.zip'));
  AP.media['m-zip'] = { buf: Z, mime: 'application/zip' };
  push({ from: 'user:777', id: 'wamid.c2', type: 'document', document: { id: 'm-zip', filename: 'project.zip', mime_type: 'application/zip', sha256: sha(Z).toString('hex') } });
  t = await until(() => sentTexts().find(x => x.startsWith('GOT[]')), 8000, 'zip reply');
  assert.match(t, /Zip "project\.zip": 4 files/);
  AP.sent.length = 0;
  push({ from: 'user:777', id: 'wamid.c3', type: 'document', document: { id: 'm-doc', filename: 'old.doc', mime_type: 'application/msword', sha256: 'x' } });
  t = await until(() => sentTexts().find(x => /\.doc files/.test(x)), 8000, 'doc answer');
  assert.match(t, /Old Word \.doc files can't be read here\. Save it as \.docx or PDF/);
});

test('the WhatsApp key never appears in logs, activity, messages or the database file', async () => {
  const all = [...LOGS, ...db.all('SELECT detail FROM audit').map(r => String(r.detail)), ...db.all('SELECT text FROM messages').map(r => String(r.text))].join('\n');
  assert.ok(!all.includes(KEY));
  assert.ok(!fs.readFileSync(path.join(DATA, 'assistant.db')).includes(Buffer.from(KEY)));
  assert.ok(db.all("SELECT detail FROM audit WHERE action='tool.send_file'").length >= 6);
});
