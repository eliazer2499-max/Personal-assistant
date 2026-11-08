// 2.3.6: site_screenshot — open a website (or a project's own files, or a site published on this server) in a
// hidden Chromium at phone size, save the picture into the project, and let the AI SEE it so it can spot and fix
// layout problems (sideways scrolling, tiny text, broken pictures, things on top of each other).
// No npm packages: Chromium is driven over its DevTools protocol with Node's built-in WebSocket.
// The browser is NOT bundled: the owner adds it once with optional/install-browser.sh.
// It runs as the locked-down sandbox user (like run_command), so a web page never runs with the assistant's keys.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { cfg } from '../config.js';
import { audit } from '../db.js';
import { projectDir, inProject, safeName } from './workspace.js';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
export const BROWSER_CMD = 'sudo bash /opt/myassistant/current/optional/install-browser.sh';
export const NO_BROWSER = `No browser on this server yet, so I can't take a screenshot. One-time setup (the owner runs this on the server): ${BROWSER_CMD}`;
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const DESKTOP = { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false };
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const MAX_FULL = 6000;          // css px: a full-page picture stops here
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function executable(p) { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }
/** The Chromium to use, or null. install-browser.sh links its pick to /usr/local/bin/ma-chromium. */
export function findChromium() {
  const env = process.env.MA_CHROMIUM;
  if (env !== undefined) return env && executable(env) ? env : null;      // tests can force "no browser" with MA_CHROMIUM=''
  const list = ['/usr/local/bin/ma-chromium'];
  for (const root of ['/opt/myassistant-browser']) {
    try {
      for (const d of fs.readdirSync(root).sort().reverse()) for (const sub of ['chrome-linux/headless_shell', 'chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/chrome', 'chrome-linux64/chrome'])
        list.push(path.join(root, d, sub));
    } catch {}
  }
  for (const dir of ['/usr/bin', '/usr/local/bin', '/snap/bin']) for (const n of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'headless_shell'])
    list.push(path.join(dir, n));
  return list.find(executable) || null;
}

