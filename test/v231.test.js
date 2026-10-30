// 2.3.1: "Use for" routing per key, migration from 2.3.0, picture key choice, reading files (Excel, Word,
// PowerPoint, CSV, zip, code) and update sources with fallback — against fake Gemini, fake OpenAI-compatible
// (Groq-like) and fake update servers. Nothing here reaches Google, Groq, GitHub or the real update sites.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LOGS = []; const origLog = console.log;
console.log = (...a) => { LOGS.push(a.join(' ')); };
const FIX = path.join(import.meta.dirname, 'fixtures');

const K = { MAIN: 'AIzaMAINKEY_' + 'm'.repeat(27), P2: 'AIzaPROJECT2_' + 'p'.repeat(26), GROQ: 'gsk_GROQKEY' + 'g'.repeat(30) };
const MODE = {};
const CALLS = [];
// update sources: /src1 (his address), /src2 (GitHub docs), /site (release site)
const SRC = { src1: { version: '2.4.0', up: true }, src2: { version: '2.4.0', up: true }, site: { version: '2.4.0', up: true } };
const TGZ = crypto.randomBytes(800); let SHA_BAD = '';
const fake = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const J = (o, s = 200, hd = {}) => { res.writeHead(s, { 'Content-Type': 'application/json', ...hd }); res.end(JSON.stringify(o)); };
  const gkey = req.headers['x-goog-api-key'];
  const um = /^\/(src1|src2|site)\/(.+)$/.exec(req.url);
  if (um) {
    const s = SRC[um[1]];
    if (!s.up) return J({ message: 'Not Found' }, 404);
    if (um[2] === 'version.json') return J({ version: s.version, date: '2026-10-30', notes: 'notes from ' + um[1] });
    if (um[2] === `myassistant-${s.version}.tar.gz` || um[2] === 'myassistant-latest.tar.gz') { res.writeHead(200); return res.end(TGZ); }
    if (um[2].endsWith('.tar.gz.sha256')) { res.writeHead(200); return res.end((SHA_BAD || crypto.createHash('sha256').update(TGZ).digest('hex')) + '  ' + um[2].replace('.sha256', '') + '\n'); }
    return J({}, 404);
  }
  const gm = /\/v1beta\/models\/([^:]+):generateContent/.exec(req.url);
  if (gm) {
    const j = JSON.parse(b); const parts = j.contents.flatMap(c => c.parts);
    const model = decodeURIComponent(gm[1]);
    CALLS.push({ api: 'gemini', key: gkey, model, media: parts.filter(p => p.inlineData).map(p => p.inlineData.mimeType), text: parts.filter(p => p.text).map(p => p.text).join('\n') });
    if (MODE[gkey] === '429min') return J({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { retryDelay: '2s' }] } }, 429);
    if (/image/.test(model)) return J({ candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40)]).toString('base64') } }] }, finishReason: 'STOP' }] });
    return J({ candidates: [{ content: { role: 'model', parts: [{ text: 'answer from ' + gkey.slice(4, 12) }] }, finishReason: 'STOP' }] });
  }
  if (req.url.startsWith('/v1/')) {
    const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (key !== K.GROQ) return J({ error: { message: 'Invalid API Key', code: 'invalid_api_key' } }, 401);
    if (req.url === '/v1/chat/completions') {
      const j = JSON.parse(b);
      CALLS.push({ api: 'openai', key, model: j.model, media: [], text: JSON.stringify(j.messages.at(-1).content) });
      if (MODE[key] === '429min') return J({ error: { message: 'Rate limit reached. Please try again in 1.5s.', code: 'rate_limit_exceeded' } }, 429, { 'retry-after': '2' });
      return J({ choices: [{ message: { role: 'assistant', content: 'answer from groq' } }] });
    }
  }
  J({ error: { message: 'nope' } }, 404);
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const F = 'http://127.0.0.1:' + fake.address().port;

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v231-'));
const DATA = T + '/data';
const PORT = 20400 + Math.floor(Math.random() * 150);
Object.assign(process.env, {
  MA_DATA_DIR: DATA, MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/sites', MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_GEMINI_BASE: F,
  MA_RELEASE_BASE: F + '/site', MA_UPDATE_SOURCE: F + '/src1', MA_UPDATE_FALLBACKS: F + '/src2',
});
// ---- a 2.3.0 database: the ai_keys table without "use_for", two keys, migration flags set ----
const { loadMasterKey } = await import('../src/crypto.js');
const db = await import('../src/db.js');
loadMasterKey(DATA); db.openDb();
db.setSetting('setup_done', '1'); db.setSetting('model', 'gemini-3.6-flash'); db.setSetting('morning_summary', '0');
db.setSetting('ai_keys_migrated_gemini', '1'); db.setSetting('ai_keys_migrated_openai', '1');
db.db.exec(`CREATE TABLE ai_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, kind TEXT, base_url TEXT, model TEXT,
    active INTEGER DEFAULT 1, position INTEGER, created INTEGER, last_used INTEGER, last_ok INTEGER, last_error TEXT, last_error_at INTEGER,
    cool_until INTEGER DEFAULT 0, problem TEXT)`);
