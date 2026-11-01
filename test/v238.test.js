// 2.3.8: browser hands (the AI drives a real hidden Chromium), account sign-ups (asks first, reads the code from Gmail,
// saves the password encrypted, saves a new API key into Settings), and the owner's live "please help" page.
// The browser tests run for real when Chromium is on this machine and are skipped (with a reason) when not.
// Everything is local: a small test website (test/signup-site.js), a fake Gmail (test/fakes.js) and a fake model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOGS = [];
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { LOGS.push(a.map(String).join(' ')); if (process.env.SHOW_LOGS) orig(...a); }; }
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v238-'));
const DATA = T + '/data', WS = T + '/ws', SITES = T + '/sites';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = 21500 + Math.floor(Math.random() * 150);
const { fakeServer } = await import('./fakes.js');
const fake = await fakeServer();
Object.assign(process.env, {
  MA_DATA_DIR: DATA, MA_WORKSPACE: WS, MA_SITES_DIR: SITES, MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_RELEASE_BASE: 'http://127.0.0.1:1',
  MA_MOCK_MODULE: new URL('./mock-model-v238.js', import.meta.url).href, MA_WA_AGENT_BASE: 'http://127.0.0.1:1/agent/v1',
  MA_GOOGLE_BASE: fake.url, MA_SIGNUP_POLL_MS: '300', MA_BROWSER_PROFILE: T + '/profile',
});
const { start } = await import('../src/server.js');
const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const tools = await import('../src/tools/index.js');
const brain = await import('../src/brain.js');
const aikeys = await import('../src/aikeys.js');
const logins = await import('../src/logins.js');
const core = await import('../src/browser-core.js');
const bt = await import('../src/tools/browser.js');
const { seal } = await import('../src/crypto.js');
const { findChromium, BROWSER_CMD } = await import('../src/tools/sitecheck.js');
const { signupSite } = await import('./signup-site.js');
const server = start();
await sleep(300);
db.setSetting('setup_done', '1'); db.setSecret('gemini_api_key', 'AIzaFAKE' + 'x'.repeat(30));
// a connected Gmail (the fake Google server answers it)
db.setSetting('google_client_id', 'cid'); db.setSecret('google_client_secret', 'csecret-123456');
db.run("INSERT INTO google_accounts(email,name,scopes,token,added,status) VALUES('abish@example.com','Abish','email',?,?,'ok')", seal('1//fakeRefresh'), Date.now());
const site = await signupSite({ onEmail: (m) => fake.state.inbox.push({ id: 'm' + (fake.state.inbox.length + 1), threadId: 't1', from: m.from, subject: m.subject, text: m.text }) });
const BASE = 'http://127.0.0.1:' + PORT;
const S = auth.newSession('127.0.0.1', 'test');
const cookie = S.cookie.split(';')[0], csrf = S.csrf;
async function call(p, body, { noAuth = false } = {}) {
  const r = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: { ...(noAuth ? {} : { Cookie: cookie }), ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-CSRF': csrf } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
}
async function waitJob(id, ms = 120000) { const end = Date.now() + ms; while (Date.now() < end) { const j = db.get('SELECT * FROM jobs WHERE id=?', id); if (['done', 'error'].includes(j.status)) return j; await sleep(50); } throw new Error('job did not finish'); }
async function waitFor(fn, ms = 60000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); } throw new Error('timed out waiting'); }
async function ask(text) { const r = await call('/api/chat', { text }); assert.equal(r.status, 200, r.text); return waitJob(r.j.job); }
const lastReply = () => db.get("SELECT text FROM messages WHERE role='assistant' ORDER BY id DESC LIMIT 1")?.text || '';
const everything = () => ['job_events', 'messages', 'audit', 'approvals', 'settings'].map(t => JSON.stringify(db.all(`SELECT * FROM ${t}`))).join('\n') + LOGS.join('\n');
const ctx = () => ({ jobId: null, chatId: null, channel: 'web', actor: 'assistant' });
test.after(async () => { await core.closeBrowser('tests done'); site.close(); fake.close(); server.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 1500); });

const BROWSER = findChromium();
const noBrowser = BROWSER ? false : 'no Chromium on this machine (optional/install-browser.sh)';
const NAMES = ['browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_select', 'browser_key', 'browser_scroll', 'browser_wait', 'browser_screenshot', 'browser_back', 'browser_close',
  'browser_handoff', 'signup_start', 'browser_new_password', 'browser_signup_submit', 'signup_check_email', 'browser_fill_login', 'browser_save_key'];

