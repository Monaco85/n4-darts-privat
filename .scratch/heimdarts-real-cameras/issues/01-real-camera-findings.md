# HeimDarts mit echten Kameras: Stand und offene Fehler

Status: done
Type: task

Erster Test von HeimDarts 0.2 mit den echten Kameras am 2026-11-04: drei USB-Kameras (MJPG, Winmau Blade 6 mit Surround, Kameras flach und nah am Ring), Windows 10, PC mit 2 Kernen.

## Erledigt

- **Autokalibrierung fand die Scheibe nicht.** Die Rot/Grün-Maske arbeitete mit HSV-Sättigung; die blassen Farben der echten Kameras fielen durch (Kamera 2: keine Scheibe, sonst 2–4 Feldgrenzen). Jetzt zuerst über den a*-Kanal (Lab), HSV als Rückfall (`autocal.py`). Ergebnis: 36–40 Feldgrenzen, ±1,0–1,6 px.
- **Kameras ignorierten die Bildrate und lasteten den PC aus.** Unter DirectShow wartet `cap.grab()` nicht auf ein neues Bild (≈380 000 Aufrufe/s), jeder Kamerathread drehte leer. Jetzt schläft der Thread bis zum nächsten fälligen Bild (`cameras.py`). Kameras liefern 15 statt 46–104 Bilder/s, Erkennung 14 statt 5 Durchläufe/s.
- **Auflösung 640×480** (`resolution` in `data/config.json`). Gemessen nur für die Kameras bei 15 Bildern/s: 1280×720 = 1,02 Kerne, 848×480 = 0,60, 640×480 = 0,37. HeimDarts gesamt: 1,43 → 0,49 Kerne.
- **Kalibrierung bei anderer Auflösung** wurde stillschweigend weiterbenutzt. Jetzt verworfen und automatisch neu gemacht (`app.py`).
- **Aufzeichnung pro Dart** in `data/aufnahmen/<zeit>/`: Graubild vorher/nachher je Kamera, `dart.json` mit Beobachtungen, Kalibrierungen und Reglern. Die letzten 60 bleiben; abschaltbar mit `"record_darts": false`.

## Würfe (640×480)

| Steckt in | Erkannt | Bemerkung |
| --- | --- | --- |
| 16, 7, 12 | S8, S9, S12 | vor der Aufzeichnung, Ursache unbekannt |
| 6 | S6 ✓ | Kameras 1+2+3 |
| 1 | S1 ✓ | Kameras 1+2+3 |
| D9 | S9 (als 4. Dart ignoriert) | nur Kamera 1, ~1 cm innen |

Zwischendurch kam ein falsches „S8“: HeimDarts war mit Darts in der Scheibe neu gestartet worden, die „leere Scheibe“ war also falsch und das Ziehen eines alten Darts zählte als neuer Dart. Kein Erkennungsfehler.

## Offen (nächste Schritte)

1. **Automatische Belichtung.** Bei der D9 wurde Kamera 3 schlagartig heller (Mittelwert 103 → 82), 55 % des Bildes galten als verändert, die Kamera fiel für diesen Dart aus. Belichtung fest einstellen (`CAP_PROP_AUTO_EXPOSURE`/`CAP_PROP_EXPOSURE` unter DirectShow) oder vor dem Vergleich die Helligkeit von vorher/nachher angleichen.
2. **Kamera sieht nur den Flight.** Darts auf der abgewandten Seite erscheinen bei Kamera 2 nur als Flight am oberen Bildrand (Elongation 1,5–2,7). Die Achse daraus ist Zufall, geht aber in den Schnittpunkt ein und verdrängt eine gute Kamera als Ausreißer. Solche Beobachtungen nicht für den Schnittpunkt nehmen (Mindestlänge in px / höhere Elongation).
3. **Eine-Kamera-Rückfall** ist zu ungenau für Doppel (D9 → S9). Lieber mit zwei Linien rechnen, sobald 1. und 2. behoben sind.
4. **Neustart mit Darts in der Scheibe** verdirbt die leere Scheibe. Beim Start nicht blind das erste Bild als leer nehmen (z. B. gespeicherte leere Scheibe laden oder vor dem ersten Wurf um „Darts ziehen“ bitten).
5. Danach Empfindlichkeit, kleinsten/größten Dart an echten Würfen einstellen und die Aufnahmen als Testfälle in `tests/` übernehmen.

