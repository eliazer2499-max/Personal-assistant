// Build tools: per-project workspace, files, commands (as an unprivileged sandbox user), publishing.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cfg } from '../config.js';
import { get, redact } from '../db.js';
import { unseal } from '../crypto.js';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const N = (description) => ({ type: 'number', description });

export function safeName(n, what = 'name') {
  const s = String(n || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(s) || s.includes('..')) throw new Error(`Bad ${what} "${n}": use letters, numbers, dot, dash, underscore`);
  return s;
}
export function projectDir(project, create = false) {
  const d = path.join(cfg.workspace, safeName(project, 'project'));
  if (create) fs.mkdirSync(d, { recursive: true, mode: 0o2770 });
  else if (!fs.existsSync(d)) throw new Error('No project "' + project + '". Create it by writing a file into it.');
  return d;
}
export function inProject(project, rel, create = false) {
  const base = projectDir(project, create);
  const p = path.resolve(base, String(rel || '.').replace(/^\/+/, ''));
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('Path leaves the project folder');
  // Refuse to follow symlinks that point outside the project.
  if (fs.existsSync(p)) { const real = fs.realpathSync(p); const rb = fs.realpathSync(base); if (real !== rb && !real.startsWith(rb + path.sep)) throw new Error('Path leaves the project folder'); }
  return p;
}
export function readWorkspaceFile(project, rel) {
  const p = inProject(project, rel);
  const st = fs.statSync(p);
  if (st.size > 50 * 1024 * 1024) throw new Error('File is over 50 MB');
  return { buf: fs.readFileSync(p), name: path.basename(p) };
}

/** Run a shell command in a project folder as the sandbox user, with a hard timeout. */
export function runInSandbox(cwd, command, { timeoutS = 300, env = {}, maxOut = 30000 } = {}) {
  return new Promise((resolve) => {
    const baseEnv = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', HOME: cfg.sandboxUser ? '/srv/myassistant/sandbox-home' : (process.env.HOME || '/tmp'), CI: '1', ...env };
    const script = 'umask 002; cd ' + JSON.stringify(cwd) + ' && ' + command;
    // The inner `timeout` ends the command even when sudo runs it on its own terminal (Ubuntu's use_pty).
    const inner = ['/usr/bin/timeout', '-k', '10', String(timeoutS), '/bin/bash', '-c', script];
    let cmd, args;
    if (cfg.sandboxUser) {
      // sudoers allows exactly: myassistant -> (ma-run) /usr/bin/env ; nothing as root.
      cmd = 'sudo'; args = ['-n', '-u', cfg.sandboxUser, '--', '/usr/bin/env', '-i', ...Object.entries(baseEnv).map(([k, v]) => k + '=' + v), ...inner];
    } else { cmd = inner[0]; args = inner.slice(1); }
    const child = spawn(cmd, args, { env: cfg.sandboxUser ? { PATH: baseEnv.PATH } : baseEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', killed = false;
    const add = (b) => { out += b.toString(); if (out.length > maxOut * 3) out = out.slice(-maxOut * 2); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const started = Date.now();
    const t = setTimeout(() => { killed = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000); }, (timeoutS + 15) * 1000);
    child.on('close', (code) => {
      clearTimeout(t);
      const o = redact(out);
      resolve({ exit_code: code, timed_out: killed || code === 124 || code === 137 || Date.now() - started >= timeoutS * 1000, output: o.length > maxOut ? '…(earlier output cut)…\n' + o.slice(-maxOut) : o });
    });
    child.on('error', (e) => { clearTimeout(t); resolve({ exit_code: -1, output: 'Could not start: ' + e.message }); });
  });
}

function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true, dereference: false, filter: (s) => !/(^|\/)(\.git|node_modules|\.env)(\/|$)/.test(path.relative(src, s)) });
  const fix = (p) => { const st = fs.lstatSync(p); if (st.isSymbolicLink()) { fs.rmSync(p); return; } fs.chmodSync(p, st.isDirectory() ? 0o755 : 0o644); if (st.isDirectory()) for (const f of fs.readdirSync(p)) fix(path.join(p, f)); };
  fix(dst);
}
export function platformToken(name) {
  const r = get('SELECT * FROM platforms WHERE name=?', String(name).toLowerCase());
  if (!r) throw new Error(`No "${name}" token saved. Add it on the Vault page.`);
  return { ...r, token: unseal(r.token), extra: r.extra ? JSON.parse(r.extra) : {} };
}

