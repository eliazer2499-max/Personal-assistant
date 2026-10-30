#!/usr/bin/env bash
# My Assistant v2 — one-command installer / updater for Ubuntu 22.04/24.04 and Debian 12 (arm64 + amd64).
#   curl -fsSL https://updates.personalassistance.soft-tech.net/install.sh | sudo bash
#   (or the same from https://abish-assistant-v2.sites.tab.bot/install.sh)
# Options (environment variables):
#   MA_DOMAIN=ai.example.com   use your own domain instead of <ip>.sslip.io (point its A record here first)
#   MA_EXTRA_DOMAINS=a.com,b.com  also answer on these addresses (point their A records here); kept on re-run/update
#   MA_EMAIL=you@example.com   email for the HTTPS certificate (optional)
#   MA_UPDATE_SOURCE=https://… where to download from first (default https://updates.personalassistance.soft-tech.net);
#                              if it fails: https://raw.githubusercontent.com/eliazer2499-max/Personal-assistant/main/docs, then the release site
#   MA_RELEASE_BASE=https://…  the release site, the last fallback (given explicitly = download from it directly)
#   DRY_RUN=1                  print what would be done, change nothing (MA_RENDER_DIR=/tmp/x also writes the files there to inspect)
#   MA_UPDATE=1                update the app only (keeps data, settings, domain)
# Safe to run again: it keeps your data, keys and settings.
set -Eeuo pipefail

RELEASE_BASE_GIVEN="${MA_RELEASE_BASE:-}"
RELEASE_BASE="${MA_RELEASE_BASE:-https://abish-assistant-v2.sites.tab.bot}"
UPDATE_SOURCE="${MA_UPDATE_SOURCE:-https://updates.personalassistance.soft-tech.net}"
GITHUB_DOCS="https://raw.githubusercontent.com/eliazer2499-max/Personal-assistant/main/docs"
# the release site kept in /etc/myassistant/env as the last fallback (an update that came from one of the first two sources keeps it)
ENV_RELEASE_BASE="$RELEASE_BASE"
case "${RELEASE_BASE%/}" in "${UPDATE_SOURCE%/}"|"$GITHUB_DOCS"|https://updates.personalassistance.soft-tech.net) ENV_RELEASE_BASE="https://abish-assistant-v2.sites.tab.bot";; esac
APP_USER=myassistant
RUN_USER=ma-run
WORK_GROUP=ma-work
OPT=/opt/myassistant
DATA=/var/lib/myassistant
SRV=/srv/myassistant
ETC=/etc/myassistant
PORT=8787
DRY="${DRY_RUN:-0}"
UPDATE="${MA_UPDATE:-0}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx \033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = "1" ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }
write_file() { # write_file <path> <mode> <owner>  (content on stdin)
  local path="$1" mode="$2" owner="$3"
  if [ "$DRY" = "1" ]; then
    printf '[dry-run] write %s (%s %s)\n' "$path" "$mode" "$owner"
    if [ -n "${MA_RENDER_DIR:-}" ]; then mkdir -p "$MA_RENDER_DIR$(dirname "$path")"; cat >"$MA_RENDER_DIR$path"; else cat >/dev/null; fi
    return
  fi
  local tmp; tmp="$(mktemp)"; cat >"$tmp"; install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$path"; rm -f "$tmp"
}
trap 'warn "Install stopped at line $LINENO. Nothing is half-deleted; run the same command again to continue."' ERR

# ---------- checks ----------
if [ "$DRY" != "1" ] && [ "$(id -u)" -ne 0 ]; then die "Run as root: curl -fsSL $RELEASE_BASE/install.sh | sudo bash"; fi
[ -r /etc/os-release ] && . /etc/os-release || die "Cannot read /etc/os-release"
case "${ID:-}:${VERSION_ID:-}" in
  ubuntu:22.04|ubuntu:24.04|debian:12) ;;
  ubuntu:*|debian:*) warn "Tested on Ubuntu 22.04/24.04 and Debian 12; you have ${PRETTY_NAME:-unknown}. Trying anyway." ;;
  *) die "This installer supports Ubuntu (22.04/24.04) and Debian 12. You have ${PRETTY_NAME:-unknown}." ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in x86_64|aarch64|arm64) ;; *) die "Unsupported CPU: $ARCH (need x86_64 or arm64)";; esac
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
[ "${MEM_MB:-0}" -lt 900 ] && warn "Only ${MEM_MB} MB RAM. It runs, but builds will be slow. Adding swap is wise."
DRYNOTE=""; [ "$DRY" = 1 ] && DRYNOTE=" (DRY RUN: nothing will change)"
say "My Assistant installer — ${PRETTY_NAME} on ${ARCH}${DRYNOTE}"

