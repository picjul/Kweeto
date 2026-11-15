"""Segmenter: turns a click or a rough box into a tight box, and finds object regions automatically.

Segmenters are registered components (plugins.SEGMENTERS); the engine profile picks one and its checkpoint.
Built-in (all models Apache-2.0):
- "sam":    Segment Anything v1 family (SAM, SlimSAM) via transformers SamModel; ONNX graphs when the runtime is
            ONNX (one image encoder and one mask decoder per prompt kind, exported on first use).
- "sam2":   SAM 2.1 via transformers Sam2Model (needs torchvision), PyTorch.
  Both are `PromptableSegmenter`s: the image encoder runs once per image and is cached; prompts only run the mask
  decoder, which costs ~50 ms per prompt on a CPU whatever the model, so the automatic scan uses a sparse grid
  plus a second pass only where no mask covered the image yet. A new SAM-like model only implements `load`,
  `encode` and `decode_raw` (and `resize` if its encoder does not pad to 1024).
- "simple": colour/background separation with connected components. No torch; good for plain backgrounds,
            tests and the demo dataset.
All coordinates are normalised 0..1 (x, y, w, h).
"""
from __future__ import annotations

import math
import threading
from collections import OrderedDict

import numpy as np
from PIL import Image, ImageFilter

from . import profiles, runtime
from .config import MAX_SEGMENTS
from .plugins import SEGMENTERS, option

Box = tuple[float, float, float, float]


# ---------- helpers ----------

def mask_to_box(mask: np.ndarray) -> Box | None:
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    H, W = mask.shape
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    return (x0 / W, y0 / H, (x1 - x0) / W, (y1 - y0) / H)


def _otsu(values: np.ndarray) -> float:
    hist, edges = np.histogram(values, bins=64)
    centers = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(hist)
    w1 = w0[-1] - w0
    m0 = np.cumsum(hist * centers) / np.maximum(w0, 1)
    m1 = (np.sum(hist * centers) - np.cumsum(hist * centers)) / np.maximum(w1, 1)
    between = w0 * w1 * (m0 - m1) ** 2
    return float(centers[int(np.argmax(between))])


def _components(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """4-connected component labelling (vectorised min-label propagation); labels 1..n in raster order."""
    H, W = mask.shape
    if not mask.any():
        return np.zeros((H, W), np.int32), 0
    big = np.iinfo(np.int64).max
    lab = np.where(mask, np.arange(H * W, dtype=np.int64).reshape(H, W), big)
    while True:
        cur = lab.copy()
        cur[1:] = np.minimum(cur[1:], lab[:-1])
        cur[:-1] = np.minimum(cur[:-1], lab[1:])
        cur[:, 1:] = np.minimum(cur[:, 1:], lab[:, :-1])
        cur[:, :-1] = np.minimum(cur[:, :-1], lab[:, 1:])
        cur = np.where(mask, cur, big)
        flat = cur.ravel()  # pointer jumping: follow each label to its own label (much faster convergence)
        inside = flat != big
        flat[inside] = np.minimum(flat[inside], flat[flat[inside]])
        if np.array_equal(cur, lab):
            break
        lab = cur
    uniq, inv = np.unique(lab[mask], return_inverse=True)
    out = np.zeros((H, W), np.int32)
    out[mask] = inv.astype(np.int32) + 1
    return out, len(uniq)


def _distance(mask: np.ndarray) -> np.ndarray:
    """Euclidean distance of every mask pixel to the nearest pixel outside it (brute force on the border)."""
    pad = np.pad(mask, 1)
    inner = pad[1:-1, 1:-1] & pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:]
    border = np.argwhere(mask & ~inner).astype(np.float32)
    pts = np.argwhere(mask).astype(np.float32)
    dist = np.zeros(mask.shape, np.float32)
    if len(border) == 0:
        return dist
    best = np.empty(len(pts), np.float32)
    for s in range(0, len(pts), 4096):
        p = pts[s:s + 4096]
        d2 = ((p[:, None, :] - border[None, :, :]) ** 2).sum(axis=2)
        best[s:s + 4096] = np.sqrt(d2.min(axis=1))
    dist[mask] = best + 0.5
    return dist


