// 2.3.13: chat through the owner's own Cloudflare key (Workers AI), as an extra backup brain when Gemini runs out.
// Docs checked Nov 1 2026:
//  - OpenAI-compatible Chat Completions: POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions
//    with "Authorization: Bearer {api_token}", body {model, messages, tools?, max_tokens?}; the answer is OpenAI's shape
//    (choices[0].message.content / .tool_calls, usage). developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
//  - Function calling: each model page says "Function calling: Yes/No". developers.cloudflare.com/workers-ai/features/function-calling/
//  - Free allowance: 10,000 Neurons a day for everything on the account (pictures and chat), reset 00:00 UTC; error 3036 when used up.
//    Neurons per million tokens per model: developers.cloudflare.com/workers-ai/platform/pricing/
// Default chat model: @cf/openai/gpt-oss-120b — function calling Yes, 128,000-token context, not on the "needs a paid plan" list.
// (@cf/meta/llama-3.3-70b-instruct-fp8-fast also calls tools but holds only 24,000 tokens; the assistant's own tool list is ~11,000.)
import { cfBase, cleanAccountId, cfErrors, isCfLimit, cfResetText } from './cloudflare.js';
import { rememberSecret } from './db.js';

export const CF_CHAT_DEFAULT = '@cf/openai/gpt-oss-120b';
export const CF_CHAT_HELP = 'Chat uses the same free daily amount as pictures. Weaker than Gemini; good as a backup.';
export const CF_CHAT_USES = ['chat', 'background'];
export const CF_CHAT_MAX_TOKENS = 4096;                    // Cloudflare's own default is 256 (model pages), too short for tool calls          // what a Cloudflare key can do besides pictures (he ticks them)
export const cfChatBase = (accountId) => `${cfBase()}/accounts/${cleanAccountId(accountId)}/ai/v1`;

/** Workers AI text model names look like @cf/openai/gpt-oss-120b. '' when it can't be one. */
export function cleanCfChatModel(v) {
  const s = String(v ?? '').trim() || CF_CHAT_DEFAULT;
  if (!/^@[a-z0-9-]+\/[A-Za-z0-9._\-]+(\/[A-Za-z0-9._\-]+)*$/.test(s) || s.length > 200) return '';
  return s;
}

// Neurons per million tokens [input, output], from Cloudflare's pricing page (Nov 2026). Unknown models: a careful high guess.
const RATES = {
  '@cf/openai/gpt-oss-120b': [31818, 68182],
  '@cf/openai/gpt-oss-20b': [18182, 27273],
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': [26668, 204805],
  '@cf/meta/llama-4-scout-17b-16e-instruct': [24545, 77273],
  '@cf/mistralai/mistral-small-3.1-24b-instruct': [31876, 50488],
  '@cf/qwen/qwen3-30b-a3b-fp8': [4625, 30475],
};
const UNKNOWN = [45000, 210000];
/** Estimated Neurons for one chat answer, from the token counts Cloudflare sends back (usage). */
export function chatNeurons(model, usage) {
  const [i, o] = RATES[model] || UNKNOWN;
  const pin = Math.max(0, Number(usage?.prompt_tokens) || 0), pout = Math.max(0, Number(usage?.completion_tokens) || 0);
  return Math.ceil((pin * i + pout * o) / 1e6);
}

const nextUtcMidnight = (t = Date.now()) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };
/**
 * A failed Cloudflare chat answer → the brain's key decision { kind, reason, until, problem }.
 * Out of today's free amount (429 / 3036) rests the key until 00:00 UTC (pictures share the same amount).
 * The reason holds Cloudflare's words, never the token.
 */
export function cfChatFail(status, text, token = '', t = Date.now()) {
  const e = cfErrors(text, token);
  if (isCfLimit(status, e.codes, e.msg)) {
    if (e.codes.includes(3036) || /daily free allocation|neurons/i.test(e.msg)) {
      const until = nextUtcMidnight(t);
      return { kind: 'quota', perDay: true, until, reason: `Cloudflare free daily amount used up (${status || 429}) — back at ${cfResetText(t)}` };
    }
    return { kind: 'quota', until: t + 60000, reason: `Cloudflare busy right now (${status || 429})${e.msg ? ': ' + e.msg.slice(0, 90) : ''}` };
  }
  if (status === 401 || status === 403 || e.codes.includes(10000) || e.codes.includes(1000))
    return { kind: 'bad_key', until: t + 30 * 60000, problem: 'key not allowed', reason: `Cloudflare refused this key (${status})${e.msg ? ': ' + e.msg.slice(0, 90) : ''} — tap Test` };
  if (status === 404 || e.codes.includes(5007) || /no such model|model not found/i.test(e.msg))
    return { kind: 'model', until: t + 10 * 60000, reason: 'Cloudflare chat model not found — tap Test and pick one from the list' };
  if (status >= 500) return { kind: 'server', until: t + 60000, reason: `Cloudflare is having trouble (${status})` };
  if (status === 408) return { kind: 'server', until: t + 60000, reason: 'Cloudflare timed out (408)' };
  return { kind: 'other', until: 0, reason: `Cloudflare chat error ${status}${e.msg ? ': ' + e.msg.slice(0, 120) : ''}` };
}