export DEBIAN_FRONTEND=noninteractive

# ---------- packages ----------
say "Installing system packages"
run apt-get update -y -q
run apt-get install -y -q ca-certificates curl gnupg git openssh-client qrencode sudo tar gzip iptables debian-keyring debian-archive-keyring apt-transport-https rsync build-essential python3

need_node=1
if command -v node >/dev/null 2>&1; then
  v="$(node -v | sed 's/^v//')"; major="${v%%.*}"; minor="$(echo "$v" | cut -d. -f2)"
  if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }; then need_node=0; fi
fi
if [ "$need_node" = 1 ]; then
  say "Installing Node.js 22 (NodeSource)"
  if [ "$DRY" = 1 ]; then echo "[dry-run] curl -fsSL https://deb.nodesource.com/setup_22.x | bash -"; else curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; fi
  run apt-get install -y -q nodejs
fi

if ! command -v caddy >/dev/null 2>&1; then
  say "Installing Caddy (automatic HTTPS)"
  if [ "$DRY" = 1 ]; then echo "[dry-run] add Caddy apt repo + apt-get install caddy"; else
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y -q && apt-get install -y -q caddy
  fi
fi

# ---------- users and folders ----------
say "Creating users and folders"
getent group "$WORK_GROUP" >/dev/null || run groupadd --system "$WORK_GROUP"
id "$APP_USER" >/dev/null 2>&1 || run useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin --user-group "$APP_USER"
id "$RUN_USER" >/dev/null 2>&1 || run useradd --system --home-dir "$SRV/sandbox-home" --shell /bin/bash --user-group "$RUN_USER"
run usermod -aG "$WORK_GROUP" "$APP_USER"
run usermod -aG "$WORK_GROUP" "$RUN_USER"
run install -d -m 755 -o root -g root "$OPT" "$OPT/releases" "$ETC" "$SRV"
run install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$DATA"
run install -d -m 2770 -o "$RUN_USER" -g "$WORK_GROUP" "$SRV/workspace"
run install -d -m 750 -o "$RUN_USER" -g "$RUN_USER" "$SRV/sandbox-home"
run install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$SRV/sites"

# ---------- download the release ----------
TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
# 2.3.1: sources in order — his own address, the repo's /docs on GitHub, then the release site. Each has
# version.json + myassistant-latest.tar.gz (+ .sha256). A source that fails is skipped; a sha256 mismatch stops.
if [ -n "$RELEASE_BASE_GIVEN" ]; then SOURCES="$RELEASE_BASE"; else SOURCES="${UPDATE_SOURCE%/} $GITHUB_DOCS $RELEASE_BASE"; fi
if [ "$DRY" = 1 ]; then
  for b in $SOURCES; do echo "[dry-run] try $b/version.json + $b/myassistant-latest.tar.gz (+ .sha256)"; done
  echo "[dry-run] unpack to $OPT/releases/<version>"
  VERSION="(dry-run)"
