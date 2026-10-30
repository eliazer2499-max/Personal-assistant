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