/** Text Generation models from a models/search answer; ones that can call tools first (when the list says so). */
export function chatModelsFrom(rows) {
  const tools = (x) => (Array.isArray(x?.properties) ? x.properties : []).some(p => /function_calling/i.test(String(p?.property_id || '')) && String(p?.value) === 'true');
  const list = (Array.isArray(rows) ? rows : []).filter(x => !x?.task || /text generation/i.test(String(x.task?.name || x.task)))
    .map(x => ({ name: String(x?.name || ''), tools: tools(x) })).filter(x => x.name.startsWith('@'));
  const names = [...new Set(list.map(x => x.name))];
  const withTools = new Set(list.filter(x => x.tools).map(x => x.name));
  return { models: [...names.filter(n => withTools.has(n)).sort(), ...names.filter(n => !withTools.has(n)).sort()], withTools: [...withTools] };
}

async function cfFetch(url, init, token, ms) {
  try { return await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(ms) }); }
  catch (e) { const err = new Error('Could not reach Cloudflare (' + (e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || 'no answer') + ')'); err.network = true; throw err; }
}
/**
 * The chat part of Test (only after the token and Account ID already worked): the account's Text Generation models
 * (chips) and ONE tiny chat call ("hi", max_tokens 5: a few Neurons). → { chat: { ok, why, limit }, chat_models,
 * chat_model, chat_listed, chat_tools, chat_message, neurons }
 */
export async function cfChatTest({ accountId, token, chatModel, testMode = false }) {
  token = String(token || '').trim(); rememberSecret(token);
  const acct = cleanAccountId(accountId), m = cleanCfChatModel(chatModel), ms = testMode ? 8000 : 30000;
  const out = { chat_model: m || String(chatModel || ''), chat_models: [], chat_tools: null, neurons: 0 };
  try {
    const s = await cfFetch(`${cfBase()}/accounts/${acct}/ai/models/search?task=${encodeURIComponent('Text Generation')}&per_page=100`, { method: 'GET' }, token, ms);
    const st = await s.text().catch(() => ''); let sj = {}; try { sj = JSON.parse(st); } catch {}
    if (s.ok && sj.success !== false) { const c = chatModelsFrom(sj.result); out.chat_models = c.models; if (m && c.models.includes(m)) out.chat_tools = c.withTools.includes(m) || null; }
    out.chat_listed = out.chat_models.length && m ? out.chat_models.includes(m) : undefined;
    if (!m) return { ...out, chat: { ok: false, why: 'Chat model names look like ' + CF_CHAT_DEFAULT }, chat_message: '✗ Chat: model names look like ' + CF_CHAT_DEFAULT + '. Tap one below.' };
    const r = await cfFetch(cfChatBase(acct) + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }) }, token, ms);
    const text = await r.text().catch(() => '');
    let j = {}; try { j = JSON.parse(text); } catch {}
    if (r.ok && Array.isArray(j.choices)) {
      out.neurons = chatNeurons(m, j.usage || { prompt_tokens: 10, completion_tokens: 5 });
      return { ...out, chat: { ok: true }, chat_message: `✓ Chat works (${m}).` };
    }
    const f = cfChatFail(r.ok ? 502 : r.status, r.ok ? '' : text, token);
    if (f.kind === 'quota') return { ...out, chat: { ok: null, why: 'limit', limit: true }, chat_message: '… Chat: ' + f.reason + '. Tap Test again later.' };
    if (f.kind === 'server') return { ...out, chat: { ok: null, why: f.reason }, chat_message: '… Chat: ' + f.reason + '. Tap Test again in a minute.' };
    if (f.kind === 'model') return { ...out, chat_listed: false, chat: { ok: false, why: 'chat model not found' }, chat_message: `✗ Chat: "${m}" is not one of Cloudflare's chat models. Tap one below.` };
    return { ...out, chat: { ok: false, why: f.reason }, chat_message: '✗ Chat: ' + f.reason };
  } catch (e) {
    if (e.network) return { ...out, chat: { ok: null, why: e.message }, chat_message: '… Chat: ' + e.message + '.' };
    throw e;
  }
}
