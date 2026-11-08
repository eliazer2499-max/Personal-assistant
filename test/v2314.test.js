// 2.3.14: three fixes from his live error (Nov 2 2026, 1:48 AM: every key failed).
// 1. Gemini 3 "Function call is missing a thought_signature": signatures go back exactly as returned; a tool call made by
//    another key (or an older model) gets Google's documented stand-in when a Gemini 3 key takes over the job.
// 2. Cloudflare chat "Bad input: oneOf at '/' not met … required properties at '/' are 'prompt'": the body now fits the
//    model's published schema (checked here against Cloudflare's own schema file); bad input → one plain-chat try.
// 3. "Request too large (413)" on a small key (free Groq): one smaller request on the same key before the next key; the
//    key's limit is remembered so later requests start small. Not a key failure.
// Everything runs against fakes on 127.0.0.1 (no real provider is called).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startMockCloudflare, TOK, ACCT, CHAT_SCHEMA } from './mock-cloudflare.js';
import { check } from './schema-check.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000, what = 'condition') { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); } throw new Error('timed out waiting for ' + what); }
const LOGS = [];
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { LOGS.push(a.map(String).join(' ')); if (process.env.SHOW_LOGS) orig(...a); }; }

const GEM3 = 'AIzaV2314Gem3_' + 'g'.repeat(25), GEMSTRICT = 'AIzaV2314Strict_' + 's'.repeat(23), GEMOUT = 'AIzaV2314Out_' + 'o'.repeat(26);
const SMALLK = 'zz14Small' + 's'.repeat(30), OTHERK = 'zz14Other' + 'o'.repeat(30), FIRSTK = 'zz14First' + 'f'.repeat(30);
const GEM = [], SMALL = [], OTHER = [], FIRST = [];
const SMALL_LIMIT = 8000;
const SIG_MSG = 'Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call `default_api:calculator` , position 2. Please refer to https://ai.google.dev/gemini-api/docs/thought-signatures for more details.';
const userText = (c) => (c.parts || []).filter(p => typeof p.text === 'string').map(p => p.text).join(' ');
// Gemini 3's rule (Google's docs): in each step of the CURRENT turn, the first functionCall part must carry its signature.
// The current turn starts at the last user content that is not only function responses.
function missingSignature(contents) {
  let start = 0;
  contents.forEach((c, i) => { if (c.role === 'user' && (c.parts || []).some(p => !p.functionResponse)) start = i; });
  return contents.slice(start).some(c => c.role === 'model' && (() => { const f = (c.parts || []).find(p => p.functionCall); return f && !f.thoughtSignature; })());
}
const fake = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const b = Buffer.concat(chunks).toString();
  const J = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const p = new URL(req.url, 'http://x').pathname;
  let j = {}; try { j = JSON.parse(b || '{}'); } catch {}
  const m = /^\/v1beta\/models\/([^:]+):generateContent$/.exec(p);
  if (m) {
    const key = String(req.headers['x-goog-api-key']), model = decodeURIComponent(m[1]);
    GEM.push({ key, model, body: j });
    if (key === GEMOUT) return J({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, GenerateRequestsPerDayPerProjectPerModel-FreeTier' } }, 429);
    const checks = /gemini-(3|4)/.test(model) || key === GEMSTRICT;          // Gemini 3+ check; GEMSTRICT: an older model that checks anyway
    if (checks && missingSignature(j.contents || [])) return J({ error: { code: 400, message: SIG_MSG, status: 'INVALID_ARGUMENT' } }, 400);
    const last = (j.contents || []).at(-1) || {};
    if ((last.parts || []).some(p => p.functionResponse)) {
      const fr = last.parts.find(p => p.functionResponse).functionResponse;
      return J({ candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini: the calculator says ' + JSON.stringify(fr.response), thoughtSignature: 'SIG_TEXT_B' }] }, finishReason: 'STOP' }] });
    }
    if (/calculate/i.test(userText(last)) && j.tools) {
      const call = { functionCall: { name: 'calculator', args: { expression: '6*7' } } };
      // Gemini 3 signs the first functionCall of a step; a parallel second call has no signature (Google's docs)
      const parts = /gemini-(3|4)/.test(model) ? [{ ...call, thoughtSignature: 'SIG_A_' + model }, { functionCall: { name: 'calculator', args: { expression: '1+1' } } }] : [call];
      return J({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] });
    }
    return J({ candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini says hi.' }] }, finishReason: 'STOP' }] });
  }
  if (p === '/first/v1/chat/completions') {            // an OpenAI-compatible key that answers the first step, then is busy
    FIRST.push(j);
    if (j.messages.some(x => x.role === 'tool')) return J({ error: { message: 'Rate limit reached. Please try again in 50s.' } }, 429);
    return J({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_f1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"6*7"}' } }] } }] });
  }
  if (p === '/small/v1/chat/completions') {            // like a free Groq key: one request may hold at most 8,000 tokens
    const requested = Math.ceil(b.length / 4) + (j.max_completion_tokens || j.max_tokens || 0);
    SMALL.push({ body: j, requested, size: b.length });
    if (requested > SMALL_LIMIT || b.includes('ALWAYS413')) return J({ error: { message: `Request too large for model \`openai/gpt-oss-120b\` in organization \`org_test\` service tier \`on_demand\` on tokens per minute (TPM): Limit ${SMALL_LIMIT}, Requested ${requested}, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today.`, type: 'tokens', code: 'rate_limit_exceeded' } }, 413);
    const lastU = [...j.messages].reverse().find(x => x.role === 'user');
    return J({ choices: [{ message: { role: 'assistant', content: 'Small key answer (' + String(lastU.content).slice(0, 30) + ')' } }] });
  }
  if (p === '/other/v1/chat/completions') { OTHER.push(j); return J({ choices: [{ message: { role: 'assistant', content: 'Answer from the other key.' } }] }); }
  J({ error: { message: 'nope' } }, 404);
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const F = 'http://127.0.0.1:' + fake.address().port;
const CF = await startMockCloudflare();

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma2314-test-'));
const DATA = T + '/data';
const PORT = 22600 + Math.floor(Math.random() * 80);
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
const brain = await import('../src/brain.js');
const cfchat = await import('../src/cfchat.js');
const tools = await import('../src/tools/index.js');
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
test.beforeEach(() => { resetKeyTestLimit(); CF.CHAT.fail = null; for (const k of aikeys.listRows()) db.run('UPDATE ai_keys SET cool_until=0, problem=NULL WHERE id=?', k.id); });
test.after(() => { server.close(); fake.close(); CF.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });
const toTop = async (id) => { for (let i = 0; i < 12; i++) { const ks = (await call('/api/brain/keys')).j.keys; if (ks[0].id === id) return; await call(`/api/brain/keys/${id}/move`, { dir: 'up' }); } };
const order = async (ids) => { await setActive(ids); for (const id of [...ids].reverse()) await toTop(id); };
const setActive = async (ids) => { for (const k of (await call('/api/brain/keys')).j.keys) await call(`/api/brain/keys/${k.id}`, { active: ids.includes(k.id) }); };
async function ask(text) {
  const r = await call('/api/chat', { text });
  assert.equal(r.status, 200, r.text);
  const id = r.j.job;
  const job = await until(() => { const j = db.get('SELECT * FROM jobs WHERE id=?', id); return j && ['done', 'error'].includes(j.status) ? j : null; }, 20000, 'job ' + id);
  return { job, answer: db.get("SELECT text FROM messages WHERE job_id=? AND role='assistant' ORDER BY id DESC LIMIT 1", id)?.text || '' };
}
const addKey = async (b) => { const r = await call('/api/brain/keys', b); assert.equal(r.status, 200, r.text); const id = r.j.key.id; await call(`/api/brain/keys/${id}`, { use_for: ['chat', 'coding', 'background', 'media'] }); return id; };
let gem3Id, strictId, gemOutId, firstId, smallId, otherId, cfId;

test('version 2.3.14 is newer than 2.3.13 (numbers, not text)', () => {
  assert.equal(updates.cmpVer('2.3.14', '2.3.13'), 1);
  assert.equal(updates.cmpVer('2.3.13', '2.3.14'), -1);
  assert.equal(updates.cmpVer('2.3.14', '2.3.9'), 1);
  // 2.3.15: the version moved on; package.json and VERSION still agree and are not older than 2.3.14
  const pv = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
  assert.equal(fs.readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim(), pv);
  assert.ok(updates.cmpVer(pv, '2.3.14') >= 0, pv);
});

// ---------------- 1. Gemini thought signatures ----------------
test('signatures: Gemini parts go back exactly as returned (functionCall + thoughtSignature, text + thoughtSignature)', () => {
  const raw = [{ text: 'Let me check.', thoughtSignature: 'SIG_T' }, { functionCall: { name: 'calculator', args: { expression: '6*7' } }, thoughtSignature: 'SIG_A' }, { functionCall: { name: 'calculator', args: { expression: '1+1' } } }];
  const items = [{ role: 'user', text: 'calc' }, { role: 'assistant', text: 'Let me check.', calls: [{ id: 'local-0', name: 'calculator', args: {} }], raw }, { role: 'tool', id: 'local-0', name: 'calculator', result: 42 }];
  for (const fill of [false, true]) {
    const out = brain.toGeminiContents(items, null, { fillSignatures: fill });
    assert.deepEqual(out[1], { role: 'model', parts: raw }, 'the model turn is sent exactly as returned');
  }
  assert.equal(raw[2].thoughtSignature, undefined, 'a parallel call keeps no signature (only the first carries it)');
});

test('signatures: which models check them; a tool call with no signature gets the documented stand-in (only on the first call of a step)', () => {
  for (const m of ['gemini-3.6-flash', 'gemini-3-pro-preview', 'gemini-3.1-flash-lite', 'gemini-4-flash', 'gemini-flash-latest']) assert.equal(brain.geminiChecksSignatures(m), true, m);
  for (const m of ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemma-3-27b-it', '']) assert.equal(brain.geminiChecksSignatures(m), false, m);
  assert.equal(brain.SKIP_SIGNATURE, 'skip_thought_signature_validator');
  const items = [{ role: 'user', text: 'calc' }, { role: 'assistant', text: 'ok', calls: [{ id: 'c1', name: 'calculator', args: { expression: '6*7' } }, { id: 'c2', name: 'calculator', args: { expression: '1+1' } }] },
    { role: 'tool', id: 'c1', name: 'calculator', result: 42 }, { role: 'tool', id: 'c2', name: 'calculator', result: 2 }];
  const plain = brain.toGeminiContents(items);
  assert.ok(plain[1].parts.every(p => !p.thoughtSignature), 'older models: nothing added');
  const filled = brain.toGeminiContents(items, null, { fillSignatures: true });
  assert.deepEqual(filled[1].parts, [{ text: 'ok' }, { functionCall: { name: 'calculator', args: { expression: '6*7' } }, thoughtSignature: 'skip_thought_signature_validator' }, { functionCall: { name: 'calculator', args: { expression: '1+1' } } }]);
  assert.equal(items[1].calls[0].thoughtSignature, undefined, 'the job history itself is not changed');
});

test('signatures, live loop: a Gemini 3 key calls a tool → its signed parts come back unchanged in the next request → answer', async () => {
  gem3Id = await addKey({ name: 'Gemini 3', kind: 'gemini', model: 'gemini-3.6-flash', key: GEM3 });
  await order([gem3Id]);
  GEM.length = 0;
  const { job, answer } = await ask('please calculate six times seven');
  assert.equal(job.status, 'done', job.result);
  assert.match(answer, /Gemini: the calculator says .*42/);
  assert.equal(GEM.length, 2);
  const second = GEM[1].body.contents;
  const modelTurn = second.findLast(c => c.role === 'model' && c.parts.some(p => p.functionCall));
  assert.deepEqual(modelTurn.parts, [{ functionCall: { name: 'calculator', args: { expression: '6*7' } }, thoughtSignature: 'SIG_A_gemini-3.6-flash' }, { functionCall: { name: 'calculator', args: { expression: '1+1' } } }], 'exactly as Gemini returned them');
  assert.ok(!JSON.stringify(GEM[1].body).includes('skip_thought_signature_validator'), 'real signatures are never replaced');
  const fr = second.at(-1).parts.filter(p => p.functionResponse);
  assert.equal(fr.length, 2, 'all function calls first, then all their answers (in order)');
});

test('signatures, his case: step 1 answered by ANOTHER key (no signature), it gets busy, a Gemini 3 key takes over → no 400, job finishes', async () => {
  firstId = await addKey({ name: 'First', kind: 'openai', base_url: F + '/first/v1', model: 'm', key: FIRSTK });
  await order([firstId, gem3Id]);
  GEM.length = 0; FIRST.length = 0;
  const { job, answer } = await ask('please calculate six times seven');
  assert.equal(job.status, 'done', job.result);
  assert.match(answer, /Gemini: the calculator says .*42/, answer);
  assert.equal(FIRST.length, 2, 'the first key made the tool call, then was busy');
  assert.equal(GEM.length, 1, 'Gemini 3 accepted the job on its first try');
  const modelTurn = GEM[0].body.contents.findLast(c => c.role === 'model' && c.parts.some(p => p.functionCall));
  const fc = modelTurn.parts.find(p => p.functionCall);
  assert.equal(fc.thoughtSignature, 'skip_thought_signature_validator');
  assert.equal(fc.functionCall.name, 'calculator');
  // the same job with the 2.3.13 request (no stand-in) is what Google refused:
  const fakeOld = GEM[0].body.contents.map(c => ({ ...c, parts: c.parts.map(p => { const { thoughtSignature, ...rest } = p; return rest; }) }));
  assert.equal(missingSignature(fakeOld), true);
  await setActive([]);
});

test('signatures: an older Gemini model that still asks for one → one more try with the stand-in, then it answers', async () => {
  strictId = await addKey({ name: 'SoftTech device', kind: 'gemini', model: 'gemini-2.5-flash', key: GEMSTRICT });
  await order([firstId, strictId]);
  GEM.length = 0; FIRST.length = 0;
  const { job, answer } = await ask('please calculate six times seven');
  assert.equal(job.status, 'done', job.result);
  assert.match(answer, /Gemini: the calculator says/);
  assert.equal(GEM.length, 2, 'first try without (2.5 does not usually check), second with the stand-in');
  assert.ok(!JSON.stringify(GEM[0].body).includes('thoughtSignature'));
  assert.ok(JSON.stringify(GEM[1].body).includes('skip_thought_signature_validator'));
  assert.equal(aikeys.keyRow(strictId).problem, null);
  await setActive([]);
});

// ---------------- 2. Cloudflare chat body ----------------
test('Cloudflare body fits the model\'s published schema: tool calls, tool answers, pictures, no null content', () => {
  const decl = tools.declarations();
  const items = [{ role: 'user', text: 'old question' }, { role: 'assistant', text: 'old answer' },
    { role: 'user', text: 'look at this and calculate', media: [{ kind: 'image', mime: 'image/png', data: 'iVBORw0KGgo=' }] },
    { role: 'assistant', text: '', calls: [{ id: 'c1', name: 'calculator', args: { expression: '6*7' } }, { id: 'c2', name: 'web_search', args: { query: 'x' } }] },
    { role: 'tool', id: 'c1', name: 'calculator', result: { result: 42 } }, { role: 'tool', id: 'c2', name: 'web_search', result: { results: [] } }];
  const msgs = brain.toOpenAIMessages('You are his assistant.', items);
  // what 2.3.13 sent is exactly what Cloudflare refused
  const old = { messages: msgs, tools: decl.map(t => ({ type: 'function', function: t })), max_tokens: 4096 };
  assert.match(check(CHAT_SCHEMA, old).join(' '), /oneOf at '\/' not met, 0 matches/);
  for (const plain of [false, true]) {
    const body = cfchat.cfChatBody({ model: '@cf/openai/gpt-oss-120b', messages: msgs, tools: decl, plain });
    const { model, ...input } = body;
    assert.deepEqual(check(CHAT_SCHEMA, input), [], 'valid (plain=' + plain + ')');
    assert.ok(body.messages.every(m => typeof m.role === 'string' && typeof m.content === 'string'), 'every message: role + string content');
    if (plain) {
      assert.equal(body.tools, undefined);
      assert.ok(body.messages.every(m => ['system', 'user', 'assistant'].includes(m.role) && !m.tool_calls));
      assert.ok(body.messages.some(m => /I called the tool calculator/.test(m.content)) && body.messages.some(m => /Tool answer from calculator/.test(m.content)));
    } else {
      assert.equal(body.tools.length, decl.length);
      const a = body.messages.find(m => m.tool_calls); assert.equal(a.content, ''); assert.equal(a.tool_calls[0].function.arguments, '{"expression":"6*7"}');
      const t = body.messages.filter(m => m.role === 'tool'); assert.deepEqual(t.map(x => x.tool_call_id), ['c1', 'c2']); assert.ok(t.every(x => typeof x.content === 'string'));
    }
    assert.match(body.messages.find(m => /look at this/.test(m.content)).content, /a picture was attached here/);
  }
  // tool declarations missing a type or description still come out valid
  const odd = cfchat.cfTools([{ name: 'odd', parameters: { type: 'object', properties: { a: { enum: ['x', 'y'] }, b: { type: ['string', 'null'], description: 'B' }, c: { type: 'array', items: { type: 'string' } } }, required: ['a', 'zz'] } }, { name: 'none' }]);
  assert.deepEqual(check(CHAT_SCHEMA, { messages: [{ role: 'user', content: 'x' }], tools: odd }), []);
  assert.deepEqual(odd[0].function.parameters.required, ['a']);
  assert.deepEqual(odd[1].function.parameters, { type: 'object', properties: {} });
});

test('Cloudflare chat in the loop: tool call → tool answer, every request valid (none refused), answer from Cloudflare', async () => {
  cfId = (await call('/api/brain/keys', { name: 'Cloudflare key (abish)', kind: 'cloudflare', account_id: ACCT, model: '', key: TOK.good })).j.key.id;
  await call(`/api/brain/keys/${cfId}`, { use_for: ['chat', 'pictures', 'background'] });
  gemOutId = await addKey({ name: 'Gemini (main)', kind: 'gemini', key: GEMOUT });
  await order([gemOutId, cfId]);
  CF.CHAT.calls.length = 0; CF.CHAT.refused.length = 0;
  const { job, answer } = await ask('please calculate six times seven');
  assert.equal(job.status, 'done', job.result);
  assert.match(answer, /Cloudflare chat here: the calculator says .*42/);
  assert.equal(CF.CHAT.calls.length, 2); assert.deepEqual(CF.CHAT.refused, []);
  const c2 = CF.CHAT.calls[1].body;
  assert.equal(c2.messages.find(m => m.tool_calls).content, '');
  assert.ok(c2.tools.some(t => t.function.name === 'calculator'));
  assert.equal(c2.max_tokens, 4096);
});

test('Cloudflare says "Bad input" anyway → one more try as plain chat (no tools), which it answers', async () => {
  await order([cfId]);
  CF.CHAT.calls.length = 0; CF.CHAT.refused.length = 0; CF.CHAT.fail = 'badinput_tools';
  const { job, answer } = await ask('hello there');
  assert.equal(job.status, 'done', job.result);
  assert.match(answer, /Hello from Cloudflare chat/);
  assert.equal(CF.CHAT.calls.length, 2);
  assert.ok(CF.CHAT.calls[0].body.tools?.length, 'first with tools');
  assert.equal(CF.CHAT.calls[1].body.tools, undefined, 'then plain');
  assert.ok(CF.CHAT.calls[1].body.messages.every(m => ['system', 'user', 'assistant'].includes(m.role)));
});

test('a Cloudflare chat model that can\'t call tools (its Test said so) gets plain chat from the start', async () => {
  const c = JSON.parse(aikeys.keyRow(cfId).caps || 'null');
  if (c) db.run('UPDATE ai_keys SET caps=? WHERE id=?', JSON.stringify({ ...c, tools: false }), cfId);
  const k = aikeys.keyRow(cfId);
  const caps = aikeys.freshCaps(k);
  if (!caps) { // never tested here: make the caps the way a Test of a no-tools model leaves them
    const r = await call(`/api/brain/keys/${cfId}/test`, {});
    assert.equal(r.status, 200, r.text);
    db.run('UPDATE ai_keys SET caps=? WHERE id=?', JSON.stringify({ ...JSON.parse(aikeys.keyRow(cfId).caps), tools: false }), cfId);
  }
  assert.equal(aikeys.freshCaps(aikeys.keyRow(cfId)).tools, false);
  CF.CHAT.calls.length = 0; CF.CHAT.refused.length = 0;
  const { job } = await ask('hello again');
  assert.equal(job.status, 'done', job.result);
  assert.equal(CF.CHAT.calls.length, 1);
  assert.equal(CF.CHAT.calls[0].body.tools, undefined);
  assert.deepEqual(CF.CHAT.refused, []);
  await setActive([]);
});

// ---------------- 3. "Request too large" ----------------
test('413 / too large is its own kind (not a key failure); a normal per-minute 429 stays a rate limit', () => {
  const groq = 'Request too large for model `openai/gpt-oss-120b` in organization `org_01m66` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 12583, please reduce your message size and try again.';
  let c = aikeys.classify({ status: 413, text: JSON.stringify({ error: { message: groq, type: 'tokens', code: 'rate_limit_exceeded' } }), provider: 'openai' });
  assert.equal(c.kind, 'too_large'); assert.equal(c.limit, 8000); assert.equal(c.requested, 12583); assert.equal(c.until, 0); assert.equal(c.problem, undefined);
  assert.match(c.reason, /^request too large for this key's limit \(413\)/);
  c = aikeys.classify({ status: 429, text: JSON.stringify({ error: { message: 'Rate limit reached for model `x` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 300. Please try again in 2.25s.' } }), provider: 'openai' });
  assert.equal(c.kind, 'quota');
  c = aikeys.classify({ status: 400, text: JSON.stringify({ error: { message: "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens.", code: 'context_length_exceeded' } }), provider: 'openai' });
  assert.equal(c.kind, 'too_large'); assert.equal(c.limit, 32768);
  c = aikeys.classify({ status: 400, text: JSON.stringify({ error: { message: 'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).' } }), provider: 'gemini' });
  assert.equal(c.kind, 'too_large'); assert.equal(c.limit, 1048576);
  assert.equal(cfchat.cfChatFail(413, JSON.stringify({ success: false, errors: [{ code: 3007, message: 'Payload too large' }] })).kind, 'too_large');
  assert.equal(cfchat.cfChatFail(400, JSON.stringify({ success: false, errors: [{ code: 5006, message: "AiError: Bad input: Error: oneOf at '/' not met" }] })).badInput, true);
  // a free Groq key is known to be small; others only once they told us
  assert.equal(aikeys.sizeCap({ id: 99901, kind: 'openai', base_url: 'https://api.groq.com/openai/v1' }), 8000);
  assert.equal(aikeys.sizeCap({ id: 99902, kind: 'openai', base_url: 'https://openrouter.ai/api/v1' }), 0);
  assert.equal(aikeys.sizeCap({ id: 99903, kind: 'gemini' }), 0);
});

test('fitToSize: his message and this job\'s steps stay, tool calls keep their answers, used tools stay, it gets small', () => {
  const decl = tools.declarations();
  const big = 'x'.repeat(30000);
  const items = [];
  for (let i = 0; i < 8; i++) items.push({ role: 'user', text: 'old ' + i + ' ' + 'y'.repeat(1500) }, { role: 'assistant', text: 'old answer ' + i });
  items.push({ role: 'user', text: 'send an email to Moshe about the meeting' });
  items.push({ role: 'assistant', text: '', calls: [{ id: 'c1', name: 'gmail_search', args: { q: 'Moshe' } }] });
  items.push({ role: 'tool', id: 'c1', name: 'gmail_search', result: { mails: big } });
  const args = { system: brain.systemPrompt('web'), items, tools: decl };
  const before = brain.estimateTokens({ s: args.system, i: items, t: decl });
  assert.ok(before > 15000, 'the full request is big: ' + before);
  const f = brain.fitToSize(args, 8000);
  assert.equal(f.trimmed, true);
  assert.ok(f.est + f.maxOut <= 8000 * 0.9, `fits: ${f.est} + ${f.maxOut}`);
  const its = f.args.items;
  assert.equal(its[0].role, 'user');
  assert.ok(its.some(x => x.text === 'send an email to Moshe about the meeting'), 'his current message stays');
  assert.ok(its.some(x => x.calls?.[0]?.id === 'c1') && its.some(x => x.role === 'tool' && x.id === 'c1'), 'the tool call keeps its answer');
  assert.ok(JSON.stringify(its.find(x => x.role === 'tool').result).length < 3000, 'long tool answer shortened');
  const names = f.args.tools.map(t => t.name);
  assert.ok(names.includes('gmail_search'), 'a tool this job used stays');
  assert.ok(names.includes('gmail_send') || names.includes('gmail_draft'), 'tools his words point at come first: ' + names.join(','));
  assert.ok(names.length < decl.length);
  assert.equal(items.length, 19, 'the job\'s own history is not changed');
  const small = brain.fitToSize({ system: 's', items: [{ role: 'user', text: 'hi' }], tools: [] }, 8000);
  assert.equal(small.trimmed, false, 'a request that already fits is left alone');
});

test('413 in the loop: the small key gets ONE smaller request on the same key and answers; its limit is remembered; not a key failure', async () => {
  smallId = await addKey({ name: 'Second provider', kind: 'openai', base_url: F + '/small/v1', model: 'openai/gpt-oss-120b', key: SMALLK });
  otherId = await addKey({ name: 'OpenRouter', kind: 'openai', base_url: F + '/other/v1', model: 'm', key: OTHERK });
  await order([smallId, otherId]);
  SMALL.length = 0; OTHER.length = 0;
  const { job, answer } = await ask('what is on my list today?');
  assert.equal(job.status, 'done', job.result);
  assert.match(answer, /^Small key answer/, answer);
  assert.equal(SMALL.length, 2, 'too large once, then the smaller request');
  assert.ok(SMALL[0].requested > SMALL_LIMIT && SMALL[1].requested <= SMALL_LIMIT, `${SMALL[0].requested} → ${SMALL[1].requested}`);
  assert.ok(SMALL[1].body.tools.length < SMALL[0].body.tools.length, 'fewer tools');
  assert.ok(SMALL[1].body.max_tokens > 0, 'the answer length is capped too (the limit counts it)');
  assert.equal(OTHER.length, 0, 'no need for the next key');
  assert.equal(db.setting('ai_key_limit_' + smallId), '8000');
  const k = aikeys.keyRow(smallId); assert.equal(k.problem, null); assert.equal(k.cool_until, 0);
  // next time it starts small: one request only
  SMALL.length = 0;
  const again = await ask('and tomorrow?');
  assert.match(again.answer, /^Small key answer/);
  assert.equal(SMALL.length, 1);
  assert.ok(SMALL[0].requested <= SMALL_LIMIT);
});

test('413 even after making it smaller → the next key answers; the reason says so; the key is not marked broken', async () => {
  db.setSetting('ai_key_limit_' + smallId, '');
  const huge = 'ALWAYS413 please read this';          // this fake key refuses it at any size
  SMALL.length = 0; OTHER.length = 0;
  const { job, answer } = await ask(huge);
  assert.equal(job.status, 'done', job.result);
  assert.equal(answer, 'Answer from the other key.');
  assert.equal(SMALL.length, 2);
  assert.equal(OTHER.length, 1);
  const k = aikeys.keyRow(smallId);
  assert.match(k.last_error, /request too large for this key's limit \(413\).*\(also after making the request smaller\)/);
  assert.equal(k.problem, null); assert.equal(k.cool_until, 0);
  await setActive([]);
});

test('the final message when nothing answers is unchanged, and no key ever reaches a log, the audit or a page', async () => {
  await order([smallId]);
  db.setSetting('ai_key_limit_' + smallId, '');
  const { job } = await ask('ALWAYS413 again');
  assert.equal(job.status, 'error');
  assert.match(job.result, /^I couldn't get an answer from any of your AI keys:\n• Second provider: request too large for this key's limit \(413\)/);
  assert.match(job.result, /Fix or add one in Settings → Brain \(AI model\) → AI keys\.$/);
  const all = LOGS.join('\n') + RAW.join('\n') + JSON.stringify(db.all('SELECT * FROM audit')) + JSON.stringify(db.all('SELECT * FROM job_events'));
  for (const k of [GEM3, GEMSTRICT, GEMOUT, SMALLK, OTHERK, FIRSTK, ...Object.values(TOK)]) assert.ok(!all.includes(k), 'a key leaked');
});
