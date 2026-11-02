#!/bin/bash
# My Assistant: keep this VM online on cable OR Wi-Fi (cable first, Wi-Fi if it drops).
#   Set up:  curl -fsSL https://updates.personalassistance.soft-tech.net/net-fallback.sh | sudo bash
#   Undo:    curl -fsSL https://updates.personalassistance.soft-tech.net/net-fallback.sh | sudo bash -s undo
#   Status:  sudo myassistant-net status
# Before running: in VirtualBox, Adapter 1 = Bridged to the PC's Wi-Fi (as today),
# Adapter 2 = Bridged to the PC's cable (Ethernet) card.
# Options: MA_IP=192.168.1.127 MA_GW=192.168.1.1 MA_PREFIX=24 MA_CABLE=enp0s8 MA_WIFI=enp0s3
# Safe: the old setup is saved, and if the router can't be reached within 2 minutes
# after the switch, the old setup comes back by itself.
set -e
[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo"; exit 1; }
mkdir -p /usr/local/sbin
cat > /usr/local/sbin/myassistant-net.new <<'MYASSISTANT_NET_EOF'
#!/bin/bash
# myassistant-net: keep the My Assistant VM online on cable OR Wi-Fi.
# Installed by net-fallback.sh. Modes:
#   myassistant-net install   set up the fallback (default)
#   myassistant-net status    show which connection is in use
#   myassistant-net test      switch to the other connection for a moment and back
#   myassistant-net undo      put the old network setup back
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

NP=/etc/netplan
OURS=$NP/90-myassistant-fallback.yaml
BK=/root/myassistant-net-backup
STATE=/var/lib/myassistant-net
CONF=/etc/myassistant-net.conf
LOG=/var/log/myassistant-net.log
CI=/etc/cloud/cloud.cfg.d/99-myassistant-net.cfg
GUARD=/etc/systemd/system/myassistant-net-guard.service
BOND=bond0
WAIT_SECS=${MA_WAIT:-120}

say() { echo "$*"; echo "$(date '+%F %T') $*" >> "$LOG" 2>/dev/null || true; }
die() { say "STOPPED: $*"; exit 1; }

need_root() { [ "$(id -u)" -eq 0 ] || { echo "Please run with sudo"; exit 1; }; }

# Physical en* network cards, in VirtualBox adapter order (PCI address order).
list_nics() {
  local d n
  for d in /sys/class/net/*; do
    n=${d##*/}
    case "$n" in en*) ;; *) continue ;; esac
    [ -e "$d/device" ] || continue
    printf '%s %s\n' "$(readlink -f "$d/device")" "$n"
  done | sort | awk '{print $2}'
}

load_conf() {
  # shellcheck disable=SC1090
  [ -f "$CONF" ] && . "$CONF"
  IP=${MA_IP:-${IP:-192.168.1.127}}
  PFX=${MA_PREFIX:-${PFX:-24}}
  if [ -z "${MA_GW:-}" ] && [ -z "${GW:-}" ]; then
    GW=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="via"){print $(i+1); exit}}')
  fi
  GW=${MA_GW:-${GW:-192.168.1.1}}
  CABLE=${MA_CABLE:-${CABLE:-}}
  WIFI=${MA_WIFI:-${WIFI:-}}
}

save_conf() {
  umask 022
  cat > "$CONF" <<EOF
# My Assistant network fallback settings (written by myassistant-net)
IP=$IP
PFX=$PFX
GW=$GW
CABLE=$CABLE
WIFI=$WIFI
EOF
}

valid_ip() { echo "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; }

gw_ok() {
  # The router answers on the bond: ping, or at least a fresh ARP lookup.
  ip neigh flush dev "$BOND" to "$GW" 2>/dev/null || true
  ping -c 1 -W 2 -I "$BOND" "$GW" >/dev/null 2>&1 && return 0
  ip neigh show "$GW" dev "$BOND" 2>/dev/null | grep -q REACHABLE && return 0
  return 1
}

active_nic() { cat /sys/class/net/$BOND/bonding/active_slave 2>/dev/null; }

name_of() {
  case "$1" in
    "$CABLE") echo "cable" ;;
    "$WIFI") echo "Wi-Fi" ;;
    "") echo "none" ;;
    *) echo "$1" ;;
  esac
}

