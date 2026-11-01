// 2.3.6: video_make — a free video maker (ffmpeg only, no paid AI video). Pictures (project files, the last photo
// the owner sent, or ones image_generate made) become scenes with a gentle slow zoom, soft crossfades, optional words
// on each scene (Hebrew/Yiddish shaped right-to-left by libass) and optional music or voice. MP4 (H.264 + AAC,
// yuv420p, faststart), vertical 1080×1920 by default, kept under WhatsApp's 16 MB unless told otherwise.
// ffmpeg runs as the locked-down sandbox user inside the project folder (like run_command).
// The owner adds ffmpeg once with optional/install-video.sh.
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config.js';
import { get, audit } from '../db.js';
import { projectDir, inProject, safeName, runInSandbox } from './workspace.js';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const N = (description) => ({ type: 'number', description });
export const VIDEO_CMD = 'sudo bash /opt/myassistant/current/optional/install-video.sh';
export const NO_FFMPEG = `ffmpeg is not installed on this server yet, so I can't make videos. One-time setup (the owner runs this on the server): ${VIDEO_CMD}`;
const SIZES = { vertical: [1080, 1920], horizontal: [1920, 1080] };
const FPS = 30;
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff']);
const AUD_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.oga', '.flac', '.mp4', '.webm', '.amr', '.3gp']);

function executable(p) { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }
/** { ffmpeg, ffprobe } or null. */
export function findFfmpeg() {
  const env = process.env.MA_FFMPEG;
  if (env !== undefined) { if (!env || !executable(env)) return null; const probe = path.join(path.dirname(env), 'ffprobe'); return { ffmpeg: env, ffprobe: executable(probe) ? probe : null }; }
  for (const dir of ['/usr/bin', '/usr/local/bin', '/snap/bin']) {
    const f = path.join(dir, 'ffmpeg'), p = path.join(dir, 'ffprobe');
    if (executable(f)) return { ffmpeg: f, ffprobe: executable(p) ? p : null };
  }
  return null;
}

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const HEBREW = /[\u0590-\u05FF\uFB1D-\uFB4F]/;
// colour emoji cannot be drawn into the video text (they would show as empty boxes), so they are left out
const EMOJI = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}])/gu;
const HAS_EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const assTime = (t) => { t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60; return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`; };
function assColor(hex, alpha = 0) {          // #rrggbb → &HAABBGGRR
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')); const c = m ? m[1] : 'ffffff';
  return '&H' + alpha.toString(16).padStart(2, '0').toUpperCase() + (c.slice(4, 6) + c.slice(2, 4) + c.slice(0, 2)).toUpperCase();
}
/** One scene's words as an ASS subtitle file (libass shapes Hebrew/Yiddish right-to-left, with vowel points). */
export function assFor(text, { W, H, dur, position = 'bottom', color = '#ffffff' }) {
  const clean = String(text || '').replace(EMOJI, '').replace(/[{}]/g, (c) => c === '{' ? '(' : ')').replace(/\\/g, '/').replace(/\r?\n/g, '\\N').replace(/[ \t]+/g, ' ').trim();
  const font = HEBREW.test(clean) ? 'Noto Sans Hebrew' : 'Noto Sans';
  const size = Math.round(Math.min(W, H) * (clean.length > 60 ? 0.055 : clean.length > 28 ? 0.068 : 0.085));   // short words big, long ones smaller
  const align = position === 'top' ? 8 : position === 'center' ? 5 : 2;
  const mv = Math.round(H * (position === 'center' ? 0 : 0.11));
  const ml = Math.round(W * 0.08);
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n` +
    '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    // BorderStyle 3 = a soft dark box behind the words; Encoding -1 = pick right-to-left / left-to-right from the text itself
    `Style: Cap,${font},${size},${assColor(color)},&H000000FF,&H64000000,&H64000000,1,0,0,0,100,100,0,0,3,${Math.round(size * 0.32)},0,${align},${ml},${ml},${mv},-1\n\n` +
    '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  const fadeIn = Math.min(400, Math.round(dur * 150)), fadeOut = Math.min(300, Math.round(dur * 100));
  return { ass: head + `Dialogue: 0,${assTime(Math.min(0.25, dur / 6))},${assTime(dur - 0.05)},Cap,,0,0,0,,{\\fad(${fadeIn},${fadeOut})}${clean}\n`, dropped_emoji: HAS_EMOJI.test(String(text || '')) };
}

