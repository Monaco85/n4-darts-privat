# HeimDarts

Eigene Darterkennung mit Kameras – komplett offline und ohne Autodarts-Software. HeimDarts stellt
dieselbe lokale Schnittstelle bereit, die n4-darts vom Board Manager erwartet (Port 3180, siehe
[`docs/board-manager-api.md`](../../docs/board-manager-api.md)). n4-darts läuft deshalb unverändert darauf und liefert die
ganze Oberfläche: Stationen, Turniere, Statistiken, Beamer-Ansicht.

```
USB-Kameras ──► HeimDarts (Erkennung, :3180) ──► n4-darts (Spiel, :5173 / :3000)
```

## Starten

**Am einfachsten: fertiges Paket.** `heimdarts-windows.zip` aus den GitHub-Releases herunterladen,
entpacken und `HeimDarts starten.cmd` doppelklicken. Python, numpy und OpenCV sind dabei; es muss
nichts installiert werden und es braucht kein Internet. Gebaut wird das Paket mit
`python package.py` (lädt dafür einmal das eingebettete Python von python.org).

**Aus dem Quellcode:**

1. **Einmalig:** `install-heimdarts.cmd` doppelklicken. Das legt die Python-Umgebung unter
   `%USERPROFILE%\Tools\heimdarts-venv` an (kurzer Pfad, wegen der Windows-Pfadlänge) und braucht
   dafür einmal Internet.
2. **HeimDarts:** `start-heimdarts.cmd` doppelklicken. Die Einrichtungsseite öffnet sich unter
   <http://localhost:3180/>.

**Dann n4-darts:** mit dem echten Board starten (`start-echtes-board.cmd`, bei der Frage nach der
Adresse einfach **Enter**). Das Skript meldet „Board Manager gefunden, Version 2.0.2-heimdarts“.
Gespielt wird wie gewohnt auf der Station, z. B. <http://localhost:5173/station/1>.

Autodarts und HeimDarts nutzen beide Port 3180. Also nicht gleichzeitig laufen lassen, oder HeimDarts
mit `start-heimdarts.cmd --port 3190` starten und in n4-darts `localhost:3190` als Adresse eingeben.
Autodarts muss auch geschlossen sein, damit HeimDarts die Kameras öffnen kann.

## Einrichten (Einrichtungsseite)

1. **Kameras:** Unter *Einstellungen* „Kameras suchen“, die gefundenen Nummern (z. B. `0`, `1`, `2`)
   untereinander eintragen und „Übernehmen“.
2. **Kalibrieren:** Bei jeder Kamera „Kalibrieren“ und im Standbild fünf Punkte anklicken: viermal die
   Außenkante des Doppelrings an den Grenzen 20|1, 6|10, 3|19, 11|14 und zuletzt die Mitte des Bulls.
   Die kleine Scheibe rechts zeigt, welcher Punkt dran ist; die Lupe hilft beim Zielen. Danach liegt
   das gelbe Gitter im Livebild auf der Scheibe – sonst neu kalibrieren.
3. **Leere Scheibe:** Ohne Darts in der Scheibe „Leere Scheibe neu aufnehmen“ drücken.
4. **Prüfen:** „Erkennung einblenden“ anhaken und ein paar Darts werfen. Der rote Fleck ist der
   erkannte Dart, die türkise Linie seine Achse, der grüne Kreis die Spitze.

Mit mindestens **zwei, besser drei Kameras** ist die Erkennung genau: Jede Kamera liefert eine Linie
auf der Scheibe, auf der die Spitze liegen muss; der Schnittpunkt ist der Treffer. Mit nur einer
Kamera wird die sichtbare Spitze genommen – das ist deutlich ungenauer.

## So funktioniert die Erkennung

- Jede Kamera vergleicht das aktuelle Bild mit dem Bild vor dem Wurf. Nach einer kurzen Bewegung und
  wieder ruhigem Bild wird ausgewertet.
- Ein länglicher Fleck passender Größe ist ein neuer Dart. Nach drei Darts wird – wie beim Board
  Manager – bis zum Ziehen nichts mehr gezählt.
- Eine große, längere Bewegung ist eine Hand („Takeout started“). Sieht die Scheibe danach wieder aus
  wie leer, meldet HeimDarts „Takeout finished“ und n4-darts wechselt den Spieler.
- „Reset“, „Stopp/Start“ und „Kalibrieren“ aus dem Board-Menü von n4-darts funktionieren. „Kalibrieren“
  nimmt dabei die leere Scheibe neu auf (die Kalibrierung selbst geschieht hier per Klick).

## Grenzen (Stand 0.1)

- Getestet ist alles mit simulierten Kameras. Mit den echten Kameras müssen sehr wahrscheinlich die
  Regler nachgestellt werden (Empfindlichkeit, kleinster/größter Dart).
- Linsenverzerrung von Weitwinkelkameras wird nicht ausgeglichen; am Rand der Scheibe kann das ein
  paar Millimeter kosten.
- Starke Schatten können als Teil des Darts erkannt werden. Gleichmäßiges Licht (LED-Ring) hilft.
- Abpraller und Darts neben der Scheibe ohne Spur werden nicht erkannt. Die trägt man an der Station
  in n4-darts nach.

## Simulation (ohne Kameras)

`start-heimdarts.cmd --sim` startet drei simulierte Kameras. Ein Klick auf die Scheibe der
Einrichtungsseite „wirft“ einen Dart, der durch die echte Bilderkennung läuft; „Darts ziehen“ simuliert
die Hand. So lässt sich n4-darts ohne Board ausprobieren. Die gespeicherten Kameraeinstellungen
bleiben dabei unberührt.

## Für Entwickler

```
%USERPROFILE%\Tools\heimdarts-venv\Scripts\python.exe -m pip install pytest
%USERPROFILE%\Tools\heimdarts-venv\Scripts\python.exe -m pytest
```

| Datei | Inhalt |
| --- | --- |
| `heimdarts/board.py` | Maße der Scheibe, Wertung, Kalibrierpunkte |
| `heimdarts/calibration.py` | Homographie Kamerabild ↔ Scheibe |
| `heimdarts/detector.py` | Bilddifferenz, Dartachse, Schnittpunkt mehrerer Kameras, Takeout |
| `heimdarts/bridge.py` | Zustand im Board-Manager-Format |
| `heimdarts/server.py`, `ws.py` | HTTP, WebSocket `/api/events`, Einrichtungsseite |
| `heimdarts/sim.py` | Simulierte Kameras und Darts für Tests |

Optionen: `--port 3180`, `--lan` (aus dem Heimnetz erreichbar, z. B. wenn n4-darts auf einem anderen
PC läuft), `--sim`, `--data ORDNER`, `--open`.
