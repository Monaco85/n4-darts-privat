"""Automatische Kalibrierung mit simulierten Kameras."""
import math

import numpy as np
import pytest

from heimdarts import board as B
from heimdarts.autocal import auto_calibrate, rotate_calibration, set_twenty
from heimdarts.calibration import Calibration
from heimdarts.detector import DartDetector
from heimdarts.sim import SimScene

GRID = np.array([(r * math.cos(a), r * math.sin(a))
                 for r in (0, 50, 103, 140, 166) for a in np.radians(np.arange(0, 360, 15))])


def truth(scene, i):
    cam = scene.cameras[i]
    return Calibration.from_points(scene.calibration_clicks(i), cam.width, cam.height)


def error_mm(cal, true_cal):
    back = cal.image_to_board(true_cal.board_to_image(GRID))
    return np.hypot(*(back - GRID).T)


@pytest.mark.parametrize("with_darts", [False, True])
@pytest.mark.parametrize("cam", [0, 1, 2])
def test_geometry_is_precise(cam, with_darts):
    scene = SimScene(seed=1)
    if with_darts:
        for label in ["T20", "D16", "S5"]:
            scene.throw_at(label)
    t = truth(scene, cam)
    r = auto_calibrate(scene.render(cam), previous=t)     # Drehung von der „vorigen“ Kalibrierung
    assert r.ok and r.rotation_source == "vorher"
    e = error_mm(r.calibration, t)
    assert np.median(e) < 1.0 and e.max() < 2.5


def test_previous_calibration_fixes_rotation_even_if_slightly_off():
    scene = SimScene(seed=1)
    t = truth(scene, 0)
    rough = Calibration.from_points(scene.calibration_clicks(0, jitter_px=4.0), 960, 540)
    r = auto_calibrate(scene.render(0), previous=rough)
    assert error_mm(r.calibration, t).max() < 2.5


def test_click_on_twenty_sets_rotation():
    scene = SimScene(seed=1)
    t = truth(scene, 1)
    r = auto_calibrate(scene.render(1))
    assert r.ok
    # irgendein Klick ins Feld der 20 (Single außen) – egal wie die Drehung vorher war
    for steps in range(10):
        wrong = rotate_calibration(r.calibration, steps)
        click = t.board_to_image([B.target_point("S20")])[0] + (3, -2)
        fixed = set_twenty(wrong, *click)
        assert error_mm(fixed, t).max() < 2.5


def test_click_next_to_twenty_on_green_field_snaps_to_twenty():
    scene = SimScene(seed=1)
    t = truth(scene, 0)
    r = auto_calibrate(scene.render(0), previous=t)
    x, y = B.R_TRIPLE_OUT + 20, 0
    a = math.radians(90 - 10)        # knapp im Feld der 1, nah an der 20
    click = t.board_to_image([(130 * math.cos(a), 130 * math.sin(a))])[0]
    fixed = set_twenty(rotate_calibration(r.calibration, 3), *click)
    assert error_mm(fixed, t).max() < 2.5
    del x, y


def test_rotation_is_cyclic():
    scene = SimScene(seed=1)
    t = truth(scene, 2)
    back = rotate_calibration(rotate_calibration(t, 4), 6)     # 10 × 36° = 360°
    assert error_mm(back, t).max() < 0.05


def test_no_board_is_reported():
    gray = np.full((540, 960, 3), 90, np.uint8)
    r = auto_calibrate(gray)
    assert not r.ok and r.calibration is None


def test_detection_with_auto_calibration():
    scene = SimScene(seed=4)
    cals = [auto_calibrate(scene.render(i), previous=truth(scene, i)).calibration for i in range(3)]
    det = DartDetector(3, cals)
    for _ in range(3):
        det.process([scene.render(i) for i in range(3)])
    rng = np.random.default_rng(5)
    errors = []
    for _ in range(3):
        r, a = rng.uniform(20, 160), rng.uniform(0, 2 * math.pi)
        x, y = r * math.cos(a), r * math.sin(a)
        scene.throw(x, y)
        ev = []
        for _ in range(5):
            ev += det.process([scene.render(i) for i in range(3)])
        darts = [e for e in ev if e["type"] == "dart"]
        assert darts
        errors.append(math.hypot(darts[0]["x"] - x, darts[0]["y"] - y))
    assert np.median(errors) < 3.0
