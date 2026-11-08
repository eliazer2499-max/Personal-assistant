// 2.3.20: Settings → Main address is ONE list of every address (Abish, WhatsApp Nov 8 2026 2:04 PM ET:
// "Like it should show all urls and allow to select a default"). The default is marked; every other one has
// "Make default", which runs the 2.3.19 Check, asks, then the 2.3.19 Switch. Typing a new address stays below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { if (process.env.SHOW_LOGS) orig(...a); }; }
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v2320-'));
const DATA = T + '/data';
const PORT = 21900 + Math.floor(Math.random() * 90);
const BASE = 'http://127.0.0.1:' + PORT;
const MAIN = '96-250-207-131.sslip.io', IP = '96.250.207.131';
const CADDY = T + '/Caddyfile';
fs.writeFileSync(CADDY, `# My Assistant (managed by its installer)\n\n${MAIN}, ai.louisb.vip, hand.example.org {\n\tencode gzip\n}\n`);
Object.assign(process.env, {
  MA_DATA_DIR: DATA, MA_WORKSPACE: T + '/ws', MA_SITES_DIR: T + '/sites', MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'https://' + MAIN, MA_EXTRA_DOMAINS: 'ai.louisb.vip', MA_CADDYFILE: CADDY,
  MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_RELEASE_BASE: 'http://127.0.0.1:1', MA_WA_AGENT_BASE: 'http://127.0.0.1:1/agent/v1',
  MA_TEST_DNS: JSON.stringify({ [MAIN]: [IP], 'ai.louisb.vip': [IP], 'hand.example.org': ['1.2.3.4'], 'elsewhere.example.com': ['1.2.3.4'] }),
  MA_TEST_PROBE: JSON.stringify({ 'ai.louisb.vip': BASE }),
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
const cookie = S.cookie.split(';')[0];
const get = async (p) => { const r = await fetch(BASE + p, { headers: { Cookie: cookie } }); return { status: r.status, j: await r.json().catch(() => null) }; };
const REQ = path.join(DATA, 'address-request');
let browser = null;
test.after(async () => { if (browser) await browser.close().catch(() => {}); server.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 300); });

test('the list: every address this server answers on, the main (default) one first and marked, each one once', async () => {
  const r = await get('/api/address');
  assert.equal(r.status, 200);
  assert.deepEqual(r.j.addresses.map(a => [a.host, a.default]), [[MAIN, true], ['ai.louisb.vip', false], ['hand.example.org', false]]);
  assert.equal(r.j.addresses.filter(a => a.default).length, 1, 'exactly one default');
  assert.equal(r.j.addresses[0].url, 'https://' + MAIN);
  assert.deepEqual(r.j.extras, ['ai.louisb.vip', 'hand.example.org'], 'the 2.3.19 field is still there');
});

test('the list is never empty and never only some of them: the main one is always in it, doubles are dropped', () => {
  assert.deepEqual(address.allAddresses('a.example.com', []).map(a => a.host), ['a.example.com'], 'no extras → just the main one');
  assert.deepEqual(address.allAddresses('a.example.com', ['b.example.com', 'a.example.com', 'b.example.com']).map(a => [a.host, a.default]), [['a.example.com', true], ['b.example.com', false]]);
  const keep = cfg.publicUrl;
  try { cfg.publicUrl = 'https://203.0.113.9'; assert.deepEqual(address.allAddresses(address.mainHost(), ['ai.louisb.vip']).map(a => a.host), ['203.0.113.9', 'ai.louisb.vip'], 'a number address as main still shows'); }
  finally { cfg.publicUrl = keep; }
});

// the page itself, in a real browser (the same Chromium the other browser tests use)
const CHROME = process.env.MA_TEST_CHROMIUM || (() => { try { const d = path.join(os.homedir(), '.cache/ms-playwright'); const e = fs.readdirSync(d).find(n => n.startsWith('chromium_headless_shell-')); const p = e && path.join(d, e, 'chrome-headless-shell-linux64/chrome-headless-shell'); return p && fs.existsSync(p) ? p : ''; } catch { return ''; } })();
const PW = '/home/user/node_modules/playwright-core/index.mjs';
const canBrowse = !!CHROME && fs.existsSync(PW);
async function page() {
  if (!browser) { const { chromium } = await import(PW); browser = await chromium.launch({ executablePath: CHROME }); }
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name: 'ma_sid', value: /ma_sid=([^;]+)/.exec(S.cookie)[1], domain: '127.0.0.1', path: '/' }]);
  const pg = await ctx.newPage();
  const calls = [];
  pg.on('request', q => { const u = new URL(q.url()); if (u.pathname.startsWith('/api/address')) calls.push(q.method() + ' ' + u.pathname); });
  return { pg, calls, ctx };
}
const rowsOf = (pg) => pg.$$eval('[data-addr-row]', els => els.map(e => ({ host: e.dataset.addrRow, def: e.dataset.addrDefault === '1', checked: e.getAttribute('aria-checked'), badge: !!e.querySelector('[data-addr-badge]'), make: !!e.querySelector('[data-addr-make]') })));

