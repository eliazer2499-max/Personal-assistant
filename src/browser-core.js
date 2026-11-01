// 2.3.8: "Browser hands" — the AI drives a real (hidden) Chromium: open pages, read them (text + a numbered list
// of buttons, links and boxes), click, type, choose, press keys, scroll, wait, take pictures, go back, close.
// Plus account sign-ups (asks the owner first, reads the code from his Gmail, saves the password encrypted) and
// a "please help" link: the owner sees the live browser on his phone and taps / types for a robot check.
// No npm packages: Chromium's DevTools protocol over Node's built-in WebSocket (like site_screenshot).
// The browser runs as the locked-down sandbox user (like run_command / site_screenshot) and keeps one profile
// folder, so logins and cookies survive between sessions. One session at a time; it closes itself when idle.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cfg } from './config.js';
import { setting, setSetting, audit, rememberSecret, log } from './db.js';
import { findChromium, BROWSER_CMD } from './tools/sitecheck.js';

export const NO_BROWSER_HANDS = `The browser is not installed on this server yet, so I can't open websites. One-time setup (the owner runs this on the server): ${BROWSER_CMD}`;
const VIEW = { width: 1280, height: 900 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ROBOT_RE = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|arkoselabs|funcaptcha|captcha-delivery|geo\.captcha|perimeterx|px-captcha/i;

/** Where the browser keeps its profile (cookies, logins). The sandbox user must own it. */
export function profileDir() {
  if (process.env.MA_BROWSER_PROFILE) return process.env.MA_BROWSER_PROFILE;
  return cfg.sandboxUser ? '/srv/myassistant/sandbox-home/.ma-browser' : path.join(cfg.dataDir, 'browser-profile');
}
/** Settings → Browser & logins → "Browser actions": on by default once the browser is installed. */
export function browserInstalled() { return !!findChromium(); }
export function browserActionsOn() {
  const v = setting('browser_actions');
  if (v === '0') return false;
  return true;          // '' (default) or '1'; when the browser is missing the tools say how to install it
}
export function idleMinutes() { const n = parseInt(setting('browser_idle_minutes'), 10); return n > 0 && n <= 120 ? n : 10; }

// ---------------- the one session ----------------
let S = null;            // { proc, c, sid, targetId, tabs:[], lastUsed, hidden, notes, loadingSince, ... }
let starting = null;
let idleTimer = null;
const listeners = new Set();

/** Start Chromium (as the sandbox user when there is one) with the persistent profile; resolve the DevTools ws URL. */
async function launch(bin) {
  const prof = profileDir();
  const flags = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-blink-features=AutomationControlled', '--lang=en-US', '--font-render-hinting=none',
    `--window-size=${VIEW.width},${VIEW.height}`, '--password-store=basic', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', 'about:blank'];
  // one profile folder that stays (cookies, logins); stale lock files from a crash are cleared (only one session ever runs)
  const script = 'P="$MA_PROFILE"; umask 077; mkdir -p "$P" || exit 1; rm -f "$P/SingletonLock" "$P/SingletonSocket" "$P/SingletonCookie"; exec "$0" --user-data-dir="$P" "$@"';
  const hours = Math.max(1, Math.min(12, parseInt(process.env.MA_BROWSER_MAX_HOURS || '4', 10) || 4));
  const inner = ['/usr/bin/timeout', '-k', '5', String(hours * 3600), '/bin/bash', '-c', script, bin, ...flags];
  const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const HOME = cfg.sandboxUser ? '/srv/myassistant/sandbox-home' : (process.env.HOME || '/tmp');
  let cmd, args;
  if (cfg.sandboxUser) { cmd = 'sudo'; args = ['-n', '-u', cfg.sandboxUser, '--', '/usr/bin/env', '-i', 'PATH=' + PATH, 'HOME=' + HOME, 'LANG=C.UTF-8', 'MA_PROFILE=' + prof, ...inner]; }
  else { cmd = inner[0]; args = inner.slice(1); }
  const child = spawn(cmd, args, { env: { PATH, HOME, LANG: 'C.UTF-8', MA_PROFILE: prof }, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000).unref(); };
  const ws = await new Promise((resolve, reject) => {
    let err = '';
    const t = setTimeout(() => { kill(); reject(new Error('The browser did not start in time. ' + err.replace(/\s+/g, ' ').slice(-300))); }, 30000);
    child.stderr.on('data', (b) => {
      err += b.toString(); if (err.length > 20000) err = err.slice(-10000);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    child.on('error', (e) => { clearTimeout(t); reject(new Error('Could not start the browser: ' + e.message)); });
    child.on('exit', (code) => { clearTimeout(t); reject(new Error('The browser stopped right away (exit ' + code + '). ' + err.replace(/\s+/g, ' ').slice(-400))); });
  });
  child.stderr.removeAllListeners('data'); child.stderr.resume();
  return { ws, kill, child };
}

/** A tiny DevTools-protocol client on Node's built-in WebSocket. */
export function cdp(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    let id = 0; const wait = new Map(); const handlers = []; const closers = [];
    sock.onerror = () => reject(new Error('Could not talk to the browser.'));
    sock.onmessage = (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      if (m.id && wait.has(m.id)) { const w = wait.get(m.id); wait.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result || {}); }
      else if (m.method) for (const h of handlers) { try { h(m); } catch {} }
    };
    sock.onclose = () => { for (const w of wait.values()) w.reject(new Error('The browser closed.')); wait.clear(); for (const f of closers) { try { f(); } catch {} } };
    sock.onopen = () => resolve({
      send(method, params = {}, sessionId, ms = 20000) {
        return new Promise((res, rej) => {
          if (sock.readyState !== 1) return rej(new Error('The browser closed.'));
          const n = ++id; const t = setTimeout(() => { wait.delete(n); rej(new Error(`The browser did not answer in time (${method}, ${Math.round(ms / 1000)} s).`)); }, ms);
          wait.set(n, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
          sock.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      on(fn) { handlers.push(fn); },
      onClose(fn) { closers.push(fn); },
      close() { try { sock.close(); } catch {} },
    });
  });
}

async function prepareTab(c, sid) {
  await c.send('Page.enable', {}, sid);
  await c.send('Runtime.enable', {}, sid);
  await c.send('Page.setLifecycleEventsEnabled', { enabled: true }, sid).catch(() => {});
  await c.send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false }, sid);
  const ua = (S && S.ua) || '';
  if (ua) await c.send('Emulation.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'en-US,en;q=0.9', platform: 'Linux x86_64' }, sid).catch(() => {});
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});" }, sid).catch(() => {});
}

async function attach(targetId) {
  const { sessionId } = await S.c.send('Target.attachToTarget', { targetId, flatten: true });
  await prepareTab(S.c, sessionId);
  return sessionId;
}

/** The running session, started on first use. */
export async function session() {
  if (S && S.alive) { S.lastUsed = Date.now(); return S; }
  if (starting) return starting;
  const bin = findChromium();
  if (!bin) { const e = new Error(NO_BROWSER_HANDS); e.noBrowser = true; throw e; }
  starting = (async () => {
    const b = await launch(bin);
    let c;
    try {
      c = await cdp(b.ws);
      const ver = await c.send('Browser.getVersion').catch(() => ({}));
      S = { proc: b, c, alive: true, tabs: [], lastUsed: Date.now(), started: Date.now(), hidden: new Map(), hiddenIdx: new Map(), hiddenN: 0,
        notes: [], loading: false, loadSeq: 0, ua: String(ver.userAgent || '').replace(/HeadlessChrome/g, 'Chrome'), handoff: null, holdUntil: 0, signup: null, approvedSubmit: false };
      const me = S;
      c.onClose(() => { me.alive = false; if (S === me) S = null; });
      b.child.on('exit', () => { me.alive = false; if (S === me) S = null; });
      await c.send('Target.setDiscoverTargets', { discover: true });
      await c.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
      c.on(onEvent);
      const { targetInfos } = await c.send('Target.getTargets');
      let page = (targetInfos || []).find(t => t.type === 'page');
      const targetId = page ? page.targetId : (await c.send('Target.createTarget', { url: 'about:blank' })).targetId;
      S.targetId = targetId; S.sid = await attach(targetId); S.tabs = [{ targetId, sid: S.sid }];
      startIdleTimer();
      audit('assistant', 'browser.started', 'profile kept in ' + profileDir());
      return S;
    } catch (e) {
      try { c && c.close(); } catch {}
      b.kill(); S = null;
      throw e;
    }
  })();
  try { return await starting; } finally { starting = null; }
}

function onEvent(m) {
  if (!S) return;
  const p = m.params || {};
  if (m.method === 'Target.targetCreated' && p.targetInfo?.type === 'page' && p.targetInfo.openerId) {
    S.newTab = p.targetInfo.targetId;           // a link opened a new tab: the next step moves to it
  } else if (m.method === 'Target.targetDestroyed' || (m.method === 'Target.detachedFromTarget' && p.targetId)) {
    const id = p.targetId;
    const i = S.tabs.findIndex(t => t.targetId === id);
    if (i >= 0) {
      S.tabs.splice(i, 1);
      if (S.targetId === id && S.tabs.length) { const t = S.tabs[S.tabs.length - 1]; S.targetId = t.targetId; S.sid = t.sid; S.notes.push('That tab closed; back on the previous one.'); }
    }
  }
  if (m.sessionId && m.sessionId !== S.sid) return;
  if (m.method === 'Page.frameStartedLoading' && p.frameId === S.targetId) { S.loading = true; S.loadSeq++; }
  else if ((m.method === 'Page.frameStoppedLoading' && p.frameId === S.targetId) || m.method === 'Page.loadEventFired') S.loading = false;
  else if (m.method === 'Page.frameNavigated' && !p.frame?.parentId) S.loadSeq++;
  else if (m.method === 'Page.javascriptDialogOpening') {
    S.notes.push(`The page showed a ${p.type} box: "${String(p.message || '').slice(0, 200)}" (answered OK).`);
    S.c.send('Page.handleJavaScriptDialog', { accept: true }, S.sid).catch(() => {});
  }
}

async function useNewTab() {
  if (!S.newTab) return '';
  const id = S.newTab; S.newTab = null;
  try {
    const sid = await attach(id);
    S.tabs.push({ targetId: id, sid }); S.targetId = id; S.sid = sid;
    await S.c.send('Target.activateTarget', { targetId: id }).catch(() => {});
    return 'A new tab opened; I am on it now (browser_back or closing it returns to the first one).';
  } catch { return ''; }
}

function startIdleTimer() {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    if (!S) { clearInterval(idleTimer); idleTimer = null; return; }
    if (S.busy > 0) return;             // a step is running right now
    const idle = Date.now() - S.lastUsed;
    const base = cfg.testMode && process.env.MA_BROWSER_IDLE_MS ? Number(process.env.MA_BROWSER_IDLE_MS) : idleMinutes() * 60000;   // tests: milliseconds
    const limit = (S.handoff || S.holdUntil > Date.now()) ? Math.max(30 * 60000, base) : base;
    if (idle > limit) closeBrowser('idle for ' + Math.round(idle / 60000) + ' min').catch(() => {});
  }, Math.min(30000, Math.max(1000, parseInt(process.env.MA_BROWSER_IDLE_TICK_MS || '30000', 10))));
  idleTimer.unref?.();
}

