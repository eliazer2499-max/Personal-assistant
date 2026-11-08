// 2.3.7: (1) Reactions = Natural: a real request (the job used a tool other than react) gets 👍 when work starts and
// ✅ when it finishes; chit-chat gets none automatically; Off and Every message are unchanged; the 12-a-minute budget
// never holds up a reply; the 2.3.5 typed-emoji safety net still works. (2) Removing published sites: this server,
// Cloudflare Pages and GitHub (only repos it published), from the web page (his tap) and through the unpublish_site
// tool (his YES). Against mocks of the WhatsApp Agent Platform, the Cloudflare API and the GitHub API, and a fake
// model. Not the real Meta, Cloudflare or GitHub services, his phone or his server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const KEY = 'WAAGENTkey-' + crypto.randomBytes(12).toString('hex');
const LOGS = [];
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { LOGS.push(a.map(String).join(' ')); if (process.env.SHOW_LOGS) orig(...a); }; }
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v237-'));
const DATA = T + '/data', WS = T + '/ws', SITES = T + '/sites';
const FIX = path.join(import.meta.dirname, 'fixtures');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); } throw new Error('timed out waiting for ' + what); }

// ---- Cloudflare + GitHub mocks
const GH_TOKEN = 'ghp_' + crypto.randomBytes(16).toString('hex'), CF_TOKEN = 'cftok' + crypto.randomBytes(16).toString('hex'), ACC = 'acc123';
const GH = { repos: { 'abish/legacy-site': { has_pages: true }, 'abish/my-site': { has_pages: true }, 'abish/old-app': { has_pages: false }, 'abish/private-stuff': { has_pages: false } }, calls: [], denyDelete: false, denyPages: false };
const CF = { projects: ['proj-a', 'proj-b', 'proj-c'], calls: [], deny: false };
function platformMock(req, res, p, u, J) {
  let m;
  if (p.startsWith('/gh/')) {
    GH.calls.push(req.method + ' ' + p.slice(3) + (req.headers.authorization === 'Bearer ' + GH_TOKEN ? '' : ' BADAUTH'));
    if (req.headers.authorization !== 'Bearer ' + GH_TOKEN) return J({ message: 'Bad credentials' }, 401);
    if ((m = /^\/gh\/repos\/([^/]+\/[^/]+)\/pages$/.exec(p)) && req.method === 'DELETE') {
      if (GH.denyPages) return J({ message: 'Resource not accessible by personal access token' }, 403);
      const r = GH.repos[m[1]]; if (!r || !r.has_pages) return J({ message: 'Not Found' }, 404);
      r.has_pages = false; res.writeHead(204); return res.end();
    }
    if ((m = /^\/gh\/repos\/([^/]+\/[^/]+)$/.exec(p))) {
      const r = GH.repos[m[1]];
      if (!r) return J({ message: 'Not Found' }, 404);
      if (req.method === 'GET') return J({ full_name: m[1], has_pages: r.has_pages, html_url: 'https://github.com/' + m[1] });
      if (req.method === 'DELETE') { if (GH.denyDelete) return J({ message: 'Must have admin rights to Repository.' }, 403); delete GH.repos[m[1]]; res.writeHead(204); return res.end(); }
    }
    return J({ message: 'mock: no route' }, 404);
  }
  CF.calls.push(req.method + ' ' + p.slice(3) + (req.headers.authorization === 'Bearer ' + CF_TOKEN ? '' : ' BADAUTH'));
  if (req.headers.authorization !== 'Bearer ' + CF_TOKEN) return J({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, 403);
  if (p === `/cf/accounts/${ACC}/pages/projects` && req.method === 'GET') {
    const page = parseInt(u.searchParams.get('page') || '1', 10), per = parseInt(u.searchParams.get('per_page') || '10', 10);
    const all = CF.projects.map(n => ({ name: n, subdomain: n + '.pages.dev', created_on: '2026-10-01T00:00:00Z' }));
    return J({ success: true, errors: [], result: all.slice((page - 1) * per, page * per), result_info: { page, per_page: per, total_count: all.length, total_pages: Math.max(1, Math.ceil(all.length / per)) } });
  }
  if ((m = new RegExp(`^/cf/accounts/${ACC}/pages/projects/([^/]+)$`).exec(p)) && req.method === 'DELETE') {
    if (CF.deny) return J({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, 403);
    if (!CF.projects.includes(m[1])) return J({ success: false, errors: [{ code: 8000007, message: 'Project not found.' }] }, 404);
    CF.projects = CF.projects.filter(n => n !== m[1]); return J({ success: true, errors: [], result: null });
  }
  return J({ success: false, errors: [{ code: 7003, message: 'mock: no route' }] }, 404);
}

const AP = { feed: [], sent: [], uploads: [], media: {}, seq: 100, statuses: [], failReact: 0 };
const sha = (b) => crypto.createHash('sha256').update(b).digest();
function push(message) { AP.seq++; AP.feed.push({ seq: AP.seq, message: { timestamp: String(Math.floor(Date.now() / 1000)), ...message } }); }
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  const J = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (p.startsWith('/gh/') || p.startsWith('/cf/')) return platformMock(req, res, p, u, J);
  if (req.headers.authorization !== 'Bearer ' + KEY) return J({ error: { message: 'Invalid OAuth access token.', code: 190 } }, 401);
  if (p === '/agent/v1/updates') {
    const offset = u.searchParams.has('offset') ? parseInt(u.searchParams.get('offset'), 10) : null;
    const pick = () => AP.feed.filter(x => offset === null || x.seq >= offset);
    let items = pick(); const end = Date.now() + Math.min(1000, Number(u.searchParams.get('timeout') || 0) * 1000);
    while (!items.length && Date.now() < end) { await sleep(20); items = pick(); }
    if (!items.length) { res.writeHead(204); return res.end(); }
    return J({ object: 'whatsapp_agent_platform', entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages: items.map(x => x.message) } }] }], next_offset: items.at(-1).seq + 1 });
  }
  if (p === '/agent/v1/statuses') { AP.statuses.push(JSON.parse(body)); return J({ success: true }); }
  if (p === '/agent/v1/messages') { const j = JSON.parse(body);
    if (j.type === 'reaction' && AP.failReact) { AP.sent.push({ ...j, refused: AP.failReact }); return J({ error: { message: 'mock: reaction refused', code: AP.failReact === 400 ? 100 : 1 } }, AP.failReact); }
    AP.sent.push(j); return J({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.out' + AP.sent.length }] }); }
  if (p === '/agent/v1/media' && req.method === 'POST') {
    const s = body.toString('latin1');
    AP.uploads.push({ type: /name="type"\r\n\r\n([^\r]*)/.exec(s)?.[1], filename: /filename="([^"]*)"/.exec(s)?.[1], size: body.length });
    return J({ id: 'up-' + AP.uploads.length });
  }
  let m;
  if ((m = /^\/agent\/v1\/media\/([^/]+)$/.exec(p))) { const f = AP.media[m[1]]; if (!f) return J({ error: { message: 'Unsupported get request', code: 100 } }, 400);
    return J({ url: MOCK + '/agent/v1/media/' + m[1] + '/content', mime_type: f.mime, sha256: sha(f.buf).toString('hex'), file_size: f.buf.length, id: m[1] }); }
  if ((m = /^\/agent\/v1\/media\/([^/]+)\/content$/.exec(p))) { const f = AP.media[m[1]]; res.writeHead(200, { 'Content-Type': f.mime }); return res.end(f.buf); }
  J({ error: { message: 'mock: no route ' + p } }, 404);
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const MOCK = 'http://127.0.0.1:' + mock.address().port;
const PORT = 21500 + Math.floor(Math.random() * 150);
Object.assign(process.env, {
  MA_DATA_DIR: DATA, MA_WORKSPACE: WS, MA_SITES_DIR: SITES, MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_RELEASE_BASE: 'http://127.0.0.1:1',
  MA_MOCK_MODULE: new URL('./mock-model-v237.js', import.meta.url).href,
  MA_WA_AGENT_BASE: MOCK + '/agent/v1', MA_GITHUB_API: MOCK + '/gh', MA_CLOUDFLARE_API: MOCK + '/cf', MA_WA_AGENT_POLL_TIMEOUT: '1', MA_WA_AGENT_MIN_INTERVAL_MS: '30', MA_WA_AGENT_WINDOW_MS: '2000', MA_WA_AGENT_BACKOFF_MS: '50', MA_WA_AGENT_CONFLICT_MS: '100',
});
const { start } = await import('../src/server.js');
const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const waagent = await import('../src/channels/waagent.js');
const tools = await import('../src/tools/index.js');
const chats = await import('../src/chats.js');
const server = start();
await sleep(300);
db.setSetting('setup_done', '1'); db.setSecret('gemini_api_key', 'AIzaFAKE' + 'x'.repeat(30));
const BASE = 'http://127.0.0.1:' + PORT;
const S = auth.newSession('127.0.0.1', 'test');
const cookie = S.cookie.split(';')[0], csrf = S.csrf;
async function call(p, body) {
  const r = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-CSRF': csrf } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text, headers: r.headers };
}
async function waitJob(id) { for (let i = 0; i < 400; i++) { const j = db.get('SELECT * FROM jobs WHERE id=?', id); if (['done', 'error'].includes(j.status)) return j; await sleep(25); } throw new Error('job did not finish'); }
async function ask(text) { const r = await call('/api/chat', { text }); assert.equal(r.status, 200, r.text); return waitJob(r.j.job); }
const sentTexts = () => AP.sent.filter(s => s.type === 'text').map(s => s.text.body);

const reactions = () => AP.sent.filter(s => s.type === 'reaction');
const textsAfter = (n) => AP.sent.slice(n).filter(s => s.type === 'text').map(s => s.text.body);
let N = 0;
async function fromHim(text) {
  const id = 'wamid.in' + (++N) + '-' + crypto.randomBytes(3).toString('hex');
  await until(() => { waagent.limits.messages.prune(Date.now()); return waagent.limits.messages.stamps.length <= 8; }, 5000, 'room in the 12-a-window budget');   // test window is 2 s
  const before = AP.sent.length;
  push({ id, from: 'user:4242', type: 'text', text: { body: text } });
  return { id, before };
}
const replyArrives = (before, re) => until(() => textsAfter(before).find(t => re.test(t)), 8000, 'the reply ' + re).catch(e => { e.message += ' — got: ' + JSON.stringify(textsAfter(before)).slice(0, 400); throw e; });

test.after(() => { waagent.stop(); server.close(); mock.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });


const skipped = () => db.all("SELECT detail FROM audit WHERE action='wa_agent.react_skipped'");


const reactsOn = (id) => reactions().filter(x => x.reaction.message_id === id).map(x => x.reaction.emoji);
const idxOf = (pred, from = 0) => AP.sent.findIndex((s, i) => i >= from && pred(s));
const mode = (m) => call('/api/wa-agent/react', { mode: m });

test('setup: key + enabled (Natural is the default)', async () => {
  let r = await call('/api/wa-agent/key', { key: KEY }); assert.equal(r.status, 200);
  r = await call('/api/wa-agent', { enabled: true }); assert.equal(r.status, 200);
  await until(async () => (await call('/api/wa-agent')).j.state === 'connected', 8000, 'connected');
  assert.equal((await call('/api/wa-agent')).j.react_mode, 'natural');
});

// ---------------------------------------------------------------- 1) Natural reactions
test('Natural: a real request gets 👍 when work starts, then ✅ (replacing it) after the reply', async () => {
  const m = await fromHim('WORK please list my projects');
  await replyArrives(m.before, /^WORKED$/);
  await until(() => reactsOn(m.id).length === 2, 5000, '👍 then ✅');
  assert.deepEqual(reactsOn(m.id), ['👍', '✅']);
  const up = idxOf(s => s.type === 'reaction' && s.reaction.message_id === m.id && s.reaction.emoji === '👍', m.before);
  const txt = idxOf(s => s.type === 'text' && s.text.body === 'WORKED', m.before);
  const done = idxOf(s => s.type === 'reaction' && s.reaction.message_id === m.id && s.reaction.emoji === '✅', m.before);
  assert.ok(up < txt && txt < done, `order 👍(${up}) < reply(${txt}) < ✅(${done})`);
  assert.deepEqual(AP.sent[done], { messaging_product: 'whatsapp', to: 'user:4242', type: 'reaction', reaction: { message_id: m.id, emoji: '✅' } });
  assert.ok(db.all("SELECT detail FROM audit WHERE action='wa_agent.react_task'").some(x => /task done: ✅/.test(x.detail)));
});

test('Natural: chit-chat (no tools), a bare "thanks" and "ok" get no automatic reaction', async () => {
  for (const txt of ['hey how are you', 'thanks', 'ok']) {
    const m = await fromHim(txt);
    await replyArrives(m.before, new RegExp('^ECHO ' + txt));
    await sleep(200);
    assert.deepEqual(reactsOn(m.id), [], 'no reaction on ' + txt);
  }
});

test('Natural: chit-chat can still get a react-tool reaction, and task reactions do not use up the 2-in-a-row cap', async () => {
  for (let i = 0; i < 3; i++) { const m = await fromHim('WORK ' + i); await replyArrives(m.before, /^WORKED$/); await until(() => reactsOn(m.id).includes('✅'), 5000, '✅'); }
  const m = await fromHim('REACT ❤️');
  const t = await replyArrives(m.before, /^TOOL react /);
  assert.match(t, /"reacted":"❤️"/);
  assert.deepEqual(reactsOn(m.id), ['❤️'], 'the react tool alone is not a "real request": no 👍/✅');
});

test('Natural: the 2.3.5 safety net still works — a typed "✅" line is taken out; one ✅ on the message, not two', async () => {
  const m = await fromHim('WORKSAY ✅\\n\\nAll done, your projects are listed');
  await replyArrives(m.before, /^All done, your projects are listed$/);
  await until(() => reactsOn(m.id).includes('✅'), 5000, '✅');
  await sleep(200);
  assert.deepEqual(reactsOn(m.id), ['👍', '✅']);
  assert.ok(!textsAfter(m.before).some(t => /✅/.test(t)), 'no ✅ in the words');
  // emoji-only reply after a task: the ✅ goes on his message, no bubble
  const m2 = await fromHim('WORKSAY ✅');
  await until(() => reactsOn(m2.id).includes('✅'), 5000, '✅ (only)');
  await sleep(300);
  assert.deepEqual(reactsOn(m2.id), ['👍', '✅']);
  assert.deepEqual(textsAfter(m2.before), [], 'nothing typed');
  // chit-chat with a typed ✅ still moves like 2.3.5 did
  const m3 = await fromHim('SAY ✅\\nGot it');
  await replyArrives(m3.before, /^Got it$/);
  await until(() => reactsOn(m3.id).length === 1, 5000, 'moved ✅');
  assert.deepEqual(reactsOn(m3.id), ['✅']);
});

test('Natural: a full 12-a-minute budget skips the reaction; the reply is never held up by it', async () => {
  await sleep(2100);   // test window is 2 s
  const m = await fromHim('WORK budget');
  const now = Date.now();
  for (let i = 0; i < 12; i++) waagent.limits.messages.stamps.push(now);   // budget full before the job starts work
  await replyArrives(m.before, /^WORKED$/);
  await sleep(300);
  assert.ok(!reactsOn(m.id).includes('👍'), '👍 skipped while the budget was full');
  assert.ok(db.all("SELECT detail FROM audit WHERE action='wa_agent.react_failed'").some(x => /automatic 👍 \(task started\): skipped/.test(x.detail)));
});

test('Off: a real request gets no reaction at all; Every message: unchanged (only the chosen emoji, no automatic ✅)', async () => {
  await sleep(2100);
  await mode('off');
  let m = await fromHim('WORK off');
  await replyArrives(m.before, /^WORKED$/); await sleep(300);
  assert.deepEqual(reactsOn(m.id), []);
  await mode('every');
  m = await fromHim('WORK every');
  await replyArrives(m.before, /^WORKED$/); await sleep(300);
  assert.deepEqual(reactsOn(m.id), ['👍'], 'Every message: the 2.3.3 automatic 👍 only');
  await mode('natural');
});

test('Natural: a job that ends waiting for his YES keeps 👍; after YES the approved step is done → ✅', async () => {
  await sleep(2100);
  fs.mkdirSync(path.join(SITES, 'yes-site'), { recursive: true }); fs.writeFileSync(path.join(SITES, 'yes-site', 'index.html'), 'hi');
  const m = await fromHim('UNPUB here yes-site');
  await replyArrives(m.before, /^Needs your OK \(A\d+\)/);     // 2.3.16: the approval request is the one message (no echo of it)
  await sleep(300);
  assert.deepEqual(reactsOn(m.id), ['👍'], 'no ✅ yet');
  assert.ok(fs.existsSync(path.join(SITES, 'yes-site')), 'nothing deleted before his YES');
  const ap = db.get("SELECT id FROM approvals WHERE tool='unpublish_site' AND status='pending' ORDER BY id DESC");
  const y = await fromHim('YES A' + ap.id);
  await replyArrives(y.before, /^Done A\d+: Deleted /);
  await until(() => reactsOn(m.id).includes('✅'), 5000, '✅ after YES');
  assert.deepEqual(reactsOn(m.id), ['👍', '✅']);
  assert.ok(!fs.existsSync(path.join(SITES, 'yes-site')));
});

test('prompt + Settings help: Natural explains 👍/✅ on tasks in plain words', async () => {
  const brain = await import('../src/brain.js');
  assert.match(brain.systemPrompt('whatsapp_agent'), /👍 automatically when you start and ✅ when you finish/);
  const app = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /it puts 👍 on your message as soon as it starts, and changes it to ✅ when it’s done/);
});

// ---------------------------------------------------------------- 2) Removing sites
const sitesMod = await import('../src/sites.js');
test('setup: tokens saved; records for what it published on Cloudflare and GitHub', async () => {
  let r = await call('/api/platforms', { kind: 'github', name: 'github', token: GH_TOKEN, account_id: '', base_url: '' }); assert.equal(r.status, 200, r.text);
  r = await call('/api/platforms', { kind: 'cloudflare', name: 'cloudflare', token: CF_TOKEN, account_id: ACC, base_url: '' }); assert.equal(r.status, 200, r.text);
  for (const n of ['local-one', 'local-two']) { fs.mkdirSync(path.join(SITES, n), { recursive: true }); fs.writeFileSync(path.join(SITES, n, 'index.html'), n); }
  // a site published with 2.3.6 (before records existed): found once in the approval history
  db.run("INSERT INTO approvals(tool,args,summary,status,created,expires,decided_at,result,channel) VALUES('github_publish',?,'x','done',1,2,3,?,'web')", JSON.stringify({ project: 'legacy', repo: 'legacy-site', pages: true }), JSON.stringify({ pushed: true, repo: 'https://github.com/abish/legacy-site', pages: 'https://abish.github.io/legacy-site/' }));
  sitesMod.record('cloudflare', 'proj-a', 'https://proj-a.pages.dev/');
  sitesMod.record('cloudflare', 'proj-gone', 'https://proj-gone.pages.dev/');
  sitesMod.record('github', 'abish/my-site', 'https://abish.github.io/my-site/', { pages: true, madeRepo: true });
  sitesMod.record('github', 'abish/old-app', 'https://github.com/abish/old-app', { pages: false });
});

test('Sites list (GET /api/projects): this server, every Cloudflare Pages project, and ONLY the GitHub repos it published', async () => {
  GH.calls.length = 0;
  const r = await call('/api/projects'); assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.j.sites.map(s => s.name).sort(), ['local-one', 'local-two']);
  const cf = Object.fromEntries(r.j.cloudflare.items.map(x => [x.name, x]));
  assert.equal(r.j.cloudflare.connected, true);
  assert.deepEqual(Object.keys(cf).sort(), ['proj-a', 'proj-b', 'proj-c', 'proj-gone']);
  assert.equal(cf['proj-a'].made_by_me, true); assert.equal(cf['proj-b'].made_by_me, false); assert.equal(cf['proj-a'].url, 'https://proj-a.pages.dev/');
  assert.equal(cf['proj-gone'].exists, false, 'recorded but no longer on Cloudflare');
  assert.deepEqual(r.j.github.items.map(x => x.name).sort(), ['abish/legacy-site', 'abish/my-site', 'abish/old-app'], 'incl. the one published before 2.3.7');
  assert.ok(!JSON.stringify(r.j).includes('private-stuff'), 'an unrelated repo is never listed');
  assert.ok(GH.calls.every(c => /^GET \/repos\/abish\/(legacy-site|my-site|old-app)$/.test(c)), 'GitHub is only asked about recorded repos: ' + GH.calls.join(', '));
  const gh = Object.fromEntries(r.j.github.items.map(x => [x.name, x]));
  assert.equal(gh['abish/my-site'].pages, true); assert.equal(gh['abish/old-app'].pages, false);
  assert.ok(!r.text.includes(GH_TOKEN) && !r.text.includes(CF_TOKEN), 'no token in the answer');
});

test('Delete needs confirm:true (the page asks "Are you sure?" first); without it nothing is touched', async () => {
  CF.calls.length = 0;
  let r = await call('/api/sites/remove', { platform: 'here', name: 'local-one' });
  assert.equal(r.status, 400); assert.match(r.j.error, /Not confirmed/);
  r = await call('/api/sites/remove', { platform: 'cloudflare', name: 'proj-a', action: 'delete' });
  assert.equal(r.status, 400);
  assert.ok(fs.existsSync(path.join(SITES, 'local-one'))); assert.deepEqual(CF.calls, []);
});

test('Delete a site on this server', async () => {
  const r = await call('/api/sites/remove', { platform: 'here', name: 'local-one', action: 'delete', confirm: true });
  assert.equal(r.status, 200, r.text); assert.match(r.j.message, /Deleted .*\/sites\/local-one\//);
  assert.ok(!fs.existsSync(path.join(SITES, 'local-one'))); assert.ok(fs.existsSync(path.join(SITES, 'local-two')));
  assert.ok(db.all("SELECT * FROM audit WHERE action='site.removed' AND actor='owner'").some(a => /here local-one/.test(a.detail)));
  const bad = await call('/api/sites/remove', { platform: 'here', name: '../etc', action: 'delete', confirm: true });
  assert.equal(bad.status, 400);
});

test('Cloudflare: a token without permission → a plain message naming the permission; nothing deleted', async () => {
  CF.deny = true;
  const r = await call('/api/sites/remove', { platform: 'cloudflare', name: 'proj-a', action: 'delete', confirm: true });
  CF.deny = false;
  assert.equal(r.status, 403); assert.match(r.j.error, /not allowed to delete Pages projects.*"Cloudflare Pages: Edit"/s); assert.match(r.j.error, /Nothing was deleted/);
  assert.ok(CF.projects.includes('proj-a')); assert.ok(sitesMod.recordOf('cloudflare', 'proj-a'));
});

test('Cloudflare: Delete removes the Pages project and its record; a project already gone just leaves the list', async () => {
  CF.calls.length = 0;
  let r = await call('/api/sites/remove', { platform: 'cloudflare', name: 'proj-a', action: 'delete', confirm: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(CF.calls, [`DELETE /accounts/${ACC}/pages/projects/proj-a`]);
  assert.ok(!CF.projects.includes('proj-a')); assert.equal(sitesMod.recordOf('cloudflare', 'proj-a'), undefined);
  r = await call('/api/sites/remove', { platform: 'cloudflare', name: 'proj-gone', action: 'forget', confirm: true });
  assert.equal(r.status, 200, r.text); assert.equal(sitesMod.recordOf('cloudflare', 'proj-gone'), undefined);
  assert.equal(CF.calls.length, 1, '"Remove from list" makes no Cloudflare call');
});

test('GitHub: Turn off Pages (repo stays), Delete repo refused without permission (plain message), then allowed', async () => {
  GH.calls.length = 0;
  let r = await call('/api/sites/remove', { platform: 'github', name: 'abish/my-site', action: 'pages_off', confirm: true });
  assert.equal(r.status, 200, r.text); assert.match(r.j.message, /Turned off GitHub Pages for abish\/my-site\. The repo is still there/);
  assert.equal(GH.repos['abish/my-site'].has_pages, false); assert.ok(GH.repos['abish/my-site']);
  assert.equal(sitesMod.recordOf('github', 'abish/my-site').pages, 0);
  GH.denyDelete = true;
  r = await call('/api/sites/remove', { platform: 'github', name: 'abish/my-site', action: 'delete_repo', confirm: true });
  GH.denyDelete = false;
  assert.equal(r.status, 403);
  assert.match(r.j.error, /not allowed to delete repositories/); assert.match(r.j.error, /"Administration: Read and write"/); assert.match(r.j.error, /"delete_repo"/);
  assert.ok(GH.repos['abish/my-site'], 'still there'); assert.ok(sitesMod.recordOf('github', 'abish/my-site'));
  GH.denyPages = true;
  r = await call('/api/sites/remove', { platform: 'github', name: 'abish/old-app', action: 'pages_off', confirm: true });
  GH.denyPages = false;
  assert.equal(r.status, 403); assert.match(r.j.error, /"Pages: Read and write"/);
  r = await call('/api/sites/remove', { platform: 'github', name: 'abish/my-site', action: 'delete_repo', confirm: true });
  assert.equal(r.status, 200, r.text); assert.ok(!GH.repos['abish/my-site']); assert.equal(sitesMod.recordOf('github', 'abish/my-site'), undefined);
  assert.ok(GH.calls.every(c => !/BADAUTH/.test(c)));
});

test('GitHub: a repo it did not publish can never be deleted (web or chat), and no GitHub call is made', async () => {
  GH.calls.length = 0;
  let r = await call('/api/sites/remove', { platform: 'github', name: 'abish/private-stuff', action: 'delete_repo', confirm: true });
  assert.equal(r.status, 400); assert.match(r.j.error, /only remove GitHub repos that I published myself/);
  const res = await tools.execTool('unpublish_site', { platform: 'github', name: 'abish/private-stuff', action: 'delete_repo' }, { channel: 'web', actor: 'assistant' });
  assert.match(res.error, /only remove GitHub repos that I published myself/);
  assert.deepEqual(GH.calls, []); assert.ok(GH.repos['abish/private-stuff']);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM approvals WHERE args LIKE '%private-stuff%'").n, 0, 'not even asked');
});

test('Chat: unpublish_site takes down a Cloudflare site only after his YES (approval flow)', async () => {
  CF.calls.length = 0;
  const job = await ask('UNPUB cloudflare proj-b delete');
  assert.match(job.result, /^\(the approval request A\d+ was the answer\)$/);   // 2.3.16: no second message about it
  const ap = db.get("SELECT * FROM approvals WHERE tool='unpublish_site' ORDER BY id DESC");
  assert.equal(ap.status, 'pending'); assert.match(ap.summary, /Delete the Cloudflare Pages project "proj-b"/);
  assert.deepEqual(CF.calls, [], 'nothing deleted before YES');
  const r = await call('/api/chat', { text: 'YES A' + ap.id }); assert.equal(r.status, 200, r.text);
  assert.equal(r.j.decided.ok, true, JSON.stringify(r.j.decided)); assert.match(r.j.decided.message, /Deleted the Cloudflare site proj-b/);
  assert.deepEqual(CF.calls, [`DELETE /accounts/${ACC}/pages/projects/proj-b`]);
});

test('Chat: GitHub needs a clear action; NO leaves everything; the tool description names the options', async () => {
  let res = await tools.execTool('unpublish_site', { platform: 'github', name: 'abish/old-app' }, { channel: 'web', actor: 'assistant' });
  assert.match(res.error, /pages_off.*delete_repo/s);
  res = await tools.execTool('unpublish_site', { platform: 'github', name: 'abish/old-app', action: 'delete_repo' }, { channel: 'web', actor: 'assistant' });
  assert.equal(res.status, 'waiting_for_owner_approval');
  const ap = db.get("SELECT * FROM approvals WHERE tool='unpublish_site' ORDER BY id DESC");
  assert.match(ap.summary, /DELETE the GitHub repository abish\/old-app/);
  const r = await call('/api/chat', { text: 'NO A' + ap.id }); assert.equal(r.status, 200);
  assert.ok(GH.repos['abish/old-app'], 'NO: still there');
  const d = tools.declarations({}).find(t => t.name === 'unpublish_site');
  assert.deepEqual(d.parameters.properties.platform.enum, ['here', 'cloudflare', 'github']);
  assert.deepEqual(d.parameters.properties.action.enum, ['pages_off', 'delete_repo']);
});

test('the page: Sites list with Delete buttons that ask "Are you sure?" first', async () => {
  const app = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /confirm\('Are you sure\?/); assert.match(app, /\/api\/sites\/remove/); assert.match(app, /confirm: true/);
  for (const label of ["'Delete'", "'Turn off Pages'", "'Delete repo'", "'Remove from list'"]) assert.ok(app.includes(label), label);
});

test('no token or key in the Activity log or the server log', async () => {
  const text = JSON.stringify(db.all('SELECT * FROM audit')) + LOGS.join('\n') + JSON.stringify(db.all('SELECT * FROM approvals'));
  for (const s of [GH_TOKEN, CF_TOKEN, KEY]) assert.ok(!text.includes(s));
});
