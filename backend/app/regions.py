"""Ingest-time candidate regions: where Pixel will look for objects, computed ONCE per image.

Three kinds of candidates, all stored as `Region(kind="window")` rows with an embedding:
- the whole image (always kept: similar-image search, and objects that fill the frame);
- segments: the segmenter's object masks at several granularities (a pile AND each item in it);
- unions: two nearby, look-alike pieces merged into one box. This is how an object broken in two by an
  occluder (a pipe behind a pole) can still be proposed as ONE object.

The candidates are class-agnostic and deliberately redundant. Choosing the right granularity per class
(one tomato, not the pile; the whole pipe, not its pieces) is learned from the teacher (see learning.py)
and resolved in engine.select_instances.
"""
from __future__ import annotations

import logging
import math

import numpy as np

from . import embedder, segmenter
from .config import BOX_PAD, MAX_UNIONS, PROPOSER
from .engine import containment, iou

log = logging.getLogger("kweeto.regions")

Cand = tuple[float, float, float, float, bool, float]  # x, y, w, h, is_full, crop padding


def base_candidates(key: str, pil) -> list[Cand]:
    """Whole image + segments (or the fixed grid with PROPOSER=windows / when segmentation finds nothing)."""
    if PROPOSER == "segments":
        try:
            boxes = segmenter.auto_boxes(key, pil)
        except Exception:  # pragma: no cover - segmenter not available
            log.exception("segments proposer failed, falling back to windows")
            boxes = []
        if boxes:
            return [(0.0, 0.0, 1.0, 1.0, True, 0.0)] + [(x, y, w, h, False, BOX_PAD) for x, y, w, h in boxes]
    return [(x, y, w, h, full, 0.0) for (x, y, w, h, full) in embedder.windows()]


def _gap(a, b) -> float:
    """Empty space between two boxes, relative to the smaller one's size (0 = touching/overlapping)."""
    dx = max(0.0, max(a[0], b[0]) - min(a[0] + a[2], b[0] + b[2]))
    dy = max(0.0, max(a[1], b[1]) - min(a[1] + a[3], b[1] + b[3]))
    scale = math.sqrt(min(a[2] * a[3], b[2] * b[3])) or 1e-6
    return math.hypot(dx, dy) / scale


def _union(a, b):
    x0, y0 = min(a[0], b[0]), min(a[1], b[1])
    x1, y1 = max(a[0] + a[2], b[0] + b[2]), max(a[1] + a[3], b[1] + b[3])
    return (x0, y0, x1 - x0, y1 - y0)


def union_candidates(boxes: list[tuple], vecs: np.ndarray, max_unions: int = MAX_UNIONS,
                     max_gap: float = 0.8) -> list[tuple]:
    """Pairs of separate, nearby pieces that look alike -> their union box (fragment hypothesis).

    Adjacent instances (two tomatoes side by side) also produce unions: those are "group" hypotheses and
    get rejected by what Pixel learns (a box containing two of your boxes is not an object).
    """
    if max_unions <= 0 or len(boxes) < 2:
        return []
    pairs = []
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            a, b = boxes[i], boxes[j]
            if iou(a, b) > 0.2 or containment(a, b) > 0.5:
                continue  # same object at another granularity, or one inside the other
            if _gap(a, b) > max_gap:
                continue
            pairs.append((float(vecs[i] @ vecs[j]), i, j))
    out: list[tuple] = []
    for _, i, j in sorted(pairs, reverse=True):
        u = _union(boxes[i], boxes[j])
        if u[2] * u[3] > 0.9:
            continue
        if any(iou(u, b) > 0.85 for b in boxes) or any(iou(u, o) > 0.85 for o in out):
            continue  # the segmenter already has this region
        out.append(u)
        if len(out) >= max_unions:
            break
    return out


def compute(key: str, pil) -> list[tuple[tuple, bool, np.ndarray]]:
    """All candidate regions of one image with their embeddings: [((x, y, w, h), is_full, vector)]."""
    base = base_candidates(key, pil)
    crops = [embedder.crop_norm(pil, x, y, w, h, pad=pad) for (x, y, w, h, _f, pad) in base]
    vecs = embedder.embed_images(crops)
    out = [((x, y, w, h), full, v) for (x, y, w, h, full, _p), v in zip(base, vecs)]
    if PROPOSER == "segments":
        idx = [k for k, c in enumerate(base) if not c[4]]
        unions = union_candidates([base[k][:4] for k in idx], vecs[idx]) if idx else []
        if unions:
            uvecs = embedder.embed_images([embedder.crop_norm(pil, *u, pad=BOX_PAD) for u in unions])
            out += [(u, False, v) for u, v in zip(unions, uvecs)]
    return out
