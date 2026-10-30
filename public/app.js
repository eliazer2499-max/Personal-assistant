// My Assistant v2 web app (vanilla JS, no build step).
const $root = document.getElementById('root');
let CSRF = '', ME = null, pollTimer = null, lastMsgId = 0, PENDING = 0;

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
async function api(path, body, method) {
  const opts = { method: method || (body ? 'POST' : 'GET'), headers: {}, credentials: 'same-origin' };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.headers['X-CSRF'] = CSRF; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  let j = {}; try { j = await r.json(); } catch {}
  if (r.status === 401 && !path.startsWith('/api/login')) { ME = null; route(); throw new Error('Please log in'); }
  if (!r.ok) throw new Error(j.error || ('Error ' + r.status));
  return j;
}
const msgEl = () => h('p', { class: 'msg' });
function say(el, text, ok) { el.textContent = text || ''; el.className = 'msg ' + (ok ? 'ok' : 'err'); }
async function act(btn, out, fn, okText) {
  btn.disabled = true; if (out) say(out, 'Working…', true);
  try { const r = await fn(); if (out) say(out, typeof okText === 'function' ? okText(r) : (okText || 'Saved.'), true); return r; }
  catch (e) { if (out) say(out, e.message, false); }
  finally { btn.disabled = false; }
}
function copyBox(value, label) {
  const inp = h('input', { value, readonly: true, 'aria-label': label || 'Copy' });
  const b = h('button', { class: 'small', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(value); b.textContent = 'Copied'; } catch { inp.select(); document.execCommand('copy'); b.textContent = 'Copied'; } setTimeout(() => b.textContent = 'Copy', 1500); } }, 'Copy');
  return h('div', { class: 'copy' }, inp, b);
}
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(t).toLocaleDateString(); };
const fmt = (t) => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

// ---------------- auth screens ----------------
function setupView() {
  const out = msgEl();
  const code = h('input', { id: 'code', autocomplete: 'off', autocapitalize: 'characters', placeholder: 'From the install screen' });
  const pw = h('input', { id: 'pw', type: 'password', autocomplete: 'new-password', placeholder: 'At least 10 characters' });
  const pw2 = h('input', { id: 'pw2', type: 'password', autocomplete: 'new-password' });
  const step1 = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    if (pw.value !== pw2.value) return say(out, 'The two passwords differ.');
    const b = e.submitter || step1.querySelector('button');
    const r = await act(b, out, () => api('/api/setup/start', { code: code.value, password: pw.value }), 'Now set up 2-step sign-in.');
    if (r) showTotp(r);
  } },
    h('label', { for: 'code' }, 'Setup code'), code,
    h('label', { for: 'pw' }, 'Choose your password'), pw,
    h('label', { for: 'pw2' }, 'Same password again'), pw2,
    h('div', { style: 'margin-top:16px' }, h('button', { class: 'primary', type: 'submit', style: 'width:100%' }, 'Continue')), out);
  const wrap = h('div', { class: 'auth' }, h('div', { class: 'logo big' }), h('h1', {}, 'Welcome'), h('p', { class: 'sub' }, 'Make this assistant yours. Only you will be able to open it.'), step1);
  function showTotp(r) {
    const out2 = msgEl();
    const totp = h('input', { id: 'totp', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '6-digit code', maxlength: 6 });
    wrap.replaceChildren(h('div', { class: 'logo big' }), h('h1', {}, '2-step sign-in'),
      h('p', { class: 'sub' }, 'Use an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, or iPhone Passwords).'),
      h('ol', { class: 'steps' },
        h('li', {}, 'On this phone: ', h('a', { href: r.otpauth }, 'tap here to add it to your authenticator app'), '. On a computer: scan the code below.'),
        h('li', {}, 'Or type this key in the app by hand:', copyBox(r.secret.replace(/ /g, ''), 'Key'))),
      r.qr_svg ? h('div', { class: 'qr', html: r.qr_svg }) : null,
      h('form', { onsubmit: async (e) => {
        e.preventDefault();
        const f = await act(e.submitter || e.target.querySelector('button'), out2, () => api('/api/setup/finish', { setup_token: r.setup_token, code: totp.value }), 'Done!');
        if (f) { CSRF = f.csrf; showRecovery(f.recovery); }
      } }, h('label', { for: 'totp' }, 'Enter the 6-digit code the app shows'), totp, h('div', { style: 'margin-top:16px' }, h('button', { class: 'primary', type: 'submit', style: 'width:100%' }, 'Turn on 2-step sign-in')), out2));
  }
  function showRecovery(codes) {
    wrap.replaceChildren(h('div', { class: 'logo big' }), h('h1', {}, 'Save these'), h('p', { class: 'sub' }, 'Backup codes, each works once if you lose your phone. Screenshot them or write them down. They will not be shown again.'),
      h('div', { class: 'codes' }, codes.map(c => h('code', {}, c))),
      h('button', { class: 'primary', style: 'width:100%;margin-top:10px', onclick: async () => { await loadMe(); location.hash = '#/settings/brain'; route(); } }, 'I saved them — continue'));
  }
  return wrap;
}
function loginView() {
  const out = msgEl();
  const pw = h('input', { id: 'lpw', type: 'password', autocomplete: 'current-password' });
  const code = h('input', { id: 'lcode', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '6-digit code (or a backup code)' });
  return h('div', { class: 'auth' }, h('div', { class: 'logo big' }), h('h1', {}, 'My Assistant'), h('p', { class: 'sub' }, 'Private. Only the owner can sign in.'),
    h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const r = await act(e.submitter || e.target.querySelector('button'), out, () => api('/api/login', { password: pw.value, code: code.value }), 'Welcome back.');
      if (r) { CSRF = r.csrf; await loadMe(); route(); }
    } }, h('label', { for: 'lpw' }, 'Password'), pw, h('label', { for: 'lcode' }, 'Authenticator code'), code,
      h('div', { style: 'margin-top:16px' }, h('button', { class: 'primary', type: 'submit', style: 'width:100%' }, 'Sign in')), out),
    h('p', { class: 'fine', style: 'text-align:center;margin-top:20px' }, 'Locked out? On the server run: sudo myassistant reset-login'));
}

// ---------------- shell ----------------
const TABS = [['chat', '💬', 'Chat'], ['approvals', '✅', 'Approvals'], ['servers', '🖥️', 'Servers'], ['settings', '⚙️', 'Settings'], ['more', '☰', 'More']];
function shell(tab, title, sub, body, opts = {}) {
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Main' }, TABS.map(([id, ic, label]) => h('a', { href: '#/' + id, class: tab === id ? 'on' : '' }, h('span', { class: 'ic', 'aria-hidden': 'true' }, ic), label, id === 'approvals' && PENDING ? h('span', { class: 'badge' }, PENDING) : null)));
  const bar = h('header', { class: 'bar' }, h('div', { class: 'title' }, opts.back ? h('a', { class: 'back', href: opts.back }, '‹ Back') : h('div', { class: 'logo', 'aria-hidden': 'true' }), h('div', {}, h('span', {}, title), sub ? h('small', {}, sub) : null)), opts.right || null);
  const main = h('main', { class: 'main', id: 'main' }, body);
  return h('div', { id: 'app' }, bar, main, opts.footer || null, tabs);
}

// ---------------- chat ----------------
const JOBS = new Map();
let CHAT_ID = parseInt(localStorage.getItem('ma_chat') || '0', 10) || 0;
let PENDING_FILES = [];   // uploaded (or uploading) but not sent yet
let REC = null;           // voice recording in progress
const MAX_UPLOAD = 20 * 1024 * 1024;
const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const fileUrl = (f, dl) => '/api/files/' + f.id + (dl ? '?download=1' : '');
function chatNotice(text) { addBubble({ role: 'notice', text }); const m = document.getElementById('main'); if (m) m.scrollTop = m.scrollHeight; }

