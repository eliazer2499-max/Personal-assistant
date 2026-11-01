// 2.3.2: Test checks what each model can do (photos, voice, PDF, pictures, tools), ticks what it can do,
// greys out the rest, and routing sends voice/photos/PDFs only to keys that can take them.
// Everything runs against fake Gemini and fake OpenAI-compatible servers on 127.0.0.1.
// Nothing here reaches Google, Groq, WhatsApp or a real server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const origLog = console.log; console.log = () => {};

// Gemini keys
const G = { MAIN: 'AIzaMAINKEY_' + 'm'.repeat(27), NOAUDIO: 'AIzaNOAUDIO_' + 'n'.repeat(27), LIMIT: 'AIzaLIMITED_' + 'l'.repeat(27), NOPIC: 'AIzaNOPICTS_' + 'q'.repeat(27) };
// OpenAI-compatible keys
const O = { GROQ: 'gsk_GROQKEY' + 'g'.repeat(30), VISION: 'sk-VISION' + 'v'.repeat(30), SILENT: 'sk-SILENT' + 's'.repeat(30), NEWTOK: 'sk-NEWTOK' + 't'.repeat(30), TOOL429: 'sk-TOOL429' + 'x'.repeat(29) };
// What each fake model accepts. limit: probes answered with 429. day429: every call answered "daily limit".
const CFG = {
  [G.MAIN]: { images: 1, audio: 1, pdf: 1, tools: 1, pictures: 1 },
  [G.NOAUDIO]: { images: 1, audio: 0, pdf: 1, tools: 1, pictures: 1 },
  [G.LIMIT]: { images: 1, audio: 1, pdf: 1, tools: 1, pictures: 1, limit: [] },
  [G.NOPIC]: { images: 1, audio: 1, pdf: 0, tools: 1, pictures: 0 },
  [O.GROQ]: { images: 0, audio: 0, tools: 1 },
  [O.VISION]: { images: 1, audio: 0, tools: 1 },
  [O.SILENT]: { images: 'silent', audio: 0, tools: 0 },
  [O.NEWTOK]: { images: 1, audio: 1, tools: 1, newTokens: 1 },
  [O.TOOL429]: { images: 0, audio: 0, tools: 1, limit: ['tools'] },
};
const CALLS = [];   // chat (non-probe) calls: { api, key, media }
const PROBES = [];  // probe calls: { api, key, cap }
const fake = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const J = (o, s = 200, hd = {}) => { res.writeHead(s, { 'Content-Type': 'application/json', ...hd }); res.end(JSON.stringify(o)); };
  const g429 = (day) => J({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [{ violations: [{ quotaId: day ? 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' : 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { retryDelay: '20s' }] } }, 429);
  if (req.url.startsWith('/v1beta/models?')) {
    const c = CFG[req.headers['x-goog-api-key']]; if (!c) return J({ error: { message: 'API key not valid', status: 'INVALID_ARGUMENT' } }, 400);
    const names = ['gemini-3.6-flash', 'gemini-3.6-flash-lite', ...(c.pictures ? ['gemini-3.1-flash-image'] : []), 'text-embedding-005'];
    return J({ models: names.map(n => ({ name: 'models/' + n, supportedGenerationMethods: n.includes('embedding') ? ['embedContent'] : ['generateContent'] })) });
  }
  const gm = /\/v1beta\/models\/([^:]+):generateContent/.exec(req.url);
  if (gm) {
    const key = req.headers['x-goog-api-key']; const c = CFG[key]; const j = JSON.parse(b);
    if (!c) return J({ error: { message: 'API key not valid', status: 'INVALID_ARGUMENT' } }, 400);
    const parts = j.contents.flatMap(x => x.parts);
    const mimes = parts.filter(p => p.inlineData).map(p => p.inlineData.mimeType);
    if (c.day429) return g429(true);
    if (j.systemInstruction) { CALLS.push({ api: 'gemini', key, media: mimes, text: parts.filter(p => p.text).map(p => p.text).join('\n') }); return J({ candidates: [{ content: { role: 'model', parts: [{ text: 'answer from ' + key.slice(4, 11) }] }, finishReason: 'STOP' }] }); }
    const cap = j.tools ? 'tools' : mimes.some(m => m.startsWith('image/')) ? 'images' : mimes.some(m => m.startsWith('audio/')) ? 'audio' : mimes.includes('application/pdf') ? 'pdf' : 'text';
    PROBES.push({ api: 'gemini', key, cap, maxOut: j.generationConfig?.maxOutputTokens });
    if ((c.limit || []).includes(cap)) return g429(false);
    if (cap !== 'text' && !c[cap]) return J({ error: { code: 400, status: 'INVALID_ARGUMENT', message: cap === 'audio' ? 'Audio input modality is not enabled for this model' : 'Unsupported MIME type: ' + mimes[0] } }, 400);
    if (cap === 'tools') return J({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'ping', args: {} } }] }, finishReason: 'STOP' }] });
    return J({ candidates: [{ content: { role: 'model', parts: [{ text: { images: 'Red', audio: 'YES', pdf: 'HELLO', text: 'OK' }[cap] }] }, finishReason: 'STOP' }] });
  }
  if (req.url.startsWith('/v1/')) {
    const key = String(req.headers.authorization || '').replace(/^Bearer /, ''); const c = CFG[key];
    if (!c) return J({ error: { message: 'Invalid API Key', code: 'invalid_api_key' } }, 401);
    if (req.url === '/v1/models') return J({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'vision-1' }, { id: 'whisper-large-v3' }] });
    if (req.url === '/v1/chat/completions') {
      const j = JSON.parse(b);
      const last = j.messages.at(-1).content;
      const types = Array.isArray(last) ? last.map(p => p.type) : [];
      if (j.messages[0].role === 'system') {
        const media = j.messages.flatMap(m => Array.isArray(m.content) ? m.content.map(p => p.type).filter(t => t !== 'text') : []);
        CALLS.push({ api: 'openai', key, media, text: JSON.stringify(j.messages.filter(m => m.role === 'user').map(m => m.content)) });
        return J({ choices: [{ message: { role: 'assistant', content: 'answer from ' + key.slice(0, 9) } }] });
      }
      const cap = j.tools ? 'tools' : types.includes('image_url') ? 'images' : types.includes('input_audio') ? 'audio' : 'text';
      PROBES.push({ api: 'openai', key, cap, max_tokens: j.max_tokens, max_completion_tokens: j.max_completion_tokens });
      if (c.newTokens && j.max_tokens !== undefined) return J({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: 'invalid_request_error' } }, 400);
      if ((c.limit || []).includes(cap)) return J({ error: { message: 'Rate limit reached. Please try again in 20s.', code: 'rate_limit_exceeded' } }, 429, { 'retry-after': '20' });
      if (cap === 'images' && c.images === 'silent') return J({ choices: [{ message: { role: 'assistant', content: "I don't see any image attached." } }] });
      if (cap !== 'text' && !c[cap]) return J({ error: { message: cap === 'images' ? 'image input is not supported for this model' : cap === 'audio' ? "Invalid content part type: 'input_audio'" : 'tools are not supported for this model', type: 'invalid_request_error' } }, 400);
      if (cap === 'tools') return J({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{}' } }] } }] });
      return J({ choices: [{ message: { role: 'assistant', content: { images: 'Red', audio: 'YES', text: 'OK' }[cap] } }] });
    }
  }
  J({ error: { message: 'nope' } }, 404);
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const F = 'http://127.0.0.1:' + fake.address().port;

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v232-'));
const DATA = T + '/data';
const PORT = 20600 + Math.floor(Math.random() * 150);
Object.assign(process.env, {
  MA_DATA_DIR: DATA, MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/sites', MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_GEMINI_BASE: F,
  MA_RELEASE_BASE: F + '/site', MA_UPDATE_SOURCE: F + '/src1', MA_UPDATE_FALLBACKS: F + '/src2',
});
// ---- a 2.3.1 database: ai_keys with "use_for" but no "caps" ----
const { loadMasterKey } = await import('../src/crypto.js');
const db = await import('../src/db.js');
loadMasterKey(DATA); db.openDb();
db.setSetting('setup_done', '1'); db.setSetting('model', 'gemini-3.6-flash'); db.setSetting('morning_summary', '0');
db.setSetting('ai_keys_migrated_gemini', '1'); db.setSetting('ai_keys_migrated_openai', '1');
db.db.exec(`CREATE TABLE ai_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, kind TEXT, base_url TEXT, model TEXT,
    active INTEGER DEFAULT 1, position INTEGER, created INTEGER, last_used INTEGER, last_ok INTEGER, last_error TEXT, last_error_at INTEGER,
    cool_until INTEGER DEFAULT 0, problem TEXT, use_for TEXT)`);
