// Updates: it checks a version.json and TELLS the owner. It only updates when he taps "Update now".
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cfg, VERSION } from './config.js';
import { setting, setSetting, audit, now, get } from './db.js';
import { latestFromGithub } from './release-source.js';

export function cmpVer(a, b) {
  const x = String(a).split('.').map(n => parseInt(n, 10) || 0), y = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}
export function updateRepo() { return String(setting('update_repo') || '').trim(); }
export function updateUrl() { const repo = updateRepo(); return repo ? `https://github.com/${repo}/releases/latest` : (setting('update_url') || cfg.releaseBase + '/version.json'); }
async function githubToken() {
  try { const { platformToken } = await import('./tools/workspace.js'); return get("SELECT 1 AS x FROM platforms WHERE name='github'") ? platformToken('github').token : ''; } catch { return ''; }
}
export async function checkUpdate(force = false) {
  if (!force && now() - Number(setting('last_update_check') || 0) < 12 * 3600 * 1000) return { current: VERSION, latest: setting('update_available') || VERSION };
  setSetting('last_update_check', now());
  let j;
  if (updateRepo()) {
    const rel = await latestFromGithub(updateRepo(), await githubToken());
    j = { version: rel.version, notes: rel.notes };
  } else {
    const r = await fetch(updateUrl(), { signal: AbortSignal.timeout(15000), headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) throw new Error('Update check failed: ' + r.status);
    j = await r.json();
  }
  const newer = cmpVer(j.version, VERSION) > 0;
  setSetting('update_available', newer ? j.version : '');
  setSetting('update_notes', newer ? String(j.notes || '').slice(0, 2000) : '');
  return { current: VERSION, latest: j.version, newer, notes: j.notes || '' };
}
/** Runs only after the owner taps Update now. Starts the root-owned update unit (sudoers allows exactly this). */
export function applyUpdate() {
  audit('owner', 'update.apply', 'from ' + VERSION);
  if (cfg.testMode) return { started: false, note: 'test mode: not started' };
  const child = spawn('sudo', ['-n', '/usr/bin/systemctl', 'start', '--no-block', cfg.updateUnit], { detached: true, stdio: 'ignore' });
  child.unref();
  return { started: true };
}
export function updateLog() {
  try { return fs.readFileSync(path.join(cfg.dataDir, 'update.log'), 'utf8').slice(-4000); } catch { return ''; }
}
