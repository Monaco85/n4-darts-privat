#!/usr/bin/env bash
# n4-darts beim Einschalten automatisch starten (Linux, ohne Root-Rechte).
#   ./autostart.sh                  einrichten (fragt nach der Autodarts-Adresse)
#   ./autostart.sh --kiosk          zusaetzlich den Browser im Vollbild auf der Station oeffnen
#   ./autostart.sh --entfernen      Autostart wieder abschalten
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/n4-darts.service"
DESKTOP="$HOME/.config/autostart/n4-darts-kiosk.desktop"

if [ "${1:-}" = "--entfernen" ]; then
  systemctl --user disable --now n4-darts.service 2>/dev/null || true
  rm -f "$UNIT" "$DESKTOP"
  systemctl --user daemon-reload || true
  echo "Autostart entfernt."
  exit 0
fi

KIOSK=0
[ "${1:-}" = "--kiosk" ] && KIOSK=1

echo "Adresse des PCs, auf dem Autodarts laeuft (Enter = dieser PC, http://localhost:3180):"
read -r -p "Adresse: " BOARD || true
BOARD="${BOARD:-http://localhost:3180}"

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=n4-darts (lokal Darts spielen)
After=network.target

[Service]
ExecStart=$ROOT/start.sh --board $BOARD --no-browser
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now n4-darts.service
# Auch ohne Anmeldung starten, sobald der Rechner laeuft (wenn erlaubt).
loginctl enable-linger "$USER" 2>/dev/null || true
echo "n4-darts startet jetzt bei jedem Einschalten. Status: systemctl --user status n4-darts"

if [ "$KIOSK" = 1 ]; then
  browser=""
  for b in chromium chromium-browser google-chrome firefox; do
    if command -v "$b" >/dev/null 2>&1; then browser="$b"; break; fi
  done
  if [ -z "$browser" ]; then
    echo "Kein Chromium/Chrome/Firefox gefunden - Kiosk-Start uebersprungen."
    exit 0
  fi
  case "$browser" in
    firefox) cmd="firefox --kiosk http://localhost:3000/station/1" ;;
    *) cmd="$browser --kiosk --noerrdialogs --disable-infobars --autoplay-policy=no-user-gesture-required http://localhost:3000/station/1" ;;
  esac
  mkdir -p "$(dirname "$DESKTOP")"
  cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=n4-darts Station
Exec=sh -c "sleep 8; $cmd"
X-GNOME-Autostart-enabled=true
EOF
  echo "Nach dem Anmelden oeffnet sich die Station im Vollbild ($browser)."
fi
