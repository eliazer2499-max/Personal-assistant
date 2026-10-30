// Servers: the assistant logs in with SSH. Read-only commands run directly; anything else waits for YES.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { cfg } from '../config.js';
import { get, all, redact } from '../db.js';
import { unseal, token } from '../crypto.js';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const N = (description) => ({ type: 'number', description });

export const sshDir = () => path.join(cfg.dataDir, 'ssh');
export function appKey() {
  const d = sshDir(); fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const k = path.join(d, 'id_ed25519');
  if (!fs.existsSync(k)) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'my-assistant', '-f', k], { stdio: 'ignore', timeout: 20000 });
  return { privPath: k, pub: fs.readFileSync(k + '.pub', 'utf8').trim() };
}

// ---------- read-only classifier ----------
const SIMPLE = new Set(['ls', 'cat', 'head', 'tail', 'df', 'du', 'free', 'uptime', 'uname', 'whoami', 'id', 'hostname', 'hostnamectl', 'date', 'ps', 'pgrep', 'w', 'who', 'last', 'lsblk', 'lscpu', 'lsb_release', 'nproc', 'ss', 'netstat', 'grep', 'egrep', 'fgrep', 'zgrep', 'wc', 'sort', 'uniq', 'cut', 'tr', 'stat', 'file', 'which', 'whereis', 'pwd', 'echo', 'tree', 'sha256sum', 'md5sum', 'vmstat', 'iostat', 'dig', 'nslookup', 'host', 'ping', 'getent', 'dmesg', 'du', 'timedatectl', 'node', 'python3', 'php', 'nginx', 'apache2ctl', 'mysql', 'psql', 'top', 'crontab', 'readlink', 'realpath', 'basename', 'dirname', 'jq', 'column', 'less', 'more', 'zcat', 'test', 'true']);
const SUBCMD = {
  systemctl: ['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'list-timers', 'show', 'cat', '--failed'],
  docker: ['ps', 'logs', 'images', 'inspect', 'version', 'info', 'stats'],
  git: ['status', 'log', 'diff', 'show', 'remote', 'rev-parse', 'describe', 'ls-files', 'blame'],
  apt: ['list', 'policy', 'show', 'search'], 'apt-cache': ['policy', 'show', 'search', 'depends'],
  dpkg: ['-l', '-L', '-s', '--list', '--status'], 'dpkg-query': null, journalctl: null,
  ip: ['a', 'addr', 'address', 'r', 'route', 'link', '-br', '-4', '-6', 's', 'neigh'], pm2: ['ls', 'list', 'status', 'logs', 'show', 'describe'],
  find: null, ufw: ['status'], certbot: ['certificates'], kubectl: ['get', 'describe', 'logs', 'top', 'version'], npm: ['ls', 'list', 'view', 'outdated', '-v', '--version'],
};
const BAD_ARGS = {
  find: /(^|\s)-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/,
  journalctl: /--(vacuum|rotate|flush|sync|relinquish|setup-keys)/,
  docker: /\b(stats)\b(?!.*--no-stream)/,       // docker stats without --no-stream never ends
  git: /\b(remote\s+(add|remove|rm|rename|set-url|prune))\b/,
  top: /^(?!.*-b)/,                                 // top only in batch mode
  node: /./, python3: /./, php: /./, mysql: /./, psql: /./, // only with a version flag (checked below)
  nginx: /^(?!\s*-[tTv]\s*$)/, apache2ctl: /^(?!\s*-(t|S|M)\s*$)/, crontab: /^(?!\s*-l\s*$)/,
  tail: /(^|\s)(-f|-F|--follow)/, less: /./, more: /./, ping: /^(?!.*-c\s*\d)/,
  ufw: /./, kubectl: /(--watch|-w\b)/,
};
function splitWords(seg) {
  const out = []; let cur = '', q = null;
  for (const ch of seg) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (q) return null;
  if (cur) out.push(cur);
  return out;
}
/** true only when every piece of the command is on the read-only list. Anything unsure -> false (needs YES). */
export function isReadOnly(command) {
  const c = String(command || '').trim();
  if (!c || c.length > 2000) return false;
  if (/[;&`<>\n\r]|\$\(|\$\{|\|\||\\/.test(c.replace(/2>\/dev\/null|2>&1/g, ''))) return false;
  for (const seg of c.replace(/2>\/dev\/null|2>&1/g, '').split('|')) {
    const w = splitWords(seg.trim());
    if (!w || !w.length) return false;
    let [prog, ...rest] = w;
    if (/^(sudo|su|doas|env|xargs|nohup|timeout|nice|watch|sh|bash|zsh|eval|exec|tee|dd|awk|sed|perl|ruby)$/.test(prog) || prog.includes('/') || prog.includes('=')) return false;
    const args = rest.join(' ');
    const versionOnly = /^(-v|-V|--version|-version)$/.test(args.trim());
    if (['node', 'python3', 'php', 'mysql', 'psql'].includes(prog)) { if (versionOnly) continue; return false; }
    if (prog in SUBCMD) {
      const allowed = SUBCMD[prog];
      if (allowed) { const sub = rest.find(x => !x.startsWith('-') || allowed.includes(x)); if (!sub || !allowed.includes(sub)) return false; }
      if (BAD_ARGS[prog] && BAD_ARGS[prog].test(args)) return false;
      if (prog === 'git' && rest[0] === 'branch' ) return false;
      continue;
    }
    if (!SIMPLE.has(prog)) return false;
    if (BAD_ARGS[prog] && BAD_ARGS[prog].test(args)) return false;
  }
  return true;
}

export function serverRow(name) {
  const r = get('SELECT * FROM servers WHERE name=?', String(name || '').toLowerCase()) || get('SELECT * FROM servers WHERE host=?', String(name || ''));
  if (!r) throw new Error(`No server named "${name}". Saved: ${all('SELECT name FROM servers').map(x => x.name).join(', ') || 'none — add one on the Servers page'}`);
  return r;
}

export function sshExec(srv, command, timeoutS = 60) {
  return new Promise((resolve) => {
    let keyPath, tmp = null;
    if (srv.key_kind === 'pasted') {
      tmp = path.join(sshDir(), 'tmp-' + token(8)); fs.writeFileSync(tmp, unseal(srv.key_enc).trim() + '\n', { mode: 0o600 }); keyPath = tmp;
    } else keyPath = appKey().privPath;
    const args = ['-i', keyPath, '-p', String(srv.port || 22), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'UserKnownHostsFile=' + path.join(sshDir(), 'known_hosts'), '-o', 'IdentitiesOnly=yes', '-o', 'ServerAliveInterval=20', '-o', 'LogLevel=ERROR',
      `${srv.user}@${srv.host}`, '--', command];
    const child = spawn(cfg.sshBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', killed = false;
    child.stdout.on('data', d => { out += d; if (out.length > 200000) out = out.slice(-100000); });
    child.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutS * 1000);
    const done = (code, err) => {
      clearTimeout(t); if (tmp) try { fs.rmSync(tmp); } catch {}
      const o = redact(out);
      resolve({ server: srv.name, exit_code: code, timed_out: killed, output: (err ? err + '\n' : '') + (o.length > 30000 ? '…' + o.slice(-30000) : o) });
    };
    child.on('close', c => done(c));
    child.on('error', e => done(-1, 'ssh could not start: ' + e.message));
  });
}

export default [
  { name: 'servers_list', description: 'List the servers the assistant can log into.', params: {},
    run: async () => ({ servers: all('SELECT name,host,port,user,notes FROM servers ORDER BY name') }) },
  { name: 'ssh_run', description: 'Run a command on one of the owner\'s servers over SSH. Read-only commands (ls, cat, df, systemctl status, docker ps, journalctl, git status…) run right away; anything that changes the server (install, restart, rm, write, deploy, sudo) files an approval and waits for the owner\'s YES.',
    params: { server: S('Server name from servers_list'), command: S('The shell command'), timeout_seconds: N('Default 60, max 1800') },
    required: ['server', 'command'],
    approval: (a) => isReadOnly(a.command) ? null : `Run on server "${a.server}":\n${a.command}`,
    run: async ({ server, command, timeout_seconds }) => sshExec(serverRow(server), command, Math.min(1800, Math.max(5, timeout_seconds || 60))) },
];