function chatView(id) {
  if (id && id !== CHAT_ID) { CHAT_ID = id; localStorage.setItem('ma_chat', String(id)); }
  PENDING_FILES = []; if (VPREV) VPREV.close();
  const log = h('div', { class: 'log', id: 'log', 'aria-live': 'polite' });
  const input = h('textarea', { id: 'input', rows: 1, placeholder: 'Ask or give me a job…', 'aria-label': 'Message' });
  const tray = h('div', { class: 'tray', id: 'tray' });
  const fileInput = h('input', { type: 'file', multiple: true, accept: 'image/*,audio/*,application/pdf,.pdf,.txt,.md,.csv,.tsv,.json,.docx,.xlsx,.pptx,.zip,.js,.ts,.jsx,.tsx,.py,.html,.css,.xml,.yml,.yaml,.sql,.sh,.log,.java,.kt,.php,.go,.rs,.c,.cpp', style: 'display:none', 'aria-hidden': 'true',
    onchange: () => { const fl = [...fileInput.files]; fileInput.value = ''; fl.forEach(f => addFile(f, refresh)); } });
  const clip = h('button', { class: 'icon', type: 'button', 'aria-label': 'Attach a photo or file', title: 'Photo or file', onclick: () => fileInput.click() }, '📎');
  const send = h('button', { class: 'send', type: 'submit', 'aria-label': 'Send' }, '➤');
  const mic = h('button', { class: 'send mic', type: 'button', 'aria-label': 'Record a voice note', title: 'Voice note: tap to start, tap ■ to stop (or hold and let go)' }, '🎤');
  const row = h('div', { class: 'composer' }, clip, input, mic, send);
  function refresh() {
    const has = input.value.trim() || PENDING_FILES.length;
    send.style.display = has ? '' : 'none'; mic.style.display = has ? 'none' : '';
    tray.replaceChildren(...PENDING_FILES.map(p => h('div', { class: 'chipfile' + (p.state === 'up' ? ' busy' : '') },
      p.kind === 'image' && p.preview ? h('img', { src: p.preview, alt: '' }) : h('span', { class: 'fi' }, p.kind === 'audio' ? '🎤' : p.kind === 'pdf' ? '📄' : '📎'),
      h('span', { class: 'fn' }, p.state === 'up' ? 'Uploading…' : p.name),
      h('button', { type: 'button', class: 'x', 'aria-label': 'Remove ' + p.name, onclick: () => { PENDING_FILES = PENDING_FILES.filter(x => x !== p); if (p.preview) URL.revokeObjectURL(p.preview); refresh(); } }, '✕'))));
  }
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; refresh(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width:700px)').matches) { e.preventDefault(); form.requestSubmit(); } });
  const form = h('form', { class: 'composerform', onsubmit: async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (PENDING_FILES.some(p => p.state === 'up')) return chatNotice('Still uploading — one moment, then send again.');
    const ids = PENDING_FILES.filter(p => p.id).map(p => p.id);
    if (!text && !ids.length) return;
    input.value = ''; input.style.height = 'auto';
    const sent = PENDING_FILES; PENDING_FILES = []; refresh();
    try { await api('/api/chat', { text, chat_id: CHAT_ID || undefined, files: ids }); sent.forEach(p => p.preview && URL.revokeObjectURL(p.preview)); }
    catch (err) { chatNotice(err.message); PENDING_FILES = sent; input.value = text; refresh(); }
    refreshChat(true);
  } }, tray, row, fileInput);
  // voice: tap 🎤 to start and ■ to stop, or hold 🎤 and let go — either way you listen first, then 🗑 or ➤
  let downAt = 0;
  mic.addEventListener('pointerdown', (e) => {
    e.preventDefault(); downAt = Date.now();
    window.addEventListener('pointerup', () => { if (REC && !REC.starting && Date.now() - downAt > 600) stopRec('preview'); }, { once: true });
    startRec(form, row);
  });
  mic.addEventListener('contextmenu', (e) => e.preventDefault());
  lastMsgId = 0; JOBS.clear();
  const right = h('div', { class: 'row', style: 'gap:6px;flex:none' },
    h('a', { class: 'pillbtn', href: '#/chats', 'aria-label': 'All chats' }, '☰ Chats'),
    h('button', { class: 'small', type: 'button', 'aria-label': 'New chat', onclick: newChat }, '＋'));
  const page = shell('chat', 'Chat', ME?.has_key ? 'private · on your server' : 'add an AI key in Settings', log, { footer: form, right });
  refresh();
  setTimeout(() => refreshChat(true), 0);
  loadMe().then(() => { const sub = page.querySelector('.title small'); if (sub && ME) sub.textContent = ME.has_key ? (ME.name || 'private · on your server') : 'add an AI key in Settings'; });
  return page;
}
async function newChat() {
  try { const r = await api('/api/chats', {}); location.hash = '#/chat/' + r.chat.id; } catch (e) { alert(e.message); }
}
async function uploadBlob(blob, name, type) {
  const r = await fetch('/api/files?chat=' + (CHAT_ID || ''), { method: 'POST', credentials: 'same-origin', body: blob,
    headers: { 'X-CSRF': CSRF, 'Content-Type': type || blob.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(name || 'file') } });
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j.error || ('Upload failed (' + r.status + ')'));
  return j.file;
}
// Big photos are made smaller on the phone first (faster upload, and the AI does not need 12 megapixels).
async function shrinkImage(file) {
  const t = file.type || '';
  if (!/^image\//.test(t) || t === 'image/svg+xml') return file;
  if (file.size < 1.5 * 1024 * 1024 && /^image\/(jpeg|png|webp)$/.test(t)) return file;
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.86));
    if (!blob) return file;
    return new File([blob], (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}
async function addFile(file, refresh) {
  if (file.size > MAX_UPLOAD) return chatNotice(`"${file.name}" is too big (max 20 MB).`);
  const kind = /^image\//.test(file.type) ? 'image' : /^audio\//.test(file.type) ? 'audio' : /pdf/.test(file.type) ? 'pdf' : 'file';
  const p = { name: file.name || 'file', kind, state: 'up', preview: kind === 'image' ? URL.createObjectURL(file) : '' };
  PENDING_FILES.push(p); refresh();
  try {
    const f2 = await shrinkImage(file);
    const up = await uploadBlob(f2, f2.name || file.name, f2.type);
    Object.assign(p, up, { state: 'ok' });
  } catch (e) { PENDING_FILES = PENDING_FILES.filter(x => x !== p); chatNotice(e.message); }
  refresh();
}

// ---- voice notes (WhatsApp style: record → listen → send) ----
let VPREV = null;         // recorded voice note waiting in the composer (listen / delete / send)
const fmtDur = (sec) => { const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9zm4 2v8h1.6v-8H10zm3.4 0v8H15v-8h-1.6z" fill="currentColor"/></svg>';
const ICON_SEND = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z" fill="currentColor"/></svg>';
const ICON_MIC = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 14.5a3.5 3.5 0 0 0 3.5-3.5V5.5a3.5 3.5 0 1 0-7 0V11a3.5 3.5 0 0 0 3.5 3.5zm6-3.5h-1.8a4.2 4.2 0 0 1-8.4 0H6a6 6 0 0 0 5.1 5.9V20H8.5v2h7v-2h-2.6v-3.1A6 6 0 0 0 18 11z" fill="currentColor"/></svg>';
const MAX_VOICE_SEC = 300; // 5 minutes per voice note, all resumed parts together
const ICON_STOP = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor"/></svg>';
const WAVE_BARS = 40;
function neutralPeaks(seed) {   // gentle made-up waveform when the real one is not known (non-WAV audio)
  let x = 0; for (const c of String(seed || 'v')) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return Array.from({ length: WAVE_BARS }, (_, i) => { x = (x * 1103515245 + 12345) >>> 0; return 0.25 + 0.45 * Math.abs(Math.sin(i / 3.1 + (x % 97) / 30)) * ((x >>> 8) % 100) / 100 + 0.1; });
}
let VP_ACTIVE = null;     // only one voice note plays at a time
/** A voice-note player: round play/pause, tappable/draggable waveform, elapsed / total. No browser controls. */
function voicePlayer(src, o = {}) {
  const audio = new Audio();
  audio.preload = o.preload || 'none';
  audio.src = src;
  let dur = Number.isFinite(o.duration) && o.duration > 0 ? o.duration : 0, pendingSeek = null, dragging = false, raf = 0;
  const btn = h('button', { type: 'button', class: 'vp-btn', 'aria-label': 'Play voice note', html: ICON_PLAY });
  const bars = h('div', { class: 'vp-bars' });
  const knob = h('span', { class: 'vp-knob', 'aria-hidden': 'true' });
  const wave = h('div', { class: 'vp-wave', role: 'slider', tabindex: '0', 'aria-label': 'Voice note position', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, bars, knob);
  const time = h('span', { class: 'vp-time' }, '0:00');
  const el = h('div', { class: 'vplayer' + (o.compact ? ' compact' : '') + (o.row ? ' vp-inline' : '') }, btn, h('div', { class: 'vp-body' }, wave, time));
  el._audio = audio;
  function drawBars(peaks) {
    const p = (peaks && peaks.length ? peaks : neutralPeaks(src));
    bars.replaceChildren(...p.map(v => h('i', { style: `height:${Math.round(14 + Math.max(0, Math.min(1, v)) * 86)}%` })));
    paint();
  }
  const cur = () => pendingSeek !== null ? pendingSeek : (audio.currentTime || 0);
  function paint() {
    const t = cur(), frac = dur ? Math.max(0, Math.min(1, t / dur)) : 0;
    const lit = Math.round(frac * bars.children.length);
    [...bars.children].forEach((b, i) => b.classList.toggle('on', i < lit));
    knob.style.left = (frac * 100) + '%';
    wave.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    const started = !audio.paused || t > 0;
    time.textContent = dur ? (started ? (o.row ? fmtDur(t) : fmtDur(t) + ' / ' + fmtDur(dur)) : fmtDur(dur)) : fmtDur(t);
  }
  function setPlaying(on) { btn.innerHTML = on ? ICON_PAUSE : ICON_PLAY; btn.setAttribute('aria-label', on ? 'Pause voice note' : 'Play voice note'); el.classList.toggle('playing', on); }
  function loop() { cancelAnimationFrame(raf); if (!el.isConnected) { audio.pause(); return; } paint(); if (!audio.paused) raf = requestAnimationFrame(loop); }
  const learnDur = () => { const d = audio.duration; if (Number.isFinite(d) && d > 0 && Math.abs(d - dur) > 0.05) { dur = d; paint(); } };
  audio.addEventListener('loadedmetadata', () => { learnDur(); if (pendingSeek !== null && dur) { try { audio.currentTime = pendingSeek; pendingSeek = null; } catch {} } });
  audio.addEventListener('durationchange', learnDur);
  audio.addEventListener('play', () => { if (VP_ACTIVE && VP_ACTIVE !== audio) VP_ACTIVE.pause(); VP_ACTIVE = audio; setPlaying(true); loop(); });
  audio.addEventListener('pause', () => { setPlaying(false); paint(); });
  audio.addEventListener('ended', () => { setPlaying(false); try { audio.currentTime = 0; } catch {} pendingSeek = null; paint(); time.textContent = dur ? fmtDur(dur) : '0:00'; });
  audio.addEventListener('timeupdate', () => { if (!el.isConnected) audio.pause(); else if (audio.paused) paint(); });
  audio.addEventListener('error', () => { setPlaying(false); time.textContent = 'can’t play'; });
  btn.addEventListener('click', () => {
    if (!audio.paused) return audio.pause();
    if (pendingSeek !== null && audio.readyState >= 1) { try { audio.currentTime = pendingSeek; pendingSeek = null; } catch {} }
    const pr = audio.play(); if (pr && pr.catch) pr.catch(e => { if (e && e.name !== 'AbortError') { setPlaying(false); time.textContent = 'can’t play'; } });
  });
  function seekFrac(frac) {
    if (!dur) return;
    const t = Math.max(0, Math.min(1, frac)) * dur;
    if (audio.readyState >= 1) { try { audio.currentTime = Math.min(t, dur - 0.05); pendingSeek = null; } catch { pendingSeek = t; } }
    else { pendingSeek = t; if (audio.preload === 'none') { audio.preload = 'metadata'; try { audio.load(); } catch {} } }
    paint();
  }
  const fracAt = (e) => { const r = wave.getBoundingClientRect(); return r.width ? (e.clientX - r.left) / r.width : 0; };
  wave.addEventListener('pointerdown', (e) => { if (e.button > 0) return; dragging = true; try { wave.setPointerCapture(e.pointerId); } catch {} seekFrac(fracAt(e)); el.classList.add('dragging'); });
  wave.addEventListener('pointermove', (e) => { if (dragging) seekFrac(fracAt(e)); });
  const endDrag = () => { dragging = false; el.classList.remove('dragging'); };
  wave.addEventListener('pointerup', endDrag); wave.addEventListener('pointercancel', endDrag);
  wave.addEventListener('keydown', (e) => {
    if (!dur) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); seekFrac((cur() + (e.key === 'ArrowRight' ? 5 : -5)) / dur); }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); btn.click(); }
  });
  drawBars(o.peaks);
  if (o.waveUrl && !(o.peaks && dur)) {
    api(o.waveUrl).then(w => { if (w && Number.isFinite(w.duration) && w.duration > 0 && !dur) dur = w.duration; if (w && w.peaks) drawBars(w.peaks); else paint(); }).catch(() => {});
  }
  if (!dur && audio.preload === 'none') { audio.preload = 'metadata'; }   // non-WAV: let the browser read the length
  paint();
  return el;
}

