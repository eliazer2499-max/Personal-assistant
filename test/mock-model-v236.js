// Fake model for the 2.3.6 tests. "SHOT <project>" calls site_screenshot (and sends the picture); "VIDEO <json>"
// calls video_make with that JSON. After a tool answer it reports what pictures it was given, so the tests can see
// that the tool's picture really reached the model. Anything else: the 2.3.5 mock.
import mock235 from './mock-model-v235.js';
export default async function mock236(args) {
  const { items } = args;
  const last = items[items.length - 1];
  if (last?.role === 'tool' && ['site_screenshot', 'video_make'].includes(last.name)) {
    const pics = items.filter(x => x.role === 'tool' && x.media).flatMap(x => x.media);
    globalThis.__v236Seen = { pics: pics.map(p => ({ mime: p.mime, bytes: Buffer.from(p.data, 'base64').length, head: Buffer.from(p.data, 'base64').subarray(0, 3).toString('hex'), name: p.name })), result: last.result };
    return { text: `SAW ${pics.length} picture(s) from ${last.name}` + (last.result?.error ? ' ERROR ' + last.result.error : ''), calls: [] };
  }
  if (last?.role === 'user') {
    const t = String(last.text || '');
    let m;
    if ((m = /SHOT (\S+)/.exec(t))) return { text: '', calls: [{ id: 'c-shot', name: 'site_screenshot', args: { project: m[1], send_to_owner: true, caption: 'phone view' } }] };
    if ((m = /VIDEO (\{[\s\S]*\})/.exec(t))) return { text: '', calls: [{ id: 'c-vid', name: 'video_make', args: JSON.parse(m[1]) }] };
  }
  return mock235(args);
}