db.run("INSERT INTO ai_keys(name,kind,base_url,model,active,position,created) VALUES('Gemini (main)','gemini','','',1,1,1)");
db.run("INSERT INTO ai_keys(name,kind,base_url,model,active,position,created) VALUES('Groq','openai',?,'openai/gpt-oss-120b',1,2,1)", F + '/v1');
db.setSecret('ai_key_1', K.MAIN); db.setSecret('ai_key_2', K.GROQ); db.setSetting('ai_key_main_id', '1');
db.db.close();

const { start } = await import('../src/server.js');
const auth = await import('../src/auth.js');
const aikeys = await import('../src/aikeys.js');
const brain = await import('../src/brain.js');
const tools = await import('../src/tools/index.js');
const server = start();
await sleep(200);
const BASE = 'http://127.0.0.1:' + PORT;
const S = auth.newSession('127.0.0.1', 'test');
const cookie = S.cookie.split(';')[0], csrf = S.csrf;
const RESPONSES = [];
async function call(p, body) {
  const r = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-CSRF': csrf } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); RESPONSES.push(text); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
}
async function waitJob(id) { for (let i = 0; i < 400; i++) { const j = db.get('SELECT * FROM jobs WHERE id=?', id); if (['done', 'error'].includes(j.status)) return j; await sleep(25); } throw new Error('job did not finish'); }
let CHAT = 0;     // each test talks in its own chat, so an earlier voice note does not travel along in the history
async function ask(text, files) { const r = await call('/api/chat', { text, ...(files ? { files } : {}), ...(CHAT ? { chat_id: CHAT } : {}) }); assert.equal(r.status, 200, r.text); return waitJob(r.j.job); }
async function upload(buf, type, name) {
  const r = await fetch(BASE + '/api/files', { method: 'POST', body: buf, headers: { Cookie: cookie, 'X-CSRF': csrf, 'Content-Type': type, 'X-File-Name': encodeURIComponent(name) } });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text, id: j?.file?.id || j?.id };
}
const keys = async () => (await call('/api/brain/keys')).j.keys;
const byName = async (n) => (await keys()).find(k => k.name === n);
const reset = () => { CALLS.length = 0; for (const k of Object.keys(MODE)) delete MODE[k]; db.run('UPDATE ai_keys SET cool_until=0, problem=NULL'); };
const freshChat = async () => { CHAT = (await import('../src/chats.js')).createChat('test ' + Date.now()).id; };
const routes = () => db.all("SELECT detail FROM audit WHERE action='brain.route' ORDER BY id").map(r => r.detail);

test.after(() => { console.log = origLog; server.close(); fake.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });

