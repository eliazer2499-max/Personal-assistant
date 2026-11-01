// 2.3.8 tests: a tiny local website with a real sign-up flow (form → email code → API keys page), a log-in page and a
// robot-check page. It "sends" its emails through onEmail() (the tests put them in the fake Gmail inbox).
import http from 'node:http';
import crypto from 'node:crypto';

export function signupSite({ onEmail = () => {} } = {}) {
  const users = new Map();          // email → { name, password, verified, code, token }
  const keys = [];                  // API keys made
  const state = { users, keys, robotPassed: false, posts: [] };
  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font:16px sans-serif;margin:20px;max-width:640px} label{display:block;margin:10px 0} .terms input{opacity:0;position:absolute;width:0;height:0} .terms span{display:inline-block;width:18px;height:18px;border:1px solid #333;vertical-align:middle;margin-right:6px} .terms input:checked+span{background:#2a6} code{background:#eee;padding:4px}</style></head><body>${body}</body></html>`;
  const cookieUser = (req) => { const m = /lt_user=([^;]+)/.exec(req.headers.cookie || ''); return m ? decodeURIComponent(m[1]) : ''; };
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const u = new URL(req.url, 'http://x'); const p = u.pathname;
    const f = new URLSearchParams(body);
    const html = (s, code = 200, h = {}) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...h }); res.end(s); };
    const go = (to, h = {}) => { res.writeHead(302, { Location: to, ...h }); res.end(); };
    if (req.method === 'POST') state.posts.push({ path: p, fields: [...f.keys()] });
    if (p === '/') return html(page('LocalTest AI — home', `<h1>LocalTest AI</h1><p>Free picture-making API for testing.</p><a href="/signup">Sign up free</a> · <a href="/login">Log in</a>`));
    if (p === '/signup' && req.method === 'GET') return html(page('Create your account', `<h1>Create your account</h1>${u.searchParams.get('err') ? '<p style="color:red">' + u.searchParams.get('err') + '</p>' : ''}
<form method="post" action="/signup">
<label>Full name <input name="name" required></label>
<label>Email address <input name="email" type="email" required></label>
<label>Password <input name="password" type="password" required></label>
<label>Repeat password <input name="password2" type="password" required></label>
<label>Country <select name="country"><option value="">Choose…</option><option value="us">United States</option><option value="il">Israel</option></select></label>
<label class="terms"><input type="checkbox" name="terms" required><span></span>I agree to the terms</label>
<button type="submit">Create account</button>
</form>`));
    if (p === '/signup' && req.method === 'POST') {
      const email = f.get('email') || '', pw = f.get('password') || '';
      if (pw.length < 12 || pw !== f.get('password2')) return go('/signup?err=' + encodeURIComponent('Passwords must match and be 12+ characters'));
      if (!f.get('terms')) return go('/signup?err=' + encodeURIComponent('Please agree to the terms'));
      const code = String(crypto.randomInt(100000, 999999)), token = crypto.randomBytes(12).toString('hex');
      users.set(email, { name: f.get('name'), password: pw, verified: false, code, token, country: f.get('country') });
      onEmail({ to: email, from: 'LocalTest AI <no-reply@127.0.0.1>', subject: 'Your LocalTest AI verification code', text: `Hi ${f.get('name')},\n\nYour verification code is ${code}.\n\nOr confirm your email here: http://${req.headers.host}/verify?token=${token}\n\nThanks, LocalTest AI` });
      return go('/verify', { 'Set-Cookie': 'lt_user=' + encodeURIComponent(email) + '; Path=/; Max-Age=86400' });
    }
    if (p === '/verify') {
      const email = cookieUser(req); const usr = users.get(email);
      const tok = u.searchParams.get('token');
      if (tok) { for (const [, x] of users) if (x.token === tok) { x.verified = true; return go('/dashboard'); } }
      if (req.method === 'POST') { if (usr && f.get('code') === usr.code) { usr.verified = true; return go('/dashboard'); } return html(page('Check your email', '<p style="color:red">Wrong code</p><form method="post"><label>Code <input name="code" inputmode="numeric"></label><button>Verify</button></form>'), 400); }
      return html(page('Check your email', `<h1>Check your email</h1><p>We sent a 6-digit code to ${email || 'your email'}.</p><form method="post"><label>Verification code <input name="code" inputmode="numeric"></label><button>Verify</button></form>`));
    }
    const me = users.get(cookieUser(req));
    if (p === '/dashboard') { if (!me || !me.verified) return go('/login'); return html(page('Dashboard', `<h1>Welcome, ${me.name}</h1><nav><a href="/keys">API keys</a> · <a href="/billing">Upgrade to Pro ($20/month)</a></nav>`)); }
    if (p === '/keys') {
      if (!me || !me.verified) return go('/login');
      if (req.method === 'POST') { const k = 'lt-' + crypto.randomBytes(24).toString('base64url'); keys.push({ email: cookieUser(req), key: k }); return html(page('API keys', `<h1>API keys</h1><p>Your new key (shown once):</p><p><code id="key">${k}</code></p><a href="/dashboard">Back</a>`)); }
      return html(page('API keys', `<h1>API keys</h1><p>No keys yet.</p><form method="post"><button>Create new key</button></form>`));
    }
    if (p === '/billing') return html(page('Upgrade to Pro', `<h1>Pro plan $20/month</h1><form method="post"><label>Card number <input name="cardnumber" autocomplete="cc-number"></label><label>Mobile phone <input name="phone" type="tel"></label><label>Name on card <input name="holder"></label><button>Pay</button></form>`));
    if (p === '/login') {
      if (req.method === 'POST') { const usr = users.get(f.get('email')); if (usr && usr.password === f.get('password')) return go('/dashboard', { 'Set-Cookie': 'lt_user=' + encodeURIComponent(f.get('email')) + '; Path=/; Max-Age=86400' }); return html(page('Log in', '<p style="color:red">Wrong email or password</p>'), 401); }
      return html(page('Log in', `<h1>Log in</h1><form method="post"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button>Log in</button></form>`));
    }
    if (p === '/robot') {
      if (req.method === 'POST') { state.robotPassed = true; return go('/robot?ok=1'); }
      return html(page(u.searchParams.get('ok') ? 'Thanks, human' : 'Just a moment...', u.searchParams.get('ok') ? '<h1>You passed</h1>' :
        `<h1>Verify you are human</h1><iframe title="recaptcha" src="about:blank#recaptcha" width="10" height="10"></iframe><form method="post"><button style="width:300px;height:80px;font-size:22px">I'm not a robot</button></form>`));
    }
    html(page('Not found', 'nope'), 404);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, url: 'http://127.0.0.1:' + srv.address().port, state, close: () => srv.close() })));
}
