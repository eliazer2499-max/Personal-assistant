// 2.1.0: migration from a 2.0.1 database, multiple chats, uploads, media to Gemini, pictures, helpers, update source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
const spawnP = (cmd, args, o) => new Promise(res => { const c = spawn(cmd, args, o); let err = ''; c.stderr.on('data', d => err += d); c.on('close', status => res({ status, stderr: err })); });
import { DatabaseSync } from 'node:sqlite';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v21-'));
const DATA = T + '/data';
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), crypto.randomBytes(200)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), crypto.randomBytes(300)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

// ---------- fake Gemini + fake GitHub ----------
const gem = [];
let RELEASE = null;
const fake = http.createServer(async (req, res) => {
  let b = []; for await (const c of req) b.push(c); b = Buffer.concat(b);
  const J = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const u = req.url;
  if (u.startsWith('/v1beta/models?')) return J({ models: [{ name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-9-flash-image', supportedGenerationMethods: ['generateContent'] }] });
  if (u.includes(':generateContent')) {
    const j = JSON.parse(b.toString()); gem.push({ url: u, body: j });
    if (/image/.test(u)) {
      if (u.includes('gemini-gone-image')) return J({ error: { message: 'not found' } }, 404);
      const prompt = j.contents.at(-1).parts.at(-1).text;
      if (/QUOTA/.test(prompt)) return J({ error: { code: 429, message: 'Quota exceeded for metric generate_content_free_tier_requests, limit: 0' } }, 429);
      return J({ candidates: [{ content: { parts: [{ text: 'Here it is' }, { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] }, finishReason: 'STOP' }] });
    }
    const c = j.contents;
    let li = c.length - 1; while (li >= 0 && !(c[li].role === 'user' && c[li].parts.some(p => p.text !== undefined))) li--;
    const ask = c[li].parts.filter(p => p.text !== undefined).map(p => p.text).join(' ');
    const responses = c.slice(li + 1).flatMap(x => x.parts.filter(p => p.functionResponse));
    const T_ = (text) => J({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
    const F_ = (name, args) => J({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP' }] });
    if (ask.startsWith('[You are a helper')) return T_('ANSWER<' + ask.split('\n\n').pop() + '>');
    if (/SPLIT/.test(ask)) {
      if (responses.length === 0) return F_('delegate', { task: 'part A', title: 'A' });
      if (responses.length === 1) return F_('delegate', { task: 'part B', title: 'B' });
      if (responses.length === 2) return F_('helpers_wait', { max_minutes: 1 });
      const w = responses[2].functionResponse.response.result;
      return T_('Combined: ' + w.helpers.map(h => h.answer).join(' + '));
    }
    const kinds = c[li].parts.filter(p => p.inlineData).map(p => p.inlineData.mimeType);
    return T_('OK saw [' + kinds.join(',') + '] for: ' + ask.slice(0, 80));
  }
  // GitHub
  if (u === '/repos/abish/myassistant/releases/latest') return RELEASE ? J(RELEASE) : J({ message: 'Not Found' }, 404);
  if (u.startsWith('/repos/abish/myassistant/tags')) return J([{ name: 'v2.0.9', tarball_url: 'x' }]);
  if (u === '/assets/tgz') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(TGZ); }
  if (u === '/assets/sha') { res.writeHead(200); return res.end((SHA_OVERRIDE || crypto.createHash('sha256').update(TGZ).digest('hex')) + '  myassistant-latest.tar.gz\n'); }
  J({}, 404);
});
let TGZ = Buffer.from('fake tarball'), SHA_OVERRIDE = '';
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const F = 'http://127.0.0.1:' + fake.address().port;

// ---------- a database shaped like 2.0.1, with history ----------
fs.mkdirSync(DATA, { recursive: true });
{
  const old = new DatabaseSync(DATA + '/assistant.db');
  old.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, channel TEXT, text TEXT, meta TEXT, job_id INTEGER, ts INTEGER);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, status TEXT, title TEXT, progress TEXT, steps INTEGER DEFAULT 0, created INTEGER, updated INTEGER, result TEXT, parent_approval INTEGER, meta TEXT);
    CREATE TABLE memory (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, fact TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, notes TEXT, due INTEGER, remind INTEGER DEFAULT 1, status TEXT DEFAULT 'open', created INTEGER, reminded INTEGER DEFAULT 0);`);
  old.exec("INSERT INTO settings(k,v) VALUES('assistant_name','Abish AI'),('setup_done','1')");
  old.exec("INSERT INTO jobs(channel,status,title,created,updated,result) VALUES('web','done','old job',1,2,'old answer')");
  old.exec("INSERT INTO messages(role,channel,text,job_id,ts) VALUES('owner','web','OLDMSG hello',NULL,1000),('assistant','web','OLDMSG hi there',1,2000),('owner','telegram','OLDMSG from telegram',NULL,3000)");
  old.exec("INSERT INTO memory(ts,fact) VALUES(1,'likes tea')");
  old.exec("INSERT INTO tasks(title,created) VALUES('call Avrum',1)");
  old.close();
}

const PORT = 19000 + Math.floor(Math.random() * 800);
Object.assign(process.env, {
  MA_DATA_DIR: DATA, MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/sites', MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_GEMINI_BASE: F, MA_GITHUB_API: F, MA_RELEASE_BASE: F, MA_TICK_MS: '3600000',
});
const { start } = await import('../src/server.js');
const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const server = start();
await new Promise(r => setTimeout(r, 300));
const BASE = 'http://127.0.0.1:' + PORT;
const S = auth.newSession('127.0.0.1', 'test');
const cookie = S.cookie.split(';')[0], csrf = S.csrf;
async function call(p, body, o = {}) {
  const headers = { ...(o.noAuth ? {} : { Cookie: cookie }), ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-CSRF': o.csrf ?? csrf } : {}), ...(o.headers || {}) };
  const r = await fetch(BASE + p, { method: o.method || (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer()); let j = null; try { j = JSON.parse(buf.toString()); } catch { j = buf; }
  return { status: r.status, j, headers: r.headers, buf };
}
async function upload(buf, type, name, o = {}) {
  const r = await fetch(BASE + '/api/files' + (o.chat ? '?chat=' + o.chat : ''), { method: 'POST', body: buf,
    headers: { ...(o.noAuth ? {} : { Cookie: cookie }), 'X-CSRF': o.csrf ?? csrf, 'Content-Type': type, 'X-File-Name': encodeURIComponent(name) } }).catch(e => ({ status: 'neterr:' + e.message, json: async () => ({}) }));
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function jobDone(id, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const j = db.get('SELECT * FROM jobs WHERE id=?', id); if (['done', 'error', 'cancelled'].includes(j.status)) return j; await sleep(50); }
  throw new Error('job ' + id + ' did not finish');
}
test.after(() => { server.close(); fake.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });

test('migration: 2.0.1 history becomes "Chat 1", nothing lost, backup kept', () => {
  const chats = db.all('SELECT * FROM chats');
  assert.equal(chats.length, 1); assert.equal(chats[0].title, 'Chat 1');
  const msgs = db.all('SELECT * FROM messages ORDER BY id');
  assert.equal(msgs.length, 3); assert.ok(msgs.every(m => m.chat_id === chats[0].id));
  assert.equal(db.get('SELECT chat_id FROM jobs WHERE id=1').chat_id, chats[0].id);
  assert.equal(db.setting('main_chat'), String(chats[0].id));
  assert.equal(db.get('SELECT fact FROM memory').fact, 'likes tea');
  assert.equal(db.get('SELECT title FROM tasks').title, 'call Avrum');
  assert.equal(db.setting('assistant_name'), 'Abish AI');
  const backups = fs.readdirSync(DATA + '/backups').filter(f => /^pre-2\.1\.0-\d+\.db$/.test(f));
  assert.equal(backups.length, 1);
  const b = new DatabaseSync(DATA + '/backups/' + backups[0], { readOnly: true });
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 3); b.close();
  assert.equal(db.get('PRAGMA user_version').user_version, 2);
});

test('migration is idempotent (second start changes nothing, no second backup)', () => {
  db.migrate(DATA + '/assistant.db');
  db.migrate(DATA + '/assistant.db');
  assert.equal(db.all('SELECT * FROM chats').length, 1);
  assert.equal(db.all('SELECT * FROM messages').length, 3);
  assert.equal(fs.readdirSync(DATA + '/backups').filter(f => f.startsWith('pre-2.1.0')).length, 1);
});


let CHAT1, CHAT2;
test('chats: list, create, rename, old history in Chat 1', async () => {
  let r = await call('/api/chats'); assert.equal(r.status, 200);
  CHAT1 = r.j.chats[0].id; assert.equal(r.j.main, CHAT1); assert.equal(r.j.chats[0].count, 3);
  r = await call('/api/chat'); assert.equal(r.j.chat.id, CHAT1); assert.equal(r.j.messages.length, 3);
  r = await call('/api/chats', {}); assert.equal(r.status, 200); CHAT2 = r.j.chat.id; assert.equal(r.j.chat.title, 'New chat');
  r = await call('/api/chats/' + CHAT2, { title: 'Pictures' }); assert.equal(r.j.chat.title, 'Pictures');
  r = await call('/api/chats/' + CHAT2, { title: '  ' }); assert.equal(r.status, 400);
  r = await call('/api/chat?chat=' + CHAT2); assert.equal(r.j.messages.length, 0); assert.equal(r.j.chat.title, 'Pictures');
  r = await call('/api/chat?chat=99999'); assert.equal(r.status, 404);
  r = await call('/api/chats', undefined, { noAuth: true }); assert.equal(r.status, 401);
  r = await call('/api/chats', {}, { csrf: 'nope' }); assert.equal(r.status, 403);
});

test('security headers allow mic + camera for this site only', async () => {
  const r = await fetch(BASE + '/');
  assert.match(r.headers.get('permissions-policy'), /microphone=\(self\)/);
  assert.match(r.headers.get('permissions-policy'), /camera=\(self\)/);
  assert.match(r.headers.get('content-security-policy'), /media-src 'self' blob:/);
});

let IMG;
test('uploads: login + CSRF required, 20 MB limit, type checks, owner-only download with ranges', async () => {
  let r = await upload(PNG, 'image/png', 'a.png', { noAuth: true }); assert.equal(r.status, 401);
  r = await upload(PNG, 'image/png', 'a.png', { csrf: 'bad' }); assert.equal(r.status, 403);
  r = await upload(Buffer.alloc(20 * 1024 * 1024 + 10), 'application/pdf', 'big.pdf');
  assert.ok(r.status === 413 || String(r.status).startsWith('neterr'), 'too large refused: ' + r.status);
  r = await upload(Buffer.from('MZ....'), 'application/x-msdownload', 'virus.exe'); assert.equal(r.status, 415);
  r = await upload(Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml', 'x.svg'); assert.equal(r.status, 415);
  r = await upload(Buffer.from('not a png'), 'image/png', 'fake.png'); assert.equal(r.status, 415);
  r = await upload(PNG, 'image/png', 'photo.png', { chat: CHAT2 }); assert.equal(r.status, 200); IMG = r.j.file;
  assert.equal(IMG.kind, 'image'); assert.equal(IMG.size, PNG.length); assert.match(IMG.id, /^[a-f0-9]{32}$/);
  assert.equal(fs.statSync(path.join(DATA, 'files', IMG.id)).mode & 0o777, 0o600);
  r = await call('/api/files/' + IMG.id, undefined, { noAuth: true }); assert.equal(r.status, 401);
  r = await call('/api/files/' + IMG.id); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png'); assert.ok(r.buf.equals(PNG));
  r = await call('/api/files/' + IMG.id, undefined, { headers: { Range: 'bytes=0-3' } }); assert.equal(r.status, 206); assert.equal(r.buf.length, 4);
  assert.equal(r.headers.get('content-range'), `bytes 0-3/${PNG.length}`);
  r = await call('/api/files/' + IMG.id + '?download=1'); assert.match(r.headers.get('content-disposition'), /^attachment/);
  r = await call('/api/files/' + 'f'.repeat(32)); assert.equal(r.status, 404);
  const md = await upload(Buffer.from('# notes'), '', 'notes.md'); assert.equal(md.status, 200); assert.equal(md.j.file.kind, 'text');
});

test('message with a photo: Gemini gets inlineData + text; only this chat\'s history', async () => {
  db.setSecret('gemini_api_key', 'AIzaFAKEKEY_' + 'x'.repeat(30));
  gem.length = 0;
  const r = await call('/api/chat', { text: 'what is in this picture?', chat_id: CHAT2, files: [IMG.id] });
  assert.equal(r.status, 200);
  const job = await jobDone(r.j.job); assert.equal(job.status, 'done', job.result);
  assert.equal(job.chat_id, CHAT2);
  const req = gem.at(-1).body;
  const last = req.contents.at(-1);
  assert.equal(last.role, 'user');
  assert.deepEqual(last.parts[0], { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } });
  assert.equal(last.parts.at(-1).text, 'what is in this picture?');
  assert.ok(!JSON.stringify(req.contents).includes('OLDMSG'), 'other chat\'s history is not sent');
  const c = await call('/api/chat?chat=' + CHAT2);
  const owner = c.j.messages.find(m => m.role === 'owner');
  assert.equal(owner.files[0].id, IMG.id);
  assert.match(c.j.messages.find(m => m.role === 'assistant').text, /OK saw \[image\/png\]/);
  // a file cannot be sent twice
  const again = await call('/api/chat', { text: 'again', chat_id: CHAT2, files: [IMG.id] }); assert.equal(again.status, 400);
  // the next message in the same chat still carries the recent photo as context
  gem.length = 0;
  const r2 = await call('/api/chat', { text: 'and the colours?', chat_id: CHAT2 });
  await jobDone(r2.j.job);
  const flat = JSON.stringify(gem.at(-1).body.contents);
  assert.ok(flat.includes(PNG.toString('base64').slice(0, 40)), 'recent photo still in context');
  assert.ok(flat.includes('what is in this picture?'));
});

test('voice note (no words), PDF and Word file reach Gemini; old chat untouched', async () => {
  gem.length = 0;
  const v = await upload(WAV, 'audio/wav', 'voice-note.wav'); assert.equal(v.status, 200);
  let r = await call('/api/chat', { text: '', chat_id: CHAT2, files: [v.j.file.id] }); assert.equal(r.status, 200);
  let job = await jobDone(r.j.job); assert.equal(job.status, 'done');
  let last = gem.at(-1).body.contents.at(-1);
  assert.equal(last.parts[0].inlineData.mimeType, 'audio/wav');
  assert.match(last.parts.at(-1).text, /voice note/);
  const p = await upload(PDF, 'application/pdf', 'invoice.pdf'); assert.equal(p.status, 200);
  const docx = makeDocx('Hello from Word. Total: 42 dollars.');
  const d = await upload(docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'letter.docx'); assert.equal(d.status, 200);
  gem.length = 0;
  r = await call('/api/chat', { text: 'summarize these', chat_id: CHAT2, files: [p.j.file.id, d.j.file.id] });
  job = await jobDone(r.j.job); assert.equal(job.status, 'done');
  last = gem.at(-1).body.contents.at(-1);
  assert.equal(last.parts[0].inlineData.mimeType, 'application/pdf');
  assert.match(last.parts.at(-1).text, /summarize these[\s\S]*Word file "letter\.docx"[\s\S]*Total: 42 dollars/);
  assert.equal(db.all('SELECT * FROM messages WHERE chat_id=?', CHAT1).length, 3);
  const empty = await call('/api/chat', { text: '', chat_id: CHAT2 }); assert.equal(empty.status, 400);
});

test('second provider: images as data URLs, voice/PDF become a clear note', async () => {
  const { openaiUserContent } = await import('../src/brain.js');
  const c = openaiUserContent({ text: 'hi', media: [{ kind: 'image', mime: 'image/png', data: 'AAA', name: 'a.png' }, { kind: 'audio', mime: 'audio/wav', data: 'BBB', name: 'v.wav' }] });
  assert.equal(c[1].image_url.url, 'data:image/png;base64,AAA');
  assert.match(c[0].text, /cannot open it.*Gemini/);
  assert.equal(openaiUserContent({ text: 'plain' }), 'plain');
});

test('picture creation: saved, shown in the chat, downloadable; free-key refusal is friendly', async () => {
  const tools = await import('../src/tools/index.js');
  const t = tools.byName('image_generate');
  db.setSetting('image_model', 'gemini-gone-image');   // retired id -> falls back to a listed image model
  let r = await t.run({ prompt: 'a sunrise over Jerusalem' }, { chatId: CHAT2 });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.model, 'gemini-9-flash-image');
  const f = db.get('SELECT * FROM files WHERE id=?', r.file_id);
  assert.equal(f.kind, 'image'); assert.ok(fs.readFileSync(path.join(DATA, 'files', f.id)).equals(PNG));
  const m = db.get('SELECT * FROM messages WHERE id=?', f.message_id);
  assert.equal(m.role, 'assistant'); assert.equal(m.chat_id, CHAT2);
  const c = await call('/api/chat?chat=' + CHAT2);
  assert.ok(c.j.messages.some(x => x.files && x.files.some(ff => ff.id === f.id)));
  db.setSetting('image_model', 'gemini-9-flash-image');
  r = await t.run({ prompt: 'QUOTA test' }, { chatId: CHAT2 });
  assert.match(r.error, /isn't available on your free Gemini key/);
});

test('helpers: a job splits into 2 helper jobs, waits, and combines their answers', async () => {
  const r = await call('/api/chat', { text: 'SPLIT this research', chat_id: CHAT2 });
  const job = await jobDone(r.j.job, 20000);
  assert.equal(job.status, 'done', job.result);
  assert.equal(job.result, 'Combined: ANSWER<part A> + ANSWER<part B>');
  const kids = db.all('SELECT * FROM jobs WHERE parent_job=?', job.id);
  assert.equal(kids.length, 2); assert.ok(kids.every(k => k.status === 'done' && k.chat_id === CHAT2));
  const texts = db.all('SELECT text FROM messages WHERE chat_id=?', CHAT2).map(x => x.text);
  assert.ok(!texts.some(t => /^ANSWER</.test(t)), 'helper answers go to the parent, not the chat');
  const tools = await import('../src/tools/index.js');
  assert.ok(!tools.declarations({ helper: true }).some(d => d.name === 'delegate'), 'helpers cannot delegate');
  const nested = await tools.byName('delegate').run({ task: 'x' }, { jobId: kids[0].id, isHelper: true });
  assert.match(nested.error, /cannot start more helpers/);
});

test('settings: jobs at the same time (1-6), update source', async () => {
  let r = await call('/api/settings', { max_parallel: '9' }); assert.equal(r.status, 400);
  r = await call('/api/settings', { max_parallel: '4' }); assert.equal(r.status, 200);
  const { maxParallel } = await import('../src/brain.js'); assert.equal(maxParallel(), 4);
  r = await call('/api/settings', { update_repo: 'not a repo!' }); assert.equal(r.status, 400);
  r = await call('/api/settings', { update_repo: 'https://github.com/abish/myassistant.git' }); assert.equal(r.status, 200);
  assert.equal(db.setting('update_repo'), 'abish/myassistant');
  r = await call('/api/update/check', {}); assert.equal(r.status, 200); assert.equal(r.j.latest, '2.0.9');   // tags only
  RELEASE = { tag_name: 'v2.9.0', body: 'New stuff', tarball_url: F + '/tarball', assets: [{ name: 'myassistant-latest.tar.gz', url: F + '/assets/tgz' }, { name: 'myassistant-latest.tar.gz.sha256', url: F + '/assets/sha' }] };
  r = await call('/api/update/check', {}); assert.equal(r.j.latest, '2.9.0'); assert.equal(r.j.newer, true);   // 2.2: was v2.2.0, now the running version
  r = await call('/api/update'); assert.equal(r.j.repo, 'abish/myassistant');
});

test('root updater helper: reads the source as the app user, downloads + verifies the GitHub asset', async () => {
  const env = { ...process.env, MA_DATA_DIR: DATA };
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'bin/update-source.mjs', 'read'], { env, cwd: path.resolve(import.meta.dirname, '..') }).toString();
  assert.deepEqual(JSON.parse(out), { repo: 'abish/myassistant', token: '' });
  const dir = fs.mkdtempSync(path.join(T, 'upd-'));
  TGZ = crypto.randomBytes(500);
  let p = await spawnP(process.execPath, ['bin/update-source.mjs', 'fetch', dir], { env: { ...env, MA_UPDATE_REPO: 'abish/myassistant' }, cwd: path.resolve(import.meta.dirname, '..') });
  assert.equal(p.status, 0, p.stderr);
  assert.ok(fs.readFileSync(path.join(dir, 'app.tgz')).equals(TGZ));
  SHA_OVERRIDE = '0'.repeat(64);
  const dir2 = fs.mkdtempSync(path.join(T, 'upd-'));
  p = await spawnP(process.execPath, ['bin/update-source.mjs', 'fetch', dir2], { env: { ...env, MA_UPDATE_REPO: 'abish/myassistant' }, cwd: path.resolve(import.meta.dirname, '..') });
  assert.equal(p.status, 2); assert.ok(!fs.existsSync(path.join(dir2, 'app.tgz')));
  SHA_OVERRIDE = '';
});

test('2.1.1 voice player: waveform + length for a real WAV voice note, login required, app files revalidate', async () => {
  // 1.5 s of 16 kHz mono PCM: quiet first half, loud second half
  const n = 24000, pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * (i < n / 2 ? 1500 : 20000)), i * 2);
  const hdr = Buffer.alloc(44); hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(16000, 24); hdr.writeUInt32LE(32000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
  const v = await upload(Buffer.concat([hdr, pcm]), 'audio/wav', 'voice-note.wav'); assert.equal(v.status, 200);
  let r = await call('/api/files/' + v.j.file.id + '/wave');
  assert.equal(r.status, 200); assert.equal(r.j.duration, 1.5); assert.equal(r.j.peaks.length, 40);
  assert.ok(r.j.peaks[5] < 0.2 && r.j.peaks[35] > 0.9, 'quiet part low, loud part high');
  assert.equal((await call('/api/files/' + v.j.file.id + '/wave', undefined, { noAuth: true })).status, 401);
  assert.equal((await call('/api/files/' + IMG.id + '/wave')).status, 400);
  assert.equal((await call('/api/files/' + 'e'.repeat(32) + '/wave')).status, 404);
  const odd = await upload(WAV, 'audio/wav', 'odd.wav');   // not a valid PCM WAV: no crash, browser draws a neutral waveform
  r = await call('/api/files/' + odd.j.file.id + '/wave'); assert.equal(r.status, 200); assert.equal(r.j.peaks, null);
  // static app files: no-cache + ETag, 304 on revalidation (so an update shows at once)
  const a = await fetch(BASE + '/app.js'); assert.equal(a.headers.get('cache-control'), 'no-cache'); const et = a.headers.get('etag'); assert.ok(et);
  const js = await a.text(); assert.ok(js.includes('function voicePlayer') && !/controls:\s*true/.test(js), 'custom voice player, no browser audio controls');
  const b = await fetch(BASE + '/app.js', { headers: { 'If-None-Match': et } }); assert.equal(b.status, 304);
});

test('deleting a chat removes its messages and files; tasks and memory stay', async () => {
  const ids = db.all('SELECT id FROM files WHERE chat_id=?', CHAT2).map(f => f.id);
  assert.ok(ids.length >= 4);
  let r = await call('/api/chats/' + CHAT2 + '/delete', {}); assert.equal(r.status, 200);
  for (const id of ids) assert.ok(!fs.existsSync(path.join(DATA, 'files', id)));
  assert.equal(db.all('SELECT * FROM messages WHERE chat_id=?', CHAT2).length, 0);
  r = await call('/api/chat?chat=' + CHAT2); assert.equal(r.status, 404);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM memory').n, 1); assert.equal(db.get('SELECT COUNT(*) AS n FROM tasks').n, 1);
  // deleting the main chat: the next message from another channel finds a home
  await call('/api/chats/' + CHAT1 + '/delete', {});
  const { addMessage } = await import('../src/notify.js');
  const mid = addMessage('owner', 'telegram', 'after delete');
  const row = db.get('SELECT chat_id FROM messages WHERE id=?', mid);
  assert.ok(db.get('SELECT id FROM chats WHERE id=?', row.chat_id));
});

// minimal .docx (zip, stored) with word/document.xml
function makeDocx(text) {
  const name = Buffer.from('word/document.xml');
  const data = Buffer.from(`<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  const crc = crc32(data);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const local = Buffer.concat([lh, name, data]);
  const central = Buffer.concat([cd, name]);
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10); eo.writeUInt32LE(central.length, 12); eo.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eo]);
}
function crc32(b) { let c, crc = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