db.run("INSERT INTO ai_keys(name,kind,base_url,model,active,position,created,use_for) VALUES('Gemini (main)','gemini','','',1,1,1,'chat,pictures,media,background')");
db.run("INSERT INTO ai_keys(name,kind,base_url,model,active,position,created,use_for) VALUES('Groq','openai',?,'openai/gpt-oss-120b',1,2,1,'chat,coding,media')", F + '/v1');
db.setSecret('ai_key_1', G.MAIN); db.setSecret('ai_key_2', O.GROQ); db.setSetting('ai_key_main_id', '1');
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
async function call(p, body) {
  const r = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-CSRF': csrf } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
}
async function waitJob(id) { for (let i = 0; i < 600; i++) { const j = db.get('SELECT * FROM jobs WHERE id=?', id); if (['done', 'error'].includes(j.status)) return j; await sleep(25); } throw new Error('job did not finish'); }
async function upload(buf, type, name) {
  const r = await fetch(BASE + '/api/files', { method: 'POST', body: buf, headers: { Cookie: cookie, 'X-CSRF': csrf, 'Content-Type': type, 'X-File-Name': encodeURIComponent(name) } });
  const j = await r.json(); return j?.file?.id || j?.id;
}
async function ask(text, files) {
  const chat = (await import('../src/chats.js')).createChat('t ' + Date.now() + Math.random()).id;
  const r = await call('/api/chat', { text, files, chat_id: chat }); assert.equal(r.status, 200, r.text); return waitJob(r.j.job);
}
const keys = async () => (await call('/api/brain/keys')).j.keys;
const byName = async (n) => (await keys()).find(k => k.name === n);
const testKey = async (n) => { const k = await byName(n); return (await call(`/api/brain/keys/${k.id}/test`, {})).j; };
const add = async (b) => { const r = await call('/api/brain/keys', b); assert.equal(r.status, 200, r.text); return r.j.key; };
const lastTested = () => db.all("SELECT detail FROM audit WHERE action='brain.key_tested' ORDER BY id DESC LIMIT 1")[0]?.detail || '';
const reset = () => { CALLS.length = 0; PROBES.length = 0; db.run('UPDATE ai_keys SET cool_until=0, problem=NULL'); };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR42mO8IyLCgA0wMeAAg1MCANDoARQXWCREAAAAAElFTkSuQmCC', 'base64');
function wav() { const n = 800, b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); return b; }

