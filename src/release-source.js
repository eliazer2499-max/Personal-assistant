// Where updates come from: the default release site, or the owner's own GitHub repo ("owner/name").
// Used by the in-app update check (as the app user) and by the root updater (bin/update-source.mjs).
export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ghBase = () => (process.env.MA_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');

function ghHeaders(token, accept = 'application/vnd.github+json') {
  return { Accept: accept, 'User-Agent': 'myassistant-updater', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
}
export async function ghGet(path, token) {
  const r = await fetch(ghBase() + path, { headers: ghHeaders(token), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, j };
}
const cleanVer = (t) => String(t || '').trim().replace(/^v/i, '');

/**
 * Latest release of a GitHub repo.
 * -> { version, notes, asset: { url, name } | null, sha: { url } | null, tarball_url, tag }
 * Prefers a release asset named myassistant-latest.tar.gz (or myassistant-<ver>.tar.gz) with its .sha256;
 * a release without assets, or a repo with only tags, falls back to GitHub's source tarball.
 */
export async function latestFromGithub(repo, token) {
  if (!REPO_RE.test(String(repo || ''))) throw new Error('Update source must look like owner/name');
  let r = await ghGet(`/repos/${repo}/releases/latest`, token);
  if (r.ok) {
    const assets = r.j.assets || [];
    const tgz = assets.find(a => a.name === 'myassistant-latest.tar.gz') || assets.find(a => /^myassistant-[\d.]+\.tar\.gz$/.test(a.name));
    const sha = tgz && assets.find(a => a.name === tgz.name + '.sha256');
    return { version: cleanVer(r.j.tag_name || r.j.name), notes: String(r.j.body || '').slice(0, 2000), tag: r.j.tag_name,
      asset: tgz ? { url: tgz.url, name: tgz.name } : null, sha: sha ? { url: sha.url } : null, tarball_url: r.j.tarball_url };
  }
  if (r.status === 404) {
    const t = await ghGet(`/repos/${repo}/tags?per_page=1`, token);
    if (t.ok && Array.isArray(t.j) && t.j[0]) return { version: cleanVer(t.j[0].name), notes: '', tag: t.j[0].name, asset: null, sha: null, tarball_url: t.j[0].tarball_url };
    throw new Error(`GitHub repo ${repo}: no release or tag found (or it is private and no GitHub token is saved in Vault)`);
  }
  throw new Error(`GitHub said ${r.status}: ${String(r.j.message || '').slice(0, 200)}`);
}
/** Download a GitHub asset (API url, works for private repos with a token) or a tarball url to a Buffer. */
export async function ghDownload(url, token, asset = true) {
  const r = await fetch(url, { headers: ghHeaders(token, asset ? 'application/octet-stream' : 'application/vnd.github+json'), redirect: 'follow', signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error('Download failed: ' + r.status);
  const b = Buffer.from(await r.arrayBuffer());
  if (b.length > 200 * 1024 * 1024) throw new Error('Download too big');
  return b;
}

// ---------------------------------------------------------------------------------------------------
// 2.3.1: update sources, tried in order. Each one has the same layout as the release site:
//   <base>/version.json · <base>/myassistant-<VERSION>.tar.gz (+ .sha256) · <base>/myassistant-latest.tar.gz (+ .sha256) · <base>/install.sh
// 1. the owner's own address (GitHub Pages from the repo's /docs folder): https://updates.personalassistance.soft-tech.net
// 2. the same /docs folder straight from GitHub: https://raw.githubusercontent.com/eliazer2499-max/Personal-assistant/main/docs
// 3. the release site: https://abish-assistant-v2.sites.tab.bot (MA_RELEASE_BASE)
// A source that fails (network, 404, bad version.json) or is behind is skipped and the next one is used.
// A sha256 mismatch is never "fixed" by another source: the update stops.
export const DEFAULT_SOURCE = 'https://updates.personalassistance.soft-tech.net';
export const GITHUB_DOCS = 'https://raw.githubusercontent.com/eliazer2499-max/Personal-assistant/main/docs';
export const SITE_SOURCE = 'https://abish-assistant-v2.sites.tab.bot';

/** A pasted GitHub repo link becomes its /docs folder on raw.githubusercontent.com. */
export function normalizeSource(s) {
  s = String(s || '').trim().replace(/\/+$/, '');
  const gh = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/i.exec(s);
  if (gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/main/docs`;
  s = s.replace(/\/(version\.json|install\.sh)$/, '');
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) s = 'https://' + s;          // "personalassistance.soft-tech.net"
  return s;
}
export const label = (u) => String(u || '').replace(/^https:\/\//, '');
/** The primary source, then the fallbacks, without repeats. */
export function sourceList(primary, fallbacks = []) {
  const out = [];
  for (const s of [primary, ...fallbacks].map(normalizeSource)) if (/^https?:\/\/[^\s/]+/.test(s) && !out.includes(s)) out.push(s);
  return out;
}
async function get(url, timeout = 20000) {
  let r;
  try { r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'myassistant-updater', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(timeout) }); }
  catch (e) { throw new Error('could not connect (' + (e.cause?.code || e.name) + ')'); }
  if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
  return r;
}
/** version.json of one source → { version, notes, base } */
export async function versionAt(base) {
  const r = await get(base + '/version.json', 15000);
  let j; try { j = JSON.parse(await r.text()); } catch { throw new Error('version.json is not valid JSON'); }
  const v = String(j?.version || '').trim().replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error('version.json has no valid "version"');
  return { version: v, notes: String(j.notes || '').slice(0, 2000), base };
}
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
/**
 * The newest version on the sources. The first source that answers is used unless it is behind
 * (then a later source with a newer version wins). → { version, notes, base, skipped: ['label: why', …] }
 */
export async function findLatest(sources, current = '0.0.0') {
  const skipped = []; let best = null;
  for (const base of sources) {
    try {
      const v = await versionAt(base);
      if (!best) best = v;
      else if (newer(v.version, best.version)) best = v;
      if (newer(best.version, current)) break;                    // found an update: stop looking
    } catch (e) { skipped.push(`${label(base)}: ${e.message}`); }
  }
  if (!best) throw new Error('no update source answered (' + skipped.join('; ') + ')');
  return { ...best, skipped };
}
/** Download <base>/myassistant-<v>.tar.gz (or -latest) and check its .sha256. A mismatch throws (code 'sha'). */
export async function downloadVerified(base, version) {
  let r, name;
  for (name of [`myassistant-${version}.tar.gz`, 'myassistant-latest.tar.gz']) {
    try { r = await get(`${base}/${name}`, 300000); break; } catch (e) { if (name === 'myassistant-latest.tar.gz' || e.status !== 404) throw e; }
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 200 * 1024 * 1024) throw new Error('download too big');
  const want = (await (await get(`${base}/${name}.sha256`)).text()).trim().split(/\s+/)[0].toLowerCase();
  const { createHash } = await import('node:crypto');
  const got = createHash('sha256').update(buf).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(want) || want !== got) throw Object.assign(new Error(`sha256 mismatch for ${label(base)}/${name} (expected ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…) — not installing`), { code: 'sha' });
  return { buf, sha: got, name };
}