restart_web() { systemctl try-restart caddy >/dev/null 2>&1 || true; }

write_yaml() {
  umask 077
  cat > "$OURS.tmp" <<EOF
# My Assistant network fallback (written by myassistant-net; undo: sudo myassistant-net undo)
# $CABLE = VirtualBox Adapter 2 (cable), $WIFI = VirtualBox Adapter 1 (Wi-Fi).
# One address ($IP) that moves to whichever connection can reach the router ($GW).
network:
  version: 2
  renderer: networkd
  ethernets:
    $CABLE:
      dhcp4: false
      dhcp6: false
      link-local: []
      optional: true
    $WIFI:
      dhcp4: false
      dhcp6: false
      link-local: []
      optional: true
  bonds:
    $BOND:
      interfaces: [$CABLE, $WIFI]
      dhcp4: false
      dhcp6: false
      addresses: [$IP/$PFX]
      routes:
        - to: default
          via: $GW
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
      parameters:
        mode: active-backup
        primary: $CABLE
        primary-reselect-policy: failure
        fail-over-mac-policy: active
        arp-interval: 2000
        arp-ip-targets: [$GW]
        arp-validate: active
        arp-all-targets: any
EOF
  chmod 600 "$OURS.tmp"
  mv -f "$OURS.tmp" "$OURS"
}

# Put back exactly what was in /etc/netplan before the fallback.
restore_files() {
  [ -d "$BK/netplan" ] || { say "No saved network setup found in $BK."; return 1; }
  rm -f "$OURS" "$OURS.tmp"
  cp -a "$BK/netplan/." "$NP/"
  [ -f "$BK/made-cloud-init-file" ] && rm -f "$CI"
  return 0
}

rollback() {
  say "Putting the old network setup back..."
  restore_files || return 1
  ip link del "$BOND" 2>/dev/null || true
  netplan generate >>"$LOG" 2>&1 || true
  netplan apply >>"$LOG" 2>&1 || true
  [ -n "${CABLE:-}" ] && ip link set "$CABLE" up 2>/dev/null
  [ -n "${WIFI:-}" ] && ip link set "$WIFI" up 2>/dev/null
  sleep 5
  restart_web
  rm -f "$STATE/pending"
  systemctl disable --quiet myassistant-net-guard.service 2>/dev/null || true
  say "Old setup is back: $(ip -4 -o addr show scope global | awk '{print $2, $4}' | tr '\n' ' ')"
}

# Bring both cards into the bond if networkd did not do it on a live switch.
ensure_slaves() {
  local n
  for n in "$CABLE" "$WIFI"; do
    if ! grep -qw "$n" /sys/class/net/$BOND/bonding/slaves 2>/dev/null; then
      ip addr flush dev "$n" 2>/dev/null || true
      ip link set "$n" down 2>/dev/null || true
      ip link set "$n" master "$BOND" 2>/dev/null || true
      ip link set "$n" up 2>/dev/null || true
    fi
    ip -4 addr flush dev "$n" 2>/dev/null || true
  done
}

# Runs detached (systemd), so it finishes even if the SSH window closes.
apply_guarded() {
  need_root
  load_conf
  mkdir -p "$STATE"
  if [ "${1:-}" != "--no-apply" ]; then
    say "Switching the network now (it may pause for a few seconds)..."
    netplan apply >>"$LOG" 2>&1 || say "netplan apply reported a problem (checking anyway)"
  else
    say "Checking the network after start-up..."
  fi
  local t=0 ok=0
  while [ "$t" -lt "$WAIT_SECS" ]; do
    if [ -d /sys/class/net/$BOND ]; then
      ensure_slaves
      if ip -4 addr show "$BOND" | grep -q "inet $IP/" && [ -n "$(active_nic)" ] && gw_ok; then ok=1; break; fi
    fi
    sleep 3; t=$((t + 3))
  done
  if [ "$ok" -ne 1 ]; then
    say "Could not reach the router ($GW) within $WAIT_SECS seconds."
    rollback
    say "RESULT: ROLLED BACK"
    return 1
  fi
  rm -f "$STATE/pending"
  restart_web
  say "Network is up on the $(name_of "$(active_nic)") ($(active_nic)), address $IP."
  test_other || true
  say "RESULT: OK"
}

