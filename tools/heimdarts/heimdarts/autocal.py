"""Automatische Kalibrierung: findet die Scheibe im Kamerabild – ohne Klicken.

Ablauf:
  1. Rote und grüne Pixel suchen. Doppel- und Triple-Ring sind die beiden großen ringförmigen
     Flecken; an ihre Außenkanten (170 mm und 107 mm) wird je eine Ellipse gelegt.
  2. Entlang jeder Ellipse die Wechsel Rot↔Grün suchen. Das sind die Segmentgrenzen – Punkte mit
     bekannter Lage auf der Scheibe. Zusammen mit der Bull-Mitte ergibt das die Homographie.
  3. Die Farben wiederholen sich alle zwei Segmente, die Lage der 20 ist also noch offen (10
     Möglichkeiten). Entschieden wird über die vorige Kalibrierung, sonst über den Zahlenring:
     zwei- und einstellige Zahlen wechseln sich in einem eindeutigen Muster ab.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

from . import board as B
from .calibration import Calibration, apply_h

DIGITS = np.array([len(str(n)) for n in B.SEGMENTS], np.float64)
CAL_BOARD = np.array([p for _, p in B.CALIBRATION_POINTS], np.float64)


@dataclass
class AutoCalResult:
    ok: bool
    message: str
    calibration: Calibration | None = None
    rotation_source: str = ""      # vorher | zahlen | unsicher
    rms_px: float = 0.0
    transitions: int = 0
    number_score: float = 0.0

    def to_dict(self) -> dict:
        return {"ok": self.ok, "message": self.message, "rotation_source": self.rotation_source,
                "rms_px": round(self.rms_px, 2), "transitions": self.transitions,
                "number_score": round(self.number_score, 2)}


def rot3(deg: float) -> np.ndarray:
    a = math.radians(deg)
    return np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1.0]])


def rotate_calibration(cal: Calibration, steps: int) -> Calibration:
    """Dreht eine Kalibrierung um steps × 36° (zwei Segmente, die Farben passen danach weiter)."""
    H = cal.H @ rot3(36.0 * steps)
    pts = apply_h(H, CAL_BOARD)
    return Calibration.from_points(pts, cal.width, cal.height)


def set_twenty(cal: Calibration, x: float, y: float) -> Calibration:
    """Ein grober Klick ins Feld der 20 legt die Drehung fest."""
    bx, by = cal.image_to_board([(x, y)])[0]
    if math.hypot(bx, by) < B.R_OUTER_BULL or math.hypot(bx, by) > B.R_BOARD:
        raise ValueError("Bitte in ein Feld der Scheibe klicken, nicht ins Bull oder daneben")
    ang = math.degrees(math.atan2(by, bx))
    idx = int(((90.0 + 9.0 - ang) % 360.0) // 18.0)
    if idx % 2:
        # Grünes/helles Feld: Die 20 hat rote Ringe. Nimm das nähere Nachbarfeld.
        center = 90.0 - 18.0 * idx
        d = ((ang - center + 540.0) % 360.0) - 180.0
        idx = (idx - 1) % 20 if d > 0 else (idx + 1) % 20
    steps = -(idx // 2) if idx <= 10 else (20 - idx) // 2
    return rotate_calibration(cal, steps) if steps else cal


# ---------------------------------------------------------------------------------- Farben
def _lab_masks(frame: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """Rot/Grün über den a*-Kanal (Lab): robuster als Sättigung bei blassen Farben echter Kameras."""
    lab = cv2.cvtColor(cv2.GaussianBlur(frame, (3, 3), 0), cv2.COLOR_BGR2LAB).astype(np.int16)
    L, a, b = lab[..., 0], lab[..., 1] - 128, lab[..., 2] - 128
    red = (a >= 22) & (L > 45) & (b > -5)
    green = (a <= -14) & (L > 45)
    n = L.size
    if red.sum() > 0.003 * n and green.sum() > 0.003 * n:
        return red.astype(np.uint8), green.astype(np.uint8)
    return None


def color_masks(frame: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lab = _lab_masks(frame)
    if lab is not None:
        return lab
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    n = h.size
    red = green = None
    for s_min in (110, 85, 60, 45):
        sat = (s >= s_min) & (v >= 45)
        red = sat & ((h <= 10) | (h >= 166))
        green = sat & (h >= 36) & (h <= 96)
        if red.sum() > 0.002 * n and green.sum() > 0.002 * n:
            break
    return red.astype(np.uint8), green.astype(np.uint8)


# ---------------------------------------------------------------------------------- Ringe
@dataclass
class _Ring:
    center: tuple[float, float]
    axes: tuple[float, float]     # Halbachsen
    angle: float                  # Grad
    hull_area: float

    def point(self, t: np.ndarray, scale: float | np.ndarray = 1.0) -> np.ndarray:
        a = math.radians(self.angle)
        ca, sa = math.cos(a), math.sin(a)
        x = self.axes[0] * np.cos(t) * scale
        y = self.axes[1] * np.sin(t) * scale
        return np.stack([self.center[0] + ca * x - sa * y, self.center[1] + sa * x + ca * y], axis=-1)


def _fit_ring(contour: np.ndarray, shape) -> _Ring | None:
    h, w = shape[:2]
    pts = contour.reshape(-1, 2).astype(np.float64)
    inside = (pts[:, 0] > 2) & (pts[:, 1] > 2) & (pts[:, 0] < w - 3) & (pts[:, 1] < h - 3)
    # Nur die Außenkante: Punkte auf der konvexen Hülle. Ist der Ring vom Bildrand abgeschnitten,
    # läuft die Kontur sonst auch an der Innenkante zurück.
    hull = cv2.convexHull(contour)
    on_hull = np.array([cv2.pointPolygonTest(hull, (float(x), float(y)), True) < 1.5 for x, y in pts])
    pts = pts[inside & on_hull]
    if len(pts) < 30:
        return None
    for _ in range(3):
        (cx, cy), (ew, eh), ang = cv2.fitEllipseAMS(pts.astype(np.float32))
        if not (np.isfinite([cx, cy, ew, eh]).all() and ew > 4 and eh > 4):
            return None
        a = math.radians(ang)
        d = pts - (cx, cy)
        u = (d[:, 0] * math.cos(a) + d[:, 1] * math.sin(a)) / (ew / 2)
        v = (-d[:, 0] * math.sin(a) + d[:, 1] * math.cos(a)) / (eh / 2)
        r = np.hypot(u, v)
        keep = np.abs(r - 1) < 0.02
        if keep.all() or keep.sum() < 30:
            break
        pts = pts[keep]
    return _Ring((cx, cy), (ew / 2, eh / 2), ang, 0.0)


def find_rings(red: np.ndarray, green: np.ndarray) -> tuple[_Ring | None, _Ring | None]:
    rg = cv2.morphologyEx(red | green, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    rg = cv2.morphologyEx(rg, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n_px = rg.size
    n, labels, stats, cents = cv2.connectedComponentsWithStats(rg, connectivity=8)
    rings = []
    for j in range(1, n):
        area = stats[j, cv2.CC_STAT_AREA]
        if area < 0.0004 * n_px:
            continue
        comp = (labels == j).astype(np.uint8)
        cs, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        c = max(cs, key=len)
        hull_area = cv2.contourArea(cv2.convexHull(c))
        if hull_area < 0.004 * n_px or area / hull_area > 0.5:
            continue          # kein Ring (zu klein oder voll ausgefüllt)
        ring = _fit_ring(c, rg.shape)
        if ring is not None:
            ring.hull_area = hull_area
            rings.append(ring)
    if not rings:
        return None, None
    rings.sort(key=lambda r: -r.hull_area)
    double = rings[0]
    treble = None
    for r in rings[1:]:
        ratio = r.hull_area / double.hull_area
        dist = math.hypot(r.center[0] - double.center[0], r.center[1] - double.center[1])
        if 0.15 < ratio < 0.75 and dist < 0.5 * max(double.axes):
            treble = r
            break
    return double, treble


# ---------------------------------------------------------------------------------- Übergänge
def _transitions(ring: _Ring, red: np.ndarray, green: np.ndarray, inner: float) -> list[tuple[float, int]]:
    """Wechsel Rot↔Grün entlang des Rings: Liste (t, Typ). Typ 0 = Rot→Grün, 1 = Grün→Rot (im Uhrzeigersinn)."""
    h, w = red.shape
    m = 1440
    t = np.linspace(0, 2 * np.pi, m, endpoint=False)
    # Breiter als der Ring selbst abtasten: innen liegen nur schwarze/helle Felder, und die
    # Perspektive verschiebt den Ring gegenüber der skalierten Ellipse ein wenig.
    scales = np.linspace(inner, 0.997, 9)
    pts = ring.point(t[:, None], scales[None, :])           # m × 7 × 2
    xi = np.round(pts[..., 0]).astype(int)
    yi = np.round(pts[..., 1]).astype(int)
    ok = (xi >= 0) & (yi >= 0) & (xi < w) & (yi < h)
    xi, yi = np.clip(xi, 0, w - 1), np.clip(yi, 0, h - 1)
    rc = (red[yi, xi] * ok).sum(axis=1)
    gc = (green[yi, xi] * ok).sum(axis=1)
    label = np.full(m, -1)
    label[(rc >= 2) & (rc > gc)] = 0
    label[(gc >= 2) & (gc > rc)] = 1
    # Läufe bilden; kurze Lücken (Drähte) überbrücken
    runs = []  # (start, end, label) mit end exklusiv, zyklisch
    start = 0
    for i in range(1, m + 1):
        if i == m or label[i] != label[start]:
            runs.append([start, i, label[start]])
            start = i
    if len(runs) > 1 and runs[0][2] == runs[-1][2]:   # zyklisch zusammenfügen
        runs[0][0] = runs[-1][0] - m
        runs.pop()
    min_run = m / 20 * 0.25
    colored = [r for r in runs if r[2] >= 0 and r[1] - r[0] >= min_run]
    out = []
    max_gap = m * 0.012
    for a, b in zip(colored, colored[1:] + colored[:1]):
        if a[2] == b[2]:
            continue
        gap = (b[0] - a[1]) % m
        if gap > max_gap:
            continue          # zu große Lücke: Übergang nicht sicher
        tm = ((a[1] + gap / 2.0) % m) * (2 * np.pi / m)
        out.append((tm, 0 if a[2] == 0 else 1))
    out.sort()
    return out


def _consecutive_run(trans: list[tuple[float, int]]) -> tuple[list[int], list[int]] | None:
    """Längstes Stück Ring ohne fehlende Grenze: Indizes in trans und ihre Grenz-Nummern k.

    Eine fehlende Grenze verdoppelt den Abstand zum Nachbarn sprunghaft; die Perspektive ändert die
    Abstände dagegen nur allmählich.
    """
    n = len(trans)
    if n < 6:
        return None
    ts = np.array([t for t, _ in trans])
    types = [k for _, k in trans]
    dts = np.diff(np.concatenate([ts, ts[:1] + 2 * np.pi]))
    good = []
    for i in range(n):
        nb = np.median([dts[(i - 1) % n], dts[(i + 1) % n]])
        good.append(types[(i + 1) % n] != types[i] and dts[i] < 1.6 * nb and dts[i] < np.pi / 4)
    if all(good):
        return list(range(n)), [types[0] + i for i in range(n)]
    # längste zyklische Folge guter Kanten
    best_len, best_start = 0, 0
    for s in range(n):
        if good[(s - 1) % n]:
            continue  # kein Anfang
        L = 0
        while L < n and good[(s + L) % n]:
            L += 1
        if L > best_len:
            best_len, best_start = L, s
    if best_len + 1 < 6:
        return None
    idx = [(best_start + j) % n for j in range(best_len + 1)]
    return idx, [types[idx[0]] + j for j in range(best_len + 1)]


def _assign_by_prediction(H: np.ndarray, pts: np.ndarray, types: list[int], radius: float) -> dict[int, int]:
    """Ordnet beobachtete Grenzen (Bildpunkte) der nächsten vorhergesagten Grenze mit passender Farbe zu."""
    pred = apply_h(H, _boundary_points(range(20), radius))
    spacing = np.hypot(*(pred - np.roll(pred, 1, axis=0)).T)
    tol = 0.45 * np.minimum(spacing, np.roll(spacing, -1))
    out: dict[int, tuple[int, float]] = {}
    for i, (p, typ) in enumerate(zip(pts, types)):
        d = np.hypot(*(pred - p).T)
        d[[k for k in range(20) if k % 2 != typ]] = np.inf
        k = int(np.argmin(d))
        if d[k] < tol[k] and (k not in out or d[k] < out[k][1]):
            out[k] = (i, float(d[k]))
    return {i: k for k, (i, _) in out.items()}


def _boundary_points(ks, radius: float) -> np.ndarray:
    ang = np.radians(81.0 - 18.0 * np.asarray(ks, np.float64))
    return np.column_stack([radius * np.cos(ang), radius * np.sin(ang)])


# ---------------------------------------------------------------------------------- Zahlenring
def number_widths(gray: np.ndarray, H: np.ndarray) -> np.ndarray:
    """Breite der Zahl (Grad) in jedem der 20 Segmente; NaN wo der Zahlenring nicht im Bild ist."""
    h, w = gray.shape
    phis = np.radians(np.arange(0, 360, 0.5))
    rs = np.arange(176.0, 222.0, 1.0)
    P = np.stack([np.outer(rs, np.cos(phis)), np.outer(rs, np.sin(phis))], axis=-1).reshape(-1, 2)
    img = apply_h(H, P).reshape(len(rs), len(phis), 2).astype(np.float32)
    valid = (img[..., 0] >= 0) & (img[..., 1] >= 0) & (img[..., 0] < w - 1) & (img[..., 1] < h - 1)
    strip = cv2.remap(gray, img[..., 0], img[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    vals = strip[valid]
    if vals.size < 100:
        return np.full(20, np.nan)
    thr, _ = cv2.threshold(vals.reshape(-1, 1).astype(np.uint8), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bright = (strip > thr) & valid
    ink = bright.sum(axis=0)
    colvalid = valid.mean(axis=0) > 0.8
    widths = np.full(20, np.nan)
    for i in range(20):
        c = (90.0 - 18.0 * i) % 360.0
        cols = (np.round((c + np.arange(-8.0, 8.01, 0.5)) / 0.5).astype(int)) % len(phis)
        if colvalid[cols].mean() < 0.7:
            continue
        # Ziffern füllen nur einen Teil ihres Feldes. Ist fast alles hell, liegt hier etwas anderes
        # (Wand, Licht, ungenaue Schätzung) – dieses Feld nicht werten.
        fill = bright[:, cols].sum() / max(1, valid[:, cols].sum())
        if fill > 0.45:
            continue
        inked = np.nonzero(ink[cols] >= 2)[0]
        widths[i] = (inked[-1] - inked[0] + 1) * 0.5 if len(inked) else 0.0
    return widths


def _ranks(x: np.ndarray) -> np.ndarray:
    order = np.argsort(x, kind="stable")
    r = np.empty(len(x))
    r[order] = np.arange(len(x))
    for v in np.unique(x):          # gleiche Werte bekommen den mittleren Rang
        m = x == v
        r[m] = r[m].mean()
    return r


def number_score(widths: np.ndarray) -> float:
    """Rangkorrelation der Zahlenbreiten mit dem Muster ein-/zweistelliger Zahlen (robust gegen Ausreißer)."""
    ok = np.isfinite(widths)
    if ok.sum() < 6 or np.std(widths[ok]) < 1e-6 or np.std(DIGITS[ok]) < 1e-6:
        return float("nan")
    return float(np.corrcoef(_ranks(widths[ok]), DIGITS[ok])[0, 1])


# ---------------------------------------------------------------------------------- Verfeinerung
# Kanten der Farbringe: (Radius, +1 = innen farbig / -1 = außen farbig)
_EDGES = [(B.R_DOUBLE_OUT, 1), (B.R_DOUBLE_IN, -1), (B.R_TRIPLE_OUT, 1), (B.R_TRIPLE_IN, -1), (B.R_OUTER_BULL, 1)]


def _edge_samples(H: np.ndarray, rgf: np.ndarray):
    """Sucht entlang der Radien die Farbkanten der Ringe. Liefert Scheibenpunkte, Bildpunkte, Richtungen."""
    h, w = rgf.shape
    offs = np.array([-6.0, -3.0, 0.0, 3.0, 6.0])               # Grad innerhalb des Segments (weg von Drähten)
    th = np.radians((90.0 - 18.0 * np.arange(20))[:, None] + offs[None, :]).ravel()
    deltas = np.arange(-4.0, 4.001, 0.1)
    brd, img, dirs = [], [], []
    for r, sign in _EDGES:
        rr = r + deltas
        P = np.stack([np.outer(np.cos(th), rr), np.outer(np.sin(th), rr)], axis=-1)   # A × D × 2
        I = apply_h(H, P.reshape(-1, 2)).reshape(len(th), len(rr), 2).astype(np.float32)
        inside = ((I[..., 0] >= 0) & (I[..., 1] >= 0) & (I[..., 0] < w - 1) & (I[..., 1] < h - 1)).all(axis=1)
        vals = cv2.remap(rgf, I[..., 0], I[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        for a in np.nonzero(inside)[0]:
            v = vals[a] if sign > 0 else 1.0 - vals[a]           # jetzt: innen hoch, außen niedrig
            cross = np.nonzero((v[:-1] >= 0.5) & (v[1:] < 0.5))[0]
            if len(cross) == 0:
                continue
            j = cross[np.argmin(np.abs(deltas[cross]))]
            frac = (v[j] - 0.5) / max(1e-6, v[j] - v[j + 1])
            d_edge = deltas[j] + frac * (deltas[j + 1] - deltas[j])
            p_obs = apply_h(H, [((r + d_edge) * math.cos(th[a]), (r + d_edge) * math.sin(th[a]))])[0]
            u = I[a, -1] - I[a, 0]
            n = math.hypot(u[0], u[1])
            if n < 1e-6:
                continue
            brd.append((r * math.cos(th[a]), r * math.sin(th[a])))
            img.append(p_obs)
            dirs.append(u / n)
    return np.array(brd).reshape(-1, 2), np.array(img).reshape(-1, 2), np.array(dirs).reshape(-1, 2)


def refine_with_edges(H: np.ndarray, rgf: np.ndarray, src: np.ndarray, dst: np.ndarray,
                      rounds: int = 3) -> np.ndarray:
    """Verbessert die Homographie: Punktpaare (Feldgrenzen, Bull) und radiale Abstände zu den Ringkanten.

    Die Ringkanten legen nur die radiale Lage fest, deshalb zählt bei ihnen nur der Abstand in
    radialer Richtung. Gelöst mit Levenberg-Marquardt und Ausreißer-Dämpfung (Huber).
    """
    rgf = cv2.GaussianBlur(rgf, (3, 3), 0)
    h = (H / H[2, 2]).ravel()[:8].copy()

    def proj(hv, P):
        M = np.append(hv, 1.0).reshape(3, 3)
        return apply_h(M, P)

    for _ in range(rounds):
        e_brd, e_img, e_dir = _edge_samples(np.append(h, 1.0).reshape(3, 3), rgf)
        if len(e_brd) < 20:
            break

        def resid(hv):
            r1 = (proj(hv, src) - dst).ravel()
            r2 = ((proj(hv, e_brd) - e_img) * e_dir).sum(axis=1)
            return np.concatenate([r1, r2])

        lam = 1e-3
        for _ in range(8):
            r = resid(h)
            wts = np.where(np.abs(r) <= 1.5, 1.0, 1.5 / np.maximum(np.abs(r), 1e-9))   # Huber
            J = np.empty((len(r), 8))
            for k in range(8):
                eps = 1e-6 * max(1.0, abs(h[k]))
                hk = h.copy()
                hk[k] += eps
                J[:, k] = (resid(hk) - r) / eps
            Jw = J * wts[:, None]
            A = Jw.T @ J
            g = Jw.T @ r
            step = np.linalg.solve(A + lam * np.diag(np.diag(A) + 1e-12), -g)
            h_new = h + step
            if np.sum(wts * resid(h_new) ** 2) < np.sum(wts * r ** 2):
                h, lam = h_new, lam * 0.3
            else:
                lam *= 10
    return np.append(h, 1.0).reshape(3, 3)


# ---------------------------------------------------------------------------------- Hauptfunktion
def auto_calibrate(frame: np.ndarray, previous: Calibration | None = None) -> AutoCalResult:
    h, w = frame.shape[:2]
    red, green = color_masks(frame)
    double, treble = find_rings(red, green)
    if double is None:
        return AutoCalResult(False, "Keine Scheibe gefunden: rote und grüne Ringe nicht erkennbar. "
                                    "Licht prüfen und darauf achten, dass die Scheibe gut im Bild ist.")
    t_d = _transitions(double, red, green, 0.88)
    run = _consecutive_run(t_d)
    if run is None:
        return AutoCalResult(False, f"Doppelring gefunden, aber nur {len(t_d)} Feldgrenzen sicher erkannt "
                                    "(mind. 6 nebeneinander nötig).", transitions=len(t_d))
    pts_d = np.array([double.point(np.array([t]))[0] for t, _ in t_d])
    types_d = [typ for _, typ in t_d]
    idx, ks = run
    H0, _ = cv2.findHomography(_boundary_points(ks, B.R_DOUBLE_OUT), pts_d[idx], 0)
    if H0 is None:
        return AutoCalResult(False, "Homographie aus dem Doppelring nicht berechenbar.", transitions=len(t_d))
    # Alle Grenzen des Doppelrings über die Vorhersage zuordnen (zweimal, mit verbesserter Schätzung)
    for _ in range(2):
        assign = _assign_by_prediction(H0, pts_d, types_d, B.R_DOUBLE_OUT)
        if len(assign) < 6:
            break
        ii = list(assign)
        H1, _ = cv2.findHomography(_boundary_points([assign[i] for i in ii], B.R_DOUBLE_OUT), pts_d[ii], 0)
        if H1 is None:
            break
        H0 = H1
    img_pts = [pts_d[i] for i in assign]
    brd_pts = list(_boundary_points([assign[i] for i in assign], B.R_DOUBLE_OUT))

    # Triple-Ring dazunehmen
    n_trans = len(img_pts)
    if treble is not None:
        t_t = _transitions(treble, red, green, 0.85)
        if t_t:
            pts_t = np.array([treble.point(np.array([t]))[0] for t, _ in t_t])
            a_t = _assign_by_prediction(H0, pts_t, [typ for _, typ in t_t], B.R_TRIPLE_OUT)
            for i, k in a_t.items():
                img_pts.append(pts_t[i])
                brd_pts.append(_boundary_points([k], B.R_TRIPLE_OUT)[0])
            n_trans += len(a_t)

    # Bull-Mitte (roter Punkt) dazunehmen
    c0 = apply_h(H0, [(0.0, 0.0)])[0]
    rad = np.hypot(*(apply_h(H0, [(B.R_OUTER_BULL * 2, 0.0)])[0] - c0))
    x0, y0 = int(max(0, c0[0] - rad)), int(max(0, c0[1] - rad))
    x1, y1 = int(min(w, c0[0] + rad + 1)), int(min(h, c0[1] + rad + 1))
    if x1 > x0 and y1 > y0:
        sub = red[y0:y1, x0:x1]
        n, labels, stats, cents = cv2.connectedComponentsWithStats(sub, connectivity=8)
        if n > 1:
            j = 1 + int(np.argmin([np.hypot(*(cents[i] + (x0, y0) - c0)) for i in range(1, n)]))
            if stats[j, cv2.CC_STAT_AREA] >= 4 and np.hypot(*(cents[j] + (x0, y0) - c0)) < rad * 0.5:
                img_pts.append(cents[j] + (x0, y0))
                brd_pts.append((0.0, 0.0))

    src, dst = np.array(brd_pts, np.float64), np.array(img_pts, np.float64)
    H, inl = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
    if H is None:
        return AutoCalResult(False, "Homographie nicht berechenbar.", transitions=n_trans)
    inl = inl.ravel().astype(bool)
    H, _ = cv2.findHomography(src[inl], dst[inl], 0)
    H = refine_with_edges(H, (red | green).astype(np.float32), src[inl], dst[inl])
    rms = float(np.sqrt(np.mean(np.sum((apply_h(H, src[inl]) - dst[inl]) ** 2, axis=1))))

    # Lage der 20: 10 Kandidaten, jeweils um 36° gedreht
    cands = [H @ rot3(36.0 * c) for c in range(10)]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    scores = np.array([number_score(number_widths(gray, Hc)) for Hc in cands])
    source = "unsicher"
    if previous is not None:
        ref = previous.board_to_image(CAL_BOARD[:4])
        dist = [np.mean(np.hypot(*(apply_h(Hc, CAL_BOARD[:4]) - ref).T)) for Hc in cands]
        best = int(np.argmin(dist))
        source = "vorher"
    else:
        s = np.where(np.isfinite(scores), scores, -2)
        order = np.argsort(-s)
        best = int(order[0])
        # Nur bei deutlichem Ergebnis dem Zahlenring trauen; sonst fragt die Oberfläche nach einem Klick
        if s[order[0]] >= 0.6 and s[order[0]] - s[order[1]] >= 0.25:
            source = "zahlen"
    Hb = cands[best]
    cal = Calibration.from_points(apply_h(Hb, CAL_BOARD), w, h)
    sc = float(scores[best]) if np.isfinite(scores[best]) else 0.0
    where = {"vorher": "Lage der 20 von der vorigen Kalibrierung übernommen",
             "zahlen": "Lage der 20 am Zahlenring erkannt",
             "unsicher": "Bitte einmal ins Feld der 20 klicken"}[source]
    if rms > 4.0:
        return AutoCalResult(False, f"Scheibe gefunden, aber ungenau (±{rms:.1f} px). Kamera ruhig halten "
                                    "und Licht prüfen.", cal, source, rms, n_trans, sc)
    return AutoCalResult(True, f"Scheibe gefunden: {n_trans} Feldgrenzen, ±{rms:.1f} px. {where}.",
                         cal, source, rms, n_trans, sc)
