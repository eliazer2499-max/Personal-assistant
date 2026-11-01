// 2.3.10: Pictures from any key whose model can make them. Test finds out (from the model list, or the model's
// name) without making a picture; image_generate uses Gemini first (as before), then the other keys set to
// "Pictures": OpenRouter style (chat + "modalities") or OpenAI style (/images/generations).
// Everything runs against fakes on 127.0.0.1 (OpenAI-compatible providers, Gemini, the WhatsApp Agent Platform,
// and the update sources). Nothing reaches a real provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000, what = 'condition') { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); } throw new Error('timed out waiting for ' + what); }
const LOGS = []; const origDbg = console.error.bind(console);
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { LOGS.push(a.map(String).join(' ')); if (process.env.SHOW_LOGS) orig(...a); }; }

// Keys that match none of the app's redaction patterns
const OR = 'zz10Or' + 'r'.repeat(32), OA = 'zz10Oa' + 'a'.repeat(32), OA2 = 'zz10Ob' + 'o'.repeat(32), BADK = 'zz10Bad' + 'b'.repeat(31), CHATK = 'zz10Chat' + 'c'.repeat(30);
const GEMK = 'AIzaV2310GEM_' + 'g'.repeat(26), GEMLIM = 'AIzaV2310LIM_' + 'l'.repeat(26);
const WAKEY = 'WAAGENTkey-' + crypto.randomBytes(12).toString('hex');
const ALLKEYS = [OR, OA, OA2, BADK, CHATK, GEMK, GEMLIM, WAKEY];
// a real, tiny 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const GPNG = Buffer.concat([PNG, Buffer.from('gemini')]);   // so we can tell which path made it
const SEEN = [], GEN = [], CHAT = [];
const AP = { feed: [], sent: [], uploads: [], seq: 100 };
function push(message) { AP.seq++; AP.feed.push({ seq: AP.seq, message: { timestamp: String(Math.floor(Date.now() / 1000)), ...message } }); }
const probeAnswer = (j, J) => {
  const last = j.messages.at(-1).content; const types = Array.isArray(last) ? last.map(p => p.type) : [];
  if (j.tools) return J({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{}' } }] } }] });
  if (types.includes('image_url')) return J({ error: { message: 'image input is not supported for this model' } }, 400);
  if (types.includes('input_audio')) return J({ error: { message: "Invalid content part type: 'input_audio'" } }, 400);
  return J({ choices: [{ message: { role: 'assistant', content: 'OK' } }] });
};
const fake = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const b = Buffer.concat(chunks).toString();
  const J = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  if (p === '/src1/version.json') return J({ version: '2.3.9', notes: 'old' });
  if (p === '/src2/version.json') return J({ version: '2.3.10', notes: 'new' });
  if (p.startsWith('/agent/v1/')) {
    if (req.headers.authorization !== 'Bearer ' + WAKEY) return J({ error: { message: 'Invalid OAuth access token.', code: 190 } }, 401);
    if (p === '/agent/v1/updates') {
      const offset = u.searchParams.has('offset') ? parseInt(u.searchParams.get('offset'), 10) : null;
      const pick = () => AP.feed.filter(x => offset === null || x.seq >= offset);
      let items = pick(); const end = Date.now() + 500;
      while (!items.length && Date.now() < end) { await sleep(20); items = pick(); }
      if (!items.length) { res.writeHead(204); return res.end(); }
      return J({ object: 'whatsapp_agent_platform', entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages: items.map(x => x.message) } }] }], next_offset: items.at(-1).seq + 1 });
    }
    if (p === '/agent/v1/statuses') return J({ success: true });
    if (p === '/agent/v1/messages') { const j = JSON.parse(b); if (j.type === 'reaction') return J({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.r' }] }); AP.sent.push(j); return J({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.out' + AP.sent.length }] }); }
    if (p === '/agent/v1/media' && req.method === 'POST') {
      const s = Buffer.concat(chunks).toString('latin1');
      AP.uploads.push({ type: /name="type"\r\n\r\n([^\r]*)/.exec(s)?.[1], filename: /filename="([^"]*)"/.exec(s)?.[1], size: chunks.reduce((n, c) => n + c.length, 0), png: s.includes('\x89PNG') });
      return J({ id: 'up-' + AP.uploads.length });
    }
    return J({ error: { message: 'mock: no route ' + p } }, 404);
  }
  if (p.startsWith('/v1beta/')) {
    const key = req.headers['x-goog-api-key']; SEEN.push({ api: 'gemini', key, url: p });
    if (key !== GEMK && key !== GEMLIM) return J({ error: { message: 'API key not valid. Please pass a valid API key.' } }, 400);
    if (p === '/v1beta/models') return J({ models: ['gemini-3.6-flash', 'gemini-3.1-flash-image'].map(n => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) });
    if (/image/.test(p)) {
      GEN.push({ shape: 'gemini', key });
      if (key === GEMLIM) return J({ error: { code: 429, message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0', status: 'RESOURCE_EXHAUSTED' } }, 429);
      return J({ candidates: [{ content: { parts: [{ text: 'Here.' }, { inlineData: { mimeType: 'image/png', data: GPNG.toString('base64') } }] } }] });
    }
    return J({ candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] });
  }
  const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
  SEEN.push({ api: 'openai', key, url: p });
  const j = b ? JSON.parse(b) : {};
  if (p.startsWith('/chat/v1/chat/completions')) {           // the fake chat model that drives the brain loop
    if (key !== CHATK) return J({ error: { message: 'Invalid API Key' } }, 401);
    CHAT.push(j);
    const last = j.messages.at(-1);
    if (last.role === 'tool') return J({ choices: [{ message: { role: 'assistant', content: 'Your picture is ready.' } }] });
    const said = JSON.stringify(j.messages.filter(m => m.role === 'user').at(-1)?.content || '');
    if (/PICTURE/.test(said) && j.tools) return J({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_pic', type: 'function', function: { name: 'image_generate', arguments: JSON.stringify({ prompt: 'a red cat on a sofa' }) } }] } }] });
    return J({ choices: [{ message: { role: 'assistant', content: 'OK' } }] });
  }
  if (p.startsWith('/or/')) {
    if (key !== OR) return J({ error: { message: 'No auth credentials found', code: 401 } }, 401);
    if (p === '/or/v1/models') return J({ data: [
      { id: 'img/gen-1', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image', 'text'] } },
      { id: 'txt/chat-1', architecture: { input_modalities: ['text'], output_modalities: ['text'] } }] });
    if (p === '/or/v1/chat/completions') {
      if (Array.isArray(j.modalities) && j.modalities.includes('image')) {
        GEN.push({ shape: 'chat', key, model: j.model, modalities: j.modalities });
        return J({ choices: [{ message: { role: 'assistant', content: 'Here is a red cat.', images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG.toString('base64') } }] } }] });
      }
      return probeAnswer(j, J);
    }
    return J({ error: { message: 'Not Found' } }, 404);
  }
  if (p.startsWith('/oa/')) {
    if (key !== OA) return J({ error: { message: 'Incorrect API key provided.', code: 'invalid_api_key' } }, 401);
    if (p === '/oa/v1/models') return J({ object: 'list', data: [{ id: 'dall-e-3' }, { id: 'gpt-4o-mini' }] });
    if (p === '/oa/v1/chat/completions') {
      if (j.model === 'dall-e-3') return J({ error: { message: 'This is not a chat model and thus not supported in the v1/chat/completions endpoint.', type: 'invalid_request_error' } }, 404);
      return probeAnswer(j, J);
    }
    if (p === '/oa/v1/images/generations') { GEN.push({ shape: 'images', key, model: j.model, response_format: j.response_format, prompt: j.prompt }); return J({ created: 1, data: [{ b64_json: PNG.toString('base64'), revised_prompt: 'A red cat' }] }); }
    return J({ error: { message: 'Not Found' } }, 404);
  }
  if (p.startsWith('/oa2/')) {     // no model list; /images/generations missing; chat+modalities works
    if (key !== OA2) return J({ error: { message: 'bad key' } }, 401);
    if (p === '/oa2/v1/chat/completions') {
      if (Array.isArray(j.modalities)) { GEN.push({ shape: 'chat', key, model: j.model }); return J({ choices: [{ message: { content: '', images: [{ image_url: { url: 'data:image/png;base64,' + PNG.toString('base64') } }] } }] }); }
      return probeAnswer(j, J);
    }
    if (p === '/oa2/v1/images/generations') { GEN.push({ shape: 'images-missing' }); return J({ error: { message: 'Unknown request URL: POST /v1/images/generations' } }, 404); }
    return J({ error: { message: 'not here' } }, 404);
  }
  if (p.startsWith('/bad/')) {     // the provider refuses the picture and repeats the key in its error
    if (key !== BADK) return J({ error: { message: 'bad key' } }, 401);
    if (p === '/bad/v1/models') return J({ data: [{ id: 'img/bad', architecture: { output_modalities: ['image', 'text'] } }] });
    if (p === '/bad/v1/chat/completions') {
      if (Array.isArray(j.modalities)) { GEN.push({ shape: 'chat', key }); return J({ error: { message: `Insufficient credits for key ${BADK}. Add credits to use image output.`, code: 402 } }, 402); }
      return probeAnswer(j, J);
    }
    return J({ error: { message: 'Not Found' } }, 404);
  }
  J({ error: { message: 'nope' } }, 404);
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const F = 'http://127.0.0.1:' + fake.address().port;

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v2310-'));
const DATA = T + '/data';
const PORT = 22100 + Math.floor(Math.random() * 80);
Object.assign(process.env, {
  MA_DATA_DIR: DATA, MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/sites', MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_GEMINI_BASE: F,
  MA_RELEASE_BASE: F + '/site', MA_UPDATE_SOURCE: F + '/src1', MA_UPDATE_FALLBACKS: F + '/src2',
  MA_WA_AGENT_BASE: F + '/agent/v1', MA_WA_AGENT_POLL_TIMEOUT: '1', MA_WA_AGENT_MIN_INTERVAL_MS: '30', MA_WA_AGENT_WINDOW_MS: '2000', MA_WA_AGENT_BACKOFF_MS: '50', MA_WA_AGENT_CONFLICT_MS: '100',
});
const { loadMasterKey } = await import('../src/crypto.js');
const db = await import('../src/db.js');
loadMasterKey(DATA); db.openDb();
db.setSetting('setup_done', '1'); db.setSetting('model', 'gemini-3.6-flash'); db.setSetting('morning_summary', '0');
db.setSetting('ai_keys_migrated_gemini', '1'); db.setSetting('ai_keys_migrated_openai', '1');
db.db.close();

const { start, resetKeyTestLimit } = await import('../src/server.js');
const auth = await import('../src/auth.js');
const aikeys = await import('../src/aikeys.js');
const pictures = await import('../src/pictures.js');
const tools = await import('../src/tools/index.js');
const chats = await import('../src/chats.js');
const waagent = await import('../src/channels/waagent.js');
const server = start();
await sleep(200);
const BASE = 'http://127.0.0.1:' + PORT;
const S = auth.newSession('127.0.0.1', 'test');
const cookie = S.cookie.split(';')[0], csrf = S.csrf;
const RAW = [];
async function call(p, body) {
  const r = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-CSRF': csrf } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); RAW.push(text); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
}
test.beforeEach(() => resetKeyTestLimit());
test.after(() => { waagent.stop(); server.close(); fake.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });
const gen = (ctx = {}) => tools.execTool('image_generate', { prompt: 'a red cat on a sofa' }, { actor: 'assistant', channel: 'web', chatId: chats.mainChatId(), jobId: null, ...ctx });
const keyId = (name) => db.get('SELECT id FROM ai_keys WHERE name=?', name).id;
const lastRoute = () => db.get("SELECT detail FROM audit WHERE action='brain.route' AND detail LIKE 'Pictures%' ORDER BY id DESC LIMIT 1")?.detail;

test('detection: the model list decides; otherwise only picture-model names count, as "probably can"', () => {
  const mods = pictures.outputModalities({ data: [{ id: 'a/img', architecture: { output_modalities: ['image', 'text'] } }, { id: 'a/txt', architecture: { output_modalities: ['text'] } }, { id: 'plain' }] });
  assert.deepEqual(mods, { 'a/img': ['image', 'text'], 'a/txt': ['text'] });
  assert.deepEqual(pictures.detectPictures('a/img', mods), { ok: true, via: 'chat', guess: false });
  assert.deepEqual(pictures.detectPictures('a/txt', mods), { ok: false, why: "This model can't make pictures" });
  assert.equal(pictures.detectPictures('flux-image-from-list-says-text', { 'flux-image-from-list-says-text': ['text'] }).ok, false, 'the list wins over the name');
  for (const n of ['dall-e-3', 'gpt-image-1', 'black-forest-labs/FLUX.1-schnell', 'sdxl-turbo', 'stable-diffusion-3.5', 'imagen-4', 'google/gemini-2.5-flash-image'])
    assert.deepEqual(pictures.detectPictures(n, {}), { ok: true, via: 'images', guess: true, why: 'Probably can — will try' }, n);
  for (const n of ['openai/gpt-oss-120b', 'llama-3.3-70b', 'google/gemma-4-31b-it:free', 'gpt-4o-mini'])
    assert.equal(pictures.detectPictures(n, {}).ok, false, n);
});

test('update check compares versions as numbers: 2.3.10 is newer than 2.3.9', async () => {
  const { cmpVer } = await import('../src/updates.js');
  assert.equal(cmpVer('2.3.10', '2.3.9'), 1); assert.equal(cmpVer('2.3.9', '2.3.10'), -1); assert.equal(cmpVer('2.3.10', '2.3.10'), 0);
  assert.equal(cmpVer('2.4.0', '2.3.10'), 1); assert.equal(cmpVer('2.3.11', '2.3.10'), 1); assert.equal(cmpVer('10.0.0', '9.9.9'), 1);
  const rs = await import('../src/release-source.js');
  const best = await rs.findLatest([F + '/src1', F + '/src2'], '2.3.9');
  assert.equal(best.version, '2.3.10', 'the source that is behind (2.3.9) is skipped for the one with 2.3.10');
  const same = await rs.findLatest([F + '/src2', F + '/src1'], '2.3.10');
  assert.equal(same.version, '2.3.10', '2.3.9 never wins over 2.3.10');
});

test('Test (unsaved key, OpenRouter style): the list says the model makes pictures → Pictures box available, not ticked, no picture made', async () => {
  GEN.length = 0; SEEN.length = 0;
  const r = await call('/api/brain/keys/test', { kind: 'openai', base_url: F + '/or/v1', model: 'img/gen-1', key: OR, name: 'OpenRouter', use_for: ['chat', 'coding'] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.ok, true, r.text);
  assert.equal(r.j.caps.pictures, true); assert.equal(r.j.caps.pictures_via, 'chat'); assert.equal(r.j.caps.pictures_guess, undefined);
  assert.deepEqual(r.j.use_support.pictures, { ok: true, why: '' });
  assert.ok(!r.j.use_for.includes('pictures'), 'not ticked by itself (those models cost money)');
  assert.match(r.j.caps_line, /pictures ✓/);
  assert.match(r.j.caps_note, /This model can make pictures: tick Pictures to use it for that \(picture models usually cost money\)\./);
  assert.doesNotMatch(r.j.caps_note, /Greyed out: Pictures/);
  assert.equal(GEN.length, 0, 'Test made no picture');
  assert.ok(!SEEN.some(s => s.url.endsWith('/images/generations')));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM ai_keys').n, 0, 'nothing saved');
});

test('Test (unsaved key): a text-only model → Pictures greyed with "This model can\'t make pictures"', async () => {
  const r = await call('/api/brain/keys/test', { kind: 'openai', base_url: F + '/or/v1', model: 'txt/chat-1', key: OR, name: 'OpenRouter' });
  assert.equal(r.j.ok, true, r.text);
  assert.equal(r.j.caps.pictures, false);
  assert.deepEqual(r.j.use_support.pictures, { ok: false, why: "This model can't make pictures" });
  assert.match(r.j.caps_note, /Greyed out: Pictures/);
});

test('saved key: untested → "Tap Test"; Test on an OpenAI picture-only model (dall-e-3) → works for pictures, "probably can — will try"', async () => {
  let r = await call('/api/brain/keys', { name: 'OpenAI pics', kind: 'openai', base_url: F + '/oa/v1', model: 'dall-e-3', key: OA, use_for: ['pictures'] });
  assert.equal(r.status, 200, r.text);
  const k = r.j.keys.find(x => x.name === 'OpenAI pics');
  assert.deepEqual(k.use_support.pictures, { ok: false, why: 'Tap Test to check if this model can make pictures' });
  assert.equal(aikeys.otherPictureKeys().length, 0, 'not used for pictures before a Test');
  GEN.length = 0;
  r = await call(`/api/brain/keys/${k.id}/test`, {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.ok, true, r.text);
  assert.equal(r.j.pictures_only, true);
  assert.match(r.j.message, /only makes pictures/);
  assert.equal(r.j.caps.pictures, true); assert.equal(r.j.caps.pictures_guess, true); assert.equal(r.j.caps.pictures_via, 'images');
  assert.equal(r.j.caps.text, false);
  assert.deepEqual(r.j.key.use_support.pictures, { ok: true, why: 'Probably can — will try' });
  assert.deepEqual(r.j.key.use_for, ['pictures'], 'his tick stays');
  assert.equal(GEN.length, 0, 'Test made no picture');
  // caps from before 2.3.10 (v1) never checked pictures on a non-Gemini key → asks for a new Test
  const row = aikeys.keyRow(k.id), c = JSON.parse(row.caps);
  assert.deepEqual(aikeys.useSupport({ ...row, caps: JSON.stringify({ ...c, v: 1, pictures: false }) }).pictures, { ok: false, why: 'Tap Test to check if this model can make pictures' });
});

test('image_generate, OpenAI style: /images/generations with b64_json, saved as a PNG in the chat, Activity line', async () => {
  GEN.length = 0;
  const before = db.get('SELECT COUNT(*) AS n FROM files').n;
  const r = await gen();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.shown_to_owner_in_chat, true); assert.equal(r.model, 'dall-e-3');
  assert.deepEqual(GEN.map(g => [g.shape, g.model, g.response_format]), [['images', 'dall-e-3', 'b64_json']]);
  const f = db.get('SELECT * FROM files WHERE id=?', r.file_id);
  assert.equal(f.mime, 'image/png'); assert.match(f.name, /^picture-\d+\.png$/);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM files').n, before + 1);
  const dl = await fetch(BASE + '/api/files/' + r.file_id, { headers: { Cookie: cookie } });
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(PNG), 'the exact PNG');
  const m = db.get('SELECT * FROM messages WHERE id=?', f.message_id);
  assert.equal(m.role, 'assistant'); assert.match(m.text, /^🎨 a red cat/); assert.match(m.meta, /"generated":"image"/);
  assert.equal(lastRoute(), "Pictures: 'OpenAI pics'");
});

test('image_generate, OpenRouter style: chat + modalities, picture read from message.images; only keys he ticked', async () => {
  // OpenRouter key saved and tested, but Pictures not ticked → not used
  let r = await call('/api/brain/keys', { name: 'OpenRouter', kind: 'openai', base_url: F + '/or/v1', model: 'img/gen-1', key: OR, use_for: ['chat'] });
  const id = r.j.keys.find(x => x.name === 'OpenRouter').id;
  r = await call(`/api/brain/keys/${id}/test`, {}); assert.equal(r.j.ok, true); assert.ok(!r.j.key.use_for.includes('pictures'));
  assert.match(r.j.caps_note, /tick Pictures to use it/);
  assert.deepEqual(aikeys.otherPictureKeys().map(k => k.name), ['OpenAI pics']);
  // he ticks Pictures on OpenRouter and turns the OpenAI key off
  r = await call(`/api/brain/keys/${id}`, { use_for: ['chat', 'pictures'] }); assert.equal(r.status, 200, r.text);
  r = await call(`/api/brain/keys/${keyId('OpenAI pics')}`, { active: false }); assert.equal(r.status, 200, r.text);
  assert.equal(r.j.keys.find(x => x.name === 'OpenRouter').use_support.pictures.ok, true, 'still tested after ticking');
  GEN.length = 0;
  const g = await gen();
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.deepEqual(GEN.map(x => [x.shape, x.model, x.modalities.join('+')]), [['chat', 'img/gen-1', 'image+text']]);
  assert.equal(g.model_note, 'Here is a red cat.');
  const dl = await fetch(BASE + '/api/files/' + g.file_id, { headers: { Cookie: cookie } });
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(PNG));
  assert.equal(lastRoute(), "Pictures: 'OpenRouter'");
});

test('the other shape is tried when the first does not exist for that model (no model list, gpt-image name)', async () => {
  let r = await call('/api/brain/keys', { name: 'Local', kind: 'openai', base_url: F + '/oa2/v1', model: 'gpt-image-x', key: OA2, use_for: ['pictures'] });
  const id = r.j.keys.find(x => x.name === 'Local').id;
  r = await call(`/api/brain/keys/${id}/test`, {}); assert.equal(r.j.ok, true, r.text);
  assert.deepEqual(r.j.key.use_support.pictures, { ok: true, why: 'Probably can — will try' });
  await call(`/api/brain/keys/${keyId('OpenRouter')}`, { active: false });
  GEN.length = 0;
  const g = await gen();
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.deepEqual(GEN.map(x => x.shape), ['images-missing', 'chat']);
  await call(`/api/brain/keys/${id}`, { active: false });
});

test('a refused picture: the provider\'s own words come back, the key never does; Gemini errors stay as before', async () => {
  let r = await call('/api/brain/keys', { name: 'Paid', kind: 'openai', base_url: F + '/bad/v1', model: 'img/bad', key: BADK, use_for: ['pictures'] });
  const id = r.j.keys.find(x => x.name === 'Paid').id;
  r = await call(`/api/brain/keys/${id}/test`, {}); assert.equal(r.j.ok, true, r.text); assert.equal(r.j.key.use_support.pictures.ok, true);
  const g = await gen();
  assert.ok(g.error, JSON.stringify(g));
  assert.match(g.error, /Picture creation failed with "Paid" \(img\/bad\): the provider said 402: Insufficient credits for key \[hidden\]\. Add credits to use image output\./);
  assert.ok(!g.error.includes(BADK));
  await call(`/api/brain/keys/${id}`, { active: false });
  r = await gen();
  assert.match(r.error, /needs a Gemini key, or another key whose model can make pictures/);
});

test('Gemini first, as before; when Gemini can\'t, the next key set to Pictures makes it', async () => {
  let r = await call('/api/brain/keys', { name: 'Gemini', kind: 'gemini', model: '', key: GEMK });
  assert.equal(r.status, 200, r.text);
  await call(`/api/brain/keys/${keyId('OpenRouter')}`, { active: true });
  GEN.length = 0;
  let g = await gen();
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.deepEqual(GEN.map(x => x.shape), ['gemini'], 'Gemini only; the other key is not called');
  let dl = await fetch(BASE + '/api/files/' + g.file_id, { headers: { Cookie: cookie } });
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(GPNG));
  assert.equal(lastRoute(), "Pictures: 'Gemini'");
  // Gemini's picture limit is used up → OpenRouter makes it
  await call(`/api/brain/keys/${keyId('Gemini')}`, { key: GEMLIM });
  GEN.length = 0;
  g = await gen();
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.deepEqual(GEN.map(x => x.shape), ['gemini', 'chat']);
  assert.match(lastRoute(), /^Pictures: 'OpenRouter' \(Gemini could not: Picture creation isn't available on your free Gemini key right now/);
  // with no other key, the Gemini message is exactly as in 2.3.9
  await call(`/api/brain/keys/${keyId('OpenRouter')}`, { active: false });
  g = await gen();
  assert.match(g.error, /^Picture creation isn't available on your free Gemini key right now \(Google said: Quota exceeded/);
  await call(`/api/brain/keys/${keyId('Gemini')}`, { active: false });
});

test('brain loop over WhatsApp: a chat model calls image_generate, the PNG is saved and sent to him as a photo', async () => {
  let r = await call('/api/brain/keys', { name: 'Chat', kind: 'openai', base_url: F + '/chat/v1', model: 'mock/chat', key: CHATK, use_for: ['chat', 'coding', 'background'] });
  assert.equal(r.status, 200, r.text);
  await call(`/api/brain/keys/${keyId('OpenRouter')}`, { active: true, use_for: ['pictures'] });   // chat goes to the "Chat" key
  r = await call('/api/wa-agent/key', { key: WAKEY }); assert.equal(r.status, 200, r.text);
  r = await call('/api/wa-agent', { enabled: true }); assert.equal(r.status, 200, r.text);
  await until(() => waagent.status().state === 'connected', 5000, 'connected');
  GEN.length = 0; CHAT.length = 0;
  const files0 = db.get('SELECT COUNT(*) AS n FROM files').n;
  push({ from: 'user:777', id: 'wamid.p1', type: 'text', text: { body: 'PICTURE of a red cat please' } });
  try { await until(() => AP.sent.some(s => s.type === 'image'), 15000, 'the picture on WhatsApp'); }
  catch (e) { if (process.env.DBG) origDbg(JSON.stringify({ sent: AP.sent, jobs: db.all('SELECT id,status,result FROM jobs ORDER BY id DESC LIMIT 2'), gen: GEN, chat: CHAT.length, logs: LOGS.slice(-15) }).slice(0, 3000)); throw e; }
  await until(() => AP.sent.some(s => s.type === 'text' && /Your picture is ready/.test(s.text.body)) || AP.sent.find(s => s.type === 'image')?.image?.caption, 5000, 'the reply');
  assert.deepEqual(GEN.map(x => [x.shape, x.model]), [['chat', 'img/gen-1']]);
  assert.ok(CHAT.some(j => j.messages.some(m => m.role === 'tool' && /"shown_to_owner_in_chat":true/.test(m.content))), 'the chat model got the tool answer');
  assert.equal(AP.uploads.length, 1); assert.equal(AP.uploads[0].type, 'image/png'); assert.ok(AP.uploads[0].png, 'a PNG went up');
  const f = db.get('SELECT * FROM files ORDER BY created DESC, rowid DESC LIMIT 1');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM files').n, files0 + 1);
  assert.equal(f.mime, 'image/png');
});

test('no key ever shows up: not in any answer, not in the logs, not in the database (except encrypted)', async () => {
  await sleep(200);
  const dump = [];
  for (const { name } of db.all("SELECT name FROM sqlite_master WHERE type='table'")) {
    if (name === 'secrets') continue;
    for (const row of db.all(`SELECT * FROM "${name}"`)) dump.push(JSON.stringify(row));
  }
  const all = [RAW.join('\n'), LOGS.join('\n'), dump.join('\n')];
  for (const k of ALLKEYS) for (const [i, txt] of all.entries()) assert.ok(!txt.includes(k), `key ${k.slice(0, 7)}… found in ${['responses', 'logs', 'database'][i]}`);
  const secrets = db.all('SELECT v FROM secrets').map(r => String(r.v)).join('\n');
  for (const k of ALLKEYS) assert.ok(!secrets.includes(k), 'secrets are stored encrypted');
});
