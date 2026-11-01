#!/usr/bin/env bash
# OPTIONAL: lets My Assistant look at websites like a phone does (the site_screenshot tool):
# a hidden (headless) Chromium browser plus fonts for Hebrew, Yiddish and emoji. About 500 MB of disk.
#   sudo bash /opt/myassistant/current/optional/install-browser.sh
# Works on x86_64 and arm64 (64-bit ARM). Safe to run again (it updates / repairs).
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo"; exit 1; }
arch=$(uname -m)
case "$arch" in x86_64|amd64|aarch64|arm64) ;; *) echo "This server is $arch. Only x86_64 and arm64 are supported."; exit 1;; esac
free_mb=$(df -BM --output=avail /opt | tail -1 | tr -dc '0-9')
[ "${free_mb:-0}" -ge 1200 ] || { echo "Need at least 1.2 GB free on /opt (have ${free_mb} MB)."; exit 1; }
export DEBIAN_FRONTEND=noninteractive
install_fonts() {
  # Noto covers Hebrew and Yiddish (incl. vowel points), Latin, Cyrillic, Arabic and more; plus colour emoji.
  apt-get install -y -q --no-install-recommends fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core fontconfig
  fc-cache -f >/dev/null 2>&1 || true
}
LINK=/usr/local/bin/ma-chromium
DEST=/opt/myassistant-browser
dpkg --configure -a >/dev/null 2>&1 || true
apt-get update -y -q
install_fonts
found=""
# 1) Playwright's Chromium (a normal program, no snap; x86_64 + arm64). Needs Node's npx (installed with My Assistant).
if command -v npx >/dev/null 2>&1; then
  mkdir -p "$DEST"
  if PLAYWRIGHT_BROWSERS_PATH="$DEST" HOME=/root timeout -k 10 1200 npx --yes "playwright@${MA_PLAYWRIGHT_VERSION:-1.64.1}" install --with-deps --only-shell chromium; then
    found=$(ls -d "$DEST"/chromium_headless_shell-*/chrome-*/headless_shell "$DEST"/chromium_headless_shell-*/chrome-*/chrome-headless-shell 2>/dev/null | sort -V | tail -1 || true)
  else
    echo "Playwright's Chromium did not install; trying the system package instead."
  fi
fi
# 2) The system package (Debian: chromium; Ubuntu: chromium-browser).
if [ -z "$found" ]; then
  if apt-cache show chromium >/dev/null 2>&1 && apt-get install -y -q chromium; then found=$(command -v chromium || true); fi
fi
if [ -z "$found" ]; then
  apt-get install -y -q chromium-browser || true
  found=$(command -v chromium-browser || command -v chromium || true)
fi
rm -rf "$DEST"/ffmpeg-* 2>/dev/null || true   # Playwright fetches its own ffmpeg; not needed here
apt-get clean
rm -rf /root/.npm/_npx 2>/dev/null || true
[ -n "$found" ] || { echo "Could not install a Chromium browser on this server."; exit 1; }
chmod -R a+rX "$DEST" 2>/dev/null || true
ln -sf "$found" "$LINK"
ver=$("$LINK" --headless --no-sandbox --version 2>/dev/null || true)
echo "Browser ready: ${ver:-$found}"
echo "Done. The assistant can now open your sites at phone size and look at them."