def _peaks(dist: np.ndarray, min_r: float) -> list[tuple[int, int, float]]:
    """Object centres: local maxima of the distance (a neck between two objects is a saddle, not a maximum;
    the ridge of an elongated object is a chain of equal maxima), deepest first, each suppressing its disc."""
    ys, xs = np.nonzero(dist >= min_r)
    if len(ys) == 0:
        return []
    vals = dist[ys, xs]
    order = np.argsort(-vals)
    ys, xs, vals = ys[order], xs[order], vals[order]
    H, W = dist.shape
    alive = np.ones(len(ys), bool)
    out = []
    for i in range(len(ys)):
        if not alive[i]:
            continue
        y, x, v = int(ys[i]), int(xs[i]), float(vals[i])
        k = max(2, int(0.5 * v))
        if dist[max(0, y - k):min(H, y + k + 1), max(0, x - k):min(W, x + k + 1)].max() > v + 1e-3:
            continue
        out.append((y, x, v))
        alive &= (ys - ys[i]) ** 2 + (xs - xs[i]) ** 2 > (0.7 * vals[i]) ** 2
        if len(out) >= 40:
            break
    return out


def crevices(pil: Image.Image, size: tuple[int, int], thr: float = 14.0) -> np.ndarray:
    """Thin lines darker than both their sides (morphological black-hat): the seams between touching objects."""
    g = pil.convert("L").resize(size[::-1], Image.BILINEAR)
    closed = g.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))
    return (np.asarray(closed, np.float32) - np.asarray(g, np.float32)) > thr


def split_touching(mask: np.ndarray, barrier: np.ndarray | None = None, min_r: float = 3.0,
                   neck: float = 0.75) -> list[np.ndarray]:
    """Splits a blob made of touching objects (a pile of tomatoes) into one mask per object.

    Each roundish object has a "deep" centre (far from the blob's border and from the dark seams inside
    it); two objects that touch are joined by a neck that is much shallower than both centres. Centres
    connected without a neck belong to the same object (an elongated pipe is a chain of equal discs),
    the others are split. Returns [] when the blob is a single object.
    """
    dist = _distance(mask & ~barrier if barrier is not None else mask)
    peaks = _peaks(dist, min_r)
    if len(peaks) < 2:
        return []
    H, W = mask.shape
    parent = list(range(len(peaks)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(peaks)):
        yi, xi, di = peaks[i]
        for j in range(i + 1, len(peaks)):
            yj, xj, dj = peaks[j]
            gap = math.hypot(yi - yj, xi - xj)
            if gap > di + dj + 2:
                continue  # not neighbours: connected (or not) through other discs
            t = np.linspace(0.0, 1.0, max(3, int(gap) + 1))
            sy = np.clip(np.round(yi + (yj - yi) * t).astype(int), 0, H - 1)
            sx = np.clip(np.round(xi + (xj - xi) * t).astype(int), 0, W - 1)
            if dist[sy, sx].min() >= neck * min(di, dj):
                parent[find(i)] = find(j)
    groups: dict[int, list[int]] = {}
    for i in range(len(peaks)):
        groups.setdefault(find(i), []).append(i)
    if len(groups) < 2:
        return []
    # every pixel goes to the object whose disc it is closest to entering (power-diagram style)
    py, px = np.nonzero(mask)
    score = np.full((len(groups), len(py)), np.inf, np.float32)
    for g, members in enumerate(groups.values()):
        for i in members:
            y, x, d = peaks[i]
            score[g] = np.minimum(score[g], np.sqrt((py - y) ** 2 + (px - x) ** 2) - d)
    owner = score.argmin(axis=0)
    area = len(py)
    parts = []
    for g in range(len(groups)):
        m = np.zeros_like(mask)
        m[py[owner == g], px[owner == g]] = True
        if m.sum() >= 0.04 * area:
            parts.append(m)
    return parts if len(parts) >= 2 else []


# ---------- "simple" backend ----------

def _foreground(pil: Image.Image) -> np.ndarray:
    small = pil.copy()
    small.thumbnail((256, 256))
    a = np.asarray(small, np.float32)
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
    bg = np.median(border, axis=0)
    dist = np.linalg.norm(a - bg, axis=2)
    spread = float(np.percentile(np.linalg.norm(border - bg, axis=1), 95))
    thr = max(_otsu(dist), spread * 1.2, 12.0)
    fg = Image.fromarray(((dist > thr) * 255).astype(np.uint8))
    fg = fg.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(3))  # close small gaps
    return np.asarray(fg) > 0