export async function closeBrowser(why = 'closed') {
  const s = S; S = null;
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  if (!s) return false;
  s.alive = false;
  try { await s.c.send('Browser.close', {}, undefined, 3000); } catch {}
  try { s.c.close(); } catch {}
  setTimeout(() => s.proc.kill(), 1500).unref();
  audit('assistant', 'browser.closed', why);
  return true;
}
export function sessionInfo() {
  if (!S || !S.alive) return { open: false };
  return { open: true, since: S.started, last_used: S.lastUsed, handoff: S.handoff ? { reason: S.handoff.reason, since: S.handoff.since } : null };
}
export function touch(holdMinutes = 0) { if (S) { S.lastUsed = Date.now(); if (holdMinutes) S.holdUntil = Math.max(S.holdUntil, Date.now() + holdMinutes * 60000); } }
export function busy(d) { if (S) { S.busy = Math.max(0, (S.busy || 0) + d); S.lastUsed = Date.now(); } }
export function current() { return S && S.alive ? S : null; }

// ---------------- page helpers ----------------
export async function evaluate(expr, ms = 15000) {
  const r = await S.c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, S.sid, ms);
  if (r.exceptionDetails) throw new Error('Page script error: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').split('\n')[0].slice(0, 200));
  return r.result ? r.result.value : undefined;
}

