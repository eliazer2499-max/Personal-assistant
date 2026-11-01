// 2.3.8: Settings → Browser & logins, and the live browser page (#/live) the owner opens from the "please help" link.
// Plain ES module; app.js passes in its small helpers (h, api, act, …).

export async function browserSettingsView(body, U) {
  const { h, api, act, msgEl, say, fmt, copyBox } = U;
  const out = msgEl();
  let r;
  try { r = await api('/api/browser'); } catch (e) { body.append(h('p', { class: 'msg err' }, e.message)); return; }
  const cb = h('input', { type: 'checkbox', id: 'browser-actions', 'aria-label': 'Browser actions' }); cb.checked = r.enabled;
  cb.addEventListener('change', async () => { try { await api('/api/browser/settings', { enabled: cb.checked }); say(out, cb.checked ? 'Browser actions are on.' : 'Browser actions are off. The assistant can\'t click or sign up on websites.', true); } catch (e) { cb.checked = !cb.checked; say(out, e.message, false); } });
  const status = r.installed
    ? h('div', { class: 'bstatus' }, h('span', { class: 'pill ok' }, 'Browser installed'), r.session.open ? h('span', { class: 'pill warn' }, 'Open now') : null)
    : h('div', {}, h('p', { class: 'bstatus' }, h('span', { class: 'pill err' }, 'Browser not installed')), h('p', { class: 'fine' }, 'Run this once on your server, then it works:'), copyBox(r.setup_command, 'Browser setup command'));
  const sessionRow = r.session.open ? h('div', { class: 'brow' },
    h('a', { class: 'pillbtn', href: '#/live' }, '👀 Watch live'),
    h('button', { class: 'small', onclick: async (e) => { if (await act(e.currentTarget, out, () => api('/api/browser/close', {}), 'Closed. Logins and cookies are kept.')) setTimeout(() => location.reload(), 600); } }, 'Close browser')) : null;
  body.append(
    h('section', { class: 'card' },
      h('h3', {}, '🌐 Browser'),
      status,
      h('div', { class: 'switch' }, h('label', { for: 'browser-actions' }, h('b', {}, 'Browser actions'), h('span', { class: 'sub fine', style: 'display:block' }, 'The assistant opens websites, clicks, fills in forms and signs up for you. Before it sends a sign-up it asks you: "Sign up at … with …?". It never pays.')), cb),
      sessionRow, out),
  );
  // Saved logins
  const list = h('div', { class: 'list' });
  const render = (rows) => {
    list.replaceChildren(...(rows.length ? rows.map((x) => {
      const reveal = h('div', { class: 'reveal' });
      const showBtn = h('button', { class: 'small', type: 'button', onclick: async (e) => {
        if (reveal.childNodes.length) { reveal.replaceChildren(); showBtn.textContent = 'Show'; return; }
        const s = await act(e.currentTarget, null, () => api(`/api/logins/${x.id}/show`, {}));
        if (s) { reveal.replaceChildren(copyBox(s.password, 'Password for ' + x.site)); showBtn.textContent = 'Hide'; setTimeout(() => { reveal.replaceChildren(); showBtn.textContent = 'Show'; }, 60000); }
      } }, 'Show');
      const del = h('button', { class: 'small danger', type: 'button', onclick: async (e) => {
        if (!confirm(`Delete the saved login for ${x.site}${x.email ? ' (' + x.email + ')' : ''}? The account on the website stays; only the saved password here is deleted.`)) return;
        if (await act(e.currentTarget, null, () => api(`/api/logins/${x.id}/remove`, {}))) render(rows.filter(y => y.id !== x.id));
      } }, 'Delete');
      return h('div', { class: 'item loginitem' },
        h('div', { class: 'logintop' }, h('div', { class: 'loginwho' }, h('b', {}, x.site), h('span', { class: 'sub' }, (x.email || 'no email') + ' · ' + (x.status === 'signed up' ? 'signed up ' : x.status === 'not finished' ? 'sign-up not finished · ' : 'saved ') + fmt(x.updated || x.created))),
          h('div', { class: 'loginbtns' }, showBtn, del)),
        reveal);
    }) : [h('div', { class: 'item fine' }, 'No saved logins yet. When the assistant makes an account for you, it appears here.')]));
  };
  render(r.logins || []);
  body.append(h('section', { class: 'card' },
    h('h3', {}, '🔐 Saved logins'),
    h('p', { class: 'fine' }, 'Accounts the assistant made or uses for you. Passwords are stored encrypted on your server. The assistant types them in but never sees them, and they are never in the chat or the Activity log. Show works only while you are logged in here.'),
    list));
}