export default [
  { name: 'project_list', description: 'List workspace projects (folders where apps and sites are built).', params: {},
    run: async () => {
      fs.mkdirSync(cfg.workspace, { recursive: true });
      return { projects: fs.readdirSync(cfg.workspace, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) };
    } },
  { name: 'file_write', description: 'Create or overwrite a text file inside a workspace project (the project is created if new).',
    params: { project: S('Project name, e.g. my-site'), path: S('File path inside the project, e.g. index.html'), content: S('Full file content') },
    required: ['project', 'path', 'content'],
    run: async ({ project, path: rel, content }) => {
      const p = inProject(project, rel, true);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(content));
      return { written: path.relative(projectDir(project), p), bytes: Buffer.byteLength(String(content)) };
    } },
  { name: 'file_read', description: 'Read a text file from a workspace project.',
    params: { project: S('Project name'), path: S('File path') }, required: ['project', 'path'],
    run: async ({ project, path: rel }) => {
      const { buf } = readWorkspaceFile(project, rel);
      const t = buf.toString('utf8');
      return { path: rel, text: t.slice(0, 30000), truncated: t.length > 30000 };
    } },
  { name: 'file_list', description: 'List files in a workspace project folder.',
    params: { project: S('Project name'), path: S('Sub-folder (optional)') }, required: ['project'],
    run: async ({ project, path: rel }) => {
      const base = inProject(project, rel || '.');
      const out = [];
      const walk = (d, depth) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name === '.git') continue; const p = path.join(d, e.name); out.push(path.relative(base, p) + (e.isDirectory() ? '/' : '')); if (e.isDirectory() && depth < 4 && out.length < 400) walk(p, depth + 1); } };
      walk(base, 0);
      return { files: out.slice(0, 400) };
    } },
  { name: 'run_command', description: 'Run a shell command inside a workspace project as a locked-down user (no access to the assistant\'s keys). Use for builds, tests, npm, python, git. Long builds are fine (timeout up to 1800 s).',
    params: { project: S('Project name'), command: S('Shell command, e.g. "npm install && npm run build"'), timeout_seconds: N('Default 300, max 1800') },
    required: ['project', 'command'],
    run: async ({ project, command, timeout_seconds }) => runInSandbox(projectDir(project, true), command, { timeoutS: Math.min(1800, Math.max(5, timeout_seconds || 300)) }) },

  { name: 'publish_site', description: 'Publish a folder of a project as a public static website on this server at https://<this server>/sites/<name>/. Waits for the owner\'s YES.',
    params: { project: S('Project name'), folder: S('Built folder inside the project, e.g. dist or . (default .)'), name: S('Site name in the address (letters, numbers, dashes)') },
    required: ['project', 'name'],
    approval: (a) => `Publish project "${a.project}" folder "${a.folder || '.'}" publicly at ${cfg.publicUrl}/sites/${a.name}/`,
    run: async ({ project, folder, name }) => {
      const src = inProject(project, folder || '.');
      if (!fs.existsSync(path.join(src, 'index.html'))) throw new Error('That folder has no index.html');
      const dst = path.join(cfg.sitesDir, safeName(name, 'site name'));
      fs.mkdirSync(cfg.sitesDir, { recursive: true });
      copyDir(src, dst);
      return { published: true, url: `${cfg.publicUrl}/sites/${safeName(name)}/` };
    } },
  { name: 'unpublish_site', description: 'Take down a site published on this server. Waits for the owner\'s YES.',
    params: { name: S('Site name') }, required: ['name'],
    approval: (a) => `Delete the public site ${cfg.publicUrl}/sites/${a.name}/`,
    run: async ({ name }) => { fs.rmSync(path.join(cfg.sitesDir, safeName(name)), { recursive: true, force: true }); return { removed: true }; } },
  { name: 'sites_list', description: 'List sites published on this server.', params: {},
    run: async () => { fs.mkdirSync(cfg.sitesDir, { recursive: true }); return { sites: fs.readdirSync(cfg.sitesDir).map(n => ({ name: n, url: `${cfg.publicUrl}/sites/${n}/` })) }; } },

  { name: 'github_publish', description: 'Push a project to a GitHub repository with the owner\'s saved GitHub token (creates the repo if needed), optionally turning on GitHub Pages. Waits for the owner\'s YES.',
    params: { project: S('Project name'), repo: S('Repository name, e.g. my-site (under the token\'s account) or owner/name'), folder: S('Folder to push (default the whole project)'), pages: { type: 'boolean', description: 'Turn on GitHub Pages (needs a public repo on free plans)' }, private: { type: 'boolean', description: 'Create as private (default false)' }, message: S('Commit message') },
    required: ['project', 'repo'],
    approval: (a) => `Push project "${a.project}"${a.folder ? ' (folder ' + a.folder + ')' : ''} to GitHub repo ${a.repo}${a.private ? ' (private)' : ' (public)'}${a.pages ? ' and turn on GitHub Pages' : ''}`,
    run: async ({ project, repo, folder, pages, private: priv, message }) => {
      const gh = platformToken('github');
      const api = (m, p, b) => fetch('https://api.github.com' + p, { method: m, headers: { Authorization: 'Bearer ' + gh.token, Accept: 'application/vnd.github+json', 'User-Agent': 'myassistant', ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
      const me = await (await api('GET', '/user')).json();
      if (!me.login) throw new Error('GitHub token was refused');
      const full = repo.includes('/') ? repo : me.login + '/' + repo;
      let r = await api('GET', '/repos/' + full);
      if (r.status === 404) {
        r = await api('POST', '/user/repos', { name: full.split('/')[1], private: !!priv, auto_init: false });
        if (!r.ok) throw new Error('Could not create repo: ' + (await r.text()).slice(0, 200));
      }
      const dir = inProject(project, folder || '.');
      const basic = Buffer.from('x-access-token:' + gh.token).toString('base64');
      // The token travels in git's environment config (not the command line, not .git/config).
      const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + basic, GIT_TERMINAL_PROMPT: '0' };
      const msg = (message || 'Update from My Assistant').replace(/"/g, "'");
      const res = await runInSandbox(dir, `git init -q -b main 2>/dev/null || git init -q; git checkout -q -B main; git add -A; git -c user.name="My Assistant" -c user.email="assistant@localhost" commit -q -m "${msg}" || true; git push -f https://github.com/${full}.git main 2>&1`, { timeoutS: 600, env });
      if (res.exit_code !== 0) throw new Error('git push failed: ' + res.output.slice(-600));
      let pagesUrl = null;
      if (pages) {
        const p = await api('POST', `/repos/${full}/pages`, { source: { branch: 'main', path: '/' } });
        const pj = await p.json().catch(() => ({}));
        pagesUrl = pj.html_url || `https://${full.split('/')[0]}.github.io/${full.split('/')[1]}/`;
      }
      return { pushed: true, repo: 'https://github.com/' + full, pages: pagesUrl };
    } },
  { name: 'cloudflare_pages_publish', description: 'Deploy a built folder to Cloudflare Pages with the owner\'s saved Cloudflare token (uses wrangler via npx). Waits for the owner\'s YES.',
    params: { project: S('Project name'), folder: S('Built folder, e.g. dist'), name: S('Cloudflare Pages project name') }, required: ['project', 'folder', 'name'],
    approval: (a) => `Deploy project "${a.project}" folder "${a.folder}" to Cloudflare Pages project "${a.name}" (public)`,
    run: async ({ project, folder, name }) => {
      const cf = platformToken('cloudflare');
      if (!cf.extra.account_id) throw new Error('Save your Cloudflare account ID with the token on the Vault page.');
      const env = { CLOUDFLARE_API_TOKEN: cf.token, CLOUDFLARE_ACCOUNT_ID: cf.extra.account_id };
      const n = safeName(name);
      const dir = projectDir(project);
      await runInSandbox(dir, `npx --yes wrangler@3 pages project create ${n} --production-branch=main 2>&1 || true`, { timeoutS: 600, env });
      const res = await runInSandbox(dir, `npx --yes wrangler@3 pages deploy ${JSON.stringify(folder)} --project-name=${n} --branch=main 2>&1`, { timeoutS: 900, env });
      if (res.exit_code !== 0) throw new Error('Cloudflare deploy failed: ' + res.output.slice(-600));
      return { deployed: true, url: `https://${n}.pages.dev/`, output: res.output.slice(-800) };
    } },

  { name: 'android_build_apk', description: 'Make a simple Android app (APK) that shows a project\'s web files or a website. Builds here if the optional Android SDK is installed (x86 servers only); otherwise prepares the project so GitHub builds the APK for free after github_publish.',
    params: { project: S('Project name (its web files go inside the app)'), app_name: S('App name shown on the phone'), url: S('A website address to open instead of local files (optional)'), package_id: S('e.g. com.abish.myapp') },
    required: ['project', 'app_name', 'package_id'],
    run: async ({ project, app_name, url, package_id }) => {
      if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(package_id)) throw new Error('package_id must look like com.name.app');
      const here = path.dirname(new URL(import.meta.url).pathname);
      const tpl = path.resolve(here, '../../templates/android-webview');
      const out = inProject(project, 'android-app', true);
      fs.cpSync(tpl, out, { recursive: true });
      const assets = path.join(out, 'app/src/main/assets/www');
      fs.mkdirSync(assets, { recursive: true });
      const webSrc = projectDir(project);
      for (const f of fs.readdirSync(webSrc)) if (!['android-app', 'node_modules', '.git', '.github'].includes(f)) fs.cpSync(path.join(webSrc, f), path.join(assets, f), { recursive: true });
      const sub = (p, a, b) => { const fp = path.join(out, p); fs.writeFileSync(fp, fs.readFileSync(fp, 'utf8').split(a).join(b)); };
      sub('app/build.gradle', '__PACKAGE__', package_id);
      sub('app/src/main/res/values/strings.xml', '__APP_NAME__', app_name.replace(/[<&>]/g, ''));
      sub('app/src/main/java/app/MainActivity.java', '__START_URL__', url ? JSON.stringify(url).slice(1, -1) : 'file:///android_asset/www/index.html');
      // GitHub Actions workflow at the project root, so github_publish gets a free cloud build.
      fs.mkdirSync(path.join(webSrc, '.github/workflows'), { recursive: true });
      fs.copyFileSync(path.join(tpl, 'build-apk.yml'), path.join(webSrc, '.github/workflows/build-apk.yml'));
      const sdk = '/opt/android-sdk';
      if (!fs.existsSync(path.join(sdk, 'platforms')) || !fs.existsSync('/opt/gradle/bin/gradle')) {
        return { prepared: 'android-app/', built: false, note: 'No local Android SDK (optional; Google\'s Android build tools do not run on ARM servers). Next: github_publish this project; GitHub builds the APK for free (repo → Actions → latest run → Artifacts → app-debug).' };
      }
      const res = await runInSandbox(out, `export ANDROID_HOME=${sdk} ANDROID_SDK_ROOT=${sdk}; /opt/gradle/bin/gradle --no-daemon -q assembleDebug 2>&1 | tail -40`, { timeoutS: 1800 });
      const apk = path.join(out, 'app/build/outputs/apk/debug/app-debug.apk');
      if (!fs.existsSync(apk)) throw new Error('Build failed: ' + res.output.slice(-800));
      return { built: true, apk: 'android-app/app/build/outputs/apk/debug/app-debug.apk', note: 'To get it on the phone: publish_site the project (then open /sites/<name>/android-app/app/build/outputs/apk/debug/app-debug.apk) or drive_upload it.' };
    } },
];