else
  if [ -n "${MA_LOCAL_TARBALL:-}" ] && [ -f "${MA_LOCAL_TARBALL:-}" ]; then
    # Given by the updater after it downloaded and sha256-checked the release.
    cp "$MA_LOCAL_TARBALL" "$TMPD/app.tgz"
  else
    GOT_IT=0
    for b in $SOURCES; do
      say "Downloading the app from $b"
      if curl -fsSL --max-time 300 "$b/myassistant-latest.tar.gz" -o "$TMPD/app.tgz" && curl -fsSL --max-time 30 "$b/myassistant-latest.tar.gz.sha256" -o "$TMPD/app.sha256"; then
        want="$(awk '{print $1}' "$TMPD/app.sha256")"; got="$(sha256sum "$TMPD/app.tgz" | awk '{print $1}')"
        [ "$want" = "$got" ] || die "Download check failed (sha256 mismatch) from $b. Not installing; try again in a minute."
        GOT_IT=1; break
      fi
      warn "Could not download from $b; trying the next source"
    done
    [ "$GOT_IT" = 1 ] || die "Could not download the app from any source ($SOURCES). Check the internet connection and try again."
  fi
  mkdir -p "$TMPD/x" && tar -xzf "$TMPD/app.tgz" -C "$TMPD/x"
  VERSION="$(cat "$TMPD/x/myassistant/VERSION")"
  rm -rf "$OPT/releases/$VERSION" && mv "$TMPD/x/myassistant" "$OPT/releases/$VERSION"
  chown -R root:root "$OPT/releases/$VERSION" && chmod -R u=rwX,go=rX "$OPT/releases/$VERSION"
  ln -sfn "$OPT/releases/$VERSION" "$OPT/current.new" && mv -T "$OPT/current.new" "$OPT/current"
  # keep the 3 newest releases for rollback
  ls -1dt "$OPT"/releases/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
fi
say "App version: $VERSION"

# ---------- address (domain) ----------
if [ -f "$ETC/env" ] && [ -z "${MA_DOMAIN:-}" ]; then
  DOMAIN="$(sed -n 's#^MA_PUBLIC_URL=https\?://##p' "$ETC/env" | head -1)"
fi
if [ -z "${DOMAIN:-}" ]; then
  if [ -n "${MA_DOMAIN:-}" ]; then DOMAIN="$MA_DOMAIN"; else
    IP=""
    for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
      IP="$(curl -4 -fsS --max-time 8 "$u" 2>/dev/null | tr -d '[:space:]')" || true
      [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && break || IP=""
    done
    [ -n "$IP" ] || die "Could not find this server's public IPv4. Re-run with MA_DOMAIN=your.domain"
    DOMAIN="${IP//./-}.sslip.io"
  fi
fi
PUBLIC_URL="https://$DOMAIN"
say "Private address: $PUBLIC_URL"

# Extra addresses for the same assistant (e.g. your own domain next to the sslip one): MA_EXTRA_DOMAINS="a.com,b.com".
# Not given: keep what was saved before, plus any extra host already on the Caddyfile site line (added by hand).
# Given (even empty): exactly that list.
if [ -n "${MA_EXTRA_DOMAINS+set}" ]; then EXTRA_RAW="$MA_EXTRA_DOMAINS"; else
  EXTRA_RAW="$( [ -f "$ETC/env" ] && sed -n 's/^MA_EXTRA_DOMAINS=//p' "$ETC/env" | head -1 || true)"
  if [ -f /etc/caddy/Caddyfile ] && grep -q 'My Assistant' /etc/caddy/Caddyfile; then
    line="$(grep -E '^[^#[:space:]{].*[{][[:space:]]*$' /etc/caddy/Caddyfile | grep -F "$DOMAIN" | head -1 | sed -E 's/[[:space:]]*[{][[:space:]]*$//')" || true
    EXTRA_RAW="$EXTRA_RAW,$line"
  fi
fi
EXTRA=""
for hst in $(printf '%s' "$EXTRA_RAW" | tr ', ' '\n\n'); do
  hst="${hst#https://}"; hst="${hst#http://}"; hst="${hst%%/*}"
  [[ "$hst" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ ]] || continue
  [ "$hst" = "$DOMAIN" ] && continue
  case ",$EXTRA," in *",$hst,"*) ;; *) EXTRA="${EXTRA:+$EXTRA,}$hst";; esac
done
if [ -n "$EXTRA" ]; then say "Also answering on: $EXTRA"; fi

write_file "$ETC/env" 644 root:root <<EOF
# My Assistant settings (no secrets here; keys live encrypted in $DATA)
MA_PUBLIC_URL=$PUBLIC_URL
MA_DATA_DIR=$DATA
MA_PORT=$PORT
MA_HOST=127.0.0.1
MA_WORKSPACE=$SRV/workspace
MA_SITES_DIR=$SRV/sites
MA_SANDBOX_USER=$RUN_USER
MA_RELEASE_BASE=$ENV_RELEASE_BASE
MA_EXTRA_DOMAINS=$EXTRA
NODE_ENV=production
EOF

