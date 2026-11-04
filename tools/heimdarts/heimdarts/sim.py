"""Simulierte Kameras und Darts – zum Ausprobieren und Testen ohne echte Hardware."""
from __future__ import annotations

import math
import threading
from dataclasses import dataclass

import cv2
import numpy as np

from . import board as B


@dataclass
class VirtualCamera:
    K: np.ndarray
    R: np.ndarray   # Welt -> Kamera
    t: np.ndarray
    width: int
    height: int

    @staticmethod
    def looking_at(position, target, width=960, height=540, focal_factor=0.62) -> "VirtualCamera":
        C = np.asarray(position, np.float64)
        f = np.asarray(target, np.float64) - C
        f /= np.linalg.norm(f)
        up = np.array([0.0, 0.0, 1.0])
        right = np.cross(f, up)
        right /= np.linalg.norm(right)
        down = np.cross(f, right)
        R = np.vstack([right, down, f])
        t = -R @ C
        fl = focal_factor * width
        K = np.array([[fl, 0, width / 2.0], [0, fl, height / 2.0], [0, 0, 1.0]])
        return VirtualCamera(K, R, t, width, height)

    def project(self, X) -> tuple[np.ndarray, np.ndarray]:
        X = np.asarray(X, np.float64).reshape(-1, 3)
        Xc = X @ self.R.T + self.t
        depth = Xc[:, 2]
        p = Xc @ self.K.T
        return p[:, :2] / p[:, 2:3], depth

    def board_homography(self) -> np.ndarray:
        H = self.K @ np.column_stack([self.R[:, 0], self.R[:, 1], self.t])
        return H / H[2, 2]

    @property
    def focal(self) -> float:
        return float(self.K[0, 0])


def default_cameras(width=960, height=540) -> list[VirtualCamera]:
    """Drei Kameras ringförmig um die Scheibe, flach über die Scheibe blickend."""
    cams = []
    for phi in (-90.0, 30.0, 150.0):
        a = math.radians(phi)
        pos = (330 * math.cos(a), 330 * math.sin(a), 90.0)
        tgt = (40 * math.cos(a), 40 * math.sin(a), 0.0)
        cams.append(VirtualCamera.looking_at(pos, tgt, width, height))
    return cams


@dataclass
class SimDart:
    x: float
    y: float
    direction: np.ndarray
    color: tuple[int, int, int]


FLIGHT_COLORS = [(200, 80, 20), (30, 160, 230), (40, 200, 60), (180, 40, 160), (20, 20, 220)]

# Teile entlang der Dartachse: (von mm, bis mm, Durchmesser mm, Farbe BGR)
DART_PARTS = [(0.0, 20.0, 2.2, (205, 205, 205)), (20.0, 62.0, 7.0, (75, 75, 85)),
              (62.0, 95.0, 4.0, (35, 35, 35))]