/** After a click / key / navigation: wait for a page load if one started, up to `ms`. */
export async function settle(seqBefore, ms = 20000) {
  await sleep(350);
  const end = Date.now() + ms;
  if (S.loadSeq !== seqBefore || S.loading) {
    while (Date.now() < end && S && S.loading) await sleep(150);
    await sleep(300);
  }
  return S ? !S.loading : true;
}

export async function navigate(url) {
  const seq = S.loadSeq;
  S.loading = true;
  const nav = await S.c.send('Page.navigate', { url }, S.sid, 30000);
  if (nav.errorText) { S.loading = false; throw new Error(`The page did not open (${nav.errorText}). Check the address, or the site may be down / blocking this server: ${url}`); }
  const end = Date.now() + 30000;
  while (Date.now() < end && S.loading) await sleep(150);
  const done = !S.loading;
  S.loading = false;
  await sleep(400);
  return { done, seq };
}

/** Hide anything that looks like an API key / token on a page. The AI sees ‹hidden-N›; browser_save_key can use N. */
export function hideKeys(text) {
  if (!S) return String(text || '');
  return String(text || '').replace(/[A-Za-z0-9][A-Za-z0-9_\-]{23,}/g, (m) => {
    if (!/\d/.test(m) || !/[A-Za-z]/.test(m) || /^[a-z]+(-[a-z]+)+$/.test(m)) return m;
    // a long word-with-dashes made of words (css class names, slugs) is not a key: keys have few dashes and mixed case or digits throughout
    const parts = m.split(/[-_]/);
    if (parts.length >= 4 && parts.every(p => /^[a-z]*\d{0,2}$/.test(p))) return m;
    let k = S.hiddenIdx.get(m);
    if (!k) { k = ++S.hiddenN; S.hidden.set(k, m); S.hiddenIdx.set(m, k); rememberSecret(m); }
    return `‹hidden-${k}›`;
  });
}
export function hiddenValue(k) { return S ? S.hidden.get(Number(k)) || '' : ''; }