def _simple(pil: Image.Image, points: list[tuple[float, float]], box: Box | None) -> tuple[Box | None, float]:
    mask, score = _simple_mask(pil, points, box)
    return (mask_to_box(mask), score) if mask is not None else (None, 0.0)


def _simple_mask(pil: Image.Image, points: list[tuple[float, float]], box: Box | None) -> tuple[np.ndarray | None, float]:
    """Mask of the object indicated by points and/or a box (whole-image frame, ~256 px)."""
    fg = _foreground(pil)
    H, W = fg.shape
    if box is not None:
        bx, by, bw, bh = box
        pad = 0.1
        x0, y0 = int(max(0, bx - bw * pad) * W), int(max(0, by - bh * pad) * H)
        x1, y1 = int(min(1, bx + bw * (1 + pad)) * W) + 1, int(min(1, by + bh * (1 + pad)) * H) + 1
        roi = np.zeros_like(fg)
        roi[y0:y1, x0:x1] = fg[y0:y1, x0:x1]
        fg = roi
    lab, n = _components(fg)
    if n == 0:
        return None, 0.0
    if points:
        keep: set[int] = set()
        for px, py in points:
            x, y = min(W - 1, int(px * W)), min(H - 1, int(py * H))
            if lab[y, x]:
                keep.add(int(lab[y, x]))
                continue
            ys, xs = np.nonzero(lab)  # nearest foreground pixel within ~6% of the image
            d = (xs - x) ** 2 + (ys - y) ** 2
            j = int(np.argmin(d))
            if d[j] <= (0.06 * max(W, H)) ** 2:
                keep.add(int(lab[ys[j], xs[j]]))
        if not keep:
            return None, 0.0
        mask = np.isin(lab, list(keep))
    else:
        sizes = np.bincount(lab.ravel())[1:]
        mask = lab == (int(np.argmax(sizes)) + 1)
    return mask, 0.7


def _simple_auto(pil: Image.Image) -> list[Box]:
    """Multi-granularity regions: every foreground blob AND the objects it is made of when they touch.

    Keeping both levels is deliberate: whether a blob is one object or a group is decided later by
    what Pixel has learned (and by the per-class size prior), not by the segmenter.
    """
    fg = _foreground(pil)
    lab, n = _components(fg)
    if n == 0:
        return []
    seams = crevices(pil, fg.shape)
    sizes = np.bincount(lab.ravel())[1:]
    order = np.argsort(-sizes)
    out: list[Box] = []
    for k in order:
        if sizes[k] < 0.004 * fg.size or len(out) >= MAX_SEGMENTS:
            break
        blob = lab == k + 1
        b = mask_to_box(blob)
        if b and b[2] * b[3] < 0.95:
            out.append(b)
        for part in split_touching(blob, seams):
            pb = mask_to_box(part)
            if pb and len(out) < MAX_SEGMENTS:
                out.append(pb)
    return _nms(out, 0.85)


# ---------- components (registered in plugins.SEGMENTERS) ----------

