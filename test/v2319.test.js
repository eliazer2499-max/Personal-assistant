// 2.3.19 (Abish, WhatsApp Nov 8 2026 11:32 AM: "So I want ai.louisb.vip to be the default. You told me to write a
// command. But if its possible without it will be better"): Settings → Main address.
// Shows the main address + the others this server answers on; Check (points to this server + opens this same assistant
// over https) refuses a bad one in plain words; Switch writes a request for the root-owned update unit (the same narrow
// sudo rule as Update now) which re-runs the installer's address step: MA_PUBLIC_URL = new, the old main moves into
// MA_EXTRA_DOMAINS, every other env line stays, and a later update keeps the choice. Webhooks follow the new address.
// All local: fake DNS answers, a fake "other server", a fake Telegram API, and the installer in its dry-run mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const LOGS = [];
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { LOGS.push(a.map(String).join(' ')); if (process.env.SHOW_LOGS) orig(...a); }; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v2319-'));
const DATA = T + '/data';
const PORT = 21700 + Math.floor(Math.random() * 150);
const BASE = 'http://127.0.0.1:' + PORT;
const MAIN = '96-250-207-131.sslip.io', IP = '96.250.207.131';

// another web server that answers the check, but is not this assistant
const other = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end('{"ok":true,"code":"not-yours"}'); });
await new Promise(r => other.listen(0, '127.0.0.1', r));
// a fake Telegram API
const TG = { info: '', set: [] };
const tg = http.createServer(async (q, s) => {
  let raw = ''; for await (const c of q) raw += c; const b = raw ? JSON.parse(raw) : {};
  const J = (o) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(o)); };
  if (q.url.endsWith('/getWebhookInfo')) return J({ ok: true, result: { url: TG.info } });
  if (q.url.endsWith('/setWebhook')) { TG.set.push(b); TG.info = b.url; return J({ ok: true, result: true }); }
  return J({ ok: false, description: 'no' });
});
await new Promise(r => tg.listen(0, '127.0.0.1', r));
const CADDY = T + '/Caddyfile';
fs.writeFileSync(CADDY, `# My Assistant (managed by its installer)\n\n${MAIN}, ai.louisb.vip, old.example.org {\n\tencode gzip\n}\n`);

Object.assign(process.env, {
  MA_DATA_DIR: DATA, MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/sites', MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'https://' + MAIN, MA_EXTRA_DOMAINS: 'ai.louisb.vip,broken.example.com', MA_CADDYFILE: CADDY,
  MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_RELEASE_BASE: 'http://127.0.0.1:1', MA_WA_AGENT_BASE: 'http://127.0.0.1:1/agent/v1',
  MA_TELEGRAM_BASE: 'http://127.0.0.1:' + tg.address().port,
  MA_TEST_DNS: JSON.stringify({ [MAIN]: [IP], 'ai.louisb.vip': [IP], 'new.example.com': [IP], 'broken.example.com': [IP], 'other.example.com': [IP],
    'elsewhere.example.com': ['1.2.3.4'], 'proxied.example.com': ['104.16.1.1'], 'old.example.org': [IP] }),
  MA_TEST_PROBE: JSON.stringify({ 'ai.louisb.vip': BASE, 'proxied.example.com': BASE, 'old.example.org': BASE, 'other.example.com': 'http://127.0.0.1:' + other.address().port }),
});
const { start } = await import('../src/server.js');
const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const address = await import('../src/address.js');
const { cfg } = await import('../src/config.js');
const server = start();
await sleep(300);
db.setSetting('setup_done', '1');
const S = auth.newSession('127.0.0.1', 'test');
const cookie = S.cookie.split(';')[0], csrf = S.csrf;
async function call(p, body, { noAuth = false } = {}) {
  const r = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: { ...(noAuth ? {} : { Cookie: cookie }), ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-CSRF': csrf } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
}
test.after(() => { server.close(); other.close(); tg.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 300); });
const REQ = path.join(DATA, 'address-request');

