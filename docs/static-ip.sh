#!/bin/bash
# My Assistant: give this VM a fixed LAN address.
#   curl https://updates.personalassistance.soft-tech.net/static-ip.sh | sudo bash
#   options: MA_IP=192.168.1.127 MA_GW=192.168.1.1 MA_PREFIX=24
set -e
[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo"; exit 1; }
IP="${MA_IP:-192.168.1.127}"; GW="${MA_GW:-192.168.1.1}"; PFX="${MA_PREFIX:-24}"
IF=$(ip -o link show | awk -F': ' '$2 ~ /^en/ {print $2; exit}')
[ -z "$IF" ] && IF=enp0s3
mkdir -p /root/netplan-backup && cp -a /etc/netplan/. /root/netplan-backup/ 2>/dev/null || true
cat > /etc/netplan/99-myassistant-static.yaml <<EOF
network:
  version: 2
  ethernets:
    $IF:
      dhcp4: false
      dhcp6: false
      addresses: [$IP/$PFX]
      routes:
        - to: default
          via: $GW
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
EOF
chmod 600 /etc/netplan/99-myassistant-static.yaml
netplan generate
netplan apply
sleep 5
echo
echo "Interface: $IF"
ip -4 addr show "$IF" | grep inet || echo "NO ADDRESS"
if ping -c 2 -W 3 1.1.1.1 >/dev/null 2>&1; then echo "INTERNET: OK"; else echo "INTERNET: FAILED"; fi
systemctl restart caddy 2>/dev/null || true
echo "DONE. To undo: sudo rm /etc/netplan/99-myassistant-static.yaml && sudo netplan apply"