# Try the other connection for a moment so we know the fallback really works.
test_other() {
  local cur other t=0
  cur=$(active_nic)
  if [ "$cur" = "$CABLE" ]; then other=$WIFI; else other=$CABLE; fi
  say "Testing the backup ($(name_of "$other"))..."
  if ! echo "$other" > /sys/class/net/$BOND/bonding/active_slave 2>/dev/null; then
    say "BACKUP NOT READY: the $(name_of "$other") connection is not passing traffic. Check VirtualBox Adapter settings."
    return 1
  fi
  # Give the bond's own router check time to reject a dead path (it checks every 2 s).
  sleep 7
  while [ "$t" -lt 20 ]; do
    if [ "$(active_nic)" = "$other" ] && gw_ok; then
      say "Backup works: the $(name_of "$other") reaches the router."
      echo "$cur" > /sys/class/net/$BOND/bonding/active_slave 2>/dev/null || true
      sleep 2
      say "Back on the $(name_of "$(active_nic)")."
      return 0
    fi
    sleep 2; t=$((t + 2))
  done
  say "BACKUP NOT READY: the $(name_of "$other") could not reach the router. Check VirtualBox Adapter settings."
  echo "$cur" > /sys/class/net/$BOND/bonding/active_slave 2>/dev/null || true
  return 1
}

install_guard() {
  cat > "$GUARD" <<'EOF'
[Unit]
Description=My Assistant network fallback: undo a network change that never got confirmed
ConditionPathExists=/var/lib/myassistant-net/pending
After=systemd-networkd.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/myassistant-net apply-guarded --no-apply

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --quiet myassistant-net-guard.service 2>/dev/null || true
}

