// 2.3.18 (Abish, Nov 8 2026 2:12–2:20 AM, WhatsApp screenshot):
// (1) the 2nd key failed with "error 400: Tool call validation failed: tool call validation failed: attempted to call
//     tool 'file_write' which was not in request.tools" — a small-limit key was sent a cut-down tool list (publish_site
//     and sites_list, no file_write) while the conversation was about building his page. Every round now carries the
//     whole tool family and the tools it already got; the 400 gets one more try on the same key with the tool.
// (2) "A designed page similar to my current site" → "Could you share the URL of your current site…?" although he had
//     asked for that page at 1:22 AM and its project existed. Each request now carries his projects/sites and earlier
//     asks (in the system prompt, never cut) and a rule to look before asking.
// (3) when no key answers at all, the key report stays word for word plus one line, and the request is tried again
//     when a key is back, then answered normally.
// Against a fake OpenAI-compatible API (it answers like the small free key does) — not his server or a real AI key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const LOGS = [];
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { LOGS.push(a.map(String).join(' ')); if (process.env.SHOW_LOGS) orig(...a); }; }
// his exact error, as that key's API sends it
const TOOL_400 = (name) => ({ error: { message: `Tool call validation failed: tool call validation failed: attempted to call tool '${name}' which was not in request.tools`, type: 'invalid_request_error', code: 'tool_use_failed' } });
const PROJECT = 'soft-tech-private-7f9a3';