/** prev: a voice note already in review — Resume keeps recording onto it (same note, one file). */
async function startRec(form, row, prev) {
  if (REC || (VPREV && !prev)) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { if (prev) showVoicePreview(form, row, prev); return chatNotice('Voice notes need a newer browser, and the https address of your assistant.'); }
  REC = { starting: true };
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { REC = null; if (prev && form.isConnected) showVoicePreview(form, row, prev); return chatNotice('The microphone is blocked. Allow the microphone for this site (browser settings → site settings), then try again.'); }
  if (!form.isConnected) { REC = null; stream.getTracks().forEach(t => t.stop()); return; }
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];
  const mime = types.find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  let rec; try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); } catch { rec = new MediaRecorder(stream); }
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const before = prev ? prev.duration || 0 : 0;               // seconds already recorded on this note
  const timer = h('span', { class: 'rectime' }, fmtDur(before));
  const bar = h('div', { class: 'recbar recording' + (prev ? ' resumed' : '') },
    h('button', { type: 'button', class: 'vbtn trash', 'aria-label': prev ? 'Throw away the new part' : 'Delete recording', html: ICON_TRASH, onclick: () => stopRec('cancel') }),
    h('span', { class: 'recdot', 'aria-hidden': 'true' }), timer, h('span', { class: 'rechint' }, prev ? 'Recording more…' : 'Recording…'),
    h('button', { type: 'button', class: 'send stop', 'aria-label': 'Stop recording', html: ICON_STOP, onclick: () => stopRec('preview') }));
  REC = { rec, stream, chunks, started: Date.now(), mime: rec.mimeType || mime, form, row, bar, tick: null, prev: prev || null, before };
  REC.tick = setInterval(() => {
    if (!REC || REC.starting) return;
    if (!bar.isConnected) return stopRec('cancel');            // left the chat while recording
    const s = before + (Date.now() - REC.started) / 1000; timer.textContent = fmtDur(s);
    if (s >= MAX_VOICE_SEC) stopRec('preview');                // 5 minutes max, all parts together
  }, 250);
  row.style.display = 'none'; form.insertBefore(bar, row);
  rec.start(250);
}
/** mode: 'preview' (stop and let him listen first) or 'cancel' (throw away; on a resumed note only the new part). */
async function stopRec(mode) {
  const r = REC; if (!r || r.starting) return; REC = null;
  clearInterval(r.tick);
  const elapsed = (Date.now() - r.started) / 1000;
  await new Promise(res => { r.rec.onstop = res; try { r.rec.stop(); } catch { res(); } setTimeout(res, 1500); });
  r.stream.getTracks().forEach(t => t.stop());
  const restore = () => { r.bar.remove(); if (!r.form.isConnected) return; if (r.prev) showVoicePreview(r.form, r.row, r.prev); else r.row.style.display = ''; };
  if (mode !== 'preview' || !r.form.isConnected) return restore();
  if (elapsed < 0.7 || !r.chunks.length) { restore(); return chatNotice(r.prev ? 'Nothing was added, that part was too short.' : 'That voice note was too short. Tap 🎤 to start, tap ■ to stop.'); }
  r.bar.replaceChildren(h('span', { class: 'rechint' }, 'Preparing…'));
  const type = (r.mime || r.chunks[0].type || 'audio/webm').split(';')[0];
  const orig = new Blob(r.chunks, { type });
  let note;
  try {
    let pcm = await decodePcm(orig);
    if (r.prev && r.prev.pcm) pcm = concatPcm(r.prev.pcm, pcm);   // Resume: same note, new audio added at the end
    note = pcmToNote(pcm);
  } catch {
    if (r.prev) { restore(); return chatNotice('Couldn’t add that part to the voice note. Your first part is still here.'); }
    // WAV plays on every phone and every model understands it; if converting fails, send the original (no Resume then)
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    note = { blob: orig, name: 'voice-note.' + ext, type, duration: elapsed, peaks: null, pcm: null };
  }
  r.bar.remove();
  if (!r.form.isConnected) return;
  showVoicePreview(r.form, r.row, note);
}
function showVoicePreview(form, row, note) {
  const url = URL.createObjectURL(note.blob);
  const player = voicePlayer(url, { duration: note.duration, peaks: note.peaks, preload: 'auto', row: true });
  const teardown = () => { player._audio.pause(); bar.remove(); URL.revokeObjectURL(url); VPREV = null; };
  const close = () => { teardown(); row.style.display = ''; };
  const del = h('button', { type: 'button', class: 'vbtn trash', 'aria-label': 'Delete voice note', html: ICON_TRASH, onclick: () => { if (!sendBtn.disabled) close(); } });
  const canResume = !!note.pcm && (note.duration || 0) < MAX_VOICE_SEC - 1;
  const resume = h('button', { type: 'button', class: 'vresume', 'aria-label': 'Resume recording', disabled: canResume ? null : '',
    title: canResume ? 'Keep recording this voice note' : (note.pcm ? 'This voice note is at the 5-minute limit' : 'This voice note can’t be continued'),
    onclick: () => { if (sendBtn.disabled || resume.disabled) return; teardown(); startRec(form, row, note); } },
    h('span', { class: 'vr-ic', html: ICON_MIC }), h('span', {}, 'Resume'));
  const sendBtn = h('button', { type: 'button', class: 'send', 'aria-label': 'Send voice note', html: ICON_SEND, onclick: async () => {
    if (sendBtn.disabled) return;
    sendBtn.disabled = true; del.disabled = true; resume.disabled = true; bar.classList.add('busy'); player._audio.pause();
    try {
      if (!note.fileId) note.fileId = (await uploadBlob(note.blob, note.name, note.type)).id;
      await api('/api/chat', { text: '', chat_id: CHAT_ID || undefined, files: [note.fileId] });
      close();
      refreshChat(true);
    } catch (e) { sendBtn.disabled = false; del.disabled = false; resume.disabled = !canResume; bar.classList.remove('busy'); chatNotice('Voice note not sent: ' + e.message + ' — tap ➤ to try again.'); }
  } });
  const bar = h('div', { class: 'recbar vpreview' },
    h('div', { class: 'vp-top' }, player),
    h('div', { class: 'vp-actions' }, del, resume, sendBtn));
  VPREV = { bar, close, note };
  row.style.display = 'none'; form.insertBefore(bar, row);
}
const PCM_RATE = 16000;
/** Decode any recording the browser made (webm/opus, mp4/aac, ogg) to 16 kHz mono samples. */
async function decodePcm(blob) {
  const AC = window.AudioContext || window.webkitAudioContext, OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AC || !OAC) throw new Error('no audio api');
  const ab = await blob.arrayBuffer();
  const ac = new AC();
  let buf;
  try { buf = await new Promise((res, rej) => { const pr = ac.decodeAudioData(ab, res, rej); if (pr && pr.then) pr.then(res, rej); }); }
  finally { try { ac.close(); } catch {} }
  if (buf.duration > MAX_VOICE_SEC + 30) throw new Error('too long');
  const len = Math.max(1, Math.ceil(buf.duration * PCM_RATE));
  const off = new OAC(1, len, PCM_RATE);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start(0);
  const out = await new Promise((res, rej) => { off.oncomplete = (e) => res(e.renderedBuffer); const pr = off.startRendering(); if (pr && pr.then) pr.then(res, rej); });
  return new Float32Array(out.getChannelData(0));
}
function concatPcm(a, b) {
  const max = MAX_VOICE_SEC * PCM_RATE, nb = Math.max(0, Math.min(b.length, max - a.length));
  const out = new Float32Array(a.length + nb); out.set(a, 0); out.set(b.subarray(0, nb), a.length); return out;
}
/** 16 kHz mono samples -> a WAV voice note with its waveform bars. */
function pcmToNote(d) {
  const rate = PCM_RATE, n = d.length, v = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const x = Math.max(-1, Math.min(1, d[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  // waveform bars (same method as the server uses for saved voice notes)
  const per = Math.max(1, Math.floor(n / WAVE_BARS)), raw = [];
  for (let b = 0; b < WAVE_BARS; b++) { let s2 = 0, c = 0; const from = b * per, to = Math.min(n, from + per), st = Math.max(1, Math.floor((to - from) / 400)); for (let i = from; i < to; i += st) { s2 += d[i] * d[i]; c++; } raw.push(c ? Math.sqrt(s2 / c) : 0); }
  const mx = Math.max(...raw, 1e-6);
  return { blob: new Blob([v], { type: 'audio/wav' }), name: 'voice-note.wav', type: 'audio/wav', duration: n / rate, peaks: raw.map(x => Math.min(1, x / mx)), pcm: d };
}

function fileView(f, generated) {
  if (f.kind === 'image') return h('div', { class: 'att' }, h('a', { href: fileUrl(f), target: '_blank', rel: 'noopener', class: 'att-img' }, h('img', { src: fileUrl(f), alt: f.name, loading: 'lazy' })),
    generated ? h('a', { class: 'att-dl', href: fileUrl(f, true) }, '⬇ Download') : null);
  // 2.3.1: files the assistant sends you: a player for audio/video, open + download for PDF, a download chip for the rest
  if (f.kind === 'audio' && generated) return h('div', { class: 'att att-card', 'data-sent': f.id }, h('div', { class: 'acname' }, h('span', { 'aria-hidden': 'true' }, '🎵 '), h('b', {}, f.name), h('small', {}, ' · ' + fmtSize(f.size))),
    voicePlayer(fileUrl(f), { waveUrl: fileUrl(f) + '/wave' }), h('a', { class: 'att-dl', href: fileUrl(f, true) }, '⬇ Download'));
  if (f.kind === 'audio') return h('div', { class: 'att att-voice' }, voicePlayer(fileUrl(f), { waveUrl: fileUrl(f) + '/wave' }));
  if (f.kind === 'video') return h('div', { class: 'att att-chip', 'data-sent': f.id }, h('a', { class: 'att-file', href: fileUrl(f), target: '_blank', rel: 'noopener' }, '🎬 ' + f.name, h('small', {}, ' · ' + fmtSize(f.size) + ' · ▶ Play')),
    h('a', { class: 'att-dl', href: fileUrl(f, true) }, '⬇ Download'));
  const icon = { pdf: '📄', docx: '📝', xlsx: '📊', pptx: '📽️', zip: '🗜️', text: '📃' }[f.kind] || (/\.apk$/i.test(f.name) ? '📦' : '📎');
  if (f.kind === 'pdf' && generated) return h('div', { class: 'att att-chip', 'data-sent': f.id }, h('a', { class: 'att-file', href: fileUrl(f), target: '_blank', rel: 'noopener' }, icon + ' ' + f.name, h('small', {}, ' · ' + fmtSize(f.size))),
    h('a', { class: 'att-dl', href: fileUrl(f, true) }, '⬇ Download'));
  return h('a', { href: fileUrl(f, true), class: 'att att-file', 'data-sent': generated ? f.id : null }, icon + ' ' + f.name, h('small', {}, ' · ' + fmtSize(f.size) + (generated ? ' · ⬇' : '')));
}
function addBubble(m, approvalStatus) {
  const log = document.getElementById('log'); if (!log) return;
  log.querySelector('.empty')?.remove();
  if (m.role === 'approval' && m.meta && m.meta.approval) {
    const id = m.meta.approval, st = (approvalStatus || {})[id] || 'pending';
    log.append(approvalCard({ id, summary: m.text.replace(/^Needs your OK \(A\d+\):\n/, '').replace(/\n\nReply YES[\s\S]*$/, ''), status: st }, true));
  } else {
    const via = m.channel && !['web', 'system'].includes(m.channel) ? h('span', { class: 'via' }, 'via ' + ({ whatsapp_agent: 'WhatsApp', whatsapp: 'WhatsApp' }[m.channel] || m.channel)) : null;
    const files = (m.files || []).map(f => fileView(f, m.role === 'assistant'));
    const voiceOnly = files.length && !m.text;
    const allVoice = files.length && (m.files || []).every(f => f.kind === 'audio');
    log.append(h('div', { class: 'bubble ' + (m.role === 'owner' ? 'owner' : m.role === 'assistant' ? 'assistant' : 'notice') + (files.length ? ' hasfiles' : '') + (allVoice && voiceOnly ? ' voice' : ''), 'data-msg': m.id || null },
      files, voiceOnly ? null : (m.text ? h('div', { class: 'btext' }, m.text) : null), via));
  }
}
function approvalCard(a, inChat) {
  const out = msgEl();
  const pending = a.status === 'pending';
  const yes = h('button', { class: 'primary', onclick: () => decideAp(a.id, true, card, out) }, 'Approve');
  const no = h('button', { class: 'danger', onclick: () => decideAp(a.id, false, card, out) }, 'Deny');
  const card = h('div', { class: 'card ap', 'data-ap': a.id }, h('h3', {}, `Needs your OK · A${a.id}`), h('pre', {}, a.summary),
    pending ? h('div', { class: 'row' }, yes, no) : h('span', { class: 'pill' + (a.status === 'done' ? ' ok' : '') }, a.status), out,
    !inChat && a.expires && pending ? h('p', { class: 'fine' }, 'Expires ' + fmt(a.expires)) : null);
  return card;
}
async function decideAp(id, yes, card, out) {
  card.querySelectorAll('button').forEach(b => b.disabled = true);
  say(out, yes ? 'Running…' : 'Cancelling…', true);
  try { const r = await api('/api/approvals/' + id, { yes }); say(out, r.message, r.ok !== false); card.querySelector('.row')?.remove(); }
  catch (e) { say(out, e.message); card.querySelectorAll('button').forEach(b => b.disabled = false); }
  PENDING = Math.max(0, PENDING - 1); updateBadge();
}
function updateBadge() { const a = document.querySelector('.tabs a[href="#/approvals"]'); if (!a) return; a.querySelector('.badge')?.remove(); if (PENDING) a.append(h('span', { class: 'badge' }, PENDING)); }
function renderJob(j, events) {
  const log = document.getElementById('log'); if (!log) return;
  let el = log.querySelector(`[data-job="${j.id}"]`);
  const active = ['queued', 'running', 'cancelling'].includes(j.status);
  if (j.parent_job) {
    // a helper: shown inside its parent's card
    const parent = log.querySelector(`[data-job="${j.parent_job}"] .subs`);
    if (!parent) { el?.remove(); return; }
    const node = h('li', { class: 'sub', 'data-job': j.id }, h('span', { class: active ? 'spin' : 'donedot', 'aria-hidden': 'true' }),
      h('b', {}, (j.title || 'Helper').replace(/^Helper: /, '').slice(0, 60)), ' · ' + (active ? `step ${j.steps || 0}` : j.status));
    if (el) el.replaceWith(node); else parent.append(node);
    return;
  }
  if (!active) { el?.remove(); return; }
  const evs = events.filter(e => e.job_id === j.id && ['tool', 'result', 'error', 'approval', 'note'].includes(e.kind));
  const list = h('ol', {}, evs.filter(e => e.kind !== 'result').slice(-12).map(e => e.kind === 'tool' ? h('li', { class: 'tool' }, h('b', {}, e.text.split(' ')[0]), ' ' + e.text.split(' ').slice(1).join(' ').slice(0, 140)) : h('li', { class: e.kind === 'error' ? 'err' : e.kind === 'approval' ? 'ap' : '' }, e.kind === 'approval' ? 'Waiting for your OK (see card)' : e.text.slice(0, 200))));
  const stop = h('button', { class: 'small', onclick: async () => { stop.disabled = true; await api('/api/jobs/' + j.id + '/cancel', {}); } }, 'Stop');
  const node = h('div', { class: 'job', 'data-job': j.id }, h('div', { class: 'head' }, h('span', {}, h('span', { class: 'spin', 'aria-hidden': 'true' }), `Working · step ${j.steps || 0} · ${j.progress || ''}`.slice(0, 90)), stop), evs.length ? list : null, h('ul', { class: 'subs' }));
  if (el) el.replaceWith(node); else log.append(node);
}
async function refreshChat(scroll) {
  const log = document.getElementById('log'); if (!log) return;
  const asked = CHAT_ID;
  let r;
  try { r = await api('/api/chat?chat=' + (CHAT_ID || '') + (lastMsgId ? '&after=' + lastMsgId : '')); }
  catch (e) { if (/deleted/.test(e.message)) { CHAT_ID = 0; localStorage.removeItem('ma_chat'); location.hash = '#/chat'; route(); } return; }
  if (asked !== CHAT_ID || document.getElementById('log') !== log) return;   // switched chats meanwhile
  if (r.chat) {
    if (!CHAT_ID) { CHAT_ID = r.chat.id; localStorage.setItem('ma_chat', String(r.chat.id)); }
    const t = document.querySelector('.title span'); if (t) t.textContent = r.chat.title || 'Chat';
    document.title = (r.chat.title || 'Chat') + ' · ' + (ME?.name || 'My Assistant');
  }
  const main = document.getElementById('main');
  const nearBottom = main && (main.scrollHeight - main.scrollTop - main.clientHeight < 120);
  if (!lastMsgId && !r.messages.length) {
    log.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'logo' }), h('p', {}, 'Ask a question, send a voice note 🎤 or a photo/file 📎, or hand me a job. I can read your Google accounts, check your servers, build sites and make pictures — and I ask before anything risky.'),
      h('div', { class: 'chips' }, ['What\'s on my calendar today?', 'Summarize my unread email', 'Check disk space on my servers', 'Make a picture of a sunrise over Jerusalem'].map(t => h('button', { class: 'chip', onclick: () => { const i = document.getElementById('input'); i.value = t; i.dispatchEvent(new Event('input')); i.focus(); } }, t)))));
  }
  for (const m of r.messages) { addBubble(m, r.approval_status); lastMsgId = Math.max(lastMsgId, m.id); }
  // keep job cards at the bottom; parents before their helpers
  log.querySelectorAll('.job').forEach(n => log.append(n));
  for (const j of r.jobs.slice().reverse()) renderJob(j, r.events);
  for (const [id, st] of Object.entries(r.approval_status || {})) { const c = log.querySelector(`[data-ap="${id}"]`); if (c && st !== 'pending' && c.querySelector('.row')) { c.querySelector('.row').replaceWith(h('span', { class: 'pill' + (st === 'done' ? ' ok' : '') }, st)); } }
  PENDING = r.pending; updateBadge();
  if (scroll || nearBottom) main.scrollTop = main.scrollHeight;
  const busy = r.jobs.some(j => ['queued', 'running', 'cancelling'].includes(j.status));
  clearTimeout(pollTimer); pollTimer = setTimeout(() => refreshChat(false), busy ? 1200 : 5000);
}

// ---------------- chats list ----------------
function chatsView() {
  const body = h('div', { class: 'list' }, h('p', { class: 'fine' }, 'Loading…'));
  const page = shell('chat', 'Chats', 'each chat has its own history', body, { right: h('button', { class: 'small primary', type: 'button', onclick: newChat }, '＋ New chat') });
  async function load() {
    let r; try { r = await api('/api/chats'); } catch (e) { body.replaceChildren(h('p', { class: 'msg err' }, e.message)); return; }
    body.replaceChildren(...r.chats.map(c => {
      const ren = h('button', { class: 'small', type: 'button', 'aria-label': 'Rename', onclick: async () => { const t = prompt('Chat name', c.title); if (t && t.trim()) { try { await api('/api/chats/' + c.id, { title: t }); load(); } catch (e) { alert(e.message); } } } }, '✎');
      const del = h('button', { class: 'small danger', type: 'button', 'aria-label': 'Delete', onclick: async () => {
        if (!confirm(`Delete "${c.title}" with its messages and files? Tasks, memory and settings stay.`)) return;
        try { await api('/api/chats/' + c.id + '/delete', {}); if (CHAT_ID === c.id) { CHAT_ID = 0; localStorage.removeItem('ma_chat'); } load(); } catch (e) { alert(e.message); }
      } }, '🗑');
      const pin = c.id === r.main ? null : h('button', { class: 'small', type: 'button', 'aria-label': 'Make main chat', title: 'Make this the main chat (Telegram/WhatsApp/SMS/email, reminders and scheduled jobs arrive in the main chat)', onclick: async () => { await api('/api/chats/' + c.id + '/main', {}); load(); } }, '📌');
      return h('div', { class: 'item chatitem' + (c.id === CHAT_ID ? ' on' : '') },
        h('a', { href: '#/chat/' + c.id, class: 'chatlink' }, h('div', { class: 'ct' }, c.title, c.id === r.main ? h('span', { class: 'pill', title: 'Messages from your other channels, reminders and scheduled jobs arrive here' }, 'main') : null),
          h('span', { class: 'sub' }, (c.last || 'No messages yet').slice(0, 80) + ' · ' + ago(c.updated))),
        h('div', { class: 'row', style: 'gap:6px;flex:none' }, pin, ren, del));
    }), h('p', { class: 'fine' }, 'Tasks, reminders, memory and settings are shared by all chats. The "main" chat also gets your Telegram/WhatsApp/SMS/email messages, reminders and scheduled jobs.'));
  }
  load();
  return page;
}