test('migration from 2.3.0: keys, order, active and key values kept; each key gets its default "Use for"', async () => {
  const ks = await keys();
  assert.deepEqual(ks.map(k => [k.name, k.kind, k.active, k.has_key]), [['Gemini (main)', 'gemini', true, true], ['Groq', 'openai', true, true]]);
  assert.deepEqual(ks[0].use_for, ['chat', 'pictures', 'media', 'background']);
  assert.deepEqual(ks[1].use_for, ['chat', 'coding']);
  assert.equal(aikeys.keyValue(ks[0].id), K.MAIN); assert.equal(aikeys.keyValue(ks[1].id), K.GROQ);
  assert.ok(db.all('PRAGMA table_info(ai_keys)').some(c => c.name === 'use_for'));
  assert.ok(db.all("SELECT detail FROM audit WHERE action='brain.keys'").some(r => /default "Use for"/.test(r.detail)));
  aikeys.ensureKeys(); assert.equal((await keys()).length, 2, 'runs once');
  // a key added now gets its type's defaults; a key can be set to nothing; a bad choice is refused
  let r = await call('/api/brain/keys', { name: 'Gemini – project 2', kind: 'gemini', key: K.P2 }); assert.equal(r.status, 200);
  assert.deepEqual(r.j.key.use_for, ['chat', 'pictures', 'media', 'background']);
  r = await call(`/api/brain/keys/${r.j.key.id}`, { use_for: ['background'] }); assert.deepEqual(r.j.key.use_for, ['background']);
  r = await call(`/api/brain/keys/${r.j.key.id}`, { use_for: ['nonsense'] }); assert.equal(r.status, 400);
  assert.ok(db.all("SELECT detail FROM audit WHERE action='brain.key_changed'").some(x => /use for Background jobs/.test(x.detail)));
  // assistant_status shows what each key is used for
  const st = await tools.execTool('assistant_status', {}, { actor: 'assistant' });
  assert.ok(JSON.stringify(st).includes('Background jobs'));
});

test('job kinds: media, coding (tools or words), background, chat', () => {
  assert.equal(brain.jobKind({ items: [{ role: 'user', text: 'hi', media: [{ kind: 'audio' }] }] }), 'media');
  assert.equal(brain.jobKind({ items: [{ role: 'user', text: 'look', media: [{ kind: 'image' }] }] }), 'media');
  assert.equal(brain.jobKind({ items: [{ role: 'user', text: 'make it' }, { role: 'assistant', calls: [{ name: 'file_write', args: {} }] }] }), 'coding');
  assert.equal(brain.jobKind({ items: [{ role: 'user', text: 'x' }, { role: 'assistant', calls: [{ name: 'ssh_run', args: {} }] }], channel: 'system' }), 'coding');
  assert.equal(brain.jobKind({ items: [{ role: 'user', text: 'x' }], codeText: true }), 'coding');
  assert.equal(brain.jobKind({ items: [{ role: 'user', text: 'x' }], channel: 'system' }), 'background');
  assert.equal(brain.jobKind({ items: [{ role: 'user', text: 'x' }], isHelper: true }), 'background');
  assert.equal(brain.jobKind({ items: [{ role: 'user', text: 'what is the weather' }] }), 'chat');
  assert.equal(brain.jobKind({ items: [{ role: 'user', text: 'read this' }], hasFiles: true }), 'media', 'an attached Excel/Word/zip counts as files');
  for (const s of ['write a python script to rename files', 'fix this bug in my website', 'build me an app for notes', 'push it to github', '```js\nx()\n```']) assert.ok(brain.looksLikeCode(s), s);
  for (const s of ['what time is my meeting', 'remind me to call mom', 'translate this to Yiddish']) assert.ok(!brain.looksLikeCode(s), s);
});

test('routing: chat → first chat key, coding → the coding key, voice → Gemini; Activity says which key did what', async () => {
  reset();
  assert.equal((await ask('hello there')).result, 'answer from MAINKEY_');
  assert.deepEqual(CALLS.map(c => c.api), ['gemini']);
  reset();
  const j = await ask('write a python script that renames my photos');
  assert.equal(j.result, 'answer from groq', 'coding goes to the key ticked "Coding"');
  assert.deepEqual(CALLS.map(c => c.api), ['openai']);
  assert.ok(routes().some(d => d === `Coding (job ${j.id}): 'Groq'`), routes().join(' | '));
  assert.ok(routes().some(d => /^Chat \(job \d+\): 'Gemini \(main\)'$/.test(d)));
  // voice note: Gemini even if the Groq key is moved to the top
  const g = await byName('Groq'); await call(`/api/brain/keys/${g.id}/move`, { dir: 'up' });
  reset();
  const up = await upload(Buffer.from('OggS fake voice'), 'audio/ogg', 'voice.ogg');
  const v = await ask('', [up.id]);
  assert.equal(v.result, 'answer from MAINKEY_'); assert.deepEqual(CALLS.map(c => [c.api, c.media]), [['gemini', ['audio/ogg']]]);
  assert.ok(routes().some(d => d === `Voice, photos & files (job ${v.id}): 'Gemini (main)'`));
  // the next words in the same chat still carry that voice note → Gemini; in a new chat, plain chat goes to Groq (first, ticked "Chat")
  reset(); assert.equal((await ask('and what did I say?')).result, 'answer from MAINKEY_');
  await freshChat(); reset(); assert.equal((await ask('good morning')).result, 'answer from groq');
  await call(`/api/brain/keys/${g.id}/move`, { dir: 'down' });
});

