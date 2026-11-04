# HeimDarts – Übergabe (Stand 04.11.2026)

Diese Datei fasst zusammen, was bisher gebaut, entschieden und herausgefunden wurde, damit die Arbeit
auf dem PC mit den Kameras nahtlos weitergehen kann – egal ob von Hand oder mit Claude Code.

## Worum es geht

- **Ziel:** Darts offline spielen, ohne Autodarts-Software und ohne Internet, mit der Oberfläche von
  **n4-darts** (dieses Repo). Hardware: Winmau-Board (Blade 6) im Winmau-Ring mit drei USB-Kameras
  (1280×720).
- **HeimDarts** (`tools/heimdarts`) ist eine **eigene** Darterkennung in Python/OpenCV. Sie stellt
  dieselbe lokale Schnittstelle bereit, die n4-darts vom Board Manager erwartet
  ([`docs/board-manager-api.md`](../../docs/board-manager-api.md), Port 3180). n4-darts läuft
  unverändert darauf.
- **Grenze:** HeimDarts enthält keinen Code und kein Modell von Autodarts und umgeht keine
  Lizenz- oder Kontoprüfung. Autodarts und HeimDarts nicht gleichzeitig laufen lassen (gleicher Port,
  gleiche Kameras).

## Stand

| Version | Inhalt | Wo |
| --- | --- | --- |
| 0.1.0 | Erkennung, Board-Manager-API, Einrichtungsseite, Simulation, Windows-Paket | `main`, Release `heimdarts-v0.1.0` |
| 0.2.0 | Autokalibrierung, Bildrate 5–30 FPS | `main`, Release `heimdarts-v0.2.0` |
| **dieser Branch** | Autokalibrierung für **echte** Bilder umgebaut, Bildrate korrekt begrenzt und angezeigt | Branch `heimdarts-echte-kameras` |

**Getestet:** 51 pytest-Tests (alle mit simulierten Kameras bzw. nachgebauter Kamera), dazu die
Autokalibrierung an drei echten Kamerabildern aus einem Screenshot (Auflösung ~610×343, auch auf
1280 hochskaliert): Scheibe überall gefunden, 32–37 Feldgrenzen, ±1,4–2,2 px, Gitter liegt sichtbar
richtig. **Nicht getestet:** echte Kameras live, echte Darts, n4-darts-Station mit HeimDarts.

## Befunde an den echten Bildern (warum 0.2.0 dort scheiterte)

- 0.2.0 meldete „nur 3 Feldgrenzen“ bzw. „Keine Scheibe gefunden“. Ursachen:
  1. **Farben blass:** Unter dem LED-Licht ist Rot eher rosa (OpenCV-Farbton 172–179 und 0–2,
     Sättigung 45–120), Grün mintfarben (Farbton 69–74, Sättigung 42–117). Die alte Schwelle (S ≥ 110
     zuerst) war zu streng.
  2. **Ferne Seite dünn:** Der Doppelring ist auf der kameraabgewandten Seite nur 1–3 px breit und
     zerfällt in Stücke. Die alte Suche erwartete einen zusammenhängenden Ring.
  3. **Logos neben dem Doppelring:** „BLADE 6“ (rot), „PDC“ (rot/blau), „Triple Core“ (orange/rot)
     liegen auf dem Zahlenring direkt außerhalb des Doppelrings.
  4. Weitwinkel-Kameras, flacher Blickwinkel.
- **Lösung in diesem Branch** (`heimdarts/autocal.py`): großzügige Farbmasken (S ≥ 42, V ≥ 55);
  zuerst das **Bull** suchen (kleiner roter Fleck mit grünem Ring); von dort **720 Strahlen** nach
  außen; je Strahl das Lauf-Paar „Triple, dann Doppel“ am Radienverhältnis 1,35–1,95 (Soll 170/107 =
  1,59). Logos liegen weiter außen und fallen raus, Lücken kosten nur einzelne Strahlen. Farbwechsel
  zwischen Strahlen = Segmentgrenze (fein nachgetastet). Danach wie gehabt: Zuordnung über ein
  lückenloses Stück, Homographie, Feinabgleich an allen Ringkanten (Levenberg-Marquardt, Huber).
- **Bildrate-Anzeige 84 FPS bei Einstellung 15:** Die Anzeige mittelte Kehrwerte der Bildabstände
  (einzelne kurze Abstände trieben sie hoch), und die Taktung ließ nach Verspätungen kurze Folgen
  durch. Jetzt: strikter Mindestabstand, Zählung über 2 s. Angezeigt wird „15 FPS (Kamera liefert
  60)“, wenn die Kamera die Wunschrate ignoriert.

## Nächste Schritte auf dem Kamera-PC

1. **Diesen Branch starten** (siehe unten) und „Alle automatisch kalibrieren“ drücken. Erwartung:
   alle drei Kameras finden die Scheibe; beim ersten Mal ggf. einmal ins Feld der 20 klicken.