// ---------------- validation ----------------
test('address: what he types is cleaned up (https://, capitals, a slash at the end) — anything else gets plain words', () => {
  assert.equal(address.normalizeHost('ai.louisb.vip'), 'ai.louisb.vip');
  assert.equal(address.normalizeHost('  HTTPS://AI.LouisB.vip/ '), 'ai.louisb.vip');
  assert.equal(address.normalizeHost('http://ai.louisb.vip'), 'ai.louisb.vip');
  assert.equal(address.normalizeHost('ai.louisb.vip.'), 'ai.louisb.vip');
  const bad = { '': /Type an address/, 'ai louisb.vip': /no spaces/, '96.250.207.131': /not a number address/, 'ai.louisb.vip:8443': /port/,
    'ai.louisb.vip/admin': /without anything after it/, 'ftp://ai.louisb.vip': /just the address/, 'localhost': /not a valid address/, '-x.example.com': /not a valid address/,
    'a..b.com': /not a valid address|not a web address/, ['x'.repeat(250) + '.com']: /not a valid address|not a web address/, 'ai.louisb.vip?x=1': /without anything after it/,
    'me@ai.louisb.vip': /just the address/, 'ai.example.123': /not a valid address|not a web address/ };
  for (const [v, re] of Object.entries(bad)) assert.throws(() => address.normalizeHost(v), (e) => { assert.match(e.message, re, v); assert.equal(e.status, 400); assert.doesNotMatch(e.message, /regex|ERR_|Caddy|undefined/); return true; }, v);
});

test('address page: needs his sign-in; shows the main address and every other address this server answers on', async () => {
  assert.equal((await call('/api/address', undefined, { noAuth: true })).status, 401);
  assert.equal((await call('/api/address/switch', { address: 'ai.louisb.vip', confirm: true }, { noAuth: true })).status, 401);
  const r = await call('/api/address');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.main, MAIN); assert.equal(r.j.main_url, 'https://' + MAIN);
  assert.deepEqual(r.j.extras, ['ai.louisb.vip', 'broken.example.com', 'old.example.org'], 'env extras + a host added by hand to the web server file; never the main one');
  assert.equal(r.j.pending, null); assert.equal(r.j.result, null);
});

