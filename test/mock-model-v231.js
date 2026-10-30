// Fake model for the 2.3.1 send_file / files tests. "SENDFILE <path> [TO chat|whatsapp]" makes it call send_file;
// after a tool it reports the tool's answer; otherwise it echoes what it got (media kinds + the text it was given).
export default async function mock231({ items }) {
  const last = items[items.length - 1];
  if (last?.role === 'tool') return { text: 'TOOL ' + last.name + ' ' + JSON.stringify(last.result).slice(0, 800), calls: [] };
  let u = null;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].role === 'user') { u = items[i]; break; }
  const m = /SENDFILE (\S+)(?: TO (\w+))?/.exec(u?.text || '');
  if (m) return { text: '', calls: [{ id: 'local-0', name: 'send_file', args: { path: m[1], caption: 'here it is', ...(m[2] ? { to: m[2] } : {}) } }] };
  const kinds = (u?.media || []).map(x => x.kind);
  return { text: `GOT[${kinds.join(',')}] ${String(u?.text || '').slice(0, 3000)}`, calls: [] };
}
