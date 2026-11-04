"""Bildrate: Eine Kamera, die schneller liefert als eingestellt, wird auf die eingestellte Rate begrenzt."""
import time

import numpy as np
import pytest

from heimdarts.cameras import OpenCVSource


class FakeCamera:
    """Verhält sich wie cv2.VideoCapture einer USB-Kamera, die stur `fps` Bilder liefert."""

    def __init__(self, fps):
        self.period = 1.0 / fps
        self.retrieved = 0
        self._next = time.perf_counter()

    def isOpened(self):
        return True

    def set(self, *_):
        return True       # Wunsch-Bildrate wird – wie bei vielen Kameras – ignoriert

    def get(self, *_):
        return 0.0

    def grab(self):
        now = time.perf_counter()
        if now < self._next:
            time.sleep(self._next - now)
        self._next += self.period
        return True

    def retrieve(self):
        self.retrieved += 1
        return True, np.zeros((72, 128, 3), np.uint8)

    def release(self):
        pass


@pytest.mark.parametrize("wanted", [5, 15])
def test_fast_camera_is_limited(monkeypatch, wanted):
    cam = FakeCamera(60)
    monkeypatch.setattr(OpenCVSource, "_open", lambda self: (cam, False))
    src = OpenCVSource("0", fps=wanted)
    try:
        time.sleep(2.5)
        info = src.info()
    finally:
        src.close()
    assert info["ok"]
    assert wanted * 0.8 <= info["fps"] <= wanted * 1.1          # verwendete Bilder
    assert info["camera_fps"] > 45                               # Kamera liefert weiter ~60
    assert cam.retrieved <= wanted * 2.5 * 1.15 + 2              # nur so viele umgewandelt


def test_fps_change_takes_effect(monkeypatch):
    cam = FakeCamera(60)
    monkeypatch.setattr(OpenCVSource, "_open", lambda self: (cam, False))
    src = OpenCVSource("0", fps=30)
    try:
        time.sleep(1.0)
        src.set_fps(5)
        time.sleep(2.5)
        info = src.info()
    finally:
        src.close()
    assert info["fps"] <= 6
