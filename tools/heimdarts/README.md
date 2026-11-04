# HeimDarts

Eigene Darterkennung mit Kameras – komplett offline und ohne Autodarts-Software. HeimDarts stellt
dieselbe lokale Schnittstelle bereit, die n4-darts vom Board Manager erwartet (Port 3180, siehe
[`docs/board-manager-api.md`](../../docs/board-manager-api.md)). n4-darts läuft deshalb unverändert darauf und liefert die
ganze Oberfläche: Stationen, Turniere, Statistiken, Beamer-Ansicht.

Stand, Befunde und nächste Schritte stehen in [`UEBERGABE.md`](UEBERGABE.md).

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
2. **Kalibrieren – automatisch:** „Alle automatisch kalibrieren“ drücken. HeimDarts findet die Scheibe
   selbst über den roten und grünen Doppel- und Triple-Ring, die Feldgrenzen und die Bull-Mitte.
   Beim allerersten Mal öffnet sich danach ein Fenster mit dem Kamerabild: Liegt die gelbe **20**
   nicht auf der echten 20, **einmal irgendwo ins Feld der echten 20 klicken** (oder mit „Drehen“
   korrigieren). Bei jeder späteren Kalibrierung wird die Lage der 20 übernommen – dann geht alles
   ohne Klick, auch über „Kalibrieren“ im Board-Menü von n4-darts.
   Neue Kameras ohne Kalibrierung werden beim Start einmal von selbst automatisch kalibriert.
   *Von Hand (5 Punkte)* gibt es im Kalibrierfenster weiterhin als Ausweg.
3. **Leere Scheibe:** Ohne Darts in der Scheibe „Leere Scheibe neu aufnehmen“ drücken.
4. **Bildrate:** Unter *Einstellungen* zwischen 5 und 30 Bildern pro Sekunde einstellbar (Standard 15).
   Unter jeder Kamera steht die verwendete Rate; liefert die Kamera mehr, steht das in Klammern dabei.
   Weniger Bilder = weniger Last für den PC; 10–15 reichen zum Spielen. Die Wartezeiten der Erkennung
   (ruhiges Bild, Hand) gelten in Sekunden und passen sich der Bildrate an.
5. **Prüfen:** „Erkennung einblenden“ anhaken und ein paar Darts werfen. Der rote Fleck ist der
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
  kalibriert alle Kameras automatisch neu und nimmt die leere Scheibe neu auf.

## So funktioniert die Autokalibrierung

1. Rote und grüne Pixel suchen (großzügig – unter LED-Licht wirkt Rot oft rosa, Grün blass) und das
   Bull finden: kleiner roter Fleck mit grünem Ring.
2. Vom Bull aus 720 Strahlen nach außen: Auf jedem Strahl das Paar „Triple-Ring, dann Doppelring“ am
   Größenverhältnis 107:170 erkennen. Logos und Aufkleber neben der Scheibe und blasse oder dünne
   Ringstücke stören so nur einzelne Strahlen.
3. Wo die Ringfarbe von Strahl zu Strahl wechselt, liegt eine Segmentgrenze (bis zu 40 Punkte mit
   bekannter Lage); dazu die Bull-Mitte. Feinabgleich an den Kanten aller Farbringe. In der
   Simulation liegt die Abweichung danach bei 0,2–0,3 mm (höchstens 0,5 mm; von Hand geklickt ~1 mm).
4. Die Farben wiederholen sich alle zwei Felder – welches rote Feld die 20 ist, kommt von der vorigen
   Kalibrierung, sonst vom Zahlenring (nur wenn eindeutig), sonst von deinem einen Klick.

## Grenzen (Stand 0.2.1)

- Die Autokalibrierung braucht eine normale Steeldartscheibe mit roten und grünen Ringen und Licht, bei
  dem die Farben kräftig erscheinen. Klappt es nicht, sagt die Meldung unter der Kamera warum.
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
