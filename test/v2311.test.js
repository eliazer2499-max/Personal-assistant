// 2.3.11: free pictures with the owner's own Cloudflare account (Workers AI). Settings → Brain → AI keys → Add key →
// "Cloudflare (pictures)": Account ID + API token (+ model). Test checks the token and lists the account's picture
// models without making a picture; image_generate uses Gemini first, then the keys set to Pictures in his order,
// moving on when one is out of its free amount, and says which one made it.
// Everything runs against fakes on 127.0.0.1 (Cloudflare API, Gemini, a chat model, the WhatsApp Agent Platform).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { startMockCloudflare, TOK, ACCT, OTHER_ACCT, png } from './mock-cloudflare.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000, what = 'condition') { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); } throw new Error('timed out waiting for ' + what); }
const LOGS = [];
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { LOGS.push(a.map(String).join(' ')); if (process.env.SHOW_LOGS) orig(...a); }; }

const GEMLIM = 'AIzaV2311LIM_' + 'l'.repeat(26), CHATK = 'zz11Chat' + 'c'.repeat(30);
const WAKEY = 'WAAGENTkey-' + crypto.randomBytes(12).toString('hex');
const ALLKEYS = [...Object.values(TOK), GEMLIM, CHATK, WAKEY];
const SEEN = [], CHAT = [];
const AP = { feed: [], sent: [], uploads: [], seq: 100 };
function push(message) { AP.seq++; AP.feed.push({ seq: AP.seq, message: { timestamp: String(Math.floor(Date.now() / 1000)), ...message } }); }
const fake = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const b = Buffer.concat(chunks).toString();
  const J = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const u = new URL(req.url, 'http://x'), p = u.pathname;
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
      AP.uploads.push({ type: /name="type"\r\n\r\n([^\r]*)/.exec(s)?.[1], filename: /filename="([^"]*)"/.exec(s)?.[1], png: s.includes('\x89PNG') });
      return J({ id: 'up-' + AP.uploads.length });
    }
    return J({ error: { message: 'mock: no route ' + p } }, 404);
  }
  if (p.startsWith('/v1beta/')) {          // Gemini whose picture limit is used up
    const key = req.headers['x-goog-api-key']; SEEN.push({ api: 'gemini', key, url: p });
    if (key !== GEMLIM) return J({ error: { message: 'API key not valid. Please pass a valid API key.' } }, 400);
    if (p === '/v1beta/models') return J({ models: ['gemini-3.6-flash', 'gemini-3.1-flash-image'].map(n => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) });
    if (/image/.test(p)) return J({ error: { code: 429, message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0', status: 'RESOURCE_EXHAUSTED' } }, 429);
    return J({ candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] });
  }
  const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (p.startsWith('/chat/v1/chat/completions')) {           // the fake chat model that drives the brain loop
    if (key !== CHATK) return J({ error: { message: 'Invalid API Key' } }, 401);
    const j = JSON.parse(b || '{}'); CHAT.push(j);
    const last = j.messages.at(-1);
    if (last.role === 'tool') return J({ choices: [{ message: { role: 'assistant', content: 'Your picture is ready.' } }] });
    const said = JSON.stringify(j.messages.filter(m => m.role === 'user').at(-1)?.content || '');
    if (/PICTURE/.test(said) && j.tools) return J({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_pic', type: 'function', function: { name: 'image_generate', arguments: JSON.stringify({ prompt: 'a red cat on a sofa' }) } }] } }] });
    return J({ choices: [{ message: { role: 'assistant', content: 'OK' } }] });
  }
  J({ error: { message: 'nope' } }, 404);
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const F = 'http://127.0.0.1:' + fake.address().port;
const CF = await startMockCloudflare();
const cfRuns = () => CF.SEEN.filter(x => x.path.includes('/ai/run/'));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v2311-'));
const DATA = T + '/data';
const PORT = 22200 + Math.floor(Math.random() * 80);
Object.assign(process.env, {
  MA_DATA_DIR: DATA, MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/sites', MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_GEMINI_BASE: F, MA_CLOUDFLARE_BASE: CF.url,
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
const cf = await import('../src/cloudflare.js');
const updates = await import('../src/updates.js');
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
test.after(() => { waagent.stop(); server.close(); fake.close(); CF.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });
const gen = (ctx = {}) => tools.execTool('image_generate', { prompt: 'a red cat on a sofa' }, { actor: 'assistant', channel: 'web', chatId: chats.mainChatId(), jobId: null, ...ctx });
const keyId = (name) => db.get('SELECT id FROM ai_keys WHERE name=?', name).id;
const lastRoute = () => db.get("SELECT detail FROM audit WHERE action='brain.route' AND detail LIKE 'Pictures%' ORDER BY id DESC LIMIT 1")?.detail;
const draft = (o) => call('/api/brain/keys/test', { kind: 'cloudflare', name: 'CF', account_id: ACCT, model: cf.CF_DEFAULT_MODEL, ...o });
const toTop = async (id) => { for (let i = 0; i < 10; i++) { const ks = (await call('/api/brain/keys')).j.keys; if (ks[0].id === id) return; await call(`/api/brain/keys/${id}/move`, { dir: 'up' }); } };
const download = async (id) => Buffer.from(await (await fetch(BASE + '/api/files/' + id, { headers: { Cookie: cookie } })).arrayBuffer());

test('version 2.3.11 is newer than 2.3.10 (numbers, not text)', () => {
  assert.equal(updates.cmpVer('2.3.11', '2.3.10'), 1);
  assert.equal(updates.cmpVer('2.3.10', '2.3.11'), -1);
  assert.equal(updates.cmpVer('2.3.11', '2.3.9'), 1);
  assert.ok(updates.cmpVer(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version, '2.3.11') >= 0, 'package.json is 2.3.11 or newer');
});

test('Test (unsaved Cloudflare key): token OK + Workers AI → picture models as chips; no picture made, nothing saved', async () => {
  const before = db.get('SELECT COUNT(*) AS n FROM ai_keys').n;
  CF.SEEN.length = 0;
  const r = await draft({ key: TOK.good });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.ok, true, r.text);
  assert.match(r.j.message, /^✓ Works: token OK, Workers AI allowed/);
  assert.deepEqual(r.j.models, ['@cf/black-forest-labs/flux-1-schnell', '@cf/black-forest-labs/flux-2-klein-4b', '@cf/bytedance/stable-diffusion-xl-lightning', '@cf/leonardo/phoenix-1.0']);
  assert.equal(r.j.model_listed, true);
  assert.equal(r.j.saved, false);
  assert.deepEqual(r.j.use_for, ['pictures']);
  assert.equal(r.j.use_support.pictures.ok, true);
  // 2.3.13 (changed on purpose): Chat and Background jobs can be ticked now (not checked until he ticks them); coding/media stay greyed out
  for (const u of ['coding', 'media']) { assert.equal(r.j.use_support[u].ok, false); assert.equal(r.j.use_support[u].why, 'Cloudflare keys do pictures, chat and background jobs'); }
  for (const u of ['chat', 'background']) assert.equal(r.j.use_support[u].ok, null);
  assert.deepEqual(CF.SEEN.map(x => x.path), ['/user/tokens/verify', `/accounts/${ACCT}/ai/models/search`]);
  assert.match(CF.SEEN[1].query, /task=Text-to-Image/);
  assert.equal(cfRuns().length, 0, 'Test never makes a picture');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM ai_keys').n, before);
});

test('Test: clear words for a bad token, a token without "Workers AI", another account\'s ID, a typo in the ID, a non-picture model', async () => {
  let r = await draft({ key: TOK.bad });
  assert.equal(r.j.ok, false); assert.match(r.j.message, /this API token is not valid/);
  r = await draft({ key: TOK.noperm });
  assert.equal(r.j.ok, false); assert.match(r.j.message, /doesn't have the "Workers AI" permission/); assert.match(r.j.message, /Workers AI Read and Workers AI Edit/);
  r = await draft({ key: TOK.good, account_id: OTHER_ACCT });
  assert.equal(r.j.ok, false); assert.match(r.j.message, /not the account this token belongs to/);
  r = await draft({ key: TOK.other });
  assert.equal(r.j.ok, false); assert.match(r.j.message, /not the account this token belongs to/);
  r = await draft({ key: TOK.good, account_id: '1234-not-an-id' });
  assert.equal(r.j.ok, false); assert.match(r.j.message, /Account ID doesn't look right/);
  r = await draft({ key: TOK.good, model: '@cf/meta/llama-3.1-8b-instruct' });
  assert.equal(r.j.ok, false); assert.match(r.j.message, /is not one of Cloudflare's picture models/); assert.equal(r.j.models.length, 4, 'chips still shown');
  r = await draft({ key: '' });
  assert.equal(r.j.ok, false); assert.match(r.j.message, /Paste the API token first/);
  r = await draft({ key: TOK.acct });          // account-owned token: checked at the account's own verify address
  assert.equal(r.j.ok, true, r.text);
  r = await draft({ key: TOK.echo });          // Cloudflare repeats the token in its error: never comes back
  assert.equal(r.j.ok, false); assert.ok(!r.text.includes(TOK.echo));
  assert.equal(cfRuns().length, 0);
});

test('Add key: Cloudflare (pictures) is saved with its Account ID, used for Pictures only, token write-only', async () => {
  let r = await call('/api/brain/keys', { name: 'Cloudflare', kind: 'cloudflare', account_id: ACCT, model: '', key: TOK.good });
  assert.equal(r.status, 200, r.text);
  const k = r.j.key;
  assert.equal(k.kind, 'cloudflare'); assert.equal(k.kind_label, 'Cloudflare (pictures)');
  assert.equal(k.account_id, ACCT); assert.equal(k.base_url, '');
  assert.equal(k.model, cf.CF_DEFAULT_MODEL); assert.equal(k.effective_model, cf.CF_DEFAULT_MODEL);
  assert.deepEqual(k.use_for, ['pictures']); assert.equal(k.has_key, true);
  assert.equal(k.use_support.chat.ok, null); assert.equal(k.use_support.coding.ok, false); assert.equal(k.use_support.pictures.ok, null);      // 2.3.13: chat can be ticked
  assert.ok(!r.text.includes(TOK.good));
  // 2.3.13 (changed on purpose): he can tick Chat on it, but not Coding; back to Pictures only for the rest of this test
  r = await call(`/api/brain/keys/${k.id}`, { use_for: ['chat', 'coding', 'pictures'] });
  assert.deepEqual(r.j.key.use_for, ['chat', 'pictures']);
  r = await call(`/api/brain/keys/${k.id}`, { use_for: ['pictures'] });
  assert.deepEqual(r.j.key.use_for, ['pictures']);
  // bad input is refused in plain words
  r = await call('/api/brain/keys', { name: 'x', kind: 'cloudflare', account_id: 'nope', key: TOK.good });
  assert.equal(r.status, 400); assert.match(r.j.error, /Account ID doesn't look right/);
  r = await call('/api/brain/keys', { name: 'x', kind: 'cloudflare', account_id: ACCT });
  assert.equal(r.status, 400); assert.match(r.j.error, /Paste the API token/);
  // never used to chat
  assert.ok(!aikeys.usableKeys().some(x => x.kind === 'cloudflare'));
  assert.ok(!aikeys.usableKeys({ use: 'chat' }).some(x => x.kind === 'cloudflare'));
  assert.ok(aikeys.usableKeys({ use: 'pictures' }).some(x => x.kind === 'cloudflare'));
  // saved-key Test: ticks Pictures, greys the rest, one Activity line, no picture
  r = await call(`/api/brain/keys/${k.id}/test`, {});
  assert.equal(r.j.ok, true, r.text);
  assert.equal(r.j.key.use_support.pictures.ok, true);
  assert.equal(r.j.caps.pictures, true); assert.equal(r.j.caps.text, false);
  assert.match(r.j.caps_note, /Greyed out: Coding, Voice, photos & files\./);      // 2.3.13: Chat and Background jobs are not greyed out any more
  assert.match(db.get("SELECT detail FROM audit WHERE action='brain.key_tested' ORDER BY id DESC LIMIT 1").detail, /^Tested 'Cloudflare': .*pictures ✓/);
  assert.equal(cfRuns().length, 0);
  // a failing saved-key Test (token without Workers AI) marks the key with a plain problem
  const bad = (await call('/api/brain/keys', { name: 'CF no perm', kind: 'cloudflare', account_id: ACCT, key: TOK.noperm })).j.key;
  r = await call(`/api/brain/keys/${bad.id}/test`, {});
  assert.equal(r.j.ok, false); assert.match(r.j.key.problem || '', /Workers AI/);
  await call(`/api/brain/keys/${bad.id}/delete`, {});
});

test('image_generate: Gemini\'s picture limit is used up → Cloudflare makes it (JSON base64 shape), saved + shown, says which key', async () => {
  let r = await call('/api/brain/keys', { name: 'Gemini', kind: 'gemini', model: '', key: GEMLIM });
  assert.equal(r.status, 200, r.text);
  CF.SEEN.length = 0;
  const files0 = db.get('SELECT COUNT(*) AS n FROM files').n;
  const g = await gen();
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.equal(g.shown_to_owner_in_chat, true);
  assert.match(g.made_with, /^Cloudflare \(Cloudflare, @cf\/black-forest-labs\/flux-1-schnell\)$/);
  assert.match(g.note, /Made with his Cloudflare key "Cloudflare" because Gemini could not make it/);
  const run = cfRuns(); assert.equal(run.length, 1);
  assert.equal(run[0].path, `/accounts/${ACCT}/ai/run/@cf/black-forest-labs/flux-1-schnell`);
  assert.equal(run[0].token, TOK.good); assert.equal(JSON.parse(run[0].body).prompt, 'a red cat on a sofa');
  const buf = await download(g.file_id);
  assert.ok(buf.equals(png(16, 16, [200, 60, 40])), 'the exact PNG Cloudflare sent');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM files').n, files0 + 1);
  const f = db.get('SELECT * FROM files WHERE id=?', g.file_id); assert.equal(f.mime, 'image/png');
  const m = db.get('SELECT * FROM messages WHERE id=?', f.message_id); assert.match(m.text, /^🎨 a red cat on a sofa/);
  assert.match(lastRoute(), /^Pictures: 'Cloudflare' \(Gemini could not: Picture creation isn't available on your free Gemini key right now/);
});

test('raw-bytes models (stable diffusion) and multipart models (flux-2) work too', async () => {
  await call(`/api/brain/keys/${keyId('Cloudflare')}`, { model: '@cf/bytedance/stable-diffusion-xl-lightning' });
  let g = await gen();
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.ok((await download(g.file_id)).equals(png(16, 16, [40, 60, 200])));
  await call(`/api/brain/keys/${keyId('Cloudflare')}`, { model: '@cf/black-forest-labs/flux-2-klein-4b' });
  CF.SEEN.length = 0;
  g = await gen();
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.ok(cfRuns()[0].ctype.startsWith('multipart/form-data'));
  assert.ok((await download(g.file_id)).equals(png(16, 16, [40, 160, 60])));
  await call(`/api/brain/keys/${keyId('Cloudflare')}`, { model: cf.CF_DEFAULT_MODEL });
});

test('out of today\'s free amount → the next key set to Pictures makes it; the empty one rests until 00:00 UTC', async () => {
  let r = await call('/api/brain/keys', { name: 'CF empty', kind: 'cloudflare', account_id: ACCT, key: TOK.quota });
  const emptyId = r.j.key.id;
  await toTop(emptyId);            // above "Cloudflare" (Gemini is still tried first)
  const order = (await call('/api/brain/keys')).j.keys.map(k => k.name);
  assert.ok(order.indexOf('CF empty') < order.indexOf('Cloudflare'), order.join(','));
  CF.SEEN.length = 0;
  let g = await gen();
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.deepEqual(cfRuns().map(x => x.token), [TOK.quota, TOK.good]);
  assert.match(g.made_with, /^Cloudflare \(/);
  const row = aikeys.keyRow(emptyId);
  assert.match(row.last_error, /free pictures for today are used up/);
  const d = new Date(); assert.equal(row.cool_until, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  assert.match(lastRoute(), /before it: "CF empty" \(Cloudflare\): Cloudflare's free pictures for today are used up/);
  // resting keys go last: next time the good key is tried first
  CF.SEEN.length = 0;
  g = await gen(); assert.equal(g.ok, true);
  assert.deepEqual(cfRuns().map(x => x.token), [TOK.good]);
  // nothing left → his message names each key and Cloudflare's own words, never a token
  await call(`/api/brain/keys/${keyId('Cloudflare')}`, { active: false });
  g = await gen();
  assert.match(g.error, /Picture creation isn't available on your free Gemini key right now/);
  assert.match(g.error, /"CF empty" \(Cloudflare\): Cloudflare's free pictures for today are used up .*10,000 neurons/);
  assert.ok(!JSON.stringify(g).includes(TOK.quota));
  await call(`/api/brain/keys/${emptyId}/delete`, {});
  await call(`/api/brain/keys/${keyId('Cloudflare')}`, { active: true });
});

test('a refused token at picture time: the key is marked with a plain problem, the next key is tried', async () => {
  const r = await call('/api/brain/keys', { name: 'CF echo', kind: 'cloudflare', account_id: ACCT, key: TOK.echo });
  const id = r.j.key.id;
  await toTop(id);
  CF.SEEN.length = 0;
  const g = await gen();
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.deepEqual(cfRuns().map(x => x.token), [TOK.echo, TOK.good]);
  const row = aikeys.keyRow(id);
  assert.match(row.problem, /Cloudflare refused this key/); assert.ok(!row.last_error.includes(TOK.echo));
  await call(`/api/brain/keys/${id}/delete`, {});
});

test('brain loop over WhatsApp: a chat model calls image_generate, Cloudflare makes it, the PNG is saved and sent to him', async () => {
  let r = await call('/api/brain/keys', { name: 'Chat', kind: 'openai', base_url: F + '/chat/v1', model: 'mock/chat', key: CHATK, use_for: ['chat', 'coding', 'background'] });
  assert.equal(r.status, 200, r.text);
  await call(`/api/brain/keys/${keyId('Gemini')}`, { use_for: ['pictures'] });       // chat goes to the "Chat" key
  r = await call('/api/wa-agent/key', { key: WAKEY }); assert.equal(r.status, 200, r.text);
  r = await call('/api/wa-agent', { enabled: true }); assert.equal(r.status, 200, r.text);
  await until(() => waagent.status().state === 'connected', 5000, 'connected');
  CF.SEEN.length = 0; CHAT.length = 0;
  const files0 = db.get('SELECT COUNT(*) AS n FROM files').n;
  push({ from: 'user:777', id: 'wamid.p1', type: 'text', text: { body: 'PICTURE of a red cat please' } });
  await until(() => AP.sent.some(s => s.type === 'image'), 15000, 'the picture on WhatsApp');
  assert.equal(cfRuns().length, 1);
  assert.ok(CHAT.some(j => j.messages.some(m => m.role === 'tool' && /"made_with":"Cloudflare/.test(m.content))), 'the chat model learns which key made it');
  assert.equal(AP.uploads.length, 1); assert.equal(AP.uploads[0].type, 'image/png'); assert.ok(AP.uploads[0].png);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM files').n, files0 + 1);
  assert.ok(!SEEN.some(x => x.api === 'cloudflare'));
});

test('no key or token ever shows up: not in any answer, not in the logs, not in the database (except encrypted)', async () => {
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
  const raw = fs.readFileSync(DATA + '/' + fs.readdirSync(DATA).find(f => /\.(db|sqlite)$/.test(f)));
  for (const k of Object.values(TOK)) assert.ok(!raw.includes(Buffer.from(k)), 'not in the database file either');
});
