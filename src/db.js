// SQLite storage (node:sqlite, built into Node 22). One file: <dataDir>/assistant.db
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { seal, unseal } from './crypto.js';

export let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS secrets (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated INTEGER);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, csrf TEXT, created INTEGER, expires INTEGER, ip TEXT, ua TEXT);
CREATE TABLE IF NOT EXISTS login_fail (ip TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, channel TEXT, text TEXT, meta TEXT, job_id INTEGER, ts INTEGER);
CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, status TEXT, title TEXT, progress TEXT, steps INTEGER DEFAULT 0, created INTEGER, updated INTEGER, result TEXT, parent_approval INTEGER, meta TEXT);
CREATE TABLE IF NOT EXISTS job_events (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER, ts INTEGER, kind TEXT, text TEXT);
CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT, args TEXT, summary TEXT, status TEXT, created INTEGER, expires INTEGER, decided_at INTEGER, decided_via TEXT, result TEXT, job_id INTEGER, channel TEXT);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, actor TEXT, action TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, fact TEXT);
CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, notes TEXT, due INTEGER, remind INTEGER DEFAULT 1, status TEXT DEFAULT 'open', created INTEGER, reminded INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT, next_run INTEGER, every_minutes INTEGER, channel TEXT, active INTEGER DEFAULT 1, created INTEGER);
CREATE TABLE IF NOT EXISTS google_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, name TEXT, scopes TEXT, token TEXT, added INTEGER, status TEXT);
CREATE TABLE IF NOT EXISTS servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, host TEXT, port INTEGER, user TEXT, key_kind TEXT, key_enc TEXT, notes TEXT, added INTEGER);
CREATE TABLE IF NOT EXISTS platforms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, kind TEXT, base_url TEXT, extra TEXT, token TEXT, added INTEGER);
CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, sender TEXT, text TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, ts INTEGER);
CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, created INTEGER, updated INTEGER);
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT, mime TEXT, size INTEGER, kind TEXT, created INTEGER, chat_id INTEGER, message_id INTEGER);
CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_ev_job ON job_events(job_id);
CREATE INDEX IF NOT EXISTS idx_ap_status ON approvals(status);
`;

export function openDb(file) {
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const f = file || path.join(cfg.dataDir, 'assistant.db');
  db = new DatabaseSync(f);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  try { fs.chmodSync(f, 0o600); } catch {}
  migrate(f);
  return db;
}

// ---- schema migrations (safe to run on every start; each step checks before it changes anything) ----
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
export function migrate(file) {
  // 2.1.0: multiple chats. Old single-chat history becomes "Chat 1"; nothing is deleted.
  const needMsg = !cols('messages').includes('chat_id'), needJob = !cols('jobs').includes('chat_id');
  if (needMsg || needJob) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    if (n > 0 && file && file !== ':memory:') {
      // A full copy of the database before the first change, kept next to the nightly backups (never auto-deleted).
      try {
        const dir = path.join(path.dirname(file), 'backups');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const b = path.join(dir, `pre-2.1.0-${Date.now()}.db`);
        db.exec(`VACUUM INTO '${b.replace(/'/g, "''")}'`);
        try { fs.chmodSync(b, 0o600); } catch {}
      } catch (e) { console.log(new Date().toISOString(), 'pre-migration backup failed:', e.message); }
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!cols('messages').includes('chat_id')) db.exec('ALTER TABLE messages ADD COLUMN chat_id INTEGER');
      if (!cols('jobs').includes('chat_id')) db.exec('ALTER TABLE jobs ADD COLUMN chat_id INTEGER');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  if (!cols('jobs').includes('parent_job')) db.exec('ALTER TABLE jobs ADD COLUMN parent_job INTEGER');   // 2.1.0 helper jobs
  db.exec('BEGIN IMMEDIATE');
  try {
    const orphans = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id IS NULL').get().n
      + db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE chat_id IS NULL').get().n;
    if (orphans) {
      let first = db.prepare('SELECT id FROM chats ORDER BY id LIMIT 1').get();
      if (!first) {
        const t = db.prepare('SELECT MIN(ts) AS a, MAX(ts) AS b FROM messages').get();
        const r = db.prepare('INSERT INTO chats(title,created,updated) VALUES(?,?,?)').run('Chat 1', t.a || Date.now(), t.b || Date.now());
        first = { id: Number(r.lastInsertRowid) };
        db.prepare("INSERT INTO settings(k,v) VALUES('main_chat',?) ON CONFLICT(k) DO NOTHING").run(String(first.id));
      }
      const main = db.prepare("SELECT v FROM settings WHERE k='main_chat'").get();
      const target = main && db.prepare('SELECT id FROM chats WHERE id=?').get(Number(main.v)) ? Number(main.v) : first.id;
      db.prepare('UPDATE messages SET chat_id=? WHERE chat_id IS NULL').run(target);
      db.prepare('UPDATE jobs SET chat_id=? WHERE chat_id IS NULL').run(target);
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_id, id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_files_msg ON files(message_id)');
    if (db.prepare('PRAGMA user_version').get().user_version < 2) db.exec('PRAGMA user_version=2');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const now = () => Date.now();
export function all(sql, ...a) { return db.prepare(sql).all(...a); }
export function get(sql, ...a) { return db.prepare(sql).get(...a); }
export function run(sql, ...a) { return db.prepare(sql).run(...a); }

// ---- settings (plain, non-secret) ----
export const DEFAULTS = {
  assistant_name: 'My Assistant',
  provider: 'gemini',               // gemini | openai (any OpenAI-compatible URL)
  model: 'gemini-3.6-flash',
  openai_base_url: 'https://api.openai.com/v1',
  openai_model: '',
  max_steps: '40',                  // most model steps in one background job
  max_minutes: '60',                // longest a single job may run
  history_messages: '16',
  max_parallel: '3',                // jobs at the same time (1-6)
  image_model: 'gemini-3.1-flash-image', // picture creation (Gemini image model)
  update_repo: '',                  // blank = release site; or a GitHub repo owner/name
  timezone: 'America/New_York',
  notify_channel: 'web',            // web | telegram | whatsapp | sms | email
  morning_summary: '1',
  morning_time: '07:30',
  continue_after_approval: '1',
  email_channel: '0',
  email_account: '',
  update_url: '',                   // blank = <release base>/version.json
  backup_keep: '14',
  backup_drive_account: '',
  google_client_id: '',
  telegram_chat_id: '',
  telegram_bot: '',
  sms_base_url: 'https://api.sms-gate.app/3rdparty/v1',
  sms_username: '',
  sms_allow: '',                    // owner phone numbers, comma separated (E.164)
  wa_phone_number_id: '',
  wa_waba_id: '',
  wa_app_id: '',
  wa_api_version: 'v23.0',
  wa_allow: '',
  owner_emails: '',
  last_summary_day: '',
  last_backup_day: '',
  last_update_check: '0',
  update_available: '',
  setup_done: '0',
};
export function setting(k) {
  const r = get('SELECT v FROM settings WHERE k=?', k);
  return r ? r.v : (DEFAULTS[k] ?? '');
}
export function setSetting(k, v) {
  run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v ?? ''));
}
export function allSettings() {
  const o = { ...DEFAULTS };
  for (const r of all('SELECT k,v FROM settings')) o[r.k] = r.v;
  return o;
}