test('the browser tools are registered and the AI is told to use them instead of refusing', () => {
  const names = tools.toolList().map(t => t.name);
  for (const n of NAMES) assert.ok(names.includes(n), n);
  const decl = tools.declarations().map(d => d.name);
  for (const n of NAMES) assert.ok(decl.includes(n), n + ' offered to the model');
  assert.equal(tools.declarations().find(d => d.name === 'browser_new_password').parameters.properties.elements.type, 'array');
  for (const n of ['browser_signup_submit', 'browser_save_key']) assert.ok(tools.toolList().find(t => t.name === n).approval, n + ' needs YES');
  const p = brain.systemPrompt('whatsapp_agent');
  if (BROWSER) {
    assert.match(p, /never say you cannot sign up/i);
    assert.match(p, /browser_signup_submit/);
    assert.match(p, /browser_handoff/);
    assert.match(p, /Never pay/);
  }
});

test('"Browser actions" off: the tools disappear for the model and refuse to run', async () => {
  db.setSetting('browser_actions', '0');
  try {
    const decl = tools.declarations().map(d => d.name);
    for (const n of NAMES) assert.ok(!decl.includes(n), n + ' hidden');
    assert.ok(decl.includes('site_screenshot'), 'other tools stay');
    const r = await tools.execTool('browser_open', { url: 'https://example.com' }, ctx());
    assert.match(r.error, /switched off/);
    assert.match(brain.systemPrompt('web'), /switched off by the owner/);
    const st = await call('/api/browser');
    assert.equal(st.j.enabled, false);
  } finally { db.setSetting('browser_actions', ''); }
  const on = await call('/api/browser/settings', { enabled: true });
  assert.equal(on.j.enabled, true);
  assert.equal(db.setting('browser_actions'), '1');
});

test('no browser installed: the tools say exactly which command to run', async () => {
  const keep = process.env.MA_CHROMIUM;
  process.env.MA_CHROMIUM = '';
  try {
    const r = await tools.execTool('browser_open', { url: 'https://example.com' }, ctx());
    assert.match(r.error, /install-browser\.sh/);
    assert.equal(r.setup_command, 'sudo bash /opt/myassistant/current/optional/install-browser.sh');
    assert.match(brain.systemPrompt('web'), /sudo bash \/opt\/myassistant\/current\/optional\/install-browser\.sh/);
    assert.equal((await call('/api/browser')).j.installed, false);
  } finally { if (keep === undefined) delete process.env.MA_CHROMIUM; else process.env.MA_CHROMIUM = keep; }
});

test('secret typing never reaches Activity or the audit log', () => {
  const s = tools.summarizeArgs({ element: 4, text: '493817', secret: true });
  assert.equal(s.text, '(hidden)'); assert.equal(s.element, 4);
  assert.equal(tools.summarizeArgs({ element: 4, text: 'hello' }).text, 'hello');
});

test('codes and confirm links are found in sign-up emails', () => {
  const a = bt.findCodes('Your verification code', 'Hi,\nYour verification code is 482913.\nConfirm: https://x.dev/verify?token=abc\nUnsubscribe: https://x.dev/unsubscribe\n© 2026', '');
  assert.deepEqual(a.codes, ['482913']);
  assert.deepEqual(a.links, ['https://x.dev/verify?token=abc']);
  const b = bt.findCodes('Welcome', '', '<p>Use code <b>ABC-123</b></p><a href="https://app.y.com/auth/confirm?t=1&amp;u=2">Confirm email</a><a href="https://y.com/privacy">Privacy</a>');
  assert.deepEqual(b.codes, ['ABC-123']);
  assert.deepEqual(b.links, ['https://app.y.com/auth/confirm?t=1&u=2']);
});

test('new passwords are strong and site names are tidy', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const p = logins.newPassword();
    assert.equal(p.length, 20);
    assert.match(p, /[A-Z]/); assert.match(p, /[a-z]/); assert.match(p, /[0-9]/); assert.match(p, /[!@#%*\-_+?]/);
    seen.add(p);
  }
  assert.equal(seen.size, 50);
  assert.equal(logins.siteKey('https://www.Example.com/signup?x=1'), 'example.com');
  assert.equal(logins.siteKey('app.groq.com'), 'app.groq.com');
});

