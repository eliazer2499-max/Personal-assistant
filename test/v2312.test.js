// 2.3.12: Auto for Cloudflare picture keys. The main AI asks image_generate for quality "best" / "fast" / "auto";
// the code picks the model from the account's own list (cached by Test, refreshed at most once a day), switches to
// the next model when one fails, prefers the cheapest model when the free daily amount is nearly used, and moves to
// the next key when Cloudflare says the free amount is gone. Everything runs against fakes on 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { startMockCloudflare, TOK, ACCT, png } from './mock-cloudflare.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000, what = 'condition') { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); } throw new Error('timed out waiting for ' + what); }
const LOGS = [];
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { LOGS.push(a.map(String).join(' ')); if (process.env.SHOW_LOGS) orig(...a); }; }

const CHATK = 'zz12Chat' + 'c'.repeat(30);
const WAKEY = 'WAAGENTkey-' + crypto.randomBytes(12).toString('hex');
const ALLKEYS = [...Object.values(TOK), CHATK, WAKEY];
const CHAT = [];
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
      AP.uploads.push({ type: /name="type"\r\n\r\n([^\r]*)/.exec(s)?.[1], png: s.includes('\x89PNG') });
      return J({ id: 'up-' + AP.uploads.length });
    }
    return J({ error: { message: 'mock: no route ' + p } }, 404);
  }
  const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (p.startsWith('/chat/v1/chat/completions')) {           // the fake chat model (the brain) that calls image_generate
    if (key !== CHATK) return J({ error: { message: 'Invalid API Key' } }, 401);
    const j = JSON.parse(b || '{}'); CHAT.push(j);
    const last = j.messages.at(-1);
    if (last.role === 'tool') return J({ choices: [{ message: { role: 'assistant', content: 'Your picture is ready.' } }] });
    const said = JSON.stringify(j.messages.filter(m => m.role === 'user').at(-1)?.content || '');
    const q = /POSTER/.test(said) ? 'best' : /QUICK/.test(said) ? 'fast' : null;
    if (q && j.tools) return J({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + q, type: 'function', function: { name: 'image_generate', arguments: JSON.stringify({ prompt: q === 'best' ? 'a poster that says SHABBAT SHALOM in gold letters' : 'a simple red apple', quality: q }) } }] } }] });
    return J({ choices: [{ message: { role: 'assistant', content: 'OK' } }] });
  }
  J({ error: { message: 'nope' } }, 404);
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const F = 'http://127.0.0.1:' + fake.address().port;
const ALLM = ['@cf/black-forest-labs/flux-1-schnell', '@cf/black-forest-labs/flux-2-dev', '@cf/black-forest-labs/flux-2-klein-4b', '@cf/black-forest-labs/flux-2-klein-9b',
  '@cf/leonardo/lucid-origin', '@cf/leonardo/phoenix-1.0', '@cf/bytedance/stable-diffusion-xl-lightning', '@cf/runwayml/stable-diffusion-v1-5-inpainting', '@cf/someone/brand-new-model'];
const CF = await startMockCloudflare({ models: ALLM });
const cfRuns = () => CF.SEEN.filter(x => x.path.includes('/ai/run/'));
const ranModels = () => cfRuns().map(x => x.path.split('/ai/run/')[1].split('/').pop());
const searches = () => CF.SEEN.filter(x => x.path.endsWith('/ai/models/search')).length;

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma2312-test-'));
const DATA = T + '/data';
const PORT = 22300 + Math.floor(Math.random() * 80);
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
test.beforeEach(() => { resetKeyTestLimit(); for (const k of Object.keys(CF.FAIL)) delete CF.FAIL[k]; });
test.after(() => { waagent.stop(); server.close(); fake.close(); CF.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });
const gen = (args = {}) => tools.execTool('image_generate', { prompt: 'a red cat on a sofa', ...args }, { actor: 'assistant', channel: 'web', chatId: chats.mainChatId(), jobId: null });
const keyId = (name) => db.get('SELECT id FROM ai_keys WHERE name=?', name).id;
const lastRoute = () => db.get("SELECT detail FROM audit WHERE action='brain.route' AND detail LIKE 'Pictures%' ORDER BY id DESC LIMIT 1")?.detail;
const pub = (id) => aikeys.publicKey(aikeys.keyRow(id));
const setUsed = (id, n, day = cf.utcDay()) => { cf.cfAddUsage(id, 0); db.run('UPDATE cf_usage SET neurons=?, day=? WHERE key_id=?', n, day, id); };
const toTop = async (id) => { for (let i = 0; i < 10; i++) { const ks = (await call('/api/brain/keys')).j.keys; if (ks[0].id === id) return; await call(`/api/brain/keys/${id}/move`, { dir: 'up' }); } };