// ---- fake API: /s = the 2nd key (gpt-oss style, validates tool calls against request.tools), /n = the next key
const CALLS = { s: [], n: [] }; const MODE = { s: 'build', n: 'ok' };
const fake = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const J = (o, st = 200, h = {}) => { res.writeHead(st, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
  const who = req.url.startsWith('/s/') ? 's' : req.url.startsWith('/n/') ? 'n' : null;
  if (!who || !req.url.endsWith('/chat/completions')) return J({ error: { message: 'no route' } }, 404);
  const body = JSON.parse(raw); CALLS[who].push(body);
  const names = (body.tools || []).map(t => t.function.name);
  const all = JSON.stringify(body.messages);
  const mode = MODE[who];
  const say = (content) => J({ choices: [{ message: { role: 'assistant', content } }] });
  const call = (name, args) => body.tool_choice === 'none' ? say('Stopping here: the page is written.')
    : names.includes(name)
    ? J({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c' + CALLS[who].length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
    : J(TOOL_400(name), 400);                                 // like the real key: a call to a tool the request did not carry
  if (mode === 'limit') return J({ error: { message: 'Rate limit reached for model on tokens per day (TPD): Limit 200000, Used 199990. Please try again in 31m0s.' } }, 429, { 'retry-after': '1860' });
  if (mode === 'ok') return say('Hello from the next key.');
  if (mode === 'persist400') return J(TOOL_400('file_write'), 400);
  if (mode === 'first400' && CALLS[who].length === 1) return J(TOOL_400('file_write'), 400);
  if (mode === 'ghost400' && !body.tool_choice) return J(TOOL_400('launch_rockets'), 400);
  if (mode === 'ghost400') return say('I made the page and will send a picture next.');
  const toolsDone = body.messages.filter(m => m.role === 'tool').length;
  if (mode === 'resolve') {             // bug 2: does the request know which site he means?
    if (!all.includes(PROJECT)) return say('Could you share the URL of your current site so I can match its design?');
    if (toolsDone === 0) return call('file_read', { project: PROJECT, path: 'index.html' });
    if (toolsDone === 1) return call('file_write', { project: PROJECT, path: 'private.html', content: '<!doctype html><title>Private</title><a href="https://soft-tech.net">Go back to site</a>' });
    return say(`Made the private page in ${PROJECT}, in the same style as your site.`);
  }
  // build / first400: write the page, then (round 2) write once more, then answer
  if (toolsDone === 0) return call('file_write', { project: PROJECT, path: 'index.html', content: '<h1>Private</h1>' });
  if (toolsDone === 1) return call('file_write', { project: PROJECT, path: 'logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
  return say('Page and logo are done.');
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const F = 'http://127.0.0.1:' + fake.address().port;

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v2318-'));
Object.assign(process.env, { MA_DATA_DIR: T, MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/s', MA_SANDBOX_USER: '', MA_PUBLIC_URL: 'https://example.test' });
const { loadMasterKey } = await import('../src/crypto.js');
const db = await import('../src/db.js');
loadMasterKey(T); db.openDb();
const approvals = await import('../src/approvals.js'); const tools = await import('../src/tools/index.js'); approvals.bindTools(tools);
const brain = await import('../src/brain.js');
const aikeys = await import('../src/aikeys.js');
const notify = await import('../src/notify.js');
const wait = async (id) => { for (let i = 0; i < 300; i++) { const j = db.get('SELECT * FROM jobs WHERE id=?', id); if (['done', 'error'].includes(j.status)) return j; await new Promise(r => setTimeout(r, 50)); } throw new Error('timeout'); };
test.after(() => { fake.close(); fs.rmSync(T, { recursive: true, force: true }); });
db.setSetting('batch_wait_ms', '0');
const keyS = () => { const k = aikeys.addKey({ name: 'Second', kind: 'openai', base_url: F + '/s/v1', model: 'openai/gpt-oss-120b', key: 'fake-second-key-0001' }); aikeys.learnSizeCap(k.id, 8000); return k; };
const keyN = () => aikeys.addKey({ name: 'abish', kind: 'openai', base_url: F + '/n/v1', model: 'm', key: 'fake-next-key-0002' });
const reset = () => { CALLS.s.length = 0; CALLS.n.length = 0; for (const k of aikeys.listRows()) aikeys.removeKey(k.id); db.run('DELETE FROM key_retries'); };
const namesOf = (b) => (b.tools || []).map(t => t.function.name);

// ---------------- 1: the tools the 2nd key gets ----------------
test('1: root cause — his words cut the tool list for the small key to publish/sites tools without file_write (2.3.17); now the whole family goes', () => {
  const all = tools.declarations({});
  const f = brain.fitToSize({ system: brain.systemPrompt('whatsapp_agent'), items: [{ role: 'user', text: 'A designed page similar to my current site' }], tools: all }, 8000);
  const n = f.args.tools.map(t => t.name);
  for (const t of ['file_write', 'file_read', 'file_list', 'project_list', 'site_screenshot', 'publish_site', 'sites_list']) assert.ok(n.includes(t), t);
  assert.ok(f.est <= 8000 * 0.9, 'still fits the key');
  // tools the earlier steps already got are never dropped, also when the request is squeezed harder
  const keep = new Set(['ssh_run', 'gmail_search'].filter(x => all.some(t => t.name === x)));
  const g = brain.fitToSize({ system: 'x', items: [{ role: 'user', text: 'hi' }], tools: all }, 3000, { force: true, keep });
  for (const k of keep) assert.ok(g.args.tools.some(t => t.name === k), k);
  // a tool name written in the history (e.g. a step summary) counts as in use
  const h = brain.fitToSize({ system: 'x', items: [{ role: 'user', text: 'earlier you ran video_make for me' }, { role: 'assistant', text: 'ok' }, { role: 'user', text: 'again please' }], tools: all }, 8000, { force: true });
  assert.ok(h.args.tools.some(t => t.name === 'video_make'));
});
test('1: his exact 400 is read as "called a tool the request did not carry" (about the request, not the key)', () => {
  const c = aikeys.classify({ status: 400, text: JSON.stringify(TOOL_400('file_write')), provider: 'openai' });
  assert.equal(c.kind, 'tool_missing'); assert.equal(c.tool, 'file_write'); assert.equal(c.until, 0);
  assert.match(c.reason, /^error 400: Tool call validation failed/);
  assert.equal(aikeys.classify({ status: 400, text: '{"error":{"message":"bad"}}', provider: 'openai' }).kind, 'other');
});
test('1 (adapter): building his page on the small key — every round carries file_write and the same tools; no 400', async () => {
  reset(); const s = keyS(); MODE.s = 'build';
  const j = await wait(brain.startJob({ text: 'A designed page similar to my current site', channel: 'web' }));
  assert.equal(j.status, 'done', j.result);
  assert.equal(j.result, 'Page and logo are done.');
  assert.equal(CALLS.s.length, 3);
  let prev = null;
  for (const b of CALLS.s) {
    const n = namesOf(b); assert.ok(n.includes('file_write'));
    if (prev) for (const x of prev) assert.ok(n.includes(x), `round dropped ${x}`);
    prev = n;
  }
  assert.ok(fs.existsSync(path.join(T, 'ws', PROJECT, 'logo.svg')));
  assert.equal(CALLS.n.length, 0);
  aikeys.removeKey(s.id);
});
test('1 (adapter): the last round ("stop calling tools") still carries the tools, with tool_choice "none"', async () => {
  reset(); const s = keyS(); MODE.s = 'build'; db.setSetting('max_steps', '1');
  try {
    const j = await wait(brain.startJob({ text: 'make the private page', channel: 'web' }));
    assert.equal(CALLS.s.length, 2, j.result + ' ' + JSON.stringify(CALLS.s.map(b => [b.tool_choice, namesOf(b).includes('file_write'), b.messages.length, String(b.messages.at(-1).content).slice(0, 80)])));
    assert.ok(namesOf(CALLS.s[1]).includes('file_write'), 'tools still sent');
    assert.equal(CALLS.s[1].tool_choice, 'none');
    assert.equal(CALLS.s[0].tool_choice, undefined);
  } finally { db.setSetting('max_steps', '40'); aikeys.removeKey(s.id); }
});
test('1 (adapter): if the 400 happens anyway → one more try on the SAME key with that tool, before the next key', async () => {
  reset(); const s = keyS(); const n = keyN(); MODE.s = 'first400';
  // make the first request lack file_write on purpose: his words point elsewhere and the key is tiny
  const j = await wait(brain.startJob({ text: 'what is the weather', channel: 'web' }));
  assert.equal(j.status, 'done', j.result);
  assert.ok(!namesOf(CALLS.s[0]).includes('file_write'), 'first request lacked it: ' + namesOf(CALLS.s[0]).join(','));
  assert.equal(CALLS.n.length, 0, 'the next key was not needed');
  assert.ok(namesOf(CALLS.s[1]).includes('file_write'), 'the retry carried the tool it called');
  assert.ok(db.all("SELECT detail FROM audit WHERE action='brain.tool_missing'").length >= 1);
  assert.ok(LOGS.some(l => /called tool "file_write" that was not in its request; one more try with it/.test(l)));
  aikeys.removeKey(s.id); aikeys.removeKey(n.id);
});
test('1 (adapter): a tool that does not exist → one more try asking for words only (tool_choice "none")', async () => {
  reset(); const s = keyS(); MODE.s = 'ghost400';
  const j = await wait(brain.startJob({ text: 'make my page', channel: 'web' }));
  assert.equal(j.status, 'done', j.result);
  assert.equal(CALLS.s.length, 2);
  assert.equal(CALLS.s[1].tool_choice, 'none');
  assert.ok(namesOf(CALLS.s[1]).length > 0, 'tools still listed');
  assert.match(JSON.stringify(CALLS.s[1].messages.at(-1)), /plain words/);
  assert.equal(j.result, 'I made the page and will send a picture next.');
  aikeys.removeKey(s.id);
});
test('1 (adapter): the 400 again after the retry → the next key answers (no endless loop)', async () => {
  reset(); const s = keyS(); const n = keyN(); MODE.s = 'persist400'; MODE.n = 'ok';
  const j = await wait(brain.startJob({ text: 'hi', channel: 'web' }));
  assert.equal(j.result, 'Hello from the next key.');
  assert.equal(CALLS.s.length, 2); assert.equal(CALLS.n.length, 1);
  aikeys.removeKey(s.id); aikeys.removeKey(n.id);
});

// ---------------- 2: "my current site" ----------------
function seedChat() {
  db.run('DELETE FROM messages'); db.run('DELETE FROM memory');
  fs.mkdirSync(path.join(T, 'ws', PROJECT), { recursive: true });
  fs.writeFileSync(path.join(T, 'ws', PROJECT, 'index.html'), '<!doctype html><html><head><style>body{background:#0b1f3a;color:#fff}</style></head><body><h1>SoftTech</h1></body></html>');
  fs.mkdirSync(path.join(T, 's', PROJECT), { recursive: true }); fs.writeFileSync(path.join(T, 's', PROJECT, 'index.html'), '<h1>SoftTech</h1>');
  db.run('INSERT INTO memory(ts,fact) VALUES(?,?)', Date.now(), 'His main website is soft-tech.net');
  const t0 = Date.now() - 50 * 60000;
  const add = (role, text, dt) => { const id = notify.addMessage(role, 'whatsapp_agent', text); db.run('UPDATE messages SET ts=? WHERE id=?', t0 + dt, id); };
  add('owner', 'I need a designed html page that this site is a privet site and add a go back to site button', 0);
  add('assistant', 'Here is the page. Reply YES to publish.', 60000);
  add('owner', 'Yes', 120000);
  for (let i = 0; i < 8; i++) { add('owner', `Small question ${i} about the weather today`, 200000 + i * 60000); add('assistant', `Answer ${i}`, 230000 + i * 60000); }
}
test('2: a follow-up about "my current site" is resolved from his projects + earlier ask — no "share the URL" question (small key, short history)', async () => {
  reset(); seedChat(); db.setSetting('history_messages', '4');
  const s = keyS(); MODE.s = 'resolve';
  try {
    const j = await wait(brain.startJob({ text: 'A designed page similar to my current site', channel: 'whatsapp_agent' }));
    assert.equal(j.status, 'done', j.result + ' | ' + CALLS.s.length);
    assert.doesNotMatch(j.result, /share the URL|which site|what is the (url|address)/i);
    assert.match(j.result, new RegExp(PROJECT));
    const sys = CALLS.s[0].messages[0].content;
    assert.match(sys, /His projects and sites \(newest first/);
    assert.match(sys, new RegExp(PROJECT + '.*published at https://example.test/sites/' + PROJECT));
    assert.match(sys, /His earlier requests in this chat[^]*privet site and add a go back to site button/);
    assert.match(sys, /soft-tech\.net/, 'his memory');
    assert.match(sys, /never ask for a URL or a name that is already here/);
    assert.ok(fs.existsSync(path.join(T, 'ws', PROJECT, 'private.html')));
  } finally { db.setSetting('history_messages', '16'); aikeys.removeKey(s.id); }
});
test('2: the same follow-up on 2.3.17 behaviour (no card) would have asked — the fake really asks without it', async () => {
  // proves the fake model is a fair judge: with no project name anywhere it asks for the URL
  reset(); db.run('DELETE FROM messages');
  const keep = fs.readdirSync(path.join(T, 'ws')); for (const d of keep) fs.renameSync(path.join(T, 'ws', d), path.join(T, 'x-' + d));
  const keepS = fs.readdirSync(path.join(T, 's')); for (const d of keepS) fs.renameSync(path.join(T, 's', d), path.join(T, 'y-' + d));
  const s = keyS(); MODE.s = 'resolve';
  try {
    const j = await wait(brain.startJob({ text: 'A designed page similar to my current site', channel: 'web' }));
    assert.match(j.result, /share the URL/);
  } finally {
    for (const d of keep) fs.renameSync(path.join(T, 'x-' + d), path.join(T, 'ws', d));
    for (const d of keepS) fs.renameSync(path.join(T, 'y-' + d), path.join(T, 's', d));
    aikeys.removeKey(s.id);
  }
});
test('2: earlier asks only list his words older than the history it gets; bare yes/ok are left out', () => {
  seedChat();
  const chat = db.get('SELECT chat_id FROM messages ORDER BY id DESC LIMIT 1').chat_id;
  const last = db.get('SELECT MAX(id) AS m FROM messages').m;
  const asks = brain.earlierAsks(chat, last - 3);
  assert.ok(asks.some(a => /privet site/.test(a.text)));
  assert.ok(!asks.some(a => /^Yes$/.test(a.text)));
  assert.ok(asks.length <= 5);
  const k = brain.knownContext({ chatId: chat, firstHistoryId: last - 3 }).join('\n');
  assert.match(k, new RegExp(PROJECT));
});
test('2: when a small key has to drop old history, his newest dropped words stay as one short line', () => {
  const items = [];
  items.push({ role: 'user', text: 'I need a designed html page that this site is a privet site and add a go back to site button' }, { role: 'assistant', text: 'x'.repeat(9000) });
  for (let i = 0; i < 6; i++) items.push({ role: 'user', text: 'filler ' + 'y'.repeat(3000) }, { role: 'assistant', text: 'z'.repeat(3000) });
  items.push({ role: 'user', text: 'A designed page similar to my current site' });
  const f = brain.fitToSize({ system: 's', items, tools: [] }, 4000);
  assert.ok(f.trimmed);
  assert.ok(f.args.items[0].text.includes('Earlier'), JSON.stringify(f.args.items.map(i => [i.role, String(i.text).slice(0, 60)])));
  assert.match(f.args.items[0].text, /Earlier in this chat he said[^]*privet site/);
  assert.equal(f.args.items.at(-1).text, 'A designed page similar to my current site');
});
test('2: the WhatsApp chat keeps the last messages across jobs (history of the same chat)', async () => {
  reset(); db.run('DELETE FROM messages');
  const n = keyN(); MODE.n = 'ok';
  await wait(brain.startJob({ text: 'first ask: make a private page for soft-tech', channel: 'whatsapp_agent' }));
  await wait(brain.startJob({ text: 'second ask: and add a button', channel: 'whatsapp_agent' }));
  const lastBody = JSON.stringify(CALLS.n.at(-1).messages);
  assert.match(lastBody, /first ask: make a private page for soft-tech/);
  assert.match(lastBody, /Hello from the next key/);
  aikeys.removeKey(n.id);
});

// ---------------- 3: no key answers → saved, tried again ----------------
test('3a: every key fails → the key report is unchanged plus ONE line, the request is saved; a later try answers him normally', async () => {
  reset(); db.run('DELETE FROM messages');
  const s = keyS(); const n = keyN(); MODE.s = 'limit'; MODE.n = 'limit';
  const j = await wait(brain.startJob({ text: 'A designed page similar to my current site', channel: 'web' }));
  assert.equal(j.status, 'error');
  const lines = j.result.split('\n');
  assert.equal(lines.at(-1), 'I saved your request and will try again when a key is back.');
  // the report itself: exactly the 2.3.17 format (same first line, one bullet per key with its label, same last line)
  assert.equal(lines[0], "I couldn't get an answer from any of your AI keys:");
  assert.match(lines[1], /^• Second: rate limit reached \(429\) for today — until ~/);
  assert.match(lines[2], /^• abish: rate limit reached \(429\) for today — until ~/);
  assert.equal(lines[3], 'Fix or add one in Settings → Brain (AI model) → AI keys.');
  assert.equal(lines.length, 5);
  assert.equal(db.all("SELECT * FROM messages WHERE role='assistant'").filter(m => /saved your request/.test(m.text)).length, 1);
  const row = db.get("SELECT * FROM key_retries WHERE status='waiting'");
  assert.ok(row, 'saved');
  assert.ok(row.next_try - Date.now() <= 15 * 60000 + 1000, 'tried again within 15 min (the key said ~31 min)');
  // a try while nothing is free yet: nothing is sent, still waiting
  db.run('UPDATE key_retries SET next_try=0');
  assert.equal(brain.retryWaiting(), 0);
  assert.equal(db.get('SELECT status FROM key_retries WHERE id=?', row.id).status, 'waiting');
  // a try that still gets no answer (keys look free but fail): quiet, still waiting
  db.run('UPDATE ai_keys SET cool_until=0'); db.run('UPDATE key_retries SET next_try=0');
  const before = db.all("SELECT id FROM messages WHERE role='assistant'").length;
  assert.equal(brain.retryWaiting(), 1);
  const j2 = await wait(db.get('SELECT last_job FROM key_retries WHERE id=?', row.id).last_job);
  assert.equal(j2.status, 'error');
  assert.equal(db.all("SELECT id FROM messages WHERE role='assistant'").length, before, 'no second report');
  assert.equal(db.get('SELECT status FROM key_retries WHERE id=?', row.id).status, 'waiting');
  // the key is back → the saved request runs and he gets the normal answer, his message is not stored twice
  MODE.n = 'ok'; db.run('UPDATE ai_keys SET cool_until=0'); db.run('UPDATE key_retries SET next_try=0');
  assert.equal(brain.retryWaiting(), 1);
  const j3 = await wait(db.get('SELECT last_job FROM key_retries WHERE id=?', row.id).last_job);
  assert.equal(j3.status, 'done', j3.result);
  assert.equal(j3.result, 'Hello from the next key.');
  assert.equal(db.get('SELECT status FROM key_retries WHERE id=?', row.id).status, 'done');
  assert.equal(db.all("SELECT * FROM messages WHERE role='owner' AND text='A designed page similar to my current site'").length, 1);
  assert.ok(db.all("SELECT text FROM messages WHERE role='assistant'").some(m => m.text === 'Hello from the next key.'));
  assert.match(JSON.stringify(CALLS.n.at(-1).messages), /A designed page similar to my current site/);
  aikeys.removeKey(s.id); aikeys.removeKey(n.id);
});
test('3b: one key works → answered, nothing saved', async () => {
  reset(); const s = keyS(); const n = keyN(); MODE.s = 'limit'; MODE.n = 'ok';
  const j = await wait(brain.startJob({ text: 'hello', channel: 'web' }));
  assert.equal(j.result, 'Hello from the next key.');
  assert.equal(db.all('SELECT * FROM key_retries').length, 0);
  aikeys.removeKey(s.id); aikeys.removeKey(n.id);
});
test('3: tries again when the first key is back (or every 15 min), stops after 24 h', () => {
  const t = 1_000_000_000_000;
  assert.equal(brain.nextTryAt(t + 5 * 60000, t), t + 5 * 60000 + 30000);
  assert.equal(brain.nextTryAt(t + 3 * 3600000, t), t + 15 * 60000);
  assert.equal(brain.nextTryAt(0, t), t + 15 * 60000);
  assert.equal(brain.nextTryAt(t + 1000, t), t + 60000);
  db.run("INSERT INTO key_retries(job_id,chat_id,channel,msg_ids,created,next_try,status) VALUES(1,1,'web','[]',?,0,'waiting')", Date.now() - 25 * 3600000);
  brain.retryWaiting();
  assert.equal(db.get('SELECT status FROM key_retries ORDER BY id DESC LIMIT 1').status, 'given_up');
});
