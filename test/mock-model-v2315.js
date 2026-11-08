// Fake model for the 2.3.15 tests (reactions + several quick messages → one answer). Every call is recorded in
// globalThis.__M2315 (the items it was given), so a test can see exactly what the model saw.
//   THANKS        → react ❤️, then NO_REPLY (a reaction is the whole answer)
//   SILENT        → NO_REPLY with no reaction (the server puts 👍 on his message)
//   HEART         → the reply is just "❤️" (goes on his message as a reaction)
//   JOB           → react 👍 + project_list together, then "JOB DONE" (react first, then answer)
//   REACTFIRST    → react 👍 on [#1] (message: 1), then "ANSWER: …"
//   SLOW <ms>     → waits <ms>, answers "DRAFT"; when called again after "[Your replies above were NOT sent" → "MERGED: <lines>"
//                   (or, when the new message is a separate question "…?" → the replies JSON: keep #1 + its own reply)
//   SLOWTOOL <ms> → waits <ms>, calls project_list; after it: "FOLDED: <lines>" if a "while you were working" note came in
//   several messages with a "?" among them → the replies JSON, deciding like the real model is told to:
//                   a "…?" line = its own reply; "make it/I mean/also/actually …" = merged into the reply before it;
//                   "thanks"/"ok" = react ❤️ only
//   anything else → "ANSWER: " + his current input (one line per message)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
globalThis.__M2315 ||= [];
const lines = (t) => String(t).split('\n').filter(l => /^\[#\d+\]/.test(l)).map(l => l.trim());

const CLOSER = /^(thanks|thank you|ok|okay|great|cool)\b/i;
const ADDS = /^(make it|i mean|also|actually|and make|no,|sorry,)/i;
/** The replies JSON for [#n] lines (only when a "?" question is among them). */
function decide(ls) {
  const msgs = ls.map(l => { const m = /^\[#(\d+)\]\s*(.*)$/.exec(l); return { n: +m[1], t: m[2] }; });
  if (!msgs.some(x => /\?/.test(x.t))) return null;
  const out = [];
  for (const x of msgs) {
    if (CLOSER.test(x.t)) { out.push({ to: [x.n], react: '❤️' }); continue; }
    const prev = [...out].reverse().find(o => o.text);
    if (ADDS.test(x.t) && prev) { prev.to.push(x.n); prev.text += ' + ' + x.t; continue; }
    out.push({ to: [x.n], text: 'ANSWER to #' + x.n + ': ' + x.t });
  }
  return JSON.stringify({ replies: out });
}
export default async function mock2315(args) {
  const { items } = args;
  globalThis.__M2315.push(JSON.parse(JSON.stringify(items.map(i => ({ role: i.role, text: i.text, name: i.name, calls: i.calls?.map(c => c.name) })))));
  const last = items[items.length - 1];
  const users = items.filter(i => i.role === 'user');
  const u = users[users.length - 1];
  const t = String(u?.text || '');
  const all = items.map(i => String(i.text || '')).join('\n');
  let m;
  if (/\[Your replies above were NOT sent/.test(t)) {
    const sl = /SLOW (\d+)/.exec(all); if (sl && +sl[1] < 2000) await sleep(+sl[1]);
    const add = lines(t);                                     // the new message(s)
    if (add.length && add.every(l => /\?/.test(l)) && !add.some(l => ADDS.test(l.replace(/^\[#\d+\]\s*/, '')))) {
      const prevN = +/^\[#(\d+)\]/.exec(add[0])[1] - 1;
      const keep = Array.from({ length: prevN }, (_, i) => ({ to: [i + 1], keep: true }));
      return { text: JSON.stringify({ replies: [...keep, ...add.map(l => { const k = +/^\[#(\d+)\]/.exec(l)[1]; return { to: [k], text: 'ANSWER to #' + k + ': ' + l.replace(/^\[#\d+\]\s*/, '') }; })] }), calls: [] };
    }
    if (/JSONFIX/.test(all)) return { text: JSON.stringify({ replies: [{ to: [1, 2], text: 'REWRITTEN: ' + lines(all).join(' | ') }] }), calls: [] };
    return { text: 'MERGED: ' + lines(all).join(' | '), calls: [] };
  }
  if (/while you were working/.test(t)) return { text: 'FOLDED: ' + lines(all).join(' | '), calls: [] };
  if (/LONGJOB/.test(t)) {
    const n = items.filter(i => i.role === 'tool').length;
    if (n === 0) return { text: 'Looking into it now…', calls: [{ id: 'L-0', name: 'project_list', args: {} }] };
    if (n === 1) return { text: 'Still going, one more check', calls: [{ id: 'L-1', name: 'project_list', args: {} }] };
    return { text: 'LONG DONE', calls: [] };
  }
  if (last?.role === 'tool') {
    if (last.name === 'react' && /THANKS/.test(t)) return { text: 'NO_REPLY', calls: [] };
    if (last.name === 'react' && /REACTFIRST/.test(t)) return { text: 'ANSWER: ' + (lines(t).join(' | ') || t), calls: [] };
    if (last.name === 'project_list' && /SLOWTOOL/.test(t)) return { text: 'NOFOLD', calls: [] };
    if (last.name === 'project_list') return { text: 'JOB DONE', calls: [] };
    return { text: 'TOOL ' + last.name + ' ' + JSON.stringify(last.result), calls: [] };
  }
  if ((m = /SLOWTOOL (\d+)/.exec(t))) { await sleep(+m[1]); return { text: '', calls: [{ id: 's-0', name: 'project_list', args: {} }] }; }
  if ((m = /SLOW (\d+)/.exec(t))) { await sleep(+m[1]); return { text: 'DRAFT', calls: [] }; }
  if (/THANKS/.test(t)) return { text: '', calls: [{ id: 't-0', name: 'react', args: { emoji: '❤️' } }] };
  if (/SILENT/.test(t)) return { text: 'NO_REPLY', calls: [] };
  if (/HEART/.test(t)) return { text: '❤️', calls: [] };
  if (/REACTFIRST/.test(t)) return { text: '', calls: [{ id: 'r-0', name: 'react', args: { emoji: '👍', message: 1 } }] };
  if (/\bJOB\b/.test(t)) return { text: '', calls: [{ id: 'j-0', name: 'react', args: { emoji: '👍' } }, { id: 'j-1', name: 'project_list', args: {} }] };
  if (/^\[He sent \d+ messages in a row/.test(t)) { const d = decide(lines(t)); if (d) return { text: d, calls: [] }; }
  if ((m = /SLOWQ (\d+)/.exec(t))) { await sleep(+m[1]); return { text: 'DRAFT ANSWER 1', calls: [] }; }
  return { text: 'ANSWER: ' + (lines(t).length ? lines(t).join(' | ') : t), calls: [] };
}
