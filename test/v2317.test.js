// 2.3.17 (Abish, Nov 8 2026 1:23 AM, WhatsApp screenshot): (A) ONE message after his YES ("Published: <link>", not
// "Done A4: …" + "Site published: …"), (B) no request code (A4) when only one request is waiting — not in the web
// card either, (C) a logo/design request gets a real logo, not "a logo placeholder"; "Again, I need…" is the main job.
// Against fakes and a fake model — not his server, the real WhatsApp or Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fakeServer } from './fakes.js';

const LOGS = [];
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { LOGS.push(a.map(String).join(' ')); if (process.env.SHOW_LOGS) orig(...a); }; }
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v2317-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(20); } throw new Error('timed out waiting for ' + what); }

// ---- WhatsApp Agent Platform mock (as in the 2.3.7 tests)
const KEY = 'WAAGENTkey-' + crypto.randomBytes(12).toString('hex');
const AP = { feed: [], sent: [], seq: 100 };
function push(message) { AP.seq++; AP.feed.push({ seq: AP.seq, message: { timestamp: String(Math.floor(Date.now() / 1000)), ...message } }); }
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  const J = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== 'Bearer ' + KEY) return J({ error: { message: 'Invalid OAuth access token.', code: 190 } }, 401);
  if (p === '/agent/v1/updates') {
    const offset = u.searchParams.has('offset') ? parseInt(u.searchParams.get('offset'), 10) : null;
    const pick = () => AP.feed.filter(x => offset === null || x.seq >= offset);
    let items = pick(); const end = Date.now() + Math.min(1000, Number(u.searchParams.get('timeout') || 0) * 1000);
    while (!items.length && Date.now() < end) { await sleep(20); items = pick(); }
    if (!items.length) { res.writeHead(204); return res.end(); }
    return J({ object: 'whatsapp_agent_platform', entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages: items.map(x => x.message) } }] }], next_offset: items.at(-1).seq + 1 });
  }
  if (p === '/agent/v1/statuses') return J({ success: true });
  if (p === '/agent/v1/media') { AP.media = (AP.media || 0) + 1; return J({ id: 'media' + AP.media }); }
  if (p === '/agent/v1/messages') { AP.sent.push(JSON.parse(body)); return J({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.out' + AP.sent.length }] }); }
  J({ error: { message: 'mock: no route ' + p } }, 404);
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const MOCK = 'http://127.0.0.1:' + mock.address().port;
const F = await fakeServer();     // Telegram + Graph (his WhatsApp number)

const PORT = 26500 + Math.floor(Math.random() * 150);
Object.assign(process.env, {
  MA_DATA_DIR: T + '/data', MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/sites', MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_RELEASE_BASE: 'http://127.0.0.1:1',
  MA_CHROMIUM: '', MA_MOCK_MODULE: new URL('./mock-model-v2317.js', import.meta.url).href,
  MA_TELEGRAM_BASE: F.url, MA_GRAPH_BASE: F.url,
  MA_WA_AGENT_BASE: MOCK + '/agent/v1', MA_WA_AGENT_POLL_TIMEOUT: '1', MA_WA_AGENT_MIN_INTERVAL_MS: '30', MA_WA_AGENT_WINDOW_MS: '2000', MA_WA_AGENT_BACKOFF_MS: '50', MA_WA_AGENT_CONFLICT_MS: '200',
});
const { start } = await import('../src/server.js');
const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const brain = await import('../src/brain.js');
const telegram = await import('../src/channels/telegram.js');
const whatsapp = await import('../src/channels/whatsapp.js');
const waagent = await import('../src/channels/waagent.js');
const emoji = await import('../src/emoji.js');
const server = start();
await sleep(300);
db.setSetting('setup_done', '1'); db.setSecret('gemini_api_key', 'AIzaFAKE' + 'x'.repeat(30));
const BASE = 'http://127.0.0.1:' + PORT;
const S = auth.newSession('127.0.0.1', 'test');
const cookie = S.cookie.split(';')[0], csrf = S.csrf;
async function call(p, body) {
  const r = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-CSRF': csrf } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
}
const job = (id) => db.get('SELECT * FROM jobs WHERE id=?', id);
async function waitJob(id, ms = 10000) { return until(() => { const j = job(id); return ['done', 'error', 'cancelled'].includes(j.status) ? j : null; }, ms, 'job ' + id); }
async function newChat() { const r = await call('/api/chats', {}); return r.j.chat.id; }
const say = async (chat, text) => { const r = await call('/api/chat', { text, chat_id: chat }); assert.equal(r.status, 200, r.text); return r.j.job; };
const msgs = (chat) => db.all("SELECT id,role,text FROM messages WHERE chat_id=? AND role IN ('owner','assistant') ORDER BY id", chat);

await import('./mock-model-v2317.js');
const M = globalThis.__M2317;
const tidy = await import('../src/tidy.js');
const approvals = await import('../src/approvals.js');
const { LOGO_SVG, REAL_PAGE } = await import('./mock-model-v2317.js');
const WS = T + '/ws', SITES = T + '/sites';
const mkProject = (n, files = { 'index.html': '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><h1>' + n + '</h1>' }) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(WS, n, f)), { recursive: true }); fs.writeFileSync(path.join(WS, n, f), c); } };
const clearApprovals = () => db.run("UPDATE approvals SET status='denied' WHERE status='pending'");
const texts = (from) => AP.sent.slice(from).filter(s => s.type === 'text').map(s => s.text.body);
const CHROME = process.env.MA_TEST_CHROMIUM || '';
test.after(() => { waagent.stop(); server.close(); mock.close(); F.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });
db.setSetting('batch_wait_ms', '0');

