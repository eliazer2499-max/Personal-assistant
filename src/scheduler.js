// Timers: approvals expiry, task reminders, scheduled jobs, morning summary, email polling,
// update checks, nightly backups.
import fs from 'node:fs';
import path from 'node:path';
import { cfg, VERSION } from './config.js';
import { db, all, run, get, now, setting, setSetting, log, audit } from './db.js';
import { expire } from './approvals.js';
import { notifyOwner } from './notify.js';
import { startJob } from './brain.js';

export function localParts(t = Date.now(), tz = setting('timezone') || 'UTC') {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

export async function reminders() {
  const due = all("SELECT * FROM tasks WHERE status='open' AND remind=1 AND reminded=0 AND due IS NOT NULL AND due <= ?", now());
  for (const t of due) {
    run('UPDATE tasks SET reminded=1 WHERE id=?', t.id);
    await notifyOwner(`⏰ Reminder: ${t.title}${t.notes ? '\n' + t.notes : ''}\n(task ${t.id} — say "done ${t.id}" or ask me to move it)`);
  }
  return due.length;
}
export function schedules() {
  const due = all('SELECT * FROM schedules WHERE active=1 AND next_run <= ?', now());
  for (const s of due) {
    if (s.every_minutes > 0) { let n = s.next_run; while (n <= now()) n += s.every_minutes * 60000; run('UPDATE schedules SET next_run=? WHERE id=?', n, s.id); }
    else run('UPDATE schedules SET active=0 WHERE id=?', s.id);
    startJob({ text: `[Scheduled job ${s.id}, set up earlier by the owner] ${s.prompt}\nWhen done, send the result to the owner with notify_me only if there is something worth telling. If there is nothing new to report, do not message him: answer exactly NO_REPLY.`, channel: 'system', hidden: true, title: 'Scheduled: ' + s.prompt.slice(0, 80) });
  }
  return due.length;
}
export function morning() {
  if (setting('morning_summary') !== '1') return false;
  const { day, hm } = localParts();
  if (setting('last_summary_day') === day || hm < (setting('morning_time') || '07:30')) return false;
  setSetting('last_summary_day', day);
  startJob({ text: '[Morning summary, automatic] Make the owner\'s morning summary: today\'s calendar for every connected Google account, important unread mail (is:unread is:important newer_than:1d), open tasks (overdue first), pending approvals, and any update notice. Short, phone-friendly. Then send it with notify_me.', channel: 'system', hidden: true, title: 'Morning summary' });
  return true;
}

export function backupNow() {
  const dir = path.join(cfg.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { day } = localParts();
  const file = path.join(dir, `assistant-${day}-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  fs.chmodSync(file, 0o600);
  try { fs.copyFileSync(path.join(cfg.dataDir, 'master.key'), path.join(dir, 'master.key.copy')); fs.chmodSync(path.join(dir, 'master.key.copy'), 0o600); } catch {}
  const keep = Math.max(1, parseInt(setting('backup_keep'), 10) || 14);
  const files = fs.readdirSync(dir).filter(f => /^assistant-.*\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f));
  audit('system', 'backup.local', path.basename(file));
  return file;
}
async function backupToDrive(file) {
  const acct = setting('backup_drive_account');
  if (!acct) return;
  const { gapi } = await import('./google.js');
  const buf = fs.readFileSync(file);
  const b = 'ma' + Date.now();
  const meta = { name: 'my-assistant-backup-' + path.basename(file), description: 'Database backup (keys inside are encrypted; restore needs master.key from the server)' };
  const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/octet-stream\r\n\r\n`), buf, Buffer.from(`\r\n--${b}--`)]);
  await gapi(acct, 'POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', body, { headers: { 'Content-Type': 'multipart/related; boundary=' + b } });
  audit('system', 'backup.drive', acct);
}
async function nightly() {
  const { day, hm } = localParts();
  if (hm < '03:00' || setting('last_backup_day') === day) return;
  setSetting('last_backup_day', day);
  try { const f = backupNow(); await backupToDrive(f); } catch (e) { log('backup', e.message); await notifyOwner('Nightly backup had a problem: ' + e.message); }
}
async function updates() {
  try {
    const { checkUpdate } = await import('./updates.js');
    const before = setting('update_available');
    const r = await checkUpdate(false);
    if (r.newer && r.latest !== before && r.latest !== setting('last_update_notice')) {
      setSetting('last_update_notice', r.latest);
      await notifyOwner(`A new version of your assistant is ready: ${r.latest} (you have ${VERSION}).${r.notes ? '\n' + r.notes : ''}\nOpen Settings → Updates and tap "Update now" when you want it. Nothing changes until you do.`);
    }
  } catch (e) { /* offline or no version.json: stay quiet */ }
}

let lastMail = 0, ticking = false;
export async function tick() {
  if (ticking) return; ticking = true;
  try {
    expire();
    run('DELETE FROM sessions WHERE expires < ?', now());
    run('DELETE FROM login_fail WHERE ts < ?', now() - 24 * 3600 * 1000);
    await reminders();
    schedules();
    morning();
    if (now() - lastMail > 55000) { lastMail = now(); const { poll } = await import('./channels/email.js'); await poll(); }
    await nightly();
    await updates();
  } catch (e) { log('tick', e.message); }
  finally { ticking = false; }
}
export function startScheduler() {
  setTimeout(tick, 3000);
  return setInterval(tick, cfg.tickMs);
}
