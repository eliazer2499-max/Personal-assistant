// 2.3.19: Settings → Main address (Abish, Nov 8 2026: "I want ai.louisb.vip to be the default … if it's possible
// without [a command] it will be better").
// The main address is MA_PUBLIC_URL in /etc/myassistant/env: every link the assistant sends, site links, sign-in
// return pages and webhooks are built from it. This page shows it and the other addresses this server answers on, checks
// a new one (it must point to this server and open this same assistant over https), and switches. The switch itself
// is done by the root-owned update unit — the one narrow sudo rule "Update now" already uses — which re-runs the
// installer's own address step (env file + web server config), tests the new address once more, and puts everything
// back if that test fails. The old main address stays as an extra address, so nothing that used it stops working.
import dns from 'node:dns';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cfg } from './config.js';
import { setting, setSetting, secret, audit, log } from './db.js';
import { token } from './crypto.js';

// a plain host name with a real (letters) last part: ai.example.com — not an IP, no port, no path
export const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NONCE_MS = 30 * 60 * 1000;
export const REQUEST_FILE = () => path.join(cfg.dataDir, 'address-request');
export const RESULT_FILE = () => path.join(cfg.dataDir, 'address-result');

const bad = (msg) => Object.assign(new Error(msg), { status: 400, plain: true });

/** "https://AI.Example.com/" → "ai.example.com". Throws a plain-words error for anything that is not just an address. */
export function normalizeHost(input) {
  let s = String(input || '').trim();
  if (!s) throw bad('Type an address, like ai.example.com.');
  if (/\s/.test(s)) throw bad('An address has no spaces. Type it like ai.example.com.');
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s); } catch { throw bad(`"${s.slice(0, 80)}" is not a web address. Type it like ai.example.com.`); }
  if (!/^https?:$/.test(u.protocol)) throw bad('Type just the address, like ai.example.com.');
  if (u.username || u.password) throw bad('Type just the address, like ai.example.com.');
  if (u.port) throw bad('The address can\'t have a port number (:' + u.port + '). It always uses the normal secure port.');
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw bad('Type just the address without anything after it, like ai.example.com.');
  const h = u.hostname.replace(/\.$/, '').toLowerCase();
  if (/^\d+(\.\d+){3}$/.test(h) || h.startsWith('[')) throw bad('Use a name, not a number address (IP). For example ai.example.com.');
  if (!HOST_RE.test(h)) throw bad(`"${h.slice(0, 80)}" is not a valid address. Type it like ai.example.com.`);
  return h;
}
const okHost = (h) => { try { return normalizeHost(h); } catch { return ''; } };

export function mainHost() { try { return new URL(cfg.publicUrl).hostname.toLowerCase(); } catch { return ''; } }