test('Saved logins: listed without passwords; Show needs the login session; Delete removes the secret', async () => {
  const id = logins.saveLogin({ site: 'https://www.demo-site.com/join', email: 'abish@example.com', password: 'Zq7!demo-pass-123456' });
  const list = await call('/api/browser');
  assert.equal(list.status, 200);
  const row = list.j.logins.find(x => x.id === id);
  assert.equal(row.site, 'demo-site.com'); assert.equal(row.email, 'abish@example.com');
  assert.ok(!list.text.includes('Zq7!demo-pass-123456'), 'no password in the list');
  assert.equal((await call('/api/browser', undefined, { noAuth: true })).status, 401);
  const noCsrf = await fetch(BASE + `/api/logins/${id}/show`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403);
  const shown = await call(`/api/logins/${id}/show`, {});
  assert.equal(shown.j.password, 'Zq7!demo-pass-123456');
  const au = db.all("SELECT * FROM audit WHERE action='login.shown'");
  assert.ok(au.length >= 1 && !JSON.stringify(au).includes('Zq7!'));
  assert.ok(db.hasSecret('login_pw_' + id));
  assert.ok(!JSON.stringify(db.all('SELECT * FROM secrets')).includes('Zq7!demo'), 'stored encrypted');
  assert.equal((await call(`/api/logins/${id}/remove`, {})).status, 200);
  assert.ok(!db.hasSecret('login_pw_' + id));
  assert.equal((await call(`/api/logins/${id}/show`, {})).status, 404);
});

test('real browser: open, read (numbered elements), type, select, tick, scroll, key, back, screenshot', { skip: noBrowser }, async () => {
  const o = await tools.execTool('browser_open', { url: site.url + '/signup' }, ctx());
  assert.ok(o.ok, JSON.stringify(o));
  assert.equal(o.title, 'Create your account');
  assert.match(o.elements, /\[\d+\] input "Full name" \(required\)/);
  assert.match(o.elements, /\[\d+\] select "Country" = "Choose…" options: Choose… \| United States \| Israel/);
  assert.match(o.elements, /\[\d+\] checkbox "I agree to the terms" \(not checked\)/, 'a hidden styled checkbox is still listed by its label');
  const n = (re) => Number(new RegExp('\\[(\\d+)\\][^\\n]*' + re).exec(o.elements)[1]);
  assert.ok((await tools.execTool('browser_type', { element: n('"Full name"'), text: 'Abish' }, ctx())).ok);
  assert.ok((await tools.execTool('browser_select', { element: n('select'), option: 'united states' }, ctx())).ok);
  assert.ok((await tools.execTool('browser_click', { element: n('checkbox') }, ctx())).ok);
  const bad = await tools.execTool('browser_select', { element: n('select'), option: 'Mars' }, ctx());
  assert.match(bad.error, /No option "Mars".*Israel/);
  const gone = await tools.execTool('browser_click', { element: 999 }, ctx());
  assert.match(gone.error, /no element \[999\].*browser_read/);
  const r = await tools.execTool('browser_read', {}, ctx());
  assert.match(r.elements, /"Full name" = "Abish"/);
  assert.match(r.elements, /= "United States"/);
  assert.match(r.elements, /checkbox "I agree to the terms" \(checked\)/);
  assert.ok((await tools.execTool('browser_scroll', { direction: 'bottom' }, ctx())).ok);
  assert.ok((await tools.execTool('browser_key', { key: 'Tab' }, ctx())).ok);
  assert.match((await tools.execTool('browser_key', { key: 'F13' }, ctx())).error, /Unknown key/);
  assert.ok((await tools.execTool('browser_open', { url: site.url + '/' }, ctx())).ok);
  const b = await tools.execTool('browser_back', {}, ctx());
  assert.match(b.url, /\/signup$/);
  const shot = await tools.execTool('browser_screenshot', {}, ctx());
  assert.ok(shot.ok); assert.equal(shot._see.length, 1); assert.equal(shot._see[0].mime, 'image/jpeg');
  assert.ok(fs.statSync(path.join(WS, shot.saved)).size > 1000);
  const w = await tools.execTool('browser_wait', { seconds: 3, for_text: 'Create your account' }, ctx());
  assert.equal(w.found, true);
  assert.match((await tools.execTool('browser_open', { url: 'ftp://x' }, ctx())).error, /Only http/);
});

