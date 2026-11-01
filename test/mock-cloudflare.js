// 2.3.11: a fake Cloudflare API (Workers AI + token verify) on 127.0.0.1 for the tests and the local real check.
// Shapes follow Cloudflare's docs (Nov 2026): every JSON answer is {success, errors:[{code,message}], messages, result}.
import http from 'node:http';
import zlib from 'node:zlib';

export const ACCT = '0123456789abcdef0123456789abcdef';
export const OTHER_ACCT = 'fedcba9876543210fedcba9876543210';
// Tokens that match none of the app's redaction patterns, so only the app's own wiping hides them.
export const TOK = {
  good: 'cfGood' + 'g'.repeat(34),        // Workers AI Read+Edit on ACCT
  noperm: 'cfNoPerm' + 'n'.repeat(32),    // valid, ACCT listed, but no Workers AI permission
  other: 'cfOther' + 'o'.repeat(33),      // valid, but for OTHER_ACCT
  bad: 'cfBad' + 'b'.repeat(35),          // not a token Cloudflare knows
  acct: 'cfAcctOwned' + 'a'.repeat(29),   // account-owned token: only the account verify address knows it
  quota: 'cfQuota' + 'q'.repeat(33),      // works, but today's free Neurons are used up
  echo: 'cfEcho' + 'e'.repeat(34),        // refused, and the error repeats the token
};

/** A real, valid PNG of w×h in one colour (so the saved file can be opened and checked). */
export function png(w = 8, h = 8, rgb = [200, 60, 40]) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

export const MODELS = ['@cf/black-forest-labs/flux-1-schnell', '@cf/bytedance/stable-diffusion-xl-lightning', '@cf/black-forest-labs/flux-2-klein-4b', '@cf/leonardo/phoenix-1.0'];