/** Hosts on the web server's site line next to the main address (added there by hand). */
export function caddyHosts(file = cfg.caddyFile, main = mainHost()) {
  let t = ''; try { t = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of t.split('\n')) {
    if (!/^[^#\s{].*\{\s*$/.test(line)) continue;
    const hosts = line.replace(/\{\s*$/, '').split(/[,\s]+/).map(x => okHost(x.replace(/:\d+$/, ''))).filter(Boolean);
    if (main && hosts.includes(main)) out.push(...hosts);
  }
  return out;
}
/** The other addresses this server answers on (not the main one), in a stable order, no doubles. */
export function extraHosts() {
  const main = mainHost(), seen = new Set(), out = [];
  for (const h of [...cfg.extraDomains.map(okHost), ...caddyHosts()]) if (h && h !== main && !seen.has(h)) { seen.add(h); out.push(h); }
  return out;
}

const resolver = () => { const r = new dns.promises.Resolver({ timeout: 4000, tries: 2 }); return r; };
/** The IPs the world's DNS gives for a host (A + AAAA). [] when it points nowhere. */
export async function resolveHost(h) {
  if (cfg.testDns) return [...(cfg.testDns[h] || [])];
  const r = resolver(); const out = [];
  for (const fn of ['resolve4', 'resolve6']) { try { out.push(...await r[fn](h)); } catch {} }
  return [...new Set(out)];
}
const ipFromName = (h) => { const m = /^(\d{1,3})[-.](\d{1,3})[-.](\d{1,3})[-.](\d{1,3})\.(?:sslip|nip)\.io$/.exec(h); return m ? m.slice(1, 5).join('.') : ''; };
/** This server's public IPs: what the main address points to (an <ip>.sslip.io name carries it), plus what an IP echo says. */
export async function serverIps() {
  const s = new Set(); const m = mainHost();
  if (ipFromName(m)) s.add(ipFromName(m));
  if (m && okHost(m)) for (const ip of await resolveHost(m)) s.add(ip);
  if (cfg.ipEcho) {
    try { const r = await fetch(cfg.ipEcho, { signal: AbortSignal.timeout(6000) }); const t = (await r.text()).trim(); if (r.ok && /^[\d.:a-f]+$/i.test(t) && t.length < 60) s.add(t); } catch {}
  }
  return [...s];
}

// ---- "is it this same assistant?" — a one-time code only this server knows, asked for over https
export function newNonce() {
  const n = token(18).replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || String(Date.now());
  setSetting('address_nonce', n + ':' + (Date.now() + NONCE_MS));
  return n;
}
/** GET /api/address-check/<code> (no login): answers only the code this server just made. */
export function nonceAnswer(n) {
  const [want, exp] = String(setting('address_nonce') || '').split(':');
  if (!want || !n || Date.now() > Number(exp || 0) || String(n) !== want) return null;
  return { ok: true, assistant: 'my-assistant', code: want };
}
function localHttps(host, p) {     // the same request, sent to this server itself (some home routers can't loop back)
  return new Promise((resolve) => {
    const q = https.request({ host: '127.0.0.1', port: 443, path: p, servername: host, headers: { Host: host }, timeout: 10000 }, (res) => {
      let b = ''; res.on('data', d => { if (b.length < 4000) b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    q.on('timeout', () => { q.destroy(new Error('no answer')); }); q.on('error', (e) => resolve({ error: e.message }));
    q.end();
  });
}
/** { reached, same, via, status, error } */
export async function probe(host, nonce) {
  const p = '/api/address-check/' + encodeURIComponent(nonce);
  const read = (status, body, via) => { let j = null; try { j = JSON.parse(body); } catch {} return { reached: true, same: status === 200 && j?.code === nonce, via, status }; };
  if (cfg.testProbe) {
    const base = cfg.testProbe[host];
    if (!base) return { reached: false, same: false, error: 'no secure page answers on that address yet' };
    try { const r = await fetch(base + p, { redirect: 'manual', signal: AbortSignal.timeout(8000) }); return read(r.status, await r.text(), 'internet'); }
    catch (e) { return { reached: false, same: false, error: e.message }; }
  }
  let err = '';
  try { const r = await fetch('https://' + host + p, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); return read(r.status, await r.text(), 'internet'); }
  catch (e) { err = e.cause?.code || e.cause?.message || e.message; }
  const l = await localHttps(host, p);
  if (!l.error) return read(l.status, l.body, 'this server');
  return { reached: false, same: false, error: plainNetErr(err || l.error) };
}
function plainNetErr(e) {
  const s = String(e || '');
  if (/CERT|certificate|self.signed|altname|SSL|TLS|alert/i.test(s)) return 'the secure certificate for it is not ready on this server';
  if (/ECONNREFUSED|refused/i.test(s)) return 'nothing answered on the secure port';
  if (/timeout|timed out|aborted|no answer/i.test(s)) return 'it did not answer in time';
  if (/ENOTFOUND|EAI_AGAIN/i.test(s)) return 'the address could not be found';
  return 'it could not be opened';
}

/** The check before a switch. ok:false always comes with plain words in message; nothing is changed by a check. */
export async function checkAddress(input) {
  const host = normalizeHost(input);
  const main = mainHost(), extras = extraHosts();
  if (host === main) return { ok: false, host, code: 'same', message: `${host} is already the main address.` };
  const [ips, mine] = await Promise.all([resolveHost(host), serverIps()]);
  const here = mine.length ? mine.join(', ') : 'this server\'s IP';
  if (!ips.length) return { ok: false, host, code: 'no_dns', ips, server_ips: mine,
    message: `${host} doesn't point anywhere yet. Where you bought the domain, add an A record for it pointing to ${here}, wait a few minutes, then check again. Nothing was changed.` };
  const dnsOk = ips.some(ip => mine.includes(ip));
  const served = extras.includes(host);
  const nonce = newNonce();
  const pr = await probe(host, nonce);
  const base = { host, ips, server_ips: mine, dns_ok: dnsOk, served, via: pr.via };
  if (pr.same) return { ...base, ok: true, ready: true, code: 'ready',
    message: `${host} opens this assistant over https. Ready to switch.` + (dnsOk ? '' : ' (It goes through another server on the way, which is fine.)') };
  if (pr.reached) return { ...base, ok: false, code: 'other_server',
    message: `${host} answers, but it is not this assistant${dnsOk ? '' : ` (it points to ${ips.join(', ')}, this server is ${here})`}. Nothing was changed.` };
  if (mine.length && !dnsOk) return { ...base, ok: false, code: 'wrong_dns',
    message: `${host} points to ${ips.join(', ')}, but this server is ${here}. Change its A record to ${mine[0]}, wait a few minutes, then check again. Nothing was changed.` };
  if (!mine.length) return { ...base, ok: false, code: 'unknown_ip',
    message: `Could not confirm that ${host} points to this server, and its secure page did not open (${pr.error}). Nothing was changed.` };
  if (served) return { ...base, ok: false, code: 'no_https',
    message: `${host} points to this server, but its secure page did not open (${pr.error}). Wait a minute and check again. Nothing was changed.` };
  return { ...base, ok: true, ready: false, code: 'new',
    message: `${host} points to this server. It isn't set up here yet, so the switch first sets it up (with a secure certificate) and tests it again. If that test fails, nothing changes.` };
}

/** Where things stand for the page. */
export function addressInfo() {
  const main = mainHost();
  let pending = null; try { pending = JSON.parse(setting('address_switch') || 'null'); } catch {}
  const result = readResult();
  if (pending && result && result.at * 1000 >= (pending.at || 0) - 5000) pending = null;   // the unit finished
  if (pending && Date.now() - pending.at > 15 * 60 * 1000) pending = null;
  const notes = [];
  if (setting('google_client_id')) notes.push({ id: 'google', text: 'Google sign-in: after the switch, add the new return address (shown in Settings → Google accounts) to "Authorized redirect URIs" in your Google console, or adding a Google account will fail. Accounts you already added keep working.' });
  if (setting('wa_phone_number_id') && !(setting('wa_app_id') && secret('wa_app_secret'))) notes.push({ id: 'whatsapp', text: 'WhatsApp business number: its webhook keeps using the old address (which keeps working). To move it, paste the new webhook address from Settings → Channels into your WhatsApp app settings.' });
  const extras = extraHosts();
  return {
    main, main_url: cfg.publicUrl, extras, addresses: allAddresses(main, extras), pending, result,
    telegram: !!secret('telegram_token'), notes,
  };
}
/** 2.3.20: ONE list of every address this server answers on — the main (default) one first, then every extra one.
 *  The main one is always in it, even when it is not a plain name (an IP address), so the list is never empty. */
export function allAddresses(main = mainHost(), extras = extraHosts()) {
  const out = [], seen = new Set();
  const add = (h, isMain) => { if (h && !seen.has(h)) { seen.add(h); out.push({ host: h, url: 'https://' + h, default: isMain }); } };
  add(main || (() => { try { return new URL(cfg.publicUrl).host.toLowerCase(); } catch { return ''; } })(), true);
  for (const h of extras) add(h, false);
  return out;
}
export function readResult() {
  let t = ''; try { t = fs.readFileSync(RESULT_FILE(), 'utf8'); } catch { return null; }
  const o = {}; for (const l of t.split('\n')) { const m = /^([a-z_]+)=(.*)$/.exec(l); if (m) o[m[1]] = m[2]; }
  return o.state ? { state: o.state, main: o.main || '', message: o.message || '', at: Number(o.at || 0) } : null;
}

/** The new list of extra addresses: everything we answer on now, plus the old main, minus the new main. */
export function newExtras(host, main = mainHost(), extras = extraHosts()) {
  const out = [];
  for (const h of [...extras, main]) { const x = okHost(h); if (x && x !== host && !out.includes(x)) out.push(x); }
  return out;
}

/** Writes the request for the root-owned unit and starts it (the same sudo rule as Update now). */
export async function switchAddress(input, confirmed) {
  if (confirmed !== true) throw bad('Not confirmed. Nothing was changed.');
  const c = await checkAddress(input);
  if (!c.ok) { audit('owner', 'address.refused', `${c.host || ''}: ${c.code}`); throw bad(c.message); }
  const main = mainHost(), extra = newExtras(c.host, main);
  const nonce = newNonce();
  const body = `main=${c.host}\nextra=${extra.join(',')}\nold=${okHost(main)}\nnonce=${nonce}\nat=${Math.floor(Date.now() / 1000)}\n`;
  const f = REQUEST_FILE(), tmp = f + '.tmp';
  fs.writeFileSync(tmp, body, { mode: 0o600 }); fs.renameSync(tmp, f);
  setSetting('address_switch', JSON.stringify({ to: c.host, from: main, at: Date.now() }));
  audit('owner', 'address.switch', `${main} → ${c.host} (kept: ${extra.join(', ') || 'none'})`);
  if (cfg.testMode) return { started: false, note: 'test mode: not started', to: c.host, extras: extra };
  const child = spawn('sudo', ['-n', '/usr/bin/systemctl', 'start', '--no-block', cfg.updateUnit], { detached: true, stdio: 'ignore' });
  child.on('error', (e) => log('address switch: could not start the unit', e.message));
  child.unref();
  return { started: true, to: c.host, extras: extra };
}

// ---- after a restart on a new main address: webhooks follow it
export async function syncAfterStart({ telegram, sms, whatsapp } = {}) {
  const prev = setting('last_public_url'); const now = cfg.publicUrl;
  const steps = [];
  if (telegram) { try { const r = await telegram.syncWebhook(); if (r) steps.push(r); } catch (e) { steps.push('Telegram webhook: ' + e.message); } }
  if (prev && prev !== now) {
    if (sms) { try { const r = await sms.resync(); if (r) steps.push(r); } catch (e) { steps.push('SMS webhook: ' + e.message); } }
    if (whatsapp) { try { const r = await whatsapp.resync(); if (r) steps.push(r); } catch (e) { steps.push('WhatsApp webhook: ' + e.message); } }
    audit('system', 'address.changed', `${prev} → ${now}${steps.length ? ' | ' + steps.join(' | ') : ''}`.slice(0, 900));
  }
  setSetting('last_public_url', now);
  return steps;
}
