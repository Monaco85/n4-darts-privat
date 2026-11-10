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
    min_elongation: float = 3.0       # so länglich muss ein Fleck sein, damit seine Achse zählt
    min_line_frac: float = 0.03       # Mindestlänge des Flecks (Anteil der Bilddiagonale)
    min_blob_px: int = 5              # kleinere Flecken sind Rauschen (dünne Linien bleiben erhalten)
    normalize_brightness: bool = True # Helligkeitssprünge (Belichtungsautomatik) ausgleichen
    shadow_filter: bool = True        # Schatten nicht als Dart werten

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
    length: float = 0.0               # Länge des Flecks in px
    rel_length: float = 0.0           # Länge / Bilddiagonale

    @property
    def quality(self) -> float:
        return self.elongation * self.rel_length

    def to_dict(self) -> dict:
        return {k: (list(v) if isinstance(v, tuple) else v) for k, v in asdict(self).items()}


@dataclass
class _CamState:
    ref: np.ndarray | None = None
    ref_bgr: np.ndarray | None = None
    empty: np.ndarray | None = None
    empty_preset: np.ndarray | None = None
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
        self.empty_changed = False        # die App speichert dann die leere Scheibe
        self._bgrs: list[np.ndarray | None] = []

    # ------------------------------------------------------------------ Verwaltung
    def accept_current(self) -> None:
        """Aktuelles Bild als Referenz übernehmen, ohne die leere Scheibe zu vergessen (nach Reset)."""
        self._accept_next = True
    def preset_empty(self, i: int, gray: np.ndarray | None) -> None:
        """Gespeicherte leere Scheibe (vom letzten Lauf). Steckt beim Start noch ein Dart, wird
        so das Ziehen trotzdem erkannt, statt die Scheibe mit Dart für leer zu halten."""
        if 0 <= i < len(self.cams):
            self.cams[i].empty_preset = gray

    def empty_images(self) -> dict[int, np.ndarray]:
        return {i: c.empty for i, c in enumerate(self.cams) if c.empty is not None}

    def set_calibration(self, i: int, cal: Calibration | None) -> None:
        self.calibrations[i] = cal

    def reset(self) -> None:
        """Nächstes ruhiges Bild wird neue Referenz (Scheibe muss leer sein)."""
        for c in self.cams:
            c.ref = c.empty = c.prev = c.ref_bgr = None
            c.empty_preset = None
            c.last_mask = None
            c.last_obs = None
        self.status = DetectorStatus(message="Referenz wird neu aufgenommen")
        self._stable = 0
        self._in_motion = False
        self._motion_ticks = 0
        self._peak_area = 0.0
        self._dirty = False

    def _prep(self, frame: np.ndarray) -> tuple[np.ndarray, np.ndarray | None]:
        k = self.config.blur | 1
        if frame.ndim == 3:
            bgr = cv2.GaussianBlur(frame, (k, k), 0)
            return cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), bgr
        return cv2.GaussianBlur(frame, (k, k), 0), None

    def _mask(self, a: np.ndarray, b: np.ndarray) -> np.ndarray:
        """Veränderte Pixel von a gegenüber b."""
        if self.config.normalize_brightness:
            a = match_brightness(a, b)
        m = (cv2.absdiff(a, b) > self.config.diff_threshold).astype(np.uint8)
        return remove_small(m, self.config.min_blob_px)

    # ------------------------------------------------------------------ Hauptschleife
    def process(self, frames: list[np.ndarray | None]) -> list[dict]:
        cfg = self.config
        grays: list[np.ndarray | None] = []
        bgrs_now: list[np.ndarray | None] = [None] * len(frames)
        self._bgrs = bgrs_now
        for i, f in enumerate(frames):
            if f is None:
                grays.append(None)
                continue
            g, bgr = self._prep(f)
            st = self.cams[i]
            if st.size != (g.shape[1], g.shape[0]):
                st.size = (g.shape[1], g.shape[0])
                st.ref = st.empty = st.prev = st.ref_bgr = None
            grays.append(g)
            bgrs_now[i] = bgr
        active = [i for i, g in enumerate(grays) if g is not None]
        if not active:
            self.status.message = "Keine Kamerabilder"
            return []

        # Erste Bilder werden Referenz
        if any(self.cams[i].ref is None for i in active):
            dirty = False
            for i in active:
                st = self.cams[i]
                if st.ref is None:
                    st.ref = grays[i].copy()
                    st.ref_bgr = None if bgrs_now[i] is None else bgrs_now[i].copy()
                    pre = st.empty_preset
                    if pre is not None and pre.shape == grays[i].shape:
                        st.empty = pre.copy()
                        npx = grays[i].size
                        if np.count_nonzero(self._mask(grays[i], pre)) / npx >= cfg.empty_area:
                            dirty = True
                    else:
                        st.empty = grays[i].copy()
                        self.empty_changed = True
                st.prev = grays[i]
            self._dirty = self._dirty or dirty
            self.status.state = "bereit"
            self.status.message = "Darts in der Scheibe? Bitte ziehen" if dirty else "Bereit"
            return []

        if self._accept_next:
            self._accept_next = False
            for i in active:
                st = self.cams[i]
                st.ref = grays[i].copy()
                st.ref_bgr = None if bgrs_now[i] is None else bgrs_now[i].copy()
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
                area = np.count_nonzero(self._mask(grays[i], st.ref)) / npx
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
            area = np.count_nonzero(self._mask(grays[i], st.ref))
            if area < 0.5 * cfg.min_dart_area * npx:
                st.ref = cv2.addWeighted(st.ref, 0.5, grays[i], 0.5, 0)
                bgr = self._bgrs[i] if i < len(self._bgrs) else None
                if bgr is not None and st.ref_bgr is not None and bgr.shape == st.ref_bgr.shape:
                    st.ref_bgr = cv2.addWeighted(st.ref_bgr, 0.5, bgr, 0.5, 0)
                if self.status.darts_on_board == 0 and not self._dirty:
                    st.empty = st.ref.copy()
                    self.empty_changed = True

    def _evaluate(self, grays, active, hand: bool) -> list[dict]:
        cfg = self.config
        ref_areas: dict[int, float] = {}
        empty_areas: dict[int, float] = {}
        masks: dict[int, np.ndarray] = {}
        for i in active:
            st = self.cams[i]
            npx = st.size[0] * st.size[1]
            masks[i] = self._mask(grays[i], st.ref)
            bgr = self._bgrs[i] if i < len(self._bgrs) else None
            cal = self.calibrations[i] if i < len(self.calibrations) else None
            if cfg.shadow_filter and cal is not None and bgr is not None and st.ref_bgr is not None                     and bgr.shape == st.ref_bgr.shape:
                # Nur auf der Scheibe: Davor (Wand, Surround) sieht ein graues Barrel sonst aus wie ein Schatten
                shadow = shadow_mask(bgr, st.ref_bgr) & board_mask(cal, bgr.shape[:2])
                masks[i] = remove_small(masks[i] & (1 - shadow), cfg.min_blob_px)
            ref_areas[i] = np.count_nonzero(masks[i]) / npx
            empty_areas[i] = np.count_nonzero(self._mask(grays[i], st.empty)) / npx
            st.last_mask = masks[i]

        def accept(new_empty: bool = False):
            for i in active:
                self.cams[i].ref = grays[i].copy()
                bgr = self._bgrs[i] if i < len(self._bgrs) else None
                self.cams[i].ref_bgr = None if bgr is None else bgr.copy()
                if new_empty:
                    self.cams[i].empty = grays[i].copy()
                    self.empty_changed = True
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
    length = float(hi - lo)
    diag = math.hypot(mask.shape[0], mask.shape[1])
    return CamObservation(cam=cam, area=int(big), p0=tuple(p0), d=tuple(d), tip_img=tuple(tip),
                          tail_img=tuple(tail), tip_board=(float(tip_board[0]), float(tip_board[1])),
                          line_board=tuple(float(v) for v in line), elongation=elongation,
                          length=length, rel_length=length / diag)


