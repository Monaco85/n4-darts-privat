"""Darterkennung über Bilddifferenzen mit einer oder mehreren Kameras.

Ablauf pro Kamera:
  * Referenzbild = Zustand der Scheibe nach dem letzten erkannten Ereignis.
  * Ändert sich das Bild (Bewegung) und ist danach wieder ruhig, wird die Differenz zur Referenz
    ausgewertet. Ein länglicher Fleck passender Größe ist ein neuer Dart.
  * Durch den Fleck wird eine Gerade gelegt. Diese Bildgerade entspricht auf der Scheibenebene
    einer Geraden, auf der die Dartspitze liegen muss (Homographie). Mit zwei oder mehr Kameras
    ergibt der Schnittpunkt dieser Geraden die Spitze – auch wenn die Spitze selbst im Bild verdeckt
    oder zu dünn ist.
  * Große, länger dauernde Änderungen gelten als Hand (Darts ziehen). Ist die Scheibe danach wieder
    so leer wie zu Beginn der Aufnahme, wird „Darts entfernt“ gemeldet.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field, asdict

import cv2
import numpy as np

from . import board as B
from .calibration import Calibration


@dataclass
class DetectorConfig:
    blur: int = 5                     # Weichzeichner (ungerade)
    diff_threshold: int = 22          # Grauwertunterschied, ab dem ein Pixel als verändert gilt
    min_dart_area: float = 0.00012    # Anteil der Bildfläche
    max_dart_area: float = 0.05
    motion_area: float = 0.00006      # Bewegung zwischen zwei Bildern
    stable_ticks: int = 3             # so viele ruhige Bilder hintereinander, bevor ausgewertet wird
    hand_min_ticks: int = 4           # Mindestdauer einer großen Bewegung, damit sie als Hand gilt
    empty_area: float = 0.00025       # max. Unterschied zur leeren Scheibe für „Darts entfernt“
    max_line_residual_mm: float = 6.0
    min_line_angle_deg: float = 12.0

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict) -> "DetectorConfig":
        c = DetectorConfig()
        for k, v in (d or {}).items():
            if hasattr(c, k):
                setattr(c, k, type(getattr(c, k))(v))
        return c


@dataclass
class CamObservation:
    cam: int
    area: int
    p0: tuple[float, float]
    d: tuple[float, float]
    tip_img: tuple[float, float]
    tail_img: tuple[float, float]
    tip_board: tuple[float, float]
    line_board: tuple[float, float, float]
    elongation: float

    def to_dict(self) -> dict:
        return {k: (list(v) if isinstance(v, tuple) else v) for k, v in asdict(self).items()}


@dataclass
class _CamState:
    ref: np.ndarray | None = None
    empty: np.ndarray | None = None
    prev: np.ndarray | None = None
    last_mask: np.ndarray | None = None
    last_obs: CamObservation | None = None
    size: tuple[int, int] = (0, 0)


@dataclass
class DetectorStatus:
    state: str = "start"          # start | bereit | bewegung | hand
    darts_on_board: int = 0
    last_event: dict | None = None
    last_event_time: float = 0.0
    message: str = "Warte auf Kamerabilder"


class DartDetector:
    def __init__(self, n_cams: int, calibrations: list[Calibration | None] | None = None,
                 config: DetectorConfig | None = None):
        self.config = config or DetectorConfig()
        self.cams = [_CamState() for _ in range(n_cams)]
        self.calibrations: list[Calibration | None] = list(calibrations or [None] * n_cams)
        self.status = DetectorStatus()
        self._stable = 0
        self._in_motion = False
        self._motion_ticks = 0
        self._peak_area = 0.0
        self._idle_ticks = 0
        self._dirty = False
        self._accept_next = False
        self.last_dart_frames: dict[int, tuple[np.ndarray, np.ndarray]] = {}

    # ------------------------------------------------------------------ Verwaltung
    def accept_current(self) -> None:
        """Aktuelles Bild als Referenz übernehmen, ohne die leere Scheibe zu vergessen (nach Reset)."""
        self._accept_next = True
    def set_calibration(self, i: int, cal: Calibration | None) -> None:
        self.calibrations[i] = cal

    def reset(self) -> None:
        """Nächstes ruhiges Bild wird neue Referenz (Scheibe muss leer sein)."""
        for c in self.cams:
            c.ref = c.empty = c.prev = None
            c.last_mask = None
            c.last_obs = None
        self.status = DetectorStatus(message="Referenz wird neu aufgenommen")
        self._stable = 0
        self._in_motion = False
        self._motion_ticks = 0
        self._peak_area = 0.0
        self._dirty = False

    def _prep(self, frame: np.ndarray) -> np.ndarray:
        g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
        k = self.config.blur | 1
        return cv2.GaussianBlur(g, (k, k), 0)

    def _mask(self, a: np.ndarray, b: np.ndarray) -> np.ndarray:
        m = (cv2.absdiff(a, b) > self.config.diff_threshold).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        return m

    # ------------------------------------------------------------------ Hauptschleife
    def process(self, frames: list[np.ndarray | None]) -> list[dict]:
        cfg = self.config
        grays: list[np.ndarray | None] = []
        for i, f in enumerate(frames):
            if f is None:
                grays.append(None)
                continue
            g = self._prep(f)
            st = self.cams[i]
            if st.size != (g.shape[1], g.shape[0]):
                st.size = (g.shape[1], g.shape[0])
                st.ref = st.empty = st.prev = None
            grays.append(g)
        active = [i for i, g in enumerate(grays) if g is not None]
        if not active:
            self.status.message = "Keine Kamerabilder"
            return []

        # Erste Bilder werden Referenz
        if any(self.cams[i].ref is None for i in active):
            for i in active:
                st = self.cams[i]
                if st.ref is None:
                    st.ref = grays[i].copy()
                    st.empty = grays[i].copy()
                st.prev = grays[i]
            self.status.state = "bereit"
            self.status.message = "Bereit"
            return []

        if self._accept_next:
            self._accept_next = False
            for i in active:
                st = self.cams[i]
                st.ref = grays[i].copy()
                st.prev = grays[i]
                st.last_obs = None
            npx = {i: self.cams[i].size[0] * self.cams[i].size[1] for i in active}
            self._dirty = any(np.count_nonzero(self._mask(grays[i], self.cams[i].empty)) / npx[i]
                              >= self.config.empty_area for i in active)
            self._in_motion = False
            self._stable = 0
            return []

        # Bewegung zwischen aufeinanderfolgenden Bildern
        moving = False
        for i in active:
            st = self.cams[i]
            npx = st.size[0] * st.size[1]
            motion = int(np.count_nonzero(cv2.absdiff(grays[i], st.prev) > cfg.diff_threshold))
            st.prev = grays[i]
            if motion > cfg.motion_area * npx:
                moving = True
        peak = 0.0
        if moving:
            for i in active:
                st = self.cams[i]
                npx = st.size[0] * st.size[1]
                area = np.count_nonzero(cv2.absdiff(grays[i], st.ref) > cfg.diff_threshold) / npx
                peak = max(peak, area)

        if moving:
            self._stable = 0
            self._in_motion = True
            self._motion_ticks += 1
            self._peak_area = max(self._peak_area, peak)
            self.status.state = "hand" if self._is_hand() else "bewegung"
            self.status.message = "Hand im Bild" if self.status.state == "hand" else "Bewegung"
            return []

        self._stable += 1
        if not self._in_motion:
            self._idle(grays, active)
            return []
        if self._stable < cfg.stable_ticks:
            return []

        # Bewegung ist vorbei und Bild ist ruhig -> auswerten
        hand = self._is_hand()
        self._in_motion = False
        self._motion_ticks = 0
        self._peak_area = 0.0
        events = self._evaluate(grays, active, hand)
        self.status.state = "bereit"
        if events:
            self.status.last_event = events[-1]
            self.status.last_event_time = time.time()
            self.status.message = _event_text(events[-1])
        return events

    def _is_hand(self) -> bool:
        return self._peak_area > self.config.max_dart_area and self._motion_ticks >= self.config.hand_min_ticks

    def _idle(self, grays, active) -> None:
        """Langsame Helligkeitsänderungen in die Referenz übernehmen."""
        self._idle_ticks += 1
        if self._idle_ticks % 25:
            return
        cfg = self.config
        for i in active:
            st = self.cams[i]
            npx = st.size[0] * st.size[1]
            area = np.count_nonzero(cv2.absdiff(grays[i], st.ref) > cfg.diff_threshold)
            if area < 0.5 * cfg.min_dart_area * npx:
                st.ref = cv2.addWeighted(st.ref, 0.5, grays[i], 0.5, 0)
                if self.status.darts_on_board == 0:
                    st.empty = st.ref.copy()

    def _evaluate(self, grays, active, hand: bool) -> list[dict]:
        cfg = self.config
        ref_areas: dict[int, float] = {}
        empty_areas: dict[int, float] = {}
        masks: dict[int, np.ndarray] = {}
        for i in active:
            st = self.cams[i]
            npx = st.size[0] * st.size[1]
            masks[i] = self._mask(grays[i], st.ref)
            ref_areas[i] = np.count_nonzero(masks[i]) / npx
            empty_areas[i] = np.count_nonzero(self._mask(grays[i], st.empty)) / npx
            st.last_mask = masks[i]

        def accept(new_empty: bool = False):
            for i in active:
                self.cams[i].ref = grays[i].copy()
                if new_empty:
                    self.cams[i].empty = grays[i].copy()
            # Steckt noch etwas in der Scheibe (auch nicht erkannte Darts)?
            self._dirty = (not new_empty) and any(empty_areas[i] >= cfg.empty_area for i in active)

        # 1) Scheibe wieder leer -> Darts entfernt
        board_used = self.status.darts_on_board > 0 or self._dirty
        if board_used and all(empty_areas[i] < cfg.empty_area for i in active):
            accept(new_empty=True)
            self.status.darts_on_board = 0
            for i in active:
                self.cams[i].last_obs = None
            return [{"type": "takeout"}]

        board_was_empty = self.status.darts_on_board == 0 and not self._dirty

        # 2) Hand war im Bild, Scheibe aber nicht leer (z. B. erst ein Teil gezogen)
        if hand:
            accept(new_empty=board_was_empty)
            return [{"type": "change", "reason": "hand"}]

        # 3) Kaum Veränderung -> nichts
        if max(ref_areas.values()) < cfg.min_dart_area:
            accept()
            return []

        # 4) Neuer Dart?
        obs: list[CamObservation] = []
        for i in active:
            cal = self.calibrations[i] if i < len(self.calibrations) else None
            if cal is None or not (cfg.min_dart_area <= ref_areas[i] <= cfg.max_dart_area):
                self.cams[i].last_obs = None
                continue
            o = observe_dart(i, masks[i], cal)
            self.cams[i].last_obs = o
            if o is not None:
                obs.append(o)
        if not obs:
            # Nur eine großflächige Änderung (z. B. Licht) wird zur neuen „leeren Scheibe“.
            # Ein kleiner, nicht gewerteter Fleck kann ein Dart sein: dann muss das Ziehen erkannt werden.
            lighting = all(ref_areas[i] > cfg.max_dart_area for i in active)
            accept(new_empty=board_was_empty and lighting)
            uncalibrated = all(self.calibrations[i] is None for i in active)
            return [{"type": "change", "reason": "unkalibriert" if uncalibrated else "unklar"}]

        x, y, method, used = fuse_observations(obs, cfg)
        hit = B.score_at(x, y)
        # Für die Aufzeichnung (Fehlersuche): Bilder vor und nach dem Dart, solange ref noch das alte ist
        self.last_dart_frames = {i: (self.cams[i].ref, grays[i]) for i in active}
        accept()
        self.status.darts_on_board += 1
        return [{"type": "dart", "x": x, "y": y, "hit": hit.to_dict(), "method": method,
                 "cams": used, "observations": [o.to_dict() for o in obs]}]

    # ------------------------------------------------------------------ Anzeige
    def debug_overlay(self, i: int, frame: np.ndarray) -> np.ndarray:
        st = self.cams[i] if i < len(self.cams) else None
        if st is None:
            return frame
        if st.last_mask is not None and st.last_mask.shape[:2] == frame.shape[:2]:
            red = np.zeros_like(frame)
            red[:, :, 2] = st.last_mask * 255
            frame = cv2.addWeighted(frame, 1.0, red, 0.6, 0)
        o = st.last_obs
        if o is not None:
            p1 = np.array(o.tip_img)
            p2 = np.array(o.tail_img)
            cv2.line(frame, tuple(map(int, p1)), tuple(map(int, p2)), (255, 255, 0), 1, cv2.LINE_AA)
            cv2.circle(frame, tuple(map(int, p1)), 6, (0, 255, 0), 2, cv2.LINE_AA)
        return frame


def observe_dart(cam: int, mask: np.ndarray, cal: Calibration) -> CamObservation | None:
    """Findet den neuen Dart im Differenzbild einer Kamera."""
    m = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    if n <= 1:
        return None
    k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    big = stats[k, cv2.CC_STAT_AREA]
    ys, xs = np.nonzero(labels == k)
    pts = np.column_stack([xs, ys]).astype(np.float32)
    vx, vy, x0, y0 = cv2.fitLine(pts, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
    # weitere Teile (z. B. dünne Spitze, abgetrennt) entlang der Geraden dazunehmen
    d = np.array([vx, vy], np.float64)
    nrm = np.array([-vy, vx], np.float64)
    p0 = np.array([x0, y0], np.float64)
    extra = []
    for j in range(1, n):
        if j == k or stats[j, cv2.CC_STAT_AREA] < 4:
            continue
        cy, cx = np.mean(np.nonzero(labels == j), axis=1)
        if abs((np.array([cx, cy]) - p0) @ nrm) < 6.0:
            yy, xx = np.nonzero(labels == j)
            extra.append(np.column_stack([xx, yy]))
    if extra:
        pts = np.vstack([pts] + [e.astype(np.float32) for e in extra])
        vx, vy, x0, y0 = cv2.fitLine(pts, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        d = np.array([vx, vy], np.float64)
        nrm = np.array([-vy, vx], np.float64)
        p0 = np.array([x0, y0], np.float64)

    rel = pts.astype(np.float64) - p0
    along = rel @ d
    across = np.abs(rel @ nrm)
    lo, hi = np.percentile(along, 0.5), np.percentile(along, 99.5)
    width = max(1.0, float(np.percentile(across, 90)) * 2)
    elongation = float((hi - lo) / width)
    e_lo = p0 + lo * d
    e_hi = p0 + hi * d
    depth = cal.board_depth([e_lo, e_hi])
    tip, tail = (e_lo, e_hi) if depth[0] >= depth[1] else (e_hi, e_lo)
    tip_board = cal.image_to_board([tip])[0]
    try:
        line = cal.image_line_to_board_line(p0, d)
    except ValueError:
        return None
    return CamObservation(cam=cam, area=int(big), p0=tuple(p0), d=tuple(d), tip_img=tuple(tip),
                          tail_img=tuple(tail), tip_board=(float(tip_board[0]), float(tip_board[1])),
                          line_board=tuple(float(v) for v in line), elongation=elongation)


def fuse_observations(obs: list[CamObservation], cfg: DetectorConfig) -> tuple[float, float, str, list[int]]:
    """Kombiniert die Beobachtungen der Kameras zu einer Trefferposition (mm)."""
    use = [o for o in obs if o.elongation >= 2.0] or obs
    if len(use) >= 2:
        while True:
            A = np.array([[o.line_board[0], o.line_board[1]] for o in use])
            rhs = -np.array([o.line_board[2] for o in use])
            sv = np.linalg.svd(A, compute_uv=False)
            min_sv = math.sqrt(1 - math.cos(math.radians(cfg.min_line_angle_deg)))
            if sv[-1] < min_sv:
                break
            p, *_ = np.linalg.lstsq(A, rhs, rcond=None)
            res = np.abs(A @ p - rhs)
            if len(use) >= 3 and res.max() > cfg.max_line_residual_mm:
                use = [o for j, o in enumerate(use) if j != int(np.argmax(res))]
                continue
            if math.hypot(p[0], p[1]) <= B.R_BOARD + 40:
                return float(p[0]), float(p[1]), "schnittpunkt", [o.cam for o in use]
            break
    # Rückfall: grobe Spitzenposition der Kamera mit dem deutlichsten Dart
    best = max(use, key=lambda o: o.elongation)
    return best.tip_board[0], best.tip_board[1], "eine kamera", [best.cam]


def _event_text(ev: dict) -> str:
    if ev["type"] == "dart":
        return f"Treffer {ev['hit']['label']}"
    if ev["type"] == "takeout":
        return "Darts entfernt"
    if ev.get("reason") == "hand":
        return "Hand erkannt"
    if ev.get("reason") == "unkalibriert":
        return "Änderung erkannt – Kamera nicht kalibriert"
    return "Änderung erkannt, kein Dart"
