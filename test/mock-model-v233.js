// Fake model for the 2.3.3 reaction tests. "REACT <emoji>" makes it call react (on the message being answered),
// "REACTREF <id> <emoji>" on a given message id, "REACTNONE" with an empty emoji (remove). After a tool it reports
// the tool's answer; otherwise it echoes the text.
export default async function mock233({ items }) {
  const last = items[items.length - 1];
  if (last?.role === 'tool') return { text: 'TOOL ' + last.name + ' ' + JSON.stringify(last.result).slice(0, 600), calls: [] };
  let u = null;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].role === 'user') { u = items[i]; break; }
  const t = String(u?.text || '');
  let m;
  if ((m = /REACTREF (\S+) (\S+)/.exec(t))) return { text: '', calls: [{ id: 'local-0', name: 'react', args: { emoji: m[2], message_id: m[1] } }] };
  if (/REACTNONE/.test(t)) return { text: '', calls: [{ id: 'local-0', name: 'react', args: { emoji: '' } }] };
  if ((m = /REACT (\S+)/.exec(t))) return { text: '', calls: [{ id: 'local-0', name: 'react', args: { emoji: m[1] } }] };
  return { text: 'ECHO ' + t.slice(0, 500), calls: [] };
}