def _intersect(use: list[CamObservation], cfg: DetectorConfig):
    """Schnittpunkt der Geraden (kleinste Quadrate). None, wenn sie zu parallel sind."""
    A = np.array([[o.line_board[0], o.line_board[1]] for o in use])
    rhs = -np.array([o.line_board[2] for o in use])
    sv = np.linalg.svd(A, compute_uv=False)
    if sv[-1] < math.sqrt(1 - math.cos(math.radians(cfg.min_line_angle_deg))):
        return None
    p, *_ = np.linalg.lstsq(A, rhs, rcond=None)
    return p


def _line_dist(o: CamObservation, p) -> float:
    a, b, c = o.line_board
    return abs(a * p[0] + b * p[1] + c)


def fuse_observations(obs: list[CamObservation], cfg: DetectorConfig) -> tuple[float, float, str, list[int]]:
    """Kombiniert die Beobachtungen der Kameras zu einer Trefferposition (mm).

    Nur deutlich längliche, ausreichend lange Flecken liefern eine verlässliche Achse. Sieht eine
    Kamera z. B. nur den Flight, ist ihre Gerade Zufall – sie zählt dann höchstens als Notnagel.
    Bei drei Geraden fliegt die raus, die am weitesten neben dem Schnitt der beiden anderen liegt.
    """
    good = sorted([o for o in obs if o.elongation >= cfg.min_elongation and o.rel_length >= cfg.min_line_frac],
                  key=lambda o: o.quality, reverse=True)
    use = list(good)
    if len(use) < 2:
        weaker = sorted([o for o in obs if o not in use and o.elongation >= 2.0], key=lambda o: o.quality, reverse=True)
        use += weaker[: 2 - len(use)]
    while len(use) >= 3:
        q_all = _intersect(use, cfg)
        if q_all is not None and max(_line_dist(o, q_all) for o in use) <= cfg.max_line_residual_mm:
            break
        # Eine Linie passt nicht. Geometrisch schneiden sich alle Paare irgendwo – entscheidend ist,
        # ob der Schnittpunkt zu den grob gesehenen Spitzen der beteiligten Kameras passt.
        costs = []
        for j in range(len(use)):
            rest = [o for k, o in enumerate(use) if k != j]
            q = _intersect(rest, cfg)
            if q is None:
                costs.append(np.inf)
                continue
            costs.append(float(np.mean([min(math.hypot(q[0] - o.tip_board[0], q[1] - o.tip_board[1]), 80.0)
                                        for o in rest])))
        if not np.isfinite(min(costs)):
            break
        use.pop(int(np.argmin(costs)))
    if len(use) >= 2:
        p = _intersect(use, cfg)
        if p is None and len(use) >= 3:      # zu parallel: das beste Paar mit gutem Winkel nehmen
            for j in range(len(use)):
                p = _intersect([o for k, o in enumerate(use) if k != j], cfg)
                if p is not None:
                    use = [o for k, o in enumerate(use) if k != j]
                    break
        if p is not None and math.hypot(p[0], p[1]) <= B.R_BOARD + 40:
            return float(p[0]), float(p[1]), "schnittpunkt", [o.cam for o in use]
    # Rückfall: grobe Spitzenposition der Kamera mit dem deutlichsten Dart
    best = max(obs, key=lambda o: o.quality)
    return best.tip_board[0], best.tip_board[1], "eine kamera", [best.cam]


