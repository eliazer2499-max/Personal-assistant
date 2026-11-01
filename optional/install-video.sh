#!/usr/bin/env bash
# OPTIONAL: lets My Assistant make videos (the video_make tool): ffmpeg plus fonts for Hebrew, Yiddish
# and emoji. Free, no AI video service. About 300 MB of disk.
#   sudo bash /opt/myassistant/current/optional/install-video.sh
# Works on x86_64 and arm64. Safe to run again.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo"; exit 1; }
free_mb=$(df -BM --output=avail / | tail -1 | tr -dc '0-9')
[ "${free_mb:-0}" -ge 600 ] || { echo "Need at least 600 MB free (have ${free_mb} MB)."; exit 1; }
export DEBIAN_FRONTEND=noninteractive
install_fonts() {
  # Noto covers Hebrew and Yiddish (incl. vowel points), Latin, Cyrillic, Arabic and more; plus colour emoji.
  apt-get install -y -q --no-install-recommends fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core fontconfig
  fc-cache -f >/dev/null 2>&1 || true
}
dpkg --configure -a >/dev/null 2>&1 || true
apt-get update -y -q
apt-get install -y -q --no-install-recommends ffmpeg
install_fonts
apt-get clean
ffmpeg -hide_banner -version | head -1
filters=$(ffmpeg -hide_banner -filters 2>/dev/null || true)
if printf '%s' "$filters" | grep -q ' ass '; then echo "Words on videos: OK (Hebrew/Yiddish right-to-left via libass)."; else echo "Note: this ffmpeg has no libass, so videos will be made without words on them."; fi
echo "Done. The assistant can now make videos."
