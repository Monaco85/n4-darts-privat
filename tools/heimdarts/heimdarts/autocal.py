"""Automatische Kalibrierung: findet die Scheibe im Kamerabild – ohne Klicken.

Ablauf:
  1. Rote und grüne Pixel suchen (großzügig: unter LED-Licht wirkt Rot oft rosa, Grün blass).
  2. Das Bull finden: kleiner roter Fleck, ringsum grün.
  3. Vom Bull aus 720 Strahlen nach außen abtasten. Auf jedem Strahl das Paar „Triple-Ring, dann
     Doppelring“ suchen – erkennbar am Größenverhältnis 107:170. Logos, Aufkleber und Lücken
     stören so nur einzelne Strahlen. Linien durch die Bull-Mitte sind auch auf der Scheibe Linien
     durch die Mitte; die Segmentgrenzen liegen also genau auf solchen Strahlen.
  4. Wo die Farbe des Rings von Strahl zu Strahl wechselt, liegt eine Segmentgrenze (bis zu 40
     Punkte mit bekannter Lage) – daraus und aus der Bull-Mitte die Homographie, dann Feinabgleich
     an allen Ringkanten.
  5. Die Farben wiederholen sich alle zwei Segmente, die Lage der 20 ist also noch offen (10
     Möglichkeiten). Entschieden wird über die vorige Kalibrierung, sonst über den Zahlenring
     (nur wenn eindeutig), sonst per Klick ins Feld der 20.
"""
from __future__ import annotations