test('version 2.3.12 is newer than 2.3.11 (numbers, not text)', () => {
  assert.equal(updates.cmpVer('2.3.12', '2.3.11'), 1);
  assert.equal(updates.cmpVer('2.3.11', '2.3.12'), -1);
  assert.equal(updates.cmpVer('2.3.12', '2.3.9'), 1);
  assert.ok(updates.cmpVer(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version, '2.3.12') >= 0, 'package.json is 2.3.12 or newer');
});

test('the ranking: best = strongest first, fast = flux-1-schnell first, unknown models last, photo-only models never', () => {
  let p = cf.cfPlan({ quality: 'best', available: ALLM });
  assert.deepEqual(p.order.map(cf.shortModel), ['flux-2-dev', 'flux-2-klein-9b', 'lucid-origin', 'phoenix-1.0', 'flux-2-klein-4b', 'flux-1-schnell', 'stable-diffusion-xl-lightning', 'brand-new-model']);
  assert.equal(p.why, 'best model');
  p = cf.cfPlan({ quality: 'fast', available: ALLM });
  assert.equal(cf.shortModel(p.order[0]), 'flux-1-schnell'); assert.equal(p.why, 'fast model');
  assert.equal(cf.shortModel(p.order.at(-1)), 'brand-new-model');
  p = cf.cfPlan({ quality: 'auto', available: ALLM });
  assert.equal(cf.shortModel(p.order[0]), 'flux-2-klein-4b');
  assert.ok(!p.order.some(m => /inpainting/.test(m)));
  // only what the account has
  p = cf.cfPlan({ quality: 'best', available: ['@cf/black-forest-labs/flux-1-schnell', '@cf/leonardo/phoenix-1.0'] });
  assert.deepEqual(p.order.map(cf.shortModel), ['phoenix-1.0', 'flux-1-schnell']);
  // the documented cost per picture (Neurons) for the main models
  assert.equal(cf.cfCost('@cf/black-forest-labs/flux-1-schnell'), 58);
  assert.equal(cf.cfCost('@cf/black-forest-labs/flux-2-dev'), 3750);
  assert.equal(cf.cfCost('@cf/someone/brand-new-model'), 500);
});

test('the free amount: under 15% left → cheapest first ("saving free allowance"); a model that costs more than what is left goes last', () => {
  let p = cf.cfPlan({ quality: 'best', available: ALLM, usedToday: 8600 });      // 1,400 left (< 1,500)
  assert.equal(cf.shortModel(p.order[0]), 'flux-1-schnell'); assert.equal(p.why, 'saving free allowance');
  p = cf.cfPlan({ quality: 'best', available: ALLM, usedToday: 8400 });          // 1,600 left: not low yet, but flux-2-dev (3,750) can't fit
  assert.equal(cf.shortModel(p.order[0]), 'flux-2-klein-9b'); assert.equal(p.why, 'saving free allowance');
  assert.equal(cf.shortModel(p.order.at(-1)), 'phoenix-1.0');
  p = cf.cfPlan({ quality: 'fast', available: ALLM, usedToday: 9000 });          // fast is already the cheap one
  assert.equal(cf.shortModel(p.order[0]), 'flux-1-schnell'); assert.equal(p.why, 'fast model');
});

