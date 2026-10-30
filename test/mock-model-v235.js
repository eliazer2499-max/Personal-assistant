// Fake model for the 2.3.5 tests. "SAY <text>" answers exactly <text> (a literal \n becomes a newline), to imitate
// the AI typing "✅" into its reply. Anything else: the 2.3.3 mock (REACT / REACTREF / echo).
import mock233 from './mock-model-v233.js';
export default async function mock235(args) {
  const { items } = args;
  const last = items[items.length - 1];
  if (last?.role !== 'tool') {
    let u = null;
    for (let i = items.length - 1; i >= 0; i--) if (items[i].role === 'user') { u = items[i]; break; }
    const t = String(u?.text || '');
    if (/HISTCHECK/.test(t)) return { text: 'HIST ' + JSON.stringify(items.filter(x => x.role === 'assistant' && /Old reminder/.test(x.text || '')).map(x => x.text)), calls: [] };
    const m = /SAY ([\s\S]*)$/.exec(t);
    if (m) return { text: m[1].replace(/\\n/g, '\n'), calls: [] };
  }
  return mock233(args);
}
