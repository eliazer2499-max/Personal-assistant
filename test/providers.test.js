// The real Gemini and OpenAI-compatible adapters, against fake HTTP endpoints shaped like the real APIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const bodies = [];
const fake = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const J = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url.startsWith('/v1beta/models?')) return J({ models: [{ name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] });
  if (req.url.includes('gemini-old-gone')) return J({ error: { message: 'not found' } }, 404);
  if (req.url.includes(':generateContent')) {
    const j = JSON.parse(b); bodies.push({ url: req.url, key: req.headers['x-goog-api-key'], body: j });
    const last = j.contents.at(-1).parts[0];
    if (last.functionResponse) return J({ candidates: [{ content: { role: 'model', parts: [{ text: 'thinking', thought: true }, { text: 'It is ' + last.functionResponse.response.result.result }] }, finishReason: 'STOP' }] });
    return J({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'calculator', args: { expression: '6*7' } }, thoughtSignature: 'SIG123' }] }, finishReason: 'STOP' }] });
  }
  if (req.url === '/v1/chat/completions') {
    const j = JSON.parse(b); bodies.push({ url: req.url, auth: req.headers.authorization, body: j });
    const last = j.messages.at(-1);
    if (last.role === 'tool') return J({ choices: [{ message: { role: 'assistant', content: 'Answer ' + JSON.parse(last.content).result } }] });
    return J({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"2^5"}' } }] } }] });
  }
  J({}, 404);
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const F = 'http://127.0.0.1:' + fake.address().port;
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-prov-'));
Object.assign(process.env, { MA_DATA_DIR: T, MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/s', MA_GEMINI_BASE: F, MA_SANDBOX_USER: '' });
const { loadMasterKey } = await import('../src/crypto.js');
const db = await import('../src/db.js');
loadMasterKey(T); db.openDb();
const approvals = await import('../src/approvals.js'); const tools = await import('../src/tools/index.js'); approvals.bindTools(tools);
const { startJob } = await import('../src/brain.js');
const wait = async (id) => { for (let i = 0; i < 100; i++) { const j = db.get('SELECT * FROM jobs WHERE id=?', id); if (['done', 'error'].includes(j.status)) return j; await new Promise(r => setTimeout(r, 50)); } throw new Error('timeout'); };
test.after(() => { fake.close(); fs.rmSync(T, { recursive: true, force: true }); });

test('Gemini: function calling round trip keeps the thought signature; key in header only', async () => {
  db.setSecret('gemini_api_key', 'AIzaFAKEKEYFORTESTS000000000');
  const j = await wait(startJob({ text: 'what is 6*7?', channel: 'web' }));
  assert.equal(j.status, 'done'); assert.equal(j.result, 'It is 42');
  assert.equal(bodies.length, 2);
  assert.match(bodies[0].url, /gemini-3\.6-flash:generateContent$/);
  assert.equal(bodies[0].key, 'AIzaFAKEKEYFORTESTS000000000');
  assert.ok(!bodies[0].url.includes('AIza'));
  const decl = bodies[0].body.tools[0].functionDeclarations.find(d => d.name === 'gmail_send');
  assert.equal(decl.parameters.type, 'OBJECT'); assert.equal(decl.parameters.properties.to.type, 'STRING');
  const second = bodies[1].body.contents;
  const modelTurn = second.find(c => c.role === 'model' && c.parts.some(p => p.functionCall));
  assert.equal(modelTurn.parts[0].thoughtSignature, 'SIG123');
  assert.ok(second.at(-1).parts[0].functionResponse);
});
test('Gemini: a retired model name falls back to the newest listed flash model', async () => {
  db.setSetting('model', 'gemini-old-gone'); bodies.length = 0;
  const j = await wait(startJob({ text: 'hi', channel: 'web' }));
  assert.equal(j.status, 'done');
  assert.match(bodies[0].url, /gemini-3\.8-flash/);
  db.setSetting('model', 'gemini-3.6-flash');
});
test('OpenAI-compatible second provider with tool calls', async () => {
  db.setSetting('provider', 'openai'); db.setSetting('openai_base_url', F + '/v1'); db.setSetting('openai_model', 'test-model'); db.setSecret('openai_api_key', 'sk-testkey1234567890123456');
  bodies.length = 0;
  const j = await wait(startJob({ text: '2^5?', channel: 'web' }));
  assert.equal(j.result, 'Answer 32');
  assert.equal(bodies[1].body.messages.at(-1).tool_call_id, 'call_1');
  assert.equal(bodies[0].auth, 'Bearer sk-testkey1234567890123456');
  db.setSetting('provider', 'gemini');
});