// ---------------------------------------------------------------- unit: the pieces
test('A: a follow-up that only restates the result is recognised; real news is not', () => {
  const told = 'Published: https://96-250-207-131.sslip.io/sites/soft-tech-private-7f9a3/';
  for (const s of ['Site published: https://96-250-207-131.sslip.io/sites/soft-tech-private-7f9a3/',
    '✅ Your site is live at https://96-250-207-131.sslip.io/sites/soft-tech-private-7f9a3 🎉',
    'Done! It is now live here: https://96-250-207-131.sslip.io/sites/soft-tech-private-7f9a3/',
    'Published.', 'A4 approved and done.', 'All set, the website is up and you can check it out.'])
    assert.equal(tidy.restatesResult(s, told), true, s);
  for (const s of ['I also added the contact form you asked for earlier, with your phone number.',
    'Want me to add a 404 page too?', 'The admin page is at https://96-250-207-131.sslip.io/sites/soft-tech-admin/'])
    assert.equal(tidy.restatesResult(s, told), false, s);
});

test('A+B: the one message after YES: "Published: <link>", the code only when needed; the follow-up is told not to repeat it', () => {
  assert.equal(approvals.doneMessage('publish_site', { name: 'x' }, { url: 'https://h/sites/x/' }), 'Published: https://h/sites/x/');
  assert.equal(approvals.doneMessage('publish_site', { name: 'x' }, { url: 'https://h/sites/x/' }, ' (A4)'), 'Published (A4): https://h/sites/x/');
  assert.equal(approvals.doneMessage('gmail_send', { to: 'a@b.c' }, {}), 'Done: email sent to a@b.c.');
  const note = approvals.followUpNote(4, 'publish_site', { url: 'https://h/sites/x/' }, 'Published: https://h/sites/x/', true);
  assert.match(note, /ALREADY been told the result in this exact message \(with a phone picture of the page\): "Published: https:\/\/h\/sites\/x\/"/);
  assert.match(note, /Do NOT repeat, restate or confirm it/); assert.match(note, /never mention the request code/); assert.match(note, /answer exactly NO_REPLY/);
});