test.after(() => { console.log = origLog; server.close(); fake.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });

test('migration from 2.3.1: "caps" column added, keys untested, ticks unchanged, nothing greyed out except Pictures on non-Gemini', async () => {
  const ks = await keys();
  assert.ok(db.all('PRAGMA table_info(ai_keys)').some(c => c.name === 'caps'));
  assert.deepEqual(ks.map(k => [k.name, k.use_for]), [['Gemini (main)', ['chat', 'pictures', 'media', 'background']], ['Groq', ['chat', 'coding', 'media']]]);
  for (const k of ks) { assert.equal(k.caps, null); assert.equal(k.caps_fresh, false); }
  assert.deepEqual(Object.values(ks[0].use_support).map(s => s.ok), [null, null, null, null, null]);
  assert.equal(ks[1].use_support.pictures.ok, false); assert.equal(ks[1].use_support.media.ok, null);
  // an untested key routes exactly like 2.3.1: a photo still goes to the first key tagged for it, even Groq
  aikeys.ensureKeys(); assert.equal((await keys())[1].caps, null, 'migration runs once, caps stay empty');
  const st = await tools.execTool('assistant_status', {}, { actor: 'assistant' });
  assert.ok(JSON.stringify(st).includes('not tested yet (tap Test)'));
  // saving ticks on an untested key keeps them (no auto-change without a Test)
  const r = await call(`/api/brain/keys/${ks[1].id}`, { use_for: ['chat', 'coding', 'media'] });
  assert.deepEqual(r.j.key.use_for, ['chat', 'coding', 'media']);
});