class Segmenter:
    """Base class of a segmenter. One instance per (model, scan settings); the facade below keeps the active one.

    Subclasses implement `segment` (click / rough box -> tight box), `mask_in_box` (exports) and `auto_boxes`
    (class-agnostic candidate regions of the automatic scan). `points` / `refine` are the scan's prompt budget
    (profile fields sam_points / sam_refine), ignored by segmenters without prompts.
    """
    id = ""
    title = ""
    summary = ""
    license = ""
    models: tuple[dict, ...] = ()
    default_model = ""
    needs_torch = True
    custom_model = True
    promptable = True   # has a scan prompt budget (points / refine)

    def __init__(self, model: str, points: int = 8, refine: int = 16) -> None:
        self.model = model or self.default_model
        self.points, self.refine = points, refine
        self.device = "cpu"

    @classmethod
    def available(cls) -> bool:
        if not cls.needs_torch:
            return True
        import importlib.util

        return importlib.util.find_spec("torch") is not None and importlib.util.find_spec("transformers") is not None

    @classmethod
    def scan_signature_of(cls, model: str, points: int, refine: int) -> str:
        """Identity of the candidate regions it produces: when it changes, the images are scanned again."""
        return f"{cls.id}:{model}:{points}:{refine}"

    @classmethod
    def mask_signature_of(cls, model: str) -> str:
        """Identity of its masks (export cache)."""
        return f"{cls.id}:{model}"

    def name(self) -> str:
        return f"{self.id} ({self.model})"

    def load(self) -> None:
        """Loads the weights (called once, under the segmenter lock)."""

    def prepare(self, key: str, pil: Image.Image) -> None:
        """Optional: pre-compute what makes the first click on this image fast."""

    def segment(self, key: str, pil: Image.Image, points: list[tuple[float, float]], box: Box | None) -> tuple[Box | None, float]:
        raise NotImplementedError

    def mask_in_box(self, key: str, pil: Image.Image, box: Box) -> tuple[np.ndarray | None, float]:
        raise NotImplementedError

    def auto_boxes(self, key: str, pil: Image.Image) -> list[Box]:
        raise NotImplementedError


@SEGMENTERS.register
class SimpleSegmenter(Segmenter):
    id = "simple"
    title = "Simple (colour)"
    summary = "Colour/background separation that also splits touching objects. No model, no torch: plain backgrounds, tests."
    license = "n/a"
    needs_torch = False
    custom_model = False
    promptable = False

    @classmethod
    def scan_signature_of(cls, model: str, points: int, refine: int) -> str:
        return "simple"

    @classmethod
    def mask_signature_of(cls, model: str) -> str:
        return "simple"

    def name(self) -> str:
        return "simple"

    def segment(self, key, pil, points, box):
        return _simple(pil, points, box)

    def mask_in_box(self, key, pil, box):
        return _simple_mask(pil, [], box)

    def auto_boxes(self, key, pil):
        return _simple_auto(pil)


