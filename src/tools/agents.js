// 2.1 tools: helper jobs (delegate / helpers_wait) and picture creation (image_generate).
import { cfg } from '../config.js';
import { all, get, setting, secret, redact, log, audit } from '../db.js';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const MAX_HELPERS = 4;
const FINAL = ['done', 'error', 'cancelled', 'interrupted'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function helperRows(parent) {
  return all('SELECT id,title,status,steps,result FROM jobs WHERE parent_job=? ORDER BY id', parent);
}

const delegate = {
  name: 'delegate',
  description: `Start a helper: a separate job that works on one part of a big task in parallel, with its own steps (up to ${MAX_HELPERS} helpers per job). Give it a complete, self-contained instruction (it does not see this chat). Then call helpers_wait to collect the answers.`,
  params: { task: S('Complete instruction for the helper, including everything it needs to know'), title: S('Short name for this part (optional)') },
  required: ['task'],
  run: async ({ task, title }, ctx = {}) => {
    if (!ctx.jobId) return { error: 'Helpers can only be started from a running job.' };
    if (ctx.isHelper) return { error: 'A helper cannot start more helpers. Do this part yourself.' };
    if (helperRows(ctx.jobId).length >= MAX_HELPERS) return { error: `This job already has ${MAX_HELPERS} helpers. Wait for them with helpers_wait.` };
    const { startJob } = await import('../brain.js');
    const id = startJob({ text: String(task).slice(0, 20000), channel: 'system', hidden: true, chatId: ctx.chatId, parentJob: ctx.jobId, title: 'Helper: ' + String(title || task).slice(0, 100) });
    return { started: true, helper_job: id, note: 'Running in the background. Call helpers_wait when you need its answer.' };
  },
};

const helpersWait = {
  name: 'helpers_wait',
  description: 'Wait for the helpers this job started and get their answers (returns when all are finished, or after max_minutes).',
  params: { max_minutes: { type: 'number', description: 'Longest wait in minutes (default 10)' } },
  run: async ({ max_minutes }, ctx = {}) => {
    if (!ctx.jobId || ctx.isHelper) return { error: 'Only a job that started helpers can wait for them.' };
    if (!helperRows(ctx.jobId).length) return { error: 'No helpers were started. Use delegate first.' };
    const { whileWaiting } = await import('../brain.js');
    const end = Math.min(Date.now() + Math.max(0.1, Math.min(60, Number(max_minutes) || 10)) * 60000, ctx.deadline || Infinity);
    await whileWaiting(async () => {
      while (Date.now() < end) {
        if (get('SELECT status FROM jobs WHERE id=?', ctx.jobId)?.status === 'cancelling') return;
        if (helperRows(ctx.jobId).every(r => FINAL.includes(r.status))) return;
        await sleep(cfg.testMode ? 100 : 1000);
      }
    });
    const rows = helperRows(ctx.jobId);
    return { all_done: rows.every(r => FINAL.includes(r.status)),
      helpers: rows.map(r => ({ helper_job: r.id, title: r.title, status: r.status, steps: r.steps, answer: r.result ? String(r.result).slice(0, 6000) : (FINAL.includes(r.status) ? '' : '(still working)') })) };
  },
};

// ---------- picture creation ----------
const gBase = () => cfg.geminiBase || 'https://generativelanguage.googleapis.com';
function friendly(status, msg) {
  const m = String(msg || '');
  if (status === 429 || /quota|exhausted|rate/i.test(m)) return `Picture creation isn't available on your free Gemini key right now (Google said: ${m.slice(0, 160) || 'quota'}). It may work later, or with a key that has billing turned on.`;
  if (status === 403 || /billing|permission|not available|free tier|location/i.test(m)) return `Picture creation isn't available on your free Gemini key (Google said: ${m.slice(0, 160) || 'not allowed'}).`;
  return `Picture creation failed (Google said ${status}: ${m.slice(0, 200)}).`;
}
async function imageModels(key) {
  try {
    const r = await fetch(gBase() + '/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    return (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, '')).filter(n => /image/.test(n) && !/imagen/.test(n));
  } catch { return []; }
}
const imageGenerate = {
  name: 'image_generate',
  description: 'Create a picture from a description (or change the last photo the owner sent in this chat, with use_last_image). The picture is shown to the owner in the chat right away and can be downloaded.',
  params: { prompt: S('What the picture should show, in detail (style, colours, text on it, …)'), use_last_image: { type: 'boolean', description: 'true = edit/transform the most recent image the owner sent in this chat' } },
  required: ['prompt'],
  run: async ({ prompt, use_last_image }, ctx = {}) => {
    const aikeys = await import('../aikeys.js');
    let keyList = aikeys.geminiKeys().filter(k => k.key);
    if (!keyList.length && secret('gemini_api_key')) keyList = [{ id: 0, name: 'Gemini', key: secret('gemini_api_key') }];
    const others = aikeys.otherPictureKeys();          // 2.3.10: other keys whose model can make pictures (ticked "Pictures")
    if (!keyList.length && !others.length) return { error: 'Picture creation needs a Gemini key, or another key whose model can make pictures with "Pictures" ticked (Settings → Brain → AI keys → tap Test on the key).' };
    const files = await import('../files.js');
    const { addMessage } = await import('../notify.js');
    let lastImg = null;
    if (use_last_image) {
      const f = get("SELECT f.* FROM files f JOIN messages m ON m.id=f.message_id WHERE f.kind='image' AND m.chat_id=? ORDER BY f.created DESC LIMIT 1", ctx.chatId || 0);
      if (!f) return { error: 'No photo from the owner in this chat to work from.' };
      const inp = files.modelInput([f]);
      lastImg = inp.media[0] ? { mime: inp.media[0].mime, data: inp.media[0].data } : null;
    }
    // The picture is shown in the chat, saved and logged the same way whichever key made it.
    const finish = (usedKey, model, mimeIn, buf, words, why) => {
      if (usedKey) audit('assistant', 'brain.route', `Pictures${ctx.jobId ? ' (job ' + ctx.jobId + ')' : ''}: '${usedKey.name}'${why || ''}`);
      const mime = mimeIn === 'image/jpeg' ? 'image/jpeg' : mimeIn === 'image/webp' ? 'image/webp' : 'image/png';
      const msgId = addMessage('assistant', 'web', '🎨 ' + String(prompt).slice(0, 300), { generated: 'image' }, ctx.jobId || null, ctx.chatId || null);
      const file = files.saveGenerated(buf, mime, 'picture-' + Date.now() + (mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg'), ctx.chatId, msgId);
      return { ok: true, shown_to_owner_in_chat: true, file_id: file.id, download: cfg.publicUrl + '/api/files/' + file.id + '?download=1', model, model_note: String(words || '').slice(0, 300) || undefined,
        note: 'The picture is already in the chat. Do not paste the link unless the owner asks; just say it is ready.' };
    };
    let geminiError = '';
    if (keyList.length) {
      const parts = [];
      if (lastImg) parts.push({ inlineData: { mimeType: lastImg.mime, data: lastImg.data } });
      parts.push({ text: String(prompt).slice(0, 4000) });
      const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } });
      let model = setting('image_model') || 'gemini-3.1-flash-image';
      let r, j, usedKey = null, netErr = '';
      for (let ki = 0; ki < keyList.length; ki++) {
        const key = keyList[ki].key; usedKey = keyList[ki];
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            r = await fetch(`${gBase()}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body, signal: AbortSignal.timeout(180000) });
          } catch (e) { netErr = 'Could not reach Google for the picture: ' + e.message; break; }
          j = await r.json().catch(() => ({}));
          if (r.status === 404 && attempt === 0) {
            const names = await imageModels(key);
            const pick = names.find(n => /flash-image/.test(n) && !/lite/.test(n)) || names.find(n => /flash.*image/.test(n)) || names[0];
            if (pick && pick !== model) { log('image model', model, 'not found; using', pick); model = pick; continue; }
          }
          if (r.status === 429 && attempt === 0 && !/limit: 0|quota/i.test(j.error?.message || '')) { await sleep(cfg.testMode ? 50 : 8000); continue; }
          break;
        }
        if (netErr) break;
        // 2.3: this key hit its limit or was refused → try the next Gemini key
        const keyProblem = r.status === 429 || r.status === 401 || r.status === 403 || /API_KEY_INVALID|API key not valid/i.test(JSON.stringify(j));
        // (a 429 here is the picture model's own limit, not the chat model's, so only a refused key is marked)
        if (keyProblem && r.status !== 429 && keyList[ki].id) aikeys.markFail(keyList[ki].id, aikeys.classify({ status: r.status, text: JSON.stringify(j), headers: r.headers, provider: 'gemini' }));
        if (keyProblem && ki < keyList.length - 1) { log('picture: key', keyList[ki].name, 'failed (' + r.status + '); trying', keyList[ki + 1].name); continue; }
        break;
      }
      if (netErr) geminiError = netErr;
      else if (!r.ok) geminiError = friendly(r.status, redact(j.error?.message || ''));
      else {
        const out = (j.candidates?.[0]?.content?.parts || []);
        const img = out.find(p => p.inlineData && /^image\//.test(p.inlineData.mimeType || ''));
        const words = out.filter(p => p.text && !p.thought).map(p => p.text).join(' ').trim();
        if (img) return finish(usedKey, model, img.inlineData.mimeType, Buffer.from(img.inlineData.data, 'base64'), words, usedKey.tagged === false ? ' — no key is set to "Pictures", so another Gemini key made it' : '');
        geminiError = 'The image model answered without a picture' + (words ? ': ' + words.slice(0, 300) : (j.promptFeedback?.blockReason ? ' (blocked: ' + j.promptFeedback.blockReason + ')' : '.'));
      }
      if (!others.length) return { error: geminiError };
      log('picture: Gemini did not make it; trying', others[0].name);
    }
    // 2.3.10: the other keys set to "Pictures", in his order
    const { generateOpenAI } = await import('../pictures.js');
    const errs = [];
    for (const k of others) {
      try {
        const g = await generateOpenAI(k, k.key, { prompt: String(prompt).slice(0, 4000), image: lastImg, timeoutMs: cfg.testMode ? 15000 : 180000 });
        return finish(k, k.model, g.mime, g.buf, g.words, geminiError ? ' (Gemini could not: ' + geminiError.slice(0, 120) + ')' : '');
      } catch (e) {
        const msg = redact(String(e.message || e)).split(k.key || '\u0000').join('[hidden]');
        errs.push(`"${k.name}" (${k.model}): ${msg}`);
        log('picture: key', k.name, 'failed:', msg.slice(0, 200));
        if (e.keyProblem && k.id) aikeys.markFail(k.id, aikeys.classify({ status: e.status, text: e.text || '', provider: 'openai' }));
      }
    }
    return { error: [geminiError, errs.length ? 'Picture creation failed with ' + errs.join('; ') : ''].filter(Boolean).join(' Then: ') };
  },
};

export default [delegate, helpersWait, imageGenerate];
