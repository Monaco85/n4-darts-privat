#!/usr/bin/env bash
# n4-darts (Linux-Paket): startet den Server und, wenn gewuenscht, das simulierte Board.
#   ./darts-starten.sh      mit dem echten Autodarts-Board (fragt nach der Adresse)
#   ./darts-simulator.sh    mit einem Board zum Anklicken
# Optionen: --simulator, --board <adresse>, --no-browser
# Braucht Node.js 22+. Fehlt es, wird es einmalig (ohne Root-Rechte) in den Ordner "node" geladen.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
NODE_VERSION="v24.22.1"
RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
step() { printf '\n%s==> %s%s\n' "$RED" "$1" "$RESET"; }

SIMULATOR=0
BOARD=""
BROWSER=1
while [ $# -gt 0 ]; do
  case "$1" in
    --simulator) SIMULATOR=1 ;;
    --board) BOARD="${2:-}"; shift ;;
    --no-browser) BROWSER=0 ;;
    *) echo "Unbekannte Option: $1"; exit 2 ;;
  esac
  shift
done

# --- Node.js -------------------------------------------------------------------------------
step "Pruefe Node.js"
NODE=""
if [ -x "$ROOT/node/bin/node" ]; then
  NODE="$ROOT/node/bin/node"
elif command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v//; s/\..*//')"
  if [ "${major:-0}" -ge 22 ]; then NODE="$(command -v node)"; fi
fi
if [ -z "$NODE" ]; then
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "${RED}Node.js 22+ fehlt und fuer $(uname -m) kann ich es nicht laden.${RESET} Bitte selbst installieren (https://nodejs.org)."; exit 1 ;;
  esac
  echo "Node.js 22+ fehlt. Lade Node.js $NODE_VERSION ($arch) einmalig in $ROOT/node ..."
  url="https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$arch.tar.xz"
  mkdir -p "$ROOT/node"
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$url"; else wget -qO- "$url"; fi \
    | tar -xJ -C "$ROOT/node" --strip-components=1
  NODE="$ROOT/node/bin/node"
fi
echo "Node.js $("$NODE" -v) ok"

# --- Board-Adresse --------------------------------------------------------------------------
if [ "$SIMULATOR" = 1 ]; then
  BOARD="http://localhost:3180"
elif [ -z "$BOARD" ]; then
  echo
  echo "Adresse des PCs, auf dem Autodarts laeuft."
  echo "Einfach Enter druecken, wenn es dieser PC ist (http://localhost:3180)."
  echo "Sonst z. B. 192.168.178.50 eingeben."
  read -r -p "Adresse: " BOARD || true
fi
BOARD="${BOARD:-http://localhost:3180}"
case "$BOARD" in http://*|https://*) ;; *) BOARD="http://$BOARD" ;; esac
BOARD="${BOARD%/}"
if ! printf '%s' "$BOARD" | grep -Eq ':[0-9]+$'; then BOARD="$BOARD:3180"; fi

export DATA_DIR="$ROOT/data" WEB_DIR="$ROOT/web" STATIONS="1=$BOARD" MAX_STATIONS=1 PORT=3000

PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ "$SIMULATOR" = 1 ]; then
  step "Starte das simulierte Board (Port 3180)"
  "$NODE" "$ROOT/sim.mjs" --boards 1 &
  PIDS+=("$!")
fi

step "Starte n4-darts fuer das Board unter $BOARD"
"$NODE" "$ROOT/server.mjs" &
PIDS+=("$!")

up=0
for _ in $(seq 1 60); do
  sleep 0.5
  if "$NODE" -e 'fetch("http://localhost:3000/api/health").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))'; then up=1; break; fi
done
if [ "$up" != 1 ]; then echo "${RED}FEHLER: Der Server ist nicht gestartet (Meldungen oben).${RESET}"; exit 1; fi

# Station 1 auf das Board stellen (STATIONS gilt nur fuer eine neue Datenbank).
"$NODE" -e '
  fetch("http://localhost:3000/api/admin/stations/1", { method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Station 1", boardUrl: process.argv[1] }) }).catch(() => {});
' "$BOARD" || true

version="$("$NODE" -e '
  fetch(process.argv[1] + "/api/version", { signal: AbortSignal.timeout(3000) })
    .then(r => r.ok ? r.text() : "").then(t => console.log(t.trim()), () => console.log(""));
' "$BOARD")"

echo
echo "${RED}================================================${RESET}"
echo "${BOLD} n4-darts laeuft!${RESET}"
echo "  Spielen : http://localhost:3000/station/1"
if [ "$SIMULATOR" = 1 ]; then
  echo "  Fake-Board: http://localhost:3180/"
elif [ -n "$version" ]; then
  echo "  ${GREEN}Autodarts Board Manager gefunden, Version $version${RESET}"
else
  echo "  ${YELLOW}ACHTUNG: Unter $BOARD antwortet kein Autodarts Board Manager!${RESET}"
fi
echo "  Stats   : $DATA_DIR/spieler-stats.json"
echo " Beenden: Strg+C oder dieses Fenster schliessen"
echo "${RED}================================================${RESET}"

if [ "$BROWSER" = 1 ] && command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  xdg-open "http://localhost:3000/station/1" >/dev/null 2>&1 || true
  if [ "$SIMULATOR" = 1 ]; then xdg-open "http://localhost:3180/" >/dev/null 2>&1 || true; fi
fi

wait
