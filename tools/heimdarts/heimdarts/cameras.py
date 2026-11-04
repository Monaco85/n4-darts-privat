"""Bildquellen: USB-Kameras, Videodateien und simulierte Kameras.

Quellenangaben (Textfeld in der Oberfläche):
  "0", "1", …      USB-Kamera mit dieser Nummer
  "sim:0" … "sim:2" simulierte Kamera
  Dateipfad        Videodatei (läuft in Schleife), z. B. eine Aufnahme zum Testen
"""
from __future__ import annotations

import os
import sys
import threading
import time

import cv2
import numpy as np


class FrameSource:
    spec = ""

    def read(self) -> np.ndarray | None:
        raise NotImplementedError

    def info(self) -> dict:
        return {"spec": self.spec, "ok": False, "width": 0, "height": 0, "error": None}

    def set_fps(self, fps: float) -> None:
        pass

    def close(self) -> None:
        pass


class OpenCVSource(FrameSource):
    """Liest Bilder in einem eigenen Thread; read() liefert immer das neueste.

    Die Bildrate (fps) wird bei der Kamera angefragt, die meisten USB-Kameras ignorieren das aber.
    Der Thread schläft deshalb zwischen zwei fälligen Bildern und holt nur so viele ab und wandelt
    sie um, wie eingestellt sind.
    """

    def __init__(self, spec: str, width: int = 1280, height: int = 720, fps: float = 15.0):
        self.spec = spec
        self.want = (width, height)
        self.fps = float(fps)
        self._fps_changed = False
        self._frame: np.ndarray | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._error: str | None = None
        self._size = (0, 0)
        self._last_ok = 0.0
        self._rate = 0.0
        self._thread = threading.Thread(target=self._run, name=f"kamera-{spec}", daemon=True)
        self._thread.start()

    def set_fps(self, fps: float) -> None:
        self.fps = float(fps)
        self._fps_changed = True

    def _open(self):
        if self.spec.strip().isdigit():
            idx = int(self.spec)
            backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
            cap = cv2.VideoCapture(idx, backend)
            if cap.isOpened():
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.want[0])
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.want[1])
                cap.set(cv2.CAP_PROP_FPS, self.fps)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            return cap, False
        if not os.path.exists(self.spec):
            raise FileNotFoundError(f"Datei nicht gefunden: {self.spec}")
        return cv2.VideoCapture(self.spec), True

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                cap, is_file = self._open()
            except Exception as e:  # noqa: BLE001
                self._error = str(e)
                self._stop.wait(2.0)
                continue
            if not cap.isOpened():
                self._error = "Kamera lässt sich nicht öffnen (belegt oder nicht angeschlossen?)"
                cap.release()
                self._stop.wait(2.0)
                continue
            file_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
            self._error = None
            fails = 0
            next_due = 0.0
            while not self._stop.is_set():
                if self._fps_changed and not is_file:
                    self._fps_changed = False
                    cap.set(cv2.CAP_PROP_FPS, self.fps)
                if not is_file:
                    # DirectShow wartet bei grab() nicht auf ein neues Bild, sondern liefert sofort das
                    # letzte. Ohne Pause dreht der Thread leer und belegt einen ganzen CPU-Kern. Also bis
                    # zum nächsten fälligen Bild schlafen und dann nur dieses eine abholen.
                    wait = next_due - time.time()
                    if wait > 0 and self._stop.wait(wait):
                        break
                if not cap.grab():
                    if is_file:
                        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                        continue
                    fails += 1
                    if fails > 30:
                        self._error = "Keine Bilder mehr von der Kamera"
                        break
                    time.sleep(0.03)
                    continue
                fails = 0
                now = time.time()
                period = 1.0 / max(1.0, self.fps)
                # Takt halten (kleines Zittern der Kamera ausgleichen), nach Hängern neu ansetzen
                next_due = next_due + period if now - next_due < period else now + period
                ok, frame = cap.retrieve()
                if not ok:
                    continue
                with self._lock:
                    if self._last_ok:
                        dt = max(1e-3, now - self._last_ok)
                        self._rate = 0.9 * self._rate + 0.1 * (1.0 / dt) if self._rate else 1.0 / dt
                    self._frame = frame
                    self._size = (frame.shape[1], frame.shape[0])
                    self._last_ok = now
                if is_file:
                    time.sleep(1.0 / max(1.0, min(file_fps, self.fps, 60.0)))
            cap.release()

    def read(self) -> np.ndarray | None:
        with self._lock:
            if self._frame is None or time.time() - self._last_ok > 3.0:
                return None
            return self._frame

    def info(self) -> dict:
        ok = self.read() is not None
        return {"spec": self.spec, "ok": ok, "width": self._size[0], "height": self._size[1],
                "fps": round(self._rate, 1) if ok else 0.0,
                "error": None if ok else (self._error or "Warte auf Bilder …")}

    def close(self) -> None:
        self._stop.set()


class SimSource(FrameSource):
    def __init__(self, spec: str, scene, index: int):
        self.spec = spec
        self.scene = scene
        self.index = index

    def read(self) -> np.ndarray | None:
        if self.index >= len(self.scene.cameras):
            return None
        return self.scene.render(self.index)

    def info(self) -> dict:
        ok = self.index < len(self.scene.cameras)
        cam = self.scene.cameras[self.index] if ok else None
        return {"spec": self.spec, "ok": ok, "width": cam.width if cam else 0,
                "height": cam.height if cam else 0, "fps": None,
                "error": None if ok else "Es gibt nur sim:0 bis sim:2"}


def open_source(spec: str, scene_factory, width: int = 1280, height: int = 720,
                fps: float = 15.0) -> FrameSource:
    s = spec.strip()
    if s.lower().startswith("sim"):
        idx = int(s.split(":", 1)[1]) if ":" in s else 0
        return SimSource(s, scene_factory(), idx)
    return OpenCVSource(s, width, height, fps)


def probe_cameras(max_index: int = 6, skip: set[int] | None = None) -> list[dict]:
    """Sucht angeschlossene USB-Kameras (dauert ein paar Sekunden)."""
    found = []
    backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
    for i in range(max_index):
        if skip and i in skip:
            found.append({"index": i, "in_use": True})
            continue
        cap = cv2.VideoCapture(i, backend)
        try:
            if cap.isOpened():
                ok, frame = cap.read()
                if ok and frame is not None:
                    found.append({"index": i, "width": frame.shape[1], "height": frame.shape[0]})
        finally:
            cap.release()
    return found