// ---------------- the check ----------------
test('check: ai.louisb.vip (points here, opens this same assistant over https) → ready to switch', async () => {
  const r = await call('/api/address/check', { address: 'ai.louisb.vip' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.ok, true); assert.equal(r.j.ready, true); assert.equal(r.j.dns_ok, true); assert.equal(r.j.host, 'ai.louisb.vip');
  assert.match(r.j.message, /opens this assistant over https\. Ready to switch\./);
});
test('check: refuses a bad domain in plain words, and changes nothing', async () => {
  const cases = [
    ['elsewhere.example.com', 'wrong_dns', /elsewhere\.example\.com points to 1\.2\.3\.4, but this server is 96\.250\.207\.131\. Change its A record to 96\.250\.207\.131/],
    ['nowhere.example.com', 'no_dns', /doesn't point anywhere yet\. Where you bought the domain, add an A record for it pointing to 96\.250\.207\.131/],
    ['other.example.com', 'other_server', /answers, but it is not this assistant/],
    ['broken.example.com', 'no_https', /points to this server, but its secure page did not open/],
    [MAIN, 'same', /is already the main address/],
  ];
  for (const [h, code, re] of cases) {
    const r = await call('/api/address/check', { address: h });
    assert.equal(r.status, 200, r.text); assert.equal(r.j.ok, false, h); assert.equal(r.j.code, code, h); assert.match(r.j.message, re, h);
    if (code !== 'same') { assert.match(r.j.message, /Nothing was changed\./, h); assert.doesNotMatch(r.j.message, /Caddy|sslip|ECONN|ENOTFOUND|undefined|null/, h); }
  }
  const bad = await call('/api/address/check', { address: 'ai.louisb.vip:8443' });
  assert.equal(bad.status, 400); assert.match(bad.j.error, /port/);
  assert.equal(fs.existsSync(REQ), false, 'a check never asks for a switch');
  assert.equal(cfg.publicUrl, 'https://' + MAIN);
});
test('check: an address that goes through another server first, but opens this assistant, is fine (with a note)', async () => {
  const r = await call('/api/address/check', { address: 'proxied.example.com' });
  assert.equal(r.j.ok, true); assert.equal(r.j.dns_ok, false); assert.match(r.j.message, /goes through another server/);
});
test('check: a new address that points here but is not set up yet → allowed; the switch sets it up and tests it again', async () => {
  const r = await call('/api/address/check', { address: 'new.example.com' });
  assert.equal(r.j.ok, true); assert.equal(r.j.ready, false); assert.equal(r.j.code, 'new');
  assert.match(r.j.message, /isn't set up here yet.*tests it again\. If that test fails, nothing changes\./);
});
test('the "is it this assistant?" page needs no sign-in and answers only the one-time code it just made', async () => {
  const n = address.newNonce();
  const a = await call('/api/address-check/' + n, undefined, { noAuth: true });
  assert.equal(a.status, 200); assert.equal(a.j.code, n);
  for (const x of ['wrongcode123', n + 'x', 'abc']) assert.equal((await call('/api/address-check/' + x, undefined, { noAuth: true })).status, 404, x);
  assert.equal((await call('/api/address-check/' + encodeURIComponent('../../x'), undefined, { noAuth: true })).status, 401, 'anything else under /api/ still needs sign-in');
  db.setSetting('address_nonce', n + ':' + (Date.now() - 1));
  assert.equal((await call('/api/address-check/' + n, undefined, { noAuth: true })).status, 404, 'an old code is not answered');
});

// ---------------- the switch ----------------
test('switch: the old main address moves to the extra ones; nothing else is lost; a bad address is refused before anything', async () => {
  assert.deepEqual(address.newExtras('ai.louisb.vip', MAIN, ['ai.louisb.vip', 'broken.example.com']), ['broken.example.com', MAIN]);
  assert.deepEqual(address.newExtras('new.example.com', MAIN, ['ai.louisb.vip']), ['ai.louisb.vip', MAIN]);
  assert.deepEqual(address.newExtras('x.example.com', '127.0.0.1', []), [], 'a non-name old address is not carried');
  const nc = await call('/api/address/switch', { address: 'ai.louisb.vip' });
  assert.equal(nc.status, 400); assert.match(nc.j.error, /Not confirmed/);
  const no = await call('/api/address/switch', { address: 'elsewhere.example.com', confirm: true });
  assert.equal(no.status, 400); assert.match(no.j.error, /points to 1\.2\.3\.4/);
  assert.equal(fs.existsSync(REQ), false);
  assert.ok(db.all("SELECT * FROM audit WHERE action='address.refused'").length >= 1);
});
test('switch to ai.louisb.vip: writes the request for the update unit (same narrow sudo rule as Update now), shows "switching"', async () => {
  const r = await call('/api/address/switch', { address: 'ai.louisb.vip', confirm: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.to, 'ai.louisb.vip'); assert.deepEqual(r.j.extras, ['broken.example.com', 'old.example.org', MAIN]);
  const body = fs.readFileSync(REQ, 'utf8');
  assert.match(body, /^main=ai\.louisb\.vip$/m);
  assert.match(body, new RegExp('^extra=broken\\.example\\.com,old\\.example\\.org,' + MAIN.replace(/\./g, '\\.') + '$', 'm'));
  assert.match(body, new RegExp('^old=' + MAIN.replace(/\./g, '\\.') + '$', 'm'));
  const nonce = /^nonce=([A-Za-z0-9]+)$/m.exec(body)[1];
  assert.ok(nonce.length >= 8); assert.equal(address.nonceAnswer(nonce).code, nonce, 'the unit can test the new address with it after the restart');
  const at = Number(/^at=(\d+)$/m.exec(body)[1]); assert.ok(Math.abs(at - Date.now() / 1000) < 10);
  assert.equal(fs.statSync(REQ).mode & 0o777, 0o600);
  const src = fs.readFileSync(new URL('../src/address.js', import.meta.url), 'utf8');
  assert.match(src, /spawn\('sudo', \['-n', '\/usr\/bin\/systemctl', 'start', '--no-block', cfg\.updateUnit\]/, 'the same command as Update now');
  const g = await call('/api/address');
  assert.equal(g.j.pending.to, 'ai.louisb.vip');
  assert.equal(cfg.publicUrl, 'https://' + MAIN, 'nothing switches inside the app: the unit does it and restarts it');
  // the unit finished: its result shows, "switching" goes away
  fs.writeFileSync(path.join(DATA, 'address-result'), `state=ok\nmain=ai.louisb.vip\nmessage=The main address is now https://ai.louisb.vip. The old address https://${MAIN} keeps working.\nat=${Math.floor(Date.now() / 1000) + 1}\n`);
  const d = await call('/api/address');
  assert.equal(d.j.pending, null); assert.equal(d.j.result.state, 'ok'); assert.equal(d.j.result.main, 'ai.louisb.vip');
  fs.rmSync(REQ, { force: true });
});
test('after the switch everything that uses the main address follows it: links, sites, sign-in return page, prompt, live view', async () => {
  const google = await import('../src/google.js'); const brain = await import('../src/brain.js'); const bt = await import('../src/tools/browser.js');
  fs.mkdirSync(path.join(T, 'sites', 'demo'), { recursive: true }); fs.writeFileSync(path.join(T, 'sites', 'demo', 'index.html'), 'hi');
  const prev = cfg.publicUrl; cfg.publicUrl = 'https://ai.louisb.vip';   // what the restarted service reads from the env file
  try {
    assert.equal(google.redirectUri(), 'https://ai.louisb.vip/oauth/google/callback');
    assert.equal(bt.liveLink(), 'https://ai.louisb.vip/#/live');
    assert.match(brain.systemPrompt('web'), /Public address of this assistant: https:\/\/ai\.louisb\.vip/);
    const pr = await call('/api/projects'); assert.ok(JSON.stringify(pr.j).includes('https://ai.louisb.vip/sites/demo/'), 'site links: ' + JSON.stringify(pr.j).slice(0, 300));
    const me = await call('/api/me'); assert.equal(me.j.public_url, 'https://ai.louisb.vip');
    const g = await call('/api/google'); assert.equal(g.j.javascript_origin, 'https://ai.louisb.vip');
  } finally { cfg.publicUrl = prev; }
});
test('Telegram webhook: re-registered automatically on the new address (same secret, no messages dropped); left alone when it is right', async () => {
  db.setSecret('telegram_token', '123456789:' + 'A'.repeat(35)); db.setSecret('telegram_hook_secret', 'hooksecretABC');
  db.setSetting('last_public_url', 'https://' + MAIN);
  TG.info = `https://${MAIN}/hook/telegram`; TG.set.length = 0;
  const prev = cfg.publicUrl; cfg.publicUrl = 'https://ai.louisb.vip';
  try {
    const telegram = await import('../src/channels/telegram.js'); const sms = await import('../src/channels/sms.js'); const whatsapp = await import('../src/channels/whatsapp.js');
    const steps = await address.syncAfterStart({ telegram, sms, whatsapp });
    assert.equal(TG.set.length, 1);
    assert.equal(TG.set[0].url, 'https://ai.louisb.vip/hook/telegram'); assert.equal(TG.set[0].secret_token, 'hooksecretABC'); assert.equal(TG.set[0].drop_pending_updates, false);
    assert.match(steps.join(' '), /Telegram webhook moved to https:\/\/ai\.louisb\.vip\/hook\/telegram/);
    assert.equal(db.setting('last_public_url'), 'https://ai.louisb.vip');
    assert.ok(db.all("SELECT * FROM audit WHERE action='address.changed'").length === 1);
    await address.syncAfterStart({ telegram, sms, whatsapp });
    assert.equal(TG.set.length, 1, 'already right: not set again');
    assert.ok(!JSON.stringify(db.all('SELECT * FROM audit')).includes('A'.repeat(35)), 'the token is never written down');
  } finally { cfg.publicUrl = prev; db.setSecret('telegram_token', ''); db.setSecret('telegram_hook_secret', ''); }
});
test('page notes: Telegram moves by itself; a Google sign-in setup gets the "add the new return address" warning', async () => {
  db.setSecret('telegram_token', '123456789:' + 'B'.repeat(35));
  db.setSetting('google_client_id', 'cid.apps');
  try {
    const r = await call('/api/address');
    assert.equal(r.j.telegram, true);
    const g = r.j.notes.find(n => n.id === 'google'); assert.ok(g); assert.match(g.text, /Authorized redirect URIs/); assert.match(g.text, /Accounts you already added keep working/);
  } finally { db.setSecret('telegram_token', ''); db.setSetting('google_client_id', ''); }
  const r2 = await call('/api/address'); assert.equal(r2.j.notes.length, 0); assert.equal(r2.j.telegram, false);
});
test('the Settings page: a "Main address" item in System; plain words, no company or tool names; the old look otherwise', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\['address', '🌍', 'Main address', 'The web address your assistant uses'\], \['updates'/);
  assert.match(app, /address: addressView/);
  const v = app.slice(app.indexOf('async function addressView'), app.indexOf('async function updatesView'));
  assert.ok(v.length > 1000);
  for (const w of ['Caddy', 'sslip', 'Cloudflare', 'Gemini', 'Groq', 'Meta', 'MA_PUBLIC_URL', 'env file', 'sudo', 'systemctl', 'DNS']) assert.ok(!v.includes(w), w);
  assert.match(v, /The old address keeps working/);
  assert.match(v, /If it doesn\\'t, nothing changes/);
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /2\.3\.19: Settings → Main address/);
  const notes = fs.readFileSync(new URL('../src/address.js', import.meta.url), 'utf8').match(/message: `[^`]*`/g).join(' ');
  for (const w of ['Caddy', 'sslip', 'Cloudflare', 'MA_', 'sudo']) assert.ok(!notes.includes(w), w);
});

// ---------------- the installer: the env file rewrite, and an update keeps it ----------------
const INSTALL = fileURLToPathSafe(new URL('../install.sh', import.meta.url));
function fileURLToPathSafe(u) { return decodeURIComponent(u.pathname); }
function render(dir, envAdd) {
  return spawnSync('bash', [INSTALL], { env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', DRY_RUN: '1', MA_RENDER_DIR: dir, ...envAdd }, encoding: 'utf8', timeout: 60000 });
}
const HIS_ENV = `# My Assistant settings (no secrets here; keys live encrypted in /var/lib/myassistant)
MA_PUBLIC_URL=https://${MAIN}
MA_DATA_DIR=/var/lib/myassistant
MA_PORT=8787
MA_HOST=127.0.0.1
MA_WORKSPACE=/srv/myassistant/workspace
MA_SITES_DIR=/srv/myassistant/sites
MA_SANDBOX_USER=ma-run
MA_RELEASE_BASE=https://abish-assistant-v2.sites.tab.bot
MA_EXTRA_DOMAINS=ai.louisb.vip
NODE_ENV=production
MA_HANDMADE=keep-me
`;
function hisServer() {
  const R = fs.mkdtempSync(path.join(T, 'r-'));
  fs.mkdirSync(R + '/etc/myassistant', { recursive: true }); fs.mkdirSync(R + '/etc/caddy', { recursive: true });
  fs.writeFileSync(R + '/etc/myassistant/env', HIS_ENV);
  fs.writeFileSync(R + '/etc/caddy/Caddyfile', `# My Assistant (managed by its installer)\n\n${MAIN}, ai.louisb.vip {\n\tencode gzip\n}\n`);
  return R;
}
const envOf = (R) => Object.fromEntries(fs.readFileSync(R + '/etc/myassistant/env', 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const siteLine = (R) => fs.readFileSync(R + '/etc/caddy/Caddyfile', 'utf8').split('\n').find(l => /\{\s*$/.test(l) && !l.startsWith('\t') && !l.startsWith('#'));

test('installer, address step (what Switch runs): MA_PUBLIC_URL is the new one, the old main is an extra, every other line stays', () => {
  const R = hisServer();
  const r = render(R, { MA_ADDRESS_ONLY: '1', MA_UPDATE: '1', MA_DOMAIN: 'ai.louisb.vip', MA_EXTRA_DOMAINS: MAIN });
  assert.equal(r.status, 0, r.stdout.slice(-800) + r.stderr.slice(-800));
  const e = envOf(R), before = Object.fromEntries(HIS_ENV.split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => l.split(/=(.*)/s).slice(0, 2)));
  assert.equal(e.MA_PUBLIC_URL, 'https://ai.louisb.vip');
  assert.equal(e.MA_EXTRA_DOMAINS, MAIN);
  for (const k of Object.keys(before)) if (!['MA_PUBLIC_URL', 'MA_EXTRA_DOMAINS'].includes(k)) assert.equal(e[k], before[k], k + ' kept');
  assert.equal(Object.keys(e).length, Object.keys(before).length);
  assert.equal(siteLine(R), `ai.louisb.vip, ${MAIN} {`, 'the web server answers on both, with a certificate for each');
  assert.doesNotMatch(r.stdout, /apt-get|Downloading the app|useradd|sudoers/, 'the address step installs nothing and touches no permissions');
  assert.match(r.stdout, /systemctl restart caddy/); assert.match(r.stdout, /systemctl restart myassistant/);
  // ...and a later update keeps his choice (it is in the env file)
  const u = render(R, { MA_UPDATE: '1' });
  assert.equal(u.status, 0, u.stdout.slice(-800) + u.stderr.slice(-800));
  const e2 = envOf(R);
  assert.equal(e2.MA_PUBLIC_URL, 'https://ai.louisb.vip'); assert.equal(e2.MA_EXTRA_DOMAINS, MAIN); assert.equal(e2.MA_HANDMADE, 'keep-me');
  assert.equal(siteLine(R), `ai.louisb.vip, ${MAIN} {`);
  assert.match(u.stdout, /Private address: https:\/\/ai\.louisb\.vip/);
  // a second update: still the same
  render(R, { MA_UPDATE: '1' }); assert.equal(envOf(R).MA_PUBLIC_URL, 'https://ai.louisb.vip'); assert.equal(envOf(R).MA_EXTRA_DOMAINS, MAIN);
});
test('installer: the command-line way (MA_DOMAIN=… without extras) also keeps the old main address; an update before 2.3.19 changes nothing', () => {
  const R = hisServer();
  const r = render(R, { MA_UPDATE: '1', MA_DOMAIN: 'ai.louisb.vip' });
  assert.equal(r.status, 0, r.stderr.slice(-500));
  assert.equal(envOf(R).MA_PUBLIC_URL, 'https://ai.louisb.vip'); assert.equal(envOf(R).MA_EXTRA_DOMAINS, MAIN);
  const R2 = hisServer();
  assert.equal(render(R2, { MA_UPDATE: '1' }).status, 0);
  const e = envOf(R2); assert.equal(e.MA_PUBLIC_URL, 'https://' + MAIN); assert.equal(e.MA_EXTRA_DOMAINS, 'ai.louisb.vip'); assert.equal(e.MA_HANDMADE, 'keep-me');
});
test('installer: the address step refuses a bad address and writes nothing', () => {
  for (const bad of ['bad_name.com', '1.2.3.4', 'x;rm -rf /', '']) {
    const R = hisServer();
    const r = render(R, { MA_ADDRESS_ONLY: '1', MA_UPDATE: '1', MA_DOMAIN: bad, MA_EXTRA_DOMAINS: MAIN });
    if (bad === '') { assert.equal(envOf(R).MA_PUBLIC_URL, 'https://' + MAIN, 'empty = keep the saved one'); continue; }
    assert.notEqual(r.status, 0, bad);
    assert.equal(fs.readFileSync(R + '/etc/myassistant/env', 'utf8'), HIS_ENV, bad);
  }
});
test('update unit: takes the request (no new sudo rule), checks each value, tests the new address, puts the old files back if the test fails', () => {
  const R = hisServer();
  assert.equal(render(R, { MA_UPDATE: '1' }).status, 0);
  const sudoers = fs.readFileSync(R + '/etc/sudoers.d/myassistant', 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
  assert.deepEqual(sudoers, ['myassistant ALL=(ma-run) NOPASSWD: /usr/bin/env', 'myassistant ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block myassistant-update.service'], 'the same two rules as 2.3.18');
  const u = fs.readFileSync(R + '/usr/local/sbin/myassistant-update', 'utf8');
  assert.equal(spawnSync('bash', ['-n', R + '/usr/local/sbin/myassistant-update']).status, 0);
  const a = u.indexOf('REQ="/var/lib/myassistant/address-request"'), b = u.indexOf('exec >"/var/lib/myassistant/update.log"');
  assert.ok(a > 0 && b > a, 'the address request is handled first, then the normal update');
  const blk = u.slice(a, b);
  assert.match(blk, /\[ ! -L "\$REQ" \]/);
  assert.match(blk, /rm -f "\$REQ"/);
  assert.match(blk, /MA_ADDRESS_ONLY=1 MA_UPDATE=1 MA_DOMAIN="\$NEW" MA_EXTRA_DOMAINS="\$X" .* bash \/opt\/myassistant\/current\/install\.sh/);
  assert.match(blk, /curl -fsS --max-time 10 --resolve "\$NEW:443:127\.0\.0\.1" "https:\/\/\$NEW\/api\/address-check\/\$NONCE"/);
  assert.match(blk, /cp -a \/etc\/myassistant\/env\.before-address \/etc\/myassistant\/env/);
  assert.match(blk, /-gt 900/, 'an old request is not used');
  assert.doesNotMatch(blk, /eval|source "\$REQ"|\. "\$REQ"/);
  // the unit's own letter-by-letter check
  const re = /HOSTRE='([^']+)'/.exec(blk)[1];
  const t = (v) => spawnSync('bash', ['-c', `[[ "$1" =~ $2 ]] && echo y || echo n`, '_', v, re], { encoding: 'utf8' }).stdout.trim();
  for (const v of ['ai.louisb.vip', MAIN, 'a.b.co']) assert.equal(t(v), 'y', v);
  for (const v of ['x;rm -rf /', '$(id).com', 'AI.louisb.vip', '1.2.3.4', 'a..b.com', '-a.com', 'a.com/x', 'a.com\nb.com', '']) assert.equal(t(v), 'n', JSON.stringify(v));
  assert.equal(fs.readFileSync(INSTALL, 'utf8'), fs.readFileSync(new URL('../docs/install.sh', import.meta.url), 'utf8'), 'docs/install.sh is the same file');
});