test('Add key: Auto is accepted, shown as "Auto (best model, switches by itself)", with "Free pictures today: ~N left (estimate)"; Test caches the models', async () => {
  let r = await call('/api/brain/keys/test', { kind: 'cloudflare', name: 'CF', account_id: ACCT, model: 'auto', key: TOK.good });
  assert.equal(r.j.ok, true, r.text);
  assert.match(r.j.message, /Pictures: Auto — your assistant picks from 9 picture models \(best: flux-2-dev, fast: flux-1-schnell\)/);
  assert.equal(r.j.models.length, 9, 'the chips are still shown');
  assert.equal(cfRuns().length, 0, 'Test makes no picture');
  r = await call('/api/brain/keys', { name: 'Cloudflare', kind: 'cloudflare', account_id: ACCT, model: 'Auto', key: TOK.good });
  assert.equal(r.status, 200, r.text);
  const k = r.j.key;
  assert.equal(k.model, 'auto'); assert.equal(k.auto, true); assert.equal(k.model_label, 'Auto (best model, switches by itself)');
  assert.equal(k.free_today.text, 'Free pictures today: ~172 left (estimate) · ~2 in best quality');
  // an existing key keeps its model (no Auto unless he picks it)
  r = await call('/api/brain/keys', { name: 'CF fixed', kind: 'cloudflare', account_id: ACCT, model: '', key: TOK.good });
  assert.equal(r.j.key.model, cf.CF_DEFAULT_MODEL); assert.equal(r.j.key.auto, false);
  assert.equal(r.j.key.free_today.text, 'Free pictures today: ~172 left (estimate)');
  await call(`/api/brain/keys/${r.j.key.id}/delete`, {});
  // saved-key Test keeps the account's picture model list for Auto
  const s0 = searches();
  r = await call(`/api/brain/keys/${k.id}/test`, {});
  assert.equal(r.j.ok, true, r.text); assert.equal(r.j.key.use_support.pictures.ok, true);
  assert.equal(searches(), s0 + 1);
  assert.deepEqual(cf.cfCachedModels(k.id), [...ALLM].sort());
});

test('Auto: "best" → the strongest model, "fast" → flux-1-schnell; Activity + the result say which model and why; Neurons counted', async () => {
  const id = keyId('Cloudflare');
  CF.SEEN.length = 0;
  let g = await gen({ quality: 'best' });
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.deepEqual(ranModels(), ['flux-2-dev']);
  assert.equal(searches(), 0, 'the cached list is used (no new model search)');
  assert.ok(cfRuns()[0].ctype.startsWith('multipart/form-data')); assert.match(cfRuns()[0].body, /name="steps"\r\n\r\n25/);
  assert.equal(g.model, '@cf/black-forest-labs/flux-2-dev'); assert.equal(g.model_why, 'best model'); assert.equal(g.quality, 'best');
  assert.match(g.note, /model flux-2-dev \(best model\)/);
  assert.match(lastRoute(), /^Pictures: 'Cloudflare' — Auto: flux-2-dev \(best model\)/);
  assert.equal(cf.cfUsedToday(id), 3750);
  assert.equal(g.free_today, 'Free pictures today: ~107 left (estimate) · ~1 in best quality');
  CF.SEEN.length = 0;
  g = await gen({ quality: 'fast' });
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.deepEqual(ranModels(), ['flux-1-schnell']); assert.equal(g.model_why, 'fast model');
  assert.equal(cf.cfUsedToday(id), 3808);
  CF.SEEN.length = 0;
  g = await gen({});            // no quality = auto
  assert.deepEqual(ranModels(), ['flux-2-klein-4b']); assert.equal(g.model_why, 'everyday model');
  setUsed(id, 0);
});