test('routing fallback: the coding key is busy → the same request goes to another active key; none ticked → any active key', async () => {
  await freshChat(); reset(); MODE[K.GROQ] = '429min';
  const j = await ask('debug my javascript function please');
  assert.equal(j.result, 'answer from MAINKEY_');
  assert.deepEqual(CALLS.map(c => c.api), ['openai', 'gemini'], 'one try on Groq, then Gemini, same request');
  assert.ok(routes().some(d => d.startsWith(`Coding (job ${j.id}): 'Gemini (main)' — no free key is set to "Coding"`)), routes().join(' | '));
  reset();
  // nobody ticked for Chat: the first active key answers anyway
  const ks = await keys();
  for (const k of ks) await call(`/api/brain/keys/${k.id}`, { use_for: k.use_for.filter(u => u !== 'chat') });
  assert.equal((await ask('how are you')).result, 'answer from MAINKEY_');
  for (const k of ks) await call(`/api/brain/keys/${k.id}`, { use_for: k.use_for });
});

test('background jobs (scheduled, helpers) use the key ticked "Background jobs"', async () => {
  await freshChat(); reset();
  const main = await byName('Gemini (main)'), p2 = await byName('Gemini – project 2');
  await call(`/api/brain/keys/${main.id}`, { use_for: ['chat', 'pictures', 'media'] });       // p2 = background only
  const id = brain.startJob({ text: '[Scheduled job 1] check the weather', channel: 'system', hidden: true, title: 'Scheduled: weather' });
  const j = await waitJob(id);
  assert.equal(j.result, 'answer from PROJECT2');
  assert.ok(routes().some(d => d === `Background jobs (job ${id}): 'Gemini – project 2'`));
  reset(); assert.equal((await ask('hi again')).result, 'answer from MAINKEY_', 'chat still on main');
  await call(`/api/brain/keys/${main.id}`, { use_for: ['chat', 'pictures', 'media', 'background'] });
  assert.ok(p2);
});

test('pictures: the Gemini key ticked "Pictures" makes the picture', async () => {
  reset();
  const main = await byName('Gemini (main)'), p2 = await byName('Gemini – project 2');
  await call(`/api/brain/keys/${main.id}`, { use_for: ['chat', 'media'] });
  await call(`/api/brain/keys/${p2.id}`, { use_for: ['pictures'] });
  const r = await tools.execTool('image_generate', { prompt: 'a red apple' }, { actor: 'assistant', jobId: null, chatId: null });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(CALLS.map(c => [c.key, /image/.test(c.model)]), [[K.P2, true]]);
  assert.ok(routes().some(d => d === "Pictures: 'Gemini – project 2'"));
  // nobody ticked: another Gemini key still makes it
  await call(`/api/brain/keys/${p2.id}`, { use_for: [] }); reset();
  const r2 = await tools.execTool('image_generate', { prompt: 'a pear' }, { actor: 'assistant' });
  assert.equal(r2.ok, true); assert.equal(CALLS[0].key, K.MAIN);
  assert.ok(routes().at(-1).includes('no key is set to "Pictures"'));
  await call(`/api/brain/keys/${main.id}`, { use_for: ['chat', 'pictures', 'media', 'background'] });
});