test('C: logo/design words, placeholders and real logo files are told apart', () => {
  for (const s of ['Again, I need the design and the logo', 'make me a logo', 'I need a new design for the site', 'can you do the branding'])
    assert.equal(tidy.asksForDesign(s), true, s);
  for (const s of ['publish it', 'add a logo placeholder for now', 'fix the menu'])
    assert.equal(tidy.asksForDesign(s), false, s);
  for (const s of ['<div class="logo-placeholder">LOGO</div>', '<div class="logo">LOGO</div>', '<img src="https://via.placeholder.com/120">', '<span>Your Logo</span>', "I've removed the details and added a logo placeholder."])
    assert.equal(tidy.hasLogoPlaceholder(s), true, s);
  assert.equal(tidy.hasLogoPlaceholder('<img src="logo.svg" alt="SoftTech">'), false);
  assert.equal(tidy.isRealLogoFile('logo.svg', LOGO_SVG), true);
  assert.equal(tidy.isRealLogoFile('logo.svg', '<svg><rect width="100" height="40" fill="#ccc"/></svg>'), false, 'one grey box is not a logo');
  assert.equal(tidy.isRealLogoFile('logo.svg', '<svg><rect/><text>LOGO</text></svg>'), false, 'a box with "LOGO" in it is a placeholder');
  assert.equal(tidy.isRealLogoFile('index.html', LOGO_SVG), false);
});

test('C: the prompt says to make a real SVG logo (never a placeholder), redesign for real, and that "Again, I need…" is the main job', () => {
  const p = brain.systemPrompt('whatsapp_agent');
  assert.match(p, /when he asks for a logo, make a REAL one yourself — write it as an SVG file \(logo\.svg in the project\)/);
  assert.match(p, /in the site's own colours and style/);
  assert.match(p, /Never use a placeholder, a grey box, "LOGO" \/ "Your logo" text or a stock placeholder image, unless he asks for a placeholder/);
  assert.match(p, /really redesign it/);
  assert.match(p, /"Again, I need…", "I still need…".*that request is now the main job/);
  assert.match(p, /never mention request codes \(like A12\) to him/);
  assert.match(p, /After his YES the result goes to him by itself in one short message/);
  assert.doesNotMatch(p, /with the code and how to say YES/);
});

test('B: the web app approval card has no "A#" in its title', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /Needs your OK · A\$\{/);
  assert.match(app, /h\('h3', \{\}, 'Needs your OK'\)/);
  assert.doesNotMatch(app, /reply “YES A12”\. /);
});

// ---------------------------------------------------------------- end to end on the WhatsApp Agent (his channel)
async function waOn() {
  let r = await call('/api/wa-agent/key', { key: KEY }); assert.equal(r.status, 200);
  r = await call('/api/wa-agent', { enabled: true }); assert.equal(r.status, 200);
  await until(async () => (await call('/api/wa-agent')).j.state === 'connected', 8000, 'connected');
}
let seq = 0;
async function publishAndYes(site, mode, yesText = 'Yes', files) {
  clearApprovals(); mkProject(site, files); M.mode = mode; M.notes.length = 0;
  const n = AP.sent.length; seq++;
  push({ id: 'wamid.P' + seq, from: 'user:4242', type: 'text', text: { body: `PUBLISH ${site} ${site}` } });
  await until(() => texts(n).some(t => /^Needs your OK/.test(t)), 8000, 'the request');
  await sleep(300);
  const req = texts(n);
  const n2 = AP.sent.length;
  push({ id: 'wamid.Y' + seq, from: 'user:4242', type: 'text', text: { body: yesText } });
  await until(() => M.notes.length >= 1, 8000, 'the follow-up job');
  await until(() => !db.get("SELECT 1 AS x FROM jobs WHERE status IN ('queued','running')"), 8000, 'jobs finished');
  await sleep(700);
  return { req, after: AP.sent.slice(n2) };
}

