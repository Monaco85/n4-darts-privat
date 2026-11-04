"""Ende-zu-Ende: simulierte Kameras -> Kalibrierung per Klickpunkte -> Erkennung."""
import math

import numpy as np
import pytest

from heimdarts import board as B
from heimdarts.calibration import Calibration
from heimdarts.detector import DartDetector
from heimdarts.sim import SimScene


def setup(n_cams=3, seed=3):
    scene = SimScene(seed=seed)
    scene.cameras = scene.cameras[:n_cams]
    scene._backgrounds = scene._backgrounds[:n_cams]
    cals = [Calibration.from_points(scene.calibration_clicks(i, jitter_px=1.0), c.width, c.height)
            for i, c in enumerate(scene.cameras)]
    det = DartDetector(n_cams, cals)
    return scene, det


def feed(scene, det, n=5):
    events = []
    for _ in range(n):
        events += det.process([scene.render(i) for i in range(len(scene.cameras))])
    return events


def takeout(scene, det):
    events = []
    for k in range(6):  # Hand bewegt sich
        scene.set_hand((-100 + 40 * k, 0, 70))
        events += feed(scene, det, 1)
        if k == 3:
            scene.clear()
    scene.set_hand(None)
    events += feed(scene, det, 5)
    return events


def test_calibration_is_accurate():
    scene, det = setup()
    for i, cal in enumerate(det.calibrations):
        assert cal.reprojection_error < 3.0
        # Bullmitte landet auf (0,0)
        center_img = cal.board_to_image([(0, 0)])[0]
        x, y = cal.image_to_board([center_img])[0]
        assert math.hypot(x, y) < 1e-6


def test_three_cameras_detect_darts_precisely():
    scene, det = setup()
    feed(scene, det, 3)
    rng = np.random.default_rng(11)
    errors = []
    for _turn in range(3):
        for _ in range(3):
            r, a = rng.uniform(20, 160), rng.uniform(0, 2 * math.pi)
            x, y = r * math.cos(a), r * math.sin(a)
            scene.throw(x, y)
            darts = [e for e in feed(scene, det) if e["type"] == "dart"]
            assert len(darts) == 1
            errors.append(math.hypot(darts[0]["x"] - x, darts[0]["y"] - y))
        assert any(e["type"] == "takeout" for e in takeout(scene, det))
    assert np.median(errors) < 3.0
    assert np.mean(np.array(errors) < 6.0) >= 0.8


@pytest.mark.parametrize("label", ["T20", "D16", "BULL", "S11"])
def test_target_fields(label):
    scene, det = setup()
    feed(scene, det, 3)
    scene.throw_at(label)
    darts = [e for e in feed(scene, det) if e["type"] == "dart"]
    assert darts and darts[0]["hit"]["label"] == label


def test_single_camera_still_finds_the_field():
    scene, det = setup(n_cams=1)
    feed(scene, det, 3)
    scene.throw(*B.target_point("T20"), tilt_deg=0)
    darts = [e for e in feed(scene, det) if e["type"] == "dart"]
    assert darts and darts[0]["method"] == "eine kamera"
    assert darts[0]["hit"]["label"] == "T20"


def test_hand_alone_is_not_a_dart():
    scene, det = setup()
    feed(scene, det, 3)
    events = takeout(scene, det)
    assert not [e for e in events if e["type"] == "dart"]


def test_takeout_after_undetected_change():
    """Auch wenn kein Dart erkannt wurde, meldet das Leeren der Scheibe „Darts entfernt“."""
    scene, det = setup()
    feed(scene, det, 3)
    det.calibrations = [None] * 3       # nichts kann gewertet werden
    scene.throw_at("T20")
    assert any(e["type"] == "change" for e in feed(scene, det))
    assert any(e["type"] == "takeout" for e in takeout(scene, det))
