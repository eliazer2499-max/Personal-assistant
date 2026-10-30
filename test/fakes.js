// Tiny fake Google + Telegram + SMS gateway + Graph servers for tests. Records every request.
import http from 'node:http';
export function fakeServer() {
  const calls = [];
  const state = { sent: [], tgSent: [], smsSent: [], waSent: [], inbox: [] };
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const u = new URL(req.url, 'http://x');
    calls.push({ method: req.method, path: u.pathname, body, headers: req.headers });
    const J = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const p = u.pathname;
    if (p === '/token') {
      const f = new URLSearchParams(body);
      if (f.get('refresh_token') === 'revoked') return J({ error: 'invalid_grant' }, 400);
      return J({ access_token: 'ya29.fakeAccess' + Date.now(), expires_in: 3600, refresh_token: f.get('grant_type') === 'authorization_code' ? '1//fakeRefresh' : undefined, scope: 'email' });
    }
    if (p === '/v1/userinfo') return J({ email: 'abish@example.com', name: 'Abish' });
    if (p === '/gmail/v1/users/me/messages/send') { state.sent.push(JSON.parse(body)); return J({ id: 'sent' + state.sent.length, threadId: 't1' }); }
    if (p === '/gmail/v1/users/me/messages') return J({ messages: state.inbox.map(m => ({ id: m.id, threadId: m.threadId })) });
    let m;
    if ((m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(p))) {
      const msg = state.inbox.find(x => x.id === m[1]) || { id: m[1], from: 'x@y.z', subject: 's', text: 't' };
      return J({ id: msg.id, threadId: msg.threadId || 't1', internalDate: String(Date.now()), labelIds: ['UNREAD'], snippet: msg.text.slice(0, 50), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: msg.from }, { name: 'Subject', value: msg.subject }, { name: 'Message-ID', value: '<' + msg.id + '@mail>' }], body: { data: Buffer.from(msg.text).toString('base64url') } } });
    }
    if (/\/modify$/.test(p)) return J({});
    if (/^\/bot[^/]+\/getMe$/.test(p)) return J({ ok: true, result: { username: 'abish_test_bot' } });
    if (/^\/bot[^/]+\/sendMessage$/.test(p)) { state.tgSent.push(JSON.parse(body)); return J({ ok: true, result: {} }); }
    if (/^\/bot[^/]+\//.test(p)) return J({ ok: true, result: true });
    if (p === '/sms/messages') { state.smsSent.push(JSON.parse(body)); return J({ id: 'sms1', state: 'Pending' }); }
    if (p === '/sms/webhooks') return J({ id: 'w' }, 201);
    if (/\/messages$/.test(p) && p.startsWith('/v23.0/')) { state.waSent.push(JSON.parse(body)); return J({ messages: [{ id: 'wamid.1' }] }); }
    if (p.startsWith('/v23.0/')) return J({ display_phone_number: '+1 555', verified_name: 'Test', success: true });
    if (p === '/version.json') return J({ version: '2.9.0', notes: 'Test notes' });
    J({ error: { message: 'fake: no route ' + p } }, 404);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, url: 'http://127.0.0.1:' + srv.address().port, calls, state, close: () => srv.close() })));
}
