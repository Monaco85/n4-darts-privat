"""Kalibrierung: Zuordnung zwischen Kamerabild und Scheibenebene (Homographie)."""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from . import board as B


@dataclass
class Calibration:
    """Kalibrierung einer Kamera.

    image_points: angeklickte Bildpunkte (Pixel) in der Reihenfolge von board.CALIBRATION_POINTS.
    H: Homographie Scheibe (mm) -> Bild (Pixel).
    """
    image_points: list[tuple[float, float]]
    width: int
    height: int
    H: np.ndarray = field(repr=False)
    H_inv: np.ndarray = field(repr=False)
    reprojection_error: float = 0.0

    @staticmethod
    def from_points(image_points, width: int, height: int) -> "Calibration":
        img = np.asarray(image_points, np.float64).reshape(-1, 2)
        brd = np.asarray([p for _, p in B.CALIBRATION_POINTS[: len(img)]], np.float64)
        if len(img) < 4:
            raise ValueError("Mindestens 4 Kalibrierpunkte nötig")
        H, _ = cv2.findHomography(brd, img, 0)
        if H is None:
            raise ValueError("Homographie konnte nicht berechnet werden – Punkte prüfen")
        H = H / H[2, 2]
        H_inv = np.linalg.inv(H)
        proj = apply_h(H, brd)
        err = float(np.sqrt(np.mean(np.sum((proj - img) ** 2, axis=1))))
        return Calibration([tuple(map(float, p)) for p in img], int(width), int(height), H, H_inv,
                           reprojection_error=err)

    def to_dict(self) -> dict:
        return {"image_points": [list(p) for p in self.image_points], "width": self.width,
                "height": self.height}

    @staticmethod
    def from_dict(d: dict) -> "Calibration":
        return Calibration.from_points(d["image_points"], d["width"], d["height"])

    # --- Umrechnungen ---
    def image_to_board(self, pts) -> np.ndarray:
        return apply_h(self.H_inv, pts)

    def board_to_image(self, pts) -> np.ndarray:
        return apply_h(self.H, pts)

    def image_line_to_board_line(self, p0, d) -> np.ndarray:
        """Bildgerade (Punkt p0, Richtung d) -> Gerade a*x + b*y + c = 0 auf der Scheibe (normiert)."""
        p1 = np.array([p0[0], p0[1], 1.0])
        p2 = np.array([p0[0] + d[0], p0[1] + d[1], 1.0])
        l_img = np.cross(p1, p2)
        l_brd = self.H.T @ l_img
        n = math.hypot(l_brd[0], l_brd[1])
        if n < 1e-12:
            raise ValueError("Entartete Gerade")
        return l_brd / n

    def board_depth(self, pts) -> np.ndarray:
        """Wie weit Bildpunkte auf der Scheibenseite des Horizonts liegen (größer = näher an der Scheibe).

        Teile des Darts, die aus der Scheibe ragen, liegen im Bild näher am Horizont der Scheibenebene
        als die Spitze. Damit lässt sich ohne Kenntnis der Optik entscheiden, welches Ende die Spitze ist.
        """
        horizon = self.H_inv[2, :]
        p = np.asarray(pts, np.float64).reshape(-1, 2)
        center = self.board_to_image([(0.0, 0.0)])[0]
        sign = 1.0 if horizon @ np.array([center[0], center[1], 1.0]) > 0 else -1.0
        n = math.hypot(horizon[0], horizon[1]) or 1.0
        return sign * (np.hstack([p, np.ones((len(p), 1))]) @ horizon) / n


def apply_h(H: np.ndarray, pts) -> np.ndarray:
    p = np.asarray(pts, np.float64).reshape(-1, 2)
    ph = np.hstack([p, np.ones((len(p), 1))]) @ H.T
    return ph[:, :2] / ph[:, 2:3]


def draw_overlay(frame: np.ndarray, cal: Calibration, color=(0, 255, 255)) -> np.ndarray:
    """Zeichnet Ringe und Segmentgrenzen der kalibrierten Scheibe ins Kamerabild."""
    out = frame
    for rad in (B.R_BULL, B.R_OUTER_BULL, B.R_TRIPLE_IN, B.R_TRIPLE_OUT, B.R_DOUBLE_IN, B.R_DOUBLE_OUT):
        angs = np.linspace(0, 2 * math.pi, 180)
        pts = np.column_stack([rad * np.cos(angs), rad * np.sin(angs)])
        ip = cal.board_to_image(pts).astype(np.int32)
        cv2.polylines(out, [ip], True, color, 1, cv2.LINE_AA)
    for i in range(20):
        a = math.radians(90.0 + 9.0 - 18.0 * i)
        seg = np.array([[B.R_OUTER_BULL * math.cos(a), B.R_OUTER_BULL * math.sin(a)],
                        [B.R_DOUBLE_OUT * math.cos(a), B.R_DOUBLE_OUT * math.sin(a)]])
        ip = cal.board_to_image(seg).astype(np.int32)
        cv2.line(out, tuple(ip[0]), tuple(ip[1]), color, 1, cv2.LINE_AA)
    # Zahl 20 zur Orientierung
    p20 = cal.board_to_image([(0, (B.R_DOUBLE_OUT + B.R_BOARD) / 2)])[0]
    cv2.putText(out, "20", (int(p20[0]) - 10, int(p20[1]) + 6), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2, cv2.LINE_AA)
    return out