# ---------- sudo rules (narrow) ----------
say "Setting permissions"
write_file /etc/sudoers.d/myassistant 440 root:root <<EOF
# My Assistant: run build commands as the locked-down $RUN_USER user, and start the update unit. Nothing else as root.
$APP_USER ALL=($RUN_USER) NOPASSWD: /usr/bin/env
$APP_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block myassistant-update.service
EOF
if [ "$DRY" != 1 ]; then visudo -cf /etc/sudoers.d/myassistant >/dev/null || { rm -f /etc/sudoers.d/myassistant; die "sudoers check failed"; }; fi

# ---------- systemd ----------
write_file /etc/systemd/system/myassistant.service 644 root:root <<EOF
[Unit]
Description=My Assistant (private AI assistant)
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
Group=$APP_USER
EnvironmentFile=$ETC/env
WorkingDirectory=$OPT/current
ExecStart=/usr/bin/env node --disable-warning=ExperimentalWarning $OPT/current/src/server.js
Restart=always
RestartSec=3
UMask=0007
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
ReadWritePaths=$DATA $SRV

[Install]
WantedBy=multi-user.target
EOF
write_file /usr/local/sbin/myassistant-update 755 root:root <<EOF
#!/usr/bin/env bash
# Started only when the owner taps "Update now" or runs: sudo myassistant update (via the myassistant-update unit).
# Source (2.3.1): Settings → Updates → Update source (default https://updates.personalassistance.soft-tech.net), then the
# repo's /docs on raw.githubusercontent.com, then the release site — sha256-checked; or the older "GitHub latest release"
# mode when a repo owner/name is set.
set -euo pipefail
exec >"$DATA/update.log" 2>&1
echo "=== update started \$(date -Is) ==="
set -a; . $ETC/env; set +a
# a copy of the database first (kept, not auto-deleted)
mkdir -p "$DATA/backups" && chown $APP_USER:$APP_USER "$DATA/backups"
( cd /tmp && runuser -u $APP_USER -- node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$DATA/assistant.db');d.exec(\"VACUUM INTO '$DATA/backups/pre-update-\"+Date.now()+\".db'\")" ) && echo "database backed up" || echo "(database backup skipped)"
HELPER="$OPT/current/bin/update-source.mjs"
SRC=""; TOKEN=""
if [ -f "\$HELPER" ]; then
  CFG="\$(cd /tmp && runuser -u $APP_USER -- node --disable-warning=ExperimentalWarning "\$HELPER" read 2>/dev/null || echo '{}')"
  SRC="\$(printf '%s' "\$CFG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).repo||"")}catch{}})')"
  TOKEN="\$(printf '%s' "\$CFG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{}})')"
