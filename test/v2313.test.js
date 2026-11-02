// 2.3.13: a Cloudflare key can also CHAT (Workers AI's OpenAI-compatible Chat Completions), as an extra backup brain
// when Gemini runs out. Chat and Background jobs are ticked by him (never by a Test). Test lists the account's chat
// models and makes one tiny chat call. Chat answers count toward the same free daily estimate as pictures (2.3.12).
// Out of today's free amount (429 / 3036) → the next key, as for every key. Everything runs against fakes on 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startMockCloudflare, TOK, ACCT } from './mock-cloudflare.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000, what = 'condition') { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); } throw new Error('timed out waiting for ' + what); }
const LOGS = [];
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { LOGS.push(a.map(String).join(' ')); if (process.env.SHOW_LOGS) orig(...a); }; }

const GEMLIM = 'AIzaV2313LIM_' + 'l'.repeat(26), CHATK = 'zz13Chat' + 'c'.repeat(30);
const ALLKEYS = [...Object.values(TOK), GEMLIM, CHATK];
const GEM = [], OAI = [];
const fake = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const b = Buffer.concat(chunks).toString();
  const J = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const p = new URL(req.url, 'http://x').pathname;
  if (p.startsWith('/v1beta/models')) {             // Gemini: always out of today's free limit
    GEM.push(p);
    return J({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, GenerateRequestsPerDayPerProjectPerModel-FreeTier' } }, 429);
  }
  if (p === '/oai/v1/chat/completions') {           // another OpenAI-compatible key (the next key after Cloudflare)
    if (String(req.headers.authorization) !== 'Bearer ' + CHATK) return J({ error: { message: 'Invalid API Key' } }, 401);
    OAI.push(JSON.parse(b || '{}'));
    return J({ choices: [{ message: { role: 'assistant', content: 'Answer from the other key.' } }] });
  }
  J({ error: { message: 'nope' } }, 404);
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const F = 'http://127.0.0.1:' + fake.address().port;
const CF = await startMockCloudflare();

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma2313-test-'));
const DATA = T + '/data';
const PORT = 22400 + Math.floor(Math.random() * 80);
Object.assign(process.env, {
  MA_DATA_DIR: DATA, MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/sites', MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_GEMINI_BASE: F, MA_CLOUDFLARE_BASE: CF.url,
  MA_RELEASE_BASE: F + '/site', MA_UPDATE_SOURCE: F + '/src1', MA_UPDATE_FALLBACKS: F + '/src2', MA_WA_AGENT_BASE: F + '/agent/v1',
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
const cfchat = await import('../src/cfchat.js');
const updates = await import('../src/updates.js');
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
test.beforeEach(() => { resetKeyTestLimit(); CF.CHAT.fail = null; });
test.after(() => { server.close(); fake.close(); CF.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });
const chatCalls = () => CF.CHAT.calls;
const cfRuns = () => CF.SEEN.filter(x => x.path.includes('/ai/run/'));
const textSearches = () => CF.SEEN.filter(x => x.path.endsWith('/ai/models/search') && /Text\+Generation|Text%20Generation/.test(x.query));
const toTop = async (id) => { for (let i = 0; i < 10; i++) { const ks = (await call('/api/brain/keys')).j.keys; if (ks[0].id === id) return; await call(`/api/brain/keys/${id}/move`, { dir: 'up' }); } };
const setActive = async (ids) => { for (const k of (await call('/api/brain/keys')).j.keys) await call(`/api/brain/keys/${k.id}`, { active: ids.includes(k.id) }); };
async function ask(text) {
  const r = await call('/api/chat', { text });
  assert.equal(r.status, 200, r.text);
  const id = r.j.job;
  const job = await until(() => { const j = db.get('SELECT * FROM jobs WHERE id=?', id); return j && ['done', 'error'].includes(j.status) ? j : null; }, 15000, 'job ' + id);
  return { job, answer: db.get("SELECT text FROM messages WHERE job_id=? AND role='assistant' ORDER BY id DESC LIMIT 1", id)?.text || '' };
}
let gemId, cfId, oaiId;

test('version 2.3.13 is newer than 2.3.12 (numbers, not text)', () => {
  assert.equal(updates.cmpVer('2.3.13', '2.3.12'), 1);
  assert.equal(updates.cmpVer('2.3.12', '2.3.13'), -1);
  assert.equal(updates.cmpVer('2.3.13', '2.3.9'), 1);
  assert.ok(updates.cmpVer(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version, '2.3.13') >= 0);      // 2.3.14: newer is fine
});

test('a Cloudflare key: Chat and Background jobs can be ticked (start unticked), its own chat model, the help line', async () => {
  gemId = (await call('/api/brain/keys', { name: 'Gemini', kind: 'gemini', key: GEMLIM })).j.key.id;
  let r = await call('/api/brain/keys', { name: 'Cloudflare', kind: 'cloudflare', account_id: ACCT, model: '', key: TOK.good });
  assert.equal(r.status, 200, r.text);
  const k = r.j.key; cfId = k.id;
  assert.deepEqual(k.use_for, ['pictures'], 'Chat and Background jobs start unticked');
  assert.equal(k.chat_model, ''); assert.equal(k.effective_chat_model, '@cf/openai/gpt-oss-120b');
  assert.equal(k.chat_help, 'Chat uses the same free daily amount as pictures. Weaker than Gemini; good as a backup.');
  assert.equal(k.use_support.chat.ok, null); assert.equal(k.use_support.background.ok, null);
  assert.equal(k.use_support.coding.ok, false); assert.equal(k.use_support.media.ok, false);
  assert.ok(!aikeys.usableKeys({ use: 'chat' }).some(x => x.kind === 'cloudflare'), 'not a brain until he ticks Chat');
  // a Test with Chat unticked makes no chat call and lists no chat models (nothing of the free amount is used)
  r = await call(`/api/brain/keys/${cfId}/test`, {});
  assert.equal(r.j.ok, true, r.text);
  assert.equal(chatCalls().length, 0); assert.equal(textSearches().length, 0); assert.equal(r.j.chat_models, undefined);
  assert.deepEqual(r.j.key.use_for, ['pictures'], 'a Test never ticks Chat by itself');
  // he ticks Chat and Background jobs (Coding is refused)
  r = await call(`/api/brain/keys/${cfId}`, { use_for: ['chat', 'coding', 'pictures', 'background'] });
  assert.deepEqual(r.j.key.use_for, ['chat', 'pictures', 'background']);
  assert.ok(aikeys.usableKeys({ use: 'chat' }).some(x => x.id === cfId && x.tagged));
  // the chat model: a typo is refused in plain words; a real name is kept; the default is stored as empty
  r = await call(`/api/brain/keys/${cfId}`, { chat_model: 'llama 3' });
  assert.equal(r.status, 400); assert.match(r.j.error, /Cloudflare chat models look like @cf\/openai\/gpt-oss-120b/);
  r = await call(`/api/brain/keys/${cfId}`, { chat_model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' });
  assert.equal(r.j.key.chat_model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  r = await call(`/api/brain/keys/${cfId}`, { chat_model: '' });
  assert.equal(r.j.key.chat_model, ''); assert.equal(r.j.key.effective_chat_model, '@cf/openai/gpt-oss-120b');
});

test('Test (Chat ticked): chat models as chips + ONE tiny chat call ("hi", max_tokens 5); no picture made; nothing ticked by itself', async () => {
  CF.CHAT.calls.length = 0;
  const before = cf.cfUsedToday(cfId);
  const r = await call(`/api/brain/keys/${cfId}/test`, {});
  assert.equal(r.j.ok, true, r.text);
  assert.match(r.j.message, /✓ Chat works \(@cf\/openai\/gpt-oss-120b\)\./);
  assert.deepEqual(r.j.chat_models, ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/openai/gpt-oss-120b', '@cf/meta/llama-3.1-8b-instruct'], 'models that can use tools first');
  assert.equal(r.j.chat_model, '@cf/openai/gpt-oss-120b'); assert.equal(r.j.chat_listed, true);
  assert.equal(chatCalls().length, 1);
  const c = chatCalls()[0];
  assert.equal(c.token, TOK.good);
  assert.deepEqual(c.body, { model: '@cf/openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 });
  assert.ok(textSearches().length >= 1);
  assert.equal(cfRuns().length, 0, 'Test never makes a picture');
  assert.equal(r.j.caps.text, true); assert.equal(r.j.caps.tools, true); assert.equal(r.j.caps.chat_model, '@cf/openai/gpt-oss-120b');
  assert.equal(r.j.key.use_support.chat.ok, true); assert.equal(r.j.key.use_support.background.ok, true);
  assert.deepEqual(r.j.key.use_for, ['chat', 'pictures', 'background']);
  assert.ok(cf.cfUsedToday(cfId) > before, 'the tiny chat call counts toward today\'s estimate');
  // a chat model the account doesn't have: plain words, chips still shown
  const d = await call('/api/brain/keys/test', { id: cfId, kind: 'cloudflare', account_id: ACCT, model: 'auto', chat_model: '@cf/nobody/no-such-chat', use_for: ['chat', 'pictures'] });
  assert.equal(d.j.ok, true, d.text); assert.match(d.j.message, /✗ Chat: "@cf\/nobody\/no-such-chat" is not one of Cloudflare's chat models/);
  assert.equal(d.j.chat_models.length, 3);
  assert.equal(d.j.use_support.chat.ok, false);
});

test('chat through the brain loop: Gemini is out of its free limit → the Cloudflare key answers, with a tool call', async () => {
  await setActive([gemId, cfId]); await toTop(gemId);
  CF.CHAT.calls.length = 0; GEM.length = 0;
  const before = cf.cfUsedToday(cfId);
  const { job, answer } = await ask('please calculate six times seven');
  assert.equal(job.status, 'done', job.result);
  assert.ok(GEM.length >= 1, 'Gemini was tried first');
  assert.match(answer, /Cloudflare chat here: the calculator says .*42/);
  assert.equal(chatCalls().length, 2, 'one call → tool call, one call with the tool result');
  const [c1, c2] = chatCalls();
  assert.equal(c1.body.model, '@cf/openai/gpt-oss-120b'); assert.equal(c1.body.max_tokens, 4096);
  assert.ok(Array.isArray(c1.body.tools) && c1.body.tools.some(t => t.type === 'function' && t.function.name === 'calculator'));
  assert.equal(c1.body.messages[0].role, 'system');
  const toolMsg = c2.body.messages.find(m => m.role === 'tool');
  assert.ok(toolMsg && toolMsg.tool_call_id === 'call_cf1' && /42/.test(toolMsg.content));
  assert.ok(c2.body.messages.some(m => m.role === 'assistant' && m.tool_calls?.[0]?.function?.name === 'calculator'));
  const used = cf.cfUsedToday(cfId) - before;
  assert.equal(used, 2 * cfchat.chatNeurons('@cf/openai/gpt-oss-120b', { prompt_tokens: 1000, completion_tokens: 50 }), 'Neurons counted in the same daily estimate as pictures');
  assert.match(db.get("SELECT detail FROM audit WHERE action='brain.route' ORDER BY id DESC LIMIT 1").detail, /^Chat \(job \d+\): 'Cloudflare'$/);
  assert.match(aikeys.publicKey(aikeys.keyRow(cfId)).free_today.text, /^Free pictures today: ~\d+ left/);
});

test('quota → next key: Cloudflare says today\'s free amount is used up (429 / 3036) → the next key answers; Cloudflare rests until 00:00 UTC', async () => {
  oaiId = (await call('/api/brain/keys', { name: 'Other', kind: 'openai', base_url: F + '/oai/v1', model: 'some-model', key: CHATK })).j.key.id;
  await setActive([cfId, oaiId]); await toTop(cfId);
  CF.CHAT.calls.length = 0; OAI.length = 0; CF.CHAT.fail = 'quota';
  const { job, answer } = await ask('hello there');
  assert.equal(job.status, 'done', job.result);
  assert.equal(answer, 'Answer from the other key.');
  assert.equal(chatCalls().length, 1); assert.equal(OAI.length, 1);
  const k = aikeys.keyRow(cfId);
  const d = new Date(); const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  assert.equal(k.cool_until, midnight);
  assert.match(k.last_error, /Cloudflare free daily amount used up \(429\) — back at/);
  assert.equal(cf.cfUsedToday(cfId), cf.CF_FREE_NEURONS, 'the estimate follows Cloudflare: nothing left today');
  assert.match(db.get("SELECT detail FROM audit WHERE action='brain.switch' ORDER BY id DESC LIMIT 1").detail, /Switched from 'Cloudflare' to 'Other': Cloudflare free daily amount used up/);
  // while it rests it is skipped without a call
  CF.CHAT.calls.length = 0; CF.CHAT.fail = null;
  const again = await ask('and again');
  assert.equal(again.answer, 'Answer from the other key.'); assert.equal(chatCalls().length, 0);
  db.run('UPDATE ai_keys SET cool_until=0, problem=NULL WHERE id=?', cfId);
  db.run('UPDATE cf_usage SET neurons=0 WHERE key_id=?', cfId);
});

test('Cloudflare busy or down → the next key answers right away, Cloudflare rests only a minute', async () => {
  for (const mode of ['busy', 'down']) {
    db.run('UPDATE ai_keys SET cool_until=0, problem=NULL WHERE id=?', cfId);
    CF.CHAT.calls.length = 0; OAI.length = 0; CF.CHAT.fail = mode;
    const { answer } = await ask('hi ' + mode);
    assert.equal(answer, 'Answer from the other key.', mode);
    const k = aikeys.keyRow(cfId);
    assert.ok(k.cool_until > Date.now() && k.cool_until < Date.now() + 2 * 60000, mode + ': short rest');
  }
  db.run('UPDATE ai_keys SET cool_until=0, problem=NULL WHERE id=?', cfId);
});

test('cfChatFail reads Cloudflare\'s errors in plain words, never with the token', () => {
  let c = cfchat.cfChatFail(429, JSON.stringify({ success: false, errors: [{ code: 3036, message: 'daily free allocation of 10,000 neurons used ' + TOK.good }] }), TOK.good);
  assert.equal(c.kind, 'quota'); assert.ok(c.perDay); assert.ok(!c.reason.includes(TOK.good));
  c = cfchat.cfChatFail(401, JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), TOK.good);
  assert.equal(c.kind, 'bad_key');
  c = cfchat.cfChatFail(400, JSON.stringify({ success: false, errors: [{ code: 5007, message: 'No such model' }] }), TOK.good);
  assert.equal(c.kind, 'model'); assert.equal(c.problem, undefined, 'a chat-model typo never blocks the key\'s pictures');
  assert.equal(cfchat.chatNeurons('@cf/openai/gpt-oss-120b', { prompt_tokens: 1e6, completion_tokens: 0 }), 31818);
  assert.equal(cfchat.chatNeurons('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { prompt_tokens: 0, completion_tokens: 1e6 }), 204805);
});

test('the Cloudflare token never shows up in logs, answers or the database', async () => {
  // Cloudflare repeats the token in an error on a chat call: still hidden
  const echoId = (await call('/api/brain/keys', { name: 'CF echo', kind: 'cloudflare', account_id: ACCT, key: TOK.echo, use_for: ['chat', 'pictures'] })).j.key.id;
  await setActive([echoId, oaiId]); await toTop(echoId);
  const { answer } = await ask('one more');
  assert.equal(answer, 'Answer from the other key.');
  await call(`/api/brain/keys/${echoId}/test`, {});
  await call('/api/brain/keys/test', { kind: 'cloudflare', account_id: ACCT, key: TOK.good, use_for: ['chat', 'pictures'] });
  RAW.push(JSON.stringify((await call('/api/brain/keys')).j), JSON.stringify((await call('/api/activity')).j || ''), JSON.stringify(aikeys.statusSummary()));
  const all = [...RAW, ...LOGS].join('\n');
  for (const t of ALLKEYS) assert.ok(!all.includes(t), 'token leaked: ' + t.slice(0, 8));
  db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const bytes = fs.readdirSync(DATA).filter(f => /\.db/.test(f)).map(f => fs.readFileSync(path.join(DATA, f)).toString('latin1')).join('');
  for (const t of ALLKEYS) assert.ok(!bytes.includes(t), 'token stored in plain text: ' + t.slice(0, 8));
});