test('page: on the first load it shows ALL the addresses at once, the default marked, "Make default" on every other one', { skip: !canBrowse && 'needs a Chromium (MA_TEST_CHROMIUM)' }, async () => {
  const { pg, ctx } = await page();
  await pg.goto(BASE + '/#/settings/address');
  await pg.waitForSelector('[data-addr-row]', { timeout: 15000 });
  const rows = await rowsOf(pg);
  assert.deepEqual(rows, [
    { host: MAIN, def: true, checked: 'true', badge: true, make: false },
    { host: 'ai.louisb.vip', def: false, checked: 'false', badge: false, make: true },
    { host: 'hand.example.org', def: false, checked: 'false', badge: false, make: true },
  ]);
  assert.match(await pg.innerText('[data-addr-default]'), /Default/);
  assert.equal(await pg.$$eval('[data-addr-pick]', e => e.length), 0, 'the old pick buttons are gone');
  assert.ok(await pg.$('#newaddr'), 'typing another address is still there');
  // also when opened from the Settings list (not a direct link)
  await pg.goto(BASE + '/#/settings'); await pg.click('[data-set="address"]');
  await pg.waitForSelector('[data-addr-row]', { timeout: 15000 });
  assert.equal((await rowsOf(pg)).length, 3);
  await ctx.close();
});

test('page: "Make default" runs Check, then asks, then Switch — and the old main stays as an extra', { skip: !canBrowse && 'needs a Chromium (MA_TEST_CHROMIUM)' }, async () => {
  fs.rmSync(REQ, { force: true });
  const { pg, calls, ctx } = await page();
  const asked = [];
  pg.on('dialog', d => { asked.push(d.message()); d.accept(); });
  await pg.goto(BASE + '/#/settings/address');
  await pg.waitForSelector('[data-addr-make="ai.louisb.vip"]', { timeout: 15000 });
  await pg.click('[data-addr-make="ai.louisb.vip"]');
  await pg.waitForFunction(() => /Saved \(test mode/.test(document.body.innerText), null, { timeout: 15000 });
  const order = calls.filter(c => c.startsWith('POST'));
  assert.deepEqual(order, ['POST /api/address/check', 'POST /api/address/switch'], 'check first, then switch');
  assert.equal(asked.length, 1); assert.match(asked[0], /Make https:\/\/ai\.louisb\.vip the default address\?/); assert.match(asked[0], /old address keeps working/);
  const req = fs.readFileSync(REQ, 'utf8');
  assert.match(req, /^main=ai\.louisb\.vip$/m);
  assert.match(req, new RegExp('^extra=.*' + MAIN.replace(/\./g, '\\.'), 'm'), 'the old main address is kept');
  assert.match(req, /^old=96-250-207-131\.sslip\.io$/m);
  assert.ok(await pg.$('[data-addr-pending]'), 'the page says it is switching');
  await ctx.close();
  fs.rmSync(REQ, { force: true }); db.setSetting('address_switch', '');
});

test('page: "Make default" on an address that does not point here → plain words, no question, nothing switched', { skip: !canBrowse && 'needs a Chromium (MA_TEST_CHROMIUM)' }, async () => {
  fs.rmSync(REQ, { force: true });
  const { pg, calls, ctx } = await page();
  const asked = []; pg.on('dialog', d => { asked.push(d.message()); d.accept(); });
  await pg.goto(BASE + '/#/settings/address');
  await pg.waitForSelector('[data-addr-make="hand.example.org"]', { timeout: 15000 });
  await pg.click('[data-addr-make="hand.example.org"]');
  await pg.waitForFunction(() => /Nothing was changed/.test(document.querySelector('[data-addr-row="hand.example.org"]').innerText), null, { timeout: 15000 });
  assert.deepEqual(calls.filter(c => c.startsWith('POST')), ['POST /api/address/check']);
  assert.equal(asked.length, 0); assert.ok(!fs.existsSync(REQ));
  // saying "Cancel" to the question also changes nothing
  const { pg: p2, calls: c2, ctx: x2 } = await page();
  p2.on('dialog', d => d.dismiss());
  await p2.goto(BASE + '/#/settings/address');
  await p2.waitForSelector('[data-addr-make="ai.louisb.vip"]', { timeout: 15000 });
  await p2.click('[data-addr-make="ai.louisb.vip"]');
  await p2.waitForFunction(() => /Nothing was changed/.test(document.querySelector('[data-addr-row="ai.louisb.vip"]').innerText), null, { timeout: 15000 });
  assert.deepEqual(c2.filter(c => c.startsWith('POST')), ['POST /api/address/check']);
  assert.ok(!fs.existsSync(REQ));
  // the typed address below the list goes through the same Check first
  await p2.click('#addrchange summary'); await p2.fill('#newaddr', 'elsewhere.example.com'); await p2.click('[data-addr-add]');
  await p2.waitForFunction(() => /Nothing was changed/.test(document.getElementById('addrchange').innerText), null, { timeout: 15000 });
  assert.ok(!fs.existsSync(REQ));
  await ctx.close(); await x2.close();
});

test('the page: plain words, no company or tool names; the Settings item and the rest of the app stay the same', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const v = app.slice(app.indexOf('function addressList'), app.indexOf('async function updatesView'));
  assert.ok(v.length > 1000);
  for (const w of ['Caddy', 'sslip', 'Cloudflare', 'Gemini', 'Groq', 'MA_PUBLIC_URL', 'env file', 'sudo', 'systemctl', 'DNS', 'data-addr-pick']) assert.ok(!v.includes(w), w);
  assert.match(v, /'Make default'/); assert.match(v, /'Default'/); assert.match(v, /Add another address/);
  assert.match(app, /\['address', '🌍', 'Main address', 'The web address your assistant uses'\]/);
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /2\.3\.20: Main address = one list/);
});