test('Auto: a model that fails (5xx, bad input, gone, out of capacity) → the next model on the same key; the key is not marked', async () => {
  const id = keyId('Cloudflare');
  CF.FAIL['@cf/black-forest-labs/flux-2-dev'] = 'down';
  CF.SEEN.length = 0;
  let g = await gen({ quality: 'best' });
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.deepEqual(ranModels(), ['flux-2-dev', 'flux-2-klein-9b']);
  assert.match(g.model_why, /^switched: flux-2-dev failed \(500: AiError: Internal server error\)$/);
  assert.match(lastRoute(), /Auto: flux-2-klein-9b \(switched: flux-2-dev failed/);
  CF.FAIL['@cf/black-forest-labs/flux-2-klein-9b'] = 'bad';
  CF.FAIL['@cf/leonardo/lucid-origin'] = 'gone';
  CF.SEEN.length = 0;
  g = await gen({ quality: 'best' });
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.deepEqual(ranModels(), ['flux-2-dev', 'flux-2-klein-9b', 'lucid-origin', 'phoenix-1.0']);
  assert.match(g.model_why, /switched: flux-2-dev failed .*; flux-2-klein-9b failed .*Bad input.*; lucid-origin failed/);
  CF.FAIL['@cf/black-forest-labs/flux-1-schnell'] = 'busy';     // 3040 = this model is busy, not the whole key
  CF.SEEN.length = 0;
  g = await gen({ quality: 'fast' });
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.deepEqual(ranModels(), ['flux-1-schnell', 'flux-2-klein-4b']);
  const row = aikeys.keyRow(id);
  assert.ok(!(row.cool_until > Date.now()), 'not resting'); assert.ok(!row.problem);
  // at most 4 models per request, then a plain error with each model's reason
  for (const m of ALLM) CF.FAIL[m] = 'down';
  CF.SEEN.length = 0;
  g = await gen({ quality: 'best' });
  assert.equal(cfRuns().length, 4); assert.match(g.error, /"Cloudflare" \(Cloudflare\): every model failed: flux-2-dev: .*500/);
  assert.ok(!(aikeys.keyRow(id).cool_until > Date.now()));
  setUsed(id, 0);
});

test('Auto: free amount nearly used (under 15% of 10,000 left) → the cheap model, "saving free allowance"', async () => {
  const id = keyId('Cloudflare');
  setUsed(id, 8700);
  assert.equal(pub(id).free_today.text, 'Free pictures today: ~22 left (estimate)');
  CF.SEEN.length = 0;
  const g = await gen({ quality: 'best' });
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.deepEqual(ranModels(), ['flux-1-schnell']);
  assert.equal(g.model_why, 'saving free allowance');
  assert.match(lastRoute(), /Auto: flux-1-schnell \(saving free allowance\)/);
  assert.equal(cf.cfUsedToday(id), 8758);
  setUsed(id, 0);
});

test('Auto: Cloudflare says the free amount is gone (429 / 3036) → the next key, as before; the empty key rests until 00:00 UTC and shows 0 left', async () => {
  const r = await call('/api/brain/keys', { name: 'CF empty', kind: 'cloudflare', account_id: ACCT, model: 'auto', key: TOK.quota });
  const emptyId = r.j.key.id;
  await toTop(emptyId);
  CF.SEEN.length = 0;
  const g = await gen({ quality: 'best' });
  assert.equal(g.ok, true, JSON.stringify(g));
  const runs = cfRuns();
  assert.deepEqual(runs.map(x => x.token), [TOK.quota, TOK.good], 'one try on the empty key, then the next key');
  assert.match(g.made_with, /^Cloudflare \(Cloudflare, @cf\/black-forest-labs\/flux-2-dev\)$/);
  const row = aikeys.keyRow(emptyId);
  const d = new Date(); assert.equal(row.cool_until, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  assert.equal(cf.cfUsedToday(emptyId), 10000);
  assert.equal(pub(emptyId).free_today.text, 'Free pictures today: ~0 left (estimate)');
  await call(`/api/brain/keys/${emptyId}/delete`, {});
  assert.equal(db.get('SELECT COUNT(*) AS n FROM cf_usage WHERE key_id=?', emptyId).n, 0, 'removing the key removes its counter');
  setUsed(keyId('Cloudflare'), 0);
});

test('the Neuron counter starts again at 00:00 UTC; the model list is refreshed at most once a day', async () => {
  const id = keyId('Cloudflare');
  const yesterday = Date.now() - 24 * 3600 * 1000;
  setUsed(id, 9990, cf.utcDay(yesterday));
  assert.equal(cf.cfUsedToday(id), 0);
  assert.equal(pub(id).free_today.left_neurons, 10000);
  cf.cfAddUsage(id, 58);
  assert.equal(cf.cfUsedToday(id), 58); assert.equal(db.get('SELECT day FROM cf_usage WHERE key_id=?', id).day, cf.utcDay());
  // a day-old list → asked again once; the next picture uses the new list
  db.run('UPDATE cf_usage SET models_at=?, models_tried_at=? WHERE key_id=?', Date.now() - 25 * 3600 * 1000, Date.now() - 25 * 3600 * 1000, id);
  CF.SEEN.length = 0;
  await gen({ quality: 'fast' }); await gen({ quality: 'fast' });
  assert.equal(searches(), 1);
  assert.ok(Date.now() - db.get('SELECT models_at FROM cf_usage WHERE key_id=?', id).models_at < 60000);
  setUsed(id, 0);
});

test('a key with one chosen model keeps working exactly as in 2.3.11 (no switching, quality ignored)', async () => {
  const r = await call('/api/brain/keys', { name: 'CF schnell', kind: 'cloudflare', account_id: ACCT, model: cf.CF_DEFAULT_MODEL, key: TOK.good });
  const id = r.j.key.id;
  await call(`/api/brain/keys/${keyId('Cloudflare')}`, { active: false });
  CF.SEEN.length = 0;
  let g = await gen({ quality: 'best' });
  assert.equal(g.ok, true); assert.deepEqual(ranModels(), ['flux-1-schnell']); assert.equal(g.model_why, undefined);
  assert.equal(cf.cfUsedToday(id), 58, 'counted for the "~N left" line too');
  CF.FAIL['@cf/black-forest-labs/flux-1-schnell'] = 'down';
  CF.SEEN.length = 0;
  g = await gen({ quality: 'best' });
  assert.equal(cfRuns().length, 1); assert.match(g.error, /CF schnell/);
  await call(`/api/brain/keys/${id}/delete`, {});
  await call(`/api/brain/keys/${keyId('Cloudflare')}`, { active: true });
});

test('brain loop over WhatsApp: the chat model asks for "best" (a poster) and "fast" (a quick one); both PNGs are saved and sent', async () => {
  let r = await call('/api/brain/keys', { name: 'Chat', kind: 'openai', base_url: F + '/chat/v1', model: 'mock/chat', key: CHATK, use_for: ['chat', 'coding', 'background'] });
  assert.equal(r.status, 200, r.text);
  await toTop(keyId('Chat'));
  r = await call('/api/wa-agent/key', { key: WAKEY }); assert.equal(r.status, 200, r.text);
  r = await call('/api/wa-agent', { enabled: true }); assert.equal(r.status, 200, r.text);
  await until(() => waagent.status().state === 'connected', 5000, 'connected');
  CF.SEEN.length = 0; CHAT.length = 0;
  const files0 = db.get('SELECT COUNT(*) AS n FROM files').n;
  push({ from: 'user:777', id: 'wamid.b1', type: 'text', text: { body: 'Make me a POSTER for shabbat' } });
  await until(() => AP.sent.filter(s => s.type === 'image').length >= 1, 15000, 'the first picture on WhatsApp');
  push({ from: 'user:777', id: 'wamid.f1', type: 'text', text: { body: 'and a QUICK apple' } });
  await until(() => AP.sent.filter(s => s.type === 'image').length >= 2, 15000, 'the second picture on WhatsApp');
  assert.deepEqual(ranModels(), ['flux-2-dev', 'flux-1-schnell']);
  const tool = CHAT.find(j => j.tools)?.tools.find(t => t.function.name === 'image_generate');
  assert.deepEqual(tool.function.parameters.properties.quality.enum, ['best', 'fast', 'auto']);
  assert.match(tool.function.description, /use "best" when he wants a high-quality or detailed picture \(portraits, text in the picture, posters/);
  assert.ok(!/@cf\//.test(JSON.stringify(tool)), 'the brain never sees model ids');
  const results = CHAT.flatMap(j => j.messages.filter(m => m.role === 'tool').map(m => m.content));
  assert.ok(results.some(c => /"model_why":"best model"/.test(c)) && results.some(c => /"model_why":"fast model"/.test(c)), 'the brain learns which model and why');
  assert.equal(AP.uploads.filter(u => u.type === 'image/png' && u.png).length, 2);
  assert.equal(AP.sent.filter(s => s.type === 'image').length, 2);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM files').n, files0 + 2);
});

test('no key or token ever shows up: not in any answer, not in the logs, not in the database (except encrypted)', async () => {
  await sleep(200);
  const dump = [];
  for (const { name } of db.all("SELECT name FROM sqlite_master WHERE type='table'")) {
    if (name === 'secrets') continue;
    for (const row of db.all(`SELECT * FROM "${name}"`)) dump.push(JSON.stringify(row));
  }
  assert.ok(db.all('SELECT * FROM cf_usage').length >= 1, 'the counter table is part of the check');
  const all = [RAW.join('\n'), LOGS.join('\n'), dump.join('\n')];
  for (const k of ALLKEYS) for (const [i, txt] of all.entries()) assert.ok(!txt.includes(k), `key ${k.slice(0, 7)}… found in ${['responses', 'logs', 'database'][i]}`);
  const raw = fs.readFileSync(DATA + '/' + fs.readdirSync(DATA).find(f => /\.(db|sqlite)$/.test(f)));
  for (const k of Object.values(TOK)) assert.ok(!raw.includes(Buffer.from(k)), 'not in the database file either');
});