// 2.3.12: opts.models = the account's picture models (default MODELS); FAIL[model] = how that model fails right now:
// 'down' (500), 'bad' (400 bad input), 'gone' (5007 no such model), 'busy' (3040 capacity), 'quota' (3036 for the whole key)
// 2.3.13: chat models (Text Generation) and the OpenAI-compatible chat address /accounts/{id}/ai/v1/chat/completions.
// Answers follow OpenAI's shape (choices[0].message, usage). CHAT.fail = 'quota' (3036) | 'busy' (3040) | 'down' (500);
// CHAT.calls = every chat request (model, token, body). A message asking to "calculate" gets a calculator tool call first.
export const TEXT_MODELS = [
  { name: '@cf/openai/gpt-oss-120b', tools: true },
  { name: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', tools: true },
  { name: '@cf/meta/llama-3.1-8b-instruct', tools: false },
];
export async function startMockCloudflare(opts = {}) {
  const CHAT = { calls: [], fail: null };
  const LIST = opts.models || MODELS;
  const FAIL = {};
  const SEEN = [];      // { path, token, body }
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('latin1');
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const u = new URL(req.url, 'http://x'); const p = u.pathname.replace(/^\/client\/v4/, '');
    SEEN.push({ path: p, query: u.search, token, method: req.method, ctype: String(req.headers['content-type'] || ''), body: body.slice(0, 400) });
    const J = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: s < 400, errors: [], messages: [], result: null, ...o })); };
    const authErr = () => J({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, 403);
    const invalid = () => J({ success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] }, 401);
    const known = Object.values(TOK).includes(token) && token !== TOK.bad;
    if (token === TOK.echo) return J({ success: false, errors: [{ code: 1000, message: 'Invalid API Token ' + TOK.echo }] }, 401);
    if (p === '/user/tokens/verify') {
      if (!known || token === TOK.acct) return invalid();
      return J({ result: { id: 'tok1', status: 'active' }, messages: [{ code: 10000, message: 'This API Token is valid and active', type: null }] });
    }
    let m = /^\/accounts\/([^/]+)\/tokens\/verify$/.exec(p);
    if (m) { if (token === TOK.acct && m[1] === ACCT) return J({ result: { id: 'tok2', status: 'active' } }); return invalid(); }
    if (p === '/accounts') {
      if (!known) return invalid();
      const acc = token === TOK.other ? [{ id: OTHER_ACCT, name: 'Someone else\'s account' }] : [{ id: ACCT, name: "Abish's account" }];
      return J({ result: acc });
    }
    m = /^\/accounts\/([^/]+)\/(.*)$/.exec(p);
    if (!m) return J({ success: false, errors: [{ code: 7000, message: 'No route for that URI' }] }, 400);
    const [, acct, rest] = m;
    if (!/^[0-9a-f]{32}$/.test(acct)) return J({ success: false, errors: [{ code: 7003, message: 'Could not route to /accounts/' + acct + ', perhaps your object identifier is invalid?' }] }, 400);
    if (!known) return invalid();
    const okAcct = token === TOK.other ? acct === OTHER_ACCT : acct === ACCT;
    if (!okAcct || token === TOK.noperm) return authErr();
    if (rest === 'ai/models/search') {
      const task = u.searchParams.get('task');
      const all = [...LIST.map(n => ({ name: n, task: { name: 'Text-to-Image' } })),
        ...TEXT_MODELS.map(x => ({ name: x.name, task: { name: 'Text Generation' }, properties: x.tools ? [{ property_id: 'function_calling', value: 'true' }] : [] }))];
      return J({ result: all.filter(x => !task || x.task.name === task) });
    }
    if (rest === 'ai/v1/chat/completions' && req.method === 'POST') {      // 2.3.13
      let j = {}; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      CHAT.calls.push({ model: j.model, token, body: j });
      const raw = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (token === TOK.quota || CHAT.fail === 'quota') return J({ success: false, errors: [{ code: 3036, message: 'AiError: You have used up your daily free allocation of 10,000 neurons.' }] }, 429);
      if (CHAT.fail === 'busy') return J({ success: false, errors: [{ code: 3040, message: 'Capacity temporarily exceeded, please try again.' }] }, 429);
      if (CHAT.fail === 'down') return J({ success: false, errors: [{ code: 3043, message: 'AiError: Internal server error' }] }, 500);
      if (!TEXT_MODELS.some(x => x.name === j.model)) return J({ success: false, errors: [{ code: 5007, message: 'No such model ' + j.model + ' or task' }] }, 400);
      if (!Array.isArray(j.messages) || !j.messages.length) return J({ success: false, errors: [{ code: 5006, message: 'AiError: Bad input: must have required property messages' }] }, 400);
      const msgs = j.messages, last = msgs[msgs.length - 1];
      const text = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x.text || '').join(' ') : '';
      const lastUser = [...msgs].reverse().find(x => x.role === 'user');
      const usage = { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 };
      const answer = (message) => raw({ id: 'chatcmpl-cf', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: j.model, choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage });
      if (last.role === 'tool') return answer({ role: 'assistant', content: 'Cloudflare chat here: the calculator says ' + text(last.content) });
      if (Array.isArray(j.tools) && j.tools.length && /calculate/i.test(text(lastUser?.content)))
        return answer({ role: 'assistant', content: null, tool_calls: [{ id: 'call_cf1', type: 'function', function: { name: 'calculator', arguments: JSON.stringify({ expression: '6*7' }) } }] });
      if (j.max_tokens === 5) return answer({ role: 'assistant', content: 'Hi!' });
      return answer({ role: 'assistant', content: 'Hello from Cloudflare chat (' + j.model + ').' });
    }
    const run = /^ai\/run\/(.+)$/.exec(rest);
    if (run && req.method === 'POST') {
      const model = run[1];
      if (token === TOK.quota) return J({ success: false, errors: [{ code: 3036, message: "AiError: You have used up your daily free allocation of 10,000 neurons. Please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage." }] }, 429);
      const f = FAIL[model];
      if (f === 'down') return J({ success: false, errors: [{ code: 3043, message: 'AiError: Internal server error' }] }, 500);
      if (f === 'bad') return J({ success: false, errors: [{ code: 5006, message: 'AiError: Bad input: prompt too long for this model' }] }, 400);
      if (f === 'gone') return J({ success: false, errors: [{ code: 5007, message: 'No such model ' + model + ' or task' }] }, 400);
      if (f === 'busy') return J({ success: false, errors: [{ code: 3040, message: 'Capacity temporarily exceeded, please try again.' }] }, 429);
      if (f === 'quota') return J({ success: false, errors: [{ code: 3036, message: 'AiError: You have used up your daily free allocation of 10,000 neurons.' }] }, 429);
      if (!LIST.includes(model)) return J({ success: false, errors: [{ code: 5007, message: 'No such model ' + model + ' or task' }] }, 400);
      const multipart = String(req.headers['content-type'] || '').startsWith('multipart/form-data');
      if (model.includes('/flux-2-')) {
        if (!multipart) return J({ success: false, errors: [{ code: 5006, message: 'AiError: Bad input: request must be multipart/form-data' }] }, 400);
        if (!/name="prompt"/.test(body)) return J({ success: false, errors: [{ code: 5006, message: 'prompt is required' }] }, 400);
        return J({ result: { image: png(16, 16, [40, 160, 60]).toString('base64') } });
      }
      let j = {}; try { j = JSON.parse(body); } catch {}
      if (!j.prompt) return J({ success: false, errors: [{ code: 5006, message: 'AiError: Bad input: must have required property prompt' }] }, 400);
      if (model.includes('flux-1-schnell') || model.includes('lucid-origin')) return J({ result: { image: png(16, 16, [200, 60, 40]).toString('base64') } });
      // stable-diffusion / phoenix: raw bytes
      res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png(16, 16, [40, 60, 200]));
    }
    J({ success: false, errors: [{ code: 7000, message: 'No route for that URI' }] }, 404);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/client/v4';
  return { url, SEEN, FAIL, CHAT, close: () => new Promise(r => srv.close(r)) };
}
