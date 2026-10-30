// Fake model for the 2.2 WhatsApp Agent tests: answers with the kinds of media it was given.
export default async function mockWa({ items }) {
  let u = null;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].role === 'user') { u = items[i]; break; }
  const kinds = (u?.media || []).map(m => m.kind);
  return { text: `GOT[${kinds.join(',')}] ${String(u?.text || '').slice(0, 200)}`, calls: [] };
}
