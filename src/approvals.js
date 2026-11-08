// The approval queue: anything that sends to others, deletes, spends, changes servers or publishes
// waits here until the owner says YES (web button, Telegram button, or "YES A12" by text/email/WhatsApp).
// Honest note: this is a rule in this program, not a wall the operating system enforces.
import { all, get, run, now, audit, setting, redact } from './db.js';
import { addMessage, deliver, notifyOwner, alsoAgent } from './notify.js';

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
  // the code only when he has to say which one (2.3.16); the web card keeps showing it
  const text = `Needs your OK (A${id}):\n${summary}\n\n` + (others ? `Reply YES A${id} or NO A${id}.` : 'Reply YES to approve, or NO.') + ` Expires in ${fmtExpiry(ttl)}.`;
  addMessage('approval', 'web', text, { approval: id }, ctx.jobId || null);
  const ch = ctx.channel && ctx.channel !== 'web' && ctx.channel !== 'system' ? ctx.channel : setting('notify_channel');
  if (ch && ch !== 'web') await deliver(ch, text, { approvalId: id, meta: ctx.meta });
  await alsoAgent(ch, text, { approvalId: id });   // same "YES A#" text reply as every other text channel; the web tap still works
  return id;
}

export async function decide(id, yes, via, viaMeta = null) {   // 2.3.16: viaMeta = his YES message's ids (WhatsApp/Telegram)
  expire();
  const a = get('SELECT * FROM approvals WHERE id=?', id);
  if (!a) return { ok: false, message: `There is no request A${id}.` };
  if (a.status === 'expired') return { ok: false, message: `That request (A${id}) expired, so nothing was done. Ask me again.` };   // 2.3.16
  if (a.status === 'superseded') return { ok: false, message: `A${id} was replaced by a newer request for the same thing, so nothing was done.` };
  if (a.status !== 'pending') return { ok: false, message: `A${id} is already ${a.status}.` };
  if (!yes) {
    run("UPDATE approvals SET status='denied', decided_at=?, decided_via=? WHERE id=?", now(), via, id);
    audit('owner', 'approval.denied', `A${id} via ${via}`);
    return { ok: true, message: `Cancelled A${id}. Nothing was done.` };
  }
  // Claim it first so two taps can never run it twice.
  const claim = run("UPDATE approvals SET status='running', decided_at=?, decided_via=? WHERE id=? AND status='pending'", now(), via, id);
  if (!claim.changes) return { ok: false, message: `A${id} is already being handled.` };
  audit('owner', 'approval.approved', `A${id} via ${via}`);
  const tool = toolsRef && toolsRef.byName(a.tool);
  let result, status = 'done', message;
  try {
    if (!tool) throw new Error('Unknown tool ' + a.tool);
    result = await tool.run(JSON.parse(a.args), { approved: true, approvalId: id, channel: a.channel });
    message = `Done A${id}: ${human(a.tool, JSON.parse(a.args), result)}`;
  } catch (e) {
    status = 'failed'; result = { error: e.message }; message = `A${id} failed: ${e.message}`;
  }
  run('UPDATE approvals SET status=?, result=? WHERE id=?', status, redact(JSON.stringify(result)).slice(0, 20000), id);
  audit('system', 'approval.' + status, `A${id} ${a.tool}: ${short(result)}`);
  addMessage('notice', 'web', message, { approval: id }, a.job_id);
  // 2.3.7: Reactions = Natural: the approved step is done, so his WhatsApp message gets ✅ (it had 👍). Never awaited.
  if (status === 'done' && a.channel === 'whatsapp_agent' && a.job_id) {
    let wamid = null; try { wamid = JSON.parse(get('SELECT meta FROM jobs WHERE id=?', a.job_id)?.meta || 'null')?.waa_wamid; } catch {}
    if (wamid) import('./channels/waagent.js').then(w => w.taskDone(wamid)).catch(() => {});
  }
  if (via === 'web' && a.channel && !['web', 'system'].includes(a.channel)) await deliver(a.channel, message);
  if (setting('continue_after_approval') === '1' && a.job_id && !get('SELECT parent_job FROM jobs WHERE id=?', a.job_id)?.parent_job) {
    const { startJob } = await import('./brain.js');
    startJob({ text: `[System note, not from the owner] The owner approved request A${id} (${a.tool}). Result: ${redact(JSON.stringify(result)).slice(0, 3000)}\nIf the original task has more steps, continue it now; otherwise just confirm briefly.`, channel: a.channel || 'web', hidden: true, parentApproval: id, chatId: (await import('./chats.js')).chatOfJob(a.job_id), meta: viaMeta && via === (a.channel || 'web') ? viaMeta : null });
  }
  return { ok: status === 'done', message, result };
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