do_install() {
  need_root
  say "== My Assistant: cable + Wi-Fi fallback =="
  command -v netplan >/dev/null || die "netplan is not on this system (this script is for Ubuntu Server)."
  command -v systemd-run >/dev/null || die "systemd-run is missing."
  modprobe bonding 2>/dev/null || [ -d /sys/module/bonding ] || die "this kernel has no bonding support (run: sudo apt install linux-generic, reboot, try again)."
  load_conf
  valid_ip "$IP" || die "MA_IP '$IP' is not an address."
  valid_ip "$GW" || die "router address '$GW' is not an address (set MA_GW=192.168.1.1)."

  local nics count
  nics=$(list_nics)
  count=$(echo "$nics" | grep -c .)
  say "Network cards found: $(echo "$nics" | tr '\n' ' ')"
  if [ -z "$WIFI" ] || [ -z "$CABLE" ]; then
    if [ "$count" -lt 2 ]; then
      say ""
      say "Only one network card is turned on in VirtualBox."
      say "Shut the VM down, then in VirtualBox: Settings, Network, Adapter 2:"
      say "  tick Enable Network Adapter, Attached to: Bridged Adapter,"
      say "  Name: the PC's cable (Ethernet) card. OK. Start the VM, run this again."
      say "Nothing was changed."
      exit 1
    fi
    WIFI=$(echo "$nics" | sed -n 1p)
    CABLE=$(echo "$nics" | sed -n 2p)
  fi
  [ -e "/sys/class/net/$CABLE" ] || die "card $CABLE not found (set MA_CABLE=...)."
  [ -e "/sys/class/net/$WIFI" ] || die "card $WIFI not found (set MA_WIFI=...)."
  [ "$CABLE" != "$WIFI" ] || die "cable and Wi-Fi are the same card ($CABLE)."
  say "Cable (Adapter 2): $CABLE    Wi-Fi (Adapter 1): $WIFI"
  say "Address $IP/$PFX, router $GW"

  mkdir -p "$STATE"
  if [ ! -d "$BK/netplan" ]; then
    mkdir -p "$BK/netplan"
    cp -a "$NP/." "$BK/netplan/" 2>/dev/null || true
    rm -f "$BK/netplan/$(basename "$OURS")"
    say "Saved the old network setup in $BK"
  else
    say "Old network setup already saved in $BK (kept as is)"
  fi

  # Our file replaces every other netplan file (they are in the backup).
  local f
  for f in "$NP"/*.yaml "$NP"/*.yml; do
    [ -e "$f" ] || continue
    [ "$f" = "$OURS" ] && continue
    rm -f "$f"
  done
  if [ -d /etc/cloud/cloud.cfg.d ] && [ ! -f "$CI" ]; then
    echo "network: {config: disabled}" > "$CI"
    touch "$BK/made-cloud-init-file"
  fi
  write_yaml
  save_conf

  if ! netplan generate >>"$LOG" 2>&1; then
    say "The new setup did not pass netplan's check:"
    tail -n 5 "$LOG"
    restore_files; netplan generate >/dev/null 2>&1 || true
    die "nothing was switched; your old setup is still in place."
  fi
  say "New setup checked."

  touch "$STATE/pending"
  install_guard
  : > "$STATE/run.log"
  local unit
  unit="myassistant-net-apply-$(date +%s)"
  systemd-run --quiet --unit="$unit" --collect \
    /bin/bash -c "/usr/local/sbin/myassistant-net apply-guarded > $STATE/run.log 2>&1" \
    || die "could not start the switch."
  say "Switching now. If the router can't be reached within $WAIT_SECS seconds, the old setup comes back by itself."

  # Follow the detached run (safe even if this window disconnects).
  local t=0 seen=0 lines
  while [ "$t" -lt $((WAIT_SECS + 90)) ]; do
    lines=$(wc -l < "$STATE/run.log" 2>/dev/null || echo 0)
    if [ "$lines" -gt "$seen" ]; then
      sed -n "$((seen + 1)),${lines}p" "$STATE/run.log"
      seen=$lines
    fi
    grep -q '^RESULT:' "$STATE/run.log" 2>/dev/null && break
    sleep 2; t=$((t + 2))
  done
  echo
  if grep -q '^RESULT: OK' "$STATE/run.log" 2>/dev/null; then
    echo "DONE. The VM now uses cable first and switches to Wi-Fi by itself."
    echo "Check any time:  sudo myassistant-net status"
    echo "Undo:            sudo myassistant-net undo"
  elif grep -q '^RESULT: ROLLED BACK' "$STATE/run.log" 2>/dev/null; then
    echo "NOT DONE. The new setup could not reach the router, so the old one is back."
    exit 1
  else
    echo "Still working. Check in a minute:  sudo myassistant-net status"
  fi
}

do_status() {
  load_conf
  if [ ! -f "$OURS" ]; then echo "Fallback is not installed."; ip -4 -o addr show scope global | awk '{print $2, $4}'; return 0; fi
  echo "Address: $IP   Router: $GW"
  echo "In use now: $(name_of "$(active_nic)") ($(active_nic))"
  local n st
  for n in "$CABLE" "$WIFI"; do
    st=$(awk -v n="$n" '$0=="Slave Interface: " n {f=1; next} f && /MII Status/ {print $3; exit}' /proc/net/bonding/$BOND 2>/dev/null)
    echo "  $(name_of "$n") ($n): ${st:-unknown}"
  done
  if gw_ok; then echo "Router: reachable"; else echo "Router: NOT reachable"; fi
  [ -f "$STATE/pending" ] && echo "(a switch is still being checked)"
  return 0
}

do_undo() {
  need_root
  say "== Undo: My Assistant cable + Wi-Fi fallback =="
  load_conf
  if [ ! -d "$BK/netplan" ]; then
    if [ -f "$OURS" ]; then die "no saved setup to go back to; remove $OURS by hand."; fi
    say "Fallback is not installed. Nothing to undo."; return 0
  fi
  rollback || die "could not restore."
  rm -f "$GUARD" "$CONF"; systemctl daemon-reload 2>/dev/null || true
  mv "$BK" "$BK.undone-$(date +%Y%m%d-%H%M%S)"
  echo "DONE. The old single-connection setup is back."
  echo "In VirtualBox you can now untick Adapter 2 (optional)."
}

case "${1:-install}" in
  install|"") do_install ;;
  apply-guarded) shift; apply_guarded "$@" ;;
  status) do_status ;;
  test) need_root; load_conf; [ -f "$OURS" ] || die "fallback is not installed."; test_other ;;
  undo|remove|uninstall) do_undo ;;
  *) echo "Use: myassistant-net [install|status|test|undo]"; exit 2 ;;
esac
MYASSISTANT_NET_EOF
chmod 755 /usr/local/sbin/myassistant-net.new
mv -f /usr/local/sbin/myassistant-net.new /usr/local/sbin/myassistant-net
exec /usr/local/sbin/myassistant-net "${1:-install}"