2. **Gitter prüfen** (Livebild mit Einblendung): Liegt es auf den Ringen? Wenn nicht: Standbild
   speichern (`http://localhost:3180/hd/camera/0.jpg?overlay=0`, ebenso 1 und 2) und mit
   `auto_calibrate()` lokal untersuchen. Stellschrauben:
   - `color_masks()` – Farbton-/Sättigungsgrenzen
   - `cast_rays()` – Radienverhältnis (1,35–1,95), Mindest-Innen/Außen-Verhältnis der Ringe
   - `find_bull()` – wenn „Bull nicht gefunden“
   - Zahlenring-Erkennung der 20: Schwellen in `auto_calibrate()` (Score ≥ 0,6, Abstand ≥ 0,25)
3. **Bildrate prüfen:** Steht unter der Kamera „(Kamera liefert …)“, ignoriert die Kamera die
   Wunschrate (DirectShow). Dann wird zwar nur jedes n-te Bild umgewandelt, aber die Kamera liefert
   weiter alle. Falls die CPU-Last zu hoch bleibt: in `cameras.py` `CAP_PROP_FOURCC` (MJPG) vor
   Auflösung/FPS setzen oder das Backend `cv2.CAP_MSMF` probieren – vorher testen, ob die Kameras
   damit noch Bilder liefern.
4. **Echte Darts werfen** („Erkennung einblenden“ anhaken): roter Fleck = Dart, türkise Linie = Achse,
   grüner Kreis = Spitze. Regler unter *Einstellungen* (Empfindlichkeit, kleinster/größter Dart)
   anpassen. Schatten und Spiegelungen sind die wahrscheinlichsten Störquellen.
5. **Mit n4-darts spielen:** HeimDarts starten, dann `start-echtes-board.cmd` (Adresse = Enter).
6. **Linsenverzerrung** (nur falls am Scheibenrand ungenau): das Modell ist eine reine Homographie.
   Eine radiale Verzerrung (k1) ließe sich in `refine_with_edges()` als zusätzlicher Parameter
   ergänzen.
7. Wenn alles passt: Pull Request zusammenführen, `python package.py` (Ordner `tools/heimdarts`),
   neue Release mit `release/heimdarts-windows.zip`.

## Starten aus diesem Branch (auf dem Kamera-PC)

```
git clone https://github.com/Monaco85/n4-darts-privat.git
cd n4-darts-privat
git checkout heimdarts-echte-kameras
cd tools\heimdarts
install-heimdarts.cmd      (einmalig, braucht Python 3.11+ und einmal Internet)
start-heimdarts.cmd        (Einrichtungsseite: http://localhost:3180/)
```

Den Ordner `data` (Einstellungen, Kalibrierungen) aus einer älteren Version kann man übernehmen.
Ohne Python: `python package.py` auf einem PC mit Python ausführen und die ZIP mitnehmen.

## Wichtige Dateien

| Datei | Inhalt |
| --- | --- |
| `heimdarts/autocal.py` | Autokalibrierung (Bull, Strahlen, Grenzen, Feinabgleich, Lage der 20) |
| `heimdarts/detector.py` | Darterkennung (Bilddifferenz, Achse, Schnitt der Kameralinien, Takeout) |
| `heimdarts/calibration.py` | Homographie, Gitter-Einblendung |
| `heimdarts/cameras.py` | Kameras/Videodateien/Simulation, Bildratenbegrenzung |
| `heimdarts/bridge.py`, `server.py`, `ws.py` | Board-Manager-Schnittstelle für n4-darts, Einrichtungsseite |
| `heimdarts/app.py` | Zusammenspiel, Konfiguration (`data/config.json`) |
| `heimdarts/sim.py` | Simulierte Kameras und Darts |
| `tests/` | pytest (`python -m pytest` im Ordner `tools/heimdarts`) |
| `package.py` | Windows-Paket mit eingebettetem Python |

Nützliche Endpunkte: `GET /hd/status`, `GET /hd/camera/<n>.jpg?overlay=0|1&debug=0|1`,
`POST /hd/autocalibrate {"cam": n}` (ohne `cam`: alle), `POST /hd/calibration/twenty {"cam","x","y"}`,
`POST /hd/calibration/rotate {"cam","steps"}`, `POST /hd/fps {"fps"}`; n4-darts nutzt `/api/*`.

## Sonstiges

- **CI:** Rot waren bisher nur zwei Zeittests von n4-darts (`packages/server/src/load.test.ts`,
  `packages/e2e/tests/latency.spec.ts`: einzelne Ausreißer über 150 ms auf GitHub-Rechnern), nie
  HeimDarts. `tools/heimdarts` ist in `biome.json` vom Lint ausgenommen; die Python-Tests laufen nicht
  in der CI.
- **GitHub:** Auto-Merge ist im Repo erlaubt, greift aber nur mit einer Schutzregel für `main` mit
  Pflicht-Checks – die gibt es nicht (bewusst nicht angelegt).
- **Python-Pfad:** Die Entwicklungs-Umgebung liegt unter `%USERPROFILE%\Tools\heimdarts-venv` (kurzer
  Pfad wegen der Windows-Pfadlänge).
