// 2.3.7: removing published sites. Three kinds:
//   here       — folders in cfg.sitesDir, served at <public url>/sites/<name>/ (publish_site)
//   cloudflare — Cloudflare Pages projects (cloudflare_pages_publish). With a token + account ID the list shows every
//                Pages project on that account (they are all sites), marked when the assistant made it.
//   github     — repos the assistant pushed with github_publish. Only those it recorded are ever listed or touched:
//                no other repo of his is listed, offered for deletion or deleted. "Turn off Pages" and "Delete repo"
//                are separate actions.
// A small record (platform, name, url, date) is kept for every Cloudflare/GitHub publish (table "published").
// Nothing is removed without the owner: the web page's Delete button (after "Are you sure?") or his YES to the
// unpublish_site tool. Tokens are only sent to the platform's API; they are never logged or returned.
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { all, get, run, now, audit, redact, setting, setSetting } from './db.js';
import { platformToken, safeName } from './tools/workspace.js';

const TIMEOUT = 15000;
const ghName = (n) => {
  const s = String(n || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(s) || s.includes('..')) throw new Error(`Bad GitHub repo "${n}": use owner/name`);
  return s;
};
const tokenOr = (name) => { try { return platformToken(name); } catch { return null; } };

// ---------------------------------------------------------------- records
export function record(platform, name, url, { pages = false, madeRepo = false } = {}) {
  const t = now();
  run(`INSERT INTO published(platform,name,url,created,updated,pages,made_repo) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(platform,name) DO UPDATE SET url=excluded.url, updated=excluded.updated, pages=excluded.pages, made_repo=MAX(made_repo, excluded.made_repo)`,
    platform, name, url || '', t, t, pages ? 1 : 0, madeRepo ? 1 : 0);
}
export const recordOf = (platform, name) => get('SELECT * FROM published WHERE platform=? AND lower(name)=lower(?)', platform, name);
/** Once, on the first list after updating to 2.3.7: sites published before records existed are found in the approval
 *  history (github_publish / cloudflare_pages_publish that he approved and that worked). Only those, nothing else. */
export function backfill() {
  if (setting('published_backfill') === '1') return;
  for (const a of all("SELECT tool,args,result,decided_at FROM approvals WHERE status='done' AND tool IN ('github_publish','cloudflare_pages_publish') ORDER BY id")) {
    try {
      const r = JSON.parse(a.result || '{}'), args = JSON.parse(a.args || '{}');
      let platform, name, url, pages = false;
      if (a.tool === 'github_publish' && typeof r.repo === 'string') { platform = 'github'; name = ghName(r.repo); pages = !!r.pages; url = r.pages || r.repo; }
      else if (a.tool === 'cloudflare_pages_publish' && r.deployed) { platform = 'cloudflare'; name = safeName(args.name); url = r.url || `https://${name}.pages.dev/`; }
      else continue;
      run('INSERT OR IGNORE INTO published(platform,name,url,created,updated,pages,made_repo) VALUES(?,?,?,?,?,?,0)', platform, name, String(url), a.decided_at || now(), now(), pages ? 1 : 0);
    } catch {}
  }
  setSetting('published_backfill', '1');
}
const forgetRecord = (platform, name) => run('DELETE FROM published WHERE platform=? AND lower(name)=lower(?)', platform, name);

// ---------------------------------------------------------------- platform calls
async function ghApi(token, method, p) {
  const r = await fetch(cfg.githubApi + p, { method, headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'myassistant', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(TIMEOUT) });
  let j = null; const text = await r.text(); try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, scopes: r.headers.get('x-oauth-scopes'), msg: redact(String(j?.message || text || '')).slice(0, 200) };
}
async function cfApi(cf, method, p) {
  const r = await fetch(`${cfg.cloudflareApi}/accounts/${encodeURIComponent(cf.extra.account_id)}${p}`, { method, headers: { Authorization: 'Bearer ' + cf.token, Accept: 'application/json', 'User-Agent': 'myassistant' }, signal: AbortSignal.timeout(TIMEOUT) });
  let j = null; try { j = await r.json(); } catch {}
  const errs = Array.isArray(j?.errors) ? j.errors : [];
  return { status: r.status, j, ok: r.ok && j?.success !== false, codes: errs.map(e => e.code), msg: redact(errs.map(e => e.message).join('; ')).slice(0, 200) };
}

