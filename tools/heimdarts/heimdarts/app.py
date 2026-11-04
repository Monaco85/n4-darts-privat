"""HeimDarts: Kameras -> Erkennung -> Board-Manager-Schnittstelle. Hält Konfiguration und Threads."""
from __future__ import annotations

import json
import math
import os
import threading
import time
from collections import deque

import cv2
import numpy as np

from . import board as B
from .bridge import BoardBridge
from .autocal import auto_calibrate, rotate_calibration, set_twenty
from .calibration import Calibration, draw_overlay
from .cameras import FrameSource, open_source, probe_cameras
from .detector import DartDetector, DetectorConfig

DEFAULT_CONFIG = {
    "cameras": [{"source": "sim:0"}, {"source": "sim:1"}, {"source": "sim:2"}],
    "resolution": [1280, 720],
    "fps": 15,
    "detector": DetectorConfig().to_dict(),
}


FPS_MIN, FPS_MAX = 5, 30


class HeimDarts:
    def __init__(self, data_dir: str, force_sim: bool = False):
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        self.config_path = os.path.join(data_dir, "config.json")
        self.config = self._load_config(force_sim)
        self.bridge = BoardBridge()
        self.bridge.on_reset = lambda: self.detector.accept_current()
        self.lock = threading.RLock()
        self._scene = None
        self.sources: list[FrameSource] = []
        self.calibrations: list[Calibration | None] = []
        self.detector = DartDetector(0)
        self.log: deque[dict] = deque(maxlen=40)
        self._frames: list[np.ndarray | None] = []
        self._stop = threading.Event()
        self._busy = False
        self.autocal_results: dict[int, dict] = {}
        self._autocal_tried: set[int] = set()
        self._loop_rate = 0.0
        self._apply_cameras(self.config["cameras"])
        self._thread = threading.Thread(target=self._loop, name="erkennung", daemon=True)
        self._thread.start()

    # ------------------------------------------------------------ Konfiguration
    def _load_config(self, force_sim: bool) -> dict:
        cfg = json.loads(json.dumps(DEFAULT_CONFIG))
        if os.path.exists(self.config_path) and not force_sim:
            try:
                with open(self.config_path, encoding="utf-8") as f:
                    cfg.update(json.load(f))
            except (OSError, ValueError):
                pass
        return cfg

    def save(self) -> None:
        with self.lock:
            cams = []
            for i, c in enumerate(self.config["cameras"]):
                cal = self.calibrations[i] if i < len(self.calibrations) else None
                cams.append({"source": c["source"], "calibration": cal.to_dict() if cal else None})
            self.config["cameras"] = cams
            self.config["detector"] = self.detector.config.to_dict()
            tmp = self.config_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.config, f, indent=2, ensure_ascii=False)
            os.replace(tmp, self.config_path)

    def scene(self):
        if self._scene is None:
            from .sim import SimScene
            self._scene = SimScene()
        return self._scene

    def _apply_cameras(self, cams: list[dict]) -> None:
        with self.lock:
            for s in self.sources:
                s.close()
            w, h = self.config.get("resolution", [1280, 720])
            self.sources = [open_source(c["source"], self.scene, int(w), int(h), self.fps) for c in cams]
            self.calibrations = []
            for c in cams:
                cal = None
                if c.get("calibration"):
                    try:
                        cal = Calibration.from_dict(c["calibration"])
                    except (ValueError, KeyError):
                        cal = None
                self.calibrations.append(cal)
            self.config["cameras"] = [{"source": c["source"], "calibration": c.get("calibration")} for c in cams]
            # Simulierte Kameras ohne Kalibrierung werden exakt kalibriert, damit man sofort spielen kann
            for i, c in enumerate(cams):
                if self.calibrations[i] is None and c["source"].strip().lower().startswith("sim"):
                    self._calibrate_sim(i)
            self.detector = DartDetector(len(self.sources), list(self.calibrations),
                                         DetectorConfig.from_dict(self.config.get("detector")))
            self._apply_timing()
            self._frames = [None] * len(self.sources)
            self.autocal_results = {}
            self._autocal_tried = set()

    def set_sources(self, specs: list[str]) -> None:
        specs = [s.strip() for s in specs if s.strip()]
        if not specs:
            raise ValueError("Mindestens eine Kamera angeben")
        with self.lock:
            old = self.config["cameras"]
            cams = []
            for i, spec in enumerate(specs):
                keep = old[i].get("calibration") if i < len(old) and old[i]["source"] == spec else None
                if keep is None and i < len(self.calibrations) and i < len(old) and old[i]["source"] == spec \
                        and self.calibrations[i] is not None:
                    keep = self.calibrations[i].to_dict()
                cams.append({"source": spec, "calibration": keep})
            self._apply_cameras(cams)
            self.save()
        self._log("info", "Kameras neu eingerichtet: " + ", ".join(specs))

    def set_detector_settings(self, values: dict) -> None:
        with self.lock:
            cfg = DetectorConfig.from_dict({**self.detector.config.to_dict(), **values})
            self.detector.config = cfg
            self.save()

    @property
    def fps(self) -> int:
        return int(min(FPS_MAX, max(FPS_MIN, int(self.config.get("fps", 15)))))

    def set_fps(self, fps: int) -> int:
        fps = int(min(FPS_MAX, max(FPS_MIN, int(fps))))
        with self.lock:
            self.config["fps"] = fps
            for s in self.sources:
                s.set_fps(fps)
            self._apply_timing()
            self.save()
        self._log("info", f"Bildrate auf {fps} FPS gestellt")
        return fps

    def _apply_timing(self) -> None:
        """Wartezeiten der Erkennung in Sekunden festhalten, unabhängig von der Bildrate."""
        cfg = self.detector.config
        cfg.stable_ticks = max(2, round(0.25 * self.fps))
        cfg.hand_min_ticks = max(3, round(0.33 * self.fps))

    # ------------------------------------------------------------ Kalibrierung
    def frame_size(self, i: int) -> tuple[int, int]:
        f = self._frames[i] if i < len(self._frames) else None
        if f is None:
            f = self.sources[i].read()
        if f is None:
            raise ValueError("Kamera liefert gerade kein Bild")
        return f.shape[1], f.shape[0]

    def calibrate(self, i: int, points: list[list[float]]) -> Calibration:
        w, h = self.frame_size(i)
        cal = Calibration.from_points(points, w, h)
        with self.lock:
            self.calibrations[i] = cal
            self.detector.set_calibration(i, cal)
            self.save()
        self.autocal_results.pop(i, None)
        self._log("info", f"Kamera {i + 1} von Hand kalibriert (Abweichung {cal.reprojection_error:.1f} px)")
        return cal

    def clear_calibration(self, i: int) -> None:
        with self.lock:
            self.calibrations[i] = None
            self.detector.set_calibration(i, None)
            self.save()
        self.autocal_results.pop(i, None)
        self._autocal_tried.add(i)   # nach bewusstem Löschen nicht sofort wieder automatisch

    def _set_calibration(self, i: int, cal: Calibration) -> None:
        with self.lock:
            self.calibrations[i] = cal
            self.detector.set_calibration(i, cal)
            self.save()

    def autocalibrate(self, i: int) -> dict:
        """Findet die Scheibe automatisch. Behält die alte Kalibrierung, wenn es nicht klappt."""
        if not 0 <= i < len(self.sources):
            raise ValueError("Diese Kamera gibt es nicht")
        f = self._frames[i] if i < len(self._frames) and self._frames[i] is not None else self.sources[i].read()
        if f is None:
            res = {"ok": False, "message": "Kamera liefert gerade kein Bild"}
        else:
            r = auto_calibrate(f, self.calibrations[i])
            res = r.to_dict()
            if r.ok and r.calibration is not None:
                self._set_calibration(i, r.calibration)
        res["needs_twenty"] = bool(res.get("ok")) and res.get("rotation_source") == "unsicher"
        self.autocal_results[i] = res
        self._log("info" if res["ok"] else "warnung", f"Kamera {i + 1}: {res['message']}")
        return res

    def autocalibrate_all(self) -> list[dict]:
        return [self.autocalibrate(i) for i in range(len(self.sources))]

    def rotate(self, i: int, steps: int) -> None:
        cal = self.calibrations[i]
        if cal is None:
            raise ValueError("Kamera ist noch nicht kalibriert")
        self._set_calibration(i, rotate_calibration(cal, int(steps)))
        self._mark_rotation_set(i)

    def twenty(self, i: int, x: float, y: float) -> None:
        cal = self.calibrations[i]
        if cal is None:
            raise ValueError("Kamera ist noch nicht kalibriert")
        self._set_calibration(i, set_twenty(cal, float(x), float(y)))
        self._mark_rotation_set(i)
        self._log("info", f"Kamera {i + 1}: Lage der 20 per Klick festgelegt")

    def _mark_rotation_set(self, i: int) -> None:
        r = self.autocal_results.get(i)
        if r:
            r["needs_twenty"] = False
            r["rotation_source"] = "klick"
            if r.get("ok"):
                r["message"] = r["message"].split(". ")[0] + ". Lage der 20 festgelegt."

    def _calibrate_sim(self, i: int) -> None:
        spec = self.config["cameras"][i]["source"]
        idx = int(spec.split(":", 1)[1]) if ":" in spec else 0
        scene = self.scene()
        if idx >= len(scene.cameras):
            return
        cam = scene.cameras[idx]
        cal = Calibration.from_points(scene.calibration_clicks(idx), cam.width, cam.height)
        self.calibrations[i] = cal
        self.config["cameras"][i]["calibration"] = cal.to_dict()

    # ------------------------------------------------------------ Bilder
    def jpeg(self, i: int, overlay: bool = True, debug: bool = False, quality: int = 80) -> bytes | None:
        if not 0 <= i < len(self.sources):
            return None
        f = self._frames[i] if i < len(self._frames) and self._frames[i] is not None else self.sources[i].read()
        if f is None:
            return None
        img = f.copy()
        cal = self.calibrations[i] if i < len(self.calibrations) else None
        if overlay and cal is not None:
            draw_overlay(img, cal)
        if debug:
            img = self.detector.debug_overlay(i, img)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
        return buf.tobytes() if ok else None

    # ------------------------------------------------------------ Hauptschleife
    def _loop(self) -> None:
        last_state = ""
        was_running = True
        while not self._stop.is_set():
            t0 = time.time()
            try:
                with self.lock:
                    sources = list(self.sources)
                    detector = self.detector
                frames = [s.read() for s in sources]
                self._frames = frames
                for i, f in enumerate(frames):
                    if f is not None and i < len(self.calibrations) and self.calibrations[i] is None \
                            and i not in self._autocal_tried:
                        self._autocal_tried.add(i)   # einmal von selbst versuchen
                        threading.Thread(target=self.autocalibrate, args=(i,), daemon=True).start()
                self.bridge.set_connected(any(f is not None for f in frames))
                running = self.bridge.running and self.bridge.status not in ("Calibrating",)
                if running and not was_running:
                    detector.accept_current()
                was_running = running
                if running:
                    events = detector.process(frames)
                    state = detector.status.state
                    if state == "hand" and last_state != "hand":
                        self.bridge.takeout_started()
                    last_state = state
                    for ev in events:
                        self._handle(ev)
            except Exception as e:  # noqa: BLE001 – Schleife darf nie sterben
                self._log("fehler", f"Erkennung: {e!r}")
                time.sleep(0.5)
            self._stop.wait(max(0.0, 1.0 / self.fps - (time.time() - t0)))
            dt = max(1e-3, time.time() - t0)
            self._loop_rate = 0.9 * self._loop_rate + 0.1 / dt if self._loop_rate else 1.0 / dt

    def _handle(self, ev: dict) -> None:
        if ev["type"] == "dart":
            accepted = self.bridge.dart(ev["x"], ev["y"])
            hit = ev["hit"]
            note = "" if accepted else " (ignoriert: schon 3 Darts oder gestoppt)"
            self._log("dart", f"{hit['label']} bei x={ev['x']:.1f} y={ev['y']:.1f} mm, "
                              f"{ev['method']}, Kameras {[c + 1 for c in ev['cams']]}{note}",
                      x=ev["x"], y=ev["y"], label=hit["label"])
        elif ev["type"] == "takeout":
            self.bridge.takeout_finished()
            self._log("takeout", "Darts entfernt")
        elif ev["type"] == "change":
            if ev.get("reason") == "hand":
                self.bridge.takeout_aborted()
                self._log("info", "Hand erkannt, Scheibe noch nicht leer")
            elif ev.get("reason") == "unkalibriert":
                self._log("warnung", "Änderung erkannt, aber keine Kamera ist kalibriert")
            else:
                self._log("info", "Änderung erkannt, aber kein Dart")

    def _log(self, kind: str, text: str, **extra) -> None:
        self.log.appendleft({"time": time.strftime("%H:%M:%S"), "kind": kind, "text": text, **extra})

    # ------------------------------------------------------------ Befehle
    def recapture_reference(self) -> None:
        self.detector.reset()
        self._log("info", "Referenzbild der leeren Scheibe neu aufgenommen")

    def remote_calibrate(self) -> None:
        """Von n4-darts („Kalibrieren“ im Board-Menü): alle Kameras automatisch kalibrieren und
        die leere Scheibe neu aufnehmen."""
        self.bridge.calibrating()
        try:
            results = self.autocalibrate_all()
            self.detector.reset()
            ok = sum(1 for r in results if r.get("ok"))
            self._log("info", f"Kalibrieren über n4-darts: {ok} von {len(results)} Kameras automatisch kalibriert")
        finally:
            self.bridge.calibrated()

    def probe(self) -> list[dict]:
        in_use = {int(c["source"]) for c in self.config["cameras"] if c["source"].strip().isdigit()}
        return probe_cameras(skip=in_use)

    # ------------------------------------------------------------ Simulation
    @property
    def has_sim(self) -> bool:
        return any(c["source"].strip().lower().startswith("sim") for c in self.config["cameras"])

    def sim_throw(self, x: float | None = None, y: float | None = None, label: str | None = None,
                  spread: float = 0.0) -> dict:
        scene = self.scene()
        d = scene.throw_at(label, spread) if label else scene.throw(float(x), float(y))
        return {"x": d.x, "y": d.y, "label": B.score_at(d.x, d.y).label}

    def sim_takeout(self) -> None:
        if self._busy:
            return
        self._busy = True

        def run():
            try:
                scene = self.scene()
                for k in range(8):   # Hand bewegt sich über die Scheibe
                    a = k / 7.0
                    scene.set_hand((-120 + 240 * a, 60 * math.sin(a * 3), 70.0))
                    time.sleep(0.12)
                    if k == 5:
                        scene.clear()
                scene.set_hand(None)
            finally:
                self._busy = False

        threading.Thread(target=run, daemon=True).start()

    # ------------------------------------------------------------ Zustand für die Oberfläche
    def status(self) -> dict:
        with self.lock:
            cams = []
            for i, s in enumerate(self.sources):
                info = s.info()
                cal = self.calibrations[i] if i < len(self.calibrations) else None
                info["calibrated"] = cal is not None
                info["calibration_error"] = round(cal.reprojection_error, 2) if cal else None
                info["calibration_points"] = cal.image_points if cal else None
                info["autocal"] = self.autocal_results.get(i)
                cams.append(info)
            st = self.detector.status
            return {
                "board": self.bridge.snapshot(),
                "clients": self.bridge.client_count,
                "detector": {"state": st.state, "message": st.message, "darts_on_board": st.darts_on_board},
                "cameras": cams,
                "settings": self.detector.config.to_dict(),
                "fps": {"value": self.fps, "min": FPS_MIN, "max": FPS_MAX, "loop": round(self._loop_rate, 1)},
                "sim": self.has_sim,
                "log": list(self.log)[:20],
                "calibration_points": [{"name": n, "x": p[0], "y": p[1]} for n, p in B.CALIBRATION_POINTS],
            }

    def close(self) -> None:
        self._stop.set()
        for s in self.sources:
            s.close()