class SimScene:
    def __init__(self, cameras: list[VirtualCamera] | None = None, seed: int | None = None,
                 noise: float = 1.5):
        self.cameras = cameras or default_cameras()
        self.rng = np.random.default_rng(seed)
        self.noise = noise
        self.darts: list[SimDart] = []
        self.hand: tuple[float, float, float] | None = None
        self.version = 0
        self.lock = threading.Lock()
        tex = B.render_board(px_per_mm=2.0)
        self._backgrounds = [self._render_background(c, tex) for c in self.cameras]

    # --------------------------------------------------------------- Szene ändern
    def throw(self, x: float, y: float, tilt_deg: float | None = None) -> SimDart:
        tilt = math.radians(tilt_deg if tilt_deg is not None else self.rng.normal(12, 6))
        side = math.radians(self.rng.normal(0, 8))
        v = np.array([math.sin(side), math.sin(tilt), math.cos(tilt) * math.cos(side)])
        v /= np.linalg.norm(v)
        with self.lock:
            dart = SimDart(float(x), float(y), v, FLIGHT_COLORS[len(self.darts) % len(FLIGHT_COLORS)])
            self.darts.append(dart)
            self.version += 1
        return dart

    def throw_at(self, label: str, spread_mm: float = 0.0) -> SimDart:
        x, y = B.target_point(label)
        if spread_mm > 0:
            x += self.rng.normal(0, spread_mm)
            y += self.rng.normal(0, spread_mm)
        return self.throw(x, y)

    def set_hand(self, pos: tuple[float, float, float] | None) -> None:
        with self.lock:
            self.hand = pos
            self.version += 1

    def clear(self) -> None:
        with self.lock:
            self.darts.clear()
            self.version += 1

    # --------------------------------------------------------------- Zeichnen
    def _render_background(self, cam: VirtualCamera, tex: np.ndarray) -> np.ndarray:
        s = 2.0
        c = (tex.shape[0] - 1) / 2.0
        T = np.array([[1 / s, 0, -c / s], [0, -1 / s, c / s], [0, 0, 1.0]])
        Hb = cam.board_homography()
        img = cv2.warpPerspective(tex, Hb @ T, (cam.width, cam.height), flags=cv2.INTER_LINEAR,
                                  borderMode=cv2.BORDER_CONSTANT, borderValue=(95, 100, 105))
        # Alles jenseits des Horizonts der Scheibenebene ist Raum, nicht Scheibe
        Hi = np.linalg.inv(Hb)
        horizon = Hi[2, :]
        ys, xs = np.mgrid[0:cam.height, 0:cam.width]
        side = horizon[0] * xs + horizon[1] * ys + horizon[2]
        cimg = Hb @ np.array([0, 0, 1.0])
        sign = np.sign(horizon @ cimg) or 1.0
        room = (side * sign) <= 0
        grad = np.linspace(120, 80, cam.height).astype(np.uint8)[:, None]
        img[room] = np.dstack([grad, grad + 5, grad + 10]).repeat(cam.width, axis=1)[room]
        return img

    def render(self, i: int, noise: bool = True) -> np.ndarray:
        cam = self.cameras[i]
        with self.lock:
            darts = list(self.darts)
            hand = self.hand
        img = self._backgrounds[i].copy()
        prims = []  # (Tiefe, Zeichenfunktion)
        for d in darts:
            tip = np.array([d.x, d.y, 0.0])
            for a, b, dia, col in DART_PARTS:
                P, depth = cam.project([tip + a * d.direction, tip + b * d.direction])
                if (depth <= 1).any():
                    continue
                th = max(1, int(round(dia * cam.focal / depth.mean())))
                prims.append((depth.mean(), ("line", P, th, col)))
            # Flights: zwei gekreuzte Trapeze
            ax0, ax1 = tip + 95 * d.direction, tip + 135 * d.direction
            u1 = np.cross(d.direction, [1.0, 0, 0])
            u1 /= np.linalg.norm(u1)
            u2 = np.cross(d.direction, u1)
            for u in (u1, u2):
                quad = [ax0 + 4 * u, ax1 + 17 * u, ax1 - 17 * u, ax0 - 4 * u]
                P, depth = cam.project(quad)
                if (depth <= 1).any():
                    continue
                prims.append((depth.mean(), ("poly", P, 0, d.color)))
        if hand is not None:
            P, depth = cam.project([hand])
            if depth[0] > 1:
                r = int(75 * cam.focal / depth[0])
                prims.append((depth[0], ("circle", P, r, (120, 160, 215))))
        for _, (kind, P, th, col) in sorted(prims, key=lambda p: -p[0]):
            if kind == "line":
                p1, p2 = P
                cv2.line(img, (int(p1[0]), int(p1[1])), (int(p2[0]), int(p2[1])), col, th, cv2.LINE_AA)
            elif kind == "poly":
                cv2.fillConvexPoly(img, P.astype(np.int32), col, cv2.LINE_AA)
            else:
                cv2.circle(img, (int(P[0][0]), int(P[0][1])), th, col, -1, cv2.LINE_AA)
        if noise and self.noise > 0:
            n = np.empty(img.shape, np.int16)
            cv2.randn(n, 0, self.noise)
            img = cv2.add(img.astype(np.int16), n, dtype=cv2.CV_16S)
            img = np.clip(img, 0, 255).astype(np.uint8)
        return img

    def calibration_clicks(self, i: int, jitter_px: float = 0.0) -> list[tuple[float, float]]:
        """Bildpunkte, die ein Nutzer beim Kalibrieren anklicken würde."""
        cam = self.cameras[i]
        pts = np.array([[p[0], p[1], 0.0] for _, p in B.CALIBRATION_POINTS])
        P, _ = cam.project(pts)
        if jitter_px > 0:
            P = P + self.rng.normal(0, jitter_px, P.shape)
        return [tuple(map(float, p)) for p in P]
