// 2.3.6: site_screenshot (a hidden Chromium at phone size; the AI sees the picture) and video_make (ffmpeg only).
// The browser and ffmpeg tests run for real when they are on this machine and are skipped (with a reason) when not.
// The AI is a fake model; no real AI service, WhatsApp or the owner's server is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LOGS = [];
for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { LOGS.push(a.map(String).join(' ')); if (process.env.SHOW_LOGS) orig(...a); }; }
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-v236-'));
const DATA = T + '/data', WS = T + '/ws', SITES = T + '/sites';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = 21300 + Math.floor(Math.random() * 150);
Object.assign(process.env, {
  MA_DATA_DIR: DATA, MA_WORKSPACE: WS, MA_SITES_DIR: SITES, MA_SANDBOX_USER: '', MA_PORT: String(PORT),
  MA_PUBLIC_URL: 'http://127.0.0.1:' + PORT, MA_TEST_MODE: '1', MA_TICK_MS: '3600000', MA_RELEASE_BASE: 'http://127.0.0.1:1',
  MA_MOCK_MODULE: new URL('./mock-model-v236.js', import.meta.url).href, MA_WA_AGENT_BASE: 'http://127.0.0.1:1/agent/v1',
});
const { start } = await import('../src/server.js');
const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const tools = await import('../src/tools/index.js');
const brain = await import('../src/brain.js');
const files = await import('../src/files.js');
const notify = await import('../src/notify.js');
const { findChromium, BROWSER_CMD } = await import('../src/tools/sitecheck.js');
const { findFfmpeg, VIDEO_CMD, assFor } = await import('../src/tools/video.js');
const server = start();
await sleep(300);
db.setSetting('setup_done', '1'); db.setSecret('gemini_api_key', 'AIzaFAKE' + 'x'.repeat(30));
const BASE = 'http://127.0.0.1:' + PORT;
const S = auth.newSession('127.0.0.1', 'test');
const cookie = S.cookie.split(';')[0], csrf = S.csrf;
async function call(p, body) {
  const r = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-CSRF': csrf } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
}
async function waitJob(id, ms = 120000) { const end = Date.now() + ms; while (Date.now() < end) { const j = db.get('SELECT * FROM jobs WHERE id=?', id); if (['done', 'error'].includes(j.status)) return j; await sleep(50); } throw new Error('job did not finish'); }
async function ask(text) { const r = await call('/api/chat', { text }); assert.equal(r.status, 200, r.text); return waitJob(r.j.job); }
test.after(() => { server.close(); setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 200); });