class PromptableSegmenter(Segmenter):
    """A SAM-like model: the image is encoded once (cached), then point/box prompts only run the mask decoder.

    Subclasses implement `load`, `encode(pil) -> image embedding` and `decode_raw(enc, kw, multimask)`, and say
    how the image is resized for the encoder (`resize`). Clicks, boxes, export masks and the automatic scan (a
    sparse grid + extra prompts where nothing was covered yet) are shared.
    """
    cache_size = 8
    decode_batch = 64

    def __init__(self, model: str, points: int = 8, refine: int = 16) -> None:
        super().__init__(model, points, refine)
        self._cache: OrderedDict[str, dict] = OrderedDict()

    # ---- hooks
    def encode(self, pil: Image.Image):
        raise NotImplementedError

    def decode_raw(self, enc: dict, kw: dict, multimask: bool):
        """kw: input_points (1,B,P,2) / input_labels (1,B,P) / input_boxes (1,B,4) torch tensors in encoder pixels.
        Returns (pred_masks (1,B,M,h,w) logits, iou_scores (1,B,M)) as torch tensors."""
        raise NotImplementedError

    def resize(self, W: int, H: int) -> tuple[float, float, tuple[float, float]]:
        """Encoder geometry: (sx, sy, valid) = scale to encoder pixels and the part of the mask that is the image.
        Default (SAM v1): longest side to 1024, then padded, so masks cover a top-left part."""
        sx = sy = 1024 / max(W, H)
        return sx, sy, (W * sx / 1024, H * sy / 1024)

    # ---- shared machinery
    def _encode(self, key: str, pil: Image.Image) -> dict:
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        W, H = pil.size
        sx, sy, valid = self.resize(W, H)
        enc = {"emb": self.encode(pil), "W": W, "H": H, "sx": sx, "sy": sy, "valid": valid}
        self._cache[key] = enc
        while len(self._cache) > self.cache_size:
            self._cache.popitem(last=False)
        return enc

    def _decode(self, enc: dict, points=None, labels=None, boxes=None, upscale: int = 1,
                multimask: bool = True) -> tuple[np.ndarray, np.ndarray]:
        """points: (B, P, 2) normalised; boxes: (B, 4) normalised x0 y0 x1 y1.

        Returns (masks [B, M, h, w] bool, cropped to the image so that pixel / size = normalised coordinate;
        scores [B, M]). Low resolution (256 px) unless `upscale` > 1 (used for single clicks).
        """
        import torch

        kw: dict = {}
        scale = torch.tensor([enc["W"] * enc["sx"], enc["H"] * enc["sy"]], dtype=torch.float32)
        if points is not None:
            pts = torch.as_tensor(np.asarray(points, np.float32)) * scale
            kw["input_points"] = pts[None]
            lab = np.ones(pts.shape[:2], np.int64) if labels is None else np.asarray(labels, np.int64)
            kw["input_labels"] = torch.as_tensor(lab)[None]
        if boxes is not None:
            bx = torch.as_tensor(np.asarray(boxes, np.float32)) * scale.repeat(2)
            kw["input_boxes"] = bx[None]
        pred_masks, iou_scores = self.decode_raw(enc, kw, multimask)
        logits = pred_masks[0].float()              # (B, M, 256, 256)
        if upscale > 1:
            logits = torch.nn.functional.interpolate(logits, scale_factor=upscale, mode="bilinear", align_corners=False)
        h, w = logits.shape[-2:]
        vw, vh = enc["valid"]
        masks = (logits[..., :max(1, math.ceil(h * vh)), :max(1, math.ceil(w * vw))] > 0).cpu().numpy()
        return masks, iou_scores[0].float().cpu().numpy()

    def prepare(self, key, pil):
        self._encode(key, pil)

    def segment(self, key, pil, points, box):
        enc = self._encode(key, pil)
        pts = [list(points)] if points else None
        bx = [[box[0], box[1], box[0] + box[2], box[1] + box[3]]] if box else None
        masks, scores = self._decode(enc, points=pts, boxes=bx, upscale=4)
        best = _pick_whole_object(masks[0], scores[0])
        return mask_to_box(masks[0, best]), float(scores[0, best])

    def mask_in_box(self, key, pil, box):
        """A box is unambiguous, so the model is first asked for its single best mask (as SAM's authors recommend
        for boxes); if that one does not match the box, its proposals are tried and the one whose extent matches
        the box best wins (measured on test images, either alone misses some)."""
        from .engine import iou

        enc = self._encode(key, pil)
        prompt = [[box[0], box[1], box[0] + box[2], box[1] + box[3]]]
        best, best_key = None, (-1.0, -1.0)
        for multimask in (False, True):
            masks, scores = self._decode(enc, boxes=prompt, upscale=4, multimask=multimask)
            for k in range(masks.shape[1]):
                b = mask_to_box(masks[0, k])
                if b is None:
                    continue
                key_k = (round(iou(b, box), 2), float(scores[0, k]))
                if key_k > best_key:
                    best, best_key = (masks[0, k], float(scores[0, k])), key_k
            if best_key[0] >= 0.5:
                break
        return best if best is not None else (None, 0.0)

    def auto_boxes(self, key, pil):
        """Automatic regions: a sparse grid of single-point prompts, then extra prompts only where nothing was
        covered yet (a thin pipe between two grid rows), all on one cached encoding.

        Keeps every reliable granularity returned for a point (sub-part, part, whole object), not just the whole
        object: on a pile of tomatoes the "whole" mask is often the pile, while the single tomato is a lower
        level. Which granularity is the object is learned later from the teacher's boxes.
        """
        enc = self._encode(key, pil)
        g = self.points
        grid = [[((i + 0.5) / g, (j + 0.5) / g)] for j in range(g) for i in range(g)]
        cands: list[tuple[float, Box]] = []
        cover = None
        for s in range(0, len(grid), self.decode_batch):
            masks, scores = self._decode(enc, points=grid[s:s + self.decode_batch])
            if cover is None:
                cover = np.zeros(masks.shape[-2:], bool)
            _collect(masks, scores, cands, cover)
        extra = _uncovered_points(cover, self.refine)
        if extra:
            masks, scores = self._decode(enc, points=[[p] for p in extra])
            _collect(masks, scores, cands, cover)
        return _nms([b for _, b in sorted(cands, key=lambda t: -t[0])], 0.85)[:MAX_SEGMENTS]