// ---------------------------------------------------------------- list
function listHere() {
  fs.mkdirSync(cfg.sitesDir, { recursive: true });
  return fs.readdirSync(cfg.sitesDir).map(n => ({ platform: 'here', name: n, url: `${cfg.publicUrl}/sites/${n}/` }));
}
async function listCloudflare() {
  const recs = all("SELECT * FROM published WHERE platform='cloudflare' ORDER BY created DESC");
  const out = { connected: false, note: '', items: recs.map(r => ({ platform: 'cloudflare', name: r.name, url: r.url, created: r.created, made_by_me: true, exists: null })) };
  const cf = tokenOr('cloudflare');
  if (!cf) { out.note = recs.length ? 'No Cloudflare token saved, so I can\'t check or delete these right now (Vault).' : ''; return out; }
  if (!cf.extra.account_id) { out.note = 'Save your Cloudflare account ID with the token (Vault) so I can list and delete Pages sites.'; return out; }
  try {
    const remote = [];
    for (let page = 1; page <= 10; page++) {
      const r = await cfApi(cf, 'GET', `/pages/projects?page=${page}&per_page=10`);
      if (!r.ok) { out.note = r.status === 403 || r.codes.includes(10000) ? 'Your Cloudflare token can\'t read Pages projects (it needs "Cloudflare Pages: Edit").' : 'Cloudflare didn\'t answer the list: ' + (r.msg || 'HTTP ' + r.status); return out; }
      const got = Array.isArray(r.j?.result) ? r.j.result : [];
      remote.push(...got);
      const info = r.j?.result_info || {};
      if (!got.length || (info.total_pages ? page >= info.total_pages : got.length < 10)) break;
    }
    out.connected = true;
    const byName = new Map(recs.map(r => [r.name.toLowerCase(), r]));
    const items = remote.filter(p => p && typeof p.name === 'string').map(p => {
      const rec = byName.get(p.name.toLowerCase()); byName.delete(p.name.toLowerCase());
      return { platform: 'cloudflare', name: p.name, url: p.subdomain ? `https://${p.subdomain}/` : (rec?.url || `https://${p.name}.pages.dev/`), created: rec?.created || (Date.parse(p.created_on) || null), made_by_me: !!rec, exists: true };
    });
    for (const rec of byName.values()) items.push({ platform: 'cloudflare', name: rec.name, url: rec.url, created: rec.created, made_by_me: true, exists: false });
    out.items = items;
  } catch (e) { out.note = 'Couldn\'t reach Cloudflare: ' + redact(e.message); }
  return out;
}
async function listGithub() {
  const recs = all("SELECT * FROM published WHERE platform='github' ORDER BY created DESC LIMIT 50");
  const out = { connected: false, note: '', items: recs.map(r => ({ platform: 'github', name: r.name, url: r.url, repo_url: 'https://github.com/' + r.name, created: r.created, pages: !!r.pages, made_by_me: true, made_repo: !!r.made_repo, exists: null })) };
  const gh = tokenOr('github');
  if (!gh) { out.note = recs.length ? 'No GitHub token saved, so I can\'t check or change these right now (Vault).' : ''; return out; }
  out.connected = true;
  await Promise.all(out.items.map(async (it) => {
    try {
      const r = await ghApi(gh.token, 'GET', '/repos/' + it.name);
      if (r.status === 200) { it.exists = true; if (typeof r.j?.has_pages === 'boolean') it.pages = r.j.has_pages; }
      else if (r.status === 404) it.exists = false;
    } catch {}
  }));
  return out;
}
/** Everything for the Sites list: here (always), Cloudflare and GitHub (records + what the token can see). */
export async function listSites() {
  try { backfill(); } catch {}
  const [cloudflare, github] = await Promise.all([listCloudflare(), listGithub()]);
  return { here: listHere(), cloudflare, github };
}

// ---------------------------------------------------------------- remove
export const ACTIONS = ['delete', 'pages_off', 'delete_repo', 'forget'];
const GH_DELETE_PERM = 'Your GitHub token is not allowed to delete repositories. It needs the "Administration: Read and write" permission for this repo (fine-grained token), or the "delete_repo" box (classic token). Change it on github.com → Settings → Developer settings → Personal access tokens, then try again. Nothing was deleted.';
const GH_PAGES_PERM = 'Your GitHub token is not allowed to change GitHub Pages for this repo. It needs "Pages: Read and write" and "Administration: Read and write" (fine-grained token), or the "repo" box (classic token). Nothing was changed.';
const CF_PERM = 'Your Cloudflare token is not allowed to delete Pages projects. Give it the "Cloudflare Pages: Edit" permission (Cloudflare → My Profile → API Tokens → edit the token), then try again. Nothing was deleted.';

