"""Geometrie einer Standard-Steeldartscheibe und Wertung von Treffern.

Koordinatensystem der Scheibe (Millimeter):
  Ursprung = Mitte Bull, x nach rechts, y nach oben (von vorne gesehen),
  z zeigt aus der Scheibe heraus in Richtung Werfer.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, asdict

import numpy as np

# Radien in mm (übliche Turniermaße)
R_BULL = 6.35          # Bullseye (50)
R_OUTER_BULL = 15.9    # Single Bull (25)
R_TRIPLE_IN = 99.0
R_TRIPLE_OUT = 107.0
R_DOUBLE_IN = 162.0
R_DOUBLE_OUT = 170.0
R_BOARD = 225.5        # Außenrand der Scheibe (schwarzer Rand mit Zahlen)

# Segmente im Uhrzeigersinn, beginnend oben
SEGMENTS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5]


def segment_center_angle(number: int) -> float:
    """Winkel (Grad, gegen den Uhrzeigersinn ab +x) der Segmentmitte."""
    i = SEGMENTS.index(number)
    return 90.0 - 18.0 * i


def boundary_point(left: int, right: int, radius: float = R_DOUBLE_OUT) -> tuple[float, float]:
    """Punkt auf der Grenze zwischen zwei benachbarten Segmenten."""
    a = segment_center_angle(left)
    b = segment_center_angle(right)
    # Mittelwert der Winkel unter Beachtung des Sprungs bei 180°
    d = ((b - a + 540.0) % 360.0) - 180.0
    if abs(abs(d) - 18.0) > 1e-6:
        raise ValueError(f"Segmente {left} und {right} sind nicht benachbart")
    ang = math.radians(a + d / 2.0)
    return radius * math.cos(ang), radius * math.sin(ang)


# Kalibrierpunkte: Namen für die Oberfläche und Lage auf der Scheibe.
CALIBRATION_POINTS = [
    ("Doppel-Außenkante zwischen 20 und 1", boundary_point(20, 1)),
    ("Doppel-Außenkante zwischen 6 und 10", boundary_point(6, 10)),
    ("Doppel-Außenkante zwischen 3 und 19", boundary_point(3, 19)),
    ("Doppel-Außenkante zwischen 11 und 14", boundary_point(11, 14)),
    ("Mitte des Bullseye", (0.0, 0.0)),
]


@dataclass
class Hit:
    number: int        # 0 = daneben, 1..20, 25 = Bull
    multiplier: int    # 0 daneben, 1 Single, 2 Double, 3 Triple (Bullseye = 25 x 2)
    x: float | None = None
    y: float | None = None

    @property
    def score(self) -> int:
        return self.number * self.multiplier

    @property
    def label(self) -> str:
        if self.multiplier == 0 or self.number == 0:
            return "0"
        if self.number == 25:
            return "BULL" if self.multiplier == 2 else "25"
        return {1: "S", 2: "D", 3: "T"}[self.multiplier] + str(self.number)

    @property
    def is_double(self) -> bool:
        return self.multiplier == 2

    def to_dict(self) -> dict:
        d = asdict(self)
        d["score"] = self.score
        d["label"] = self.label
        return d

    @staticmethod
    def from_dict(d: dict) -> "Hit":
        return Hit(int(d["number"]), int(d["multiplier"]), d.get("x"), d.get("y"))


def score_at(x: float, y: float) -> Hit:
    """Wertung für einen Treffer an (x, y) in mm."""
    r = math.hypot(x, y)
    if r <= R_BULL:
        return Hit(25, 2, x, y)
    if r <= R_OUTER_BULL:
        return Hit(25, 1, x, y)
    if r > R_DOUBLE_OUT:
        return Hit(0, 0, x, y)
    ang = math.degrees(math.atan2(y, x))
    # Index im Uhrzeigersinn ab oben; Segment 20 reicht von 81° bis 99°
    idx = int(((90.0 + 9.0 - ang) % 360.0) // 18.0)
    number = SEGMENTS[idx]
    if R_TRIPLE_IN <= r <= R_TRIPLE_OUT:
        mult = 3
    elif R_DOUBLE_IN <= r <= R_DOUBLE_OUT:
        mult = 2
    else:
        mult = 1
    return Hit(number, mult, x, y)


_LABEL_RE = re.compile(r"^([SDT]?)(\d{1,2})$")


def parse_label(text: str) -> Hit:
    """Wandelt eine Eingabe wie "T20", "D16", "S5", "5", "25", "BULL", "50", "0" in einen Treffer um."""
    t = text.strip().upper().replace(" ", "")
    if t in ("0", "MISS", "DANEBEN", "M", "-"):
        return Hit(0, 0)
    if t in ("BULL", "BULLSEYE", "50", "DB", "D25"):
        return Hit(25, 2)
    if t in ("25", "SB", "S25", "OB"):
        return Hit(25, 1)
    m = _LABEL_RE.match(t)
    if not m:
        raise ValueError(f"Unbekannte Eingabe: {text!r}")
    prefix, num = m.group(1), int(m.group(2))
    if not 1 <= num <= 20:
        raise ValueError(f"Ungültige Zahl: {num}")
    mult = {"": 1, "S": 1, "D": 2, "T": 3}[prefix]
    return Hit(num, mult)


def target_point(label: str) -> tuple[float, float]:
    """Mittelpunkt eines Zielfeldes in mm (für Simulation und Tests)."""
    h = parse_label(label)
    if h.number == 0:
        return 0.0, R_DOUBLE_OUT + 25.0
    if h.number == 25:
        return (0.0, 0.0) if h.multiplier == 2 else (0.0, (R_BULL + R_OUTER_BULL) / 2)
    ang = math.radians(segment_center_angle(h.number))
    r = {1: (R_TRIPLE_OUT + R_DOUBLE_IN) / 2, 2: (R_DOUBLE_IN + R_DOUBLE_OUT) / 2,
         3: (R_TRIPLE_IN + R_TRIPLE_OUT) / 2}[h.multiplier]
    return r * math.cos(ang), r * math.sin(ang)


def render_board(px_per_mm: float = 2.0, size_mm: float = 2 * R_BOARD + 10) -> np.ndarray:
    """Zeichnet eine Scheibe von vorne (BGR-Bild). Mitte des Bildes = Bull.

    Wird für die Simulation genutzt. Bildpixel (u, v) ↔ mm: x = (u - c)/s, y = -(v - c)/s.
    """
    import cv2

    n = int(round(size_mm * px_per_mm))
    c = (n - 1) / 2.0
    img = np.full((n, n, 3), (60, 60, 60), np.uint8)
    ys, xs = np.mgrid[0:n, 0:n]
    x = (xs - c) / px_per_mm
    y = -(ys - c) / px_per_mm
    r = np.hypot(x, y)
    ang = np.degrees(np.arctan2(y, x))
    idx = (((90.0 + 9.0 - ang) % 360.0) // 18.0).astype(int)
    even = (idx % 2) == 0  # 20, 18, 13, ... -> schwarz / rot

    black = np.array((25, 25, 25), np.uint8)
    cream = np.array((190, 225, 235), np.uint8)
    red = np.array((40, 40, 200), np.uint8)
    green = np.array((60, 150, 30), np.uint8)

    img[r <= R_BOARD] = (15, 15, 15)
    single = r <= R_DOUBLE_OUT
    img[single & even] = black
    img[single & ~even] = cream
    ring = ((r >= R_TRIPLE_IN) & (r <= R_TRIPLE_OUT)) | ((r >= R_DOUBLE_IN) & (r <= R_DOUBLE_OUT))
    img[ring & even] = red
    img[ring & ~even] = green
    img[r <= R_OUTER_BULL] = green
    img[r <= R_BULL] = red

    # Drahtgitter
    wire = (170, 170, 170)
    for rad in (R_BULL, R_OUTER_BULL, R_TRIPLE_IN, R_TRIPLE_OUT, R_DOUBLE_IN, R_DOUBLE_OUT):
        cv2.circle(img, (int(round(c)), int(round(c))), int(round(rad * px_per_mm)), wire, 1, cv2.LINE_AA)
    for i in range(20):
        a = math.radians(90.0 + 9.0 - 18.0 * i)
        p1 = (c + R_OUTER_BULL * px_per_mm * math.cos(a), c - R_OUTER_BULL * px_per_mm * math.sin(a))
        p2 = (c + R_DOUBLE_OUT * px_per_mm * math.cos(a), c - R_DOUBLE_OUT * px_per_mm * math.sin(a))
        cv2.line(img, (int(p1[0]), int(p1[1])), (int(p2[0]), int(p2[1])), wire, 1, cv2.LINE_AA)
    # Zahlen
    for num in SEGMENTS:
        a = math.radians(segment_center_angle(num))
        rr = (R_DOUBLE_OUT + R_BOARD) / 2 * px_per_mm
        txt = str(num)
        scale = 0.9 * px_per_mm / 2.0
        (tw, th), _ = cv2.getTextSize(txt, cv2.FONT_HERSHEY_SIMPLEX, scale, 2)
        px = int(c + rr * math.cos(a) - tw / 2)
        py = int(c - rr * math.sin(a) + th / 2)
        cv2.putText(img, txt, (px, py), cv2.FONT_HERSHEY_SIMPLEX, scale, (230, 230, 230), 2, cv2.LINE_AA)
    return img