// Runs in the page: numbers every button / link / box once (window.__maEls keeps them) and reads the text.
const READ = (from, max) => `(() => {
  const els = window.__maEls || (window.__maEls = [null]);
  const SEL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick]';
  const found = [];
  const walk = (root) => { for (const e of root.querySelectorAll('*')) { if (e.matches(SEL)) found.push(e); if (e.shadowRoot) walk(e.shadowRoot); } };
  walk(document);
  for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument && f.contentDocument.body) walk(f.contentDocument); } catch (x) {} }
  const t = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const shown = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width >= 1 && r.height >= 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity || '1') > 0.05; };
  const labelText = (l) => { const k = l.cloneNode(true); k.querySelectorAll('select,option,textarea,input').forEach(x => x.remove()); return t(k.textContent); };
  const label = (e) => {
    const by = e.getAttribute('aria-labelledby');
    const l = t(e.getAttribute('aria-label')) || (e.labels && e.labels.length ? labelText(e.labels[0]) : '') || (by ? t((document.getElementById(by.split(' ')[0]) || {}).innerText) : '') ||
      t(e.getAttribute('placeholder')) || (e.tagName === 'INPUT' && /^(submit|button|reset)$/.test(e.type) ? t(e.value) : '') ||
      (e.tagName === 'SELECT' ? '' : t(e.innerText)) || t(e.title) || t(e.getAttribute('alt')) || t(e.querySelector && e.querySelector('img[alt]') && e.querySelector('img[alt]').alt) || t(e.name) || t(e.id);
    return l.slice(0, 90);
  };
  const vh = innerHeight, out = [];
  for (const e of found) {
    const isBox = e.tagName === 'INPUT' && /^(checkbox|radio)$/.test(e.type);
    if (e.tagName === 'INPUT' && e.type === 'hidden') continue;
    let vis = shown(e);
    if (!vis && isBox && e.labels && e.labels.length && shown(e.labels[0])) vis = true;
    if (!vis) continue;
    let n = els.indexOf(e); if (n < 0) { n = els.length; els.push(e); }
    const tag = e.tagName.toLowerCase(), role = e.getAttribute('role') || '';
    let kind = tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'select' ? 'select' : tag === 'textarea' ? 'textbox' : tag === 'summary' ? 'button' : role || (e.isContentEditable ? 'textbox' : tag);
    const o = { n, kind, label: label(e) };
    if (tag === 'input') { o.kind = /^(submit|button|reset|image)$/.test(e.type) ? 'button' : isBox ? e.type : 'input'; if (o.kind === 'input') o.type = e.type || 'text'; }
    if (o.kind === 'input' || tag === 'textarea') o.value = e.type === 'password' ? (e.value ? '(filled)' : '') : String(e.value || '').slice(0, 80);
    if (isBox || role === 'checkbox' || role === 'switch') o.checked = !!(e.checked || e.getAttribute('aria-checked') === 'true');
    if (tag === 'select') { o.value = e.selectedOptions && e.selectedOptions[0] ? t(e.selectedOptions[0].text) : ''; o.options = [...e.options].slice(0, 25).map(x => t(x.text).slice(0, 40)); }
    if (tag === 'a') { const h = e.getAttribute('href') || ''; if (h && !h.startsWith('javascript')) o.href = h.slice(0, 100); }
    if (e.disabled || e.getAttribute('aria-disabled') === 'true') o.disabled = true;
    if (e.required) o.required = true;
    const r = e.getBoundingClientRect(); if (r.bottom < 0) o.where = 'above'; else if (r.top > vh) o.where = 'below';
    out.push(o);
    if (out.length >= 160) break;
  }
  const body = document.body ? document.body.innerText : '';
  const frames = [...document.querySelectorAll('iframe')].map(f => (f.src || '') + ' ' + (f.title || '')).join(' ');
  return { url: location.href, title: document.title, text: body.slice(${from}, ${from} + ${max}), textLength: body.length, from: ${from}, els: out, frames,
    scroll: Math.round(scrollY), height: Math.round(document.documentElement.scrollHeight), passwordBoxes: document.querySelectorAll('input[type=password]').length };
})()`;