def _pick_whole_object(masks: np.ndarray, scores: np.ndarray, min_score: float = 0.80) -> int:
    """SAM returns 3 nested masks (sub-part, part, whole object). The whole object usually gets a
    *lower* score than a sub-part (a nut's hole, a bolt's shaft), so the top score is the wrong pick:
    take the largest mask among the reliable ones, ignoring masks that cover most of the image."""
    areas = masks.reshape(len(masks), -1).mean(axis=1)
    ok = [i for i in range(len(masks)) if (scores[i] >= min_score or scores[i] == scores.max()) and areas[i] < 0.9]
    return max(ok, key=lambda i: areas[i]) if ok else int(np.argmax(scores))


def _collect(masks: np.ndarray, scores: np.ndarray, cands: list, cover: np.ndarray) -> None:
    for m, sc in zip(masks, scores):
        whole = _pick_whole_object(m, sc)
        for k in range(len(m)):
            if sc[k] >= 0.8:
                cover |= m[k]
            b = mask_to_box(m[k])
            if b and (sc[k] >= 0.85 or k == whole) and 0.002 < b[2] * b[3] < 0.9:
                cands.append((float(sc[k]) + (0.05 if k == whole else 0.0), b))


def _uncovered_points(cover: np.ndarray, limit: int, min_frac: float = 0.0015) -> list[tuple[float, float]]:
    """One prompt inside each sizeable area that no reliable mask covered yet (largest first)."""
    if limit <= 0:
        return []
    lab, n = _components(~cover)
    if n == 0:
        return []
    h, w = cover.shape
    sizes = np.bincount(lab.ravel())[1:]
    pts = []
    for k in np.argsort(-sizes):
        if sizes[k] < min_frac * h * w or len(pts) >= limit:
            break
        ys, xs = np.nonzero(lab == k + 1)
        j = int(np.argmin((ys - ys.mean()) ** 2 + (xs - xs.mean()) ** 2))  # inside, near the middle
        pts.append(((xs[j] + 0.5) / w, (ys[j] + 0.5) / h))
    return pts


def _nms(boxes: list[Box], thr: float = 0.6) -> list[Box]:
    from .engine import iou

    kept: list[Box] = []
    for b in boxes:
        if all(iou(b, k) < thr for k in kept):
            kept.append(b)
    return kept


def _sam_modules(model_id: str):
    """PyTorch wrappers exported to ONNX: the image encoder, and the mask decoder for one prompt kind."""
    import torch
    from transformers import SamModel

    sam = SamModel.from_pretrained(model_id).eval()

    class Encoder(torch.nn.Module):
        def __init__(self):
            super().__init__(); self.sam = sam

        def forward(self, pixel_values):
            return self.sam.get_image_embeddings(pixel_values)

    class Decoder(torch.nn.Module):
        def __init__(self, points: bool, boxes: bool, multimask: bool):
            super().__init__()
            self.sam, self.points, self.boxes, self.multimask = sam, points, boxes, multimask

        def forward(self, image_embeddings, *prompts):
            kw, i = {}, 0
            if self.points:
                kw["input_points"], kw["input_labels"], i = prompts[0], prompts[1], 2
            if self.boxes:
                kw["input_boxes"] = prompts[i]
            out = self.sam(image_embeddings=image_embeddings, multimask_output=self.multimask, **kw)
            return out.pred_masks, out.iou_scores

    return Encoder, Decoder


def _export_encoder(model_id: str):
    def run(path):
        import torch

        enc, _ = _sam_modules(model_id)
        runtime.export_onnx(enc(), (torch.randn(1, 3, 1024, 1024),), path, ["pixel_values"], ["image_embeddings"], {})
    return run


def _export_decoder(model_id: str, points: bool, boxes: bool, multimask: bool):
    def run(path):
        import torch

        _, dec = _sam_modules(model_id)
        b, p = 3, 2  # sizes > 1 so the exporter keeps them dynamic
        args, names, dyn = [torch.randn(1, 256, 64, 64)], ["image_embeddings"], {}
        if points:
            args += [torch.rand(1, b, p, 2) * 1024, torch.ones(1, b, p, dtype=torch.int64)]
            names += ["input_points", "input_labels"]
            dyn |= {"input_points": {1: "b", 2: "p"}, "input_labels": {1: "b", 2: "p"}}
        if boxes:
            args.append(torch.tensor([[[100.0, 100.0, 400.0, 500.0]] * b]))
            names.append("input_boxes")
            dyn["input_boxes"] = {1: "b"}
        dyn |= {"pred_masks": {1: "b"}, "iou_scores": {1: "b"}}
        runtime.export_onnx(dec(points, boxes, multimask), tuple(args), path, names, ["pred_masks", "iou_scores"], dyn)
    return run