test('real browser: the whole sign-up — YES first, code from Gmail, password saved encrypted, API key saved into AI keys', { skip: noBrowser }, async () => {
  const G = globalThis.__v238 = {};
  const j1 = await ask('SIGNUP ' + site.url);
  assert.equal(j1.status, 'done');
  // pressing the form's button directly is refused: it must go through the owner's YES
  assert.match(G.refused.error, /browser_signup_submit/);
  assert.equal(site.state.users.size, 0, 'nothing was sent before YES');
  const ap = db.get("SELECT * FROM approvals WHERE tool='browser_signup_submit' ORDER BY id DESC LIMIT 1");
  assert.equal(ap.status, 'pending');
  assert.equal(ap.summary.split('\n')[0], 'Sign up at 127.0.0.1 with abish@example.com?');
  assert.match(lastReply(), new RegExp('A' + ap.id));
  const yes = await call(`/api/approvals/${ap.id}`, { yes: true });
  assert.equal(yes.status, 200, yes.text); assert.ok(yes.j.ok, yes.text);
  const user = site.state.users.get('abish@example.com');
  assert.ok(user, 'account made at the site');
  assert.equal(user.name, 'Abish Test'); assert.equal(user.country, 'il');
  const saved = logins.findLogin('127.0.0.1', 'abish@example.com');
  assert.equal(logins.loginPassword(saved.id), user.password, 'the password the site got is the one saved');
  // the continuation reads the code from Gmail, verifies, makes a key and asks to save it
  const cont = await waitFor(() => db.get('SELECT * FROM jobs WHERE parent_approval=?', ap.id));
  await waitJob(cont.id);
  assert.equal(user.verified, true, 'email confirmed with the code from Gmail');
  assert.equal(G.mail.codes[0], user.code);
  assert.equal(site.state.keys.length, 1);
  const theKey = site.state.keys[0].key;
  assert.ok(!JSON.stringify(G.keyPage).includes(theKey), 'the AI never saw the key: ' + G.keyPage.text);
  assert.match(G.keyPage.text, /‹hidden-\d+›/);
  const ap2 = db.get("SELECT * FROM approvals WHERE tool='browser_save_key' ORDER BY id DESC LIMIT 1");
  assert.equal(ap2.summary.split('\n')[0], 'Save the new API key from 127.0.0.1 into Settings → Brain → AI keys as "LocalTest (free)"?');
  const yes2 = await call(`/api/approvals/${ap2.id}`, { yes: true });
  assert.ok(yes2.j.ok, yes2.text);
  const k = aikeys.listKeys().find(x => x.name === 'LocalTest (free)');
  assert.ok(k, 'key listed in AI keys'); assert.equal(k.kind, 'openai'); assert.equal(k.model, 'pic-1'); assert.deepEqual(k.use_for, ['pictures']);
  assert.equal(aikeys.keyValue(k.id), theKey);
  assert.equal(logins.findLogin('127.0.0.1', 'abish@example.com').status, 'signed up');
  // nothing secret leaked anywhere: chat, Activity, audit, approvals, logs
  const all = everything();
  assert.ok(!all.includes(user.password), 'password not in chat/Activity/logs');
  assert.ok(!all.includes(theKey), 'key not in chat/Activity/logs');
  const typed = db.all("SELECT text FROM job_events WHERE kind='tool' AND text LIKE 'browser_type%secret%'");
  assert.ok(typed.length && typed.every(e => e.text.includes('(hidden)') && !e.text.includes(user.code)), 'secret-typed code shows as (hidden) in Activity');
  assert.ok(site.state.posts.some(p => p.path === '/verify'));
});

test('real browser: log back in with the saved login, and cookies survive closing the browser', { skip: noBrowser }, async () => {
  const G = globalThis.__v238;
  await core.closeBrowser('test');
  const o = await tools.execTool('browser_open', { url: site.url + '/dashboard' }, ctx());
  assert.equal(o.title, 'Dashboard', 'still logged in after a restart (profile kept)');
  // clear the site cookie, then log in with browser_fill_login
  await core.evaluate("document.cookie = 'lt_user=; Path=/; Max-Age=0'");
  const j = await ask('LOGIN ' + site.url);
  assert.equal(j.status, 'done');
  assert.equal(G.loginPage.title, 'Dashboard');
  assert.ok(!everything().includes(site.state.users.get('abish@example.com').password));
});