function elLine(o) {
  let s = `[${o.n}] ${o.kind}${o.type && o.type !== 'text' ? ':' + o.type : ''} "${o.label}"`;
  if (o.value !== undefined && o.value !== '') s += ` = "${o.value}"`;
  if (o.options) s += ` options: ${o.options.join(' | ')}`;
  if (o.checked !== undefined) s += o.checked ? ' (checked)' : ' (not checked)';
  if (o.href) s += ` → ${o.href}`;
  if (o.disabled) s += ' (disabled)';
  if (o.required) s += ' (required)';
  if (o.where) s += ` (${o.where}, scroll to see)`;
  return s;
}

/** Read the current page for the AI: text (keys hidden) + numbered elements + robot-check warning. */
export async function readPage({ from = 0, max = 5000 } = {}) {
  const r = await evaluate(READ(Math.max(0, from | 0), Math.max(500, Math.min(12000, max | 0))), 20000);
  const robot = ROBOT_RE.test(r.frames) || /^just a moment|attention required|are you a robot|verify you are human/i.test(r.title) || /verify you are human|i'?m not a robot|press (and|&) hold/i.test(r.text.slice(0, 3000));
  const out = {
    url: hideKeys(r.url), title: hideKeys(r.title),
    text: hideKeys(r.text) + (r.textLength > r.from + r.text.length ? `\n…(more text: browser_read with from=${r.from + r.text.length}; ${r.textLength} characters in all)` : ''),
    elements: r.els.map(o => hideKeys(elLine(o))).join('\n') || '(no buttons, links or boxes found)',
    scroll: `${r.scroll} of ${r.height}px (screen is ${VIEW.height}px tall)`,
  };
  if (robot) out.robot_check = 'This page shows an "I am not a robot" check. You cannot solve it: call browser_handoff so the owner taps it on his phone.';
  if (S.notes.length) out.notes = S.notes.splice(0).join(' ');
  if ([...S.hidden.keys()].length && /‹hidden-\d+›/.test(out.text + out.elements)) out.hidden_note = 'Text that looks like an API key or token is shown as ‹hidden-N›. To save one into Settings use browser_save_key with hidden=N. Never ask to see it.';
  return out;
}