import math
import warnings
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
def color_masks(frame: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Rote und grüne Flächen. Bewusst großzügig; falsche Treffer (Logos, Aufkleber) filtert
    später die Ringstruktur heraus."""
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    sat = (s >= 42) & (v >= 55)
    red = sat & ((h <= 8) | (h >= 168))
    green = sat & (h >= 45) & (h <= 92)
    return red.astype(np.uint8), green.astype(np.uint8)


# ---------------------------------------------------------------------------------- Bull
def find_bull(red: np.ndarray, green: np.ndarray) -> tuple[float, float] | None:
    """Mitte des Bulls: kleiner, kompakter roter Fleck mit grünem Ring drumherum."""
    n, _, stats, cents = cv2.connectedComponentsWithStats(red, connectivity=8)
    h, w = red.shape
    angs = np.linspace(0, 2 * np.pi, 48, endpoint=False)
    best, best_score = None, 0.0
    for j in range(1, n):
        area = stats[j, cv2.CC_STAT_AREA]
        bw, bh = stats[j, cv2.CC_STAT_WIDTH], stats[j, cv2.CC_STAT_HEIGHT]
        if area < 2 or area > 0.004 * red.size or max(bw, bh) > 4 * max(1, min(bw, bh)):
            continue
        cx, cy = cents[j]
        rx, ry = max(1.0, bw / 2.0), max(1.0, bh / 2.0)
        hits = tot = 0
        for f in (1.5, 1.9, 2.3):      # Single Bull ist 2,5-mal so groß wie das Bullseye
            xs = np.round(cx + f * rx * np.cos(angs)).astype(int)
            ys = np.round(cy + f * ry * np.sin(angs)).astype(int)
            ok = (xs >= 0) & (ys >= 0) & (xs < w) & (ys < h)
            hits += int(green[ys[ok], xs[ok]].sum())
            tot += int(ok.sum())
        score = hits / max(1, tot)
        if score > best_score:
            best, best_score = (float(cx), float(cy)), score
    return best if best_score >= 0.45 else None


# ---------------------------------------------------------------------------------- Strahlen
@dataclass
class _Rays:
    center: tuple[float, float]
    phi: np.ndarray        # Winkel im Bild (im Uhrzeigersinn, da y nach unten)
    t_in: np.ndarray       # Triple-Ring innen/außen (px vom Bull), NaN wenn nicht gefunden
    t_out: np.ndarray
    d_in: np.ndarray       # Doppelring innen/außen
    d_out: np.ndarray
    t_col: np.ndarray      # Farbe: 0 rot, 1 grün, -1 unbekannt
    d_col: np.ndarray


def _runs(mask: np.ndarray, gap: int) -> list[tuple[int, int]]:
    idx = np.nonzero(mask)[0]
    if len(idx) == 0:
        return []
    runs, start, prev = [], idx[0], idx[0]
    for i in idx[1:]:
        if i - prev > gap + 1:
            runs.append((start, prev + 1))
            start = i
        prev = i
    runs.append((start, prev + 1))
    return runs


def cast_rays(red: np.ndarray, green: np.ndarray, center, n_rays: int = 720, step: float = 0.5) -> _Rays:
    h, w = red.shape
    rg = red | green
    cx, cy = center
    phi = np.arange(n_rays) * (2 * np.pi / n_rays)
    out = {k: np.full(n_rays, np.nan) for k in ("t_in", "t_out", "d_in", "d_out")}
    t_col = np.full(n_rays, -1)
    d_col = np.full(n_rays, -1)
    for k, a in enumerate(phi):
        dx, dy = math.cos(a), math.sin(a)
        lim = []
        if dx > 1e-9:
            lim.append((w - 1 - cx) / dx)
        elif dx < -1e-9:
            lim.append(-cx / dx)
        if dy > 1e-9:
            lim.append((h - 1 - cy) / dy)
        elif dy < -1e-9:
            lim.append(-cy / dy)
        rmax = min(lim) if lim else 0
        if rmax < 10:
            continue
        rs = np.arange(0, rmax, step)
        xs = np.round(cx + rs * dx).astype(int)
        ys = np.round(cy + rs * dy).astype(int)
        col = rg[ys, xs]
        runs = [(rs[i0], rs[i1 - 1] + step, i0, i1) for i0, i1 in _runs(col, gap=3)]
        found = None
        for i, (s0, e0, a0, b0) in enumerate(runs):
            if s0 < 0.6 * e0 or e0 < 6:          # Bull (beginnt in der Mitte) oder zu nah
                continue
            for s1, e1, a1, b1 in runs[i + 1:]:
                q = e1 / e0
                if q > 1.95:
                    break
                if q >= 1.35 and s1 >= 0.78 * e1 and (e1 - s1) <= 0.25 * e1:
                    found = (s0, e0, a0, b0, s1, e1, a1, b1)
                    break
            if found:
                break
        if not found:
            continue
        s0, e0, a0, b0, s1, e1, a1, b1 = found
        out["t_in"][k], out["t_out"][k], out["d_in"][k], out["d_out"][k] = s0, e0, s1, e1
        for (i0, i1, arr) in ((a0, b0, t_col), (a1, b1, d_col)):
            r_cnt = int(red[ys[i0:i1], xs[i0:i1]].sum())
            g_cnt = int(green[ys[i0:i1], xs[i0:i1]].sum())
            if max(r_cnt, g_cnt) >= 1 and max(r_cnt, g_cnt) >= 2 * min(r_cnt, g_cnt):
                arr[k] = 0 if r_cnt > g_cnt else 1
    # Ausreißer: Ringradien ändern sich von Strahl zu Strahl nur wenig
    for key in ("d_out", "t_out"):
        v = out[key]
        ok = np.isfinite(v)
        if ok.sum() < 10:
            continue
        with warnings.catch_warnings():          # Abschnitte ganz ohne Treffer sind normal
            warnings.simplefilter("ignore", RuntimeWarning)
            med = np.array([np.nanmedian(np.take(v, range(i - 6, i + 7), mode="wrap")) for i in range(n_rays)])
        bad = ok & (np.abs(v - med) > 0.06 * med)
        v[bad] = np.nan
        if key == "d_out":
            out["d_in"][bad] = np.nan
            d_col[bad] = -1
        else:
            out["t_in"][bad] = np.nan
            t_col[bad] = -1
    return _Rays((float(cx), float(cy)), phi, out["t_in"], out["t_out"], out["d_in"], out["d_out"], t_col, d_col)


def ray_transitions(rays: _Rays, red: np.ndarray, green: np.ndarray, ring: str):
    """Segmentgrenzen auf einem Ring: Liste (Winkel, Typ) und Bildpunkte an der Außenkante.
    Typ 0 = Rot→Grün, 1 = Grün→Rot (im Uhrzeigersinn)."""
    h, w = red.shape
    col = rays.d_col if ring == "double" else rays.t_col
    r_in = rays.d_in if ring == "double" else rays.t_in
    r_out = rays.d_out if ring == "double" else rays.t_out
    n = len(rays.phi)
    valid = np.nonzero(col >= 0)[0]
    trans, pts = [], []
    if len(valid) < 2:
        return trans, np.zeros((0, 2))
    cx, cy = rays.center
    for j in range(len(valid)):
        a, b = valid[j], valid[(j + 1) % len(valid)]
        gap = (b - a) % n
        if col[a] == col[b] or gap == 0 or gap > 6:
            continue
        pa, pb = rays.phi[a], rays.phi[a] + gap * (2 * np.pi / n)
        mid = 0.5 * ((r_in[a] + r_out[a]) / 2 + (r_in[b] + r_out[b]) / 2)
        half = 0.25 * 0.5 * ((r_out[a] - r_in[a]) + (r_out[b] - r_in[b]))
        sub = np.linspace(pa, pb, 4 * gap + 1)
        labels = []
        for ang in sub:                     # feiner abtasten, wo genau die Farbe wechselt
            rr = mid + np.array([-half, 0.0, half])
            xs = np.clip(np.round(cx + rr * math.cos(ang)).astype(int), 0, w - 1)
            ys = np.clip(np.round(cy + rr * math.sin(ang)).astype(int), 0, h - 1)
            rc, gc = int(red[ys, xs].sum()), int(green[ys, xs].sum())
            labels.append(0 if rc > gc else 1 if gc > rc else -1)
        labels = np.array(labels)
        ia = np.nonzero(labels == col[a])[0]
        ib = np.nonzero(labels == col[b])[0]
        if len(ia) and len(ib) and ia.max() < ib.min():
            ang = 0.5 * (sub[ia.max()] + sub[ib.min()])
        else:
            ang = 0.5 * (pa + pb)
        f = (ang - pa) / max(1e-9, pb - pa)
        r_edge = (1 - f) * r_out[a] + f * r_out[b]
        trans.append((float(ang % (2 * np.pi)), 0 if col[a] == 0 else 1))
        pts.append((cx + r_edge * math.cos(ang), cy + r_edge * math.sin(ang)))
    order = np.argsort([t for t, _ in trans])
    return [trans[i] for i in order], np.array(pts).reshape(-1, 2)[order]


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
    bull = find_bull(red, green)
    if bull is None:
        return AutoCalResult(False, "Bull nicht gefunden: Ist die Scheibe ganz im Bild und gut beleuchtet? "
                                    "Rot und Grün müssen im Kamerabild erkennbar sein.")
    rays = cast_rays(red, green, bull)
    n_ok = int(np.isfinite(rays.d_out).sum())
    if n_ok < 60:
        return AutoCalResult(False, f"Triple- und Doppelring nur auf {n_ok} von {len(rays.phi)} Strahlen gefunden. "
                                    "Licht prüfen und darauf achten, dass die Scheibe gut im Bild ist.")
    t_d, pts_d = ray_transitions(rays, red, green, "double")
    run = _consecutive_run(t_d)
    if run is None:
        return AutoCalResult(False, f"Doppelring gefunden, aber nur {len(t_d)} Feldgrenzen sicher erkannt "
                                    "(mind. 6 nebeneinander nötig).", transitions=len(t_d))
    types_d = [typ for _, typ in t_d]
    idx, ks = run
    H0, _ = cv2.findHomography(np.vstack([_boundary_points(ks, B.R_DOUBLE_OUT), [(0.0, 0.0)]]),
                               np.vstack([pts_d[idx], [bull]]), 0)
    if H0 is None:
        return AutoCalResult(False, "Homographie aus dem Doppelring nicht berechenbar.", transitions=len(t_d))
    # Alle Grenzen des Doppelrings über die Vorhersage zuordnen (zweimal, mit verbesserter Schätzung)
    assign = {}
    for _ in range(2):
        a_new = _assign_by_prediction(H0, pts_d, types_d, B.R_DOUBLE_OUT)
        if len(a_new) < 6:
            break
        assign = a_new
        ii = list(assign)
        H1, _ = cv2.findHomography(np.vstack([_boundary_points([assign[i] for i in ii], B.R_DOUBLE_OUT), [(0.0, 0.0)]]),
                                   np.vstack([pts_d[ii], [bull]]), 0)
        if H1 is None:
            break
        H0 = H1
    if not assign:
        assign = {i: k for i, k in zip(idx, ks)}
    img_pts = [pts_d[i] for i in assign]
    brd_pts = list(_boundary_points([assign[i] for i in assign], B.R_DOUBLE_OUT))

    # Triple-Ring dazunehmen
    t_t, pts_t = ray_transitions(rays, red, green, "treble")
    if t_t:
        a_t = _assign_by_prediction(H0, pts_t, [typ for _, typ in t_t], B.R_TRIPLE_OUT)
        for i, k in a_t.items():
            img_pts.append(pts_t[i])
            brd_pts.append(_boundary_points([k], B.R_TRIPLE_OUT)[0])
    n_trans = len(img_pts)
    img_pts.append(np.array(bull))
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
    if rms > 6.0:
        return AutoCalResult(False, f"Scheibe gefunden, aber ungenau (±{rms:.1f} px). Kamera ruhig halten "
                                    "und Licht prüfen.", cal, source, rms, n_trans, sc)
    return AutoCalResult(True, f"Scheibe gefunden: {n_trans} Feldgrenzen, ±{rms:.1f} px. {where}.",
                         cal, source, rms, n_trans, sc)