/** Checks a removal before it is asked for / done. Returns { platform, name, action, summary }; throws a plain message. */
export function planRemoval({ platform, name, action } = {}) {
  const pf = String(platform || 'here').toLowerCase().replace(/^(this server|server|local)$/, 'here');
  let act = String(action || '').toLowerCase() || (pf === 'github' ? '' : 'delete');
  if (!['here', 'cloudflare', 'github'].includes(pf)) throw new Error('Platform must be here, cloudflare or github.');
  if (pf === 'here') {
    const n = safeName(name, 'site name');
    if (!fs.existsSync(path.join(cfg.sitesDir, n))) throw new Error(`No site "${n}" on this server (sites_list shows them).`);
    return { platform: pf, name: n, action: 'delete', summary: `Delete the public site ${cfg.publicUrl}/sites/${n}/ from this server` };
  }
  if (pf === 'cloudflare') {
    const n = safeName(name, 'Cloudflare Pages project name');
    if (act === 'forget') { if (!recordOf('cloudflare', n)) throw new Error(`"${n}" is not on my list.`); return { platform: pf, name: n, action: act, summary: `Remove "${n}" from my list of Cloudflare sites (nothing on Cloudflare is touched)` }; }
    if (act !== 'delete') throw new Error('For Cloudflare the action is "delete".');
    return { platform: pf, name: n, action: act, summary: `Delete the Cloudflare Pages project "${n}" (https://${n}.pages.dev/) with all its versions. The site goes offline. This can't be undone.` };
  }
  const n = ghName(name);
  const rec = recordOf('github', n);
  if (!rec) throw new Error(`I only remove GitHub repos that I published myself, and "${n}" is not one of them. Nothing was changed.`);
  if (!act) throw new Error('For GitHub, say which: "pages_off" (turn off GitHub Pages, the repo stays) or "delete_repo" (delete the whole repository).');
  if (act === 'pages_off') return { platform: pf, name: rec.name, action: act, summary: `Turn off GitHub Pages for ${rec.name} (the site goes offline; the repository and its files stay)` };
  if (act === 'delete_repo' || act === 'delete') return { platform: pf, name: rec.name, action: 'delete_repo', summary: `DELETE the GitHub repository ${rec.name} with all its files and history (and its site). This can't be undone.` };
  if (act === 'forget') return { platform: pf, name: rec.name, action: act, summary: `Remove ${rec.name} from my list of GitHub sites (nothing on GitHub is touched)` };
  throw new Error('For GitHub the action is "pages_off" or "delete_repo".');
}

/** Does it. Only called after the owner's YES or his Delete tap. Returns { ok, message, ... }; throws a plain message. */
export async function removeSite(args = {}, actor = 'owner') {
  const p = planRemoval(args);
  const done = (message, extra = {}) => { audit(actor, 'site.removed', `${p.platform} ${p.name} ${p.action}: ${message}`.slice(0, 300)); return { ok: true, removed: true, platform: p.platform, name: p.name, action: p.action, message, ...extra }; };
  if (p.action === 'forget') { forgetRecord(p.platform, p.name); return done('removed from the list'); }
  if (p.platform === 'here') {
    fs.rmSync(path.join(cfg.sitesDir, p.name), { recursive: true, force: true });
    return done(`Deleted ${cfg.publicUrl}/sites/${p.name}/`);
  }
  if (p.platform === 'cloudflare') {
    const cf = tokenOr('cloudflare');
    if (!cf) throw new Error('No Cloudflare token saved. Add it on the Vault page.');
    if (!cf.extra.account_id) throw new Error('Save your Cloudflare account ID with the token on the Vault page.');
    const r = await cfApi(cf, 'DELETE', '/pages/projects/' + encodeURIComponent(p.name));
    if (r.ok) { forgetRecord('cloudflare', p.name); return done(`Deleted the Cloudflare site ${p.name}.pages.dev`); }
    if (r.status === 404 || r.codes.includes(8000007)) { forgetRecord('cloudflare', p.name); return done(`${p.name} was already gone from Cloudflare; removed it from the list`); }
    if (r.status === 403 || r.codes.includes(10000)) throw Object.assign(new Error(CF_PERM), { kind: 'permission' });
    throw new Error('Cloudflare did not delete it: ' + (r.msg || 'HTTP ' + r.status) + '. Nothing was deleted.');
  }
  const gh = tokenOr('github');
  if (!gh) throw new Error('No GitHub token saved. Add it on the Vault page.');
  if (p.action === 'pages_off') {
    const r = await ghApi(gh.token, 'DELETE', `/repos/${p.name}/pages`);
    const repoUrl = 'https://github.com/' + p.name;
    if (r.status === 204 || r.status === 200) { record('github', p.name, repoUrl, { pages: false }); return done(`Turned off GitHub Pages for ${p.name}. The repo is still there.`); }
    if (r.status === 404) {
      const repo = await ghApi(gh.token, 'GET', '/repos/' + p.name);
      if (repo.status === 200) { record('github', p.name, repoUrl, { pages: false }); return done(`GitHub Pages was already off for ${p.name}.`); }
      throw new Error(`GitHub can't find ${p.name} (already deleted, or the token can't see it). Nothing was changed.`);
    }
    if (r.status === 403) throw Object.assign(new Error(GH_PAGES_PERM), { kind: 'permission' });
    throw new Error('GitHub did not turn Pages off: ' + (r.msg || 'HTTP ' + r.status) + '. Nothing was changed.');
  }
  const r = await ghApi(gh.token, 'DELETE', '/repos/' + p.name);
  if (r.status === 204 || r.status === 200) { forgetRecord('github', p.name); return done(`Deleted the GitHub repository ${p.name}.`); }
  if (r.status === 403) throw Object.assign(new Error(GH_DELETE_PERM), { kind: 'permission' });
  if (r.status === 404) throw new Error(`GitHub can't find ${p.name}: it may already be deleted, or the token can't see it. Nothing was deleted. If it's gone, tap "Remove from list".`);
  throw new Error('GitHub did not delete it: ' + (r.msg || 'HTTP ' + r.status) + '. Nothing was deleted.');
}
