// Fake model for the 2.3.7 tests. "WORK" calls a real tool (project_list) and then answers "WORKED" (or, with
// "WORKSAY <text>", answers exactly <text>, a literal \n becomes a newline). "WORKREACT <emoji>" calls project_list
// and react together. "UNPUB <platform> <name> [action]" calls unpublish_site. Anything else: the 2.3.5 mock.
import mock235 from './mock-model-v235.js';
export default async function mock237(args) {
  const { items } = args;
  const last = items[items.length - 1];
  let u = null;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].role === 'user') { u = items[i]; break; }
  const t = String(u?.text || '');
  let m;
  if (last?.role === 'tool' && ['project_list', 'unpublish_site'].includes(last.name)) {
    if ((m = /WORKSAY ([\s\S]*)$/.exec(t))) return { text: m[1].replace(/\\n/g, '\n'), calls: [] };
    if (last.name === 'unpublish_site') return { text: 'UNPUB ' + JSON.stringify(last.result).slice(0, 400), calls: [] };
    return { text: 'WORKED', calls: [] };
  }
  if (last?.role === 'tool' && last.name === 'react' && /WORKREACT/.test(t)) return { text: 'WORKED', calls: [] };
  if (last?.role !== 'tool') {
    if ((m = /WORKREACT (\S+)/.exec(t))) return { text: '', calls: [{ id: 'l-0', name: 'react', args: { emoji: m[1] } }, { id: 'l-1', name: 'project_list', args: {} }] };
    if (/\bWORK(SAY)?\b/.test(t)) return { text: '', calls: [{ id: 'l-0', name: 'project_list', args: {} }] };
    if ((m = /UNPUB (\S+) (\S+)(?: (\S+))?/.exec(t))) return { text: '', calls: [{ id: 'l-0', name: 'unpublish_site', args: { platform: m[1], name: m[2], ...(m[3] ? { action: m[3] } : {}) } }] };
  }
  return mock235(args);
}