## Lokaler Stand auf dem Dart-PC (nicht im Repo)

- Repo unter `C:\Users\Dart\n4-darts-privat`, Branch `claude/changes` (PR #4). Git-Autor nur für dieses Repo gesetzt: `Monaco85`, `zunker.sebastian@gmail.com`.
- Python 3.12 per winget (nur für den Benutzer), HeimDarts-Umgebung unter `%USERPROFILE%\Tools\heimdarts-venv` mit numpy, OpenCV und pytest.
- `tools/heimdarts/data/config.json`: Kameras `0`, `1`, `2`, Auflösung 640×480, 15 Bilder/s, Kalibrierung mit gesetzter 20 für alle drei Kameras. Die alte Einstellung (1280×720) liegt daneben als `config-1280x720.bak.json`.
- `tools/heimdarts/data/aufnahmen`: die Aufnahmen der Würfe vom 2026-11-04 (S6, S1, D9 und das falsche S8).
- HeimDarts ist beendet, die Kameras sind frei.

## Weitermachen

1. `tools/heimdarts/start-heimdarts.cmd` starten, Einrichtungsseite <http://localhost:3180/>. Autodarts muss geschlossen sein.
2. Darts ziehen, „Leere Scheibe neu aufnehmen“, erst dann werfen (siehe Punkt 4 oben).
3. Pro Wurf die echten Felder in Wurfreihenfolge notieren und mit den Aufnahmen in `tools/heimdarts/data/aufnahmen` vergleichen: Sie zeigen pro Kamera, was erkannt wurde.
4. Mit Punkt 1 der offenen Liste (Belichtung) anfangen.

## Umgesetzt am 2026-11-10 (Laptop, nur mit Simulation getestet)

Zu den offenen Punkten 1–4 oben:

1. **Belichtung:** `detector.match_brightness()` gleicht vor jedem Vergleich die Gesamthelligkeit an (Median der Helligkeitsverhältnisse pro Pixel, ein Dart verschiebt ihn nicht). Zusätzlich hält `cameras.py` 3 s nach dem Start Belichtung und Weißabgleich fest (Schalter auf der Einrichtungsseite, `"lock_exposure"`). Ob DirectShow das bei diesen Kameras befolgt, steht im Tooltip der Kamerazeile („Belichtung: fest …“); wird das Bild dabei viel dunkler, schaltet HeimDarts zurück auf automatisch.
2. **Nur-Flight-Ansichten:** Für den Schnittpunkt zählen nur Flecken mit Elongation ≥ 3 und Länge ≥ 3 % der Bilddiagonale (`min_elongation`, `min_line_frac`). Passen drei Linien nicht zusammen, wird die verworfen, deren Weglassen den Schnittpunkt am besten zu den gesehenen Spitzen der übrigen Kameras passen lässt (vorher: die mit dem größten Abstand – das konnte die gute Kamera treffen).
3. **Dünne Teile:** Statt Öffnen mit 3×3 (löscht alles unter 3 px Breite, bei 640×480 also Spitze und Schaft) werden nur noch Flecken unter 5 px entfernt (`min_blob_px`).
4. **Schatten:** Wird ein Pixel auf der Scheibe nur dunkler (50–92 %) bei gleicher Farbe, gilt es als Schatten und nicht als Dart (`shadow_filter`). Nur innerhalb der Scheibe – davor sieht ein graues Barrel sonst selbst wie ein Schatten aus.
5. **Neustart mit Darts:** Die leere Scheibe wird als `data/leer_kameraN.png` gespeichert und beim Start geladen. Steckt dann noch etwas, meldet HeimDarts „Darts in der Scheibe? Bitte ziehen“, das Ziehen wird erkannt, kein alter Dart zählt als neuer.

Neue Tests: `tests/test_robustness.py` (Belichtungssprung 28 %, Schatten, Nur-Flight-Ansicht, falsche dritte Linie, dünne Linien, Neustart mit Darts). 55 Tests grün.

**Am Dart-PC prüfen:** mit den Aufnahmen in `data/aufnahmen` und neuen Würfen – v. a. ob die Belichtung festgehalten wird und ob Doppel jetzt mit zwei Kameras erkannt werden.
