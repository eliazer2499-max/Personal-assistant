// 2.3.16: published sites at <public address>/sites/<name>/… (Abish, Nov 8 2026: "When i visit a wrong url from a
// published site on the assistant it shows nothing. Can we add a 404 error page?").
// Caddy serves the files that exist (as before); anything it can't find under /sites/ comes here, and this serves
// it too when the app is reached directly. Rules:
//   - /sites/<name>            → 301 to /sites/<name>/
//   - a folder                 → its index.html (a folder path without the last / is redirected to add it)
//   - a missing page           → 404 with the site's own 404.html when it has one, else a plain built-in page
//   - an unknown site          → 404, built-in page without a link
//   - nothing outside the sites folder can be reached (.., encoded .., symlinks out, hidden files)
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.csv': 'text/csv; charset=utf-8',
};
export const SITE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The built-in "Page not found" page. home = the site's address, or null when the site itself does not exist. */
export function notFoundPage(shownPath, home) {
  const p = esc(String(shownPath || '/').slice(0, 300));
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Page not found</title>
<style>
:root{color-scheme:light dark}
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f6f9;color:#1b2430;padding:24px;box-sizing:border-box}
main{max-width:420px;text-align:center}
.code{font-size:64px;font-weight:800;letter-spacing:-2px;margin:0;color:#94a3b8}
h1{font-size:22px;margin:4px 0 10px}
p{margin:0 0 18px;color:#5b6675}
code{display:inline-block;max-width:100%;overflow-wrap:anywhere;background:rgba(127,127,127,.14);border-radius:6px;padding:2px 7px;font-size:14px;color:inherit}
a.btn{display:inline-block;padding:11px 20px;border-radius:12px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600}
@media (prefers-color-scheme:dark){body{background:#0b0f15;color:#e6edf5}p{color:#9aa7b6}.code{color:#475569}}
</style></head>
<body><main>
<p class="code">404</p>
<h1>Page not found</h1>
<p>There is no page at <code>${p}</code>.${home ? '' : ' This site does not exist.'}</p>
${home ? `<a class="btn" href="${esc(home)}">Go to the home page</a>` : ''}
</main></body></html>
`;
}

function headers(type, size, extra = {}) {
  return { 'Content-Type': type, 'Content-Length': String(size), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer-when-downgrade', 'Cache-Control': 'no-cache', ...extra };
}
function send404(req, res, rel, siteDir, home) {
  let body = null, type = 'text/html; charset=utf-8';
  if (siteDir) {
    try {
      const own = path.join(siteDir, '404.html');
      const real = fs.realpathSync(own);
      if (real.startsWith(fs.realpathSync(siteDir) + path.sep) && fs.statSync(real).isFile()) body = fs.readFileSync(real);
    } catch {}
  }
  if (!body) body = Buffer.from(notFoundPage(rel, home));
  res.writeHead(404, headers(type, body.length));
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

/**
 * Handle GET/HEAD /sites/… . Returns true when it answered. sitesDir defaults to cfg.sitesDir.
 */
export function serveSite(req, res, sitesDir = cfg.sitesDir) {
  const url = new URL(req.url, 'http://x');
  const m = /^\/sites(?:\/([^/]*)(\/.*)?)?$/.exec(url.pathname);
  if (!m) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }); res.end('Method not allowed'); return true; }
  let name = '';
  try { name = decodeURIComponent(m[1] || ''); } catch { name = ''; }
  const shown = url.pathname;
  const root = path.resolve(sitesDir);
  if (!name || !SITE_NAME.test(name) || name.startsWith('.')) return send404(req, res, shown, null, null);
  const siteDir = path.join(root, name);
  let siteOk = false; try { siteOk = fs.statSync(siteDir).isDirectory() && fs.realpathSync(siteDir).startsWith(fs.realpathSync(root) + path.sep); } catch {}
  if (!siteOk) return send404(req, res, shown, null, null);
  const home = '/sites/' + encodeURIComponent(name) + '/';
  if (m[2] === undefined) { res.writeHead(301, { Location: home + url.search, 'Content-Length': '0' }); res.end(); return true; }
  // the path inside the site: every part decoded and checked (no .., no hidden files, no NUL, no backslash tricks)
  let parts;
  try { parts = m[2].split('/').slice(1).map(decodeURIComponent); } catch { return send404(req, res, shown, siteDir, home); }
  if (parts.some(p => p === '..' || p === '.' || p.includes('\0') || p.includes('/') || p.includes('\\') || (p.startsWith('.') && p !== '.well-known'))) return send404(req, res, shown, siteDir, home);
  let file = path.join(siteDir, ...parts.filter(Boolean));
  const realSite = fs.realpathSync(siteDir);
  let st;
  try { const real = fs.realpathSync(file); if (real !== realSite && !real.startsWith(realSite + path.sep)) return send404(req, res, shown, siteDir, home); file = real; st = fs.statSync(file); }
  catch { return send404(req, res, shown, siteDir, home); }
  if (st.isDirectory()) {
    if (!url.pathname.endsWith('/')) { res.writeHead(301, { Location: url.pathname + '/' + url.search, 'Content-Length': '0' }); res.end(); return true; }
    file = path.join(file, 'index.html');
    try { st = fs.statSync(file); if (!st.isFile()) throw new Error('no index'); } catch { return send404(req, res, shown, siteDir, home); }
  } else if (!st.isFile()) return send404(req, res, shown, siteDir, home);
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const base = { ETag: etag, 'Last-Modified': st.mtime.toUTCString(), 'Accept-Ranges': 'bytes' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, base); res.end(); return true; }
  let start = 0, end = st.size - 1, status = 200;
  const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (rg && st.size > 0 && (rg[1] !== '' || rg[2] !== '')) {
    if (rg[1] === '') start = Math.max(0, st.size - parseInt(rg[2], 10)); else { start = parseInt(rg[1], 10); if (rg[2] !== '') end = Math.min(end, parseInt(rg[2], 10)); }
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return true; }
    status = 206; base['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  res.writeHead(status, headers(type, st.size ? end - start + 1 : 0, base));
  if (req.method === 'HEAD' || !st.size) { res.end(); return true; }
  fs.createReadStream(file, { start, end }).pipe(res);
  return true;
}
