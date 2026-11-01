# My Assistant v2 — exact setup on a home PC (VirtualBox)

Your own private AI assistant, running on an Ubuntu virtual machine at home.
This is the exact setup used for the first one. About 30–40 minutes the first time.

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

**Settings → Brain (AI keys) → + Add key**

1. Gemini (main): paste the key from aistudio.google.com/apikey → Save → **Test**.
2. OpenRouter (backup, optional) → Save → Test.
3. Cloudflare Workers AI (pictures, optional; can also chat as a backup)
   → Save → Test → choose **Auto** → tick **Chat**.

Test shows what each key can do (Chat, Photos, Voice, PDF, Pictures, Tools)
and ticks the right "Use for" boxes.

---

## Step 7 — Optional extras

In the VM:

```
sudo bash /opt/myassistant/current/optional/install-browser.sh
sudo bash /opt/myassistant/current/optional/install-video.sh
```

- **install-browser.sh** (~500 MB): lets it open and check websites.
- **install-video.sh** (~300 MB): lets it make videos.

In the app, **Settings → Channels**:
- **WhatsApp Agent**: in WhatsApp → Settings → Agents → Create an agent → open
  the agent's chat → Chat info → API key → paste it in the WhatsApp Agent card →
  Save key → Enabled → send the agent a message.
- **Telegram**: paste a @BotFather token, tap the pairing link.
- **Email**: switch on, then email yourself with subject `AI: ...`.
- **Google accounts**: follow the steps on that page (Gmail/Calendar).

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

---

## Copy to another PC instead

VirtualBox → **File → Export Appliance** → copy the `.ova` → on the other PC
**File → Import Appliance**. Everything comes along (settings, keys, chats).
If both run on the same network, give the copy a different fixed address
(Step 2 with `MA_IP=`), and only one of them can use the router's ports 80/443.

---

## Where things live (in the VM)

- App: `/opt/myassistant/releases/<version>` (current one: `/opt/myassistant/current`)
- Data & backups: `/var/lib/myassistant`
- Settings: `/etc/myassistant/env`
- Web server: Caddy (handles HTTPS automatically)

More: `SETUP.txt` (cloud servers, Oracle free tier), `README.txt` (what's new),
`RELEASING.md` (how updates are published).
