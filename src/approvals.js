// The approval queue: anything that sends to others, deletes, spends, changes servers or publishes
// waits here until the owner says YES (web button, Telegram button, or "YES A12" by text/email/WhatsApp).
// Honest note: this is a rule in this program, not a wall the operating system enforces.
import { all, get, run, now, audit, setting, redact } from './db.js';
import { addMessage, deliver, notifyOwner, alsoAgent } from './notify.js';
import { NO_REPLY as NO_REPLY_WORD } from './emoji.js';

let toolsRef = null;
export function bindTools(t) { toolsRef = t; }

// 2.3.16 (Abish, Nov 8: "remove the reply yes A3 when I reply when I have only one project its for that"):
// requests expire after 30 minutes (Settings key approval_expiry_min), a new request for the same thing replaces the
// older one, the message shows the code only when more than one is waiting, and a bare YES/NO goes to the newest
// request unless two or more different ones were asked for in the last few minutes (then it asks which).
export const EXPIRY_MIN_DEFAULT = 30;
export const FRESH_MS = 10 * 60 * 1000;
export function expiryMs() {
  const n = parseInt(setting('approval_expiry_min') || '', 10);
  return (n >= 1 && n <= 24 * 60 ? n : EXPIRY_MIN_DEFAULT) * 60 * 1000;
}
const fmtExpiry = (ms) => ms % 3600000 === 0 ? (ms / 3600000) + ' h' : Math.round(ms / 60000) + ' min';
/** What a request is about, for "the same thing again" (same tool + same target). */
const TARGET_KEYS = ['platform', 'name', 'site', 'project', 'repo', 'server', 'host', 'to', 'path', 'chat', 'number', 'id'];
export function targetOf(tool, args) {
  let a = {}; try { a = typeof args === 'string' ? JSON.parse(args) : (args || {}); } catch {}
  const keys = TARGET_KEYS.filter(k => a[k] !== undefined && a[k] !== null && a[k] !== '');
  const pick = keys.length ? Object.fromEntries(keys.map(k => [k, String(a[k]).trim().toLowerCase()])) : a;
  return tool + ' ' + JSON.stringify(pick);
}