const BROWSER = findChromium(), FF = findFfmpeg();
const noBrowser = BROWSER ? false : 'no Chromium on this machine (optional/install-browser.sh)';
const noFfmpeg = FF && FF.ffprobe ? false : 'no ffmpeg/ffprobe on this machine (optional/install-video.sh)';
const pngSize = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
const ctx = () => ({ jobId: null, chatId: null, channel: 'web', actor: 'assistant' });
function probe(file) {
  return JSON.parse(execFileSync(FF.ffprobe, ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height,pix_fmt', '-of', 'json', file]).toString());
}
function writeProject(name, rel, content) { const p = path.join(WS, name, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; }
// a small real PNG (solid colour, made with zlib) so tests need no picture files
import zlib from 'node:zlib';
function solidPng(w, h, [r, g, b]) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const PAGE = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>שלום</title>
<style>body{margin:0;font-family:sans-serif}.wide{width:700px;background:#fc9}.fine{font-size:9px}</style></head>
<body><h1>שלום! ברוכים הבאים</h1><div class="wide">too wide</div><p class="fine">tiny print here</p><img src="nope.png" width="50" height="50"></body></html>`;
const GOOD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Good</title></head><body style="margin:0;font:18px sans-serif"><h1>Fine page</h1><p>All good here.</p></body></html>`;

test('both tools are registered, on by default, and count as building work', () => {
  const names = tools.toolList().map(t => t.name);
  for (const n of ['site_screenshot', 'video_make']) { assert.ok(names.includes(n), n); assert.ok(brain.CODING_TOOLS.has(n), n + ' is a coding tool'); }
  const decl = tools.declarations().find(d => d.name === 'video_make');
  assert.equal(decl.parameters.properties.scenes.type, 'array');
  assert.deepEqual(decl.parameters.required, ['project', 'scenes']);
  assert.match(tools.declarations().find(d => d.name === 'site_screenshot').description, /phone size/);
});

test('system prompt: screenshot-and-fix (at most 2 rounds) and plan-render-check-video guidelines', () => {
  const p = brain.systemPrompt('web');
  assert.match(p, /after building or changing a site, take a phone-size site_screenshot/);
  assert.match(p, /At most 2 rounds of fixes/);
  assert.match(p, /plan the scenes first/);
  assert.match(p, /ffprobe and shows you 2 frames/);
});

test('settings hint lists all three optional one-time commands in plain words', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  for (const s of ['optional/install-android-sdk.sh', 'optional/install-browser.sh', 'optional/install-video.sh']) assert.ok(app.includes('sudo bash /opt/myassistant/current/' + s), s);
  for (const s of ['install-browser.sh', 'install-video.sh']) {
    const f = new URL('../optional/' + s, import.meta.url);
    assert.ok(fs.existsSync(f), s); const t = fs.readFileSync(f, 'utf8');
    assert.match(t, /fonts-noto-core/); assert.match(t, /fonts-noto-color-emoji/); assert.match(t, /df -BM/, s + ' checks free disk');
    assert.ok(fs.statSync(f).mode & 0o111, s + ' is executable');
  }
  assert.match(fs.readFileSync(new URL('../optional/install-browser.sh', import.meta.url), 'utf8'), /aarch64\|arm64/);
});

test('no browser: site_screenshot says so and names the one setup command', async () => {
  process.env.MA_CHROMIUM = '';
  try {
    writeProject('nb', 'index.html', GOOD);
    const r = await tools.execTool('site_screenshot', { project: 'nb' }, ctx());
    assert.match(r.error, /No browser on this server yet/);
    assert.ok(r.error.includes('sudo bash /opt/myassistant/current/optional/install-browser.sh'));
    assert.equal(r.setup_command, BROWSER_CMD);
  } finally { delete process.env.MA_CHROMIUM; }
});

test('no ffmpeg: video_make says so and names the one setup command', async () => {
  process.env.MA_FFMPEG = '';
  try {
    const r = await tools.execTool('video_make', { project: 'nv', scenes: [{ color: '#112233', text: 'hi' }] }, ctx());
    assert.match(r.error, /ffmpeg is not installed/);
    assert.ok(r.error.includes('sudo bash /opt/myassistant/current/optional/install-video.sh'));
    assert.equal(r.setup_command, VIDEO_CMD);
  } finally { delete process.env.MA_FFMPEG; }
});

test('brain: a tool picture reaches the model (Gemini parts, OpenAI user message); can\'t-see models get a note', () => {
  const pic = { kind: 'image', mime: 'image/jpeg', data: Buffer.from('fakejpeg').toString('base64'), name: 'phone screenshot of x' };
  const items = [{ role: 'user', text: 'check my site' }, { role: 'assistant', text: '', calls: [{ id: 'a', name: 'site_screenshot', args: {} }, { id: 'b', name: 'file_read', args: {} }] },
    { role: 'tool', id: 'a', name: 'site_screenshot', result: { ok: true }, media: [pic] }, { role: 'tool', id: 'b', name: 'file_read', result: { text: 'x' } }];
  const g = brain.toGeminiContents(items);
  assert.equal(g.length, 3);
  const parts = g[2].parts;
  assert.deepEqual(parts.map(p => Object.keys(p)[0]), ['functionResponse', 'functionResponse', 'inlineData', 'text'], 'answers first, then the picture');
  assert.equal(parts[2].inlineData.mimeType, 'image/jpeg');
  assert.ok(!JSON.stringify(g).includes('toolMedia'), 'internal marker is not sent');
  const gNo = brain.toGeminiContents(items, { images: false });
  assert.ok(!JSON.stringify(gNo).includes('inlineData'));
  assert.match(gNo[2].parts.at(-1).text, /cannot look at pictures/);
  const o = brain.toOpenAIMessages('sys', items);
  assert.deepEqual(o.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'tool', 'user']);
  assert.equal(o[5].content[0].type, 'image_url');
  assert.match(o[5].content[0].image_url.url, /^data:image\/jpeg;base64,/);
  assert.ok(!o[3].content.includes('fakejpeg'), 'the picture is not pasted into the tool text');
  // only the 2 latest tool results keep their pictures; older ones say so
  const many = [1, 2, 3].map(i => ({ role: 'tool', id: 't' + i, name: 'site_screenshot', result: { ok: true }, media: [pic] }));
  brain.keepRecentToolPictures(many);
  assert.deepEqual(many.map(x => !!x.media), [false, true, true]);
  assert.match(many[0].result.picture, /taken out/);
  assert.ok(brain.withoutToolPictures(items).every(x => !x.media));
});

test('site_screenshot: a project page at phone size — PNG saved, problems found, picture handed to the model', { skip: noBrowser, timeout: 90000 }, async () => {
  writeProject('demo', 'index.html', PAGE);
  const r = await tools.execTool('site_screenshot', { project: 'demo', desktop: true }, ctx());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.title, 'שלום');
  assert.equal(r.saved.length, 2);
  const phone = fs.readFileSync(path.join(WS, r.saved[0].file));
  assert.deepEqual(pngSize(phone), { w: 780, h: 1688 }, 'phone: 390×844 at 2×');
  assert.equal(pngSize(fs.readFileSync(path.join(WS, r.saved[1].file))).w, 1366, 'desktop size');
  const probs = r.problems_found.join('\n');
  assert.match(probs, /scrolls sideways/); assert.match(probs, /smaller than 12px/); assert.match(probs, /did not load: .*nope\.png/);
  assert.equal(r._see.length, 2); assert.equal(Buffer.from(r._see[0].data, 'base64').subarray(0, 2).toString('hex'), 'ffd8', 'a JPEG for the model');
  assert.ok(!JSON.stringify(r).includes(r._see[0].data.slice(0, 40)), 'the picture is not in the JSON result text');
  // a clean page has nothing to report
  writeProject('good', 'index.html', GOOD);
  const g = await tools.execTool('site_screenshot', { project: 'good', full_page: true }, ctx());
  assert.deepEqual(g.problems_found, ['none of the automatic checks found a problem']);
});

test('site_screenshot: published site by name; bad url and missing files give plain errors', { skip: noBrowser, timeout: 60000 }, async () => {
  fs.mkdirSync(path.join(SITES, 'shop'), { recursive: true }); fs.writeFileSync(path.join(SITES, 'shop', 'index.html'), GOOD);
  const r = await tools.execTool('site_screenshot', { site: 'shop' }, ctx());
  assert.equal(r.ok, true, JSON.stringify(r)); assert.match(r.saved[0].file, /^shop\/screenshots\/shop-phone-/);
  assert.match((await tools.execTool('site_screenshot', { url: 'file:///etc/passwd' }, ctx())).error, /Only http/);
  assert.match((await tools.execTool('site_screenshot', { site: 'nope' }, ctx())).error, /No published site/);
  assert.match((await tools.execTool('site_screenshot', { project: 'good', path: 'missing.html' }, ctx())).error, /No missing\.html/);
  assert.match((await tools.execTool('site_screenshot', {}, ctx())).error, /Say what to open/);
});

test('job: the model calls site_screenshot, SEES the picture on its next step, and the owner gets it in the chat', { skip: noBrowser, timeout: 90000 }, async () => {
  writeProject('shotjob', 'index.html', GOOD);
  globalThis.__v236Seen = null;
  const j = await ask('SHOT shotjob');
  assert.equal(j.status, 'done', j.result);
  assert.match(j.result, /^SAW 1 picture\(s\) from site_screenshot/);
  assert.equal(globalThis.__v236Seen.pics[0].mime, 'image/jpeg'); assert.equal(globalThis.__v236Seen.pics[0].head, 'ffd8ff');
  const sent = db.get("SELECT f.* FROM files f JOIN messages m ON m.id=f.message_id WHERE m.meta LIKE '%sent_file%' ORDER BY f.created DESC LIMIT 1");
  assert.equal(sent.kind, 'image'); assert.match(sent.name, /phone.*\.png$/);
  assert.match(globalThis.__v236Seen.result.sent_to_owner, /in the chat/);
});

test('video: 3 scenes (project picture, chat picture, colour) with Hebrew words and music → MP4 checked', { skip: noFfmpeg, timeout: 240000 }, async () => {
  writeProject('vid', 'photos/a.png', solidPng(640, 480, [30, 90, 200]));
  const up = files.saveUpload(solidPng(400, 600, [200, 60, 40]), 'image/png', 'gen.png', null);
  execFileSync(FF.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', '-b:a', '96k', path.join(WS, 'vid', 'song.mp3')]);
  const r = await tools.execTool('video_make', { project: 'vid', name: 'Test Clip', audio: 'song.mp3', scenes: [
    { image: 'photos/a.png', text: 'שבת שלום! אַ גוטן שבת', duration: 3 },
    { image_file_id: up.id, text: 'Hello 🎉 world', duration: 2.5, text_position: 'top' },
    { color: '#1e3a5f', text: 'סוף', duration: 2 }] }, ctx());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.saved, 'vid/videos/test-clip.mp4');
  const f = path.join(WS, r.saved);
  const p = probe(f);
  const v = p.streams.find(s => s.codec_type === 'video'), a = p.streams.find(s => s.codec_type === 'audio');
  assert.deepEqual([v.codec_name, v.width, v.height, v.pix_fmt], ['h264', 1080, 1920, 'yuv420p']);
  assert.equal(a.codec_name, 'aac');
  const fade = Math.min(0.7, 2 / 3), want = 3 + 2.5 + 2 - 2 * fade;
  assert.ok(Math.abs(Number(p.format.duration) - want) < 0.2, `duration ${p.format.duration} ≈ ${want}`);
  assert.ok(fs.statSync(f).size < 16 * 1024 * 1024); assert.equal(r.fits_whatsapp, true);
  const head = fs.readFileSync(f).subarray(0, 64 * 1024).toString('latin1');
  assert.ok(head.indexOf('moov') > 0 && (head.indexOf('mdat') < 0 || head.indexOf('moov') < head.indexOf('mdat')), 'faststart: moov before the video data');
  assert.equal(r._see.length, 2, 'two frames for the model to look at');
  assert.deepEqual(r.notes, ['scene 2: emoji were left out of the words on the video']);
  assert.deepEqual(fs.readdirSync(path.join(WS, 'vid')).filter(n => n.startsWith('.video-work')), [], 'temporary files cleaned up');
});

test('video: horizontal, last photo + last voice note from the owner, sent to him; plain errors', { skip: noFfmpeg, timeout: 240000 }, async () => {
  const chat = (await import('../src/chats.js')).mainChatId();
  const msg = notify.addMessage('owner', 'web', 'here', null, null, chat);
  const ph = files.saveUpload(solidPng(800, 600, [20, 160, 90]), 'image/png', 'me.png', chat);
  const wav = path.join(T, 'v.wav'); execFileSync(FF.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=2', wav]);
  const au = files.saveUpload(fs.readFileSync(wav), 'audio/wav', 'voice.wav', chat);
  files.claimFiles([ph.id, au.id], msg, chat);
  const r = await tools.execTool('video_make', { project: 'vid2', orientation: 'horizontal', use_last_audio: true, send_to_owner: true, scenes: [{ use_last_photo: true, text: 'ברוך הבא', duration: 3 }] }, { chatId: chat, channel: 'web' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const v = probe(path.join(WS, r.saved)).streams.find(s => s.codec_type === 'video');
  assert.deepEqual([v.width, v.height], [1920, 1080]);
  assert.match(r.audio, /voice\.wav/);
  assert.match(r.sent_to_owner, /in the chat/);
  assert.match((await tools.execTool('video_make', { project: 'vid2', scenes: [{ image: 'nope.jpg' }] }, ctx())).error, /no file nope\.jpg/);
  assert.match((await tools.execTool('video_make', { project: 'vid2', scenes: [] }, ctx())).error, /at least one scene/);
  assert.match((await tools.execTool('video_make', { project: 'vid2', max_mb: 0.1, scenes: [{ color: '#000000', duration: 10 }] }, ctx())).error, /cannot fit/);
});

test('video: a tight size limit lowers the resolution and stays under it', { skip: noFfmpeg, timeout: 240000 }, async () => {
  const r = await tools.execTool('video_make', { project: 'vid3', max_mb: 1, scenes: [{ color: '#334455', text: 'שלום', duration: 6 }, { color: '#aa3300', text: 'עולם', duration: 6 }] }, ctx());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.size_mb <= 1, 'size ' + r.size_mb);
  assert.match(r.video, /720x1280/);
});

test('video text: Hebrew picks the Hebrew font and right-to-left detection; emoji are left out', () => {
  const he = assFor('שלום עולם 🎉', { W: 1080, H: 1920, dur: 3 });
  assert.match(he.ass, /Style: Cap,Noto Sans Hebrew,/); assert.match(he.ass, /,-1\n/, 'Encoding -1: direction from the text');
  assert.ok(!he.ass.includes('🎉')); assert.equal(he.dropped_emoji, true);
  const en = assFor('Hello {there}\nline 2', { W: 1920, H: 1080, dur: 3, position: 'top' });
  assert.match(en.ass, /Style: Cap,Noto Sans,/); assert.match(en.ass, /Hello \(there\)\\Nline 2/); assert.equal(en.dropped_emoji, false);
});