// one browser at a time (a small server has little memory)
let chain = Promise.resolve();
function oneAtATime(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

/** Start Chromium (as the sandbox user when there is one) and return { ws, close }. */
async function launch(bin) {
  const flags = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--font-render-hinting=none',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', 'about:blank'];
  // a fresh profile folder for each run, removed when the browser ends
  const script = 'D=$(mktemp -d /tmp/ma-shot-XXXXXX) || exit 1; trap \'rm -rf "$D"\' EXIT; "$0" --user-data-dir="$D" "$@"';
  const inner = ['/usr/bin/timeout', '-k', '5', '170', '/bin/bash', '-c', script, bin, ...flags];
  const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const HOME = cfg.sandboxUser ? '/srv/myassistant/sandbox-home' : (process.env.HOME || '/tmp');
  let cmd, args;
  if (cfg.sandboxUser) { cmd = 'sudo'; args = ['-n', '-u', cfg.sandboxUser, '--', '/usr/bin/env', '-i', 'PATH=' + PATH, 'HOME=' + HOME, 'LANG=C.UTF-8', ...inner]; }
  else { cmd = inner[0]; args = inner.slice(1); }
  const child = spawn(cmd, args, { env: { PATH, HOME, LANG: 'C.UTF-8' }, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000).unref(); };
  const ws = await new Promise((resolve, reject) => {
    let err = '';
    const t = setTimeout(() => { kill(); reject(new Error('The browser did not start in time. ' + err.slice(-300))); }, 25000);
    child.stderr.on('data', (b) => {
      err += b.toString(); if (err.length > 20000) err = err.slice(-10000);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    child.on('error', (e) => { clearTimeout(t); reject(new Error('Could not start the browser: ' + e.message)); });
    child.on('exit', (code) => { clearTimeout(t); reject(new Error('The browser stopped right away (exit ' + code + '). ' + err.replace(/\s+/g, ' ').slice(-400))); });
  });
  return { ws, kill, child };
}

/** A tiny DevTools-protocol client on Node's built-in WebSocket. */
function cdp(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    let id = 0; const wait = new Map(); const handlers = [];
    sock.onerror = () => reject(new Error('Could not talk to the browser.'));
    sock.onmessage = (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      if (m.id && wait.has(m.id)) { const w = wait.get(m.id); wait.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result || {}); }
      else if (m.method) for (const h of handlers) h(m);
    };
    sock.onclose = () => { for (const w of wait.values()) w.reject(new Error('The browser closed.')); wait.clear(); };
    sock.onopen = () => resolve({
      send(method, params = {}, sessionId, ms = 30000) {
        return new Promise((res, rej) => {
          const n = ++id; const t = setTimeout(() => { wait.delete(n); rej(new Error(method + ' timed out')); }, ms);
          wait.set(n, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
          sock.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      on(fn) { handlers.push(fn); },
      close() { try { sock.close(); } catch {} },
    });
  });
}

/** Serve one folder on 127.0.0.1 (random port, secret path) so the browser can open a project's own files. */
function serveFolder(root) {
  const token = crypto.randomBytes(9).toString('hex');
  const types = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.avif': 'image/avif',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
  const rootReal = fs.realpathSync(root);
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!p.startsWith('/' + token + '/')) { res.writeHead(404); return res.end(); }
    p = p.slice(token.length + 2);
    let f = path.resolve(rootReal, p || 'index.html');
    try {
      if (f !== rootReal && !f.startsWith(rootReal + path.sep)) throw 0;
      if (fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
      const real = fs.realpathSync(f);
      if (!real.startsWith(rootReal + path.sep)) throw 0;
      res.writeHead(200, { 'Content-Type': types[path.extname(real).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(real).pipe(res);
    } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${srv.address().port}/${token}/`, close: () => srv.close() })));
}

// Read in the page after it loaded: the usual phone problems, as plain facts.
const CHECKS = `(() => {
  const de = document.documentElement, vw = de.clientWidth || window.innerWidth;
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const wide = [], tiny = [];
  for (const e of document.body ? document.body.querySelectorAll('*') : []) {
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (r.width > vw + 2 && wide.length < 6 && cs.position !== 'fixed') wide.push(name(e) + ' (' + Math.round(r.width) + 'px wide)');
    const own = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 2);
    if (own && parseFloat(cs.fontSize) < 12 && tiny.length < 6) tiny.push(name(e) + ' ' + cs.fontSize + ' "' + e.textContent.trim().slice(0, 30) + '"');
  }
  const broken = [...document.images].filter(i => (i.complete && i.naturalWidth === 0) || !(i.getAttribute('src') || i.getAttribute('srcset') || '').trim()).map(i => ((i.currentSrc || i.src || '(no src)') + (i.alt ? ' (shows "' + i.alt.slice(0, 30) + '")' : '')).slice(0, 160)).slice(0, 8);
  // 2.3.17 (E): pictures pulled from another site (they break, or change, whenever that site does)
  const hot = [...document.images].map(i => i.currentSrc || i.src || '').filter(s => /^https?:/i.test(s) && (() => { try { return new URL(s).origin !== location.origin; } catch { return false; } })()).map(s => s.slice(0, 160)).slice(0, 8);
  const vh = window.innerHeight;
  const buttons = [...document.querySelectorAll('a[href],button,[role=button],input[type=submit],input[type=button]')].filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 8 && r.height > 8 && r.top < vh && r.bottom > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity || '1') > 0.2; }).map(e => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 40)).filter(Boolean).slice(0, 10);
  const meta = document.querySelector('meta[name=viewport]');
  return { title: document.title.slice(0, 120), page_height: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0),
    scrolls_sideways: de.scrollWidth > vw + 2 || wide.length > 0, layout_width: Math.max(window.innerWidth, de.scrollWidth), page_width: Math.max(de.scrollWidth, ...[...document.querySelectorAll('body *')].slice(0, 3000).map(e => Math.round(e.getBoundingClientRect().width))), wider_than_screen: wide, tiny_text: tiny, broken_images: broken, hotlinked_images: hot, buttons_on_first_screen: buttons,
    has_viewport_meta: !!meta, dir: de.dir || getComputedStyle(document.body || de).direction, lang: de.lang || '' };
})()`;

async function shoot(c, sid, size) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.deviceScaleFactor, mobile: size.mobile }, sid);
  await c.send('Emulation.setTouchEmulationEnabled', size.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }, sid);
  await c.send('Emulation.setUserAgentOverride', { userAgent: size.mobile ? PHONE_UA : PHONE_UA.replace(/\(Linux; Android 14; Pixel 8\)/, '(X11; Linux x86_64)').replace(' Mobile', '') }, sid);
}

async function capture(c, sid, size, fullPage) {
  const facts = (await c.send('Runtime.evaluate', { expression: CHECKS, returnByValue: true }, sid)).result?.value || {};
  // A page wider than the phone: phones zoom out until all of it fits (so everything looks small). Show that.
  const lw = Math.max(size.width, facts.layout_width || size.width);
  const z = size.width / lw;
  const h = Math.round((fullPage ? Math.min(MAX_FULL, Math.max(size.height, facts.page_height || size.height)) : size.height) / z);
  const clip = (scale) => ({ x: 0, y: 0, width: lw, height: h, scale: scale * z });
  const png = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage || z < 1, clip: clip(1) }, sid, 60000);
  // a lighter copy for the AI to look at (same picture, smaller)
  const lookH = fullPage ? Math.min(h, Math.round(3000 / z)) : h;
  const look = await c.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: fullPage || z < 1, clip: { ...clip(size.mobile ? 0.75 : 0.6), height: lookH } }, sid, 60000);
  return { facts, png: Buffer.from(png.data, 'base64'), look: look.data, height: Math.round(h * z), zoomed_out: z < 1 };
}

/** Open url at each size and capture. */
// 2.3.16 (Abish, Nov 8: the picture caught soft-tech.net's loading splash, he had to say "wait a sec and then send"):
// after the page loads, wait until the network is quiet (no request for 0.5 s, at most 10 s), then let it settle
// (3 s by default; wait_ms 0–15000) before taking the picture.
export const SETTLE_DEFAULT_MS = 3000, SETTLE_MAX_MS = 15000, IDLE_QUIET_MS = 500, IDLE_MAX_MS = 10000;
export const settleMs = (v) => { const n = Number(v); return Number.isFinite(n) && v !== undefined && v !== null && v !== '' ? Math.max(0, Math.min(SETTLE_MAX_MS, Math.round(n))) : SETTLE_DEFAULT_MS; };
export async function screenshotUrl(url, { sizes = [PHONE], fullPage = false, waitMs = SETTLE_DEFAULT_MS } = {}) {
  const bin = findChromium();
  if (!bin) { const e = new Error(NO_BROWSER); e.noBrowser = true; throw e; }
  return oneAtATime(async () => {
    const b = await launch(bin);
    let c;
    try {
      c = await cdp(b.ws);
      const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId: sid } = await c.send('Target.attachToTarget', { targetId, flatten: true });
      const errors = [];
      let loaded = null;
      const inflight = new Set(); let lastNet = Date.now();
      c.on((m) => {
        if (m.sessionId !== sid) return;
        if (m.method === 'Network.requestWillBeSent') { inflight.add(m.params.requestId); lastNet = Date.now(); }
        else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') { inflight.delete(m.params.requestId); lastNet = Date.now(); }
        if (m.method === 'Page.loadEventFired' && loaded) loaded();
        else if (m.method === 'Runtime.exceptionThrown' && errors.length < 8) errors.push('script error: ' + String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').split('\n')[0].slice(0, 200));
        else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error' && errors.length < 8) errors.push('console: ' + (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200));
        else if (m.method === 'Log.entryAdded' && m.params.entry?.level === 'error' && errors.length < 8) errors.push(String(m.params.entry.text || '').slice(0, 160) + (m.params.entry.url ? ' ' + m.params.entry.url.slice(0, 120) : ''));
      });
      await c.send('Page.enable', {}, sid); await c.send('Runtime.enable', {}, sid); await c.send('Log.enable', {}, sid);
      await c.send('Network.enable', {}, sid).catch(() => {});
      const shots = [];
      for (let i = 0; i < sizes.length; i++) {
        const size = sizes[i];
        await shoot(c, sid, size);
        const done = new Promise((r) => { loaded = r; });
        const nav = await c.send('Page.navigate', { url }, sid, 30000);
        if (nav.errorText) throw new Error('The page did not open: ' + nav.errorText + ' (' + url + ')');
        await Promise.race([done, sleep(25000)]);
        await c.send('Runtime.evaluate', { expression: 'document.fonts ? document.fonts.ready.then(() => 1) : 1', awaitPromise: true }, sid, 10000).catch(() => {});
        const idleEnd = Date.now() + IDLE_MAX_MS;                   // network quiet (long-polling pages: at most 10 s)
        while (Date.now() < idleEnd && (inflight.size || Date.now() - lastNet < IDLE_QUIET_MS)) await sleep(100);
        await sleep(waitMs);
        shots.push({ size, ...(await capture(c, sid, size, fullPage)) });
      }
      return { shots, errors };
    } finally {
      try { if (c) { await c.send('Browser.close', {}, undefined, 3000).catch(() => {}); c.close(); } } catch {}
      setTimeout(b.kill, 1500).unref();
    }
  });
}

// ---------------- 2.3.17 (E): the page's own files, checked without a browser ----------------
// Abish, Nov 8 1:26 AM: "a designed html page … add a go back to site button" came out as a broken picture ("Logo"
// alt text) and "Private Link" on white. The logo was searched for on the web and linked from another site.
// This reads the site's .html/.css files and lists: pictures that point at files that are not there, pictures linked
// from other sites (hot-linked), images with no address, and logo placeholders.
const IMG_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico|avif|bmp)(?:[?#]|$)/i;
const SKIP_REF = /^(?:data:|blob:|#|mailto:|tel:|javascript:|about:|sms:|whatsapp:)/i;
function refsOf(file, text) {
  const out = [];   // { ref, picture }
  const add = (ref, picture) => { ref = String(ref || '').trim().replace(/^['"]|['"]$/g, ''); out.push({ ref, picture }); };
  if (/\.css$/i.test(file)) { for (const m of text.matchAll(/url\(\s*([^)]*?)\s*\)/gi)) add(m[1], true); return out; }
  for (const m of text.matchAll(/<(img|source|image|video|input|link|script)\b([^>]*)>/gi)) {
    const tag = m[1].toLowerCase(), at = m[2];
    const attr = (n) => { const r = new RegExp('(?:^|\\s)' + n + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(at); return r ? (r[2] ?? r[3] ?? r[4] ?? '') : null; };
    if (tag === 'img') { const s = attr('src'), ss = attr('srcset'); if ((s === null || !s.trim()) && !ss) out.push({ ref: '', picture: true, empty: true }); if (s && s.trim()) add(s, true); }
    if ((tag === 'img' || tag === 'source') && attr('srcset')) for (const part of attr('srcset').split(',')) add(part.trim().split(/\s+/)[0], true);
    if (tag === 'source' && attr('src')) add(attr('src'), false);
    if (tag === 'image') { const h = attr('href') ?? attr('xlink:href'); if (h) add(h, true); }
    if (tag === 'video' && attr('poster')) add(attr('poster'), true);
    if (tag === 'input' && /image/i.test(attr('type') || '') && attr('src')) add(attr('src'), true);
    if (tag === 'link') { const rel = (attr('rel') || '').toLowerCase(), h = attr('href'); if (h && /icon|stylesheet|preload|manifest/.test(rel)) add(h, /icon/.test(rel) || IMG_EXT.test(h)); }
    if (tag === 'script' && attr('src')) add(attr('src'), false);
  }
  for (const m of text.matchAll(/style\s*=\s*("[^"]*"|'[^']*')/gi)) for (const u of m[1].matchAll(/url\(\s*([^)]*?)\s*\)/gi)) add(u[1].replace(/&quot;/g, ''), true);
  for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) for (const u of m[1].matchAll(/url\(\s*([^)]*?)\s*\)/gi)) add(u[1], true);
  return out;
}
/** Static check of a site folder. Returns { missing, hotlinked, empty, placeholders, problems, mustFix }. */
export function checkSiteFiles(root, { siteName = '' } = {}) {
  const res = { missing: [], hotlinked: [], empty: [], placeholders: [], problems: [], mustFix: false };
  let rootReal; try { rootReal = fs.realpathSync(root); } catch { return res; }
  const files = [];
  const walk = (d, depth) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { if (e.name === 'node_modules' || e.name === '.git' || e.name === 'screenshots') continue; const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 5) walk(p, depth + 1); else if (e.isFile() && /\.(?:html?|css)$/i.test(e.name) && files.length < 200) files.push(p); } };
  walk(rootReal, 0);
  let tidy = null;
  for (const f of files) {
    let text = ''; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const rel = path.relative(rootReal, f);
    for (const r of refsOf(f, text)) {
      if (r.empty) { res.empty.push(rel); continue; }
      const ref = r.ref;
      if (!ref || SKIP_REF.test(ref)) continue;
      if (/^(?:https?:)?\/\//i.test(ref)) { if (r.picture || IMG_EXT.test(ref)) res.hotlinked.push(`${rel}: ${ref.slice(0, 140)}`); continue; }
      if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) continue;
      let clean = ref.split(/[?#]/)[0]; try { clean = decodeURIComponent(clean); } catch {}
      if (!clean) continue;
      let target;
      if (clean.startsWith('/')) {
        const m = /^\/sites\/([^/]+)\/(.*)$/.exec(clean);
        if (m && (!siteName || m[1] === siteName)) target = path.join(rootReal, m[2]);
        else { res.missing.push(`${rel}: ${ref.slice(0, 140)} (an address from the top of the server, not inside this site — use a relative path like "${path.basename(clean) || 'logo.svg'}")`); continue; }
      } else target = path.resolve(path.dirname(f), clean);
      if (target.endsWith(path.sep) || clean.endsWith('/')) target = path.join(target, 'index.html');
      const inside = target === rootReal || target.startsWith(rootReal + path.sep);
      if (!inside || !fs.existsSync(target)) res.missing.push(`${rel}: ${ref.slice(0, 140)}${inside ? '' : ' (outside the site folder)'}`);
    }
    if (/\.html?$/i.test(f) && /logo|placeholder|placehold/i.test(text)) {
      tidy = tidy || { has: (t) => /\blogo[\s_-]*(?:placeholder|here|goes here|coming soon)\b|\bplaceholder[\s_-]*(?:logo|image|icon|img)\b|\byour[\s_-]*logo\b|via\.placeholder\.com|placehold\.(?:co|it)|dummyimage\.com/i.test(t) };
      if (tidy.has(text)) res.placeholders.push(rel);
    }
  }
  const uniq = (a) => [...new Set(a)].slice(0, 10);
  res.missing = uniq(res.missing); res.hotlinked = uniq(res.hotlinked); res.empty = uniq(res.empty); res.placeholders = uniq(res.placeholders);
  if (res.missing.length) res.problems.push('pictures/files the page uses that are not in the site folder (they show as broken pictures): ' + res.missing.join('; '));
  if (res.empty.length) res.problems.push('<img> with no picture address in: ' + res.empty.join(', '));
  if (res.hotlinked.length) res.problems.push('pictures linked from other sites (hot-linked; they break or change any time — put your own file in the project instead): ' + res.hotlinked.join('; '));
  if (res.placeholders.length) res.problems.push('a logo/picture placeholder in: ' + res.placeholders.join(', '));
  res.mustFix = res.problems.length > 0;
  return res;
}
export const FIX_PICTURES = 'Fix this before you show him the page or ask for his YES: make the logo yourself as an SVG file in the project (e.g. logo.svg: a simple mark + the name, in the site\'s colours) and use it with a relative path (src="logo.svg"). Never link a picture from another site and never search the web for a logo. Take a new site_screenshot and check it shows no broken picture.';

/** 2.3.17 (E): the check before his YES for publish_site — files first, then (with a browser) the real page. */
export async function precheckSite(dir, { siteName = '' } = {}) {
  const st = checkSiteFiles(dir, { siteName });
  const problems = [...st.problems];
  if (!st.mustFix && findChromium()) {
    let server = null;
    try {
      server = await serveFolder(dir);
      const r = await screenshotUrl(server.base, { sizes: [PHONE], waitMs: 300 });
      const f = r.shots[0].facts;
      if (f.broken_images?.length) problems.push('pictures that did not load in the browser: ' + f.broken_images.join(', '));
      if (f.hotlinked_images?.length) problems.push('pictures linked from other sites: ' + f.hotlinked_images.join(', '));
    } catch { /* the browser check is extra; the file check above already ran */ }
    finally { if (server) server.close(); }
  }
  return { ok: !problems.length, problems };
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

export const siteScreenshot = {
  name: 'site_screenshot',
  description: 'Look at a website like a phone does: opens it in a hidden browser at phone size (390×844), saves a PNG screenshot into the project and shows you the picture, plus a list of common problems found (sideways scrolling, tiny text, broken pictures, script errors). Open a project\'s own files (project + path), a site published on this server (site), or any web address (url). Use after building or changing a site; can also send the picture to the owner.',
  params: {
    project: S('Workspace project: its files are opened (index.html unless path says otherwise), and the screenshot is saved in it'),
    path: S('File inside the project to open (default index.html)'),
    site: S('Name of a site published on this server (publish_site) to open'),
    url: S('A web address (https://…) to open instead'),
    desktop: { type: 'boolean', description: 'Also take a desktop-size picture (1366×900)' },
    full_page: { type: 'boolean', description: 'Capture the whole page height (up to 6000 px), not just the first screen (still phone width)' },
    wait_ms: { type: 'number', description: 'Extra wait after the page has loaded and gone quiet, in milliseconds (default 3000, max 15000). Raise it for a page with a long loading animation.' },
    send_to_owner: { type: 'boolean', description: 'Also send the phone screenshot to the owner (send_file)' },
    caption: S('Text to go with the picture when sending'),
  },
  required: [],
  run: async (a = {}, ctx = {}) => {
    const { project, path: rel, site, url, desktop, full_page, send_to_owner, caption, wait_ms } = a;
    if (!project && !site && !url) return { error: 'Say what to open: project (its files), site (published here) or url.' };
    if (!findChromium()) return { error: NO_BROWSER, setup_command: BROWSER_CMD };
    let target, server = null;
    try {
      if (url) {
        let u; try { u = new URL(String(url)); } catch { return { error: 'That is not a web address: ' + url }; }
        if (!/^https?:$/.test(u.protocol)) return { error: 'Only http(s) addresses can be opened.' };
        target = u.href;
      } else if (site) {
        const dir = path.join(cfg.sitesDir, safeName(site, 'site name'));
        if (!fs.existsSync(path.join(dir, 'index.html'))) return { error: `No published site "${site}" on this server (sites_list shows them).` };
        server = await serveFolder(dir); target = server.base;
      } else {
        const dir = projectDir(project);
        const file = inProject(project, rel || 'index.html');
        if (!fs.existsSync(file)) return { error: `No ${rel || 'index.html'} in project "${project}" (file_list shows what is there).` };
        server = await serveFolder(dir);
        target = server.base + path.relative(fs.realpathSync(dir), fs.realpathSync(file)).split(path.sep).map(encodeURIComponent).join('/');
      }
      const sizes = desktop ? [PHONE, DESKTOP] : [PHONE];
      const r = await screenshotUrl(target, { sizes, fullPage: !!full_page, waitMs: settleMs(wait_ms) });
      // where to save: the project given, else the published site's name, else "screenshots"
      const saveProject = project ? safeName(project, 'project') : site ? safeName(site, 'project') : 'screenshots';
      const label = (site || (url ? new URL(url).hostname : '') || path.basename(rel || 'index', '.html') || 'page').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'page';
      const saved = [], see = [];
      const t = stamp();
      for (const s of r.shots) {
        const kind = s.size.mobile ? 'phone' : 'desktop';
        const relOut = `screenshots/${label}-${kind}-${t}.png`;
        const out = inProject(saveProject, relOut, true);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, s.png);
        saved.push({ file: saveProject + '/' + relOut, size: `${s.size.width}x${s.height}${s.size.deviceScaleFactor > 1 ? ' @' + s.size.deviceScaleFactor + 'x' : ''}`, bytes: s.png.length, kind });
        see.push({ kind: 'image', mime: 'image/jpeg', data: s.look, name: `${kind} screenshot of ${label}` });
      }
      const f = r.shots[0].facts;
      const problems = [];
      if (f.scrolls_sideways) problems.push(`page is ${f.page_width}px wide on a 390px phone: it scrolls sideways, or the phone zooms out and everything looks small` + (f.wider_than_screen?.length ? ' (too wide: ' + f.wider_than_screen.join(', ') + ')' : ''));
      if (f.tiny_text?.length) problems.push('text smaller than 12px: ' + f.tiny_text.join('; '));
      if (f.broken_images?.length) problems.push('pictures that did not load: ' + f.broken_images.join(', '));
      if (!f.has_viewport_meta) problems.push('no <meta name="viewport" content="width=device-width, initial-scale=1"> (phones will show it zoomed out)');
      if (f.hotlinked_images?.length) problems.push('pictures linked from other sites (hot-linked): ' + f.hotlinked_images.join(', '));
      for (const e of new Set(r.errors)) problems.push(e);
      // 2.3.17 (E): the site's own files too — a picture that points at a missing file, or at another site
      const folder = site ? path.join(cfg.sitesDir, safeName(site, 'site name')) : (!url ? path.dirname(inProject(project, rel || 'index.html')) : null);
      const st = folder ? checkSiteFiles(folder, { siteName: site ? safeName(site) : '' }) : { problems: [], mustFix: false };
      for (const p of st.problems) if (!problems.includes(p)) problems.push(p);
      const pictureTrouble = st.mustFix || !!f.broken_images?.length || !!f.hotlinked_images?.length;
      const out = { ok: true, opened: url ? target : (site ? 'site ' + site : `project ${project}/${rel || 'index.html'}`), title: f.title, page_height_px: f.page_height,
        saved, problems_found: problems.length ? problems : ['none of the automatic checks found a problem'],
        buttons_on_first_screen: f.buttons_on_first_screen || [],
        ...(pictureTrouble ? { must_fix: FIX_PICTURES } : {}),
        look: 'The screenshot is attached for you to look at now. If he asked for a designed page, it must look designed (real layout and colours, not plain text on white), with its own logo, and every button he asked for visible in buttons_on_first_screen. Check it like a phone user: text readable, nothing cut off or overlapping, pictures showing, buttons big enough, Hebrew/Yiddish right-to-left. Fix what is wrong, then take one more screenshot.' };
      if (send_to_owner && pictureTrouble) out.sent_to_owner = 'NOT sent: the page has broken or hot-linked pictures. ' + FIX_PICTURES;   // 2.3.17 (E)
      else if (send_to_owner) {
        const { sendFile } = await import('./sendfile.js');
        const sent = await sendFile.run({ path: saved[0].file, caption: caption || '' }, ctx);
        out.sent_to_owner = sent.error ? 'not sent: ' + sent.error : (sent.whatsapp ? 'in the chat; WhatsApp: ' + sent.whatsapp : 'in the chat');
      }
      audit('assistant', 'tool.site_screenshot', `${out.opened} → ${saved.map(s => s.file).join(', ')}${problems.length ? ' · ' + problems.length + ' problem(s)' : ''}`);
      Object.defineProperty(out, '_see', { value: see, enumerable: false });
      return out;
    } catch (e) {
      if (e.noBrowser) return { error: NO_BROWSER, setup_command: BROWSER_CMD };
      return { error: 'Screenshot failed: ' + e.message };
    } finally { if (server) server.close(); }
  },
};

export default [siteScreenshot];
