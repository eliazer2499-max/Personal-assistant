MY ASSISTANT v2 — your own private AI assistant, on your own server
===================================================================
Version 2.1.2. Setup steps: SETUP.txt.

NEW IN 2.1
- Several chats (like ChatGPT): ☰ Chats → New chat, rename, delete. Each
  chat has its own history; tasks, memory and settings are shared. Your
  earlier messages are in "Chat 1". The "main" chat also receives
  Telegram/WhatsApp/SMS/email messages, reminders and scheduled jobs.
- Voice notes: tap 🎤 (tap ■ to send) or hold and let go. Gemini hears the
  voice itself. Photos and files: tap 📎 (photos, PDF, Word .docx, text;
  up to 20 MB each). Gemini looks at photos and PDFs directly.
- Pictures: "make a picture of …" (Gemini image model, a setting in
  Settings → Brain; may not be available on a free key).
- Helpers: a big job can split into up to 4 helper jobs that work in
  parallel; you see them under the job card.
- Settings → General → "Jobs at the same time" (default 3).
- Settings → Updates → Update source: updates.personalassistance.soft-tech.net
  first, then the repo's /docs on GitHub, then the release site (see RELEASING.md).
- Before the database changes for 2.1, a full copy is saved in
  /var/lib/myassistant/backups/pre-2.1.0-<time>.db (kept, never auto-deleted).

2.3.3
- WhatsApp Agent reactions: when it gets your message it reacts 👍 right away
  (Settings → Channels → WhatsApp Agent → "React to my messages", emoji
  👍 👀 ❤️ ✅). The assistant can also react ❤️ / 😂 / ✅ when it fits, for
  example ✅ when a job you asked for is done. A failed reaction never stops
  the reply; it is written to the Activity log.

2.3.2
- Test checks what each model can do: Settings → Brain → tap a key → Test.
  It sends the model a tiny photo, a half-second sound, a one-word PDF and a
  tiny tool call, then shows "This model can:" ✓/✗ (Chat, Photos, Voice, PDF,
  Pictures, Tools). It ticks every "Use for" the model can do and greys out the
  rest with the reason. Keys you have not tested keep their ticks as before.
- Voice notes only go to keys that can hear, photos only to keys that can see
  (from the last Test). A limit during Test shows "couldn't check", not ✗.

2.3.1
- Each AI key has "Use for" (Chat, Coding, Pictures, Voice & files, Background):
  Settings → Brain (AI keys) → tap a key. Busy or missing → the next active key.
- New Settings and Brain screens, light and dark (Settings → General → Appearance).
- The assistant can send you files (send_file) in the web chat and on WhatsApp.
- It reads Word, Excel, PowerPoint, CSV, text/code files and .zip you send it.

WHAT IT DOES
- Chat with it on its private web page (installable on your phone's home
  screen), Telegram, email ("AI:" subject), text messages (Android gateway
  phone), WhatsApp (Meta Cloud API) and, new in 2.2, WhatsApp Agent (the
  "Agents" feature in your own WhatsApp: paste the agent's API key in
  Settings > Channels; no public address needed). It only obeys you on every
  channel.
- Long jobs run in the background (default up to 40 steps / 60 minutes per
  job, changeable). You watch each step live and can stop it.
- Brain: Google Gemini with your own free key (default model gemini-3.6-flash;
  if Google retires a model it switches to the newest listed flash model).
  New in 2.3: AI keys. Add several keys, each with a name (e.g. "Gemini -
  project 2"), Active on/off, a Test button and an order. Gemini keys or any
  OpenAI-compatible API (Groq, OpenRouter, OpenAI, a local server). When a
  key hits its free limit, is refused or its provider is down, the assistant
  moves to the next active key for the same request by itself (voice notes
  and PDFs prefer Gemini keys). Switches are written to the Activity log.
- Google, multiple accounts: Gmail search/read/draft/send, Calendar
  list/create, Drive search/read/upload, Docs create, Sheets read/append,
  Contacts search. Each account signs in once (OAuth); tokens are encrypted.
- Servers: logs in over SSH with its own key (or one you paste). Read-only
  commands run at once; anything that changes a server waits for your YES.
- Builds things: a workspace folder per project; it writes files, runs
  builds/tests as a locked-down user (no access to its own keys), and
  publishes sites on this server (https://<your address>/sites/<name>/),
  to GitHub (and GitHub Pages) or to Cloudflare Pages with your tokens.
  Android apps: it prepares a WebView app; GitHub builds the APK for free,
  or install the optional Android SDK on an x86 server.
  Checks its sites (2.3.6): opens them in a hidden browser at phone size,
  looks at the picture and fixes what looks wrong (optional, one time:
  sudo bash /opt/myassistant/current/optional/install-browser.sh).
  Makes videos (2.3.6, free): pictures + words (Hebrew/Yiddish too) + music
  into an MP4 under 16 MB (optional, one time:
  sudo bash /opt/myassistant/current/optional/install-video.sh).
- Memory, tasks with reminders, repeating jobs ("every morning check my
  servers"), and a morning summary to your chosen channel.
- Approvals: one queue (web buttons, Telegram buttons, WhatsApp buttons, or
  "YES A12" by text/email). Expire after 24 h. Full activity log.
- Updates: it checks for new versions and tells you; it only updates when you
  tap "Update now". Nightly database backups (optionally to Google Drive).

PRIVACY AND SAFETY, HONESTLY
- It runs on your server. Only your password + authenticator code opens the
  page; Telegram/WhatsApp/SMS/email only obey your own chat/numbers/address.
- Keys, tokens and passwords you give it are encrypted (AES-256-GCM) with a
  master key file on the server (mode 600). Anyone with root on the server
  could read them — keep the server's own login safe.
- What you ask, plus the email/file/command text a tool reads to answer, is
  sent to the AI provider (Google Gemini by default). On Gemini's free tier
  Google may use that to improve its products. Use a paid key if that matters.
- The approval rule is in this program's code (the AI only gets tools that FILE
  a request for risky actions; your YES runs them). It is a strong habit, not a
  wall: text inside emails/web pages is treated as content, never as orders.
- Each ability can be switched off in Settings > Tools.

HOW IT'S BUILT (for anyone checking)
- Node.js 22, no npm packages (built-in http, crypto, node:sqlite, child_process).
- One systemd service (myassistant), Caddy for HTTPS, SQLite database in
  /var/lib/myassistant, projects in /srv/myassistant/workspace.
- Tests: npm test (unit + end-to-end with fake Google/Telegram/SMS/Meta and a
  fake model; uses a local sshd for SSH tests when available).
