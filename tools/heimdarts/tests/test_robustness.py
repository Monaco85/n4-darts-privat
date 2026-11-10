"""Erkennung unter Bedingungen echter Kameras: Belichtungssprünge, Schatten, schlechte Ansichten, Neustart."""
import math

import numpy as np

from heimdarts import board as B
from heimdarts.calibration import Calibration
from heimdarts.detector import CamObservation, DartDetector, DetectorConfig, fuse_observations, remove_small
from heimdarts.sim import SimScene


def setup(seed=3, **cfg):
    scene = SimScene(seed=seed)
    cals = [Calibration.from_points(scene.calibration_clicks(i, 1.0), c.width, c.height)
            for i, c in enumerate(scene.cameras)]
    return scene, DartDetector(3, cals, DetectorConfig(**cfg))


def feed(scene, det, n=5):
    ev = []
    for _ in range(n):
        ev += det.process([scene.render(i) for i in range(len(scene.cameras))])
    return ev


def throw(scene, det, x, y):
    scene.throw(x, y)
    return [e for e in feed(scene, det) if e["type"] == "dart"]


def test_exposure_jump_during_throw():
    """Kamera regelt beim Wurf um 28 % dunkler (wie Kamera 3 bei der D9: 55 % des Bildes „verändert“)."""
    scene, det = setup()
    feed(scene, det, 3)
    scene.gain = 0.72
    darts = throw(scene, det, 0.0, 166.0)          # D20
    assert darts and darts[0]["hit"]["label"] == "D20"
    assert darts[0]["method"] == "schnittpunkt"


def test_exposure_jump_without_compensation_breaks():
    """Gegenprobe: ohne Ausgleich ist der Belichtungssprung kein Dart mehr."""
    scene, det = setup(normalize_brightness=False)
    feed(scene, det, 3)
    scene.gain = 0.72
    darts = throw(scene, det, 0.0, 166.0)
    assert not darts or darts[0]["hit"]["label"] != "D20" or darts[0]["method"] != "schnittpunkt"


def test_shadows_do_not_pull_the_tip():
    errors = {}
    for flt in (True, False):
        scene, det = setup(seed=5, shadow_filter=flt)
        scene.shadows = True
        feed(scene, det, 3)
        rng = np.random.default_rng(2)
        e = []
        for _ in range(3):
            r, a = rng.uniform(30, 150), rng.uniform(0, 2 * math.pi)
            x, y = r * math.cos(a), r * math.sin(a)
            d = throw(scene, det, x, y)
            assert d
            e.append(math.hypot(d[0]["x"] - x, d[0]["y"] - y))
        errors[flt] = float(np.median(e))
    assert errors[True] < 3.0
    assert errors[True] <= errors[False] + 0.5


def _obs(cam, p0, ang_deg, elong, rel_len, tip=(0.0, 0.0)):
    a = math.radians(ang_deg)
    # Gerade durch p0 mit Richtung a: a*x + b*y + c = 0 mit (a,b) = Normale
    nx, ny = -math.sin(a), math.cos(a)
    c = -(nx * p0[0] + ny * p0[1])
    return CamObservation(cam=cam, area=100, p0=(0, 0), d=(1, 0), tip_img=(0, 0), tail_img=(1, 0),
                          tip_board=tip, line_board=(nx, ny, c), elongation=elong, length=50,
                          rel_length=rel_len)


def test_flight_only_view_is_ignored():
    target = (0.0, 100.0)
    good1 = _obs(0, target, 30, 7.0, 0.08, tip=(8.0, 105.0))
    good2 = _obs(1, target, 100, 6.0, 0.07, tip=(-2.0, 112.0))
    flight = _obs(2, (40.0, 60.0), 160, 2.2, 0.02, tip=(40.0, 60.0))      # kurz, kaum länglich, liegt daneben
    x, y, method, used = fuse_observations([flight, good1, good2], DetectorConfig())
    assert method == "schnittpunkt" and 2 not in used
    assert math.hypot(x - target[0], y - target[1]) < 0.5


def test_outlier_line_is_dropped():
    target = (50.0, -20.0)
    # grob gesehene Spitzen liegen auf der eigenen Linie, wegen der Perspektive etwas daneben
    a = _obs(0, target, 10, 6.0, 0.06, tip=(target[0] + 15 * math.cos(math.radians(10)), target[1] + 15 * math.sin(math.radians(10))))
    b = _obs(1, target, 75, 6.0, 0.06, tip=(target[0] - 12 * math.cos(math.radians(75)), target[1] - 12 * math.sin(math.radians(75))))
    bad = _obs(2, (80.0, 10.0), 140, 8.0, 0.09, tip=(80.0, 10.0))   # länglich und lang, aber woanders
    x, y, method, used = fuse_observations([a, b, bad], DetectorConfig())
    assert used == [0, 1] or sorted(used) == [0, 1]
    assert math.hypot(x - target[0], y - target[1]) < 0.5


def test_thin_lines_survive_noise_removal():
    m = np.zeros((50, 50), np.uint8)
    m[10:40, 25] = 1            # 1 px breite Linie (Spitze/Schaft)
    m[5, 5] = 1                 # einzelnes Rauschpixel
    out = remove_small(m, 5)
    assert out[10:40, 25].all() and out[5, 5] == 0


def test_restart_with_darts_in_board():
    """Neustart mit steckenden Darts: Die gespeicherte leere Scheibe sorgt dafür, dass das Ziehen
    erkannt wird und kein alter Dart als neuer zählt."""
    scene, det = setup()
    feed(scene, det, 3)
    empties = {i: img.copy() for i, img in det.empty_images().items()}
    for label in ("T20", "S5"):
        scene.throw_at(label)
    det2 = DartDetector(3, det.calibrations, DetectorConfig())
    for i, img in empties.items():
        det2.preset_empty(i, img)
    feed(scene, det2, 3)
    assert "ziehen" in det2.status.message
    # Darts ziehen (Hand), dann ist die Scheibe leer
    events = []
    for k in range(6):
        scene.set_hand((-100 + 40 * k, 0, 70))
        events += feed(scene, det2, 1)
        if k == 3:
            scene.clear()
    scene.set_hand(None)
    events += feed(scene, det2, 5)
    assert any(e["type"] == "takeout" for e in events)
    assert not any(e["type"] == "dart" for e in events)
    # danach normal weiter
    d = throw(scene, det2, *B.target_point("D16"))
    assert d and d[0]["hit"]["label"] == "D16"