test('Test on a full Gemini key: everything ✓, every "Use for" ticked, one Activity line', async () => {
  reset();
  const x = await testKey('Gemini (main)');
  assert.equal(x.ok, true); assert.equal(x.message, '✓ Works (gemini-3.6-flash)');
  assert.deepEqual(aikeys.CAPS.map(c => x.caps[c]), [true, true, true, true, true, true]);
  assert.equal(x.caps.model, 'gemini-3.6-flash'); assert.ok(x.caps.checked_at);
  assert.deepEqual(x.key.use_for, ['chat', 'coding', 'pictures', 'media', 'background']);
  assert.equal(x.key.caps_fresh, true);
  assert.deepEqual(x.uses_added, ['coding']);
  // cheap: one text call + 4 probes (photo, voice, PDF, tools), each with a small answer limit; no picture is made
  assert.deepEqual(PROBES.map(p => p.cap).sort(), ['audio', 'images', 'pdf', 'text', 'tools']);
  assert.ok(PROBES.filter(p => p.cap !== 'text').every(p => p.maxOut && p.maxOut <= 64));
  assert.equal(lastTested(), "Tested 'Gemini (main)': chat ✓ tools ✓ photos ✓ voice ✓ PDF ✓ pictures ✓ · ticked Coding");
  // no secret stored in caps
  const raw = db.get('SELECT caps FROM ai_keys WHERE name=?', 'Gemini (main)').caps;
  assert.ok(!raw.includes(G.MAIN.slice(0, 10)));
});