// ---------------- approvals ----------------
function approvalsView() {
  const body = h('div', { class: 'page' }, h('p', { class: 'fine' }, 'Anything that sends to other people, deletes, spends, changes a server or publishes waits here for your OK. Requests expire after 24 hours. You can also answer “YES A12” on Telegram, WhatsApp, text or email.'));
  const list = h('div', {}); body.append(list);
  let all = false;
  const toggle = h('button', { class: 'small', onclick: () => { all = !all; toggle.textContent = all ? 'Show waiting only' : 'Show history'; load(); } }, 'Show history');
  body.append(toggle);
  async function load() {
    const r = await api('/api/approvals' + (all ? '?status=all' : ''));
    list.replaceChildren(...(r.approvals.length ? r.approvals.map(a => { const c = approvalCard(a); if (a.result && a.status !== 'pending') c.append(h('p', { class: 'fine mono' }, a.result.slice(0, 300))); return c; }) : [h('div', { class: 'empty' }, all ? 'No history yet.' : 'Nothing is waiting for your OK.')]));
  }
  load();
  return shell('approvals', 'Approvals', 'nothing risky happens without you', body);
}

// ---------------- servers ----------------
function serversView() {
  const body = h('div', { class: 'page' });
  const out = msgEl();
  const f = { name: h('input', { id: 'sname', placeholder: 'e.g. web1' }), host: h('input', { id: 'shost', placeholder: 'IP or hostname' }), port: h('input', { id: 'sport', value: '22', inputmode: 'numeric' }), user: h('input', { id: 'suser', placeholder: 'e.g. ubuntu' }), key: h('textarea', { id: 'skey', rows: 3, placeholder: 'Optional: paste a private key instead of using the assistant\'s key' }) };
  const list = h('div', { class: 'list' });
  async function load() {
    const r = await api('/api/servers');
    keyBox.replaceChildren(h('p', { class: 'fine' }, 'Add this key on each server once (it lets the assistant log in; its private half never leaves this server):'), copyBox(r.public_key, 'Public key'),
      h('p', { class: 'fine' }, 'On the server, run:'), copyBox(`mkdir -p ~/.ssh && echo "${r.public_key}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`, 'Command'));
    list.replaceChildren(...(r.servers.length ? r.servers.map(s => {
      const res = msgEl();
      return h('div', { class: 'item' }, h('div', {}, h('b', {}, s.name), h('span', { class: 'sub' }, `${s.user}@${s.host}:${s.port} · ${s.key_kind === 'pasted' ? 'your key' : 'assistant key'}`), res),
        h('div', { class: 'row', style: 'flex-wrap:nowrap' }, h('button', { class: 'small', onclick: (e) => act(e.target, res, () => api(`/api/servers/${s.id}/test`, {}), r2 => r2.exit_code === 0 ? '✓ ' + r2.output.trim().slice(0, 160) : '✗ ' + r2.output.trim().slice(0, 200)) }, 'Test'),
          h('button', { class: 'small danger', onclick: async () => { if (confirm('Remove ' + s.name + '?')) { await api(`/api/servers/${s.id}/remove`, {}); load(); } } }, 'Remove')));
    }) : [h('div', { class: 'item' }, h('span', { class: 'fine' }, 'No servers yet.'))]));
  }
  const keyBox = h('div', { class: 'card' });
  body.append(h('p', { class: 'fine' }, 'The assistant runs read-only commands (look at disk, logs, services) right away. Anything that changes a server waits for your OK.'), keyBox, h('h2', {}, 'Your servers'), list,
    h('h2', {}, 'Add a server'), h('form', { onsubmit: async (e) => { e.preventDefault(); const r = await act(e.submitter || e.target.querySelector('button'), out, () => api('/api/servers', { name: f.name.value, host: f.host.value, port: f.port.value, user: f.user.value, private_key: f.key.value }), 'Saved. Tap Test.'); if (r) { f.key.value = ''; load(); } } },
      h('label', { for: 'sname' }, 'Name'), f.name, h('label', { for: 'shost' }, 'Host'), f.host, h('div', { class: 'row' }, h('div', { style: 'flex:1' }, h('label', { for: 'suser' }, 'User'), f.user), h('div', { style: 'width:90px' }, h('label', { for: 'sport' }, 'Port'), f.port)),
      h('label', { for: 'skey' }, 'Private key (optional)'), f.key, h('div', { style: 'margin-top:14px' }, h('button', { class: 'primary', type: 'submit', style: 'width:100%' }, 'Save server')), out));
  load();
  return shell('servers', 'Servers', 'logs in with its own key', body);
}

