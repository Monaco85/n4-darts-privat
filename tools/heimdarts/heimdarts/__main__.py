"""Start: python -m heimdarts [--port 3180] [--lan] [--sim] [--data ORDNER] [--open]"""
from __future__ import annotations

import argparse
import os
import sys
import time
import webbrowser

from .app import HeimDarts
from .server import serve


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    p = argparse.ArgumentParser(prog="heimdarts", description="Eigene Darterkennung für n4-darts")
    p.add_argument("--port", type=int, default=3180, help="Port (n4-darts erwartet 3180)")
    p.add_argument("--lan", action="store_true", help="auch aus dem Heimnetz erreichbar (Standard: nur dieser PC)")
    p.add_argument("--sim", action="store_true", help="mit drei simulierten Kameras starten (gespeicherte Einstellungen bleiben unberührt)")
    p.add_argument("--data", default=os.path.join(root, "data"), help="Ordner für Einstellungen")
    p.add_argument("--open", action="store_true", help="Einrichtungsseite im Browser öffnen")
    a = p.parse_args()

    if sys.stdout and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    app = HeimDarts(a.data, force_sim=a.sim)
    host = "0.0.0.0" if a.lan else "127.0.0.1"
    try:
        httpd = serve(app, host, a.port)
    except OSError as e:
        print(f"Port {a.port} ist belegt ({e}). Läuft Autodarts oder HeimDarts schon? Anderen Port mit --port wählen.")
        app.close()
        sys.exit(1)
    url = f"http://localhost:{a.port}/"
    print(f"HeimDarts läuft: {url}")
    print(f"n4-darts: Board-Adresse http://localhost:{a.port} (bei start-echtes-board.cmd einfach Enter)")
    if app.has_sim:
        print("Hinweis: simulierte Kameras aktiv. Echte Kameras auf der Einrichtungsseite eintragen.")
    print("Beenden mit Strg+C")
    if a.open:
        webbrowser.open(url)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
        app.close()


if __name__ == "__main__":
    main()
