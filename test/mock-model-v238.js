// Fake model for the 2.3.8 tests: drives the real browser tools step by step like a model would.
// "SIGNUP <url>" signs up at the local test site (the final button through the owner's YES), reads the code from the
// fake Gmail, makes an API key and saves it (YES again). "ROBOT <url>" meets a robot check and asks the owner for help.
// "LOGIN <url>" logs in with the saved login. Anything else: the 2.3.7 mock.
import mockPrev from './mock-model-v237.js';
const num = (els, re) => { for (const l of String(els || '').split('\n')) { const m = /^\[(\d+)\]/.exec(l); if (m && re.test(l)) return Number(m[1]); } return null; };
const call = (...cs) => ({ text: '', calls: cs.map(([name, args]) => ({ id: 'c' + Math.random().toString(36).slice(2, 8), name, args })) });
export default async function mock238(args) {
  const { items, noTools } = args;
  let lu = -1; for (let i = items.length - 1; i >= 0; i--) if (items[i].role === 'user') { lu = i; break; }
  const ask = String(items[lu]?.text || '');
  const res = items.slice(lu + 1).filter(x => x.role === 'tool');
  const R = (i) => res[i]?.result || {};
  const last = res[res.length - 1];
  const G = globalThis.__v238 || (globalThis.__v238 = {});
  if (noTools) return mockPrev(args);
  let m;
  if ((m = /SIGNUP (\S+)/.exec(ask))) {
    const U = G.url = m[1];
    if (res.length === 0) return call(['signup_start', { site: U }]);
    if (res.length === 1) { G.email = R(0).email; return call(['browser_open', { url: U + '/signup' }]); }
    if (res.length === 2) {
      const e = R(1).elements; G.submit = num(e, /button "Create account"/);
      return call(['browser_type', { element: num(e, /"Full name"/), text: 'Abish Test' }], ['browser_type', { element: num(e, /input:email/), text: G.email }],
        ['browser_new_password', { elements: [num(e, /"Password"/), num(e, /"Repeat password"/)], site: U }], ['browser_select', { element: num(e, /select/), option: 'Israel' }],
        ['browser_click', { element: num(e, /checkbox/) }], ['browser_click', { element: G.submit }]);
    }
    if (res.length === 8) { G.refused = R(7); return call(['browser_signup_submit', { element: G.submit, site: U, email: G.email }]); }
    return { text: `Filled in the sign-up form. Waiting for your YES (${R(8).approval}).`, calls: [] };
  }
  if (/approved request A\d+ \(browser_signup_submit\)/.test(ask)) {
    const U = G.url;
    if (res.length === 0) return call(['signup_check_email', { site: U, wait_seconds: 15 }]);
    if (res.length === 1) { G.mail = R(0); return call(['browser_read', {}]); }
    if (res.length === 2) { const e = R(1).elements; return call(['browser_type', { element: num(e, /Verification code/), text: G.mail.codes[0], secret: true }], ['browser_click', { element: num(e, /button "Verify"/) }]); }
    if (res.length === 4) return call(['browser_read', {}]);
    if (res.length === 5) return call(['browser_click', { element: num(R(4).elements, /link "API keys"/) }]);
    if (res.length === 6) return call(['browser_read', {}]);
    if (res.length === 7) return call(['browser_click', { element: num(R(6).elements, /Create new key/) }]);
    if (res.length === 8) return call(['browser_read', {}]);
    if (res.length === 9) { G.keyPage = R(8); const h = /‹hidden-(\d+)›/.exec(R(8).text); return call(['browser_save_key', { hidden: h ? Number(h[1]) : 0, site: U, save_as: 'ai_key', name: 'LocalTest (free)', ai_kind: 'openai', base_url: U + '/v1', model: 'pic-1', use_for: 'pictures' }]); }
    return { text: `Signed up and made a key. Waiting for your YES to save it (${R(9).approval}).`, calls: [] };
  }
  if (/approved request A\d+ \(browser_save_key\)/.test(ask)) return { text: 'The key is saved in Settings → Brain → AI keys.', calls: [] };
  if ((m = /ROBOT (\S+)/.exec(ask))) {
    if (res.length === 0) return call(['browser_open', { url: m[1] + '/robot' }]);
    if (res.length === 1) { G.robotRead = R(0); return call(['browser_handoff', { reason: 'tap the robot check' }]); }
    return { text: 'Waiting for you to tap it.', calls: [] };
  }
  if (/tapped Done on the live browser/.test(ask)) {
    if (res.length === 0) return call(['browser_read', {}]);
    G.afterDone = R(0);
    return { text: 'Thanks, I am past the check: ' + R(0).title, calls: [] };
  }
  if ((m = /LOGIN (\S+)/.exec(ask))) {
    if (res.length === 0) return call(['browser_open', { url: m[1] + '/login' }]);
    if (res.length === 1) { const e = R(0).elements; return call(['browser_fill_login', { site: m[1], email_element: num(e, /input:email/), password_element: num(e, /input:password/) }], ['browser_click', { element: num(e, /button "Log in"/) }]); }
    if (res.length === 3) return call(['browser_read', {}]);
    G.loginPage = R(3);
    return { text: 'Logged in: ' + R(3).title, calls: [] };
  }
  return mockPrev(args);
}