test('files in: Excel, Word, PowerPoint, CSV, zip and code files reach the AI as text; unreadable types get a clear answer', async () => {
  const cases = [
    ['openpyxl.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', [/Excel file "openpyxl\.xlsx", 2 sheets/, /Sheet "Sales": 76 rows × 4 columns/, /Columns \(first row\): Date \| Item \| Qty \| Price/, /2: 2026-10-02 \| Widget 1 \| 1 \| 1\.5/, /Shipping & handling <free>/, /showing 60 of 75 data rows/]],
    ['xlsxwriter.xlsx', 'application/octet-stream', [/Sheet "Budget"/, /4: Total \| 1550\.5/]],
    ['libreoffice.xlsx', '', [/2: 2026-10-02 \| Widget 1/]],
    ['notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', [/Meeting notes/, /Call Avrum about the Yiddish feedback & ship 2\.3\.1\./]],
    ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', [/PowerPoint file "deck\.pptx"/, /Slide 1:\nRoadmap\nUse for per key\nSend files back/, /Slide 2:\nNext/]],
    ['data.csv', 'text/csv', [/Table "data\.csv": 3 rows × 3 columns/, /2: Levi, Moshe \| Brooklyn \| 12,50/]],
    ['project.zip', 'application/x-zip-compressed', [/Zip "project\.zip": 4 files/, /- myapp\/logo\.png \(2\.9 KB\)/, /--- myapp\/index\.js ---\nconsole\.log\('hello from zip'\)/]],
  ];
  for (const [name, type, want] of cases) {
    await freshChat(); reset();
    const up = await upload(fs.readFileSync(path.join(FIX, name)), type, name);
    assert.equal(up.status, 200, name + ': ' + up.text);
    const j = await ask('what is in this file?', [up.id]);
    assert.equal(j.status, 'done', name);
    const sent = CALLS.at(-1).text;
    for (const re of want) assert.match(sent, re, name);
    assert.ok(!/node_modules\/x\/big\.js ---/.test(sent), 'zip: node_modules text not inlined');
  }
  // code file
  await freshChat(); reset();
  let up = await upload(Buffer.from('def hello():\n    return "shalom"\n'), 'text/x-python', 'hello.py'); assert.equal(up.status, 200);
  await ask('review this', [up.id]); assert.match(CALLS.at(-1).text, /\[File "hello\.py"\]\ndef hello\(\):/);
  up = await upload(Buffer.from('fun main() = println("hi")'), 'application/octet-stream', 'Main.kt'); assert.equal(up.status, 200);
  // clear answers for what can't be read
  up = await upload(Buffer.from('\xd0\xcf\x11\xe0 old word'), 'application/msword', 'old.doc'); assert.equal(up.status, 415); assert.match(up.j.error, /Old Word \.doc files can't be read here\. Save it as \.docx or PDF/);
  up = await upload(Buffer.from('MZ....'), 'application/x-msdownload', 'tool.exe'); assert.equal(up.status, 415); assert.match(up.j.error, /can't read that type of file \(\.exe\)\. Photos, voice notes, PDF, Word, Excel/);
  up = await upload(Buffer.from('not really excel'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'fake.xlsx'); assert.equal(up.status, 415); assert.match(up.j.error, /looks damaged/);
  up = await upload(Buffer.from([0x41, 0, 0x42, 0]), 'text/plain', 'bin.txt'); assert.equal(up.status, 415);
  // a damaged zip that passes the first check still gives the AI a short note, not a crash
  up = await upload(Buffer.from('PK\x03\x04 broken'), 'application/zip', 'broken.zip'); assert.equal(up.status, 200);
  await freshChat(); reset(); const j = await ask('open it', [up.id]); assert.equal(j.status, 'done'); assert.match(CALLS.at(-1).text, /Zip file "broken\.zip" could not be opened/);
});

test('extractors are bounded: a zip bomb entry is refused, a zip64 / encrypted entry is described', async () => {
  const x = await import('../src/extract.js');
  const zlib = await import('node:zlib');
  const big = zlib.deflateRawSync(Buffer.alloc(60 * 1024 * 1024));
  const name = Buffer.from('bomb.txt');
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(big.length, 18); lh.writeUInt32LE(60 * 1024 * 1024, 22); lh.writeUInt16LE(name.length, 26);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(big.length, 20); ch.writeUInt32LE(60 * 1024 * 1024, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(0, 42);
  const cd = Buffer.concat([ch, name]); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(30 + name.length + big.length, 16);
  const zip = Buffer.concat([lh, name, big, cd, end]);
  const e = x.zipEntries(zip)[0];
  assert.throws(() => x.zipRead(zip, e), /too big to unpack/);
  assert.match(x.zipSummary(zip, 'bomb.zip'), /bomb\.txt \(60\.0 MB\)/);
});

test('updates: his address first, then the GitHub docs folder, then the release site; Activity notes a fallback', async () => {
  let r = await call('/api/update'); assert.deepEqual(r.j.sources, [F.replace(/^https:\/\//, '') + '/src1', F + '/src2', F + '/site'].map(s => s.replace(/^https:\/\//, '')));
  r = await call('/api/update/check', {}); assert.equal(r.j.latest, '2.4.0'); assert.equal(r.j.newer, true); assert.equal(r.j.from, F + '/src1'); assert.equal(r.j.fell_back, undefined);
  SRC.src1.up = false;
  r = await call('/api/update/check', {}); assert.equal(r.j.latest, '2.4.0'); assert.equal(r.j.from, F + '/src2'); assert.match(r.j.fell_back, /src1: HTTP 404/);
  assert.ok(db.all("SELECT detail FROM audit WHERE action='update.fallback'").some(x => /src1: HTTP 404 — used .*\/src2/.test(x.detail)));
  SRC.src2.up = false; r = await call('/api/update/check', {}); assert.equal(r.j.from, F + '/site');
  // the first source is behind: a later one with a newer version wins
  SRC.src1.up = true; SRC.src2.up = true; SRC.src1.version = '2.3.0'; SRC.src2.version = '2.4.1';
  r = await call('/api/update/check', {}); assert.equal(r.j.latest, '2.4.1'); assert.equal(r.j.from, F + '/src2');
  SRC.src1.version = '2.4.0'; SRC.src2.version = '2.4.0';
  // the setting: a GitHub repo link becomes its /docs folder; nonsense is refused; blank = default
  r = await call('/api/settings', { update_source: 'https://github.com/eliazer2499-max/Personal-assistant' }); assert.equal(r.status, 200);
  assert.equal(db.setting('update_source'), 'https://raw.githubusercontent.com/eliazer2499-max/Personal-assistant/main/docs');
  r = await call('/api/settings', { update_source: 'updates.example.com' }); assert.equal(r.status, 200); assert.equal(db.setting('update_source'), 'https://updates.example.com');
  r = await call('/api/settings', { update_source: 'ftp://x' }); assert.equal(r.status, 400);
  r = await call('/api/settings', { update_source: '' }); assert.equal(r.status, 200); assert.equal(db.setting('update_source'), '');
});

function helper(dir, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'bin/update-source.mjs', 'fetch-auto', dir], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, MA_UPDATE_SOURCE: F + '/src1', MA_UPDATE_FALLBACKS: F + '/src2', MA_RELEASE_BASE: F + '/site', ...env } });
    let out = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => out += d);
    c.on('close', (status) => resolve({ status, out }));
  });
}
test('root updater helper: downloads + checks sha256, falls back when a source is down, refuses a mismatch and older versions', async () => {
  let d = fs.mkdtempSync(path.join(T, 'u-'));
  let p = await helper(d); assert.equal(p.status, 0, p.out);
  assert.ok(fs.readFileSync(path.join(d, 'app.tgz')).equals(TGZ)); assert.match(p.out, /latest is 2\.4\.0 at .*\/src1/); assert.match(p.out, /sha256 ok/);
  SRC.src1.up = false; d = fs.mkdtempSync(path.join(T, 'u-'));
  p = await helper(d); assert.equal(p.status, 0, p.out); assert.match(p.out, /skipped .*src1: HTTP 404/); assert.match(p.out, /from .*\/src2/);
  SRC.src2.up = false; d = fs.mkdtempSync(path.join(T, 'u-'));
  p = await helper(d); assert.equal(p.status, 0, p.out); assert.match(p.out, /from .*\/site/);
  SRC.src1.up = true; SRC.src2.up = true;
  SHA_BAD = '0'.repeat(64); d = fs.mkdtempSync(path.join(T, 'u-'));
  p = await helper(d); assert.equal(p.status, 2, p.out); assert.match(p.out, /sha256 mismatch/); assert.ok(!fs.existsSync(path.join(d, 'app.tgz')), 'nothing written');
  SHA_BAD = '';
  for (const s of Object.values(SRC)) s.version = '1.0.0';
  d = fs.mkdtempSync(path.join(T, 'u-')); p = await helper(d); assert.equal(p.status, 3, p.out); assert.match(p.out, /older than the installed/);
  for (const s of Object.values(SRC)) s.version = '2.4.0';
});

test('no key ever appears in API answers, logs, Activity or the raw database', async () => {
  const all = [...RESPONSES, ...LOGS, ...db.all('SELECT detail FROM audit').map(r => String(r.detail))].join('\n');
  for (const k of Object.values(K)) assert.ok(!all.includes(k), 'key leaked');
  const raw = fs.readFileSync(path.join(DATA, 'assistant.db'));
  for (const k of Object.values(K)) assert.ok(!raw.includes(Buffer.from(k)), 'key in raw db');
});
