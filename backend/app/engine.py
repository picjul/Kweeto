"""Pixel's brain: in-memory vector store, kNN memory + linear probe with a background class,
and instance selection (one object per proposal, also for touching or broken objects).

Golden rule: the labels used for prediction come ONLY from what a human confirmed (boxes, and the
regions of verified images, see learning.py). Proposals are never used as examples (no feedback loop).
"""
from __future__ import annotations

import math
import threading
from collections import defaultdict
from dataclasses import dataclass

import numpy as np

try:  # FAISS when available, otherwise a numpy fallback (same results)
    import faiss  # type: ignore

    HAS_FAISS = True
except Exception:  # pragma: no cover
    faiss = None
    HAS_FAISS = False

KIND_WINDOW = 0
KIND_BOX = 1
KIND_DETECTOR = 2  # candidate added where the trained detector saw an object no window covered (used only with it)
BG = 0  # background pseudo-class ("not an object of any class"); real class ids start at 1


def topk_ip(base: np.ndarray, queries: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    """Top-k by inner product (= cosine on normalised vectors)."""
    base = np.ascontiguousarray(base, dtype=np.float32)
    queries = np.ascontiguousarray(queries, dtype=np.float32)
    k = max(1, min(k, base.shape[0]))
    if HAS_FAISS:
        index = faiss.IndexFlatIP(base.shape[1])
        index.add(base)
        sims, idx = index.search(queries, k)
        return sims, idx.astype(np.int64)
    sims_out = np.empty((queries.shape[0], k), dtype=np.float32)
    idx_out = np.empty((queries.shape[0], k), dtype=np.int64)
    for s in range(0, queries.shape[0], 2048):
        block = queries[s:s + 2048] @ base.T
        if k < base.shape[0]:
            part = np.argpartition(-block, k - 1, axis=1)[:, :k]
        else:
            part = np.tile(np.arange(base.shape[0]), (block.shape[0], 1))
        ps = np.take_along_axis(block, part, axis=1)
        order = np.argsort(-ps, axis=1)
        idx_out[s:s + 2048] = np.take_along_axis(part, order, axis=1)
        sims_out[s:s + 2048] = np.take_along_axis(ps, order, axis=1)
    return sims_out, idx_out


def iou(a, b) -> float:
    ax0, ay0, aw, ah = a
    bx0, by0, bw, bh = b
    ix = max(0.0, min(ax0 + aw, bx0 + bw) - max(ax0, bx0))
    iy = max(0.0, min(ay0 + ah, by0 + bh) - max(ay0, by0))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def containment(a, b) -> float:
    ax0, ay0, aw, ah = a
    bx0, by0, bw, bh = b
    ix = max(0.0, min(ax0 + aw, bx0 + bw) - max(ax0, bx0))
    iy = max(0.0, min(ay0 + ah, by0 + bh) - max(ay0, by0))
    small = min(aw * ah, bw * bh)
    return (ix * iy) / small if small > 0 else 0.0


class VectorStore:
    """Growable embedding matrix with per-row metadata and soft deletion."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.clear()

    def clear(self) -> None:
        with self.lock:
            self.dim = 0
            self.n = 0
            self._cap = 0
            self.vec = np.zeros((0, 0), np.float32)
            self.region_id = np.zeros(0, np.int64)
            self.image_id = np.zeros(0, np.int64)
            self.kind = np.zeros(0, np.int8)
            self.is_full = np.zeros(0, bool)
            self.active = np.zeros(0, bool)
            self.geom = np.zeros((0, 4), np.float32)
            self.row_of: dict[int, int] = {}

    def _grow(self, need: int) -> None:
        if need <= self._cap:
            return
        cap = max(1024, self._cap * 2, need)

        def g(a: np.ndarray, tail: tuple, dtype) -> np.ndarray:
            new = np.zeros((cap, *tail), dtype)
            new[: self.n] = a[: self.n]
            return new

        self.vec = g(self.vec, (self.dim,), np.float32)
        self.region_id = g(self.region_id, (), np.int64)
        self.image_id = g(self.image_id, (), np.int64)
        self.kind = g(self.kind, (), np.int8)
        self.is_full = g(self.is_full, (), bool)
        self.active = g(self.active, (), bool)
        self.geom = g(self.geom, (4,), np.float32)
        self._cap = cap

    def add(self, items: list[tuple[int, int, int, tuple, bool, np.ndarray]]) -> None:
        """items: (region_id, image_id, kind, (x,y,w,h), is_full, vector)."""
        if not items:
            return
        with self.lock:
            if self.dim == 0:
                self.dim = int(len(items[0][5]))
                self.vec = np.zeros((0, self.dim), np.float32)
            self._grow(self.n + len(items))
            for rid, iid, kind, geom, full, v in items:
                if len(v) != self.dim:
                    raise ValueError(f"Embedding size {len(v)} differs from {self.dim}: did you change model? Use a new DATA_DIR.")
                if rid in self.row_of:
                    continue
                r = self.n
                self.vec[r] = v
                self.region_id[r] = rid
                self.image_id[r] = iid
                self.kind[r] = kind
                self.is_full[r] = full
                self.active[r] = True
                self.geom[r] = geom
                self.row_of[rid] = r
                self.n += 1

    def remove(self, region_ids) -> None:
        with self.lock:
            for rid in region_ids:
                r = self.row_of.pop(int(rid), None)
                if r is not None:
                    self.active[r] = False

    def size(self) -> int:
        return len(self.row_of)


store = VectorStore()


@dataclass
class Params:
    sim_min: float
    sim_high: float
    propose_min: float
    knn_k: int
    temperature: float
    max_per_image: int
    probe_weight: float = 0.0  # 0 = kNN only, 1 = probe only (for the choice of the class)
    use_geometry: bool = True  # give the probe the region's size/shape and how many regions it contains
    detector_weight: float = 0.3  # how much the detector's box pulls the class and the "is it an object" toward it
    detector_veto: float = 0.3    # how much confidence drops where the detector saw nothing


# ---------- region features ----------

GEO_DIM = 3


def children_counts(st: VectorStore, rows: np.ndarray) -> np.ndarray:
    """For each row: how many candidate regions of the same image lie inside it.

    The signal that tells a pile (contains several look-alike regions) from a single object.
    """
    rows = np.asarray(rows, np.int64)
    out = np.zeros(len(rows), np.float32)
    if len(rows) == 0:
        return out
    n = st.n
    win = np.nonzero(st.active[:n] & (st.kind[:n] == KIND_WINDOW))[0]
    by_img: dict[int, list[int]] = defaultdict(list)
    for r in win:
        by_img[int(st.image_id[r])].append(int(r))
    q_by_img: dict[int, list[int]] = defaultdict(list)
    for k, r in enumerate(rows):
        q_by_img[int(st.image_id[r])].append(k)
    for img, ks in q_by_img.items():
        w = by_img.get(img)
        if not w:
            continue
        Q = st.geom[rows[ks]].astype(np.float64)  # (q, 4)
        G = st.geom[w].astype(np.float64)          # (g, 4)
        ix = np.clip(np.minimum(Q[:, None, 0] + Q[:, None, 2], G[None, :, 0] + G[None, :, 2])
                     - np.maximum(Q[:, None, 0], G[None, :, 0]), 0, None)
        iy = np.clip(np.minimum(Q[:, None, 1] + Q[:, None, 3], G[None, :, 1] + G[None, :, 3])
                     - np.maximum(Q[:, None, 1], G[None, :, 1]), 0, None)
        ga = np.maximum(G[:, 2] * G[:, 3], 1e-9)
        qa = Q[:, 2] * Q[:, 3]
        inside = (ix * iy / ga[None, :] >= 0.85) & (ga[None, :] <= 0.6 * qa[:, None])
        out[ks] = inside.sum(axis=1)
    return out


def geo_features(geom: np.ndarray, kids: np.ndarray) -> np.ndarray:
    """Size, shape and "contains other regions": roughly unit-scaled so they don't drown the embedding."""
    geom = np.asarray(geom, np.float64).reshape(-1, 4)
    area = np.clip(geom[:, 2] * geom[:, 3], 1e-4, 1.0)
    aspect = np.clip(geom[:, 2] / np.maximum(geom[:, 3], 1e-4), 0.05, 20.0)
    return np.stack([np.log(area) / 4.0, np.log(aspect) / 2.0, np.minimum(kids, 3) / 3.0], axis=1).astype(np.float32)


def features(st: VectorStore, rows, use_geometry: bool = True) -> np.ndarray:
    """What the probe sees for a region: the embedding (+ geometry)."""
    rows = np.asarray(rows, np.int64)
    X = st.vec[rows].astype(np.float32)
    if not use_geometry:
        return X
    return np.concatenate([X, geo_features(st.geom[rows], children_counts(st, rows))], axis=1)


# ---------- linear probe ----------

@dataclass
class LinearProbe:
    """Multinomial logistic regression on frozen embeddings, optionally with a background class (BG)."""
    classes: np.ndarray  # sorted class ids (BG = 0 first, when present)
    W: np.ndarray        # (D, C)
    b: np.ndarray        # (C,)
    scale: float
    train_acc: float
    n: int
    use_geometry: bool = False  # True when trained on `features(..., use_geometry=True)`
    steps: int = 0       # optimisation steps of the last fit (fewer when warm-started)

    @property
    def has_bg(self) -> bool:
        return len(self.classes) > 0 and int(self.classes[0]) == BG

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        z = (X @ self.W) * self.scale + self.b
        z -= z.max(axis=1, keepdims=True)
        e = np.exp(z)
        return e / e.sum(axis=1, keepdims=True)


def train_probe(X: np.ndarray, y: np.ndarray, sample_weight: np.ndarray | None = None, steps: int = 300,
                lr: float = 0.05, l2: float = 1e-3, scale: float = 10.0, min_per_class: int = 1,
                init: LinearProbe | None = None, tol: float = 5e-4) -> LinearProbe | None:
    """Full-batch Adam on class-balanced, sample-weighted cross-entropy.

    Always fits on ALL the examples (deterministic, supports deleting examples), but starts from the
    previous solution when the classes are unchanged (`init`), so after one more click it converges in a
    few dozen steps: incremental in cost, not in semantics. Milliseconds for a few thousand examples.
    """
    classes, counts = np.unique(y, return_counts=True)
    if len(classes) < 2 or counts.min() < min_per_class:
        return None
    X = np.ascontiguousarray(X, dtype=np.float32)
    yi = np.searchsorted(classes, y)
    N, D = X.shape
    C = len(classes)
    w0 = np.ones(N, np.float32) if sample_weight is None else np.asarray(sample_weight, np.float32)
    cw = np.bincount(yi, weights=w0, minlength=C)
    sw = (w0 * (w0.sum() / (C * np.maximum(cw, 1e-9)))[yi]).astype(np.float32)  # balance the classes
    sw /= sw.sum()
    Y = np.zeros((N, C), np.float32)
    Y[np.arange(N), yi] = 1.0
    warm = init is not None and np.array_equal(init.classes, classes) and init.W.shape == (D, C)
    W = init.W.copy() if warm else np.zeros((D, C), np.float32)
    b = init.b.copy() if warm else np.zeros(C, np.float32)
    if warm:
        lr = lr * 0.5
    mW, vW, mb, vb = np.zeros_like(W), np.zeros_like(W), np.zeros_like(b), np.zeros_like(b)
    b1, b2, eps = 0.9, 0.999, 1e-8
    prev = math.inf
    t = 0
    for t in range(1, steps + 1):
        z = (X @ W) * scale + b
        z -= z.max(axis=1, keepdims=True)
        P = np.exp(z)
        P /= P.sum(axis=1, keepdims=True)
        if t % 10 == 0:  # early stop once the loss has settled (fast after a warm start)
            loss = float(-(sw * np.log(P[np.arange(N), yi] + 1e-12)).sum() + 0.5 * l2 * (W * W).sum())
            if prev - loss < tol:  # settled (on separable data the loss would creep down forever)
                break
            prev = loss
        G = (P - Y) * sw[:, None]             # dL/dz
        gW = (X.T @ G) * scale + l2 * W
        gb = G.sum(axis=0)
        mW = b1 * mW + (1 - b1) * gW
        vW = b2 * vW + (1 - b2) * gW * gW
        mb = b1 * mb + (1 - b1) * gb
        vb = b2 * vb + (1 - b2) * gb * gb
        W -= lr * (mW / (1 - b1 ** t)) / (np.sqrt(vW / (1 - b2 ** t)) + eps)
        b -= lr * (mb / (1 - b1 ** t)) / (np.sqrt(vb / (1 - b2 ** t)) + eps)
    probe = LinearProbe(classes=classes, W=W, b=b, scale=scale, train_acc=0.0, n=N, steps=t)
    probe.train_acc = float((probe.predict_proba(X).argmax(axis=1) == yi).mean())
    return probe


# ---------- size prior & instance selection ----------

def size_priors(geoms_by_class: dict[int, list[tuple]], min_n: int = 3) -> dict[int, tuple[float, float]]:
    """Typical log-area of each class (median, robust spread), from the confirmed boxes."""
    out = {}
    for c, gs in geoms_by_class.items():
        if len(gs) < min_n:
            continue
        la = np.log(np.clip([g[2] * g[3] for g in gs], 1e-5, 1.0))
        med = float(np.median(la))
        mad = float(np.median(np.abs(la - med))) * 1.4826
        out[int(c)] = (med, max(0.25, mad))
    return out


def _g(d: dict) -> tuple:
    return (d["x"], d["y"], d["w"], d["h"])


def _is_group(big: dict, kids: list[dict], prior: tuple[float, float] | None) -> bool:
    """Is `big` a group of `kids` (several objects) rather than one object made of `kids` (fragments)?

    With a size prior for the class, the side whose size is more typical wins. Without one: three or more
    look-alike pieces are a pile (a broken object is usually in two pieces); for two pieces the region
    Pixel is clearly surer about wins, ties go to separate objects (touching objects are the common case).
    """
    if prior is not None:
        mu, sd = prior
        z_big = abs(math.log(max(big["w"] * big["h"], 1e-5)) - mu) / sd
        z_kids = float(np.mean([abs(math.log(max(k["w"] * k["h"], 1e-5)) - mu) / sd for k in kids]))
        if abs(z_big - z_kids) > 0.5:
            return z_kids < z_big
    if len(kids) >= 3:
        return True
    return not big["confidence"] >= max(k["confidence"] for k in kids) + 0.1


def select_instances(items: list[dict], priors: dict, max_n: int) -> list[dict]:
    """One proposal per object. Resolves the region hierarchy before the usual overlap suppression:

    - a region of class X that contains >= 2 separate regions also predicted X is either a GROUP of
      touching objects (keep the pieces) or ONE object split into fragments (keep the big one);
    - then greedy non-maximum suppression by confidence.
    """
    items = sorted(items, key=lambda d: -d["confidence"])
    area = [d["w"] * d["h"] for d in items]
    dropped: set[int] = set()
    for gi in sorted(range(len(items)), key=lambda i: -area[i]):
        if gi in dropped:
            continue
        big = items[gi]
        chosen: list[int] = []
        for k in range(len(items)):
            if k == gi or k in dropped or items[k]["class_id"] != big["class_id"] or area[k] > 0.6 * area[gi]:
                continue
            if containment(_g(items[k]), _g(big)) < 0.85:
                continue
            if all(iou(_g(items[k]), _g(items[c])) < 0.3 and containment(_g(items[k]), _g(items[c])) < 0.5
                   for c in chosen):
                chosen.append(k)
        if len(chosen) < 2 or sum(area[k] for k in chosen) < 0.35 * area[gi]:
            continue
        if _is_group(big, [items[k] for k in chosen], priors.get(big["class_id"])):
            dropped.add(gi)
        else:
            dropped.update(chosen)
    kept: list[dict] = []
    for i, d in enumerate(items):
        if i in dropped or len(kept) >= max_n:
            continue
        g = _g(d)
        if any(iou(g, _g(k)) > 0.5 or containment(g, _g(k)) > 0.7 for k in kept):
            continue
        kept.append(d)
    return kept


# ---------- prediction ----------

DET_MATCH_IOU = 0.5


def detector_evidence(cand_img: np.ndarray, cand_geom: np.ndarray, detections: dict[int, list]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """For each candidate: the class and score of the detector box that best matches it (IoU >= 0.5), and
    whether the detector looked at that image at all. class -1 / score 0 = the detector saw nothing there."""
    M = len(cand_img)
    det_cls = np.full(M, -1, np.int64)
    det_score = np.zeros(M)
    scanned = np.zeros(M, bool)
    by_img: dict[int, list[int]] = defaultdict(list)
    for i, iid in enumerate(cand_img):
        by_img[int(iid)].append(i)
    for iid, ks in by_img.items():
        dets = detections.get(iid)
        if dets is None:
            continue
        scanned[ks] = True
        if not dets:
            continue
        Q = cand_geom[ks].astype(np.float64)
        D = np.array([g for _c, _s, g in dets], np.float64)
        ix = np.clip(np.minimum(Q[:, None, 0] + Q[:, None, 2], D[None, :, 0] + D[None, :, 2])
                     - np.maximum(Q[:, None, 0], D[None, :, 0]), 0, None)
        iy = np.clip(np.minimum(Q[:, None, 1] + Q[:, None, 3], D[None, :, 1] + D[None, :, 3])
                     - np.maximum(Q[:, None, 1], D[None, :, 1]), 0, None)
        inter = ix * iy
        union = (Q[:, 2] * Q[:, 3])[:, None] + (D[:, 2] * D[:, 3])[None, :] - inter
        ious = inter / np.maximum(union, 1e-12)
        best = ious.argmax(axis=1)
        ok = ious[np.arange(len(ks)), best] >= DET_MATCH_IOU
        for k, j, good in zip(ks, best, ok):
            if good:
                det_cls[k] = int(dets[j][0])
                det_score[k] = float(dets[j][1])
    return det_cls, det_score, scanned


def predict(st: VectorStore, labels, negatives, target_images, p: Params,
            probe: LinearProbe | None = None, priors: dict | None = None,
            detections: dict[int, list] | None = None) -> list[dict]:
    """Scores every candidate region of the target images and keeps one proposal per object.

    labels:    [(region_id, class_id)] confirmed examples (kNN memory)
    negatives: [(region_id, class_id)] "this region is not this class"
    probe:     linear probe; its class opinion is blended with the kNN vote (weight `p.probe_weight`) and,
               when it has a background class, its "is this an object at all?" gates the confidence
    priors:    per-class size prior used to tell groups from fragments
    detections: {image_id: [(class_id, score, (x, y, w, h))]} of the project's trained detector, or None (not
               used). A third opinion: where its box matches a candidate it pulls the class and the objectness
               toward its own (by `p.detector_weight` x its score) and Pixel is humbler when they disagree; where
               it saw nothing the confidence drops (`p.detector_veto`). Its boxes that no window covered are
               candidates too (KIND_DETECTOR). Pixel still needs familiar examples: the detector never
               proposes on its own.
    """
    with st.lock:
        if st.n == 0 or not labels or not target_images:
            return []
        lab = [(st.row_of[r], c) for r, c in labels if r in st.row_of]
        if not lab:
            return []
        P = st.vec[[r for r, _ in lab]].copy()
        lab_cls = np.array([c for _, c in lab], np.int64)
        n = st.n
        targets = np.fromiter(target_images, dtype=np.int64)
        kinds = st.kind[:n]
        is_cand = (kinds == KIND_WINDOW) | (kinds == KIND_DETECTOR) if detections is not None else kinds == KIND_WINDOW
        mask = st.active[:n] & is_cand & np.isin(st.image_id[:n], targets)
        cand = np.nonzero(mask)[0]
        if cand.size == 0:
            return []
        C = st.vec[cand].copy()
        cand_img = st.image_id[cand].copy()
        cand_reg = st.region_id[cand].copy()
        cand_geom = st.geom[cand].copy()
        neg = [(st.row_of[r], c) for r, c in negatives if r in st.row_of]
        N = st.vec[[r for r, _ in neg]].copy() if neg else None
        neg_cls = np.array([c for _, c in neg], np.int64) if neg else None
        Xp = features(st, cand, probe.use_geometry) if probe is not None else None

    classes = np.unique(lab_cls)
    lab_ci = np.searchsorted(classes, lab_cls)
    sims, idx = topk_ip(P, C, p.knn_k)
    nb_ci = lab_ci[idx]
    M, K = sims.shape
    rows = np.arange(M)

    # weighted vote: softmax over the neighbours' similarities
    w = np.exp((sims - sims[:, :1]) / p.temperature)
    votes = np.zeros((M, len(classes)), np.float64)
    for j in range(K):
        np.add.at(votes, (rows, nb_ci[:, j]), w[:, j])
    share = votes / votes.sum(axis=1, keepdims=True)
    knn_best = share.argmax(axis=1)

    # the probe: smoother generalisation for the class, and a learned "object vs background" gate
    objectness = np.ones(M)
    disagree = np.zeros(M, bool)
    use_probe = False
    if probe is not None and Xp is not None:
        pp_all = probe.predict_proba(Xp)
        real = probe.classes != BG
        if probe.has_bg:
            objectness = 1.0 - pp_all[:, 0]
        if p.probe_weight > 0 and np.isin(classes, probe.classes[real]).all():
            pp = pp_all[:, np.searchsorted(probe.classes, classes)]
            pp = pp / np.maximum(pp.sum(axis=1, keepdims=True), 1e-9)
            share = (1 - p.probe_weight) * share + p.probe_weight * pp
            disagree = pp.argmax(axis=1) != knn_best
            use_probe = True
    # the trained detector: a third opinion on the class and on "is this an object at all"
    det_disagree = np.zeros(M, bool)
    if detections is not None:
        det_cls, det_score, scanned = detector_evidence(cand_img, cand_geom, detections)
        hit = det_cls >= 0
        known = hit & np.isin(det_cls, classes)
        if known.any():
            dw = p.detector_weight * det_score[known]
            onehot = np.zeros((int(known.sum()), len(classes)))
            onehot[np.arange(int(known.sum())), np.searchsorted(classes, det_cls[known])] = 1.0
            share[known] = (1 - dw)[:, None] * share[known] + dw[:, None] * onehot
        objectness = np.where(hit, objectness + (1 - objectness) * p.detector_weight * det_score, objectness)
        objectness = np.where(scanned & ~hit, objectness * (1 - p.detector_veto), objectness)
    best = share.argmax(axis=1)
    top = share[rows, best]
    if detections is not None:
        det_disagree = known & (classes[best] != det_cls)
    if len(classes) > 1:
        tmp = share.copy()
        tmp[rows, best] = -1.0
        second = tmp.argmax(axis=1)
        second_share = np.maximum(tmp[rows, second], 0.0)
    else:
        second = None
        second_share = np.zeros(M)

    # familiarity: how "truly close" the nearest example of the winning class is
    # (with the probe the winner may have no neighbour among the top-k: fall back to the nearest example of any class)
    nn_best = np.where(nb_ci == best[:, None], sims, -1.0).max(axis=1)
    nn_ref = np.maximum(nn_best, sims[:, 0] - 0.02) if use_probe else nn_best
    fam = np.clip((nn_ref - p.sim_min) / max(1e-6, p.sim_high - p.sim_min), 0.0, 1.0)
    conf = top * fam * objectness
    conf[disagree] *= 0.75  # the two "minds" disagree: be humbler
    conf[det_disagree] *= 0.75  # the detector says another class: same humility
    best_cls = classes[best]

    # negatives: if the candidate is closer to a "not X" than to the best example of X, drop X
    if N is not None and len(N):
        nsims, nidx = topk_ip(N, C, 5)
        nb_neg_cls = neg_cls[nidx]
        blocked = ((nb_neg_cls == best_cls[:, None]) & (nsims >= nn_ref[:, None] - 1e-6)).any(axis=1)
        conf[blocked] = 0.0

    per_img: dict[int, list[dict]] = defaultdict(list)
    for i in np.nonzero(conf >= p.propose_min)[0]:
        g = cand_geom[i]
        sc = int(classes[second[i]]) if second is not None and second_share[i] > 0.01 else None
        per_img[int(cand_img[i])].append(dict(
            image_id=int(cand_img[i]), region_id=int(cand_reg[i]), class_id=int(best_cls[i]), second_class_id=sc,
            confidence=float(conf[i]), margin=float(top[i] - second_share[i]), nn_sim=float(nn_ref[i]),
            x=float(g[0]), y=float(g[1]), w=float(g[2]), h=float(g[3]),
        ))
    out: list[dict] = []
    for items in per_img.values():
        out += select_instances(items, priors or {}, p.max_per_image)
    return out


def similarity_profile(st: VectorStore, labels, max_n: int = 2000) -> dict | None:
    """Median similarity to the nearest same-class vs other-class neighbour (auto-calibration)."""
    with st.lock:
        lab = [(st.row_of[r], c) for r, c in labels if r in st.row_of]
        if len(lab) < 4:
            return None
        if len(lab) > max_n:
            rng = np.random.default_rng(0)
            lab = [lab[i] for i in rng.choice(len(lab), max_n, replace=False)]
        P = st.vec[[r for r, _ in lab]].copy()
    cls = np.array([c for _, c in lab])
    if len(np.unique(cls)) < 2:
        return None
    S = P @ P.T
    np.fill_diagonal(S, -np.inf)
    same = cls[:, None] == cls[None, :]
    same_best = np.where(same, S, -np.inf).max(axis=1)
    other_best = np.where(~same, S, -np.inf).max(axis=1)
    valid = np.isfinite(same_best)
    if valid.sum() < 2:
        return None
    return {"same": float(np.median(same_best[valid])), "other": float(np.median(other_best))}


def _full_rows(st: VectorStore) -> np.ndarray:
    n = st.n
    return np.nonzero(st.active[:n] & (st.kind[:n] == KIND_WINDOW) & st.is_full[:n])[0]


def similar_images(st: VectorStore, image_id: int, k: int = 12) -> list[tuple[int, float]]:
    with st.lock:
        rows = _full_rows(st)
        if rows.size == 0:
            return []
        ids = st.image_id[rows].copy()
        pos = np.nonzero(ids == image_id)[0]
        if pos.size == 0:
            return []
        base = st.vec[rows].copy()
    q = base[pos[0]][None, :]
    sims, idx = topk_ip(base, q, k + 1)
    out = [(int(ids[j]), float(s)) for s, j in zip(sims[0], idx[0]) if int(ids[j]) != image_id]
    return out[:k]


def full_vectors(st: VectorStore, image_ids) -> tuple[np.ndarray, np.ndarray]:
    with st.lock:
        rows = _full_rows(st)
        ids = st.image_id[rows]
        sel = rows[np.isin(ids, np.fromiter(image_ids, dtype=np.int64))]
        return st.image_id[sel].copy(), st.vec[sel].copy()


def label_matrix(st: VectorStore, labels) -> np.ndarray | None:
    with st.lock:
        rows = [st.row_of[r] for r, _ in labels if r in st.row_of]
        return st.vec[rows].copy() if rows else None


def kmeans(x: np.ndarray, k: int, iters: int = 20, seed: int = 0) -> np.ndarray:
    """Minimal spherical k-means (normalised vectors). Returns the per-row assignment."""
    n = x.shape[0]
    k = max(1, min(k, n))
    rng = np.random.default_rng(seed)
    centers = x[rng.choice(n, k, replace=False)].copy()
    assign = np.zeros(n, np.int64)
    for _ in range(iters):
        assign = (x @ centers.T).argmax(axis=1)
        for c in range(k):
            members = x[assign == c]
            if len(members):
                m = members.mean(axis=0)
                centers[c] = m / (np.linalg.norm(m) or 1.0)
    return assign