fi
USRC=""
[ -n "\${CFG:-}" ] && USRC="\$(printf '%s' "\$CFG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).source||"")}catch{}})')"
if [ -z "\$SRC" ] && [ -f "\$HELPER" ] && grep -q fetch-auto "\$HELPER"; then
  W="\$(mktemp -d)"; trap 'rm -rf "\$W"' EXIT
  set +e
  MA_UPDATE_SOURCE="\$USRC" MA_RELEASE_BASE="$ENV_RELEASE_BASE" node --disable-warning=ExperimentalWarning "\$HELPER" fetch-auto "\$W"
  RC=\$?
  set -e
  if [ "\$RC" = 2 ]; then echo "Not updating: the download did not match its sha256."; exit 1; fi
  if [ "\$RC" = 0 ] && [ -f "\$W/app.tgz" ]; then
    mkdir -p "\$W/x" && tar -xzf "\$W/app.tgz" -C "\$W/x"
    [ -f "\$W/x/myassistant/VERSION" ] && [ -f "\$W/x/myassistant/install.sh" ] || { echo "The download has no myassistant/VERSION + install.sh; not updating."; exit 1; }
    echo "installing version \$(cat "\$W/x/myassistant/VERSION")"
    MA_UPDATE=1 MA_LOCAL_TARBALL="\$W/app.tgz" MA_RELEASE_BASE="$ENV_RELEASE_BASE" MA_UPDATE_SOURCE="\$USRC" bash "\$W/x/myassistant/install.sh"
  else
    echo "the update helper could not finish; using a source's installer instead"
    OK=0
    for b in \${USRC:-https://updates.personalassistance.soft-tech.net} https://raw.githubusercontent.com/eliazer2499-max/Personal-assistant/main/docs $ENV_RELEASE_BASE; do
      if curl -fsSL --max-time 60 "\$b/install.sh" -o "\$W/install.sh"; then echo "source: \$b"; MA_UPDATE=1 MA_RELEASE_BASE="\$b" bash "\$W/install.sh" && OK=1; break; fi
    done
    [ "\$OK" = 1 ] || { echo "No source could be reached; not updated."; exit 1; }
  fi
elif [ -z "\$SRC" ]; then
  echo "source: $ENV_RELEASE_BASE"
  curl -fsSL "$ENV_RELEASE_BASE/install.sh" | MA_UPDATE=1 MA_RELEASE_BASE="$ENV_RELEASE_BASE" bash
else
  echo "source: GitHub \$SRC"
  W="\$(mktemp -d)"; trap 'rm -rf "\$W"' EXIT
  MA_UPDATE_REPO="\$SRC" MA_UPDATE_TOKEN="\$TOKEN" node --disable-warning=ExperimentalWarning "\$HELPER" fetch "\$W"
  unset TOKEN
  if [ -f "\$W/src.tgz" ]; then
    mkdir -p "\$W/s" && tar -xzf "\$W/src.tgz" -C "\$W/s"
    TOP="\$(dirname "\$(find "\$W/s" -maxdepth 3 -name VERSION | awk '{print length, \$0}' | sort -n | head -1 | cut -d' ' -f2-)")"
    [ -f "\$TOP/src/server.js" ] || { echo "The repo's source has no VERSION + src/server.js at its top; cannot update from it."; exit 1; }
    mkdir -p "\$W/n" && cp -a "\$TOP" "\$W/n/myassistant" && tar -czf "\$W/app.tgz" -C "\$W/n" myassistant
  fi
  mkdir -p "\$W/x" && tar -xzf "\$W/app.tgz" -C "\$W/x"
  [ -f "\$W/x/myassistant/VERSION" ] && [ -f "\$W/x/myassistant/install.sh" ] || { echo "The download has no myassistant/VERSION + install.sh; not updating."; exit 1; }
  echo "installing version \$(cat "\$W/x/myassistant/VERSION")"
  MA_UPDATE=1 MA_LOCAL_TARBALL="\$W/app.tgz" MA_RELEASE_BASE="$ENV_RELEASE_BASE" bash "\$W/x/myassistant/install.sh"
fi
echo "=== update finished \$(date -Is) ==="
EOF
write_file /etc/systemd/system/myassistant-update.service 644 root:root <<EOF
[Unit]
Description=Update My Assistant (runs only when the owner taps Update now)
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/myassistant-update
EOF
write_file /usr/local/bin/myassistant 755 root:root <<'EOF'
#!/usr/bin/env bash
# My Assistant helper. Usage: sudo myassistant {status|url|setup-code|reset-login|logs|backup|update|restart}
set -euo pipefail
DATA=/var/lib/myassistant
url() { sed -n 's/^MA_PUBLIC_URL=//p' /etc/myassistant/env; }
case "${1:-status}" in
  status) systemctl --no-pager status myassistant | head -12; echo; echo "Address: $(url)";;
  url) url;;
  setup-code) if [ -f $DATA/setup-code ]; then echo "Setup code: $(cat $DATA/setup-code)"; else echo "Setup is done (no code). Lost access? Run: sudo myassistant reset-login"; fi;;
  reset-login)
    read -r -p "This removes the owner password and 2-step sign-in (your data stays). Continue? [y/N] " a; [ "$a" = y ] || exit 1
    systemctl stop myassistant
    cd /tmp && sudo -u myassistant node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$DATA/assistant.db');d.exec(\"DELETE FROM settings WHERE k IN ('setup_done','owner_password','recovery_codes','totp_last_step'); DELETE FROM secrets WHERE k='totp_secret'; DELETE FROM sessions;\")"
    code=$(head -c 64 /dev/urandom | tr -dc 'A-Z0-9' | head -c 10); install -m 600 -o myassistant -g myassistant /dev/null $DATA/setup-code; echo "$code" > $DATA/setup-code
    systemctl start myassistant; echo "Open $(url) and use setup code: $code";;
  logs) journalctl -u myassistant -n 100 --no-pager;;
  backup) cd /tmp && sudo -u myassistant node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$DATA/assistant.db');const f='$DATA/backups/manual-'+Date.now()+'.db';require('fs').mkdirSync('$DATA/backups',{recursive:true});d.exec(\"VACUUM INTO '\"+f+\"'\");console.log('Saved',f)";;
  update) systemctl start myassistant-update.service; tail -n 20 $DATA/update.log;;
  restart) systemctl restart myassistant;;
  *) echo "Usage: sudo myassistant {status|url|setup-code|reset-login|logs|backup|update|restart}";;