/** The ffmpeg command (as one shell line, run inside the project folder). Exported for tests. */
export function buildCommand({ ffmpeg, scenes, W, H, fade, audioIn, total, out, videoBitrate, maxrate, scaleDown, audioFadeOut }) {
  const args = [q(ffmpeg), '-hide_banner', '-loglevel', 'error', '-y'];
  const fc = [];
  scenes.forEach((s, i) => {
    const frames = Math.round(s.dur * FPS);
    if (s.file) {
      args.push('-i', q(s.file));
      const W2 = Math.round(W * 1.5 / 2) * 2, H2 = Math.round(H * 1.5 / 2) * 2;      // a bigger picture first, so the slow zoom is smooth
      const z = i % 2 === 0 ? `min(1+0.10*on/${frames},1.10)` : `max(1.10-0.10*on/${frames},1.0)`;   // in, out, in, …
      fc.push(`[${i}:v]scale=${W2}:${H2}:force_original_aspect_ratio=increase,crop=${W2}:${H2},setsar=1,zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}` +
        `${s.ass ? `,ass=${s.ass}` : ''},format=yuv420p,setsar=1,trim=duration=${s.dur.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    } else {
      args.push('-f', 'lavfi', '-t', s.dur.toFixed(3), '-i', q(`color=c=0x${s.color}:s=${W}x${H}:r=${FPS}`));
      fc.push(`[${i}:v]setsar=1${s.ass ? `,ass=${s.ass}` : ''},format=yuv420p,fps=${FPS},trim=duration=${s.dur.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    }
  });
  const ai = scenes.length;
  if (audioIn) args.push('-i', q(audioIn)); else args.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', q('anullsrc=r=44100:cl=stereo'));
  let last = 'v0', offset = 0;
  for (let i = 1; i < scenes.length; i++) {
    offset += scenes[i - 1].dur - fade;
    const o = i === scenes.length - 1 ? 'vx' : `x${i}`;
    fc.push(`[${last}][v${i}]xfade=transition=fade:duration=${fade.toFixed(3)}:offset=${offset.toFixed(3)}[${o}]`);
    last = o;
  }
  if (scenes.length === 1) { fc.push('[v0]null[vx]'); }
  fc.push(scaleDown ? `[vx]scale=${scaleDown[0]}:${scaleDown[1]},setsar=1[vout]` : '[vx]null[vout]');
  const fo = Math.min(audioFadeOut, total / 3);
  fc.push(`[${ai}:a]aresample=44100,aformat=channel_layouts=stereo,atrim=0:${total.toFixed(3)},apad=whole_dur=${total.toFixed(3)},afade=t=in:d=0.05,afade=t=out:st=${Math.max(0, total - fo).toFixed(3)}:d=${fo.toFixed(3)},asetpts=N/SR/TB[aout]`);
  args.push('-filter_complex', q(fc.join(';')), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    ...(videoBitrate ? ['-b:v', videoBitrate + 'k'] : ['-crf', '23']), '-maxrate', maxrate + 'k', '-bufsize', (maxrate * 2) + 'k',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-movflags', '+faststart', '-t', total.toFixed(3), q(out));
  return args.join(' ');
}

let assOk = null;
async function hasAss(ffmpeg, dir) {
  if (assOk === null) { const r = await runInSandbox(dir, `${q(ffmpeg)} -hide_banner -filters 2>&1`, { timeoutS: 30, maxOut: 60000 }); assOk = / ass +V->V/.test(r.output || ''); }
  return assOk;
}

async function probe(ffprobe, dir, rel) {
  if (!ffprobe) return null;
  const r = await runInSandbox(dir, `${q(ffprobe)} -v error -show_entries format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,pix_fmt -of json ${q(rel)}`, { timeoutS: 60 });
  try { return JSON.parse(r.output); } catch { return null; }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

function chatFile(files, spec, kind) {
  const s = String(spec || '').trim();
  const id = /^(?:file:)?([a-f0-9]{32})$/.exec(s) || /\/api\/files\/([a-f0-9]{32})/.exec(s);
  const row = id ? files.fileRow(id[1]) : null;
  if (!row) return null;
  if (kind && row.kind !== kind) throw new Error(`Chat file ${s} is not ${kind === 'image' ? 'a picture' : 'audio'}.`);
  return row;
}
function lastFromOwner(kind, chatId) {
  return get(`SELECT f.* FROM files f JOIN messages m ON m.id=f.message_id WHERE f.kind=? AND m.role='owner' AND m.chat_id=? ORDER BY f.created DESC LIMIT 1`, kind, chatId || 0)
    || get(`SELECT f.* FROM files f JOIN messages m ON m.id=f.message_id WHERE f.kind=? AND m.role='owner' ORDER BY f.created DESC LIMIT 1`, kind);
}

export const videoMake = {
  name: 'video_make',
  description: 'Make an MP4 video (free, no AI video service) from scenes: each scene is a picture (a project file, a chat picture id from image_generate, or the last photo the owner sent) or a plain colour, with optional words on it (Hebrew/Yiddish fine), shown for some seconds with a slow zoom; scenes crossfade. Optional music or voice (trimmed and faded to fit). Vertical 1080×1920 by default (horizontal 1920×1080 optional), kept under 16 MB for WhatsApp. Saves into the project, checks the result and shows you 2 frames; can send the video to the owner.',
  params: {
    project: S('Workspace project to save the video in (picture paths are inside it)'),
    scenes: { type: 'array', description: 'The scenes in order (1–30)', items: { type: 'object', properties: {
      image: S('Picture file inside the project, e.g. photos/1.jpg'),
      image_file_id: S('Id of a picture already in the chat (image_generate returns file_id)'),
      use_last_photo: { type: 'boolean', description: 'Use the last photo the owner sent' },
      color: S('Plain background colour instead of a picture, e.g. #1e3a5f'),
      text: S('Words to show on this scene (optional; emoji are left out)'),
      text_position: S('bottom (default), center or top', { enum: ['bottom', 'center', 'top'] }),
      duration: N('Seconds on screen (default 3.5, 1–20)'),
    } } },
    audio: S('Music or voice: a file inside the project (e.g. music/song.mp3) or the id of an audio file in the chat'),
    use_last_audio: { type: 'boolean', description: 'Use the last voice note / audio file the owner sent as the sound' },
    orientation: S('vertical (default, for phones/WhatsApp status) or horizontal', { enum: ['vertical', 'horizontal'] }),
    name: S('File name for the video (default video-<date>), saved as videos/<name>.mp4'),
    max_mb: N('Size limit in MB (default 15.5, under WhatsApp\'s 16 MB)'),
    send_to_owner: { type: 'boolean', description: 'Also send the finished video to the owner (send_file)' },
    caption: S('Text to go with the video when sending'),
  },
  required: ['project', 'scenes'],
  run: async (a = {}, ctx = {}) => {
    const ff = findFfmpeg();
    if (!ff) return { error: NO_FFMPEG, setup_command: VIDEO_CMD };
    const files = await import('../files.js');
    let scenesIn = a.scenes;
    if (typeof scenesIn === 'string') { try { scenesIn = JSON.parse(scenesIn); } catch { return { error: 'scenes must be a list of scenes.' }; } }
    if (!Array.isArray(scenesIn) || !scenesIn.length) return { error: 'Give at least one scene (a picture or a colour, with optional text).' };
    if (scenesIn.length > 30) return { error: 'At most 30 scenes in one video.' };
    const [W, H] = SIZES[a.orientation === 'horizontal' ? 'horizontal' : 'vertical'];
    const project = safeName(a.project, 'project');
    const dir = projectDir(project, true);
    const workRel = `.video-work-${stamp()}-${Math.random().toString(36).slice(2, 6)}`;
    const work = path.join(dir, workRel);
    fs.mkdirSync(work, { recursive: true, mode: 0o2770 });
    try { fs.chmodSync(work, 0o2770); } catch {}      // the sandbox user (same group) writes the render here
    const cleanup = async () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} if (fs.existsSync(work)) await runInSandbox(dir, `rm -rf ${q(workRel)}`, { timeoutS: 30 }); };
    try {
      const notes = [];
      const scenes = [];
      const canText = await hasAss(ff.ffmpeg, dir);
      if (!canText && scenesIn.some(s => s && s.text)) notes.push('this server\'s ffmpeg has no libass, so the words were left off (install-video.sh fixes it)');
      for (let i = 0; i < scenesIn.length; i++) {
        const s = scenesIn[i] || {};
        const dur = Math.max(1, Math.min(20, Number(s.duration) || 3.5));
        let src = null, ext = '.jpg';
        if (s.image) {
          const p = inProject(project, s.image);
          if (!fs.existsSync(p)) return { error: `Scene ${i + 1}: no file ${s.image} in project ${project} (file_list shows what is there).` };
          ext = path.extname(p).toLowerCase(); src = p;
        } else if (s.image_file_id) {
          const row = chatFile(files, s.image_file_id, 'image');
          if (!row) return { error: `Scene ${i + 1}: no picture with id ${s.image_file_id} in the chat.` };
          src = files.filePath(row); ext = path.extname(row.name).toLowerCase() || '.jpg';
        } else if (s.use_last_photo) {
          const row = lastFromOwner('image', ctx.chatId);
          if (!row) return { error: `Scene ${i + 1}: the owner has not sent a photo yet.` };
          src = files.filePath(row); ext = path.extname(row.name).toLowerCase() || '.jpg';
        }
        if (src && !IMG_EXT.has(ext)) return { error: `Scene ${i + 1}: ${path.basename(src)} is not a picture ffmpeg can use (jpg, png, webp…).` };
        const scene = { dur };
        if (src) { scene.file = `${workRel}/s${i}${ext}`; fs.copyFileSync(src, path.join(dir, scene.file)); }
        else { const m = /^#?([0-9a-f]{6})$/i.exec(String(s.color || '')); scene.color = m ? m[1].toLowerCase() : '1e2a3a'; }
        if (canText && s.text && String(s.text).trim()) {
          const { ass, dropped_emoji } = assFor(s.text, { W, H, dur, position: s.text_position });
          scene.ass = `${workRel}/s${i}.ass`; fs.writeFileSync(path.join(dir, scene.ass), ass);
          if (dropped_emoji) notes.push(`scene ${i + 1}: emoji were left out of the words on the video`);
        }
        scenes.push(scene);
      }
      const fade = scenes.length > 1 ? Math.min(0.7, Math.min(...scenes.map(s => s.dur)) / 3) : 0;
      const total = scenes.reduce((t, s) => t + s.dur, 0) - fade * (scenes.length - 1);
      if (total > 180) return { error: `That would be ${Math.round(total)} s; keep one video under 3 minutes.` };
      // sound
      let audioIn = null, audioName = null;
      if (a.audio || a.use_last_audio) {
        let src, ext;
        const row = a.audio ? chatFile(files, a.audio, 'audio') : lastFromOwner('audio', ctx.chatId);
        if (row) { src = files.filePath(row); ext = path.extname(row.name).toLowerCase() || '.m4a'; audioName = row.name; }
        else if (a.audio) {
          const p = inProject(project, a.audio);
          if (!fs.existsSync(p)) return { error: `No sound file ${a.audio} in project ${project}.` };
          src = p; ext = path.extname(p).toLowerCase(); audioName = a.audio;
        } else return { error: 'The owner has not sent a voice note or audio file yet.' };
        if (!AUD_EXT.has(ext)) return { error: `${audioName} is not a sound file ffmpeg can use (mp3, m4a, wav, ogg…).` };
        audioIn = `${workRel}/audio${ext}`; fs.copyFileSync(src, path.join(dir, audioIn));
      }
      // size: stay under the limit (WhatsApp takes videos up to 16 MB)
      const maxMb = Math.max(0.1, Math.min(200, Number(a.max_mb) || 15.5));
      const budgetK = Math.floor(maxMb * 1024 * 1024 * 8 * 0.94 / total / 1000) - 128;   // video kbit/s that fits
      if (budgetK < 150) return { error: `A ${Math.round(total)} s video cannot fit in ${maxMb} MB. Make it shorter or allow more MB.` };
      const scaleDown = budgetK < 700 ? (W > H ? [1280, 720] : [720, 1280]) : null;
      const base = (a.name ? String(a.name).replace(/\.mp4$/i, '') : 'video-' + stamp()).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 60) || 'video';
      const outRel = `videos/${base}.mp4`;
      fs.mkdirSync(path.join(dir, 'videos'), { recursive: true, mode: 0o2770 });
      const tmpOut = `${workRel}/out.mp4`;
      const enc = async (videoBitrate) => runInSandbox(dir, buildCommand({ ffmpeg: ff.ffmpeg, scenes, W, H, fade, audioIn, total, out: tmpOut, videoBitrate, maxrate: Math.min(8000, budgetK), scaleDown, audioFadeOut: audioIn ? 1.5 : 0.1 }), { timeoutS: 1200, maxOut: 4000 });
      const started = Date.now();
      let r = await enc(null);
      if (r.exit_code !== 0 || !fs.existsSync(path.join(dir, tmpOut))) return { error: 'ffmpeg could not make the video: ' + String(r.output || '').slice(-700) };
      let size = fs.statSync(path.join(dir, tmpOut)).size;
      if (size > maxMb * 1024 * 1024) {     // rare (busy pictures): once more at a fixed, lower bitrate
        r = await enc(Math.floor(budgetK * 0.85));
        if (r.exit_code !== 0) return { error: 'ffmpeg could not make the smaller video: ' + String(r.output || '').slice(-500) };
        size = fs.statSync(path.join(dir, tmpOut)).size;
        notes.push('made a second, lighter pass to fit the size limit');
      }
      fs.copyFileSync(path.join(dir, tmpOut), path.join(dir, outRel));
      // check it: duration, size, streams; and grab 2 frames to look at
      const info = await probe(ff.ffprobe, dir, outRel);
      const v = info?.streams?.find(s => s.codec_type === 'video'), au = info?.streams?.find(s => s.codec_type === 'audio');
      const dur = Number(info?.format?.duration) || total;
      const textAt = scenes.findIndex(s => s.ass);
      let startOf = 0; const starts = scenes.map(s => { const t = startOf; startOf += s.dur - fade; return t; });
      const t1 = textAt >= 0 ? starts[textAt] + scenes[textAt].dur * 0.6 : Math.min(dur * 0.25, 2);
      const t2 = scenes.length > 1 ? starts[Math.floor(scenes.length / 2)] + scenes[Math.floor(scenes.length / 2)].dur * 0.6 : dur * 0.75;
      const see = [];
      for (const [k, t] of [[1, t1], [2, t2]]) {
        const fr = `${workRel}/frame${k}.jpg`;
        await runInSandbox(dir, `${q(ff.ffmpeg)} -hide_banner -loglevel error -y -ss ${Math.max(0, Math.min(dur - 0.1, t)).toFixed(2)} -i ${q(outRel)} -frames:v 1 -vf scale=${W > H ? 960 : 540}:-2 -q:v 4 ${q(fr)}`, { timeoutS: 60 });
        if (fs.existsSync(path.join(dir, fr))) see.push({ kind: 'image', mime: 'image/jpeg', data: fs.readFileSync(path.join(dir, fr)).toString('base64'), name: `frame at ${t.toFixed(1)} s` });
      }
      const mb = (size / 1048576).toFixed(1);
      const out = { ok: true, saved: `${project}/${outRel}`, duration_s: Number(dur.toFixed(2)), size_mb: Number(mb), video: v ? `${v.codec_name} ${v.width}x${v.height} ${v.pix_fmt}` : 'h264', audio: au ? `${au.codec_name}${audioName ? ' (' + audioName + ')' : ' (silent)'}` : 'none',
        scenes: scenes.length, render_seconds: Math.round((Date.now() - started) / 1000), fits_whatsapp: size <= 16 * 1024 * 1024,
        look: see.length ? 'Two frames from the finished video are attached. Look at them: words readable and right-to-left where needed, nothing cut off, pictures not stretched. Fix and render again if something is wrong (at most twice), then send it.' : 'Could not grab frames to look at.' };
      if (notes.length) out.notes = notes;
      if (a.send_to_owner) {
        const { sendFile } = await import('./sendfile.js');
        const sent = await sendFile.run({ path: out.saved, caption: a.caption || '' }, ctx);
        out.sent_to_owner = sent.error ? 'not sent: ' + sent.error : (sent.whatsapp ? 'in the chat; WhatsApp: ' + sent.whatsapp : 'in the chat');
      }
      audit('assistant', 'tool.video_make', `${out.saved} · ${out.duration_s} s · ${mb} MB · ${scenes.length} scene(s)`);
      Object.defineProperty(out, '_see', { value: see, enumerable: false });
      return out;
    } catch (e) {
      return { error: 'Video failed: ' + e.message };
    } finally { await cleanup(); }
  },
};

export default [videoMake];