@SEGMENTERS.register
class SamSegmenter(PromptableSegmenter):
    """Segment Anything v1 family (SAM, SlimSAM): ONNX graphs when the runtime is ONNX (one image encoder and one
    mask decoder per prompt kind, exported on first use), else PyTorch."""
    id = "sam"
    title = "SAM / SlimSAM"
    summary = "Segment Anything v1 family: the whole object, its parts and its pieces from a click or a box."
    license = "Apache-2.0"
    models = (option("nielsr/slimsam-77-uniform", "SlimSAM 77%", "Apache-2.0", "the light profile"),
              option("nielsr/slimsam-50-uniform", "SlimSAM 50%", "Apache-2.0"),
              option("facebook/sam-vit-base", "SAM ViT-B", "Apache-2.0", "the accurate profile"),
              option("facebook/sam-vit-large", "SAM ViT-L", "Apache-2.0"))
    default_model = "nielsr/slimsam-77-uniform"

    def __init__(self, model, points=8, refine=16):
        super().__init__(model, points, refine)
        self._processor = None
        self._model = None
        self._graphs: dict[str, "runtime.Graph"] = {}

    def load(self):
        from transformers import SamProcessor

        self._processor = SamProcessor.from_pretrained(self.model)
        if runtime.runtime() == "onnx":
            try:
                self._graphs["encoder"] = runtime.graph(self.model, "encoder", _export_encoder(self.model))
                self.device = runtime.label(self._graphs["encoder"].provider)
                self._decoder_graph(True, False, True)  # the automatic scan's decoder, ready before the first image
                return
            except Exception as e:  # export or session failed: PyTorch still works
                self._graphs.clear()
                runtime.note_fallback("segmenter", f"{type(e).__name__}: {e}")
        import torch
        from transformers import SamModel

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self._model = SamModel.from_pretrained(self.model).to(self.device).eval()

    def _decoder_graph(self, points: bool, boxes: bool, multimask: bool) -> "runtime.Graph":
        key = f"decoder-{'p' if points else ''}{'b' if boxes else ''}-{'multi' if multimask else 'single'}"
        if key not in self._graphs:
            self._graphs[key] = runtime.graph(self.model, key, _export_decoder(self.model, points, boxes, multimask))
        return self._graphs[key]

    def encode(self, pil):
        import torch

        pv = self._processor.image_processor(images=pil, return_tensors="pt")["pixel_values"]
        if "encoder" in self._graphs:
            return self._graphs["encoder"].run({"pixel_values": pv.numpy().astype(np.float32)})[0]
        with torch.inference_mode():
            return self._model.get_image_embeddings(pv.to(self.device))

    def decode_raw(self, enc, kw, multimask):
        import torch

        if "encoder" in self._graphs:  # ONNX: one decoder graph per prompt kind
            g = self._decoder_graph("input_points" in kw, "input_boxes" in kw, multimask)
            feeds = {"image_embeddings": enc["emb"], **{k: v.numpy() for k, v in kw.items()}}
            return tuple(torch.from_numpy(a) for a in g.run({k: feeds[k] for k in g.inputs}))
        with torch.inference_mode():
            out = self._model(image_embeddings=enc["emb"], multimask_output=multimask,
                              **{k: v.to(self.device) for k, v in kw.items()})
        return out.pred_masks, out.iou_scores