export function parseDecision(text) {
  const m = /^\s*(yes|y|approve|approved|ok|okay|no|n|deny|denied|cancel|reject)\b[\s,:#-]*a?\s*#?(\d+)?\s*[.!]*\s*$/i.exec(String(text || '').split(/\r?\n/)[0]);
  if (!m) return null;
  const yes = /^(yes|y|approve|approved|ok|okay)$/i.test(m[1]);
  let id = m[2] ? parseInt(m[2], 10) : null;
  if (id === null) {
    const p = pending();
    if (!p.length) {
      // a plain YES/NO for a request that just ran out → say so (not for "ok", which is usually just "ok")
      if (/^(yes|y|approve|approved|no|n|deny|denied|cancel|reject)$/i.test(m[1])) {
        const ex = get("SELECT id FROM approvals WHERE status='expired' AND decided_at > ? ORDER BY id DESC LIMIT 1", now() - 2 * 3600 * 1000);
        if (ex) return { yes, id: ex.id };      // decide() answers "that request expired — ask again"
      }
      return null;
    }
    const newest = p[p.length - 1];
    const fresh = p.filter(a => a.created > now() - FRESH_MS);
    if (fresh.length >= 2) {
      // two or more different requests are really open: ask which one (nothing is decided)
      return { ask: 'Which one? ' + fresh.map(a => `Reply ${yes ? 'YES' : 'NO'} A${a.id} for: ${String(a.summary || a.tool).split('\n')[0].slice(0, 80)}`).join(' · ') };
    }
    id = newest.id;
  }
  return { yes, id };
}
export function pending() { expire(); return all("SELECT * FROM approvals WHERE status='pending' ORDER BY id"); }
export function expire() {
  // 2.3.16: also requests older than the expiry time (Settings), so the old 24-hour ones don't pile up
  const rows = all("SELECT id FROM approvals WHERE status='pending' AND (expires < ? OR created < ?)", now(), now() - expiryMs());
  for (const r of rows) { run("UPDATE approvals SET status='expired', decided_at=? WHERE id=?", now(), r.id); audit('system', 'approval.expired', 'A' + r.id); }
  return rows.length;
}

export async function request(tool, args, summary, ctx = {}) {
  expire();
  // 2.3.16: a new request for the same thing (same tool + same target) replaces the older one(s)
  const target = targetOf(tool, args);
  for (const old of all("SELECT id,tool,args FROM approvals WHERE status='pending' AND tool=?", tool)) {
    if (targetOf(old.tool, old.args) !== target) continue;
    run("UPDATE approvals SET status='superseded', decided_at=? WHERE id=? AND status='pending'", now(), old.id);
    audit('system', 'approval.superseded', `A${old.id} (replaced by a new request for the same thing)`);
  }
  const ttl = expiryMs();
  const r = run('INSERT INTO approvals(tool,args,summary,status,created,expires,job_id,channel) VALUES(?,?,?,?,?,?,?,?)',
    tool, JSON.stringify(args), redact(summary), 'pending', now(), now() + ttl, ctx.jobId || null, ctx.channel || 'web');
  const id = Number(r.lastInsertRowid);
  audit(ctx.actor || 'assistant', 'approval.requested', `A${id} ${tool}: ${summary.split('\n')[0]}`);
  const others = all("SELECT id FROM approvals WHERE status='pending' AND id<>?", id).length;
  // the code only when he has to say which one (2.3.16; 2.3.17: not in the title either)
  const text = (others ? `Needs your OK (A${id}):` : 'Needs your OK:') + `\n${summary}\n\n` + (others ? `Reply YES A${id} or NO A${id}.` : 'Reply YES to approve, or NO.') + ` Expires in ${fmtExpiry(ttl)}.`;
  addMessage('approval', 'web', text, { approval: id }, ctx.jobId || null);
  const ch = ctx.channel && ctx.channel !== 'web' && ctx.channel !== 'system' ? ctx.channel : setting('notify_channel');
  if (ch && ch !== 'web') await deliver(ch, text, { approvalId: id, meta: ctx.meta });
  await alsoAgent(ch, text, { approvalId: id });   // same "YES A#" text reply as every other text channel; the web tap still works
  return id;
}

// 2.3.17 (Abish, Nov 8 1:23 AM: "Done A4: published at …" and then "Site published: …"): after his YES he gets ONE
// short message ("Published: <link>", with a phone picture of the page when it is a site). The code (A4) is shown only
// when other requests are still waiting, so it matters which one it was.
export function codeNeeded(id) { return all("SELECT id FROM approvals WHERE status='pending' AND id<>?", id).length > 0; }
export async function decide(id, yes, via, viaMeta = null) {   // 2.3.16: viaMeta = his YES message's ids (WhatsApp/Telegram)
  expire();
  const a = get('SELECT * FROM approvals WHERE id=?', id);
  const tag = codeNeeded(id) ? ` (A${id})` : '';
  if (!a) return { ok: false, message: `There is no request A${id}.` };
  if (a.status === 'expired') return { ok: false, message: `That request${tag} expired, so nothing was done. Ask me again.` };   // 2.3.16
  if (a.status === 'superseded') return { ok: false, message: `That request${tag} was replaced by a newer one for the same thing, so nothing was done.` };
  if (a.status !== 'pending') return { ok: false, message: `That request${tag} is already ${a.status}.` };
  if (!yes) {
    run("UPDATE approvals SET status='denied', decided_at=?, decided_via=? WHERE id=?", now(), via, id);
    audit('owner', 'approval.denied', `A${id} via ${via}`);
    return { ok: true, message: `Cancelled${tag}. Nothing was done.` };
  }
  // Claim it first so two taps can never run it twice.
  const claim = run("UPDATE approvals SET status='running', decided_at=?, decided_via=? WHERE id=? AND status='pending'", now(), via, id);
  if (!claim.changes) return { ok: false, message: `That request${tag} is already being handled.` };
  audit('owner', 'approval.approved', `A${id} via ${via}`);
  const tool = toolsRef && toolsRef.byName(a.tool);
  let result, status = 'done', message;
  try {
    if (!tool) throw new Error('Unknown tool ' + a.tool);
    result = await tool.run(JSON.parse(a.args), { approved: true, approvalId: id, channel: a.channel });
    message = doneMessage(a.tool, JSON.parse(a.args), result, tag);
  } catch (e) {
    status = 'failed'; result = { error: e.message }; message = `That didn't work${tag}: ${e.message}`;
  }
  run('UPDATE approvals SET status=?, result=? WHERE id=?', status, redact(JSON.stringify(result)).slice(0, 20000), id);
  audit('system', 'approval.' + status, `A${id} ${a.tool}: ${short(result)}`);
  // 2.3.17: a published site → one phone picture of the page with the message as its caption (when a browser is
  // installed). On WhatsApp that picture IS the one message, so nothing else is sent for it.
  const chatId = a.job_id ? (await import('./chats.js')).chatOfJob(a.job_id) : null;
  let shot = null;
  if (status === 'done' && a.tool === 'publish_site' && result && result.url) shot = await livePicture(JSON.parse(a.args), message, { jobId: a.job_id, channel: a.channel, chatId });
  if (!shot) addMessage('notice', 'web', message, { approval: id }, a.job_id);
  // 2.3.7: Reactions = Natural: the approved step is done, so his WhatsApp message gets ✅ (it had 👍). Never awaited.
  if (status === 'done' && a.channel === 'whatsapp_agent' && a.job_id) {
    let wamid = null; try { wamid = JSON.parse(get('SELECT meta FROM jobs WHERE id=?', a.job_id)?.meta || 'null')?.waa_wamid; } catch {}
    if (wamid) import('./channels/waagent.js').then(w => w.taskDone(wamid)).catch(() => {});
  }
  const delivered = !!(shot && shot.whatsapp && a.channel === 'whatsapp_agent');   // the picture + caption already went
  if (via === 'web' && a.channel && !['web', 'system'].includes(a.channel) && !delivered) await deliver(a.channel, message);
  if (setting('continue_after_approval') === '1' && a.job_id && !get('SELECT parent_job FROM jobs WHERE id=?', a.job_id)?.parent_job) {
    const { startJob } = await import('./brain.js');
    startJob({ text: followUpNote(id, a.tool, result, message, !!shot), channel: a.channel || 'web', hidden: true, parentApproval: id, chatId, meta: viaMeta && via === (a.channel || 'web') ? viaMeta : null });
  }
  return { ok: status === 'done', message, result, delivered, picture: !!shot };
}

/** 2.3.17: what the job after his YES is told. He already has the result, so it must not say it again. */
export function followUpNote(id, tool, result, told, picture = false) {
  return `[System note, not from the owner] The owner approved request A${id} (${tool}) and it ran. Result: ${redact(JSON.stringify(result)).slice(0, 3000)}\n` +
    `He has ALREADY been told the result in this exact message${picture ? ' (with a phone picture of the page)' : ''}: "${told}". ` +
    `Do NOT repeat, restate or confirm it (no "Site published", "It's live", "Done", no link again) and never mention the request code. ` +
    `If his original request has steps that are still not done (for example he asked for a logo or a design and that is not made yet), do them now and then tell him briefly what you did. Otherwise answer exactly ${NO_REPLY_WORD}.`;
}

/** 2.3.17: the one short message after his YES, e.g. "Published: https://…/sites/x/". tag = " (A4)" only when needed. */
export function doneMessage(tool, args, r, tag = '') {
  const h = human(tool, args, r);
  if (tool === 'publish_site' && r && r.url) return `Published${tag}: ${r.url}`;
  return `Done${tag}: ${h}`;
}

/** 2.3.17: a phone picture of the just-published site, sent with the message as caption. null = no browser / failed. */
export async function livePicture(args, caption, ctx) {
  try {
    const sc = await import('./tools/sitecheck.js');
    if (!sc.findChromium()) return null;
    const r = await sc.siteScreenshot.run({ site: args.name, send_to_owner: true, caption }, ctx);
    if (!r || r.error || !r.sent_to_owner || /^not sent/.test(r.sent_to_owner)) return null;
    return { whatsapp: /WhatsApp: sent/.test(r.sent_to_owner) };
  } catch { return null; }
}

function human(tool, args, r) {
  try {
    if (tool === 'gmail_send') return `email sent to ${args.to}.`;
    if (tool === 'calendar_create') return `event "${args.title}" added${r.link ? ': ' + r.link : '.'}`;
    if (tool === 'ssh_run') return `ran on ${args.server} (exit ${r.exit_code}${r.timed_out ? ', timed out' : ''}).${r.output ? '\n' + String(r.output).trim().slice(-600) : ''}`;
    if (tool === 'publish_site') return `published at ${r.url}`;
    if (tool === 'github_publish') return `pushed to ${r.repo}${r.pages ? ' — site: ' + r.pages : ''}`;
    if (tool === 'cloudflare_pages_publish') return `deployed to ${r.url}`;
    if (tool === 'unpublish_site' && r && r.message) return r.message;   // 2.3.7
    if (tool === 'sms_send') return `text queued to ${args.to}.`;
    if (tool === 'whatsapp_send') return `WhatsApp sent to ${args.to}.`;
    if (tool === 'platform_request') return `${args.method} ${args.path} → HTTP ${r.status}`;
  } catch {}
  return short(r);
}
function short(r) {
  if (!r) return 'ok';
  if (r.error) return r.error;
  const s = JSON.stringify(r);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}