// Runs in the page: scroll element n into view and report where to click (and whether it would submit a form
// that holds a password the assistant just made — that click must go through browser_signup_submit).
const PREP = (n) => `(() => {
  const e = (window.__maEls || [])[${n}];
  if (!e || !e.isConnected) return { missing: true };
  let t = e; const r0 = e.getBoundingClientRect();
  if ((r0.width < 1 || r0.height < 1) && e.labels && e.labels.length) t = e.labels[0];
  t.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  let r = t.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  let w = t.ownerDocument.defaultView;
  while (w && w.frameElement) { const fr = w.frameElement.getBoundingClientRect(); x += fr.left; y += fr.top; w = w.parent; }
  const top = document.elementFromPoint(x, y);
  const ok = !!top && (top === t || t.contains(top) || top.contains(t) || top.tagName === 'IFRAME' || (top.shadowRoot && top.shadowRoot.contains(t)) || (t.getRootNode && t.getRootNode().host === top));
  const form = e.form || (e.closest && e.closest('form'));
  const scope = form || document;
  const madePw = [...scope.querySelectorAll('input')].some(i => i.__maNewPw && i.isConnected);
  const tag = e.tagName, type = (e.getAttribute('type') || '').toLowerCase();
  const words = String(e.innerText || e.value || e.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
  const submits = (form && ((tag === 'BUTTON' && (!type || type === 'submit')) || (tag === 'INPUT' && /^(submit|image)$/.test(type)))) || /sign ?up|register|create( an| my| your)? account|join|get started|submit|continue|next|agree|start free/i.test(words);
  return { x: Math.round(x), y: Math.round(y), ok, cover: ok || !top ? '' : (top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + ' "' + String(top.innerText || '').trim().slice(0, 40) + '"'),
    guarded: !!(madePw && submits), disabled: !!(e.disabled || e.getAttribute('aria-disabled') === 'true'), words: words.slice(0, 60) };
})()`;

export async function mouseClick(x, y) {
  const c = S.c, sid = S.sid;
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sid, 8000);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, sid, 8000);
  await sleep(40);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, sid, 8000);
}

export class Refused extends Error {}

export async function clickElement(n, { approved = false } = {}) {
  const p = await evaluate(PREP(Number(n)));
  if (p.missing) throw new Refused(`There is no element [${n}] on this page any more (the page changed). Call browser_read for fresh numbers.`);
  if (p.guarded && !approved && !S.approvedSubmit) throw new Refused(`[${n}] "${p.words}" would send the sign-up form with the password I made. Use browser_signup_submit with element=${n} so the owner can say YES first.`);
  const seq = S.loadSeq;
  if (p.ok) await mouseClick(p.x, p.y);
  else await evaluate(`(() => { const e = window.__maEls[${Number(n)}]; const t = (e.getBoundingClientRect().width < 1 && e.labels && e.labels[0]) || e; t.click(); return 1; })()`);
  const done = await settle(seq);
  const tab = await useNewTab();
  return { clicked: n, what: p.words || undefined, note: [p.disabled ? 'That element looked disabled, so maybe nothing happened.' : '', !p.ok ? `Something covered it (${p.cover}), so I clicked it directly.` : '', tab, done ? '' : 'The page is still loading; browser_wait a little, then browser_read.'].filter(Boolean).join(' ') || undefined };
}

export async function focusElement(n, clear = true) {
  const r = await evaluate(`(() => { const e = (window.__maEls || [])[${Number(n)}]; if (!e || !e.isConnected) return 'missing';
    e.scrollIntoView({ block: 'center', behavior: 'instant' }); e.focus();
    const ok = e.matches('input,textarea,select') || e.isContentEditable; if (!ok) return 'notbox';
    if (${clear ? 'true' : 'false'}) { if (e.isContentEditable) { const s = getSelection(); s.selectAllChildren(e); } else if (e.select && e.type !== 'number' && e.type !== 'email') e.select(); else { try { e.setSelectionRange(0, e.value.length); } catch (x) { e.select && e.select(); } } }
    return e.type === 'password' ? 'password' : 'ok'; })()`);
  if (r === 'missing') throw new Refused(`There is no element [${n}] on this page any more. Call browser_read for fresh numbers.`);
  if (r === 'notbox') throw new Refused(`[${n}] is not a box you can type into. Pick an input or textbox number from browser_read.`);
  return r;
}

export async function typeText(text) {
  // select-all + insertText replaces the old value and fires the input events frameworks (React, Vue) listen to
  if (text === '') { await S.c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, S.sid); await S.c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, S.sid); return; }
  await S.c.send('Input.insertText', { text: String(text) }, S.sid, 15000);
}

