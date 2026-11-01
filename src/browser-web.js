// 2.3.8: web routes for the browser — Settings → Browser & logins (switch, saved logins with Show / Delete) and the
// live view the owner opens from the "please help" link (#/live). All behind the owner's login + CSRF like every /api route.
import { setting, setSetting, audit } from './db.js';
import * as B from './browser-core.js';
import { listLogins, loginRow, loginPassword, removeLogin } from './logins.js';
import { BROWSER_CMD } from './tools/sitecheck.js';

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

export function registerBrowserRoutes(R) {
  R('GET', /^\/api\/browser$/, () => ({
    installed: B.browserInstalled(), enabled: B.browserActionsOn(), setting: setting('browser_actions') || 'auto', setup_command: BROWSER_CMD,
    idle_minutes: B.idleMinutes(), session: B.sessionInfo(), logins: listLogins(),
  }));
  R('POST', /^\/api\/browser\/settings$/, (c) => {
    if (c.body.enabled !== undefined) { setSetting('browser_actions', c.body.enabled ? '1' : '0'); audit('owner', 'browser.actions', c.body.enabled ? 'on' : 'off'); if (!c.body.enabled) B.closeBrowser('switched off by the owner').catch(() => {}); }
    return { ok: true, enabled: B.browserActionsOn() };
  });
  R('POST', /^\/api\/browser\/close$/, async () => ({ ok: true, closed: await B.closeBrowser('closed by the owner') }));
  // Saved logins: Show needs his login session (this route is behind it) and is written to the audit log (without the password).
  R('POST', /^\/api\/logins\/(\d+)\/show$/, (c) => {
    const r = loginRow(c.m[1]); if (!r) throw httpErr(404, 'That login was deleted');
    audit('owner', 'login.shown', `${r.site}${r.email ? ' · ' + r.email : ''}`);
    return { id: r.id, site: r.site, email: r.email, password: loginPassword(r.id) };
  });
  R('POST', /^\/api\/logins\/(\d+)\/remove$/, (c) => { if (!removeLogin(c.m[1])) throw httpErr(404, 'That login was deleted'); return { ok: true }; });

  // the live browser (the "please help" page)
  R('GET', /^\/api\/browser\/live$/, async () => {
    if (!B.current()) return { active: false };
    return await B.liveFrame();
  });
  R('POST', /^\/api\/browser\/live\/input$/, async (c) => {
    if (!B.current()) throw httpErr(409, 'The browser is closed. Ask the assistant to open the page again.');
    return await B.liveInput(c.body || {});
  });
  R('POST', /^\/api\/browser\/live\/done$/, async () => {
    const h = B.endHandoff();
    audit('owner', 'browser.handoff_done', h ? h.site + ': ' + h.reason : '');
    if (h) {
      const { startJob } = await import('./brain.js');
      startJob({ text: `[System note, not from the owner's words] The owner tapped Done on the live browser page (he was asked to: ${h.reason}). Call browser_read and continue the task.`, channel: h.channel || 'web', hidden: true, chatId: h.chatId || null });
    }
    return { ok: true, continued: !!h };
  });
}
