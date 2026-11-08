// Fake model for the 2.3.16 tests. globalThis.__M2316.mode picks what it answers to a [System note] (the job that
// runs after his YES): 'leak' = the exact replies JSON Abish got on Nov 8, 'fence' = the same in a ```json block,
// 'broken' = cut-off JSON, 'thumb' = a lone 👍, '' = "Done.".
//   UNPUB <name> [ECHO|MIXED] → calls unpublish_site (needs his YES); then: ECHO = "Approval request A# is waiting…",
//                                MIXED = a real line + an "approval is waiting" line, plain = NO_REPLY
//   PASTE / PASTERAW / SHOWCODE  → a whole index.html pasted in the answer (fenced / unfenced / he asked for the code)
//   JSONSINGLE                    → one message answered in a fenced replies JSON
//   anything else                 → "ANSWER: " + his words
globalThis.__M2316 ||= { mode: '', calls: [] };
const PAGE = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<style>body{font-family:sans-serif;margin:0}h1{color:#123}</style>\n</head>\n<body>\n<h1>Hello</h1>\n<p>Welcome to SoftTech.</p>\n<script>console.log(1)</script>\n</body>\n</html>';
export const LEAK = '{"replies":[{"to":[3],"text":"Site is live at https://ai.louisb.vip/sites/soft-tech-private-7f9a3/"}]}';
export default async function mock2316({ items }) {
  const M = globalThis.__M2316;
  M.calls.push(items.length);
  const last = items[items.length - 1];
  const users = items.filter(i => i.role === 'user');
  const t = String(users[users.length - 1]?.text || '');
  if (last?.role === 'tool') {
    if (last.name === 'unpublish_site') {
      const code = last.result?.approval || 'A?';
      if (/ECHO/.test(t)) return { text: `Approval request ${code} is waiting for your confirmation. Reply YES ${code} to publish.`, calls: [] };
      if (/MIXED/.test(t)) return { text: `I made the page smaller.\nPublishing it needs your OK (${code}), just reply YES.`, calls: [] };
      return { text: 'NO_REPLY', calls: [] };
    }
    return { text: 'DONE', calls: [] };
  }
  if (t.startsWith('[System note')) {
    if (M.mode === 'leak') return { text: LEAK, calls: [] };
    if (M.mode === 'fence') return { text: '```json\n' + LEAK + '\n```', calls: [] };
    if (M.mode === 'broken') return { text: '{"replies":[{"to":[3],"text":"Site is live at https://ai.louisb.vip/sites/soft-tech-private-7f9a3/"', calls: [] };
    if (M.mode === 'thumb') return { text: '👍', calls: [] };
    return { text: 'Done.', calls: [] };
  }
  let m;
  if ((m = /UNPUB (\S+)/.exec(t))) return { text: '', calls: [{ id: 'u-0', name: 'unpublish_site', args: { platform: 'here', name: m[1] } }] };
  if (/PASTERAW/.test(t)) return { text: 'Here is the new page:\n' + PAGE + '\nIf that looks good, just say YES and I\'ll apply', calls: [] };
  if (/PASTE|SHOWCODE/.test(t)) return { text: 'Here is the new index.html:\n```html\n' + PAGE + '\n```\nIf that looks good, just say YES and I\'ll apply', calls: [] };
  if (/JSONSINGLE/.test(t)) return { text: '```json\n{"replies":[{"to":[1],"text":"Plain answer"}]}\n```', calls: [] };
  return { text: 'ANSWER: ' + t.replace(/\n/g, ' | '), calls: [] };
}