const KEYS = { enter: ['Enter', 'Enter', 13, '\r'], tab: ['Tab', 'Tab', 9], escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27], backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46],
  arrowdown: ['ArrowDown', 'ArrowDown', 40], arrowup: ['ArrowUp', 'ArrowUp', 38], arrowleft: ['ArrowLeft', 'ArrowLeft', 37], arrowright: ['ArrowRight', 'ArrowRight', 39],
  down: ['ArrowDown', 'ArrowDown', 40], up: ['ArrowUp', 'ArrowUp', 38], pagedown: ['PageDown', 'PageDown', 34], pageup: ['PageUp', 'PageUp', 33], home: ['Home', 'Home', 36], end: ['End', 'End', 35], space: [' ', 'Space', 32, ' '] };
export function keyNames() { return Object.keys(KEYS); }
export async function pressKey(name, { approved = false } = {}) {
  const k = KEYS[String(name || '').toLowerCase().replace(/[\s_-]/g, '')];
  if (!k) throw new Refused(`Unknown key "${name}". Keys: Enter, Tab, Escape, Backspace, Delete, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, PageDown, PageUp, Home, End, Space.`);
  if (k[0] === 'Enter' && !approved && !S.approvedSubmit) {
    const g = await evaluate(`(() => { const e = document.activeElement; const f = e && (e.form || (e.closest && e.closest('form'))); return !!f && [...f.querySelectorAll('input')].some(i => i.__maNewPw); })()`);
    if (g) throw new Refused('Enter here would send the sign-up form with the password I made. Use browser_signup_submit (the owner says YES first).');
  }
  const seq = S.loadSeq;
  const base = { key: k[0], code: k[1], windowsVirtualKeyCode: k[2], nativeVirtualKeyCode: k[2] };
  await S.c.send('Input.dispatchKeyEvent', { type: k[3] ? 'keyDown' : 'rawKeyDown', ...base, ...(k[3] ? { text: k[3], unmodifiedText: k[3] } : {}) }, S.sid);
  await S.c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, S.sid);
  const done = await settle(seq);
  const tab = await useNewTab();
  return { pressed: k[0], note: [tab, done ? '' : 'The page is still loading.'].filter(Boolean).join(' ') || undefined };
}

export async function screenshotJpeg(quality = 70, scale = 1) {
  const r = await S.c.send('Page.captureScreenshot', { format: 'jpeg', quality, ...(scale !== 1 ? { clip: { x: 0, y: 0, width: VIEW.width, height: VIEW.height, scale } } : {}) }, S.sid, 20000);
  return r.data;
}
export async function screenshotPng() { const r = await S.c.send('Page.captureScreenshot', { format: 'png' }, S.sid, 20000); return Buffer.from(r.data, 'base64'); }
export async function wheel(x, y, dy) {
  await S.c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy }, S.sid);
  await sleep(250);
}
export const VIEWPORT = VIEW;

// ---------------- the owner's live view (handoff) ----------------
export function startHandoff(info) { if (!S) return null; S.handoff = { ...info, since: Date.now() }; S.lastUsed = Date.now(); return S.handoff; }
export function endHandoff() { if (!S || !S.handoff) return null; const h = S.handoff; S.handoff = null; S.lastUsed = Date.now(); return h; }
export async function liveFrame() {
  if (!S || !S.alive) return { active: false };
  const info = await evaluate('({ url: location.href, title: document.title })', 5000).catch(() => ({ url: '', title: '' }));
  const img = await screenshotJpeg(60);
  return { active: true, url: hideKeys(info.url), title: hideKeys(info.title), w: VIEW.width, h: VIEW.height, img: 'data:image/jpeg;base64,' + img, handoff: S.handoff ? { reason: S.handoff.reason, since: S.handoff.since } : null };
}
export async function liveInput(b) {
  if (!S || !S.alive) throw new Error('The browser is closed.');
  S.lastUsed = Date.now();
  const x = Math.max(0, Math.min(VIEW.width - 1, Number(b.x) || 0)), y = Math.max(0, Math.min(VIEW.height - 1, Number(b.y) || 0));
  if (b.kind === 'tap') { const seq = S.loadSeq; await mouseClick(x, y); await settle(seq, 8000); await useNewTab(); }
  else if (b.kind === 'text') { await typeText(String(b.text || '').slice(0, 2000)); }
  else if (b.kind === 'key') { await pressKey(b.key, { approved: true }); }
  else if (b.kind === 'scroll') { await wheel(x || VIEW.width / 2, y || VIEW.height / 2, Math.max(-3000, Math.min(3000, Number(b.dy) || 0))); }
  else throw new Error('Unknown action');
  return { ok: true };
}