export function liveView(U) {
  const { h, api, shell } = U;
  const img = h('img', { class: 'liveimg', alt: 'The assistant\'s browser, live', draggable: 'false' });
  const screen = h('div', { class: 'livescreen fit' }, img, h('div', { class: 'liveempty' }, 'Loading…'));
  const ask = h('div', { class: 'liveask' });
  const where = h('div', { class: 'livewhere fine' });
  const out = h('p', { class: 'msg' });
  let W = 1280, H = 900, timer = null, stopped = false, busy = false;
  const alive = () => !stopped && (location.hash.split('?')[0] === '#/live');
  async function refresh() {
    clearTimeout(timer);
    if (!alive()) return;
    if (!document.hidden && !busy) {
      try {
        const f = await api('/api/browser/live');
        if (!f.active) { screen.classList.add('closed'); screen.lastChild.textContent = 'The browser is closed right now. When the assistant needs your help, it sends you a link to this page.'; ask.replaceChildren(); where.textContent = ''; }
        else {
          screen.classList.remove('closed'); W = f.w; H = f.h; img.src = f.img;
          ask.replaceChildren(...(f.handoff ? [h('b', {}, 'The assistant asks: '), f.handoff.reason + '. ', 'Tap on the picture where you would tap on the page. When you\'re finished, tap Done.'] : ['Watching the assistant\'s browser. You can tap and type here too.']));
          where.textContent = (f.title ? f.title + ' · ' : '') + String(f.url || '').replace(/^https?:\/\//, '').slice(0, 80);
        }
      } catch (e) { out.textContent = e.message; out.className = 'msg err'; }
    }
    timer = setTimeout(refresh, 1000);
  }
  async function send(b, label) {
    busy = true; out.textContent = label || 'Sending…'; out.className = 'msg ok';
    try { await api('/api/browser/live/input', b); out.textContent = ''; } catch (e) { out.textContent = e.message; out.className = 'msg err'; }
    busy = false; refresh();
  }
  img.addEventListener('click', (e) => {
    const r = img.getBoundingClientRect();
    const x = Math.round((e.clientX - r.left) / r.width * W), y = Math.round((e.clientY - r.top) / r.height * H);
    const dot = h('span', { class: 'tapdot', style: `left:${e.clientX - screen.getBoundingClientRect().left + screen.scrollLeft}px;top:${e.clientY - screen.getBoundingClientRect().top + screen.scrollTop}px` });
    screen.append(dot); setTimeout(() => dot.remove(), 700);
    send({ kind: 'tap', x, y }, 'Tapping…');
  });
  const zoom = h('button', { class: 'small', type: 'button', onclick: () => { const z = screen.classList.toggle('zoom'); screen.classList.toggle('fit', !z); zoom.textContent = z ? '🔍 Fit' : '🔍 Zoom'; } }, '🔍 Zoom');
  const key = (k, label) => h('button', { class: 'small', type: 'button', onclick: () => send({ kind: 'key', key: k }) }, label);
  const scroll = (dy, label) => h('button', { class: 'small', type: 'button', onclick: () => send({ kind: 'scroll', dy }) }, label);
  const txt = h('input', { type: 'text', placeholder: 'Type here, then tap Type', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Text to type' });
  const typeForm = h('form', { class: 'livetype', onsubmit: (e) => { e.preventDefault(); if (!txt.value) return; const v = txt.value; txt.value = ''; send({ kind: 'text', text: v }, 'Typing…'); } }, txt, h('button', { type: 'submit' }, 'Type'));
  const done = h('button', { class: 'primary livedone', type: 'button', onclick: async () => {
    done.disabled = true;
    try { const r = await api('/api/browser/live/done', {}); stopped = true; clearTimeout(timer); out.textContent = r.continued ? 'Thanks! The assistant continues now. You can close this page.' : 'Thanks! You can close this page.'; out.className = 'msg ok'; }
    catch (e) { out.textContent = e.message; out.className = 'msg err'; done.disabled = false; }
  } }, '✅ Done');
  const body = h('div', { class: 'page livepage' },
    h('div', { class: 'card liveaskcard' }, ask),
    screen, where,
    h('div', { class: 'livekeys' }, zoom, scroll(-500, '⬆︎ Up'), scroll(500, '⬇︎ Down'), key('Enter', '⏎ Enter'), key('Backspace', '⌫'), key('Tab', 'Tab')),
    typeForm, out, done);
  refresh();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && alive()) refresh(); });
  return shell('chat', 'Live browser', 'Help the assistant', body, { back: '#/chat' });
}
