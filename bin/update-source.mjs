#!/usr/bin/env node
// Part of the updater (run by /usr/local/sbin/myassistant-update, only when the owner asks for an update).
//   read            (as the app user)  print {"repo":"owner/name","token":"…"} or {"repo":""} for the default source
//   fetch <dir>     (as root)          download the latest GitHub release into <dir>; reads repo/token from env
//                                      MA_UPDATE_REPO / MA_UPDATE_TOKEN; writes <dir>/app.tgz (verified asset) or <dir>/src.tgz
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [, , mode, outDir] = process.argv;
if (mode === 'read') {
  const { DatabaseSync } = await import('node:sqlite');
  const dataDir = process.env.MA_DATA_DIR || '/var/lib/myassistant';
  const db = new DatabaseSync(path.join(dataDir, 'assistant.db'));
  const repo = (db.prepare("SELECT v FROM settings WHERE k='update_repo'").get()?.v || '').trim();
  let token = '';
  if (repo) {
    const row = db.prepare("SELECT token FROM platforms WHERE name='github'").get();
    if (row?.token) { const c = await import('../src/crypto.js'); c.loadMasterKey(dataDir); try { token = c.unseal(row.token); } catch {} }
  }
  db.close();
  process.stdout.write(JSON.stringify({ repo, token }));
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
} else {
  console.error('usage: update-source.mjs read | fetch <dir>'); process.exit(64);
}
