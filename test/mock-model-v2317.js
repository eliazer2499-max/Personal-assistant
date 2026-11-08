// Fake model for the 2.3.17 tests (Abish, Nov 8 1:23 AM screenshot). globalThis.__M2317.mode = what it answers to the
// [System note] job after his YES: 'restate' = "Site published: <link>" (his bug), 'restate2' = "✅ Your site is live at <link>",
// 'more' = a real extra step, 'quiet' = NO_REPLY.
//   PUBLISH <project> <name>      → publish_site (waits for his YES), then NO_REPLY
//   ...the design and the logo... → writes a page with a logo PLACEHOLDER first (his bug); after the guard's note it
//                                    writes a real logo.svg and uses it
//   "placeholder" in his words    → a placeholder he asked for (no nudge expected)
globalThis.__M2317 ||= { mode: 'restate', notes: [], nudged: 0 };
const PLACEHOLDER_PAGE = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>SoftTech</title></head><body><header><div class="logo-placeholder">LOGO</div><h1>SoftTech</h1></header></body></html>';
export const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 64" role="img" aria-label="SoftTech"><rect x="2" y="2" width="60" height="60" rx="14" fill="#1d4ed8"/><path d="M42 20c-4-4-18-4-18 4s18 6 18 14-14 8-18 4" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/><text x="76" y="42" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#0f172a">SoftTech</text></svg>';
export const REAL_PAGE = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="logo.svg"><title>SoftTech</title><style>body{margin:0;font-family:Arial,sans-serif;color:#0f172a}header{display:flex;align-items:center;padding:16px;background:#eff6ff}header img{height:44px}.hero{padding:40px 20px;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:#fff}.hero h1{margin:0 0 8px;font-size:30px}.btn{display:inline-block;margin-top:16px;padding:12px 20px;border-radius:10px;background:#fff;color:#1d4ed8;font-weight:700;text-decoration:none}</style></head><body><header><img src="logo.svg" alt="SoftTech"></header><section class="hero"><h1>Tech that just works</h1><p>Phones, computers and setup for your home and office.</p><a class="btn" href="#contact">Contact us</a></section></body></html>';
export default async function mock2317({ items }) {
  const M = globalThis.__M2317;
  const last = items[items.length - 1];
  const users = items.filter(i => i.role === 'user');
  const t = String(users[users.length - 1]?.text || '');
  const firstUser = String(users[0]?.text || '');
  if (last?.role === 'tool') {
    if (last.name === 'publish_site') return { text: 'NO_REPLY', calls: [] };
    if (last.name === 'file_write') {
      const p = last.result?.written || '';
      if (p === 'index.html' && M.stage === 'placeholder') { M.stage = 'said'; return { text: "I've removed the details and added a logo placeholder.", calls: [] }; }
      if (p === 'logo.svg') return { text: '', calls: [{ id: 'w-2', name: 'file_write', args: { project: M.project, path: 'index.html', content: REAL_PAGE } }] };
      if (p === 'index.html') return { text: 'New design with your logo (blue S mark + SoftTech). Picture above.', calls: [] };
    }
    return { text: 'DONE', calls: [] };
  }
  if (t.startsWith('[System note] He asked for a real logo')) { M.nudged++; return { text: '', calls: [{ id: 'w-1', name: 'file_write', args: { project: M.project, path: 'logo.svg', content: LOGO_SVG } }] }; }
  if (t.startsWith('[System note')) {
    M.notes.push(t);
    const url = (/"url":"([^"]+)"/.exec(t) || [])[1] || '';
    if (M.mode === 'restate') return { text: 'Site published: ' + url, calls: [] };
    if (M.mode === 'restate2') return { text: '✅ Your site is live at ' + url + ' 🎉', calls: [] };
    if (M.mode === 'more') return { text: 'I also added the contact form you asked for earlier, with your phone number.', calls: [] };
    return { text: 'NO_REPLY', calls: [] };
  }
  let m;
  if ((m = /PUBLISH (\S+) (\S+)/.exec(t))) return { text: '', calls: [{ id: 'p-0', name: 'publish_site', args: { project: m[1], name: m[2] } }] };
  if (/logo|design/i.test(t)) {
    M.stage = 'placeholder';
    return { text: '', calls: [{ id: 'w-0', name: 'file_write', args: { project: M.project, path: 'index.html', content: PLACEHOLDER_PAGE } }] };
  }
  return { text: 'ANSWER: ' + t.replace(/\n/g, ' | '), calls: [] };
}
