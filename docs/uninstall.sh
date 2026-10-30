#!/usr/bin/env bash
# Removes My Assistant. Keeps your data unless you add --purge.
#   sudo bash uninstall.sh            (keeps /var/lib/myassistant: database, keys, backups)
#   sudo bash uninstall.sh --purge    (deletes everything, including data and built projects)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo"; exit 1; }
PURGE=0; [ "${1:-}" = "--purge" ] && PURGE=1
systemctl disable --now myassistant 2>/dev/null || true
rm -f /etc/systemd/system/myassistant.service /etc/systemd/system/myassistant-update.service /usr/local/sbin/myassistant-update /usr/local/bin/myassistant /etc/sudoers.d/myassistant
systemctl daemon-reload
if [ -f /etc/caddy/Caddyfile.before-myassistant ]; then mv /etc/caddy/Caddyfile.before-myassistant /etc/caddy/Caddyfile; elif grep -q 'My Assistant' /etc/caddy/Caddyfile 2>/dev/null; then printf ':80 {\n\trespond "Caddy is running"\n}\n' > /etc/caddy/Caddyfile; fi
systemctl reload caddy 2>/dev/null || true
rm -rf /opt/myassistant /etc/myassistant
if [ "$PURGE" = 1 ]; then
  rm -rf /var/lib/myassistant /srv/myassistant
  userdel myassistant 2>/dev/null || true; userdel ma-run 2>/dev/null || true; groupdel ma-work 2>/dev/null || true
  echo "Removed My Assistant and all its data."
else
  echo "Removed My Assistant. Your data is still in /var/lib/myassistant and /srv/myassistant (delete with --purge)."
fi
echo "Caddy and Node.js were left installed (apt remove caddy nodejs to remove them). Firewall rules for 80/443 were left open."
