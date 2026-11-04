"""Zustand im Format der lokalen Board-Manager-Schnittstelle, die n4-darts erwartet.

Beschrieben in n4-darts unter docs/board-manager-api.md: Jede Nachricht ist ein kompletter
Schnappschuss {"type":"state","data":{connected, running, event, status, numThrows, throws?}}.
"""
from __future__ import annotations

import json
import math
import threading
from typing import Callable

from . import board as B

# Board-Manager-Koordinaten: Bull = (0,0), Außenkante Doppel ≈ 0.99, y Richtung 20
COORD_SCALE = 0.99 / B.R_DOUBLE_OUT


def wedge_number(x: float, y: float) -> int:
    ang = math.degrees(math.atan2(y, x))
    return B.SEGMENTS[int(((90.0 + 9.0 - ang) % 360.0) // 18.0)]


def throw_from_mm(x: float, y: float) -> dict:
    """Ein Wurf-Objekt wie beim Board Manager aus einer Position in mm."""
    r = math.hypot(x, y)
    n = wedge_number(x, y)
    if r <= B.R_BULL:
        seg = ("Double", 2, "Bull", 25)
    elif r <= B.R_OUTER_BULL:
        seg = ("Single", 1, "25", 25)
    elif r < B.R_TRIPLE_IN:
        seg = ("SingleInner", 1, f"S{n}", n)
    elif r <= B.R_TRIPLE_OUT:
        seg = ("Triple", 3, f"T{n}", n)
    elif r < B.R_DOUBLE_IN:
        seg = ("SingleOuter", 1, f"S{n}", n)
    elif r <= B.R_DOUBLE_OUT:
        seg = ("Double", 2, f"D{n}", n)
    else:
        seg = ("Outside", 0, f"M{n}", n)
    bed, mult, name, number = seg
    return {"bouncer": False,
            "coords": {"x": round(x * COORD_SCALE, 4), "y": round(y * COORD_SCALE, 4)},
            "segment": {"bed": bed, "multiplier": mult, "name": name, "number": number}}


class BoardBridge:
    def __init__(self):
        self._lock = threading.RLock()
        self._listeners: list[Callable[[str], None]] = []
        self.connected = True
        self.running = True
        self.event = "Started"
        self.status = "Throw"
        self.throws: list[dict] = []
        self.on_reset: Callable[[], None] | None = None

    # ------------------------------------------------------------ Verteilung
    def subscribe(self, fn: Callable[[str], None]) -> None:
        with self._lock:
            self._listeners.append(fn)

    def unsubscribe(self, fn: Callable[[str], None]) -> None:
        with self._lock:
            if fn in self._listeners:
                self._listeners.remove(fn)

    @property
    def client_count(self) -> int:
        return len(self._listeners)

    def snapshot(self) -> dict:
        with self._lock:
            s = {"connected": self.connected, "running": self.running, "event": self.event,
                 "status": self.status, "numThrows": len(self.throws)}
            if self.throws:
                s["throws"] = [dict(t) for t in self.throws]
            return s

    def _emit(self, event: str, *, status: str | None = None, running: bool | None = None,
              throws: list[dict] | None = None) -> None:
        with self._lock:
            self.event = event
            if status is not None:
                self.status = status
            if running is not None:
                self.running = running
            if throws is not None:
                self.throws = throws
            msg = json.dumps({"type": "state", "data": self.snapshot()})
            listeners = list(self._listeners)
        for fn in listeners:
            try:
                fn(msg)
            except Exception:
                self.unsubscribe(fn)

    # ------------------------------------------------------------ Ereignisse der Erkennung
    def dart(self, x_mm: float, y_mm: float) -> bool:
        with self._lock:
            # Wie der Board Manager: nach drei Darts wird bis zum Ziehen nichts mehr erkannt
            if not self.running or self.status != "Throw" or len(self.throws) >= 3:
                return False
            throws = self.throws + [throw_from_mm(x_mm, y_mm)]
            self._emit("Throw detected", status="Takeout" if len(throws) == 3 else "Throw", throws=throws)
            return True

    def takeout_started(self) -> None:
        with self._lock:
            if self.running and self.throws and self.status != "Takeout in progress":
                self._emit("Takeout started", status="Takeout in progress")

    def takeout_aborted(self) -> None:
        """Hand war im Bild, aber die Scheibe ist nicht leer."""
        with self._lock:
            if self.status == "Takeout in progress":
                self._emit("Takeout aborted", status="Takeout" if len(self.throws) >= 3 else "Throw")

    def takeout_finished(self) -> None:
        """Scheibe ist wieder leer. Wird auch gemeldet, wenn die Erkennung Darts verpasst hat –
        n4-darts beendet dann die Aufnahme mit den Darts, die an der Station nachgetragen wurden."""
        with self._lock:
            if not self.running:
                return
            if self.status != "Takeout in progress":
                self._emit("Takeout started", status="Takeout in progress")
            self._emit("Takeout finished", status="Throw", throws=[])

    # ------------------------------------------------------------ Befehle (von n4-darts)
    def reset(self) -> None:
        self._emit("Manual reset", status="Throw" if self.running else "Stopped", throws=[])
        if self.on_reset:
            self.on_reset()

    def stop(self) -> None:
        self._emit("Stopping", status="Stopping", running=False)
        self._emit("Stopped", status="Stopped", running=False)

    def start(self) -> None:
        self._emit("Starting", status="Starting", running=True)
        self._emit("Started", status="Takeout" if len(self.throws) >= 3 else "Throw", running=True)

    def calibrating(self) -> None:
        self._emit("Calibrating", status="Calibrating")

    def calibrated(self) -> None:
        self._emit("Calibrated", status=("Takeout" if len(self.throws) >= 3 else "Throw") if self.running else "Stopped")

    def set_connected(self, connected: bool) -> None:
        with self._lock:
            if connected == self.connected:
                return
            self.connected = connected
        self._emit("Camera connected" if connected else "Camera error")
