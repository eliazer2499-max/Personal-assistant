// Fake model for tests and screenshots (only loaded when MA_TEST_MODE=1 and MA_MOCK_MODULE points here).
// It behaves like a model doing a multi-step tool job.
export default async function mock({ items, noTools }) {
  if (process.env.MA_MOCK_DELAY) await new Promise(r => setTimeout(r, Number(process.env.MA_MOCK_DELAY)));
  let lastUser = -1;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].role === 'user') { lastUser = i; break; }
  const ask = items[lastUser]?.text || '';
  const results = items.slice(lastUser + 1).filter(x => x.role === 'tool');
  const R = (n) => results[n]?.result;
  const call = (name, args) => ({ text: '', calls: [{ id: 'c' + Math.random().toString(36).slice(2, 8), name, args }] });
  if (noTools) return { text: 'Stopping here (limit reached).', calls: [] };

  if (/disk/i.test(ask) && /email|send/i.test(ask)) {
    if (results.length === 0) return call('servers_list', {});
    if (results.length === 1) return call('ssh_run', { server: 'local', command: 'df -h / | tail -1' });
    if (results.length === 2) {
      const line = String(R(1)?.output || '').trim().split(/\s+/);
      return call('gmail_send', { to: 'bob@example.com', subject: 'Disk report for local', body: `Root disk on "local": ${line[2] || '?'} used of ${line[1] || '?'} (${line[4] || '?'}).` });
    }
    const line = String(R(1)?.output || '').trim().split(/\s+/);
    const ap = R(2)?.approval || '?';
    return { text: `Server "local" root disk: ${line[2]} used of ${line[1]} (${line[4]}).\nThe email to bob@example.com is ready but waiting for your OK (${ap}) — tap Approve.`, calls: [] };
  }
  if (/restart/i.test(ask)) {
    if (results.length === 0) return call('ssh_run', { server: 'local', command: 'sudo systemctl restart nginx' });
    return { text: `Restarting nginx changes the server, so it's waiting for your OK (${R(0)?.approval}).`, calls: [] };
  }
  if (/uptime|look at/i.test(ask)) {
    if (results.length === 0) return call('ssh_run', { server: 'local', command: 'uptime' });
    return { text: 'Uptime: ' + String(R(0)?.output || '').trim(), calls: [] };
  }
  if (/remember/i.test(ask)) {
    if (results.length === 0) return call('memory_save', { fact: ask.replace(/.*remember( that)?/i, '').trim() });
    return { text: 'Saved.', calls: [] };
  }
  if (/calc|\d+\s*[*x]\s*\d+/i.test(ask)) {
    if (results.length === 0) return call('calculator', { expression: (ask.match(/[\d.+\-*/() ]{3,}/) || ['0'])[0] });
    return { text: 'That is ' + R(0)?.result + '.', calls: [] };
  }
  if (/\[System note/.test(ask)) return { text: 'Done — the approved step went through.', calls: [] };
  if (/long job/i.test(ask)) {
    if (results.length < 12) return call('calculator', { expression: `${results.length}+1` });
    return { text: 'Finished all 12 steps.', calls: [] };
  }
  return { text: 'Hi! (fake test model) You said: ' + ask.slice(0, 200), calls: [] };
}
