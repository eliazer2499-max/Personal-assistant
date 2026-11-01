// 2.3.9: Test in the Add-key sheet — checks the typed (unsaved) type, address, model and key.
// Runs against fake Gemini and fake OpenAI-compatible servers on 127.0.0.1. Nothing reaches a real provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LOGS = [];
const origLog = console.log, origErr = console.error, origWarn = console.warn;
console.log = (...a) => LOGS.push(a.join(' ')); console.error = (...a) => LOGS.push(a.join(' ')); console.warn = (...a) => LOGS.push(a.join(' '));

// Keys that match none of the app's redaction patterns, so only the 2.3.9 wiping can hide them.
const OK = 'zz9Draft' + 'q'.repeat(30);          // works on the OpenAI-compatible fake
const ECHO = 'zz9Echo' + 'e'.repeat(31);         // refused, and the provider repeats the key in its error
const STORED = 'zz9Stored' + 's'.repeat(29);     // already saved for "Old key"
const GEM = 'AIzaDRAFTGEM_' + 'g'.repeat(26);    // works on the Gemini fake
const SEEN = [];   // { api, key, url }
const fake = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const J = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url.startsWith('/v1beta/')) {
    const key = req.headers['x-goog-api-key']; SEEN.push({ api: 'gemini', key, url: req.url });
    if (key !== GEM) return J({ error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }, 400);
    if (req.url.startsWith('/v1beta/models?')) return J({ models: ['gemini-3.6-flash', 'gemini-3.6-flash-lite', 'gemini-3.1-flash-image'].map(n => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) });
    const j = JSON.parse(b || '{}');
    if (j.tools) return J({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'ping', args: {} } }] }, finishReason: 'STOP' }] });
    const mimes = (j.contents || []).flatMap(x => x.parts).filter(p => p.inlineData).map(p => p.inlineData.mimeType);
    const t = mimes.some(m => m.startsWith('image/')) ? 'Red' : mimes.some(m => m.startsWith('audio/')) ? 'YES' : mimes.includes('application/pdf') ? 'HELLO' : 'OK';
    return J({ candidates: [{ content: { role: 'model', parts: [{ text: t }] }, finishReason: 'STOP' }] });
  }
  const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
  SEEN.push({ api: 'openai', key, url: req.url });
  if (req.url.startsWith('/nolist/v1/models')) return J({ error: { message: 'not here' } }, 404);
  if (key === ECHO) return J({ error: { message: `Incorrect API key provided: ${ECHO}. You can find your key at https://example.test/keys.`, code: 'invalid_api_key' } }, 401);
  if (key !== OK && key !== STORED) return J({ error: { message: 'Invalid API Key', code: 'invalid_api_key' } }, 401);
  if (req.url.endsWith('/models')) return J({ data: [{ id: 'google/gemma-4-31b-it:free' }, { id: 'meta/llama-4:free' }, { id: 'vision-1' }] });
  if (req.url.endsWith('/chat/completions')) {
    const j = JSON.parse(b || '{}');
    const last = j.messages.at(-1).content; const types = Array.isArray(last) ? last.map(p => p.type) : [];
    if (j.tools) return J({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{}' } }] } }] });
    if (types.includes('image_url')) return j.model === 'vision-1' ? J({ choices: [{ message: { role: 'assistant', content: 'Red' } }] }) : J({ error: { message: 'image input is not supported for this model' } }, 400);
    if (types.includes('input_audio')) return J({ error: { message: "Invalid content part type: 'input_audio'" } }, 400);
    return J({ choices: [{ message: { role: 'assistant', content: 'OK' } }] });
  }
  J({ error: { message: 'nope' } }, 404);
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const F = 'http://127.0.0.1:' + fake.address().port;

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v239-'));
const DATA = T + '/data';
const PORT = 21900 + Math.floor(Math.random() * 80);
Object.assign(process.env, {
  MA_DATA_DIR: DATA, MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/sites', MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_GEMINI_BASE: F,
  MA_RELEASE_BASE: F + '/site', MA_UPDATE_SOURCE: F + '/src1', MA_UPDATE_FALLBACKS: F + '/src2',
});
const { loadMasterKey } = await import('../src/crypto.js');
const db = await import('../src/db.js');
loadMasterKey(DATA); db.openDb();
db.setSetting('setup_done', '1'); db.setSetting('model', 'gemini-3.6-flash'); db.setSetting('morning_summary', '0');
db.setSetting('ai_keys_migrated_gemini', '1'); db.setSetting('ai_keys_migrated_openai', '1');
const aikeys = await import('../src/aikeys.js');
aikeys.ensureKeys();
const old = aikeys.addKey({ name: 'Old key', kind: 'openai', base_url: F + '/v1', model: 'vision-1', key: STORED });
db.db.close();

const { start, resetKeyTestLimit } = await import('../src/server.js');
const auth = await import('../src/auth.js');
const server = start();
await sleep(200);
const BASE = 'http://127.0.0.1:' + PORT;
const S = auth.newSession('127.0.0.1', 'test');
const cookie = S.cookie.split(';')[0], csrf = S.csrf;
const RAW = [];   // every response body, to check no key ever comes back
async function call(p, body, hd = {}) {
  const r = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-CSRF': csrf } : {}), ...hd }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); RAW.push(text); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
}
const draft = (b) => call('/api/brain/keys/test', b);
test.beforeEach(() => resetKeyTestLimit());
const snapshot = () => ({
  keys: db.all('SELECT * FROM ai_keys ORDER BY id'),
  secrets: db.all('SELECT k, v FROM secrets ORDER BY k').map(r => r.k + '=' + r.v).join(','),
  audit: db.get('SELECT COUNT(*) AS n FROM audit').n,
  settings: db.all('SELECT k, v FROM settings ORDER BY k').filter(r => !/^(update_|last_|session)/.test(r.k)),
});
let before;

test.after(() => { console.log = origLog; console.error = origErr; console.warn = origWarn; server.close(); fake.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });

test('needs his login session and the CSRF check', async () => {
  before = snapshot();
  const noLogin = await fetch(BASE + '/api/brain/keys/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'openai', base_url: F + '/v1', key: OK }) });
  assert.equal(noLogin.status, 401);
  const noCsrf = await fetch(BASE + '/api/brain/keys/test', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'openai', base_url: F + '/v1', key: OK }) });
  assert.equal(noCsrf.status, 403);
  assert.equal(SEEN.length, 0, 'nothing was sent to the provider');
});

