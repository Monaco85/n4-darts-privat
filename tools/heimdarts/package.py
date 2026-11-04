"""Baut das Windows-Paket release/heimdarts-windows.zip.

Darin steckt ein eigenes Python (Embeddable Package von python.org) samt numpy und OpenCV, der
HeimDarts-Code und die Start-Dateien. Auf dem Ziel-PC muss nichts installiert werden, und es braucht
kein Internet.

Aufruf (braucht einmal Internet zum Herunterladen):  python package.py [--python 3.13.14]
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from importlib.metadata import version as pkg_version
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RELEASE = ROOT / "release"
CRLF = "\r\n"


def crlf(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\n", CRLF)


def download(url: str, target: Path) -> Path:
    if not target.exists():
        print(f"== Lade {url}")
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".part")
        with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        tmp.replace(target)
    return target


def cmd_file(title: str, args: str) -> str:
    return crlf(f"""@echo off
title {title}
cd /d "%~dp0"
"%~dp0python\\python.exe" -m heimdarts --data "%~dp0data" --open {args}%*
echo.
pause
""")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--python", default="3.13.14", help="Python-Version des eingebetteten Pythons")
    a = p.parse_args()
    major_minor = "".join(a.python.split(".")[:2])
    version = (ROOT / "pyproject.toml").read_text(encoding="utf-8").split('version = "', 1)[1].split('"', 1)[0]

    out = RELEASE / "heimdarts-windows"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)

    # 1) Eingebettetes Python
    embed = download(f"https://www.python.org/ftp/python/{a.python}/python-{a.python}-embed-amd64.zip",
                     RELEASE / "cache" / f"python-{a.python}-embed-amd64.zip")
    with zipfile.ZipFile(embed) as z:
        z.extractall(out / "python")
    # Suchpfade: Standardbibliothek, App-Code und mitgelieferte Pakete
    (out / "python" / f"python{major_minor}._pth").write_text(
        crlf(f"python{major_minor}.zip\n.\n..\\app\n..\\app\\lib\n"), encoding="ascii")

    # 2) numpy und OpenCV als fertige Windows-Pakete für genau diese Python-Version
    print("== Pakete für Windows holen")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--quiet",
                           "--target", str(out / "app" / "lib"), "--only-binary=:all:",
                           "--platform", "win_amd64", "--implementation", "cp",
                           "--python-version", major_minor, "-r", str(ROOT / "requirements.txt")])
    for junk in (out / "app" / "lib" / "bin",):
        shutil.rmtree(junk, ignore_errors=True)

    # 3) HeimDarts selbst
    shutil.copytree(ROOT / "heimdarts", out / "app" / "heimdarts",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))

    # 4) Start-Dateien und Kurzanleitung
    (out / "HeimDarts starten.cmd").write_text(cmd_file("HeimDarts - Darterkennung", ""), encoding="ascii")
    (out / "HeimDarts Simulation.cmd").write_text(cmd_file("HeimDarts - Simulation", "--sim "), encoding="ascii")
    reqs = (ROOT / "requirements.txt").read_text(encoding="utf-8").split()
    (out / "LIESMICH.txt").write_text(crlf(f"""HeimDarts {version} - eigene Darterkennung für n4-darts, komplett offline

Starten
  HeimDarts starten.cmd      mit den echten Kameras
  HeimDarts Simulation.cmd   zum Ausprobieren ohne Kameras (Klick auf die Scheibe = Wurf)
Die Einrichtungsseite öffnet sich unter http://localhost:3180/
Beenden: das schwarze Fenster schließen.

Mit n4-darts spielen
  1. HeimDarts starten.
  2. n4-darts mit dem echten Board starten und als Board-Adresse http://localhost:3180 nehmen
     (bei start-echtes-board.cmd einfach Enter drücken).
  Autodarts darf nicht gleichzeitig laufen: gleicher Port 3180 und dieselben Kameras.

Einrichten (auf der Einrichtungsseite)
  1. "Kameras suchen", die Nummern eintragen, "Übernehmen".
  2. Jede Kamera mit 5 Klicks kalibrieren (Doppel-Außenkante 20|1, 6|10, 3|19, 11|14, Bull-Mitte).
  3. Bei leerer Scheibe "Leere Scheibe neu aufnehmen".
  Zwei oder drei Kameras sind deutlich genauer als eine.

Einstellungen liegen im Ordner "data" - beim Aktualisieren behalten.
Enthalten: Python {a.python}, {", ".join(reqs)}. Es muss nichts installiert werden.
Falls beim Start "DLL load failed" erscheint: "Microsoft Visual C++ Redistributable (x64)" installieren.
"""), encoding="utf-8-sig")

    # 5) ZIP
    zip_path = RELEASE / "heimdarts-windows.zip"
    zip_path.unlink(missing_ok=True)
    print("== ZIP packen")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in sorted(out.rglob("*")):
            if f.is_file():
                z.write(f, Path("heimdarts-windows") / f.relative_to(out))
    print(f"Fertig: {zip_path} ({zip_path.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    try:
        pkg_version("pip")
    except Exception:  # noqa: BLE001
        sys.exit("pip fehlt in diesem Python")
    main()
