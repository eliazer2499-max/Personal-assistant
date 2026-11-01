// 2.3.10: pictures from any key whose model can make them (not only Gemini).
// Detection (during Test, never a paid picture call): the provider's model list says so (OpenRouter:
// data[].architecture.output_modalities includes "image"), or — when the list says nothing — the model's
// name looks like a picture model (dall-e, gpt-image, flux, sdxl, stable-diffusion, imagen, …-image):
// then it is "probably can — will try".
// Making a picture (OpenAI-compatible keys):
//   'chat'   = POST {base}/chat/completions with "modalities":["image","text"] (OpenRouter style);
//              the pictures come back in choices[0].message.images[].image_url.url (a data: URL)
//   'images' = POST {base}/images/generations {model, prompt, response_format:"b64_json"} (OpenAI style)
// The shape the model list pointed to is tried first; if the provider says that shape doesn't exist
// for this model (400/404/405), the other shape is tried once.
import { redact } from './db.js';

export const IMAGE_NAME = /(dall-?e|gpt-image|flux|sdxl|stable-diffusion|imagen|-image)/i;
export function looksLikeImageModel(id) { return IMAGE_NAME.test(String(id || '')); }

/** /models answer → { modelId: ['text','image',…] } for the models that say what they output. */
export function outputModalities(listJson) {
  const out = {};
  for (const m of (listJson?.data || listJson?.models || [])) {
    const id = m && (m.id || m.name); if (!id) continue;
    const mods = m.architecture?.output_modalities || m.output_modalities;
    if (Array.isArray(mods)) out[String(id)] = mods.map(x => String(x).toLowerCase());
  }
  return out;
}

/** What Test says about pictures for an OpenAI-compatible model. → { ok, why, via, guess } */
export function detectPictures(model, mods = {}) {
  const m = mods && mods[model];
  if (Array.isArray(m)) return m.includes('image') ? { ok: true, via: 'chat', guess: false } : { ok: false, why: 'This model can\'t make pictures' };
  if (looksLikeImageModel(model)) return { ok: true, via: 'images', guess: true, why: 'Probably can — will try' };
  return { ok: false, why: 'This model can\'t make pictures' };
}

const MIMES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
function sniff(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}
const MAX = 20 * 1024 * 1024;
/** data: URL or https URL → { buf, mime } */
async function imageFrom(url, timeoutMs) {
  const s = String(url || '');
  const d = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(s);
  let buf, mime = '';
  if (d) { buf = Buffer.from(d[3], d[2] ? 'base64' : 'utf8'); mime = (d[1] || '').toLowerCase(); }
  else if (/^https?:\/\//i.test(s)) {
    const r = await fetch(s, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error('could not download the picture (' + r.status + ')');
    buf = Buffer.from(await r.arrayBuffer()); mime = (r.headers.get('content-type') || '').split(';')[0].toLowerCase();
  } else throw new Error('the answer had no picture');
  if (!buf.length) throw new Error('the picture was empty');
  if (buf.length > MAX) throw new Error('the picture was too big');
  const real = sniff(buf) || (MIMES[mime] ? mime : '');
  if (!real) throw new Error('the answer was not a PNG, JPEG or WebP picture');
  return { buf, mime: real };
}
export const extFor = (mime) => MIMES[mime] || '.png';

/** The provider's own words, without the key. */
function providerWords(text, key) {
  let msg = '';
  try { const j = JSON.parse(text); msg = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : '') || ''; } catch { msg = String(text || '').replace(/<[^>]+>/g, ' '); }
  msg = String(msg).replace(/\s+/g, ' ').trim();
  if (key && key.length >= 4) msg = msg.split(key).join('[hidden]');
  return redact(msg).slice(0, 220);
}
export class PictureError extends Error {
  constructor(message, { status = 0, shapeMissing = false, keyProblem = false, text = '' } = {}) { super(message); this.status = status; this.shapeMissing = shapeMissing; this.keyProblem = keyProblem; this.text = text; }
}

async function post(url, key, body, timeoutMs) {
  let r;
  try { r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new PictureError('could not reach the provider (' + (e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.message) + ')'); }
  const text = await r.text().catch(() => '');
  if (!r.ok) {
    const words = providerWords(text, key);
    throw new PictureError(`the provider said ${r.status}${words ? ': ' + words : ''}`, { status: r.status, text: redact(text).slice(0, 2000),
      keyProblem: r.status === 401 || r.status === 403,
      shapeMissing: [400, 404, 405].includes(r.status) && !/content|safety|policy|moderation|prompt/i.test(words) });
  }
  try { return JSON.parse(text); } catch { throw new PictureError('the provider answered something that is not JSON'); }
}

async function viaChat({ base, key, model, prompt, image, timeoutMs }) {
  const content = image ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data}` } }] : prompt;
  const j = await post(base + '/chat/completions', key, { model, messages: [{ role: 'user', content }], modalities: ['image', 'text'] }, timeoutMs);
  const msg = j?.choices?.[0]?.message || {};
  const words = typeof msg.content === 'string' ? msg.content.trim() : Array.isArray(msg.content) ? msg.content.filter(p => p?.type === 'text').map(p => p.text).join(' ').trim() : '';
  const url = (msg.images || []).map(x => x?.image_url?.url || x?.url).find(Boolean);
  if (!url) throw new PictureError('the model answered without a picture' + (words ? ': ' + words.slice(0, 200) : ''));
  return { ...(await imageFrom(url, timeoutMs)), words };
}
async function viaImages({ base, key, model, prompt, image, timeoutMs }) {
  if (image) throw new PictureError('this model can only make new pictures, not change a photo', { shapeMissing: true });
  const j = await post(base + '/images/generations', key, { model, prompt, n: 1, response_format: 'b64_json' }, timeoutMs);
  const d = j?.data?.[0] || {};
  if (d.b64_json) return { ...(await imageFrom('data:image/png;base64,' + d.b64_json, timeoutMs)), words: String(d.revised_prompt || '') };
  if (d.url) return { ...(await imageFrom(d.url, timeoutMs)), words: String(d.revised_prompt || '') };
  throw new PictureError('the model answered without a picture');
}

/**
 * Make one picture with an OpenAI-compatible key. k = { base_url, model, pictures_via }. key is only sent in the
 * Authorization header. → { buf, mime, words, shape } or throws PictureError (message never holds the key).
 */
export async function generateOpenAI(k, key, { prompt, image = null, timeoutMs = 180000 } = {}) {
  const base = String(k.base_url || '').replace(/\/+$/, '');
  const order = k.pictures_via === 'chat' ? ['chat', 'images'] : ['images', 'chat'];
  let first = null;
  for (const shape of order) {
    try { return { ...(await (shape === 'chat' ? viaChat : viaImages)({ base, key, model: k.model, prompt, image, timeoutMs })), shape }; }
    catch (e) {
      if (!(e instanceof PictureError)) throw e;
      if (!first) first = e;
      if (!e.shapeMissing) throw (first === e ? e : first.shapeMissing ? e : first);
    }
  }
  throw first;
}