test('new OpenAI-compatible key, no model yet: lists the models to choose from', async () => {
  const r = await draft({ kind: 'openai', base_url: F + '/v1/', model: '', key: OK, name: 'OpenRouter' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.ok, false);
  assert.match(r.j.message, /No model chosen — tap one from the list below\./);
  assert.deepEqual(r.j.models, ['google/gemma-4-31b-it:free', 'meta/llama-4:free', 'vision-1']);
  assert.equal(r.j.saved, false);
  assert.ok(SEEN.some(s => s.key === OK && s.url === '/v1/models'));
});

test('new key with a model: same answer as the saved-key Test (works, what it can do, ticks), nothing saved', async () => {
  SEEN.length = 0;
  const r = await draft({ kind: 'openai', base_url: F + '/v1', model: 'google/gemma-4-31b-it:free', key: OK, name: 'OpenRouter', use_for: ['chat', 'coding'] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.ok, true);
  assert.equal(r.j.message, '✓ Works (google/gemma-4-31b-it:free)');
  assert.equal(r.j.models.length, 3);
  assert.equal(r.j.caps.text, true); assert.equal(r.j.caps.tools, true); assert.equal(r.j.caps.images, false); assert.equal(r.j.caps.audio, false); assert.equal(r.j.caps.pictures, false);
  assert.equal(r.j.caps.model, 'google/gemma-4-31b-it:free');
  assert.match(r.j.caps_line, /chat ✓ tools ✓ photos ✗ voice ✗/);
  assert.deepEqual(r.j.use_for, ['chat', 'coding', 'background']);
  assert.deepEqual(r.j.uses_added, ['background']);
  assert.equal(r.j.use_support.pictures.ok, false);
  assert.equal(r.j.use_support.media.ok, false);
  assert.match(r.j.caps_note, /Ticked Background jobs\./);
  assert.ok(SEEN.filter(s => s.url === '/v1/chat/completions').length >= 3, 'the capability checks ran');
  assert.ok(SEEN.every(s => s.key === OK));
  assert.deepEqual(snapshot(), before, 'no key, status, caps or Activity line was stored');
});

test('new Gemini key works the same way (blank model = the default)', async () => {
  const r = await draft({ kind: 'gemini', model: '', key: GEM, name: 'Gemini 2' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.ok, true, r.text);
  assert.equal(r.j.message, '✓ Works (gemini-3.6-flash)');
  assert.ok(r.j.models.includes('gemini-3.6-flash-lite'));
  assert.equal(r.j.caps.pictures, true); assert.equal(r.j.caps.images, true);
  assert.equal(r.j.use_support.pictures.ok, true);
  const empty = await draft({ kind: 'gemini', key: '' });
  assert.equal(empty.j.ok, false); assert.match(empty.j.message, /Paste the key first/);
  assert.deepEqual(snapshot(), before);
});

test('a refused key that the provider repeats back never shows up in the answer, the log or the database', async () => {
  const r = await draft({ kind: 'openai', base_url: F + '/v1', model: 'x', key: ECHO });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.ok, false);
  assert.match(r.j.message, /^✗ /);
  assert.ok(!r.text.includes(ECHO), r.text);
  assert.ok(!r.text.includes(ECHO.slice(0, 20)));
  const bad = await draft({ kind: 'gemini', key: 'AIzaWRONG_' + 'w'.repeat(29) });
  assert.equal(bad.j.ok, false); assert.ok(!bad.text.includes('AIzaWRONG_'));
  assert.deepEqual(snapshot(), before);
});

test('editing a saved key: empty key field uses the saved key with the typed model; the saved key is not changed', async () => {
  SEEN.length = 0;
  const r = await draft({ id: old.id, kind: 'openai', base_url: F + '/v1', model: 'google/gemma-4-31b-it:free', key: '' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.ok, true, r.text);
  assert.equal(r.j.used_saved_key, true);
  assert.equal(r.j.model, 'google/gemma-4-31b-it:free');
  assert.ok(SEEN.length && SEEN.every(s => s.key === STORED), 'the saved key was used');
  assert.ok(!r.text.includes(STORED));
  // a newly typed key is tried instead of the saved one
  SEEN.length = 0;
  const r2 = await draft({ id: old.id, kind: 'openai', base_url: F + '/v1', model: 'vision-1', key: OK });
  assert.equal(r2.j.ok, true); assert.equal(r2.j.used_saved_key, false);
  assert.ok(SEEN.every(s => s.key === OK));
  assert.equal(r2.j.caps.images, true);
  // a typed key that is refused does not mark the saved key as failing
  const r3 = await draft({ id: old.id, kind: 'openai', base_url: F + '/v1', model: 'vision-1', key: 'nope' + 'n'.repeat(30) });
  assert.equal(r3.j.ok, false);
  const k = aikeys.keyRow(old.id);
  assert.equal(k.model, 'vision-1'); assert.equal(k.last_error, null); assert.equal(k.caps, null); assert.equal(aikeys.keyValue(old.id), STORED);
  assert.deepEqual(snapshot(), before);
  const gone = await draft({ id: 99999, kind: 'openai', base_url: F + '/v1', model: 'x' });
  assert.equal(gone.status, 404);
});

test('a provider without a model list still answers; bad input gets a plain message', async () => {
  const r = await draft({ kind: 'openai', base_url: F + '/nolist/v1', key: OK });
  assert.equal(r.j.ok, false); assert.match(r.j.message, /did not give a model list/);
  const nb = await draft({ kind: 'openai', base_url: '', model: 'x', key: OK });
  assert.equal(nb.status, 400); assert.match(nb.j.error, /API base URL must start with https:\/\//);
  const nk = await draft({ kind: 'claude', key: OK });
  assert.equal(nk.status, 400);
  const sp = await draft({ kind: 'openai', base_url: F + '/v1', key: 'two words' });
  assert.equal(sp.status, 400); assert.ok(!sp.text.includes('two words'));
});

test('the saved-key Test still works and still records what the model can do', async () => {
  const r = await call(`/api/brain/keys/${old.id}/test`, {});
  assert.equal(r.j.ok, true, r.text);
  assert.equal(r.j.caps.images, true);
  assert.ok(aikeys.keyRow(old.id).caps);
  before = snapshot();
});

test('rate limit: about 10 tests a minute', async () => {
  let last;
  for (let i = 0; i < 12; i++) { last = await draft({ kind: 'openai', base_url: F + '/v1', key: OK }); if (last.status === 429) break; }
  assert.equal(last.status, 429);
  assert.match(last.j.error, /Wait a minute/);
  assert.deepEqual(snapshot(), before);
});

test('no typed key anywhere: responses, log lines, data folder', async () => {
  for (const key of [OK, ECHO, GEM, STORED]) {
    assert.ok(!RAW.some(t => t.includes(key)), 'response carried a key');
    assert.ok(!LOGS.some(t => t.includes(key)), 'log carried a key');
  }
  for (const f of fs.readdirSync(DATA)) {
    const p = path.join(DATA, f); if (!fs.statSync(p).isFile()) continue;
    const buf = fs.readFileSync(p);
    for (const key of [OK, ECHO, GEM]) assert.ok(!buf.includes(key), `${f} holds a typed key`);
  }
  const a = db.all('SELECT detail FROM audit').map(r => r.detail).join('\n');
  for (const key of [OK, ECHO, GEM, STORED]) assert.ok(!a.includes(key));
});

test('the Add-key sheet has a Test button and the OpenRouter hint', async () => {
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /'data-test': k \? k\.id : 'new'/);
  assert.match(js, /api\('\/api\/brain\/keys\/test', tb\)/);
  assert.match(js, /https:\/\/openrouter\.ai\/api\/v1/);
  assert.ok(!js.includes('Save the key first, then tap Test.'));
});