@SEGMENTERS.register
class Sam2Segmenter(PromptableSegmenter):
    """SAM 2.1 via transformers (needs torchvision); PyTorch only for now."""
    id = "sam2"
    title = "SAM 2.1"
    summary = "Segment Anything 2.1: better masks than SAM v1 at a similar cost. Runs on PyTorch."
    license = "Apache-2.0"
    models = (option("facebook/sam2.1-hiera-tiny", "SAM 2.1 tiny", "Apache-2.0", "the balanced profile"),
              option("facebook/sam2.1-hiera-small", "SAM 2.1 small", "Apache-2.0"),
              option("facebook/sam2.1-hiera-base-plus", "SAM 2.1 base+", "Apache-2.0"))
    default_model = "facebook/sam2.1-hiera-tiny"

    def __init__(self, model, points=8, refine=16):
        super().__init__(model, points, refine)
        self._processor = None
        self._model = None

    @classmethod
    def available(cls) -> bool:
        import importlib.util

        return super().available() and importlib.util.find_spec("torchvision") is not None

    def load(self):
        import torch
        from transformers import Sam2Model, Sam2Processor

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self._processor = Sam2Processor.from_pretrained(self.model)
        self._model = Sam2Model.from_pretrained(self.model).to(self.device).eval()

    def resize(self, W, H):  # squashed to 1024x1024: masks cover the whole image
        return 1024 / W, 1024 / H, (1.0, 1.0)

    def encode(self, pil):
        import torch

        pv = self._processor.image_processor(images=pil, return_tensors="pt")["pixel_values"]
        with torch.inference_mode():
            return self._model.get_image_embeddings(pv.to(self.device))

    def decode_raw(self, enc, kw, multimask):
        import torch

        with torch.inference_mode():
            out = self._model(image_embeddings=enc["emb"], multimask_output=multimask,
                              **{k: v.to(self.device) for k, v in kw.items()})
        return out.pred_masks, out.iou_scores


# ---------- public API (the active profile's segmenter) ----------

_lock = threading.Lock()
_current: Segmenter | None = None


def _get() -> Segmenter:
    """The active profile's segmenter, loaded (caller holds `_lock`)."""
    global _current
    cfg = profiles.active
    want = (cfg.segmenter, cfg.sam_model, cfg.sam_points, cfg.sam_refine)
    if _current is None or (_current.id, _current.model, _current.points, _current.refine) != want:
        _current = None
        seg = SEGMENTERS.get(cfg.segmenter)(cfg.sam_model, cfg.sam_points, cfg.sam_refine)
        seg.load()
        _current = seg
    return _current


def segment(key: str, pil: Image.Image, points: list[tuple[float, float]] | None = None,
            box: Box | None = None) -> tuple[Box | None, float]:
    """Tight box around the object indicated by points and/or a rough box. Returns (box, score)."""
    points = points or []
    if not points and box is None:
        return None, 0.0
    with _lock:
        return _get().segment(key, pil, points, box)


def mask_in_box(key: str, pil: Image.Image, box: Box) -> tuple[np.ndarray | None, float]:
    """The object's mask inside a confirmed box (for exports). Boolean array covering the whole image:
    pixel (r, c) of an (h, w) mask is the normalised point (c / w, r / h). None if nothing was found."""
    with _lock:
        return _get().mask_in_box(key, pil, box)


def auto_boxes(key: str, pil: Image.Image) -> list[Box]:
    """Class-agnostic object boxes for the "segments" proposer."""
    with _lock:
        return _get().auto_boxes(key, pil)


def prepare(key: str, pil: Image.Image) -> None:
    """Pre-computes the (slow) image encoding so the first click on this image is instant."""
    with _lock:
        _get().prepare(key, pil)


def warmup() -> None:
    """Loads the weights ahead of the first click."""
    with _lock:
        _get()


def unload() -> None:
    """Frees the model and its cached encodings (profile switch)."""
    global _current
    with _lock:
        _current = None


def name() -> str:
    cfg = profiles.active
    try:
        return SEGMENTERS.get(cfg.segmenter)(cfg.sam_model, cfg.sam_points, cfg.sam_refine).name()
    except ValueError:
        return f"{cfg.segmenter} (not available)"


def mask_signature() -> str:
    cfg = profiles.active
    try:
        return SEGMENTERS.get(cfg.segmenter).mask_signature_of(cfg.sam_model)
    except ValueError:
        return f"{cfg.segmenter}:{cfg.sam_model}"


def device() -> str:
    """Where it runs once loaded: an ONNX Runtime provider ("DirectML", "CPU"...) or a PyTorch device."""
    cur = _current
    return cur.device if cur is not None else "cpu"