esac
EOF

# ---------- HTTPS (Caddy) ----------
say "Configuring HTTPS for $DOMAIN"
if [ -f /etc/caddy/Caddyfile ] && ! grep -q 'My Assistant' /etc/caddy/Caddyfile; then run cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-myassistant"; fi
GLOBAL=""
[ -n "${MA_EMAIL:-}" ] && GLOBAL="{
	email $MA_EMAIL
}"
SITE_ADDR="$DOMAIN${EXTRA:+, ${EXTRA//,/, }}"
write_file /etc/caddy/Caddyfile 644 root:root <<EOF
# My Assistant (managed by its installer; your earlier file, if any, is Caddyfile.before-myassistant)
$GLOBAL
$SITE_ADDR {
	encode gzip
	handle_path /sites/* {
		root * $SRV/sites
		file_server
	}
	handle {
		reverse_proxy 127.0.0.1:$PORT
	}
}
EOF

# ---------- firewall on this machine ----------
say "Opening ports 80 and 443 on this machine's firewall"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  run ufw allow 80/tcp; run ufw allow 443/tcp
fi
if command -v iptables >/dev/null 2>&1; then
  for p in 80 443; do
    if ! iptables -C INPUT -p tcp --dport "$p" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null; then
      run iptables -I INPUT 1 -p tcp --dport "$p" -m conntrack --ctstate NEW -j ACCEPT
    fi
  done
  # Oracle Cloud Ubuntu images keep rules in /etc/iptables/rules.v4 with a final REJECT; save ours so they survive reboot.
  if [ -f /etc/iptables/rules.v4 ]; then
    if command -v netfilter-persistent >/dev/null 2>&1; then run netfilter-persistent save; else
      if [ "$DRY" = 1 ]; then echo "[dry-run] iptables-save > /etc/iptables/rules.v4"; else iptables-save > /etc/iptables/rules.v4; fi; fi
  fi
fi

# ---------- first-run setup code ----------
if [ "$DRY" != 1 ] && [ ! -f "$DATA/assistant.db" ] && [ ! -f "$DATA/setup-code" ]; then
  code=$(head -c 64 /dev/urandom | tr -dc 'A-Z0-9' | head -c 10)
  install -m 600 -o "$APP_USER" -g "$APP_USER" /dev/null "$DATA/setup-code"; echo "$code" > "$DATA/setup-code"
fi

# ---------- start ----------
say "Starting"
run systemctl daemon-reload
run systemctl enable myassistant >/dev/null 2>&1 || true
run systemctl restart myassistant
run systemctl enable caddy >/dev/null 2>&1 || true
run systemctl restart caddy
if [ "$DRY" != 1 ]; then
  for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 || { journalctl -u myassistant -n 30 --no-pager; die "The app did not start (log above)."; }
fi

echo
echo "============================================================"
if [ "$UPDATE" = 1 ]; then
  echo " Updated My Assistant to version $VERSION."
else
  echo " My Assistant $VERSION is installed."
  echo
  echo " Open:        $PUBLIC_URL"
  if [ -f "$DATA/setup-code" ]; then echo " Setup code:  $(cat "$DATA/setup-code")"; else echo " (Setup already done — sign in with your password + code.)"; fi
  echo
  echo " If the page does not open within 2 minutes:"
  echo "  - Oracle Cloud: add ingress rules for TCP 80 and 443 in your"
  echo "    VCN's security list (see SETUP.txt, 'If you use Oracle')."
  echo "  - Other clouds: allow TCP 80 and 443 in the provider's firewall."
  echo " Help: sudo myassistant status | logs | setup-code"
fi
echo "============================================================"