// ---- secrets (AES-256-GCM sealed with master.key) ----
export function setSecret(k, v) {
  if (v === null || v === undefined || v === '') { run('DELETE FROM secrets WHERE k=?', k); return; }
  run('INSERT INTO secrets(k,v,updated) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated=excluded.updated', k, seal(v), now());
  rememberSecret(String(v));
}
export function secret(k) {
  const r = get('SELECT v FROM secrets WHERE k=?', k);
  if (!r) return '';
  const v = unseal(r.v); rememberSecret(v); return v;
}
export function hasSecret(k) { return !!get('SELECT 1 AS x FROM secrets WHERE k=?', k); }

// Every secret value we have ever decrypted in this process; redact() hides them from logs and audit.
const KNOWN = new Set();
export function rememberSecret(v) { if (v && String(v).length >= 8) KNOWN.add(String(v)); }
export function redact(text) {
  let s = String(text ?? '');
  for (const v of KNOWN) if (s.includes(v)) s = s.split(v).join('[hidden]');
  return s
    .replace(/AIza[0-9A-Za-z_\-]{20,}/g, '[hidden]')
    .replace(/\b\d{6,12}:[A-Za-z0-9_\-]{30,}\b/g, '[hidden]')          // Telegram bot tokens
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[hidden]')
    .replace(/\bya29\.[0-9A-Za-z_\-]+/g, '[hidden]')
    .replace(/\bEAA[A-Za-z0-9]{30,}\b/g, '[hidden]')                    // Meta tokens
    .replace(/\bsk-[A-Za-z0-9_\-]{20,}\b/g, '[hidden]')
    .replace(/\b(gsk|xai|sk-or-v1)[_-][A-Za-z0-9_\-]{20,}\b/g, '[hidden]')       // Groq / xAI / OpenRouter keys
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[hidden private key]');
}

export function audit(actor, action, detail) {
  run('INSERT INTO audit(ts,actor,action,detail) VALUES(?,?,?,?)', now(), actor, action, redact(typeof detail === 'string' ? detail : JSON.stringify(detail ?? '')).slice(0, 4000));
}
export function log(...a) {
  console.log(new Date().toISOString(), redact(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')));
}
export function seenOnce(id) {
  try { run('INSERT INTO seen(id,ts) VALUES(?,?)', id, now()); return true; } catch { return false; }
}