test('A+B (his Nov 8 screenshot): request without "A4"; after "Yes" exactly ONE message "Published: <link>" — the follow-up "Site published: …" is not sent', async () => {
  await waOn();
  const { req, after } = await publishAndYes('soft-tech-private-7f9a3', 'restate');
  assert.equal(req.length, 1, JSON.stringify(req));
  assert.match(req[0], /^Needs your OK:\n/); assert.doesNotMatch(req[0], /\bA\d+\b/, 'no code in the request');
  const out = after.filter(s => s.type === 'text').map(s => s.text.body);
  const url = BASE + '/sites/soft-tech-private-7f9a3/';
  assert.deepEqual(out, ['Published: ' + url], JSON.stringify(out));
  assert.ok(out.every(t => !/\bA\d+\b/.test(t)), 'no code after YES');
  assert.ok(db.get("SELECT 1 AS x FROM audit WHERE action='reply.restated_result'"), 'the restated reply was held back');
  assert.match(M.notes[0], /ALREADY been told the result in this exact message: "Published: /);
  fs.writeFileSync(T + '/after-yes.json', JSON.stringify(out));
  globalThis.__AFTER_YES = { request: req[0], after: out };
});

test('A: "✅ Your site is live at <link> 🎉" is held back too; a real extra step still goes out (2 messages, the second is news)', async () => {
  let r = await publishAndYes('soft-tech-b', 'restate2');
  assert.deepEqual(r.after.filter(s => s.type === 'text').map(s => s.text.body), ['Published: ' + BASE + '/sites/soft-tech-b/']);
  r = await publishAndYes('soft-tech-c', 'more');
  assert.deepEqual(r.after.filter(s => s.type === 'text').map(s => s.text.body), ['Published: ' + BASE + '/sites/soft-tech-c/', 'I also added the contact form you asked for earlier, with your phone number.']);
});

test('B: two requests waiting → the codes are shown, and the reply to "YES A#" names that one', async () => {
  clearApprovals(); mkProject('two-a'); mkProject('two-b'); M.mode = 'quiet';
  const n = AP.sent.length;
  push({ id: 'wamid.T1', from: 'user:4242', type: 'text', text: { body: 'PUBLISH two-a two-a' } });
  await until(() => texts(n).filter(t => /^Needs your OK/.test(t)).length === 1, 8000, 'first request');
  push({ id: 'wamid.T2', from: 'user:4242', type: 'text', text: { body: 'PUBLISH two-b two-b' } });
  await until(() => texts(n).filter(t => /^Needs your OK/.test(t)).length === 2, 8000, 'second request');
  const [first, second] = texts(n).filter(t => /^Needs your OK/.test(t));
  assert.match(first, /^Needs your OK:\n/, 'the first one was alone: no code');
  const id2 = db.get("SELECT id FROM approvals WHERE status='pending' ORDER BY id DESC LIMIT 1").id;
  assert.match(second, new RegExp(`^Needs your OK \\(A${id2}\\):[\\s\\S]*Reply YES A${id2} or NO A${id2}\\.`));
  const n2 = AP.sent.length;
  push({ id: 'wamid.T3', from: 'user:4242', type: 'text', text: { body: `YES A${id2}` } });
  await until(() => texts(n2).some(t => /^Published/.test(t)), 8000, 'published');
  assert.deepEqual(texts(n2).filter(t => /^Published/.test(t)), [`Published (A${id2}): ${BASE}/sites/two-b/`], 'the code, because another one is still waiting');
  // now only one is left: a plain NO, and the answer has no code
  const n3 = AP.sent.length;
  push({ id: 'wamid.T4', from: 'user:4242', type: 'text', text: { body: 'no' } });
  await until(() => texts(n3).some(t => /^Cancelled/.test(t)), 8000, 'cancelled');
  assert.deepEqual(texts(n3).filter(t => /^Cancelled/.test(t)), ['Cancelled. Nothing was done.']);
  // "approvals" with one waiting lists it without a code
  clearApprovals(); await approvals.request('publish_site', { project: 'two-a', name: 'two-a' }, 'Publish two-a', { channel: 'web' });
  const { ownerSaid } = await import('../src/channels/inbound.js');
  const list = await ownerSaid('web', 'approvals');
  assert.match(list, /^Waiting for your OK: Publish two-a\nReply YES or NO\.$/);
  clearApprovals();
});

test('C (his "Again, I need the design and the logo"): a placeholder is not the answer — it makes logo.svg and uses it', async () => {
  clearApprovals(); M.project = 'soft-tech-private-7f9a3'; M.nudged = 0; M.stage = '';
  mkProject(M.project);
  await sleep(500);
  const n = AP.sent.length;
  push({ id: 'wamid.L1', from: 'user:4242', type: 'text', text: { body: 'Again, I need the design and the logo' } });
  await until(() => M.nudged === 1, 8000, 'the guard sends it back to make the logo').catch(e => { fs.writeFileSync('/tmp/v2317-debug.json', JSON.stringify({ ev: db.all('SELECT kind,text FROM job_events ORDER BY id DESC LIMIT 12'), sent: texts(n), stage: M.stage, logs: LOGS.slice(-15) }, null, 1)); throw e; });
  await until(() => texts(n).length >= 1, 8000, 'the answer');
  await sleep(500);
  const logo = path.join(WS, M.project, 'logo.svg');
  assert.ok(fs.existsSync(logo), 'a real logo file was written');
  assert.equal(tidy.isRealLogoFile('logo.svg', fs.readFileSync(logo, 'utf8')), true);
  const page = fs.readFileSync(path.join(WS, M.project, 'index.html'), 'utf8');
  assert.match(page, /<img src="logo\.svg"/); assert.match(page, /rel="icon" href="logo\.svg"/);
  assert.equal(tidy.hasLogoPlaceholder(page), false, 'no placeholder left in the page');
  const out = texts(n);
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.doesNotMatch(out[0], /placeholder/i, 'the placeholder answer never reached him');
  assert.ok(db.get("SELECT 1 AS x FROM audit WHERE action='design.placeholder_nudge'"));
});

test('C: when he asks for a placeholder himself, it is left alone (no nudge)', async () => {
  M.project = 'ph-site'; M.nudged = 0; M.stage = ''; mkProject(M.project);
  const n = AP.sent.length;
  push({ id: 'wamid.L2', from: 'user:4242', type: 'text', text: { body: 'put a logo placeholder there for now, I will send the logo later' } });
  await until(() => texts(n).length >= 1, 8000, 'the answer');
  await sleep(300);
  assert.equal(M.nudged, 0);
  assert.match(texts(n)[0], /placeholder/);
  assert.ok(!fs.existsSync(path.join(WS, M.project, 'logo.svg')));
});

test('A (with a browser): after "Yes" the ONE message is a phone picture of the live page with "Published: <link>" as its caption', { skip: !CHROME && 'set MA_TEST_CHROMIUM to a Chromium to run this' }, async () => {
  process.env.MA_CHROMIUM = CHROME;
  try {
    const { req, after } = await publishAndYes('soft-tech-pic', 'restate', 'Yes', { 'index.html': REAL_PAGE, 'logo.svg': LOGO_SVG });
    const site = BASE + '/sites/soft-tech-pic/';
    assert.equal(after.filter(s => s.type === 'text').length, 0, 'no separate text: ' + JSON.stringify(after.filter(s => s.type === 'text')));
    const imgs = after.filter(s => s.type === 'image');
    assert.equal(imgs.length, 1, JSON.stringify(after.map(s => s.type)));
    assert.equal(imgs[0].image.caption, 'Published: ' + site);
    assert.match(M.notes[0], /with a phone picture of the page/);
    if (process.env.MA_TEST_EVIDENCE) {      // for the report's phone picture (not part of the check)
      const shots = fs.readdirSync(path.join(WS, 'soft-tech-pic', 'screenshots')).filter(f => f.endsWith('.png')).sort();
      fs.mkdirSync(process.env.MA_TEST_EVIDENCE, { recursive: true });
      fs.copyFileSync(path.join(WS, 'soft-tech-pic', 'screenshots', shots[shots.length - 1]), path.join(process.env.MA_TEST_EVIDENCE, 'live.png'));
      fs.writeFileSync(path.join(process.env.MA_TEST_EVIDENCE, 'chat.json'), JSON.stringify({ request: req[0], after: after.map(s => ({ type: s.type, text: s.text?.body, caption: s.image?.caption })) }, null, 1));
    }
  } finally { process.env.MA_CHROMIUM = ''; }
});
