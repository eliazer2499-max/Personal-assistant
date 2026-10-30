// 2.3: several named AI keys, Test buttons, automatic failover — against fake Gemini and fake
// OpenAI-compatible (Groq-like) servers shaped like the real APIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Every console line the app prints is kept, to check no key ever reaches the log.
const LOGS = []; const origLog = console.log;
console.log = (...a) => { LOGS.push(a.join(' ')); };

const K = {
  MAIN: 'AIzaMAINKEY_' + 'm'.repeat(27), P2: 'AIzaPROJECT2_' + 'p'.repeat(26), P3: 'AIzaPROJECT3_' + 'q'.repeat(26),
  OLDOPENAI: 'sk-oldsecondprovider_' + 'o'.repeat(20), GROQ: 'gsk_GROQKEY' + 'g'.repeat(30), BADGROQ: 'gsk_BADGROQ' + 'b'.repeat(30),
};
const MODE = {};          // key → ok | 429min | 429day | bad | 500 | down
const CALLS = [];         // { api, key, model, media }
const fake = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const J = (o, s = 200, hd = {}) => { res.writeHead(s, { 'Content-Type': 'application/json', ...hd }); res.end(JSON.stringify(o)); };
  const gkey = req.headers['x-goog-api-key'];
  if (req.url.startsWith('/v1beta/models?')) {
    if (MODE[gkey] === 'bad') return J({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 400);
    return J({ models: ['gemini-3.6-flash', 'gemini-3.6-flash-lite', 'gemini-3.6-pro', 'text-embedding-005', 'gemini-3.1-flash-image'].map(n => ({ name: 'models/' + n, supportedGenerationMethods: n.startsWith('text-') ? ['embedContent'] : ['generateContent'] })) });
  }
  const gm = /\/v1beta\/models\/([^:]+):generateContent/.exec(req.url);
  if (gm) {
    const j = JSON.parse(b); const media = j.contents.flatMap(c => c.parts).filter(p => p.inlineData).map(p => p.inlineData.mimeType);
    CALLS.push({ api: 'gemini', key: gkey, model: decodeURIComponent(gm[1]), media });
    const m = MODE[gkey] || 'ok';
    if (m === '429min') return J({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. Please retry in 1.4s.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' }] } }, 429);
    if (m === '429day') return J({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 250',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '31s' }] } }, 429);
    if (m === 'bad') return J({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 400);
    if (m === '500') return J({ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }, 503);
    return J({ candidates: [{ content: { role: 'model', parts: [{ text: 'answer from ' + gkey.slice(4, 12) }] }, finishReason: 'STOP' }] });
  }
  if (req.url.startsWith('/v1/')) {
    const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (key !== K.GROQ && key !== K.OLDOPENAI) return J({ error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401);
    if (req.url === '/v1/models') return J({ object: 'list', data: [{ id: 'openai/gpt-oss-120b' }, { id: 'llama-3.1-8b-instant' }] });
    if (req.url === '/v1/chat/completions') {
      const j = JSON.parse(b);
      CALLS.push({ api: 'openai', key, model: j.model, media: [] , text: JSON.stringify(j.messages.at(-1).content) });
      if (MODE[key] === '429min') return J({ error: { message: 'Rate limit reached for model `openai/gpt-oss-120b` on requests per minute (RPM): Limit 30, Used 30. Please try again in 1.5s.', type: 'requests', code: 'rate_limit_exceeded' } }, 429, { 'retry-after': '2' });
      if (!['openai/gpt-oss-120b', 'llama-3.1-8b-instant'].includes(j.model)) return J({ error: { message: `The model \`${j.model}\` does not exist or you do not have access to it.`, type: 'invalid_request_error', code: 'model_not_found' } }, 404);
      return J({ choices: [{ message: { role: 'assistant', content: 'answer from groq' } }] });
    }
  }
  J({ error: { message: 'nope' } }, 404);
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const F = 'http://127.0.0.1:' + fake.address().port;

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v23-'));
const DATA = T + '/data';
const PORT = 20100 + Math.floor(Math.random() * 150);
Object.assign(process.env, {
  MA_DATA_DIR: DATA, MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/sites', MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_RELEASE_BASE: 'http://127.0.0.1:1', MA_GEMINI_BASE: F,
});
// A 2.2 database: one Gemini key, and a second provider set up but not switched on.
const { loadMasterKey } = await import('../src/crypto.js');
const db = await import('../src/db.js');
loadMasterKey(DATA); db.openDb();
db.setSetting('setup_done', '1'); db.setSetting('model', 'gemini-3.6-flash'); db.setSetting('morning_summary', '0');
db.setSecret('gemini_api_key', K.MAIN);
db.setSetting('provider', 'gemini'); db.setSetting('openai_base_url', F + '/v1'); db.setSetting('openai_model', 'llama-3.3-70b-versatile'); db.setSecret('openai_api_key', K.OLDOPENAI);
db.db.close();

const { start } = await import('../src/server.js');
const auth = await import('../src/auth.js');
const aikeys = await import('../src/aikeys.js');
const brain = await import('../src/brain.js');
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
async function ask(text, files) {
  const r = await call('/api/chat', { text, ...(files ? { files } : {}) }); assert.equal(r.status, 200, r.text);
  for (let i = 0; i < 400; i++) { const j = db.get('SELECT * FROM jobs WHERE id=?', r.j.job); if (['done', 'error'].includes(j.status)) return j; await sleep(25); }
  throw new Error('job did not finish');
}
const keys = async () => (await call('/api/brain/keys')).j.keys;
const byName = async (n) => (await keys()).find(k => k.name === n);
const reset = () => { CALLS.length = 0; for (const k of Object.keys(MODE)) delete MODE[k]; db.run('UPDATE ai_keys SET cool_until=0, problem=NULL'); };

test.after(() => { console.log = origLog; server.close(); fake.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });

test('migration from 2.2: "Gemini (main)" active, "Second provider" kept but inactive; no key in the answer', async () => {
  const ks = await keys();
  assert.deepEqual(ks.map(k => [k.name, k.kind, k.active, k.has_key]), [['Gemini (main)', 'gemini', true, true], ['Second provider', 'openai', false, true]]);
  assert.equal(ks[0].model, ''); assert.equal(ks[0].effective_model, 'gemini-3.6-flash');
  assert.equal(ks[1].base_url, F + '/v1'); assert.equal(ks[1].model, 'llama-3.3-70b-versatile');
  assert.equal(aikeys.keyValue(ks[0].id), K.MAIN); assert.equal(aikeys.keyValue(ks[1].id), K.OLDOPENAI);
  // runs once: a restart does not add them again
  aikeys.ensureKeys(); assert.equal((await keys()).length, 2);
  const j = await ask('hello');
  assert.equal(j.status, 'done'); assert.equal(j.result, 'answer from MAINKEY_');
  assert.ok(CALLS.every(c => c.api === 'gemini'));
  const me = await call('/api/me'); assert.equal(me.j.has_key, true);
});

test('add keys (Gemini project 2, Groq), order decides, inactive keys are skipped', async () => {
  let r = await call('/api/brain/keys', { name: 'Gemini – project 2 (abish@…)', kind: 'gemini', key: K.P2, active: true }); assert.equal(r.status, 200, r.text);
  r = await call('/api/brain/keys', { name: 'Groq', kind: 'openai', base_url: F + '/v1/', model: 'openai/gpt-oss-120b', key: K.GROQ, active: true }); assert.equal(r.status, 200);
  assert.equal(r.j.key.base_url, F + '/v1');
  r = await call('/api/brain/keys', { name: '', kind: 'gemini', key: K.P3 }); assert.equal(r.status, 400);
  r = await call('/api/brain/keys', { name: 'x', kind: 'openai', base_url: 'ftp://x', model: 'm' }); assert.equal(r.status, 400);
  assert.deepEqual((await keys()).map(k => k.name), ['Gemini (main)', 'Second provider', 'Gemini – project 2 (abish@…)', 'Groq']);
  const p2 = await byName('Gemini – project 2 (abish@…)');
  await call(`/api/brain/keys/${p2.id}/move`, { dir: 'up' }); r = await call(`/api/brain/keys/${p2.id}/move`, { dir: 'up' });
  assert.deepEqual(r.j.keys.map(k => k.name), ['Gemini – project 2 (abish@…)', 'Gemini (main)', 'Second provider', 'Groq']);
  reset(); assert.equal((await ask('hi')).result, 'answer from PROJECT2');
  await call(`/api/brain/keys/${p2.id}`, { active: false });
  reset(); assert.equal((await ask('hi')).result, 'answer from MAINKEY_');
  assert.ok(!CALLS.some(c => c.key === K.P2 || c.key === K.OLDOPENAI), 'inactive keys never called');
  await call(`/api/brain/keys/${p2.id}`, { active: true });
  await call(`/api/brain/keys/${p2.id}/move`, { dir: 'down' });     // order: main, p2, second provider (off), groq
  assert.deepEqual((await keys()).map(k => k.name), ['Gemini (main)', 'Gemini – project 2 (abish@…)', 'Second provider', 'Groq']);
});

test('429 per-minute: the same request goes to the next key; the rest time is honoured; Activity says so', async () => {
  reset(); MODE[K.MAIN] = '429min';
  const t0 = Date.now();
  const j = await ask('one');
  assert.equal(j.result, 'answer from PROJECT2');
  assert.deepEqual(CALLS.map(c => c.key), [K.MAIN, K.P2], 'one try on main, then project 2, same request');
  const main = await byName('Gemini (main)');
  assert.ok(main.resting_until >= t0 + 1900 && main.resting_until <= Date.now() + 2100, 'retryDelay 2s honoured');
  assert.match(main.last_error, /Google free limit reached \(429\)/);
  assert.ok(!/https?:/.test(main.last_error), 'no raw links');
  CALLS.length = 0;
  await ask('two');
  assert.deepEqual(CALLS.map(c => c.key), [K.P2], 'main is resting, not called');
  const sw = db.all("SELECT detail FROM audit WHERE action='brain.switch'").map(r => r.detail);
  assert.ok(sw.some(d => /^Switched from 'Gemini \(main\)' to 'Gemini – project 2 \(abish@…\)': Google free limit reached/.test(d)), sw.join(' | '));
  const st = await call('/api/brain/keys'); assert.equal(st.j.in_use.name, 'Gemini – project 2 (abish@…)');
  await sleep(2100); MODE[K.MAIN] = 'ok'; CALLS.length = 0;
  assert.equal((await ask('three')).result, 'answer from MAINKEY_', 'after the rest, first key again');
  // assistant_status shows the key in use
  const tools = await import('../src/tools/index.js');
  const s = await tools.execTool('assistant_status', {}, { actor: 'assistant' });
  assert.equal((s.ai_key_in_use || s.result?.ai_key_in_use).name, 'Gemini (main)');
});

test('429 per day: rests until midnight Pacific; status line says when', async () => {
  reset(); MODE[K.MAIN] = '429day';
  assert.equal((await ask('day')).result, 'answer from PROJECT2');
  const main = await byName('Gemini (main)');
  assert.equal(main.resting_until, aikeys.nextPacificMidnight(main.last_error_at));
  assert.match(main.last_error, /Google free daily limit reached \(429\) — resets ~\d{1,2}(:\d\d)? AM E[DS]T/);
  assert.match(main.resting_until_text, /^12:00 AM P|^3:00 AM E/);
  // midnight Pacific, also across the daylight-saving change
  assert.equal(new Date(aikeys.nextPacificMidnight(Date.parse('2026-10-30T16:51:00Z'))).toISOString(), '2026-10-31T07:00:00.000Z');
  assert.equal(new Date(aikeys.nextPacificMidnight(Date.parse('2026-11-01T12:00:00Z'))).toISOString(), '2026-11-02T08:00:00.000Z');
  assert.equal(new Date(aikeys.nextPacificMidnight(Date.parse('2026-10-31T06:59:00Z'))).toISOString(), '2026-10-31T07:00:00.000Z');
});

test('bad key: marked "bad key", the request still answered by the next key; fixing the key clears it', async () => {
  reset(); MODE[K.MAIN] = 'bad';
  assert.equal((await ask('x')).result, 'answer from PROJECT2');
  let main = await byName('Gemini (main)');
  assert.equal(main.problem, 'bad key'); assert.match(main.last_error, /^bad key/);
  delete MODE[K.MAIN];
  await call(`/api/brain/keys/${main.id}`, { key: K.MAIN });      // pasting the key again clears the rest
  main = await byName('Gemini (main)'); assert.equal(main.problem, null); assert.equal(main.resting_until, null);
  assert.equal(main.has_key, true);
});

test('5xx: one quick retry, then the next key', async () => {
  reset(); MODE[K.MAIN] = '500';
  assert.equal((await ask('y')).result, 'answer from PROJECT2');
  assert.deepEqual(CALLS.map(c => c.key), [K.MAIN, K.MAIN, K.P2]);
  assert.match((await byName('Gemini (main)')).last_error, /having trouble \(503\)/);
});

test('model not found on an OpenAI-compatible key: config problem, no timed rest, next key used', async () => {
  reset();
  const groq = await byName('Groq');
  await call(`/api/brain/keys/${groq.id}/move`, { dir: 'up' }); await call(`/api/brain/keys/${groq.id}/move`, { dir: 'up' }); await call(`/api/brain/keys/${groq.id}/move`, { dir: 'up' });
  await call(`/api/brain/keys/${groq.id}`, { model: 'llama-3.3-70b-versatile' });
  assert.equal((await ask('z')).result, 'answer from MAINKEY_');
  const g = await byName('Groq');
  assert.equal(g.problem, 'model not found'); assert.equal(g.resting_until, null);
  assert.match(g.last_error, /model not found — tap Test and pick one from the list/);
  CALLS.length = 0; await ask('z2');
  assert.ok(!CALLS.some(c => c.api === 'openai'), 'skipped until fixed');
  await call(`/api/brain/keys/${g.id}`, { model: 'openai/gpt-oss-120b' });
  reset(); assert.equal((await ask('z3')).result, 'answer from groq');
});

test('voice note / PDF: Gemini keys first even when an OpenAI-compatible key is first; text-only keeps the order', async () => {
  reset();   // order now: Groq, main, p2
  const media = [{ kind: 'audio', mime: 'audio/ogg', data: 'T2dnUw==', name: 'voice.ogg' }];
  let r = await brain.callModel({ system: 's', items: [{ role: 'user', text: '', media }], tools: [] });
  assert.equal(r.keyName, 'Gemini (main)'); assert.deepEqual(CALLS.map(c => [c.api, c.media]), [['gemini', ['audio/ogg']]]);
  CALLS.length = 0;
  r = await brain.callModel({ system: 's', items: [{ role: 'user', text: 'hi' }], tools: [] });
  assert.equal(r.keyName, 'Groq');
  // through the app: upload a voice note while every Gemini key is resting → Groq answers + a notice
  MODE[K.MAIN] = '429day'; MODE[K.P2] = '429day'; CALLS.length = 0;
  const up = await fetch(BASE + '/api/files', { method: 'POST', body: Buffer.from('OggS fake voice'), headers: { Cookie: cookie, 'X-CSRF': csrf, 'Content-Type': 'audio/ogg', 'X-File-Name': 'voice.ogg' } });
  const f = await up.json(); assert.ok(f.id || f.file?.id, JSON.stringify(f));
  const j = await ask('', [f.id || f.file.id]);
  assert.equal(j.result, 'answer from groq');
  assert.deepEqual(CALLS.map(c => c.api), ['gemini', 'gemini', 'openai'], JSON.stringify(CALLS).slice(0, 1500));
  assert.match(CALLS.at(-1).text, /cannot open it/);
  const notice = db.get("SELECT text FROM messages WHERE role='notice' AND job_id=?", j.id);
  assert.match(notice.text, /No Gemini key was free, so I used "Groq"/);
});

test('all keys fail: one clear message naming each key and why', async () => {
  reset(); MODE[K.MAIN] = '429day'; MODE[K.P2] = 'bad';
  const groq = await byName('Groq');
  db.setSecret('ai_key_' + groq.id, K.BADGROQ);
  const j = await ask('anything');
  assert.equal(j.status, 'error');
  assert.match(j.result, /^I couldn't get an answer from any of your AI keys:/);
  assert.match(j.result, /• Groq: bad key \(401\)/);
  assert.match(j.result, /• Gemini \(main\): Google free daily limit reached \(429\) — resets ~/);
  assert.match(j.result, /• Gemini – project 2 \(abish@…\): bad key/);
  assert.match(j.result, /\(1 more switched off\.\)/);
  assert.match(j.result, /Settings → Brain \(AI model\) → AI keys/);
  assert.ok(!/https?:\/\//.test(j.result) && j.result.length < 600, 'short, no raw provider text');
  const msg = db.get("SELECT text FROM messages WHERE role='assistant' AND job_id=?", j.id);
  assert.equal(msg.text, j.result);
  db.setSecret('ai_key_' + groq.id, K.GROQ);
});

test('Test button: Gemini lists models and makes a tiny request; errors are readable', async () => {
  reset();
  const main = await byName('Gemini (main)');
  let r = await call(`/api/brain/keys/${main.id}/test`, {});
  assert.equal(r.j.ok, true); assert.equal(r.j.message, '✓ Works (gemini-3.6-flash)');
  assert.ok(r.j.models.includes('gemini-3.6-flash-lite') && !r.j.models.includes('gemini-3.1-flash-image') && !r.j.models.includes('text-embedding-005'));
  assert.equal(r.j.models[0], 'gemini-3.6-flash-lite', 'lite models first');
  // 2.3.2: after the one tiny request, Test also checks photos, voice, PDF and tools (one small call each)
  assert.ok(CALLS.length >= 1 && CALLS.length <= 5, 'one test call + at most 4 capability checks'); assert.equal(CALLS[0].key, K.MAIN);
  MODE[K.MAIN] = '429day';
  r = await call(`/api/brain/keys/${main.id}/test`, {});
  assert.equal(r.j.ok, false); assert.match(r.j.message, /^✗ Google free daily limit reached \(429\) — resets ~/);
  assert.ok(r.j.key.resting_until);
  MODE[K.MAIN] = 'bad';
  r = await call(`/api/brain/keys/${main.id}/test`, {}); assert.match(r.j.message, /^✗ bad key/);
  delete MODE[K.MAIN];
  r = await call(`/api/brain/keys/${main.id}/test`, {}); assert.equal(r.j.ok, true); assert.equal(r.j.key.problem, null); assert.equal(r.j.key.resting_until, null);
  // 2.2's "Check key" still works
  r = await call('/api/brain/test', {}); assert.equal(r.j.ok, true); assert.ok(r.j.flash_models.includes('gemini-3.6-flash-lite'));
});

test('Test button: OpenAI-compatible lists the key\'s models and flags a model not in the list', async () => {
  reset();
  const groq = await byName('Groq');
  await call(`/api/brain/keys/${groq.id}`, { model: 'llama-3.3-70b-versatile' });
  let r = await call(`/api/brain/keys/${groq.id}/test`, {});
  assert.equal(r.j.ok, false); assert.deepEqual(r.j.models, ['llama-3.1-8b-instant', 'openai/gpt-oss-120b']);
  assert.match(r.j.message, /model not found — tap Test and pick one from the list/); assert.equal(r.j.model_listed, false);
  await call(`/api/brain/keys/${groq.id}`, { model: 'openai/gpt-oss-120b' });
  r = await call(`/api/brain/keys/${groq.id}/test`, {});
  assert.equal(r.j.ok, true); assert.equal(r.j.message, '✓ Works (openai/gpt-oss-120b)');
  const so = await byName('Second provider');
  r = await call(`/api/brain/keys/${so.id}/test`, {}); assert.equal(r.j.ok, false);   // old model name → not found, list shown
  assert.ok(r.j.models.length === 2);
  db.setSecret('ai_key_' + groq.id, K.BADGROQ);
  r = await call(`/api/brain/keys/${groq.id}/test`, {}); assert.match(r.j.message, /^✗ bad key \(401\)/); assert.deepEqual(r.j.models, []);
  db.setSecret('ai_key_' + groq.id, K.GROQ);
  r = await call('/api/brain/keys', {}); assert.equal(r.status, 400);
  const g = await call('/api/brain/keys'); assert.equal(g.j.groq.model, 'openai/gpt-oss-120b'); assert.equal(g.j.groq.base_url, 'https://api.groq.com/openai/v1');
});

test('remove a key: gone from the list and its secret is deleted', async () => {
  const r0 = await call('/api/brain/keys', { name: 'temp', kind: 'gemini', key: K.P3 });
  const id = r0.j.key.id;
  assert.ok(db.hasSecret('ai_key_' + id));
  const r = await call(`/api/brain/keys/${id}/delete`, {}); assert.equal(r.status, 200);
  assert.ok(!db.hasSecret('ai_key_' + id)); assert.ok(!(await keys()).some(k => k.id === id));
  assert.equal((await call(`/api/brain/keys/${id}/test`, {})).status, 404);
});

test('keys never appear in API answers, logs, Activity, job steps, messages or the raw database', async () => {
  reset(); MODE[K.MAIN] = '429min'; await ask('last'); await sleep(50);
  const vals = Object.values(K);
  for (const v of vals) {
    assert.ok(!RESPONSES.some(t => t.includes(v)), 'API answer has ' + v.slice(0, 8));
    assert.ok(!LOGS.some(t => t.includes(v)), 'log has ' + v.slice(0, 8));
  }
  const rows = JSON.stringify([db.all('SELECT * FROM audit'), db.all('SELECT * FROM job_events'), db.all('SELECT * FROM messages'), db.all('SELECT * FROM ai_keys'), db.all('SELECT * FROM settings'), db.all('SELECT * FROM jobs')]);
  for (const v of vals) assert.ok(!rows.includes(v), 'table text has ' + v.slice(0, 8));
  db.db.exec('PRAGMA wal_checkpoint(FULL)');
  const raw = Buffer.concat(fs.readdirSync(DATA).filter(f => f.startsWith('assistant.db')).map(f => fs.readFileSync(path.join(DATA, f))));
  for (const v of vals) assert.ok(!raw.includes(Buffer.from(v)), 'raw db has ' + v.slice(0, 8));
  assert.ok(LOGS.some(t => /key "Gemini \(main\)" failed/.test(t)), 'failures are logged by name');
});

test('migration when the second provider was in use: it stays first and active, Gemini behind it', async () => {
  const f2 = T + '/other.db';
  db.openDb(f2);
  db.setSecret('gemini_api_key', K.MAIN); db.setSetting('provider', 'openai'); db.setSetting('openai_base_url', F + '/v1'); db.setSetting('openai_model', 'openai/gpt-oss-120b'); db.setSecret('openai_api_key', K.GROQ);
  aikeys.ensureKeys();
  assert.deepEqual(aikeys.listKeys().map(k => [k.name, k.active]), [['Second provider', true], ['Gemini (main)', true]]);
  // a fresh install with no keys: nothing is made up
  db.openDb(T + '/empty.db'); aikeys.ensureKeys(); assert.equal(aikeys.listKeys().length, 0);
  await assert.rejects(brain.callModel({ system: 's', items: [{ role: 'user', text: 'hi' }], tools: [] }), /No AI key yet\. Open Settings → Brain \(AI model\) → AI keys → Add key/);
});