def match_brightness(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Gleicht die Gesamthelligkeit von a an b an (Belichtungsautomatik der Kamera)."""
    # Median der Verhältnisse pro Pixel: Ein Dart betrifft nur wenige Pixel und verschiebt ihn nicht,
    # eine geänderte Belichtung dagegen alle.
    sa = a[::4, ::4].astype(np.float32)
    sb = b[::4, ::4].astype(np.float32)
    ok = (sa >= 30) & (sb >= 30)
    if ok.sum() < 100:
        return a
    gain = float(np.median(sb[ok] / sa[ok]))
    if abs(gain - 1.0) < 0.02:
        return a
    return cv2.convertScaleAbs(a, alpha=gain)


def remove_small(mask: np.ndarray, min_px: int) -> np.ndarray:
    """Entfernt winzige Flecken, lässt aber dünne Linien (Spitze, Schaft) stehen."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n <= 1:
        return mask
    keep = np.zeros(n, np.uint8)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= min_px
    return keep[labels]


_BOARD_MASKS: dict[tuple, np.ndarray] = {}


def board_mask(cal: Calibration, shape) -> np.ndarray:
    """Fläche der Scheibe (bis zum Außenrand) im Kamerabild."""
    key = (id(cal), tuple(shape))
    m = _BOARD_MASKS.get(key)
    if m is None:
        if len(_BOARD_MASKS) > 16:
            _BOARD_MASKS.clear()
        angs = np.linspace(0, 2 * np.pi, 180, endpoint=False)
        pts = np.column_stack([B.R_BOARD * np.cos(angs), B.R_BOARD * np.sin(angs)])
        img = cal.board_to_image(pts)
        ok = cal.board_depth(img) > 0                   # nur Punkte vor dem Horizont
        m = np.zeros(shape, np.uint8)
        if ok.sum() >= 3:
            cv2.fillPoly(m, [np.round(img[ok]).astype(np.int32)], 1)
        _BOARD_MASKS[key] = m
    return m


def shadow_mask(cur_bgr: np.ndarray, ref_bgr: np.ndarray) -> np.ndarray:
    """Schatten: Pixel wird dunkler (auf 50–92 %), Farbe bleibt fast gleich. Ein Dart dagegen
    ändert entweder die Farbe oder die Helligkeit viel stärker (dunkles Barrel auf hellem Feld)."""
    c = cv2.cvtColor(cur_bgr, cv2.COLOR_BGR2LAB).astype(np.int16)
    r = cv2.cvtColor(ref_bgr, cv2.COLOR_BGR2LAB).astype(np.int16)
    ratio = (c[..., 0] + 1) / (r[..., 0] + 1.0)
    chroma = np.abs(c[..., 1] - r[..., 1]) + np.abs(c[..., 2] - r[..., 2])
    return ((ratio >= 0.5) & (ratio <= 0.92) & (chroma <= 8) & (r[..., 0] >= 40)).astype(np.uint8)


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