// ---------------- settings ----------------
// 2.3.1: one tidy grouped list. Every page keeps its address (#/settings/brain, …) so old links still work.
const SETTINGS_GROUPS = [
  ['Assistant', [['brain', '🧠', 'Brain (AI keys)', 'AI keys, who does what, models, limits'], ['general', '⚙️', 'General', 'Name, time zone, morning summary, light/dark']]],
  ['Connections', [['channels', '💬', 'Channels', 'WhatsApp Agent, Telegram, email, text/SMS'], ['google', '📧', 'Google accounts', 'Gmail, Calendar, Drive, Docs, Sheets, Contacts'], ['#/more/vault', '🔑', 'Vault', 'Tokens for GitHub, Cloudflare and more']]],
  ['Abilities', [['tools', '🧰', 'Tools', 'Turn abilities on or off']]],
  ['System', [['updates', '⬆️', 'Updates & backups', 'New version, update, backups'], ['security', '🛡️', 'Security', 'Password, 2-step sign-in, sessions'], ['#/more/audit', '📜', 'Activity log', 'What it did, and which key answered']]],
];
const SETTINGS_MENU = SETTINGS_GROUPS.flatMap(([, items]) => items).filter(x => !x[0].startsWith('#')).map(([id, , t, s]) => [id, t, s]);
function settingsView(sub) {
  if (!sub) {
    const page = h('div', { class: 'page setpage' },
      h('div', { class: 'sethero' }, h('div', {}, h('b', {}, ME?.name || 'My Assistant'), h('span', { class: 'sub' }, 'Version ' + (ME?.version || ''))),
        ME?.update_available ? h('a', { class: 'pill warn', href: '#/settings/updates' }, 'Update ready') : null),
      SETTINGS_GROUPS.map(([g, items]) => h('section', { class: 'setgroup' }, h('h2', { class: 'grouphead' }, g),
        h('div', { class: 'list setlist' }, items.map(([id, ic, t, s]) => h('a', { class: 'item setitem', href: id.startsWith('#') ? id : '#/settings/' + id, 'data-set': id.replace(/^#\/more\//, '') },
          h('span', { class: 'setic', 'aria-hidden': 'true' }, ic), h('div', { class: 'settext' }, h('span', { class: 'sett' }, t), h('span', { class: 'sub' }, s)),
          id === 'updates' && ME?.update_available ? h('span', { class: 'dot', 'aria-label': 'update ready' }) : null, h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')))))));
    return shell('settings', 'Settings', '', page);
  }
  const views = { brain: brainView, general: generalView, google: googleView, channels: channelsView, tools: toolsView, updates: updatesView, security: securityView };
  const body = h('div', { class: 'page' });
  (views[sub] || (() => {}))(body);
  return shell('settings', (SETTINGS_MENU.find(x => x[0] === sub) || [, 'Settings'])[1], '', body, { back: '#/settings' });
}

// Light / dark (stored on this device). Auto follows the phone.
function applyTheme() { const t = localStorage.getItem('ma_theme') || 'auto'; if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); }
applyTheme();

async function generalView(body) {
  const r = await api('/api/settings'); const s = r.settings; const out = msgEl();
  const name = h('input', { id: 'aname', value: s.assistant_name }), tz = h('input', { id: 'tz', value: s.timezone });
  const morning = h('input', { type: 'checkbox', id: 'morn' }); morning.checked = s.morning_summary === '1';
  const mtime = h('input', { id: 'mtime', value: s.morning_time, placeholder: '07:30' });
  const theme = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Appearance' }, [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => {
    const b = h('button', { type: 'button', role: 'radio', 'data-theme-set': v, 'aria-checked': String((localStorage.getItem('ma_theme') || 'auto') === v), onclick: () => { localStorage.setItem('ma_theme', v); applyTheme(); theme.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x === b))); } }, l);
    return b;
  }));
  body.append(
    h('div', { class: 'card' }, h('h3', {}, 'Assistant'), h('label', { for: 'aname' }, 'Assistant name'), name, h('label', { for: 'tz' }, 'Time zone'), tz,
      h('p', { class: 'fine' }, 'Like America/New_York. Reminders and the morning summary use it.')),
    h('div', { class: 'card' }, h('h3', {}, 'Morning summary'),
      h('div', { class: 'switch' }, h('label', { for: 'morn', style: 'margin:0;color:var(--text)' }, 'Send me a morning summary'), morning), h('label', { for: 'mtime' }, 'Time (24h)'), mtime),
    h('button', { class: 'primary', style: 'width:100%', onclick: (e) => act(e.target, out, () => api('/api/settings', { assistant_name: name.value, timezone: tz.value, morning_summary: morning.checked ? '1' : '0', morning_time: mtime.value })) }, 'Save'), out,
    h('div', { class: 'card', style: 'margin-top:14px' }, h('h3', {}, 'Appearance'), h('p', { class: 'fine', style: 'margin-top:0' }, 'On this device. Auto follows your phone.'), theme));
}

const USE_ORDER = ['chat', 'coding', 'pictures', 'media', 'background'];
const USE_INFO = { chat: ['💬', 'Chat', 'everyday questions and tasks'], coding: ['💻', 'Coding', 'apps, sites, scripts, servers'], pictures: ['🎨', 'Pictures', 'making pictures'],
  media: ['🎤', 'Voice, photos & files', 'voice notes, photos, PDFs'], background: ['⏰', 'Background jobs', 'reminders, summaries, helpers'] };
const USE_SHORT = { chat: '💬 Chat', coding: '💻 Coding', pictures: '🎨 Pictures', media: '🎤 Voice & files', background: '⏰ Background' };
// 2.3.2: what the model can do, found by Test
const CAP_ORDER = ['text', 'images', 'audio', 'pdf', 'pictures', 'tools'];
const CAP_NAME = { text: 'Chat', images: 'Photos', audio: 'Voice', pdf: 'PDF', pictures: 'Pictures', tools: 'Tools' };
const testMsg = (x) => x.message + (x.caps_note ? '\n' + x.caps_note : '');
function capsView(k) {
  const c = k && k.caps;
  if (!c) return h('p', { class: 'fine capnone', 'data-caps': 'none' }, 'Tap Test to check what this model can do (photos, voice, PDF, pictures, tools).');
  const chips = h('div', { class: 'capchips' }, CAP_ORDER.map(x => {
    const v = c[x], why = (c.unchecked && c.unchecked[x]) || (c.why && c.why[x]) || '';
    const cls = v === true ? 'yes' : v === false ? 'no' : 'unk';
    return h('span', { class: 'capchip ' + cls, 'data-cap': x, 'data-ok': String(v), title: why }, (v === true ? '✓ ' : v === false ? '✗ ' : '? ') + CAP_NAME[x]);
  }));
  const lim = Object.entries(c.unchecked || {}).filter(([x]) => c[x] !== true && c[x] !== false).map(([x, w]) => CAP_NAME[x] + (w === 'limit' ? ' (limit)' : ''));
  const notes = [];
  if (!k.caps_fresh) notes.push(c.model && c.model !== k.effective_model ? `This was for ${c.model}. Tap Test to check ${k.effective_model || 'the new model'}.` : 'The key or address changed since. Tap Test to check again.');
  else if (lim.length) notes.push("Couldn't check: " + lim.join(', ') + '. Tap Test again later.');
  if (c.files_text && c.pdf === false && k.kind !== 'gemini') notes.push('Word, Excel, PowerPoint, CSV, zip and code files are read as text.');
  return h('div', { class: 'capwrap' + (k.caps_fresh ? '' : ' stale'), 'data-caps': k.caps_fresh ? 'fresh' : 'stale' },
    h('p', { class: 'caphead' }, 'This model can:', c.checked_at ? h('span', { class: 'fine' }, ' · checked ' + ago(c.checked_at)) : null), chips,
    ...notes.map(n => h('p', { class: 'fine capnote' }, n)));
}
function keyStatus(k) {
  if (!k.active) return ['Off', ''];
  if (k.resting_until) return ['Resting till ' + String(k.resting_until_text).replace(/\s+[A-Z]{2,5}$/, ''), 'warn'];
  if (k.problem) return [k.problem[0].toUpperCase() + k.problem.slice(1), 'err'];
  if (k.in_use) return ['✓ In use', 'ok'];
  if (k.last_ok) return ['✓ Working', 'ok'];
  return [k.has_key || k.kind === 'openai' ? 'Not used yet' : 'No key saved', k.has_key ? '' : 'warn'];
}
/** Which key the assistant would pick for each kind of job right now (same rule as the server). */
function whoDoesWhat(keys) {
  const free = (k) => k.active && !k.resting_until && !k.problem && (k.has_key || k.kind === 'openai');
  return USE_ORDER.map(u => {
    const can = (k) => (k.use_support?.[u]?.ok ?? null) !== false;          // 2.3.2: Test showed it can't → not picked
    const hears = (k) => k.use_support?.media?.ok === true || (k.kind === 'gemini' && can(k));
    const pool = (u === 'pictures' ? keys.filter(k => k.kind === 'gemini') : keys).filter(can);
    const tagged = (u === 'media' ? pool.find(k => free(k) && k.use_for.includes(u) && hears(k)) : null) || pool.find(k => free(k) && k.use_for.includes(u));
    const any = tagged || (u === 'media' ? pool.find(k => free(k) && hears(k)) : null) || pool.find(k => free(k));
    return [u, any, !!tagged];
  });
}

async function brainView(body) {
  const r = await api('/api/settings'); const s = r.settings;
  const keysSec = h('section', { id: 'aikeys', class: 'bsec' }), whoSec = h('section', { class: 'bsec', id: 'whowhat' });
  // Models
  const outM = msgEl(), outL = msgEl();
  const model = h('input', { id: 'model', value: s.model, autocapitalize: 'off', spellcheck: 'false' });
  const imodel = h('input', { id: 'imodel', value: s.image_model || '', placeholder: 'gemini-3.1-flash-image', autocapitalize: 'off', spellcheck: 'false' });
  const steps = h('input', { id: 'steps', value: s.max_steps, inputmode: 'numeric' }), mins = h('input', { id: 'mins', value: s.max_minutes, inputmode: 'numeric' });
  const par = h('select', { id: 'par' }, [1, 2, 3, 4, 5, 6].map(n => h('option', { value: String(n) }, String(n)))); par.value = String(s.max_parallel || '3');
  body.append(keysSec, whoSec,
    h('section', { class: 'bsec', id: 'models' }, h('h2', { class: 'grouphead' }, 'Models'),
      h('div', { class: 'card' },
        h('label', { for: 'model', style: 'margin-top:0' }, 'Default Gemini model'), model,
        h('p', { class: 'fine' }, 'For Gemini keys whose Model is empty. A model ending in “-lite” has a bigger free limit.'),
        h('label', { for: 'imodel' }, 'Picture model'), imodel,
        h('p', { class: 'fine' }, 'For “make a picture of…”. Uses the Gemini keys set to Pictures first.'),
        h('button', { class: 'primary', style: 'width:100%;margin-top:6px', onclick: (e) => act(e.target, outM, () => api('/api/settings', { model: model.value, image_model: imodel.value }), 'Saved.').then(() => paintKeys()) }, 'Save models'), outM)),
    h('section', { class: 'bsec', id: 'limits' }, h('h2', { class: 'grouphead' }, 'Limits'),
      h('div', { class: 'card' },
        h('div', { class: 'row2' }, h('div', {}, h('label', { for: 'steps', style: 'margin-top:0' }, 'Max steps per job'), steps), h('div', {}, h('label', { for: 'mins', style: 'margin-top:0' }, 'Max minutes per job'), mins)),
        h('label', { for: 'par' }, 'Jobs at the same time'), par,
        h('p', { class: 'fine' }, 'Default 3. Free keys have per-minute limits, so more jobs at once can make each one slower.'),
        h('button', { class: 'primary', style: 'width:100%;margin-top:6px', onclick: (e) => act(e.target, outL, () => api('/api/settings', { max_steps: steps.value, max_minutes: mins.value, max_parallel: par.value })) }, 'Save limits'), outL)),
    h('p', { class: 'fine privacy' }, 'Privacy, honestly: what you ask, and the mail/file text a tool reads to answer you, goes to the AI provider of the key in use (Google for Gemini keys). On free tiers the provider may use it to improve its products. Your keys and tokens stay on your server.'));

  let K = null; const testOut = {};
  async function paintKeys(data) {
    K = data || await api('/api/brain/keys');
    keysSec.replaceChildren(
      h('div', { class: 'sechead' }, h('h2', { class: 'grouphead' }, 'AI keys'), h('button', { class: 'small primary', 'data-addkey': '1', onclick: () => openSheet(null) }, '+ Add key')),
      h('p', { class: 'inuse ' + (K.in_use ? 'ok' : 'no'), 'data-inuse': '1' }, K.in_use ? `In use now: ${K.in_use.name} (${K.in_use.model})` : (K.keys.some(k => k.active) ? 'Not used yet' : 'No active key yet — tap “+ Add key”')),
      K.keys.length ? h('div', { class: 'list keylist' }, K.keys.map((k, i) => keyRow(k, i))) : h('div', { class: 'list' }, h('p', { class: 'fine' }, 'No keys yet. A free Gemini key comes from aistudio.google.com/apikey.')),
      h('p', { class: 'fine' }, 'Tap a key to edit, test or remove it. Each job goes to the first free key set for it (top to bottom); if none is free, another active key takes over.'));
    whoSec.replaceChildren(h('h2', { class: 'grouphead' }, 'Who does what'),
      h('div', { class: 'list who' }, whoDoesWhat(K.keys).map(([u, k, tagged]) => h('div', { class: 'item whoitem', 'data-who': u },
        h('span', { class: 'setic', 'aria-hidden': 'true' }, USE_INFO[u][0]), h('div', { class: 'settext' }, h('span', { class: 'sett' }, USE_INFO[u][1]),
          h('span', { class: 'sub whokey' + (k ? (tagged ? '' : ' warn') : ' err') }, k ? '→ ' + k.name + (tagged ? '' : ' (backup)') : 'no free key right now'))))),
      h('p', { class: 'fine' }, '“Backup” = no free key is ticked for that job, so another active key does it.'));
  }
  function keyRow(k, i) {
    const [st, cls] = keyStatus(k);
    const problem = k.last_error && (k.problem || k.resting_until) ? 'Last error: ' + k.last_error + (k.last_error_at ? ' (' + ago(k.last_error_at) + ')' : '') : '';
    return h('button', { type: 'button', class: 'keyitem' + (k.active ? '' : ' off'), 'data-key': k.id, onclick: () => openSheet(k) },
      h('span', { class: 'knum' }, String(i + 1)),
      h('span', { class: 'kbody' },
        h('span', { class: 'kname' }, h('b', {}, k.name)),
        h('span', { class: 'ksub' }, (k.kind === 'gemini' ? 'Gemini' : 'OpenAI-compatible') + ' · ', h('span', { class: 'mono' }, k.effective_model || 'no model')),
        h('span', { class: 'ktags' }, h('span', { class: 'pill ' + cls, 'data-status': k.id }, st),
          k.use_for.length ? k.use_for.map(u => h('span', { class: 'tag', 'data-tag': u }, USE_SHORT[u])) : h('span', { class: 'tag none' }, 'Not used for anything')),
        problem ? h('span', { class: 'fine kline' }, problem) : null),
      h('span', { class: 'kside' }, h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')));
  }

  // ----- the edit sheet -----
  function closeSheet() { document.querySelector('.sheetback')?.remove(); document.body.classList.remove('noscroll'); }
  function openSheet(k0) {
    closeSheet();
    const isNew = !k0; let k = k0;
    const back = h('div', { class: 'sheetback', onclick: (e) => { if (e.target === back) closeSheet(); } });
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': isNew ? 'Add key' : 'Edit key', 'data-sheet': isNew ? 'new' : k.id });
    back.append(sheet); document.body.append(back); document.body.classList.add('noscroll');
    const o = msgEl(), to = msgEl();
    const kname = h('input', { 'data-f': 'name', value: k ? k.name : '', placeholder: 'e.g. Gemini – project 2 (abish@…)' });
    const kind = h('select', { 'data-f': 'kind' }, h('option', { value: 'gemini' }, 'Gemini (Google)'), h('option', { value: 'groq' }, 'Groq (free, OpenAI-compatible)'), h('option', { value: 'openai' }, 'Other OpenAI-compatible'));
    kind.value = k ? (k.kind === 'openai' && k.base_url === K.groq.base_url ? 'groq' : k.kind) : 'gemini';
    const base = h('input', { 'data-f': 'base', value: k ? k.base_url : '', placeholder: 'https://…/v1', autocapitalize: 'off', spellcheck: 'false' });
    const kmodel = h('input', { 'data-f': 'model', value: k ? k.model : '', autocapitalize: 'off', spellcheck: 'false' });
    const kkey = h('input', { 'data-f': 'key', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: k && k.has_key ? 'saved — paste to replace' : 'paste the key' });
    const act1 = h('input', { type: 'checkbox', 'data-f': 'active', 'data-active': k ? k.id : 'new', id: 'kactive' }); act1.checked = k ? k.active : true;
    if (k) act1.onchange = async () => { try { const x = await api(`/api/brain/keys/${k.id}`, { active: act1.checked }); k = x.key; paintKeys({ ...K, keys: x.keys }); say(o, act1.checked ? 'Switched on.' : 'Switched off.', true); } catch (e) { say(o, e.message); act1.checked = !act1.checked; } };
    const baseWrap = h('div', {}, h('label', {}, 'API base URL'), base);
    const help = h('p', { class: 'fine' });
    const useBoxes = {}, useWhy = {};
    const usesWrap = h('div', { class: 'uses' }, USE_ORDER.map(u => {
      const cb = h('input', { type: 'checkbox', 'data-use': u, id: 'use-' + u }); useBoxes[u] = cb;
      useWhy[u] = h('small', { class: 'usewhy', 'data-why': u, hidden: true });
      return h('label', { class: 'usebox', for: 'use-' + u }, cb, h('span', { class: 'useic', 'aria-hidden': 'true' }, USE_INFO[u][0]), h('span', { class: 'usetext' }, h('b', {}, USE_INFO[u][1]), h('small', {}, USE_INFO[u][2]), useWhy[u]));
    }));
    const capsWrap = h('div', { class: 'capsbox' });
    // 2.3.2: grey out what the model can't do (from the last Test), with a one-line reason. Untested = like 2.3.1.
    const applySupport = () => {
      const v = kind.value, kindNow = v === 'gemini' ? 'gemini' : 'openai';
      const sameSetup = k && k.kind === kindNow;
      const sup = sameSetup && k.use_support ? k.use_support : Object.fromEntries(USE_ORDER.map(u => [u, { ok: null, why: '' }]));
      if (kindNow !== 'gemini') sup.pictures = { ok: false, why: 'Pictures need a Gemini key' };
      for (const u of USE_ORDER) {
        const s = sup[u] || { ok: null, why: '' };
        useBoxes[u].disabled = s.ok === false; if (s.ok === false) useBoxes[u].checked = false;
        useWhy[u].textContent = s.why || ''; useWhy[u].hidden = !s.why;
        useWhy[u].className = 'usewhy' + (s.ok === false ? ' no' : '');
      }
      capsWrap.replaceChildren(sameSetup || !k ? capsView(k) : h('p', { class: 'fine capnone', 'data-caps': 'none' }, 'Save, then tap Test to check what this model can do.'));
    };
    const defaultsFor = (v) => v === 'gemini' ? ['chat', 'pictures', 'media', 'background'] : ['chat', 'coding'];
    const setUses = (list) => USE_ORDER.forEach(u => { useBoxes[u].checked = list.includes(u); });
    setUses(k ? k.use_for : defaultsFor('gemini'));
    const sync = (fromUser) => {
      const v = kind.value; baseWrap.hidden = v !== 'openai';
      if (v === 'groq' && fromUser) { base.value = K.groq.base_url; if (!kmodel.value || isNew) kmodel.value = K.groq.model; }
      if (v === 'openai' && fromUser && base.value === K.groq.base_url) base.value = '';
      if (fromUser && isNew) setUses(defaultsFor(v));
      applySupport();
      kmodel.placeholder = v === 'gemini' ? 'empty = default (' + (K.default_model || 'gemini-3.6-flash') + ')' : v === 'groq' ? K.groq.model : 'model name (tap Test to see the list)';
      help.replaceChildren(...(v === 'gemini' ? ['Get a free key: ', h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' }, 'aistudio.google.com/apikey'), ' → Create API key. A key from another Google project has its own free limit.']
        : v === 'groq' ? ['Get a free key: ', h('a', { href: 'https://console.groq.com/keys', target: '_blank', rel: 'noopener' }, 'console.groq.com/keys'), ' → Create API Key. After saving, tap Test: it checks what the model can do (most Groq models can\'t hear voice notes or see photos).']
          : ['Any OpenAI-compatible API (OpenRouter, OpenAI, a local server…). After saving, tap Test: it checks what the model can do.']));
    };
    kind.onchange = () => sync(true); sync(isNew);
    const models = h('div', { class: 'kmodelswrap' });
    const showModels = (list) => {
      models.replaceChildren(...(list && list.length ? [h('p', { class: 'fine' }, 'Models this key can use — tap one to choose it:'), h('div', { class: 'kmodels' }, list.slice(0, 30).map(m => h('button', { type: 'button', class: 'chip' + (m === (kmodel.value || k?.effective_model) ? ' on' : ''), 'data-model': m,
        onclick: async () => { kmodel.value = m; if (!isNew) { try { const x = await api(`/api/brain/keys/${k.id}`, { model: m }); k = x.key; K.keys = x.keys; paintKeys(K); applySupport(); say(to, `Model set to ${m}. Tap Test to check it.`, true); } catch (e) { say(to, e.message); } } showModels(list); } }, m)))] : []));
    };
    if (k && testOut[k.id]) { say(to, testMsg(testOut[k.id]), testOut[k.id].ok); showModels(testOut[k.id].models); }
    const body = () => {
      const b = { name: kname.value, kind: kind.value === 'gemini' ? 'gemini' : 'openai', model: kmodel.value, active: act1.checked, use_for: USE_ORDER.filter(u => useBoxes[u].checked) };
      if (kind.value !== 'gemini') b.base_url = kind.value === 'groq' ? (base.value || K.groq.base_url) : base.value;
      if (kkey.value) b.key = kkey.value;
      return b;
    };
    const save = async (e) => {
      const x = await act(e.target, o, () => api(isNew ? '/api/brain/keys' : `/api/brain/keys/${k.id}`, body()), 'Saved.');
      if (x) { kkey.value = ''; await paintKeys({ ...K, keys: x.keys }); closeSheet(); }
    };
    const test = async (e) => {
      if (isNew) return say(to, 'Save the key first, then tap Test.');
      const x = await act(e.target, to, () => api(`/api/brain/keys/${k.id}/test`, {}), testMsg);
      if (x) {
        testOut[k.id] = x; showModels(x.models);
        if (x.key) { k = x.key; if (x.caps) setUses(k.use_for); applySupport(); }     // ticks what it can do, greys out the rest
        paintKeys();
      }
    };
    const idx = k ? K.keys.findIndex(x => x.id === k.id) : -1;
    const move = (dir) => async () => { const x = await api(`/api/brain/keys/${k.id}/move`, { dir }); await paintKeys({ ...K, keys: x.keys }); openSheet(x.keys.find(y => y.id === k.id)); };
    const [st, cls] = k ? keyStatus(k) : ['', ''];
    sheet.append(
      h('div', { class: 'sheethead' }, h('span', { class: 'grab', 'aria-hidden': 'true' }), h('h3', {}, isNew ? 'Add key' : k.name), h('button', { class: 'small sheetx', 'aria-label': 'Close', onclick: closeSheet }, '✕')),
      h('div', { class: 'kform', 'data-form': isNew ? 'new' : k.id },
        k ? h('div', { class: 'sheetstat' }, h('span', { class: 'pill ' + cls }, st), h('span', { class: 'fine' }, [k.last_used ? 'Last used ' + ago(k.last_used) : 'Never used', k.last_error ? 'Last error: ' + k.last_error : ''].filter(Boolean).join(' · '))) : null,
        h('div', { class: 'switch' }, h('label', { for: 'kactive', style: 'margin:0;color:var(--text)' }, 'Active'), act1),
        h('label', {}, 'Name / description'), kname,
        h('label', {}, 'Type'), kind, help, baseWrap,
        h('label', {}, 'Model'), kmodel, models,
        h('label', {}, 'Key'), kkey,
        h('label', {}, 'Use for'), capsWrap, usesWrap,
        h('p', { class: 'fine' }, 'The assistant picks this key for the jobs ticked here. If it is busy or out of limit, another key takes over.'),
        h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'primary', 'data-save': '1', onclick: save }, isNew ? 'Add key' : 'Save'),
          k ? h('button', { 'data-test': k.id, onclick: test }, 'Test') : null), o, to,
        k ? h('div', { class: 'row', style: 'margin-top:4px' },
          h('button', { class: 'small', 'aria-label': 'Move up', disabled: idx <= 0, onclick: move('up') }, '↑ Higher'),
          h('button', { class: 'small', 'aria-label': 'Move down', disabled: idx === K.keys.length - 1, onclick: move('down') }, '↓ Lower')) : null,
        k ? h('button', { class: 'danger', style: 'width:100%;margin-top:14px', 'data-remove': k.id, onclick: async (e) => { if (!confirm(`Remove the key "${k.name}"? It is deleted from your server.`)) return; const x = await act(e.target, o, () => api(`/api/brain/keys/${k.id}/delete`, {}), 'Removed.'); if (x) { closeSheet(); paintKeys(); } } }, 'Remove key') : null));
    (isNew ? kname : sheet.querySelector('.sheetx')).focus?.({ preventScroll: true });
  }
  window.addEventListener('hashchange', closeSheet, { once: true });
  try { await paintKeys(); } catch (e) { keysSec.append(h('p', { class: 'msg err' }, e.message)); }
}
async function googleView(body) {
  const q = new URLSearchParams((location.hash.split('?')[1] || ''));
  const r = await api('/api/google');
  const out = msgEl(), out2 = msgEl();
  if (q.get('added')) say(out2, '✓ Added ' + q.get('added'), true);
  if (q.get('error')) say(out2, q.get('error'));
  const cid = h('input', { id: 'cid', value: r.client_id, placeholder: '…apps.googleusercontent.com' });
  const csec = h('input', { id: 'csec', type: 'password', placeholder: r.has_secret ? 'saved — paste to replace' : 'GOCSPX-…' });
  const ready = r.client_id && r.has_secret;
  body.append(
    h('div', { class: 'card' }, h('h3', {}, 'Your accounts'),
      r.accounts.length ? h('div', { class: 'list' }, r.accounts.map(a => h('div', { class: 'item' }, h('div', {}, a.email, h('span', { class: 'sub' }, a.status === 'ok' ? 'connected' : 'sign-in expired — tap Add again with this account')), h('button', { class: 'small danger', onclick: async () => { if (confirm('Remove ' + a.email + '?')) { await api(`/api/google/${a.id}/remove`, {}); location.reload(); } } }, 'Remove')))) : h('p', { class: 'fine' }, 'No Google account yet.'),
      h('button', { class: 'primary', style: 'width:100%', disabled: !ready, onclick: (e) => act(e.target, out2, async () => { const x = await api('/api/google/start', {}); location.href = x.url; }, 'Opening Google…') }, '+ Add Google account'),
      !ready ? h('p', { class: 'fine' }, 'First finish the one-time setup below.') : h('p', { class: 'fine' }, 'Add as many accounts as you like, one at a time. Google will warn the app is unverified: it is your own app, so tap Advanced → Go to (your app).'), out2),
    h('div', { class: 'card' }, h('h3', {}, 'One-time Google setup (about 5 minutes, on a computer is easiest)'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Open ', h('a', { href: 'https://console.cloud.google.com/projectcreate', target: '_blank', rel: 'noopener' }, 'Google Cloud → New project'), ', name it “My Assistant”, Create.'),
        h('li', {}, h('a', { href: r.enable_apis_link, target: '_blank', rel: 'noopener' }, 'Tap here to switch on the 6 APIs'), ' (Gmail, Calendar, Drive, Docs, Sheets, People) → Next → Enable.'),
        h('li', {}, 'Go to ', h('a', { href: 'https://console.cloud.google.com/auth/overview', target: '_blank', rel: 'noopener' }, 'Google Auth Platform'), ' → Get started: app name “My Assistant”, your email, Audience: ', h('b', {}, 'External'), ', finish.'),
        h('li', {}, 'Audience → Test users → add each Gmail you will connect. Then tap ', h('b', {}, 'Publish app'), ' (In production). Why: in “Testing”, Google signs you out every 7 days. In production it keeps working; Google just shows an “unverified app” warning you click past. No review is needed for your own use.'),
        h('li', {}, 'Clients → Create client → ', h('b', {}, 'Web application'), '. Under Authorized redirect URIs add exactly:', copyBox(r.redirect_uri, 'Redirect URI'), 'Create, then copy the Client ID and Client secret into the boxes below.')),
      h('label', { for: 'cid' }, 'Client ID'), cid, h('label', { for: 'csec' }, 'Client secret'), csec,
      h('div', { style: 'margin-top:12px' }, h('button', { class: 'primary', style: 'width:100%', onclick: (e) => act(e.target, out, () => api('/api/google/client', { client_id: cid.value, client_secret: csec.value }), 'Saved. Now tap “Add Google account”.').then(() => setTimeout(route, 900)) }, 'Save')), out,
      h('p', { class: 'fine' }, 'If Google refuses the redirect address (it ends in sslip.io), point a domain you own at this server and re-run the installer with MA_DOMAIN=your.domain.')));
}
// 2.2: WhatsApp Agent (Meta's WhatsApp Agent Platform). The key is stored in the Vault and never shown again.
function waAgentStatusText(w) {
  if (!w.enabled) return [w.has_key ? 'Off (key saved)' : 'Off', 'no'];
  if (w.state === 'connected') return [w.creator_known ? '✓ Connected' + (w.last_in ? ' · last message ' + ago(w.last_in) : '') : '✓ Connected — now send your agent a first message in WhatsApp', 'ok'];
  if (w.state === 'connecting') return [w.error ? w.error : 'Connecting…', 'no'];
  return ['⚠ ' + (w.error || 'Not connected'), 'no'];
}
function waAgentCard(w) {
  const out = msgEl();
  const stat = h('p', { class: 'stat', id: 'waa-status', role: 'status' });
  const key = h('input', { id: 'waakey', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: w.has_key ? 'saved in Vault — paste to replace' : 'paste the API key' });
  const on = h('input', { type: 'checkbox', id: 'waaon' }); on.checked = w.enabled;
  const btns = h('div', { class: 'row', style: 'margin-top:10px' });
  const card = h('div', { class: 'card', id: 'wa-agent-card' });
  const paint = (x) => {
    w = x || w;
    const [t, cls] = waAgentStatusText(w); stat.textContent = t; stat.className = 'stat ' + cls;
    key.placeholder = w.has_key ? 'saved in Vault — paste to replace' : 'paste the API key';
    on.checked = w.enabled;
    if (typeof paintReact === 'function' && document.activeElement !== rEmoji) paintReact();
    btns.replaceChildren(
      h('button', { class: 'primary', onclick: async (e) => { const x = await act(e.target, out, () => api('/api/wa-agent/key', { key: key.value }), w.enabled ? 'Key saved. Reconnecting…' : 'Key saved in your Vault. Now turn on “Enabled”.'); if (x) { key.value = ''; paint(x); } } }, 'Save key'),
      h('button', { disabled: !(w.enabled && w.creator_known), onclick: (e) => act(e.target, out, () => api('/api/wa-agent/test', {}), 'Sent. Look in your WhatsApp agent chat.') }, 'Send test'),
      w.has_key ? h('button', { class: 'danger small', onclick: async (e) => { if (!confirm('Remove the WhatsApp Agent key from the Vault?')) return; const x = await act(e.target, out, () => api('/api/wa-agent/key/remove', {}), 'Key removed.'); if (x) paint(x); } }, 'Remove key') : null);
  };
  // 2.3.3: automatic reaction when it gets his message
  const rOn = h('input', { type: 'checkbox', id: 'waareact' });
  const rEmoji = h('select', { id: 'waaemoji', 'aria-label': 'Reaction emoji' }, (w.react_choices || ['👍', '👀', '❤️', '✅']).map(e => h('option', { value: e }, e)));
  const rOut = msgEl();
  const paintReact = () => { rOn.checked = w.react !== false; rEmoji.value = w.react_emoji || '👍'; rEmoji.disabled = !rOn.checked; };
  const saveReact = async (el, body, ok) => { const x = await act(el, rOut, () => api('/api/wa-agent/react', body), ok); if (x) { w = x; } paintReact(); };
  rOn.onchange = () => saveReact(rOn, { on: rOn.checked }, rOn.checked ? 'On. It reacts ' + rEmoji.value + ' when it gets your message.' : 'Off. No automatic reaction.');
  rEmoji.onchange = () => saveReact(rEmoji, { emoji: rEmoji.value }, 'Saved. It reacts ' + rEmoji.value + '.');
  paintReact();
  on.onchange = async () => { const x = await act(on, out, () => api('/api/wa-agent', { enabled: on.checked }), on.checked ? 'Turned on. Connecting…' : 'Turned off.'); if (x) paint(x); else on.checked = !on.checked; };
  card.append(h('h3', {}, 'WhatsApp Agent (new — free, in your own WhatsApp)'), stat,
    h('ol', { class: 'steps' },
      h('li', {}, 'In WhatsApp: ', h('b', {}, 'Settings → Agents → Create an agent'), ' (or use the one you have, e.g. “Sende”).'),
      h('li', {}, 'Open the agent’s chat → ', h('b', {}, 'Chat info → API key'), ', copy it.'),
      h('li', {}, 'Paste it here, tap ', h('b', {}, 'Save key'), ', then turn on ', h('b', {}, 'Enabled'), '.'),
      h('li', {}, 'Send your agent any message. It lands in your 📌 main chat and I answer in WhatsApp. Voice notes, photos and PDFs work.')),
    h('label', { for: 'waakey' }, 'API key (kept encrypted in your Vault, never shown again)'), key,
    h('div', { class: 'switch', style: 'margin-top:10px' }, h('label', { for: 'waaon', style: 'margin:0;color:var(--text)' }, 'Enabled'), on),
    btns, out,
    h('div', { class: 'switch', style: 'margin-top:14px' }, h('label', { for: 'waareact', style: 'margin:0;color:var(--text)' }, 'React to my messages'), rOn),
    h('div', { class: 'row', style: 'margin-top:8px;align-items:center;gap:10px' }, h('label', { for: 'waaemoji', style: 'margin:0' }, 'Reaction'), rEmoji),
    h('p', { class: 'fine', style: 'margin-top:6px' }, 'When it gets your message it reacts with this emoji. The assistant may change it to ❤️, 😂 or ✅ when that fits (✅ = done).'),
    rOut,
    h('p', { class: 'fine' }, 'Only you (the agent’s creator) can chat with it. Reminders, morning summary and approval requests also go there. Approve by tapping Approve in this app, or reply “YES A12”. WhatsApp allows 12 messages a minute, so long answers may take a moment. Messages there are not end-to-end encrypted.'));
  paint(w);
  // keep the status fresh while this page is open
  const tick = async () => { if (!card.isConnected) return; try { paint(await api('/api/wa-agent')); } catch {} setTimeout(tick, 5000); };
  setTimeout(tick, 3000);
  return card;
}
async function channelsView(body) {
  const r = await api('/api/channels');
  // notify
  const nc = h('select', { id: 'nc' }, ['web', 'whatsapp_agent', 'telegram', 'whatsapp', 'sms', 'email'].map(c => h('option', { value: c }, { web: 'This web page only', whatsapp_agent: 'WhatsApp Agent', telegram: 'Telegram', whatsapp: 'WhatsApp (Business API)', sms: 'Text (SMS)', email: 'Email' }[c]))); nc.value = r.notify_channel;
  const out0 = msgEl();
  body.append(h('div', { class: 'card' }, h('h3', {}, 'Where reminders, summaries and approval requests go'), nc, h('div', { style: 'margin-top:10px' }, h('button', { class: 'primary small', onclick: (e) => act(e.target, out0, () => api('/api/settings', { notify_channel: nc.value })) }, 'Save')), out0));
  body.append(waAgentCard(r.wa_agent));
  // telegram
  const t = r.telegram, tout = msgEl();
  const tok = h('input', { id: 'tgtok', type: 'password', autocomplete: 'off', placeholder: '123456789:AA…' });
  const pairBox = h('div', {});
  body.append(h('div', { class: 'card' }, h('h3', {}, 'Telegram (free, instant — recommended)'),
    h('p', { class: 'stat ' + (t.paired ? 'ok' : 'no') }, t.paired ? `✓ Connected to @${t.bot} and paired to your chat` : t.connected ? `Bot @${t.bot} connected — not paired yet` : 'Not connected'),
    h('ol', { class: 'steps' }, h('li', {}, 'In Telegram, open ', h('a', { href: 'https://t.me/BotFather', target: '_blank', rel: 'noopener' }, '@BotFather'), ', send /newbot, pick a name.'), h('li', {}, 'Copy the token it gives you and paste it here. I set up the connection myself.'), h('li', {}, 'Tap the pairing link I show you, then Start. Only that chat will be answered.')),
    h('label', { for: 'tgtok' }, 'Bot token'), tok,
    h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: async (e) => { const x = await act(e.target, tout, () => api('/api/telegram/setup', { token: tok.value }), 'Connected. Now tap the pairing link.'); if (x) { tok.value = ''; pairBox.replaceChildren(h('p', {}, h('a', { class: 'pill ok', href: x.link, target: '_blank', rel: 'noopener', style: 'font-size:15px;padding:8px 14px' }, `Pair with @${x.bot} →`)), h('p', { class: 'fine' }, `Or send /start ${x.code} to @${x.bot}. Link works for 30 minutes.`)); } } }, t.connected ? 'Reconnect' : 'Connect'),
      t.paired ? h('button', { onclick: (e) => act(e.target, tout, () => api('/api/telegram/test', {}), 'Sent a test message.') }, 'Test') : null,
      t.connected ? h('button', { class: 'danger', onclick: (e) => act(e.target, tout, () => api('/api/telegram/disconnect', {}), 'Disconnected.') }, 'Disconnect') : null), pairBox, tout));
  // email
  const e = r.email, eout = msgEl();
  const en = h('input', { type: 'checkbox', id: 'emon' }); en.checked = e.enabled;
  const acct = h('select', { id: 'emacct' }, e.accounts.length ? e.accounts.map(a => h('option', { value: a }, a)) : h('option', { value: '' }, 'connect a Google account first')); acct.value = e.account;
  body.append(h('div', { class: 'card' }, h('h3', {}, 'Email'), h('p', { class: 'fine' }, 'Email yourself with a subject starting “AI:” — I answer in the same thread within a minute. Only mail from your own address counts. Reply “YES A12” to approve.'),
    h('div', { class: 'switch' }, h('label', { for: 'emon', style: 'margin:0;color:var(--text)' }, 'Answer “AI:” emails'), en), h('label', { for: 'emacct' }, 'Using account'), acct,
    h('div', { style: 'margin-top:10px' }, h('button', { class: 'primary small', disabled: !e.accounts.length, onclick: (ev) => act(ev.target, eout, () => api('/api/email', { enabled: en.checked, account: acct.value })) }, 'Save')), eout));
  // sms
  const s = r.sms, sout = msgEl();
  const sf = { user: h('input', { id: 'smsu', value: s.username, autocomplete: 'off' }), pass: h('input', { id: 'smsp', type: 'password', placeholder: s.has_password ? 'saved — paste to replace' : '' }), allow: h('input', { id: 'smsa', value: s.allow, placeholder: '+1646…, your own number(s)' }), base: h('input', { id: 'smsb', value: s.base_url }), sign: h('input', { id: 'smss', type: 'password', placeholder: s.signing ? 'saved' : 'optional' }) };
  const dl = 'https://github.com/capcom6/android-sms-gateway/releases/latest';
  const qr = h('div', { class: 'qr' }); api('/api/qr?text=' + encodeURIComponent(dl)).then(x => { if (x.svg) qr.innerHTML = x.svg; else qr.remove(); }).catch(() => qr.remove());
  body.append(h('div', { class: 'card' }, h('h3', {}, 'Text messages (SMS/MMS) through an Android phone'), h('p', { class: 'stat ' + (s.has_password ? 'ok' : 'no') }, s.has_password ? '✓ Gateway saved' : 'Not connected'),
    h('ol', { class: 'steps' }, h('li', {}, 'On a spare Android phone with a SIM, install the free app ', h('b', {}, 'SMS Gateway for Android'), ' (', h('a', { href: dl, target: '_blank', rel: 'noopener' }, 'download'), ', or scan:)'), qr,
      h('li', {}, 'Open it → turn on ', h('b', {}, 'Cloud server'), ' → tap Online. It shows a Username and Password.'), h('li', {}, 'Paste them here with your own number, tap Connect. I register the webhook myself.'), h('li', {}, 'Keep that phone charged and online. Texts from your number become commands; texts from others are kept in your inbox for me to read. Picture messages show as “MMS received” (pictures are not downloaded).')),
    h('label', { for: 'smsu' }, 'Username'), sf.user, h('label', { for: 'smsp' }, 'Password'), sf.pass, h('label', { for: 'smsa' }, 'Your number(s) — only these can command me'), sf.allow,
    h('details', {}, h('summary', { class: 'fine' }, 'Advanced'), h('label', { for: 'smsb' }, 'API address'), sf.base, h('label', { for: 'smss' }, 'Webhook signing key (from the app settings)'), sf.sign),
    h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: (ev) => act(ev.target, sout, () => api('/api/sms/setup', { sms_username: sf.user.value, sms_password: sf.pass.value, sms_allow: sf.allow.value, sms_base_url: sf.base.value, sms_signing_key: sf.sign.value }), x => (x.steps || []).join('\n')) }, 'Connect'),
      s.has_password ? h('button', { onclick: (ev) => act(ev.target, sout, () => api('/api/sms/test', {}), 'Test text queued to your number.') }, 'Test') : null), sout));
  // whatsapp
  const w = r.whatsapp, wout = msgEl();
  const wf = { pid: h('input', { id: 'wapid', value: w.phone_number_id, inputmode: 'numeric' }), waba: h('input', { id: 'wawaba', value: w.waba_id, inputmode: 'numeric' }), app: h('input', { id: 'waapp', value: w.app_id, inputmode: 'numeric' }), secret: h('input', { id: 'wasec', type: 'password', placeholder: w.has_app_secret ? 'saved' : '' }), token: h('input', { id: 'watok', type: 'password', placeholder: w.has_token ? 'saved — paste to replace' : 'EAA…' }), allow: h('input', { id: 'waallow', value: w.allow, placeholder: '1646…, your WhatsApp number' }) };
  const manual = h('div', {});
  const showManual = async () => { const x = await api('/api/whatsapp/prepare', {}); manual.replaceChildren(h('p', { class: 'fine' }, 'Manual webhook (only if automatic setup fails): Meta app → WhatsApp → Configuration → Webhook → Edit:'), h('label', {}, 'Callback URL'), copyBox(x.webhook_url), h('label', {}, 'Verify token'), copyBox(x.verify_token), h('p', { class: 'fine' }, 'Then subscribe to the “messages” field.')); };
  body.append(h('div', { class: 'card' }, h('h3', {}, 'WhatsApp (Meta Cloud API)'), h('p', { class: 'stat ' + (w.has_token ? 'ok' : 'no') }, w.has_token ? '✓ Saved' : 'Not connected'),
    h('p', { class: 'fine' }, 'Honest note: Meta requires a few taps only you can do: a Meta developer account, a phone number for the bot (Meta texts it a code; it cannot be a number already used in the WhatsApp app), and sometimes business verification. After that I do the rest.'),
    h('ol', { class: 'steps' }, h('li', {}, h('a', { href: 'https://developers.facebook.com/apps/creation/', target: '_blank', rel: 'noopener' }, 'developers.facebook.com → Create app'), ' → use case “Connect with customers through WhatsApp” → link or create a business.'),
      h('li', {}, 'WhatsApp → API Setup: add your bot number (Meta sends it a code). Copy the ', h('b', {}, 'Phone number ID'), ' and ', h('b', {}, 'WhatsApp Business Account ID'), '.'),
      h('li', {}, 'App settings → Basic: copy ', h('b', {}, 'App ID'), ' and ', h('b', {}, 'App secret'), '.'),
      h('li', {}, 'business.facebook.com → Settings → System users → Add (Admin) → Assign your app → Generate token with whatsapp_business_messaging + whatsapp_business_management, expiry Never. Copy it.'),
      h('li', {}, 'Paste everything here and tap Connect. I register the webhook with Meta myself.')),
    h('label', { for: 'wapid' }, 'Phone number ID'), wf.pid, h('label', { for: 'wawaba' }, 'WhatsApp Business Account ID'), wf.waba, h('label', { for: 'waapp' }, 'App ID'), wf.app, h('label', { for: 'wasec' }, 'App secret'), wf.secret, h('label', { for: 'watok' }, 'Permanent access token'), wf.token, h('label', { for: 'waallow' }, 'Your WhatsApp number(s) — only these can command me'), wf.allow,
    h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: (ev) => act(ev.target, wout, () => api('/api/whatsapp/setup', { wa_phone_number_id: wf.pid.value, wa_waba_id: wf.waba.value, wa_app_id: wf.app.value, wa_app_secret: wf.secret.value, wa_token: wf.token.value, wa_allow: wf.allow.value }), x => (x.steps || []).join('\n')) }, 'Connect'),
      w.has_token ? h('button', { onclick: (ev) => act(ev.target, wout, () => api('/api/whatsapp/test', {}), 'Sent. (Meta only delivers if you messaged the bot in the last 24 h.)') }, 'Test') : null,
      h('button', { onclick: showManual }, 'Manual webhook')), wout, manual));
}
async function toolsView(body) {
  const r = await api('/api/settings');
  body.append(h('p', { class: 'fine' }, 'Like the starter\'s enabled_tools.txt: switch any ability off and the assistant cannot use it. ', h('span', { class: 'pill warn' }, 'asks first'), ' = files an approval before doing anything risky.'));
  const list = h('div', { class: 'card' });
  for (const t of r.tools) {
    const cb = h('input', { type: 'checkbox', id: 'tool-' + t.name, 'aria-label': t.name }); cb.checked = t.enabled;
    cb.addEventListener('change', async () => { try { await api('/api/tools', { name: t.name, enabled: cb.checked }); } catch (e) { cb.checked = !cb.checked; alert(e.message); } });
    list.append(h('div', { class: 'switch' }, h('div', {}, h('b', { class: 'mono' }, t.name), ' ', t.approval ? h('span', { class: 'pill warn' }, 'asks first') : null, h('span', { class: 'sub fine', style: 'display:block' }, t.description.slice(0, 120))), cb));
  }
  body.append(list);
}
function updateSourceCard(r) {
  // 2.3.1: his own address first, then the repo's /docs on GitHub, then the release site (tried in order, automatically).
  const out = msgEl();
  const lab = (u) => String(u || '').replace(/^https:\/\//, '');
  const cur = r.repo ? 'legacy' : r.source ? 'custom' : 'default';
  const kind = h('select', { id: 'usrc' },
    h('option', { value: 'default' }, lab(r.source_default) + ' (default)'),
    h('option', { value: 'custom' }, 'Another address'),
    r.repo ? h('option', { value: 'legacy' }, 'GitHub latest release: ' + r.repo + ' (older mode)') : null);
  kind.value = cur;
  const link = h('input', { id: 'usrclink', value: cur === 'custom' ? r.source : '', placeholder: 'https://updates.example.com', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', inputmode: 'url' });
  const linkBox = h('div', {}, h('label', { for: 'usrclink' }, 'Address'), link, h('p', { class: 'fine' }, 'A folder with version.json and myassistant-latest.tar.gz (+ .sha256). A GitHub repo link works too: its /docs folder is used.'));
  const sync = () => { linkBox.hidden = kind.value !== 'custom'; };
  kind.addEventListener('change', sync); sync();
  const order = (r.sources || []).map((s, i) => h('li', {}, s, i === 0 ? h('span', { class: 'fine' }, ' — first') : null));
  return h('div', { class: 'card', id: 'updsource' }, h('h3', {}, 'Update source'),
    h('label', { for: 'usrc', style: 'margin-top:0' }, 'Get updates from'), kind, linkBox,
    h('p', { class: 'fine' }, 'Tried in this order. If one can\'t be reached, the next is used, and the Activity log says so. Every download is checked with its .sha256 before installing.'),
    h('ol', { class: 'fine srcorder', 'data-sources': '1' }, order),
    r.checked_from ? h('p', { class: 'fine' }, 'Last check came from: ' + r.checked_from) : null,
    h('div', { style: 'margin-top:12px' }, h('button', { class: 'primary', style: 'width:100%', 'data-save-source': '1', onclick: (e) => act(e.target, out, () => {
      const v = kind.value;
      if (v === 'legacy') return Promise.resolve({});
      return api('/api/settings', { update_repo: '', update_source: v === 'default' ? '' : link.value });
    }, 'Saved. Tap “Check now” to look for an update.').then(x => { if (x) setTimeout(route, 900); }) }, 'Save')), out);
}
async function updatesView(body) {
  const r = await api('/api/update'); const b = await api('/api/backups'); const s = await api('/api/settings'); const g = await api('/api/google');
  const updStat = h('p', { class: 'stat ' + (r.available ? 'no' : 'ok') }, r.available ? `Version ${r.available} is ready.` : 'Up to date (as of the last check).');
  const updNotes = h('p', { class: 'fine', style: r.notes ? null : 'display:none' }, r.notes || '');
  const showUpdate = (x) => {   // right after "Check now": show the new version and turn on Update now, no reload needed
    updStat.className = 'stat ' + (x.newer ? 'no' : 'ok'); updStat.textContent = x.newer ? `Version ${x.latest} is ready.` : 'Up to date (as of the last check).';
    updNotes.textContent = x.newer ? (x.notes || '') : ''; updNotes.style.display = x.newer && x.notes ? '' : 'none';
    updBtn.disabled = !x.newer; if (x.newer) updBtn.removeAttribute('disabled'); else updBtn.setAttribute('disabled', '');
  };
  const updBtn = h('button', { class: 'primary', 'data-update-now': '1', disabled: !r.available, onclick: (e) => { if (confirm('Update now? The assistant restarts for about a minute.')) act(e.target, out, () => api('/api/update/apply', {}), 'Updating… reload this page in a minute.'); } }, 'Update now');
  const out = msgEl(), bout = msgEl();
  const drive = h('select', { id: 'bdrive' }, h('option', { value: '' }, 'Off'), g.accounts.map(a => h('option', { value: a.email }, a.email))); drive.value = s.settings.backup_drive_account;
  body.append(h('div', { class: 'card' }, h('h3', {}, 'Version ' + r.current), updStat, updNotes,
    h('p', { class: 'fine' }, 'It checks for updates and tells you. It never updates itself: nothing changes until you tap Update now. Your data, keys and settings are kept.'),
    h('div', { class: 'row' }, h('button', { onclick: (e) => act(e.target, out, () => api('/api/update/check', {}), x => { showUpdate(x); const src = x.from ? ` (from ${x.from}${x.fell_back ? '; the first source didn\'t answer' : ''})` : ''; return (x.newer ? `Version ${x.latest} is ready. Tap Update now.` : `You have the latest (${x.latest}).`) + src; }) }, 'Check now'),
      updBtn), out,
    r.log ? h('details', {}, h('summary', { class: 'fine' }, 'Last update log'), h('pre', { class: 'mono', style: 'white-space:pre-wrap' }, r.log)) : null),
    updateSourceCard(r),
    h('div', { class: 'card' }, h('h3', {}, 'Backups'), h('p', { class: 'fine' }, `Every night at 3:00 a copy of the database is saved on the server (${b.dir}), keeping the last ${s.settings.backup_keep}.`),
      h('p', { class: 'fine' }, b.backups.length ? 'Latest: ' + b.backups[0] : 'No backup yet.'),
      h('label', { for: 'bdrive' }, 'Also copy to Google Drive'), drive, h('p', { class: 'fine' }, 'The copy\'s saved keys stay encrypted; restoring needs the master.key file from the server.'),
      h('div', { class: 'row' }, h('button', { onclick: (e) => act(e.target, bout, () => api('/api/settings', { backup_drive_account: drive.value })) }, 'Save'), h('button', { class: 'primary', onclick: (e) => act(e.target, bout, () => api('/api/backup/now', {}), x => 'Saved ' + x.file) }, 'Back up now')), bout));
}
function securityView(body) {
  const out = msgEl(), out2 = msgEl();
  const o = h('input', { id: 'opw', type: 'password', autocomplete: 'current-password' }), n = h('input', { id: 'npw', type: 'password', autocomplete: 'new-password' }), c = h('input', { id: 'pcode', inputmode: 'numeric', placeholder: '6-digit code' });
  body.append(h('div', { class: 'card' }, h('h3', {}, 'Change password'), h('label', { for: 'opw' }, 'Current password'), o, h('label', { for: 'npw' }, 'New password (10+ characters)'), n, h('label', { for: 'pcode' }, 'Authenticator code'), c,
    h('div', { style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: (e) => act(e.target, out, () => api('/api/password', { old_password: o.value, new_password: n.value, code: c.value }), 'Changed. Sign in again.').then(() => setTimeout(() => location.reload(), 1200)) }, 'Change')), out),
    h('div', { class: 'card' }, h('h3', {}, 'Sessions'), h('button', { onclick: (e) => act(e.target, out2, () => api('/api/sessions/revoke', {}), 'Every other device is signed out.') }, 'Sign out everywhere else'), out2),
    h('div', { class: 'card' }, h('h3', {}, 'Lost your phone?'), h('p', { class: 'fine' }, 'Use one of your backup codes in the code box. Or log into the server and run: sudo myassistant reset-login — it gives you a new setup code (your data stays).')),
    h('div', { class: 'card' }, h('h3', {}, 'How it stays private'), h('ul', { class: 'fine' }, h('li', {}, 'Runs on your server; only your password + authenticator code opens it.'), h('li', {}, 'Keys and tokens are encrypted on disk (AES-256) and never shown back.'), h('li', {}, 'Every channel only obeys you (your Telegram chat, your numbers, your email).'), h('li', {}, 'The AI model provider (Google Gemini by default) sees what you ask it.'))));
}

// ---------------- more ----------------
function moreView(sub) {
  if (!sub) return shell('more', 'More', '', h('div', { class: 'page' }, h('div', { class: 'list' },
    [['tasks', 'Tasks, reminders & memory'], ['vault', 'Vault (platform tokens)'], ['projects', 'Projects & sites'], ['audit', 'Activity log']].map(([id, t]) => h('a', { class: 'item', href: '#/more/' + id }, t, h('span', { class: 'chev' }, '›')))),
    h('button', { class: 'danger', style: 'width:100%', onclick: async () => { await api('/api/logout', {}); ME = null; route(); } }, 'Sign out')));
  const body = h('div', { class: 'page' });
  ({ tasks: tasksView, vault: vaultView, projects: projectsView, audit: auditView }[sub] || (() => {}))(body);
  return shell('more', { tasks: 'Tasks & memory', vault: 'Vault', projects: 'Projects & sites', audit: 'Activity log' }[sub] || 'More', '', body, { back: '#/more' });
}
async function tasksView(body) {
  const r = await api('/api/tasks');
  const t = h('input', { id: 'ttitle', placeholder: 'New task' }), d = h('input', { id: 'tdue', type: 'datetime-local' }), out = msgEl();
  body.append(h('form', { class: 'card', onsubmit: async (e) => { e.preventDefault(); await act(e.submitter || e.target.querySelector('button'), out, () => api('/api/tasks', { title: t.value, due: d.value ? new Date(d.value).toISOString() : '' })); route(); } }, h('label', { for: 'ttitle' }, 'Add a task (or just ask in chat)'), t, h('label', { for: 'tdue' }, 'Remind me at'), d, h('div', { style: 'margin-top:10px' }, h('button', { class: 'primary small', type: 'submit' }, 'Add')), out),
    h('h2', {}, 'Tasks'), h('div', { class: 'list' }, r.tasks.length ? r.tasks.map(x => h('div', { class: 'item' }, h('div', {}, x.status === 'done' ? h('s', {}, x.title) : x.title, h('span', { class: 'sub' }, x.due ? fmt(x.due) : 'no date')), x.status !== 'done' ? h('button', { class: 'small', onclick: async () => { await api(`/api/tasks/${x.id}/done`, {}); route(); } }, 'Done') : null)) : h('div', { class: 'item fine' }, 'No tasks.')),
    h('h2', {}, 'Repeating jobs'), h('div', { class: 'list' }, r.schedules.length ? r.schedules.map(x => h('div', { class: 'item' }, h('div', {}, x.prompt.slice(0, 120), h('span', { class: 'sub' }, 'next ' + fmt(x.next_run) + (x.every_minutes ? ` · every ${x.every_minutes} min` : ''))), h('button', { class: 'small danger', onclick: async () => { await api(`/api/schedules/${x.id}/cancel`, {}); route(); } }, 'Stop'))) : h('div', { class: 'item fine' }, 'None. Ask in chat: “every morning at 8 check my servers”.')),
    h('h2', {}, 'What I remember about you'), h('div', { class: 'list' }, r.memory.length ? r.memory.map(x => h('div', { class: 'item' }, h('div', {}, x.fact, h('span', { class: 'sub' }, fmt(x.ts))), h('button', { class: 'small danger', onclick: async () => { await api(`/api/memory/${x.id}/remove`, {}); route(); } }, 'Forget'))) : h('div', { class: 'item fine' }, 'Nothing yet.')),
    h('h2', {}, 'Texts from others'), h('div', { class: 'list' }, r.inbox.length ? r.inbox.map(x => h('div', { class: 'item' }, h('div', {}, x.text, h('span', { class: 'sub' }, `${x.channel} · ${x.sender} · ${fmt(x.ts)}`)))) : h('div', { class: 'item fine' }, 'None.')));
}
async function vaultView(body) {
  const r = await api('/api/platforms');
  const f = { kind: h('select', { id: 'pkind' }, ['github', 'cloudflare', 'digitalocean', 'vercel', 'netlify', 'whatsapp-agent', 'other'].map(k => h('option', { value: k }, k))), name: h('input', { id: 'pname', placeholder: 'name (default: same as type)' }), token: h('input', { id: 'ptok', type: 'password', autocomplete: 'off' }), acct: h('input', { id: 'pacct', placeholder: 'Cloudflare only' }), base: h('input', { id: 'pbase', placeholder: 'https://api.example.com (for “other”)' }) };
  const out = msgEl();
  body.append(h('p', { class: 'fine' }, 'API tokens for other platforms. Stored encrypted, used by tools, never shown back. Prefer tokens with only the permissions needed (e.g. a GitHub fine-grained token for chosen repos).'),
    h('div', { class: 'list' }, r.platforms.length ? r.platforms.map(p => h('div', { class: 'item' }, h('div', {}, h('b', {}, p.name), h('span', { class: 'sub' }, p.kind + ' · token saved')), h('button', { class: 'small danger', onclick: async () => { if (confirm('Delete token ' + p.name + '?')) { await api(`/api/platforms/${p.id}/remove`, {}); route(); } } }, 'Delete'))) : h('div', { class: 'item fine' }, 'No tokens yet.')),
    h('form', { class: 'card', onsubmit: async (e) => { e.preventDefault(); const x = await act(e.submitter || e.target.querySelector('button'), out, () => api('/api/platforms', { kind: f.kind.value, name: f.name.value || f.kind.value, token: f.token.value, account_id: f.acct.value, base_url: f.base.value })); if (x) route(); } },
      h('h3', {}, 'Add a token'), h('label', { for: 'pkind' }, 'Type'), f.kind, h('label', { for: 'pname' }, 'Name'), f.name, h('label', { for: 'ptok' }, 'Token'), f.token, h('label', { for: 'pacct' }, 'Cloudflare account ID'), f.acct, h('label', { for: 'pbase' }, 'API base URL'), f.base,
      h('div', { style: 'margin-top:10px' }, h('button', { class: 'primary', type: 'submit', style: 'width:100%' }, 'Save token')), out));
}
async function projectsView(body) {
  const r = await api('/api/projects');
  body.append(h('p', { class: 'fine' }, 'Ask in chat: “build me a one-page site for …”. I write it in a project folder, build it, and publish it after your OK.'),
    h('h2', {}, 'Published on this server'), h('div', { class: 'list' }, r.sites.length ? r.sites.map(s => h('a', { class: 'item', href: s.url, target: '_blank', rel: 'noopener' }, s.name, h('span', { class: 'chev' }, '↗'))) : h('div', { class: 'item fine' }, 'None yet.')),
    h('h2', {}, 'Projects'), h('div', { class: 'list' }, r.projects.length ? r.projects.map(p => h('div', { class: 'item' }, p)) : h('div', { class: 'item fine' }, 'None yet.')),
    h('p', { class: 'fine' }, 'Android apps: optional. On the server run sudo bash /opt/myassistant/current/optional/install-android-sdk.sh (about 3 GB), then ask me to build an APK.'));
}
async function auditView(body) {
  const list = h('div', { class: 'list audit' }); body.append(list);
  let before = 0;
  const more = h('button', { class: 'small', onclick: () => load() }, 'Older');
  body.append(more);
  async function load() {
    const r = await api('/api/audit' + (before ? '?before=' + before : ''));
    for (const a of r.audit) { list.append(h('div', { class: 'item' }, h('b', {}, a.action), ' ', h('span', { class: 'pill' }, a.actor), h('span', { class: 'sub' }, fmt(a.ts) + (a.detail ? ' · ' + a.detail.slice(0, 220) : '')))); before = a.id; }
    if (r.audit.length < 100) more.remove();
  }
  load();
}

// ---------------- router ----------------
async function loadMe() { try { ME = await api('/api/me'); CSRF = ME.csrf; } catch { ME = null; } }
async function route() {
  clearTimeout(pollTimer);
  const hello = await fetch('/api/hello').then(r => r.json()).catch(() => ({}));
  if (hello.setup_needed) return $root.replaceChildren(setupView());
  if (!ME) { if (hello.logged_in) await loadMe(); if (!ME) return $root.replaceChildren(loginView()); }
  const [, top, sub] = (location.hash.split('?')[0] || '#/chat').split('/');
  const v = { chat: () => chatView(parseInt(sub, 10) || 0), chats: chatsView, approvals: approvalsView, servers: serversView, settings: () => settingsView(sub), more: () => moreView(sub) }[top] || chatView;
  $root.replaceChildren(v());
}
window.addEventListener('hashchange', route);
route();
