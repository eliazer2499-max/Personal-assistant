#!/usr/bin/env node
// Part of the updater (run by /usr/local/sbin/myassistant-update, only when the owner asks for an update).
//   read            (as the app user)  print {"repo":"owner/name","token":"…"} or {"repo":""} for the default source
//   fetch <dir>     (as root)          download the latest GitHub release into <dir>; reads repo/token from env
//                                      MA_UPDATE_REPO / MA_UPDATE_TOKEN; writes <dir>/app.tgz (verified asset) or <dir>/src.tgz
//   fetch-auto <dir> (as root, 2.3.1)  the update sources in order (MA_UPDATE_SOURCE or https://updates.personalassistance.soft-tech.net,
//                                      then raw.githubusercontent.com/…/main/docs, then MA_RELEASE_BASE): version.json, then
//                                      myassistant-<VER>.tar.gz + .sha256 (checked). Writes <dir>/app.tgz.
//                                      Exit 2 = sha256 mismatch (nothing written, no fallback); 3 = only older versions; 1 = nothing worked.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [, , mode, outDir] = process.argv;
if (mode === 'read') {
  const { DatabaseSync } = await import('node:sqlite');
  const dataDir = process.env.MA_DATA_DIR || '/var/lib/myassistant';
  const db = new DatabaseSync(path.join(dataDir, 'assistant.db'));
  const repo = (db.prepare("SELECT v FROM settings WHERE k='update_repo'").get()?.v || '').trim();
  const source = (db.prepare("SELECT v FROM settings WHERE k='update_source'").get()?.v || '').trim();
  let token = '';
  if (repo) {
    const row = db.prepare("SELECT token FROM platforms WHERE name='github'").get();
    if (row?.token) { const c = await import('../src/crypto.js'); c.loadMasterKey(dataDir); try { token = c.unseal(row.token); } catch {} }
  }
  db.close();
  process.stdout.write(JSON.stringify(source ? { repo, token, source } : { repo, token }));
} else if (mode === 'fetch' && outDir) {
  const { latestFromGithub, ghDownload } = await import('../src/release-source.js');
  const repo = process.env.MA_UPDATE_REPO, token = process.env.MA_UPDATE_TOKEN || '';
  const rel = await latestFromGithub(repo, token);
  console.log(`GitHub ${repo}: latest is ${rel.tag || rel.version}`);
  if (rel.asset) {
    const tgz = await ghDownload(rel.asset.url, token, true);
    if (rel.sha) {
      const want = (await ghDownload(rel.sha.url, token, true)).toString('utf8').trim().split(/\s+/)[0].toLowerCase();
      const got = crypto.createHash('sha256').update(tgz).digest('hex');
      if (want !== got) { console.error('Download check failed (sha256 mismatch)'); process.exit(2); }
      console.log('sha256 ok', got);
    } else console.log('no .sha256 asset next to the tarball; relying on HTTPS from GitHub');
    fs.writeFileSync(path.join(outDir, 'app.tgz'), tgz);
  } else {
    console.log('release has no myassistant-latest.tar.gz asset; using the source tarball of', rel.tag);
    fs.writeFileSync(path.join(outDir, 'src.tgz'), await ghDownload(rel.tarball_url, token, false));
  }
} else if (mode === 'fetch-auto' && outDir) {
  const { sourceList, findLatest, versionAt, downloadVerified, label, DEFAULT_SOURCE, GITHUB_DOCS, SITE_SOURCE } = await import('../src/release-source.js');
  const site = (process.env.MA_RELEASE_BASE || SITE_SOURCE).replace(/\/+$/, '');
  const fallbacks = process.env.MA_UPDATE_FALLBACKS !== undefined ? process.env.MA_UPDATE_FALLBACKS.split(',').filter(Boolean) : [GITHUB_DOCS];
  const list = sourceList(process.env.MA_UPDATE_SOURCE || DEFAULT_SOURCE, [...fallbacks, site]);
  const here = path.dirname(new URL(import.meta.url).pathname);
  let current = '0.0.0'; try { current = fs.readFileSync(path.join(here, '..', 'VERSION'), 'utf8').trim(); } catch {}
  const older = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };
  console.log('update sources, in order: ' + list.map(label).join(' → '));
  let info;
  try { info = await findLatest(list, current); }
  catch (e) { console.error('Could not find an update: ' + e.message); process.exit(1); }
  for (const s of info.skipped) console.log('skipped ' + s);
  if (older(info.version, current)) { console.error(`The newest version found (${info.version}) is older than the installed ${current}; not installing.`); process.exit(3); }
  console.log(`latest is ${info.version} at ${label(info.base)}`);
  // download from that source; if it fails (not a checksum problem), the next sources that have this version or newer
  let got = null;
  for (const base of [info.base, ...list.filter(b => b !== info.base)]) {
    try {
      const v = base === info.base ? info : await versionAt(base);
      if (older(v.version, info.version)) { console.log(`skipped ${label(base)}: it has ${v.version}`); continue; }
      got = await downloadVerified(base, v.version);
      console.log(`downloaded ${got.name} from ${label(base)}; sha256 ok ${got.sha}`);
      fs.writeFileSync(path.join(outDir, 'source.txt'), `${label(base)} ${v.version}\n`);
      break;
    } catch (e) {
      if (e.code === 'sha') { console.error('Download check failed: ' + e.message); process.exit(2); }
      console.log(`download from ${label(base)} failed: ${e.message}`);
    }
  }
  if (!got) { console.error('Download failed from every source.'); process.exit(1); }
  fs.writeFileSync(path.join(outDir, 'app.tgz'), got.buf);
} else {
  console.error('usage: update-source.mjs read | fetch <dir> | fetch-auto <dir>'); process.exit(64);
}