test('real browser: robot check → link to the live page → owner taps it there → Done continues the job', { skip: noBrowser }, async () => {
  const G = globalThis.__v238;
  const j = await ask('ROBOT ' + site.url);
  assert.equal(j.status, 'done');
  assert.match(G.robotRead.robot_check, /browser_handoff/);
  const note = db.get("SELECT text FROM messages WHERE text LIKE 'Please tap the robot check here%' ORDER BY id DESC LIMIT 1");
  assert.ok(note, 'owner got the link');
  assert.ok(note.text.endsWith('\n' + BASE + '/#/live'), note.text);
  assert.match(note.text, /reply done/);
  const st = await call('/api/browser');
  assert.equal(st.j.session.handoff.reason, 'tap the robot check');
  const live = await call('/api/browser/live');
  assert.equal(live.j.active, true); assert.match(live.j.img, /^data:image\/jpeg;base64,\/9j/); assert.equal(live.j.w, 1280);
  assert.equal(live.j.handoff.reason, 'tap the robot check');
  assert.equal((await call('/api/browser/live', undefined, { noAuth: true })).status, 401, 'only when logged in');
  const pos = await core.evaluate("(() => { const r = document.querySelector('button').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
  const tap = await call('/api/browser/live/input', { kind: 'tap', x: pos.x, y: pos.y });
  assert.equal(tap.status, 200, tap.text);
  await waitFor(() => site.state.robotPassed);
  assert.equal((await call('/api/browser/live/input', { kind: 'scroll', dy: 300 })).status, 200);
  assert.equal((await call('/api/browser/live/input', { kind: 'nope' })).status, 500);
  const done = await call('/api/browser/live/done', {});
  assert.equal(done.j.continued, true);
  await waitFor(() => G.afterDone);
  assert.equal(G.afterDone.title, 'Thanks, human');
  assert.equal(core.sessionInfo().handoff, null);
});

test('real browser: never types card details or a phone number', { skip: noBrowser }, async () => {
  const o = await tools.execTool('browser_open', { url: site.url + '/billing' }, ctx());
  const n = (re) => Number(new RegExp('\\[(\\d+)\\][^\\n]*' + re).exec(o.elements)[1]);
  assert.match((await tools.execTool('browser_type', { element: n('"Card number"'), text: '4242 4242 4242 4242' }, ctx())).error, /never type those/);
  assert.match((await tools.execTool('browser_type', { element: n('"Mobile phone"'), text: '+15555550100' }, ctx())).error, /phone number/);
  assert.match((await tools.execTool('browser_type', { element: n('"Name on card"'), text: '4242424242424242' }, ctx())).error, /never type those/, 'a card number is refused in any box');
  assert.ok((await tools.execTool('browser_type', { element: n('"Name on card"'), text: 'Abish' }, ctx())).ok);
});

test('real browser: it closes itself when idle (and the switch off closes it too)', { skip: noBrowser }, async () => {
  await core.closeBrowser('test');
  process.env.MA_BROWSER_IDLE_MS = '400'; process.env.MA_BROWSER_IDLE_TICK_MS = '200';
  try {
    const o1 = await tools.execTool('browser_open', { url: site.url + '/' }, ctx());
    assert.ok(o1.ok, JSON.stringify(o1));
    assert.equal(core.sessionInfo().open, true);
    await waitFor(() => !core.sessionInfo().open, 10000);
    const closed = db.all("SELECT * FROM audit WHERE action='browser.closed'");
    assert.ok(closed.some(a => /idle/.test(a.detail)), JSON.stringify(closed));
  } finally { delete process.env.MA_BROWSER_IDLE_MS; delete process.env.MA_BROWSER_IDLE_TICK_MS; }
  assert.ok((await tools.execTool('browser_open', { url: site.url + '/' }, ctx())).ok);
  await call('/api/browser/settings', { enabled: false });
  await waitFor(() => !core.sessionInfo().open, 10000);
  await call('/api/browser/settings', { enabled: true });
});
