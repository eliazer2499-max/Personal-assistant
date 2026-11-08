// 2.3.17 (Abish, Nov 8 2026 1:26 AM, WhatsApp screenshot), part 2:
// (D) his chat got the literal text `<|start|>assistant to=functions web searchcommentary json{" query":" SoftTech logo
//     png site:github.com soft-tech.net"}<|call|>` — a key's tool call written as harmony text. It is now read back into
//     a real tool call and run; text that can't be read gets one more try on the same key, then the next key; and the
//     send step never lets such text out on any channel.
// (E) "a designed html page … add a go back to site button" came out as a broken "Logo" picture and "Private Link" on
//     white. site_screenshot / publish_site now find broken, missing and hot-linked pictures before he sees anything,
//     a logo is never searched for on the web, and the prompt says what "designed" means.
// Against fakes (a fake OpenAI-compatible API, local files) — not his server or a real AI key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const LOGS = [];
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { LOGS.push(a.map(String).join(' ')); if (process.env.SHOW_LOGS) orig(...a); }; }
const LEAK = '<|start|>assistant to=functions web searchcommentary json{" query":" SoftTech logo png site:github.com soft-tech.net"}<|call|>';
const MARKERS = /<\||\|>|to=functions|commentary json/i;

// ---- a fake OpenAI-compatible API with two keys: "/a" (the 2nd key, gpt-oss style) and "/b"
const CALLS = { a: [], b: [] }; let modeA = 'leak';
const fake = http.createServer(async (req, res) => {
  let s = ''; for await (const c of req) s += c;
  const J = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const who = req.url.startsWith('/a/') ? 'a' : req.url.startsWith('/b/') ? 'b' : null;
  if (!who || !req.url.endsWith('/chat/completions')) return J({ error: { message: 'no route' } }, 404);
  const body = JSON.parse(s); CALLS[who].push(body);
  const last = body.messages.at(-1);
  const say = (content) => J({ choices: [{ message: { role: 'assistant', content } }] });
  if (who === 'b') return say('Hello from the next key.');
  if (last.role === 'tool') return say('I will make the logo myself as logo.svg.');
  if (modeA === 'leak') return say(LEAK);
  if (modeA === 'canonical') return say('<|start|>assistant<|channel|>commentary to=functions.calculator <|constrain|>json<|message|>{"expression":"6*7"}<|call|>');
  return say('<|start|>assistant to=functions.web_search json{"query": broken<|call|>');     // can't be read
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const F = 'http://127.0.0.1:' + fake.address().port;

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v2317b-'));
Object.assign(process.env, { MA_DATA_DIR: T, MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/s', MA_SANDBOX_USER: '', MA_PUBLIC_URL: 'https://example.test' });
const { loadMasterKey } = await import('../src/crypto.js');
const db = await import('../src/db.js');
loadMasterKey(T); db.openDb();
const approvals = await import('../src/approvals.js'); const tools = await import('../src/tools/index.js'); approvals.bindTools(tools);
const brain = await import('../src/brain.js');
const aikeys = await import('../src/aikeys.js');
const { parseHarmony, hasHarmony, withoutHarmony, toolNameFor } = await import('../src/harmony.js');
const { guardOut } = await import('../src/outguard.js');
const notify = await import('../src/notify.js');
const sitecheck = await import('../src/tools/sitecheck.js');
const basic = await import('../src/tools/basic.js');
const wait = async (id) => { for (let i = 0; i < 200; i++) { const j = db.get('SELECT * FROM jobs WHERE id=?', id); if (['done', 'error'].includes(j.status)) return j; await new Promise(r => setTimeout(r, 50)); } throw new Error('timeout'); };
test.after(() => { fake.close(); fs.rmSync(T, { recursive: true, force: true }); });
const NAMES = ['web_search', 'web_fetch', 'file_write', 'site_screenshot', 'publish_site', 'calculator'];

// ---------------- D: harmony text ----------------
test('D: his exact leaked text is read back into a real web_search call (name with a space, keys with spaces)', () => {
  assert.equal(hasHarmony(LEAK), true);
  const h = parseHarmony(LEAK, NAMES);
  assert.equal(h.found, true);
  assert.deepEqual(h.calls, [{ name: 'web_search', args: { query: 'SoftTech logo png site:github.com soft-tech.net' } }]);
  assert.equal(h.text, '');
});
test('D: variants — canonical harmony, stripped tokens, browser.search, words around a call, final channel, unknown tool, broken JSON', () => {
  const canon = parseHarmony('<|start|>assistant<|channel|>commentary to=functions.web_search <|constrain|>json<|message|>{"query":"SoftTech"}<|call|>', NAMES);
  assert.deepEqual(canon.calls, [{ name: 'web_search', args: { query: 'SoftTech' } }]); assert.equal(canon.text, '');
  const bare = parseHarmony('assistant to=functions.web_fetch commentary json{"url":"https://x.test"}', NAMES);
  assert.deepEqual(bare.calls, [{ name: 'web_fetch', args: { url: 'https://x.test' } }]);
  const br = parseHarmony('to=browser.search json{"query":"abc"}<|call|>', NAMES);
  assert.equal(br.calls[0].name, 'web_search'); assert.equal(br.text, '');
  const around = parseHarmony('Making the logo now.<|channel|>commentary to=functions.file_write json<|message|>{"project":"p","path":"logo.svg","content":"<svg>{}</svg>"}<|call|>', NAMES);
  assert.equal(around.calls[0].name, 'file_write'); assert.equal(around.calls[0].args.content, '<svg>{}</svg>'); assert.equal(around.text, 'Making the logo now.');
  const fin = parseHarmony('<|channel|>analysis<|message|>he wants a page<|end|><|start|>assistant<|channel|>final<|message|>Here is the page.<|return|>', NAMES);
  assert.deepEqual(fin.calls, []); assert.equal(fin.text, 'Here is the page.');
  const unknown = parseHarmony('<|start|>assistant to=functions.launch_rockets json{"n":1}<|call|>', NAMES);
  assert.deepEqual(unknown.calls, []); assert.equal(unknown.unread, 1); assert.equal(unknown.text, '');
  const broken = parseHarmony('<|start|>assistant to=functions.web_search json{"query": broken<|call|>', NAMES);
  assert.deepEqual(broken.calls, []); assert.equal(broken.unread, 1);
  assert.equal(toolNameFor('web search', NAMES), 'web_search'); assert.equal(toolNameFor('functions.site_screenshot', NAMES), 'site_screenshot');
  // ordinary words are not touched
  for (const ok of ['Normal answer about json and commentary.', 'Use the to=function syntax? no', 'Price: 5 | 6 > 4', 'I searched the web for "SoftTech".'])
    assert.equal(hasHarmony(ok), false, ok);
});
test('D: readHarmony turns the answer into a tool call; with no tools offered it is "bad" (retry / next key)', () => {
  const tl = NAMES.map(name => ({ name }));
  const r = brain.readHarmony({ text: LEAK, calls: [] }, { tools: tl });
  assert.equal(r.bad, false); assert.equal(r.fixed, 1); assert.equal(r.resp.text, ''); assert.equal(r.resp.calls[0].name, 'web_search'); assert.ok(r.resp.calls[0].id);
  assert.equal(brain.readHarmony({ text: LEAK, calls: [] }, { tools: tl, noTools: true }).bad, true);
  assert.equal(brain.readHarmony({ text: 'Hi there', calls: [] }, { tools: tl }).fixed, 0);
});
test('D (adapter): the 2nd key leaks his exact text → web_search really runs (no network: logo search note), no marker reaches the chat', async () => {
  const a = aikeys.addKey({ name: 'Second key', kind: 'openai', base_url: F + '/a/v1', model: 'openai/gpt-oss-120b', key: 'fake-second-key-0001' });
  CALLS.a.length = 0; modeA = 'leak';
  const j = await wait(brain.startJob({ text: 'I need a designed html page that this site is a privet site and add a go back to site button', channel: 'web' }));
  assert.equal(j.status, 'done', j.result);
  assert.equal(CALLS.a.length, 2, 'one answer with the leak, one after the tool ran');
  const toolMsg = CALLS.a[1].messages.find(m => m.role === 'tool');
  assert.ok(toolMsg, 'the call was run as a real tool call');
  assert.match(toolMsg.content, /Not searched/);
  const asst = CALLS.a[1].messages.find(m => m.role === 'assistant' && m.tool_calls);
  assert.equal(asst.tool_calls[0].function.name, 'web_search');
  assert.doesNotMatch(String(asst.content || ''), MARKERS);
  assert.equal(j.result, 'I will make the logo myself as logo.svg.');
  for (const m of db.all('SELECT text FROM messages')) assert.doesNotMatch(m.text, MARKERS);
  for (const e of db.all('SELECT text FROM job_events WHERE job_id=?', j.id).filter(Boolean)) assert.doesNotMatch(String(e.text || ''), /<\|start\|>/);
  aikeys.removeKey(a.id);
});
test('D (adapter): canonical harmony → the real tool runs (calculator 6*7)', async () => {
  const a = aikeys.addKey({ name: 'Second key', kind: 'openai', base_url: F + '/a/v1', model: 'openai/gpt-oss-120b', key: 'fake-second-key-0001' });
  CALLS.a.length = 0; modeA = 'canonical';
  const j = await wait(brain.startJob({ text: 'what is 6*7', channel: 'web' }));
  assert.equal(j.status, 'done', j.result);
  const toolMsg = CALLS.a[1].messages.find(m => m.role === 'tool');
  assert.match(toolMsg.content, /42/);
  aikeys.removeKey(a.id);
});
test('D (adapter): text that cannot be read → one more try on the same key, then the next key answers; nothing leaks', async () => {
  const a = aikeys.addKey({ name: 'Second key', kind: 'openai', base_url: F + '/a/v1', model: 'openai/gpt-oss-120b', key: 'fake-second-key-0001' });
  const b = aikeys.addKey({ name: 'Third key', kind: 'openai', base_url: F + '/b/v1', model: 'm', key: 'fake-third-key-0002' });
  CALLS.a.length = 0; CALLS.b.length = 0; modeA = 'broken';
  const j = await wait(brain.startJob({ text: 'hi', channel: 'web' }));
  assert.equal(j.status, 'done', j.result);
  assert.equal(CALLS.a.length, 2, 'asked the same key once more');
  assert.equal(CALLS.b.length, 1, 'then the next key');
  assert.equal(j.result, 'Hello from the next key.');
  assert.match(aikeys.keyRow(a.id).last_error || '', /broken tool command/);
  assert.ok(LOGS.some(l => /answered with tool-call text/.test(l)));
  aikeys.removeKey(a.id); aikeys.removeKey(b.id);
});
test('D (send step): the last guard blocks such text on every channel, keeps real words around it, and logs it', async () => {
  assert.equal(guardOut(LEAK, 'test'), '');
  assert.equal(guardOut('Sure.\n' + LEAK, 'test'), 'Sure.');
  assert.equal(guardOut('Normal words', 'test'), 'Normal words');
  assert.ok(LOGS.some(l => /outguard: tool-call text blocked on test/.test(l)));
  assert.deepEqual(withoutHarmony('<|channel|>final<|message|>Done.<|end|>'), { text: 'Done.', blocked: true });
  // the channels themselves: nothing is sent (they return before even needing a connection)
  for (const ch of ['waagent', 'whatsapp', 'telegram', 'sms', 'email']) {
    const m = await import('../src/channels/' + ch + '.js');
    assert.equal(await m.sendOwner(LEAK, {}), true, ch);
  }
  assert.equal(await notify.deliver('whatsapp_agent', LEAK, {}), true);
  const id = notify.addMessage('assistant', 'web', LEAK);
  assert.equal(db.get('SELECT text FROM messages WHERE id=?', id).text, '');
  const own = notify.addMessage('owner', 'web', 'what does <|start|> mean?');
  assert.equal(db.get('SELECT text FROM messages WHERE id=?', own).text, 'what does <|start|> mean?', 'his own words are stored as he wrote them');
});

// ---------------- E: broken pictures, hot-linked logos, designed pages ----------------
function site(dir, files) { fs.rmSync(dir, { recursive: true, force: true }); for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); } return dir; }
const BAD_PAGE = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="favicon.png"></head><body><img src="logo.png" alt="Logo"><img src="https://raw.githubusercontent.com/x/y/main/softtech.png" alt="SoftTech"><h1>Private Link</h1><div style="background:url(img/bg.jpg)"></div><img alt="empty"></body></html>';
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b2545"/><circle cx="32" cy="32" r="18" fill="none" stroke="#22d3ee" stroke-width="5"/></svg>';
const GOOD_PAGE = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="logo.svg"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><style>body{margin:0;background:linear-gradient(#0b2545,#13315c);color:#fff;font-family:sans-serif}.c{margin:60px 20px;padding:28px;border-radius:18px;background:#fff;color:#0b2545;text-align:center}a.b{display:inline-block;padding:14px 22px;border-radius:12px;background:#22d3ee;color:#0b2545;font-weight:700;text-decoration:none}</style></head><body><div class="c"><img src="logo.svg" width="72" height="72" alt="SoftTech"><h1>This site is private</h1><p>Only invited people can see it.</p><a class="b" href="https://soft-tech.net/">Go back to site</a></div></body></html>';

test('E: the file check finds missing local pictures, hot-linked pictures, empty <img> and CSS pictures; a good page passes', () => {
  const bad = site(path.join(T, 'chk-bad'), { 'index.html': BAD_PAGE });
  const r = sitecheck.checkSiteFiles(bad);
  assert.equal(r.mustFix, true);
  assert.ok(r.missing.some(m => /logo\.png/.test(m))); assert.ok(r.missing.some(m => /favicon\.png/.test(m))); assert.ok(r.missing.some(m => /img\/bg\.jpg/.test(m)));
  assert.ok(r.hotlinked.some(m => /raw\.githubusercontent\.com/.test(m)));
  assert.deepEqual(r.empty, ['index.html']);
  const good = site(path.join(T, 'chk-good'), { 'index.html': GOOD_PAGE, 'logo.svg': LOGO });
  const g = sitecheck.checkSiteFiles(good);
  assert.deepEqual(g.problems, [], 'a font stylesheet from another site is fine; only pictures count');
  // /sites/<name>/… addresses map into the site; other top-of-server addresses are not inside it
  const abs = site(path.join(T, 'chk-abs'), { 'index.html': '<img src="/sites/priv/logo.svg"><img src="/logo.svg">', 'logo.svg': LOGO });
  const a = sitecheck.checkSiteFiles(abs, { siteName: 'priv' });
  assert.equal(a.missing.length, 1); assert.match(a.missing[0], /^index\.html: \/logo\.svg/);
  // a ../ address leaving the site is missing too
  const up = site(path.join(T, 'chk-up'), { 'sub/index.html': '<img src="../../chk-good/logo.svg">' });
  assert.match(sitecheck.checkSiteFiles(up).missing[0], /outside the site folder/);
});
test('E: publish_site is not filed for his YES while the page has broken/hot-linked pictures; a fixed page is', async () => {
  const ws = path.join(T, 'ws', 'private-page');
  site(ws, { 'index.html': BAD_PAGE });
  const before = db.get('SELECT COUNT(*) AS n FROM approvals').n;
  const r = await tools.execTool('publish_site', { project: 'private-page', name: 'soft-tech-private-7f9a3' }, {});
  assert.match(r.error || '', /Not filed for his YES/);
  assert.ok(r.problems.some(p => /logo\.png/.test(p)) && r.problems.some(p => /linked from other sites/.test(p)));
  assert.match(r.fix, /logo\.svg/);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM approvals').n, before, 'no request reached him');
  site(ws, { 'index.html': GOOD_PAGE, 'logo.svg': LOGO });
  const ok = await tools.execTool('publish_site', { project: 'private-page', name: 'soft-tech-private-7f9a3' }, {});
  assert.equal(ok.status, 'waiting_for_owner_approval', JSON.stringify(ok));
  db.run("UPDATE approvals SET status='cancelled' WHERE status='pending'");
});
test('E: a web search for a logo picture is not run; it tells the AI to make its own SVG', async () => {
  const ws = basic.default ? basic.default.find?.(t => t.name === 'web_search') : null;
  const t = ws || (await import('../src/tools/index.js')).declarations && null;
  assert.equal(basic.LOGO_FILE_SEARCH('SoftTech logo png site:github.com soft-tech.net'), true);
  assert.equal(basic.LOGO_FILE_SEARCH('best pizza near me'), false);
  assert.equal(basic.LOGO_FILE_SEARCH('logo design ideas for a bakery'), false);
  const r = await tools.execTool('web_search', { query: ' SoftTech logo png site:github.com soft-tech.net' }, {});
  assert.deepEqual(r.results, []); assert.match(r.note, /Make the logo yourself/);
  void t;
});
test('E: the prompt says what a designed page is, no hot-linking or logo search, check the screenshot first', () => {
  const p = brain.systemPrompt('whatsapp_agent');
  assert.match(p, /"designed" page/); assert.match(p, /Go back to site/); assert.match(p, /never search the web for a logo/);
  assert.match(p, /never link a picture from another site/); assert.match(p, /Before you send a screenshot or call publish_site/);
  assert.match(p, /never use a placeholder|Never use a placeholder/i);
});

const BROWSER = sitecheck.findChromium();
const noBrowser = BROWSER ? false : 'no Chromium on this machine (set MA_CHROMIUM or run optional/install-browser.sh)';
test('E (browser): site_screenshot of the broken page — broken + hot-linked pictures found, must_fix, NOT sent to him', { skip: noBrowser, timeout: 90000 }, async () => {
  site(path.join(T, 'ws', 'private-page'), { 'index.html': BAD_PAGE });
  const r = await tools.execTool('site_screenshot', { project: 'private-page', send_to_owner: true, wait_ms: 200 }, {});
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.ok(r.problems_found.some(p => /did not load/.test(p) && /Logo/.test(p)), r.problems_found.join(' | '));
  assert.ok(r.problems_found.some(p => /linked from other sites/.test(p)));
  assert.match(r.must_fix, /logo\.svg/);
  assert.match(r.sent_to_owner, /^NOT sent/);
});
test('E (browser): the fixed page — no problems, the "Go back to site" button is on the first screen, picture goes to him', { skip: noBrowser, timeout: 90000 }, async () => {
  site(path.join(T, 'ws', 'private-page'), { 'index.html': GOOD_PAGE, 'logo.svg': LOGO });
  const r = await tools.execTool('site_screenshot', { project: 'private-page', send_to_owner: true, wait_ms: 200 }, {});
  assert.equal(r.ok, true);
  assert.equal(r.must_fix, undefined, JSON.stringify(r.problems_found));
  assert.ok(r.buttons_on_first_screen.includes('Go back to site'), JSON.stringify(r.buttons_on_first_screen));
  assert.match(r.sent_to_owner, /in the chat/);
});
test('E (browser): publish_site also opens the page before his YES — a picture file that is not a real picture is caught', { skip: noBrowser, timeout: 90000 }, async () => {
  site(path.join(T, 'ws', 'private-page'), { 'index.html': GOOD_PAGE.replace('logo.svg" width', 'logo.png" width'), 'logo.svg': LOGO, 'logo.png': 'not a png' });
  const r = await tools.execTool('publish_site', { project: 'private-page', name: 'priv2' }, {});
  assert.match(r.error || '', /Not filed/); assert.ok(r.problems.some(p => /did not load in the browser/.test(p)), JSON.stringify(r.problems));
});