test('Test on Groq (gpt-oss): chat ✓ tools ✓ photos ✗ voice ✗; Voice/photos box unticked and greyed with the reason', async () => {
  reset();
  const x = await testKey('Groq');
  assert.equal(x.ok, true);
  assert.equal(x.caps.text, true); assert.equal(x.caps.tools, true);
  assert.equal(x.caps.images, false); assert.equal(x.caps.audio, false); assert.equal(x.caps.pdf, false); assert.equal(x.caps.pictures, false);
  assert.equal(x.caps.files_text, true);
  assert.deepEqual(x.key.use_for, ['chat', 'coding', 'background']);
  assert.deepEqual(x.uses_removed, ['media']); assert.deepEqual(x.uses_added, ['background']);
  assert.equal(x.key.use_support.media.ok, false); assert.match(x.key.use_support.media.why, /can't see photos, hear voice notes or read PDFs/);
  assert.equal(x.key.use_support.pictures.ok, false); assert.match(x.key.use_support.pictures.why, /This model can't make pictures/);   // 2.3.10 wording (was: needs a Gemini key)
  assert.match(lastTested(), /^Tested 'Groq': chat ✓ tools ✓ photos ✗ voice ✗ PDF ✗ pictures ✗/);
  assert.equal(x.caps_note, 'Ticked Background jobs. Greyed out: Pictures, Voice, photos & files.');
  // only 3 probes for OpenAI-compatible (photo, voice, tools) + the text call; PDFs/pictures are not called
  assert.deepEqual(PROBES.filter(p => p.key === O.GROQ).map(p => p.cap).sort(), ['audio', 'images', 'text', 'tools']);
  assert.ok(PROBES.filter(p => p.cap !== 'text').every(p => p.max_tokens === 32));
  // ticking a greyed-out job by hand is not kept
  const k = await byName('Groq');
  const r = await call(`/api/brain/keys/${k.id}`, { use_for: ['chat', 'media', 'pictures'] });
  assert.deepEqual(r.j.key.use_for, ['chat']);
  await call(`/api/brain/keys/${k.id}`, { use_for: ['chat', 'coding', 'background'] });
});

test('photos ✓ voice ✗: the Voice/photos box stays on and says which', async () => {
  reset();
  await add({ name: 'Vision', kind: 'openai', base_url: F + '/v1', model: 'vision-1', key: O.VISION, use_for: ['chat'] });
  const x = await testKey('Vision');
  assert.equal(x.caps.images, true); assert.equal(x.caps.audio, false); assert.equal(x.caps.tools, true);
  assert.equal(x.key.use_support.media.ok, true);
  assert.match(x.key.use_support.media.why, /^photos ✓ voice ✗ PDF ✗/);
  assert.ok(x.key.use_for.includes('media'));
  assert.match(lastTested(), /^Tested 'Vision': chat ✓ tools ✓ photos ✓ voice ✗/);
  await add({ name: 'Gemini no voice', kind: 'gemini', key: G.NOAUDIO, use_for: ['chat'] });
  const y = await testKey('Gemini no voice');
  assert.equal(y.caps.audio, false); assert.equal(y.caps.images, true); assert.equal(y.caps.pdf, true);
  assert.match(y.key.use_support.media.why, /photos ✓ voice ✗ PDF ✓/);
  assert.match(y.caps.why.audio, /refused \(400: Audio input modality/);
});

test('a provider that silently drops the photo ("I don\'t see any image") counts as ✗; no tools → Coding and Background greyed', async () => {
  reset();
  await add({ name: 'Silent', kind: 'openai', base_url: F + '/v1', model: 'openai/gpt-oss-120b', key: O.SILENT, use_for: ['chat', 'coding', 'background'] });
  const x = await testKey('Silent');
  assert.equal(x.caps.images, false); assert.equal(x.caps.tools, false);
  assert.deepEqual(x.key.use_for, ['chat']);
  assert.equal(x.key.use_support.coding.ok, false); assert.match(x.key.use_support.coding.why, /can't use tools/);
  assert.equal(x.key.use_support.background.ok, false);
});

test('a model that wants max_completion_tokens is not marked ✗ for it', async () => {
  reset();
  await add({ name: 'NewTok', kind: 'openai', base_url: F + '/v1', model: 'vision-1', key: O.NEWTOK, use_for: ['chat'] });
  const x = await testKey('NewTok');
  assert.equal(x.caps.images, true); assert.equal(x.caps.audio, true); assert.equal(x.caps.tools, true);
  assert.ok(PROBES.some(p => p.key === O.NEWTOK && p.max_completion_tokens === 32));
});

test('429 during the probe = "couldn\'t check (limit)", not ✗; old answers and ticks kept', async () => {
  reset();
  await add({ name: 'Limited', kind: 'gemini', key: G.LIMIT, use_for: ['chat', 'media'] });
  let x = await testKey('Limited');
  assert.equal(x.caps.audio, true);
  // now the voice and tools checks hit the per-minute limit
  CFG[G.LIMIT].limit = ['audio', 'tools'];
  const before = (await byName('Limited')).use_for;
  x = await testKey('Limited');
  assert.equal(x.ok, true);
  assert.equal(x.caps.audio, true, 'kept from the last Test'); assert.equal(x.caps.tools, true);
  assert.equal(x.caps.unchecked.audio, 'limit'); assert.equal(x.caps.unchecked.tools, 'limit');
  assert.deepEqual(x.key.use_for, before);
  assert.match(x.caps_note, /Couldn't check voice, tools \(limit reached\)/);
  assert.match(lastTested(), /couldn't check voice, tools: limit/);
  assert.equal((await byName('Limited')).resting_until, null, 'a probe limit does not rest the key');
  CFG[G.LIMIT].limit = [];
  // a key never tested before: limit on tools → tools unknown, so Coding/Background ticks are left alone
  await add({ name: 'Tool429', kind: 'openai', base_url: F + '/v1', model: 'openai/gpt-oss-120b', key: O.TOOL429, use_for: ['chat', 'coding'] });
  x = await testKey('Tool429');
  assert.equal(x.caps.tools, null); assert.equal(x.caps.images, false);
  assert.deepEqual(x.key.use_for, ['chat', 'coding']);
  assert.equal(x.key.use_support.coding.ok, null); assert.equal(x.key.use_support.background.ok, null);
  assert.match(lastTested(), /tools \? .*couldn't check tools: limit/);
});

test('Pictures: Gemini key whose model list has no picture model gets Pictures greyed; picture keys skip it', async () => {
  reset();
  await add({ name: 'NoPic', kind: 'gemini', key: G.NOPIC, use_for: ['chat', 'pictures'] });
  const x = await testKey('NoPic');
  assert.equal(x.caps.pictures, false); assert.equal(x.caps.pdf, false);
  assert.ok(!x.key.use_for.includes('pictures'));
  assert.equal(x.key.use_support.pictures.ok, false); assert.match(x.key.use_support.pictures.why, /picture model/);
  // even if it was moved first, the picture maker tries it last
  const k = await byName('NoPic'); for (let i = 0; i < 10; i++) await call(`/api/brain/keys/${k.id}/move`, { dir: 'up' });
  assert.notEqual(aikeys.geminiKeys()[0].name, 'NoPic');
  assert.equal(aikeys.geminiKeys().at(-1).name, 'NoPic');
  await call(`/api/brain/keys/${k.id}`, { active: false });
});

test('routing: voice notes only to keys that can hear, photos only to keys that can see; then back to 2.3.1 fallback', async () => {
  // order: Gemini no voice, Groq, Vision, Gemini (main), … — switch off the extra keys
  for (const n of ['Silent', 'NewTok', 'Limited', 'Tool429']) { const k = await byName(n); await call(`/api/brain/keys/${k.id}`, { active: false }); }
  const order = async (names) => { for (const n of [...names].reverse()) { const k = await byName(n); for (let i = 0; i < 12; i++) await call(`/api/brain/keys/${k.id}/move`, { dir: 'up' }); } };
  await order(['Gemini no voice', 'Groq', 'Vision', 'Gemini (main)']);
  for (const n of ['Gemini no voice', 'Groq', 'Vision', 'Gemini (main)']) { const k = await byName(n); await call(`/api/brain/keys/${k.id}`, { use_for: ['chat', 'coding', 'media', 'background'] }); }
  assert.deepEqual((await byName('Groq')).use_for, ['chat', 'coding', 'background'], 'Groq cannot keep Voice/photos');
  // voice note: "Gemini no voice" is first in line but can't hear → Gemini (main)
  reset();
  const vid = await upload(wav(), 'audio/wav', 'note.wav');
  let job = await ask('what did I say?', [vid]);
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(CALLS[0].key, G.MAIN); assert.deepEqual(CALLS[0].media, ['audio/wav']);
  // photo: Gemini no voice can see → it takes it
  reset();
  const pid = await upload(PNG, 'image/png', 'red.png');
  job = await ask('what colour?', [pid]);
  assert.equal(CALLS[0].key, G.NOAUDIO); assert.deepEqual(CALLS[0].media, ['image/png']);
  // photo with Gemini no voice switched off: Groq (can't see) is skipped → Vision (OpenAI-compatible, can see)
  const gnv = await byName('Gemini no voice'); await call(`/api/brain/keys/${gnv.id}`, { active: false });
  reset();
  job = await ask('what colour now?', [await upload(PNG, 'image/png', 'red2.png')]);
  assert.equal(CALLS[0].key, O.VISION); assert.deepEqual(CALLS[0].media, ['image_url']);
  // plain chat is not affected: first in line (Groq) answers
  reset();
  job = await ask('hello there');
  assert.equal(CALLS[0].key, O.GROQ);
  // usableKeys puts the keys that can't take it last and says what they can't take
  const u = aikeys.usableKeys({ use: 'media', withMedia: true, mediaKinds: ['audio'] });
  assert.deepEqual(u.slice(-2).map(x => x.name).sort(), ['Groq', 'Vision']); assert.ok(u.slice(-2).every(x => x.cannot.join() === 'audio'));
  assert.equal(u[0].name, 'Gemini (main)'); assert.deepEqual(u[0].cannot, []);
  // every key that can hear is out for the day → a key that can't hear still answers, with a note instead of the audio
  CFG[G.MAIN].day429 = 1;
  reset();
  job = await ask('and this one?', [await upload(wav(), 'audio/wav', 'note2.wav')]);
  assert.equal(job.status, 'done', job.error || '');
  const c = CALLS.find(x => x.api === 'openai');
  assert.ok(c, 'an OpenAI-compatible key answered'); assert.deepEqual(c.media, [], 'no audio sent to a key that cannot hear');
  assert.match(c.text, /cannot open that kind of file \(its Test showed it\)|cannot open it/);
  delete CFG[G.MAIN].day429;
});

test('an untested key keeps 2.3.1 routing (a photo still goes to it)', async () => {
  reset(); db.run('UPDATE ai_keys SET cool_until=0, problem=NULL');
  const groq = await byName('Groq');
  db.run('UPDATE ai_keys SET caps=NULL, use_for=? WHERE id=?', 'chat,coding,media', groq.id);   // like a key from 2.3.1
  const u = aikeys.usableKeys({ use: 'media', mediaKinds: ['image'] });
  assert.equal(u[0].name, 'Groq'); assert.deepEqual(u[0].cannot, []);
});

test('changing the model or replacing the key: old caps kept but no longer used until Test', async () => {
  reset();
  await testKey('Vision');
  const k = await byName('Vision');
  let r = await call(`/api/brain/keys/${k.id}`, { model: 'openai/gpt-oss-120b' });
  assert.equal(r.j.key.caps.model, 'vision-1', 'old caps kept'); assert.equal(r.j.key.caps_fresh, false);
  assert.equal(r.j.key.use_support.media.ok, null, 'not greyed out from old caps');
  r = await call(`/api/brain/keys/${k.id}`, { model: 'vision-1' }); assert.equal(r.j.key.caps_fresh, true);
  r = await call(`/api/brain/keys/${k.id}`, { key: O.VISION });
  assert.equal(r.j.key.caps_fresh, false); assert.equal(r.j.key.caps.stale, true);
  const x = await testKey('Vision'); assert.equal(x.key.caps_fresh, true);
});

test('a failing Test (bad key) changes no caps and no ticks', async () => {
  reset();
  const k = await byName('Gemini (main)');
  const before = db.get('SELECT caps, use_for FROM ai_keys WHERE id=?', k.id);
  db.setSecret('ai_key_' + k.id, 'AIzaWRONG_' + 'w'.repeat(29));
  const x = (await call(`/api/brain/keys/${k.id}/test`, {})).j;
  assert.equal(x.ok, false); assert.equal(x.caps, undefined);
  assert.deepEqual(db.get('SELECT caps, use_for FROM ai_keys WHERE id=?', k.id), before);
  db.setSecret('ai_key_' + k.id, G.MAIN);
});

test('OpenAI-compatible content: voice clip goes as input_audio only to a model that can hear; a refused photo becomes a note', () => {
  const it = { text: 'hi', media: [{ kind: 'image', mime: 'image/png', data: 'AAA', name: 'a.png' }, { kind: 'audio', mime: 'audio/wav', data: 'BBB', name: 'v.wav' }] };
  let c = brain.openaiUserContent(it, { images: true, audio: true });
  assert.deepEqual(c.map(p => p.type), ['text', 'image_url', 'input_audio']); assert.equal(c[2].input_audio.format, 'wav');
  c = brain.openaiUserContent(it, { images: false, audio: false });
  assert.deepEqual(c.map(p => p.type), ['text']); assert.match(c[0].text, /"a\.png" \(photo\), "v\.wav" \(voice note\)/);
  c = brain.openaiUserContent(it);   // untested = 2.3.1
  assert.deepEqual(c.map(p => p.type), ['text', 'image_url']); assert.match(c[0].text, /cannot open it.*Gemini/);
});
