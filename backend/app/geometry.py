"""Mask -> polygons (for COCO / YOLO-seg exports), without OpenCV.

Outer contours are traced with Moore-neighbour tracing, then simplified with Ramer-Douglas-Peucker.
Coordinates are normalised 0..1 (x, y) over the whole image, like every geometry in Kweeto.
Holes are not represented (COCO polygons and YOLO-seg cannot express them anyway).
"""
from __future__ import annotations

import numpy as np

# clockwise neighbours, starting west: (dy, dx)
_DIRS = [(0, -1), (-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1)]


def _trace(comp: np.ndarray) -> list[tuple[int, int]]:
    """Outer boundary pixels (row, col) of one 8-connected component, in order."""
    pad = np.pad(comp, 1)
    ys, xs = np.nonzero(pad)
    start = (int(ys[0]), int(xs[0]))  # first pixel in raster order: its west neighbour is background
    contour = [start]
    cur, back = start, 0              # we "came" from the west
    for _ in range(4 * pad.size):
        for k in range(8):
            d = (back + 1 + k) % 8
            ny, nx = cur[0] + _DIRS[d][0], cur[1] + _DIRS[d][1]
            if pad[ny, nx]:
                prev = (cur[0] + _DIRS[(d - 1) % 8][0], cur[1] + _DIRS[(d - 1) % 8][1])
                cur = (ny, nx)
                back = _DIRS.index((prev[0] - ny, prev[1] - nx)) if (prev[0] - ny, prev[1] - nx) in _DIRS else (d + 4) % 8
                break
        else:
            break  # isolated pixel
        if cur == start:
            break
        contour.append(cur)
    return [(y - 1, x - 1) for y, x in contour]


def _rdp(pts: np.ndarray, eps: float) -> np.ndarray:
    """Ramer-Douglas-Peucker on an open polyline (iterative)."""
    if len(pts) < 3:
        return pts
    keep = np.zeros(len(pts), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        seg = pts[b] - pts[a]
        n = np.hypot(*seg) or 1e-9
        d = np.abs(seg[0] * (pts[a + 1:b, 1] - pts[a, 1]) - seg[1] * (pts[a + 1:b, 0] - pts[a, 0])) / n
        i = int(np.argmax(d))
        if d[i] > eps:
            m = a + 1 + i
            keep[m] = True
            stack += [(a, m), (m, b)]
    return pts[keep]


def mask_polygons(mask: np.ndarray, min_frac: float = 0.002, max_polys: int = 5,
                  tolerance: float = 0.004) -> list[list[tuple[float, float]]]:
    """Polygons (largest first) of the parts of `mask`, normalised. Tiny specks are dropped."""
    from .segmenter import _components  # vectorised 4-connected labelling

    mask = np.asarray(mask, bool)
    h, w = mask.shape
    lab, n = _components(mask)
    if n == 0:
        return []
    sizes = np.bincount(lab.ravel())[1:]
    out = []
    for k in np.argsort(-sizes)[:max_polys]:
        if sizes[k] < max(4, min_frac * mask.size):
            break
        ring = np.array(_trace(lab == k + 1), np.float64)
        if len(ring) < 3:
            continue
        # split the closed ring at its farthest point so RDP keeps both halves
        far = int(np.argmax(np.hypot(ring[:, 0] - ring[0, 0], ring[:, 1] - ring[0, 1])))
        eps = tolerance * max(h, w)
        a = _rdp(ring[:far + 1], eps)
        b = _rdp(np.vstack([ring[far:], ring[:1]]), eps)
        poly = np.vstack([a, b[1:-1]])
        if len(poly) < 3:
            continue
        out.append([(float((x + 0.5) / w), float((y + 0.5) / h)) for y, x in poly])
    return out


def polygon_area(poly: list[tuple[float, float]], width: float = 1.0, height: float = 1.0) -> float:
    """Shoelace area (in pixels if width/height are given)."""
    if len(poly) < 3:
        return 0.0
    x = np.array([p[0] * width for p in poly])
    y = np.array([p[1] * height for p in poly])
    return float(0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1))))


def box_polygon(box: tuple[float, float, float, float]) -> list[tuple[float, float]]:
    x, y, w, h = box
    return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
