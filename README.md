# My Assistant v2 — complete setup guide

Your own private AI assistant, running on an Ubuntu virtual machine at home.
This is the exact setup used for the first one (home PC + VirtualBox), plus every
optional part and a free cloud option. About 30–40 minutes the first time.

**Contents:** 1 Create the VM · 2 Fixed address · 3 Router ports · 4 Install · 5 First login ·
6 AI keys · 6b Google accounts · 7 Extras & channels · Own domain · Everyday commands ·
If it stops loading · Copy to another PC · Cloud server option · Remove it

---

## What you need

- A Windows PC that stays on (set **Sleep = Never** in Windows power settings).
- [VirtualBox](https://www.virtualbox.org/wiki/Downloads) installed on it.
- The Ubuntu Server 24.04 ISO: https://ubuntu.com/download/server
- Access to your home router (to forward 2 ports).
- A free Gemini key: https://aistudio.google.com/apikey

---

## Step 1 — Create the VM

1. VirtualBox → **New**
   - Name: `myassistant` (anything)
   - ISO Image: the Ubuntu Server 24.04 ISO
   - Tick **Skip Unattended Installation**
2. Hardware: **4096 MB** memory, **2 CPUs** (more is fine).
3. Hard disk: **40 GB**.
4. Finish, then **Settings → Network → Adapter 1**:
   - Attached to: **Bridged Adapter**
   - Name: the PC's **Wi-Fi** card
     (on the first PC the cable/Ethernet card kept dropping; Wi-Fi was stable)
   - Cable Connected: ticked
5. **Settings → System → Motherboard**: no change needed.
6. Start the VM and install Ubuntu Server with the defaults:
   - Network: leave on automatic (DHCP) for now
   - Make a user + password (you'll type this password for `sudo`)
   - Tick **Install OpenSSH server** (optional, handy)
   - Reboot when it says so, then log in.

> Tip: if you control the PC over Chrome Remote Desktop and can't paste,
> type the commands below by hand. They are kept short on purpose.

---

## Step 2 — Give the VM a fixed address (recommended)

So the router always finds it. In the VM type:

```
ip a
```

Note the `inet 192.168.x.y` under `enp0s3` and your router address
(usually `192.168.1.1`). Then type:

```
sudo true
curl https://updates.personalassistance.soft-tech.net/static-ip.sh | sudo bash
```

It fixes the VM at **192.168.1.127** with router **192.168.1.1**.
For a different address, first make sure nothing else uses it, then run:

```
curl https://updates.personalassistance.soft-tech.net/static-ip.sh | sudo MA_IP=192.168.1.128 MA_GW=192.168.1.1 bash
```

The end should say `INTERNET: OK`. Undo any time:
`sudo rm /etc/netplan/99-myassistant-static.yaml && sudo netplan apply`

---

## Step 3 — Router: forward 2 ports

In your router's admin page → **Port forwarding**, add:

| Name | External port | Internal IP | Internal port | Protocol |
|---|---|---|---|---|
| web  | 80  | 192.168.1.127 | 80  | TCP |
| https| 443 | 192.168.1.127 | 443 | TCP |

Use the VM's address from Step 2.

**One per house:** your home internet has one outside address, so only ONE
assistant per house can use ports 80/443. A second VM in the same house works
on the home network only.

---

## Step 4 — Install the assistant

In the VM type:

```
sudo true
curl https://updates.personalassistance.soft-tech.net/install.sh | sudo bash
```

(Backup source if that address is down:
`curl https://abish-assistant-v2.sites.tab.bot/install.sh | sudo bash`)

It takes 3–6 minutes and always installs the **latest** version. At the end it
prints your address (like `https://96-250-207-131.sslip.io`) and a **SETUP CODE**.

**Your own domain (optional):** point the domain's A record to your home's
outside IP first, then install with:

```
curl https://updates.personalassistance.soft-tech.net/install.sh | sudo MA_DOMAIN=ai.example.com bash
```

Or keep the sslip address and add the domain as an extra:
`... | sudo MA_UPDATE=1 MA_EXTRA_DOMAINS=ai.example.com bash`

**Change the main address later, without a command (2.3.19, one list since 2.3.20):** Settings → Main address lists
every address this server answers on, with the default one marked. Tap **Make default** next to another one (or type a
new one under "Add another address"). It checks first that the address points to this server and opens this same
assistant; if not, nothing changes. The old address keeps working, updates keep your choice, and
Telegram moves to the new address by itself. If you use Google sign-in, add the new return address to your Google
console afterwards.

---

## Step 5 — First login (on your phone)

1. Open the address it printed.
2. Enter the setup code, choose a password.
3. Add it to an authenticator app (Google Authenticator, Microsoft
   Authenticator, or iPhone Passwords) and type the 6-digit code.
4. Screenshot the 8 backup codes.

Lost the code? In the VM: `sudo myassistant setup-code`

---

## Step 6 — Add the AI keys

**Settings → Brain (AI keys) → + Add key** → pick the Type → paste → **Save** → **Test**.
Test shows what each key can do (Chat, Photos, Voice, PDF, Pictures, Tools) and ticks the right "Use for" boxes
(Chat, Coding, Pictures, Voice & files, Background). If one key is busy, the next active key takes over.

| Key | Type | Where to get it (free) | Use for |
|---|---|---|---|
| **Gemini** (main) | Gemini | https://aistudio.google.com/apikey → Create API key | Chat, pictures, voice & files, background |
| **OpenRouter** (backup) | OpenAI-compatible, address `https://openrouter.ai/api/v1` | https://openrouter.ai/keys | Chat, coding |
| **Groq** (backup, optional) | Groq | https://console.groq.com/keys → Create API Key | Chat, coding |
| **Cloudflare** (pictures) | Cloudflare | see below | Pictures; tick Chat/Background to use it as a backup brain |

**Cloudflare key:**
1. https://dash.cloudflare.com → sign up (free).
2. Copy the **Account ID** (right side of the account home page).
3. My Profile → **API Tokens** → Create Token → **Workers AI** template → Create → copy.
4. In the app: Type **Cloudflare**, paste Account ID + API token → **Test** → Model **Auto** → tick **Chat** (and Background) if you want it as a backup brain.

Cloudflare gives a small free amount of pictures each day (resets 00:00 UTC).

---

## Step 6b — Google accounts (Gmail, Calendar)

**Settings → Google accounts**, then follow the page:
1. Create a Google Cloud project (https://console.cloud.google.com).
2. Switch on the APIs the page lists (Gmail, Calendar, …).
3. OAuth consent screen: **External**, add yourself as a test user,
   then **PUBLISH** the app (otherwise sign-ins expire every 7 days).
4. Credentials → Create **OAuth client ID** → type **Web** → add the
   redirect address the page shows → copy **Client ID + Secret** into the page.
5. Tap **Add Google account** once for each Gmail account.

Google needs a real domain for the redirect address. If it refuses the sslip
address, use your own domain (Step 4, `MA_DOMAIN=`).

## Step 7 — Optional extras

In the VM:

```
sudo bash /opt/myassistant/current/optional/install-browser.sh
sudo bash /opt/myassistant/current/optional/install-video.sh
```

- **install-browser.sh** (~500 MB): lets it open and check websites.
- **install-video.sh** (~300 MB): lets it make videos.

In the app, **Settings → Channels** (all optional):

- **WhatsApp Agent** (easiest WhatsApp): in WhatsApp → Settings → Agents →
  Create an agent → open the agent's chat → Chat info → **API key** → paste it
  in the WhatsApp Agent card → **Save key** → turn on **Enabled** → send the
  agent a message. Option "React to my messages" (👍 👀 ❤️ ✅).
- **Telegram**: in Telegram open @BotFather → /newbot → copy the token →
  paste it → tap the pairing link.
- **Email**: switch on, then email yourself with subject `AI: ...`.
- **Text/SMS**: install "SMS Gateway for Android" on a spare Android phone,
  turn on **Cloud server**, paste its username/password.
- **WhatsApp (Meta Cloud API)**: needs a Meta developer app + a number Meta
  verifies by code. The page lists every tap.

Other settings:
- **Servers**: copy the assistant's key (shown on the page) into each server's
  `~/.ssh/authorized_keys`, add the server, tap **Test**.
- **More → Vault**: GitHub / Cloudflare tokens, so it can publish sites.
- **Settings → General**: Appearance (light/dark), "Jobs at the same time" (default 3).
- **Settings → Updates**: update source (default `updates.personalassistance.soft-tech.net`,
  then GitHub `/docs`, then the release site) and **Update now**.

Anything that emails other people, deletes, spends, changes a server or
publishes waits for your **YES**.

---

## Own domain (like ai.louisb.vip)

1. In your domain's DNS (for example Cloudflare → DNS) add an **A record**:
   name `ai` → your home's outside IP (Google "what is my ip" from home).
   On Cloudflare set it to **DNS only** (grey cloud).
2. In the VM:
   ```
   curl https://updates.personalassistance.soft-tech.net/install.sh | sudo MA_UPDATE=1 MA_EXTRA_DOMAINS=ai.example.com bash
   ```
   (keeps the sslip address too; HTTPS is set up automatically within a minute or two.)

---

## Everyday commands (in the VM)

| Command | What it does |
|---|---|
| `sudo myassistant status` | Is it running? |
| `sudo myassistant url` | Show the address |
| `sudo myassistant setup-code` | New setup code |
| `sudo myassistant reset-login` | Reset password / 2-step login |
| `sudo myassistant logs` | Recent log lines |
| `sudo myassistant backup` | Make a backup now |
| `sudo myassistant update` | Update to the latest version |
| `sudo myassistant restart` | Restart it |

Updates can also be done in the app: **Settings → Updates → Update now**.

---

## If it stops loading from outside

1. In the VM: `sudo myassistant status` — if it says running, the app is fine.
2. `ip a` — is there an `inet 192.168.1.127` line under `enp0s3`?
   - **No:** the VM lost its network. Check VirtualBox → Settings → Network is
     Bridged to the **Wi-Fi** card, then `sudo netplan apply`.
3. `ping 192.168.1.1` (Ctrl+C to stop):
   - **Destination Host Unreachable** = the PC's network card isn't passing
     traffic. Switch the bridge to the other card (Wi-Fi ↔ cable).
4. `systemctl status caddy` (press `q` to leave) — should say active (running).
   If not: `sudo systemctl restart caddy`.
5. VM frozen? VirtualBox → Machine → **Reset**.
6. Just installed and the page won't open: wait 1–2 minutes for the HTTPS certificate;
   check the router forwards 80 and 443 (Step 3).
7. Lost the setup code: `sudo myassistant setup-code`.
   Lost your phone / 2-step: use a backup code, or `sudo myassistant reset-login`.
8. Errors: `sudo myassistant logs`.

---

## Copy to another PC instead

VirtualBox → **File → Export Appliance** → copy the `.ova` → on the other PC
**File → Import Appliance**. Everything comes along (settings, keys, chats).
If both run on the same network, give the copy a different fixed address
(Step 2 with `MA_IP=`), and only one of them can use the router's ports 80/443.

---

## Instead of a home PC: free cloud server (Oracle "Always Free")

No router or VM needed; it has its own public IP.

1. Sign up at https://oracle.com/cloud/free ("Start for free"). It asks for a card
   to verify; Always Free resources are not charged. Pick a home region near you.
2. Open **Cloud Shell** (the `>_` icon at the top) and make a login key:
   ```
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 && cat ~/.ssh/id_ed25519.pub
   ```
   Copy the line it prints (starts with `ssh-ed25519`).
3. Menu → Compute → Instances → **Create instance**:
   - Image: **Canonical Ubuntu 24.04**
   - Shape: Ampere **VM.Standard.A1.Flex**, 2 OCPU, 12 GB (free). "Out of capacity" →
     try another availability domain or later.
   - Networking: new virtual cloud network, public subnet, **Assign a public IPv4 address**.
   - SSH keys: **Paste public keys** → paste the line from step 2.
   - Create, then copy the **Public IP**.
4. Open the web ports: instance page → Subnet → Security Lists → Default Security
   List → **Add Ingress Rules**: Source `0.0.0.0/0`, TCP, port **80**; add another for **443**.
5. In Cloud Shell: `ssh ubuntu@YOUR_PUBLIC_IP`, then do **Step 4** (install) and **Steps 5–7**.

Other clouds (Google Cloud, AWS, Hetzner, DigitalOcean): Ubuntu 24.04, allow inbound
TCP 80 and 443, then Step 4.

---

## Remove it

```
sudo bash /opt/myassistant/current/uninstall.sh
```
Keeps your data. Add `--purge` to delete everything.

---

## Where things live (in the VM)

- App: `/opt/myassistant/releases/<version>` (current one: `/opt/myassistant/current`)
- Data & backups: `/var/lib/myassistant`
- Settings: `/etc/myassistant/env`
- Web server: Caddy (handles HTTPS automatically)

More: `SETUP.txt` (cloud servers, Oracle free tier), `README.txt` (what's new),
`RELEASING.md` (how updates are published).
